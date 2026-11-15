'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detectBrowsers() {
  const candidates = [];
  const platform = process.platform;
  if (platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['LOCALAPPDATA'],
    ].filter(Boolean);
    const rels = [
      ['Google\\Chrome\\Application\\chrome.exe', 'Google Chrome'],
      ['Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Edge'],
      ['BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Brave'],
      ['Chromium\\Application\\chrome.exe', 'Chromium'],
    ];
    for (const root of roots) {
      for (const [rel, name] of rels) {
        const full = path.join(root, rel);
        if (fs.existsSync(full)) candidates.push({ name, path: full });
      }
    }
  } else if (platform === 'darwin') {
    const rels = [
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome'],
      ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Microsoft Edge'],
      ['/Applications/Chromium.app/Contents/MacOS/Chromium', 'Chromium'],
    ];
    for (const [full, name] of rels) if (fs.existsSync(full)) candidates.push({ name, path: full });
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      const found = which(bin);
      if (found) candidates.push({ name: bin, path: found });
    }
  }
  return candidates;
}

function which(bin) {
  const paths = String(process.env.PATH || '').split(path.delimiter);
  for (const p of paths) {
    const full = path.join(p, bin);
    try { if (fs.existsSync(full)) return full; } catch (_) { /* ignore */ }
  }
  return '';
}

class BrowserManager {
  constructor({ getConfig }) {
    this.getConfig = getConfig;
    this.ws = null;
    this.browserProcess = null;
    this.sessionId = null;
    this.targetId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onDisconnect = null;
  }

  async status() {
    const cfg = this.getConfig().browser;
    const detected = detectBrowsers();
    const exe = cfg.exePath || detected[0]?.path || '';
    let connected = false;
    try {
      const info = await this.httpJson(cfg.port, '/json/version', 1500);
      connected = !!info;
    } catch (_) { connected = false; }
    return {
      detected,
      exePath: exe,
      port: cfg.port,
      running: !!this.ws && this.ws.readyState === WebSocket.OPEN,
      debuggingEndpoint: connected,
      headless: !!cfg.headless,
      targetId: this.targetId,
    };
  }

