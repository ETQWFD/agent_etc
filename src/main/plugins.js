'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

/**
 * 插件体系：
 * 1) 原生插件 —— 一个目录，内含 plugin.json 与入口 JS，通过 ctx.registerTool 注册工具；
 * 2) MCP 服务器 —— 任意实现 Model Context Protocol 的进程，stdio JSON-RPC 接入。
 * 所有插件都对 Agent 暴露为普通工具，可随时启用 / 停用 / 卸载。
 */

class PluginHost {
  constructor({ appRoot, userDataDir, getConfig, onToolsChanged }) {
    this.appRoot = appRoot;
    this.userDataDir = userDataDir;
    this.getConfig = getConfig;
    this.onToolsChanged = onToolsChanged || (() => {});
    this.native = new Map(); // id -> { manifest, dir, instance, tools: [] }
    this.mcp = new Map(); // id -> McpClient
    this.log = [];
    this.loadErrors = [];
  }

  pluginDirs() {
    const out = [];
    const builtin = path.join(this.appRoot, 'plugins', 'builtin');
    const user = path.join(this.userDataDir, 'plugins');
    for (const root of [builtin, user]) {
      try {
        if (!fs.existsSync(root)) continue;
        for (const name of fs.readdirSync(root)) {
          const dir = path.join(root, name);
          if (fs.existsSync(path.join(dir, 'plugin.json')) || fs.existsSync(path.join(dir, 'index.js'))) out.push(dir);
        }
      } catch (err) {
        this.loadErrors.push(`扫描插件目录失败 ${root}: ${err.message}`);
      }
    }
    return out;
  }

  readManifest(dir) {
    const manifestFile = path.join(dir, 'plugin.json');
    let manifest = {};
    if (fs.existsSync(manifestFile)) {
      try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (err) {
        throw new Error(`plugin.json 解析失败：${err.message}`);
      }
    }
    return {
      id: manifest.id || path.basename(dir),
      name: manifest.name || manifest.id || path.basename(dir),
      version: manifest.version || '1.0.0',
      description: manifest.description || '',
      author: manifest.author || '',
      main: manifest.main || 'index.js',
      dir,
      manifest,
    };
  }

  isDisabled(id) {
    return (this.getConfig().plugins?.disabled || []).includes(id);
  }

  async loadNative() {
    for (const p of this.native.values()) {
      try { p.instance?.deactivate?.(); } catch (_) { /* ignore */ }
    }
    this.native.clear();
    const seen = new Set();
    for (const dir of this.pluginDirs()) {
      let manifest;
      try { manifest = this.readManifest(dir); } catch (err) {
        this.loadErrors.push(err.message);
        continue;
      }
      if (seen.has(manifest.id)) continue; // 用户目录优先
      seen.add(manifest.id);
      const record = { ...manifest, tools: [], enabled: !this.isDisabled(manifest.id), error: '' };
      if (!record.enabled) {
        this.native.set(manifest.id, record);
        continue;
      }
      try {
        const entry = path.join(dir, manifest.main);
        if (!fs.existsSync(entry)) throw new Error(`入口文件不存在：${entry}`);
        const mod = require(entry);
        const ctx = {
          registerTool: (tool) => {
            if (!tool?.name) throw new Error('插件工具缺少 name');
            record.tools.push({ ...tool, source: `plugin:${record.id}` });
          },
          getConfig: () => this.getConfig(),
          workspace: () => this.getConfig().workspace,
          log: (...args) => this.pushLog(`[${record.id}] ${args.join(' ')}`),
          pluginDir: dir,
        };
        const instance = typeof mod === 'function' ? mod(ctx) : await mod.activate(ctx);
        record.instance = instance || mod;
        this.native.set(manifest.id, record);
      } catch (err) {
        record.error = err.message;
        this.native.set(manifest.id, record);
        this.loadErrors.push(`插件 ${manifest.id} 加载失败：${err.message}`);
      }
    }
    this.emitTools();
  }

  async loadMcp() {
    const servers = this.getConfig().plugins?.mcp || [];
    const wanted = new Set(servers.filter((s) => s.enabled !== false).map((s) => s.id));
    for (const [id, client] of this.mcp.entries()) {
      if (!wanted.has(id)) {
        client.stop();
        this.mcp.delete(id);
      }
    }
    for (const server of servers) {
      if (server.enabled === false) continue;
      const existing = this.mcp.get(server.id);
      if (existing && existing.configHash === JSON.stringify(server)) continue;
      if (existing) existing.stop();
      const client = new McpClient(server, (line) => this.pushLog(`[mcp:${server.id}] ${line}`));
      this.mcp.set(server.id, client);
      try {
        await client.start();
      } catch (err) {
        client.error = err.message;
        this.loadErrors.push(`MCP ${server.name || server.id} 启动失败：${err.message}`);
      }
    }
    this.emitTools();
  }

  async reloadAll() {
    this.loadErrors = [];
    await this.loadNative();
    await this.loadMcp();
    this.emitTools();
  }

  pushLog(line) {
    this.log.push({ time: Date.now(), line });
    if (this.log.length > 300) this.log = this.log.slice(-300);
  }

  emitTools() {
    this.onToolsChanged(this.tools());
  }

