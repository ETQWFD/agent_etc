'use strict';

/**
 * 手机版：在主进程里起一个受 token 保护的 HTTP 服务，
 * 手机与电脑在同一局域网时，用浏览器打开即可使用同一个 Agent。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !/^169\.254\./.test(net.address) && !/^127\./.test(net.address)) out.push(net.address);
    }
  }
  return out;
}

class MobileServer {
  constructor({ getState, chat, stop, respondApproval, respondChoice, staticDir }) {
    this.getState = getState;
    this.chat = chat;
    this.stop = stop;
    this.respondApproval = respondApproval;
    this.respondChoice = respondChoice;
    this.staticDir = staticDir;
    this.server = null;
    this.port = 0;
    this.token = '';
    this.clients = new Set();
    this.closed = false;
  }

  randomToken() {
    return crypto.randomBytes(16).toString('hex');
  }

  status() {
    return {
      running: !!this.server,
      port: this.port,
      token: this.token,
      urls: this.server ? lanAddresses().map((ip) => `http://${ip}:${this.port}/?t=${this.token}`) : [],
    };
  }

  start({ port = 8787, token = '' } = {}) {
    return new Promise((resolve, reject) => {
      if (this.server) {
        resolve(this.status());
        return;
      }
      this.token = token || this.randomToken();
      this.closed = false;
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (err) => {
        this.server = null;
        reject(err.code === 'EADDRINUSE' ? new Error(`端口 ${port} 已被占用，请换一个`) : err);
      });
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        this.port = server.address().port;
        resolve(this.status());
      });
    });
  }

  async stop() {
    for (const c of this.clients) {
      try { c.res.end(); } catch (_) { /* ignore */ }
    }
    this.clients.clear();
    if (!this.server) return this.status();
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    this.port = 0;
    return this.status();
  }

  broadcast(sessionId, event) {
    const payload = JSON.stringify({ sessionId, event });
    for (const c of this.clients) {
      if (c.sessionId && c.sessionId !== sessionId) continue;
      try { c.res.write(`data: ${payload}\n\n`); } catch (_) { /* ignore */ }
    }
  }

  broadcastApproval(id, req) {
    const payload = JSON.stringify({ sessionId: '', event: { type: 'approval', id, req } });
    for (const c of this.clients) {
      try { c.res.write(`data: ${payload}\n\n`); } catch (_) { /* ignore */ }
    }
  }

  broadcastChoice(id, req) {
    const payload = JSON.stringify({ sessionId: '', event: { type: 'choice', id, req } });
    for (const c of this.clients) {
      try { c.res.write(`data: ${payload}\n\n`); } catch (_) { /* ignore */ }
    }
  }

  checkAuth(req, url) {
    const header = req.headers['x-etc-token'];
    if (header && header === this.token) return true;
    const q = url.searchParams.get('t');
    if (q && q === this.token) return true;
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/(?:^|;\s*)etc_token=([^;]+)/);
    return !!(m && m[1] === this.token);
  }

  sendJson(res, code, data) {
    const body = JSON.stringify(data);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  readBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 2 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); }
      });
    });
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/' || pathname === '/index.html') {
      if (!this.checkAuth(req, url)) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0a0a0b;color:#e8e8ee;font-family:system-ui;padding:40px">访问令牌无效或缺失。请在电脑端「设置 → 手机版」复制完整链接。</body>');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `etc_token=${this.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      });
      res.end(fs.readFileSync(path.join(this.staticDir, 'index.html')));
      return;
    }

    if (pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': MIME['.webmanifest'] });
      res.end(JSON.stringify({
        name: 'agent_etc 手机版',
        short_name: 'agent_etc',
        start_url: `/?t=${this.token}`,
        display: 'standalone',
        background_color: '#0a0a0b',
        theme_color: '#0a0a0b',
        icons: [{ src: `/icon.png?t=${this.token}`, sizes: '512x512', type: 'image/png' }],
      }));
      return;
    }

    if (pathname === '/icon.png') {
      const p = path.join(this.staticDir, 'icon.png');
      if (fs.existsSync(p)) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
        res.end(fs.readFileSync(p));
      } else {
        res.writeHead(404); res.end();
      }
      return;
    }

    if (!this.checkAuth(req, url)) {
      this.sendJson(res, 401, { ok: false, error: '令牌无效' });
      return;
    }

    if (pathname === '/api/state') {
      try {
        this.sendJson(res, 200, { ok: true, ...(await this.getState()) });
      } catch (err) {
        this.sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const client = { res, sessionId: url.searchParams.get('sid') || '' };
      this.clients.add(client);
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
      }, 25000);
      req.on('close', () => {
        clearInterval(ping);
        this.clients.delete(client);
      });
      return;
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = await this.readBody(req);
      try {
        const result = await this.chat(body);
        this.sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        this.sendJson(res, 200, { ok: false, error: err.message });
      }
      return;
    }

    if (pathname === '/api/stop' && req.method === 'POST') {
      try { this.stop(); this.sendJson(res, 200, { ok: true }); } catch (err) { this.sendJson(res, 500, { ok: false, error: err.message }); }
      return;
    }

    if (pathname === '/api/choice' && req.method === 'POST') {
      const body = await this.readBody(req);
      try { this.respondChoice(body.id, body.answer || {}); this.sendJson(res, 200, { ok: true }); } catch (err) { this.sendJson(res, 500, { ok: false, error: err.message }); }
      return;
    }

    if (pathname === '/api/approval' && req.method === 'POST') {
      const body = await this.readBody(req);
      try { this.respondApproval(body.id, !!body.approved); this.sendJson(res, 200, { ok: true }); } catch (err) { this.sendJson(res, 500, { ok: false, error: err.message }); }
      return;
    }

    if (pathname === '/api/session' && req.method === 'POST') {
      const body = await this.readBody(req);
      try {
        const s = await this.chat({ newSession: true, title: body.title || '手机任务' });
        this.sendJson(res, 200, { ok: true, ...s });
      } catch (err) {
        this.sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    this.sendJson(res, 404, { ok: false, error: 'not found' });
  }
}

module.exports = { MobileServer, lanAddresses };