  async httpJson(port, suffix, timeout = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${suffix}`, { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async ensure() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (!this.sessionId) await this.attachPage();
      return;
    }
    const cfg = this.getConfig().browser;
    let version = null;
    try { version = await this.httpJson(cfg.port, '/json/version', 1500); } catch (_) { version = null; }
    if (!version) await this.launch();
    await this.connect();
    await this.attachPage();
  }

  async launch() {
    const cfg = this.getConfig().browser;
    const exe = cfg.exePath || detectBrowsers()[0]?.path;
    if (!exe) throw new Error('未找到 Chrome / Edge，请在「设置 → 浏览器」里手动指定浏览器路径');
    if (!fs.existsSync(exe)) throw new Error(`浏览器路径不存在：${exe}`);
    const profile = cfg.profileDir || path.join(path.dirname(this.getConfig().workspace), 'agent_etc-browser-profile');
    try { await fsp.mkdir(profile, { recursive: true }); } catch (_) { /* ignore */ }
    const args = [
      `--remote-debugging-port=${cfg.port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      'about:blank',
    ];
    if (cfg.headless) args.unshift('--headless=new');
    this.browserProcess = spawn(exe, args, { detached: false, stdio: 'ignore' });
    this.browserProcess.on('error', (err) => console.error('[browser] 启动失败', err));
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      try {
        const v = await this.httpJson(cfg.port, '/json/version', 1500);
        if (v) return v;
      } catch (_) { /* 继续等待 */ }
    }
    throw new Error('浏览器已启动但调试端口没有响应，请检查是否被安全软件拦截');
  }

  async connect() {
    const cfg = this.getConfig().browser;
    const version = await this.httpJson(cfg.port, '/json/version');
    const wsUrl = version.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('浏览器没有开放调试 WebSocket');
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, handshakeTimeout: 10000 });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连接浏览器调试端口超时')), 10000);
      this.ws.once('open', () => { clearTimeout(t); resolve(); });
      this.ws.once('error', (err) => { clearTimeout(t); reject(err); });
    });
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message || 'CDP 错误'}${msg.error.data ? `: ${msg.error.data}` : ''}`));
        else resolve(msg.result);
      }
    });
    this.ws.on('close', () => {
      this.pending.forEach(({ reject }) => reject(new Error('浏览器连接已断开')));
      this.pending.clear();
      this.sessionId = null;
      if (this.onDisconnect) this.onDisconnect();
    });
  }

  send(method, params = {}, sessionId = undefined) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('浏览器未连接'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器指令超时：${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async attachPage() {
    const { targetInfos } = await this.send('Target.getTargets');
    const pages = (targetInfos || []).filter((t) => t.type === 'page');
    const page = pages.find((t) => !/^(chrome|edge|about):/.test(t.url)) || pages[0];
    if (!page) throw new Error('浏览器里没有可用页面');
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.sessionId = sessionId;
    this.targetId = page.targetId;
    await this.send('Page.enable', {}, sessionId).catch(() => {});
    await this.send('Runtime.enable', {}, sessionId).catch(() => {});
  }

  async open(url) {
    await this.ensure();
    let targetId;
    if (this.sessionId) {
      await this.send('Page.navigate', { url }, this.sessionId).catch(async () => {
        const res = await this.send('Target.createTarget', { url });
        targetId = res.targetId;
      });
    } else {
      const res = await this.send('Target.createTarget', { url });
      targetId = res.targetId;
    }
    if (targetId) {
      const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
      this.sessionId = sessionId;
      this.targetId = targetId;
      await this.send('Page.enable', {}, sessionId).catch(() => {});
    }
    await sleep(800);
    try { await this.send('Page.waitForLoadState', {}, this.sessionId); } catch (_) { /* Chrome 不支持，忽略 */ }
    const info = await this.evaluate('({url: location.href, title: document.title, readyState: document.readyState})');
    return info;
  }

  async evaluate(expression) {
    await this.ensure();
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, this.sessionId);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || '页面脚本执行失败');
    }
    return res.result?.value;
  }

  async readText(maxChars = 12000) {
    const data = await this.evaluate(`(() => {
      const body = document.body ? document.body.innerText : '';
      return { url: location.href, title: document.title, text: body };
    })()`);
    return { ...data, text: String(data.text || '').slice(0, maxChars) };
  }

  async click(target) {
    const expr = `(() => {
      const target = ${JSON.stringify(String(target))};
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      let el = null;
      try { el = document.querySelector(target); } catch (e) { el = null; }
      if (!el) {
        const all = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],li,div,span')];
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const want = norm(target);
        el = all.find((e) => visible(e) && norm(e.innerText) === want)
          || all.find((e) => visible(e) && norm(e.innerText).includes(want) && want.length > 1);
        if (el && el.tagName === 'SPAN' && el.closest('a,button,[role=button]')) el = el.closest('a,button,[role=button]');
      }
      if (!el) return { ok: false, reason: '未找到元素' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: (el.innerText || '').slice(0, 80) };
    })()`;
    return this.evaluate(expr);
  }

  async type(field, text, submit = false) {
    const expr = `(() => {
      const field = ${JSON.stringify(String(field))};
      const text = ${JSON.stringify(String(text))};
      let el = null;
      try { el = document.querySelector(field); } catch (e) { el = null; }
      if (!el) {
        const all = [...document.querySelectorAll('input,textarea,[contenteditable=true]')];
        el = all.find((e) => (e.placeholder || '').includes(field) || (e.getAttribute('aria-label') || '').includes(field) || (e.name || '') === field);
      }
      if (!el) return { ok: false, reason: '未找到输入框' };
      el.focus();
      if (el.isContentEditable) {
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      } else {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      ${submit ? `el.form && el.form.requestSubmit ? el.form.requestSubmit() : el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));` : ''}
      return { ok: true, tag: el.tagName };
    })()`;
    const res = await this.evaluate(expr);
    if (submit) await sleep(1200);
    return res;
  }

  async scroll(delta = 800) {
    await this.evaluate(`window.scrollBy(0, ${Number(delta) || 800}); 'ok'`);
    return { ok: true };
  }

  async screenshot(dir) {
    await this.ensure();
    try { await fsp.mkdir(dir, { recursive: true }); } catch (_) { /* ignore */ }
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, this.sessionId);
    const file = path.join(dir, `browser-${Date.now()}.png`);
    await fsp.writeFile(file, Buffer.from(shot.data, 'base64'));
    return { path: file, bytes: Buffer.from(shot.data, 'base64').length };
  }

  async close() {
    try { if (this.ws) this.ws.close(); } catch (_) { /* ignore */ }
    this.ws = null;
    this.sessionId = null;
    if (this.browserProcess) {
      try { this.browserProcess.kill(); } catch (_) { /* ignore */ }
      this.browserProcess = null;
    }
    return { ok: true };
  }

  async stopBrowser() {
    const cfg = this.getConfig().browser;
    try {
      const version = await this.httpJson(cfg.port, '/json/version', 1500);
      if (version?.webSocketDebuggerUrl) {
        const { spawnSync } = require('child_process');
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(this.browserProcess?.pid || ''), '/T', '/F'], { windowsHide: true });
        }
        void version;
      }
    } catch (_) { /* ignore */ }
    return this.close();
  }
}

function registerBrowserTools(registry, manager, getWorkspace) {
  registry.register({
    name: 'browser_open',
    description: '用本机浏览器打开网址（保留登录态），返回标题与地址。',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的网址' } },
      required: ['url'],
    },
    async run(args, ctx) {
      const approved = await ctx.approve({ kind: 'browser', title: '打开浏览器', detail: String(args.url) });
      if (!approved) return { skipped: true, reason: '用户拒绝打开浏览器' };
      return manager.open(args.url);
    },
  });

  registry.register({
    name: 'browser_read',
    description: '读取当前网页的标题、地址与正文纯文本。',
    parameters: {
      type: 'object',
      properties: { maxChars: { type: 'number', description: '最多返回字符数，默认 12000' } },
    },
    async run(args) {
      return manager.readText(Number(args.maxChars) || 12000);
    },
  });

  registry.register({
    name: 'browser_click',
    description: '点击页面元素。参数可以是 CSS 选择器，也可以是元素的可见文字。',
    danger: true,
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: 'CSS 选择器或元素文字' } },
      required: ['target'],
    },
    async run(args, ctx) {
      const approved = await ctx.approve({ kind: 'browser', title: '点击页面元素', detail: String(args.target) });
      if (!approved) return { skipped: true, reason: '用户拒绝这次点击' };
      return manager.click(args.target);
    },
  });

  registry.register({
    name: 'browser_type',
    description: '在输入框填写文本，可选择直接提交。',
    danger: true,
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'CSS 选择器、placeholder 或字段名' },
        text: { type: 'string', description: '要填入的文本' },
        submit: { type: 'boolean', description: '填完后是否回车提交' },
      },
      required: ['field', 'text'],
    },
    async run(args, ctx) {
      const approved = await ctx.approve({ kind: 'browser', title: '填写表单', detail: `${args.field} ← ${String(args.text).slice(0, 60)}`, preview: args.submit ? '将自动提交' : '' });
      if (!approved) return { skipped: true, reason: '用户拒绝这次表单填写' };
      return manager.type(args.field, args.text, !!args.submit);
    },
  });

  registry.register({
    name: 'browser_scroll',
    description: '向下滚动页面，加载更多内容。',
    parameters: {
      type: 'object',
      properties: { delta: { type: 'number', description: '滚动像素，默认 800' } },
    },
    async run(args) {
      return manager.scroll(args.delta);
    },
  });

  registry.register({
    name: 'browser_screenshot',
    description: '截取当前网页画面并保存为 PNG，返回本地文件路径。',
    parameters: { type: 'object', properties: {} },
    async run() {
      const dir = path.join(getWorkspace(), 'screenshots');
      return manager.screenshot(dir);
    },
  });

  registry.register({
    name: 'browser_eval',
    description: '在当前页面执行任意 JavaScript 并返回结果（高级用法，谨慎）。',
    danger: true,
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JavaScript 表达式' } },
      required: ['expression'],
    },
    async run(args, ctx) {
      const approved = await ctx.approve({ kind: 'browserEval', title: '在页面执行脚本', detail: String(args.expression).slice(0, 200) });
      if (!approved) return { skipped: true, reason: '用户拒绝执行页面脚本' };
      return manager.evaluate(args.expression);
    },
  });
}

module.exports = { BrowserManager, registerBrowserTools, detectBrowsers };
