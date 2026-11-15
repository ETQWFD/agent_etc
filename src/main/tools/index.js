'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool || !tool.name || typeof tool.run !== 'function') {
      throw new Error('工具定义不完整：需要 name 与 run()');
    }
    this.tools.set(tool.name, {
      danger: false,
      source: 'builtin',
      parameters: { type: 'object', properties: {} },
      ...tool,
    });
    return this.tools.get(tool.name);
  }

  unregister(name) {
    this.tools.delete(name);
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
      danger: !!t.danger,
      source: t.source,
    }));
  }

  schemaForModel() {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async run(name, args, ctx) {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `工具不存在：${name}` };
    try {
      const result = await tool.run(args || {}, ctx);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }
}

function resolvePath(input, workspace) {
  if (!input) return workspace;
  const p = String(input);
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  if (path.isAbsolute(p)) return p;
  return path.join(workspace, p);
}

function stripHtml(html) {
  let text = String(html);
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>|<\/div>|<\/li>|<\/h\d>|<\/tr>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  const entities = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" };
  text = text.replace(/&(nbsp|lt|gt|amp|quot|#39);/g, (m) => entities[m] || m);
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function registerCoreTools(registry, deps) {
  const { getConfig } = deps;

  registry.register({
    name: 'fs_list',
    description: '列出目录内容，返回名称、类型、大小。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径，留空表示当前工作区' } },
    },
    async run(args, ctx) {
      const target = resolvePath(args.path, getConfig().workspace);
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const rows = [];
      for (const e of entries.slice(0, 200)) {
        let size = 0;
        try {
          if (e.isFile()) size = (await fsp.stat(path.join(target, e.name))).size;
        } catch (_) { /* ignore */ }
        rows.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size });
      }
      return { path: target, count: rows.length, entries: rows };
    },
  });

  registry.register({
    name: 'fs_read',
    description: '读取文本文件内容（最多 200KB），返回带行号的文本。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        offset: { type: 'number', description: '起始行号，从 1 开始' },
        limit: { type: 'number', description: '最多读取行数，默认 400' },
      },
      required: ['path'],
    },
    async run(args) {
      const target = resolvePath(args.path, getConfig().workspace);
      const stat = await fsp.stat(target);
      if (stat.size > 200 * 1024) throw new Error(`文件过大（${Math.round(stat.size / 1024)}KB），请改用 shell_run 分段读取`);
      const raw = await fsp.readFile(target, 'utf8');
      const lines = raw.split(/\r?\n/);
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.max(1, Number(args.limit) || 400);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      return {
        path: target,
        totalLines: lines.length,
        text: slice.map((l, i) => `${offset + i}\t${l}`).join('\n'),
      };
    },
  });

  registry.register({
    name: 'fs_write',
    description: '写入文本文件（覆盖或新建），自动创建父目录。写操作需用户确认。',
    danger: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对路径基于工作区' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
    async run(args, ctx) {
      const target = resolvePath(args.path, getConfig().workspace);
      const approved = await ctx.approve({
        kind: 'write',
        title: '写入文件',
        detail: target,
        preview: String(args.content || '').slice(0, 800),
      });
      if (!approved) return { skipped: true, reason: '用户拒绝了这次写入' };
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, String(args.content ?? ''), 'utf8');
      return { path: target, bytes: Buffer.byteLength(String(args.content ?? '')) };
    },
  });

  registry.register({
    name: 'shell_run',
    description: '在本机执行 shell 命令并返回 stdout/stderr。命令执行需用户确认。',
    danger: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录，默认工作区' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 60000' },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      const cwd = resolvePath(args.cwd, getConfig().workspace);
      const approved = await ctx.approve({ kind: 'shell', title: '执行命令', detail: String(args.command), preview: `cwd: ${cwd}` });
      if (!approved) return { skipped: true, reason: '用户拒绝了这次命令执行' };
      return runShell(String(args.command), cwd, Number(args.timeoutMs) || 60000);
    },
  });

  registry.register({
    name: 'web_fetch',
    description: '抓取网页并转为纯文本，用于阅读文档、文章、接口返回。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https 链接' },
        maxChars: { type: 'number', description: '最多返回字符数，默认 8000' },
      },
      required: ['url'],
    },
    async run(args, ctx) {
      const maxChars = Math.min(30000, Number(args.maxChars) || 8000);
      const approved = await ctx.approve({ kind: 'network', title: '访问网络', detail: String(args.url) });
      if (!approved) return { skipped: true, reason: '用户拒绝了这次网络请求' };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        const resp = await fetch(args.url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; agent_etc/1.0)', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
          redirect: 'follow',
        });
        const type = resp.headers.get('content-type') || '';
        const body = await resp.text();
        const text = /json|text\/plain/.test(type) ? body : stripHtml(body);
        return { url: args.url, status: resp.status, contentType: type, text: text.slice(0, maxChars) };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { cwd, windowsHide: true })
      : spawn('/bin/bash', ['-lc', command], { cwd });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        child.kill();
        resolve({ ok: false, timedOut: true, stdout: stdout.slice(-6000), stderr: stderr.slice(-3000), exitCode: null });
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 60000) stdout = stdout.slice(-60000); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 30000) stderr = stderr.slice(-30000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!finished) { finished = true; resolve({ ok: false, error: err.message }); }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!finished) {
        finished = true;
        resolve({ ok: code === 0, exitCode: code, stdout: stdout.slice(-6000), stderr: stderr.slice(-3000) });
      }
    });
  });
}

module.exports = { ToolRegistry, registerCoreTools, resolvePath, stripHtml, runShell };
