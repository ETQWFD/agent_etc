'use strict';

/**
 * 插件市场：接 MCP 官方注册表、npm 与可自定义的 JSON 源。
 * 安装后直接进现有 PluginHost（MCP 用 npx 启动，原生插件从 GitHub zip 安装）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function fetchJson(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'agent_etc/1.3.0', accept: 'application/json' } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { clearTimeout(timer); resolve(d); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

function sh(cmd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : '' });
    });
  });
}

class Marketplace {
  constructor({ getConfig, pluginHost, userDataDir }) {
    this.getConfig = getConfig;
    this.pluginHost = pluginHost;
    this.userDataDir = userDataDir;
    this.cache = new Map();
  }

  async search({ source = 'mcp', query = '' }) {
    const q = String(query || '').trim().toLowerCase();
    if (source === 'npm') return this.searchNpm(q);
    if (source === 'custom') return this.searchCustom(q);
    return this.searchMcp(q);
  }

  async searchMcp(q) {
    const pages = [0];
    const out = [];
    const seen = new Set();
    for (const p of pages) {
      let data;
      try {
        data = await fetchJson(`https://registry.modelcontextprotocol.io/v0/servers?limit=100${q ? '&search=' + encodeURIComponent(q) : ''}${p ? '&cursor=' + encodeURIComponent(p) : ''}`);
      } catch (err) {
        if (!out.length) throw new Error(`MCP 注册表不可用：${err.message}`);
        break;
      }
      for (const row of data.servers || []) {
        const v = row.server || {};
        const id = String(v.name || '');
        if (!id || seen.has(id)) continue;
        if (q && !(`${id} ${v.title || ''} ${v.description || ''}`.toLowerCase().includes(q))) continue;
        const pkg = (v.packages || []).find((x) => x && x.identifier);
        if (!pkg) continue; // 远程 HTTP MCP 暂时不在本市场安装
        seen.add(id);
        out.push({
          id,
          name: v.title || id,
          description: String(v.description || '').slice(0, 240),
          version: v.version || pkg.version || '',
          package: pkg.identifier,
          transport: pkg.transport?.type || 'stdio',
          type: 'npm-mcp',
          source: 'MCP 官方注册表',
          homepage: v.websiteUrl || '',
        });
        if (out.length >= 40) break;
      }
    }
    return out;
  }

  async searchNpm(q) {
    const text = `${q || 'mcp'} mcp server`;
    const data = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=30`);
    return (data.objects || []).map((o) => {
      const p = o.package || {};
      return {
        id: `npm:${p.name}`,
        name: p.name,
        description: String(p.description || '').slice(0, 240),
        version: p.version || '',
        package: p.name,
        type: 'npm-mcp',
        source: 'npm',
        homepage: p.links?.homepage || p.links?.npm || '',
      };
    }).filter((x) => x.package);
  }

  async searchCustom(q) {
    const url = (this.getConfig().plugins?.marketplaceUrl || '').trim();
    if (!url) throw new Error('还没有配置自定义插件市场地址');
    const data = await fetchJson(url);
    const items = Array.isArray(data) ? data : (data.items || []);
    return items
      .filter((x) => !q || JSON.stringify(x).toLowerCase().includes(q))
      .slice(0, 60)
      .map((x) => ({
        id: String(x.id || x.name || x.url || ''),
        name: String(x.name || x.id || ''),
        description: String(x.description || ''),
        version: String(x.version || ''),
        package: x.package || '',
        url: x.url || x.repo || '',
        type: x.type || (String(x.url || '').endsWith('.zip') ? 'zip-plugin' : 'npm-mcp'),
        source: '自定义源',
      }))
      .filter((x) => x.id);
  }

  async install(entry) {
    if (!entry || !entry.type) throw new Error('插件条目无效');
    if (entry.type === 'npm-mcp') {
      if (!entry.package) throw new Error('缺少 npm 包名');
      const id = await this.pluginHost.addMcpServer({
        id: `mcp-${String(entry.package).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`,
        name: entry.name || entry.package,
        command: 'npx',
        args: ['-y', entry.package],
        env: {},
        enabled: true,
      });
      return { ok: true, id, kind: 'mcp', package: entry.package };
    }
    if (entry.type === 'zip-plugin' || entry.url) {
      return this.installZip(entry);
    }
    throw new Error(`暂不支持这种插件类型：${entry.type}`);
  }

  async installZip(entry) {
    const url = String(entry.url || '');
    if (!/^https:\/\//.test(url)) throw new Error('只允许 https 插件包');
    const tmp = path.join(os.tmpdir(), `etc-plugin-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const zip = path.join(tmp, 'plugin.zip');
    const r = await sh('curl', ['-fL', '--max-time', '120', '-o', zip, url]);
    if (!r.ok) throw new Error(`下载失败：${r.error || r.stderr}`);
    const un = await sh('unzip', ['-q', '-o', zip, '-d', tmp]);
    if (!un.ok) throw new Error(`解压失败：${un.error || un.stderr}`);
    const found = this.findManifest(tmp, 0);
    if (!found) throw new Error('压缩包里没有 plugin.json');
    const id = await this.pluginHost.installFromFolder(path.dirname(found));
    return { ok: true, id, kind: 'native', path: found };
  }

  findManifest(dir, depth) {
    if (depth > 3) return '';
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return ''; }
    if (items.some((x) => x.isFile() && x.name === 'plugin.json')) return path.join(dir, 'plugin.json');
    for (const it of items) {
      if (!it.isDirectory() || it.name === '__MACOSX') continue;
      const hit = this.findManifest(path.join(dir, it.name), depth + 1);
      if (hit) return hit;
    }
    return '';
  }
}

module.exports = { Marketplace };