  tools() {
    const out = [];
    for (const p of this.native.values()) {
      if (!p.enabled) continue;
      for (const t of p.tools) {
        out.push({
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
          danger: !!t.danger,
          source: `plugin:${p.id}`,
          run: t.run,
          pluginId: p.id,
        });
      }
    }
    for (const [id, client] of this.mcp.entries()) {
      if (!client.ready) continue;
      for (const t of client.tools) {
        out.push({
          name: mcpToolName(id, t.name),
          description: `[MCP:${client.config.name || id}] ${t.description || ''}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
          danger: true,
          source: `mcp:${id}`,
          run: async (args) => client.callTool(t.name, args),
          pluginId: id,
        });
      }
    }
    return out;
  }

  list() {
    const native = [...this.native.values()].map((p) => ({
      kind: 'native',
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      author: p.author,
      enabled: p.enabled,
      error: p.error,
      tools: p.tools.map((t) => t.name),
      dir: p.dir,
    }));
    const mcp = [...this.mcp.values()].map((c) => ({
      kind: 'mcp',
      id: c.config.id,
      name: c.config.name || c.config.id,
      version: '—',
      description: `${c.config.command} ${(c.config.args || []).join(' ')}`,
      author: 'MCP',
      enabled: c.config.enabled !== false,
      error: c.error || '',
      ready: c.ready,
      tools: c.tools.map((t) => t.name),
    }));
    return { native, mcp, log: this.log.slice(-80), errors: this.loadErrors };
  }

  async setEnabled(id, enabled) {
    const cfg = this.getConfig();
    const disabled = new Set(cfg.plugins?.disabled || []);
    if (enabled) disabled.delete(id); else disabled.add(id);
    cfg.plugins.disabled = [...disabled];
    const server = (cfg.plugins.mcp || []).find((s) => s.id === id);
    if (server) server.enabled = enabled;
    await this.reloadAll();
    return this.list();
  }

  async installFromFolder(sourceDir) {
    const manifest = this.readManifest(sourceDir);
    const dest = path.join(this.userDataDir, 'plugins', manifest.id);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) await fsp.rm(dest, { recursive: true, force: true });
    await copyDir(sourceDir, dest);
    await this.reloadAll();
    return dest;
  }

  async uninstall(id) {
    const record = this.native.get(id);
    if (!record) {
      const cfg = this.getConfig();
      cfg.plugins.mcp = (cfg.plugins.mcp || []).filter((s) => s.id !== id);
      const client = this.mcp.get(id);
      if (client) { client.stop(); this.mcp.delete(id); }
      await this.reloadAll();
      return;
    }
    if (!record.dir.startsWith(this.userDataDir)) throw new Error('内置插件不可卸载，可先停用');
    try { record.instance?.deactivate?.(); } catch (_) { /* ignore */ }
    await fsp.rm(record.dir, { recursive: true, force: true });
    this.native.delete(id);
    await this.reloadAll();
    return true;
  }

  async addMcpServer(server) {
    const cfg = this.getConfig();
    const id = server.id || `mcp-${Math.random().toString(36).slice(2, 8)}`;
    cfg.plugins.mcp = [...(cfg.plugins.mcp || []).filter((s) => s.id !== id), { ...server, id, enabled: true }];
    await this.reloadAll();
    return id;
  }

  shutdown() {
    for (const c of this.mcp.values()) c.stop();
    for (const p of this.native.values()) {
      try { p.instance?.deactivate?.(); } catch (_) { /* ignore */ }
    }
  }
}

function mcpToolName(serverId, toolName) {
  return `mcp_${String(serverId).replace(/[^a-zA-Z0-9_]/g, '_')}_${String(toolName).replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isFile()) await fsp.copyFile(s, d);
  }
}

class McpClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger || (() => {});
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.tools = [];
    this.ready = false;
    this.error = '';
    this.configHash = JSON.stringify(config);
  }

  async start() {
    const { command, args = [], env = {}, cwd } = this.config;
    if (!command) throw new Error('MCP 服务器缺少 command');
    const mergedEnv = { ...process.env, ...env };
    this.proc = spawn(command, args, {
      cwd: cwd || undefined,
      env: mergedEnv,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.on('error', (err) => { this.error = err.message; this.logger(`进程错误 ${err.message}`); });
    this.proc.on('close', (code) => {
      this.ready = false;
      this.logger(`进程退出 code=${code}`);
      for (const { reject } of this.pending.values()) reject(new Error('MCP 服务器已退出'));
      this.pending.clear();
    });
    this.proc.stdout.on('data', (d) => this.consume(d.toString()));
    this.proc.stderr.on('data', (d) => this.logger(d.toString().trim().slice(0, 400)));

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { roots: { listChanged: false }, tools: {} },
      clientInfo: { name: 'agent_etc', version: '1.0.0' },
    }, 20000);
    this.notify('notifications/initialized', {});
    const list = await this.request('tools/list', {}, 20000);
    this.tools = list?.tools || [];
    this.ready = true;
    this.logger(`已连接，工具 ${this.tools.length} 个`);
  }

  sendRaw(obj) {
    if (!this.proc?.stdin.writable) throw new Error('MCP 进程不可写');
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  notify(method, params) {
    try { this.sendRaw({ jsonrpc: '2.0', method, params }); } catch (_) { /* ignore */ }
  }

  request(method, params, timeout = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.sendRaw({ jsonrpc: '2.0', id, method, params }); } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    while (true) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'MCP 调用失败'));
        else resolve(msg.result);
      }
    }
  }

  async callTool(name, args) {
    const res = await this.request('tools/call', { name, arguments: args || {} }, 60000);
    const content = (res?.content || []).map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'resource') return c.resource?.text || JSON.stringify(c.resource);
      return JSON.stringify(c);
    }).join('\n');
    return { content, isError: !!res?.isError };
  }

  stop() {
    try { this.proc?.kill(); } catch (_) { /* ignore */ }
    this.proc = null;
    this.ready = false;
  }
}

module.exports = { PluginHost, McpClient };
