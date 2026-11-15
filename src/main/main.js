'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { ConfigStore } = require('./config');
const { MemoryStore } = require('./memory');
const { Marketplace } = require('./marketplace');
const { QQBridge } = require('./qq');
const { SessionStore } = require('./sessions');
const { PluginHost } = require('./plugins');
const { LocalModelRunner } = require('./llamacpp');
const { Agent } = require('./agent');
const { MobileServer } = require('./mobile');
const { checkUpdate } = require('./updates');

// 打包后 __dirname 位于 resources/app.asar/src/main；用 app.getAppPath() 避免
// 安装到任意目录（含空格、中文、其他盘）时依赖固定的相对层级。
const APP_ROOT = app.getAppPath();
const isDev = !app.isPackaged;

protocol.registerSchemesAsPrivileged([
  { scheme: 'etcfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

function focusExistingWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

let win = null;
let config = null;
let sessions = null;
let pluginHost = null;
let memory = null;
let marketplace = null;
let qq = null;
let localModel = null;
let agent = null;
let mobile = null;
const approvals = new Map();
const choices = new Map();

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: '#0a0a0b',
    show: false,
    title: 'agent_etc',
    ...(fs.existsSync(path.join(APP_ROOT, 'build', 'icon.png'))
      ? { icon: path.join(APP_ROOT, 'build', 'icon.png') }
      : {}),
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0a0a0b', symbolColor: '#d2d2da', height: 56 },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    const msg = `界面加载失败（${code} ${desc}）\n${url || ''}`;
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'startup-error.log'), `${new Date().toISOString()} ${msg}\n`); } catch (_e) {}
    try { dialog.showErrorBox('agent_etc 界面加载失败', msg); } catch (_e) {}
  });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function initServices() {
  config = new ConfigStore();
  sessions = new SessionStore(app.getPath('userData'));
  memory = new MemoryStore(path.join(app.getPath('userData'), 'memory.json'));
  pluginHost = new PluginHost({
    appRoot: APP_ROOT,
    userDataDir: app.getPath('userData'),
    getConfig: () => config.get(),
    onToolsChanged: () => { if (agent) agent.syncPluginTools(); },
  });
  qq = new QQBridge({
    getConfig: () => config.get(),
    agent,
    sessions,
    onChange: (st) => send('qq:status', st),
  });
  marketplace = new Marketplace({
    getConfig: () => config.get(),
    pluginHost,
    userDataDir: app.getPath('userData'),
  });
  localModel = new LocalModelRunner({
    getConfig: () => config.get(),
    appRoot: APP_ROOT,
    userDataDir: app.getPath('userData'),
  });
  agent = new Agent({
    config,
    sessions,
    pluginHost,
    localModel,
    memory,
    appRoot: APP_ROOT,
    userDataDir: app.getPath('userData'),
    emit: (sessionId, event) => {
      send('agent:event', { sessionId, event });
      mobile?.broadcast(sessionId, event);
    },
    askUser: (req) => new Promise((resolve) => {
      const id = crypto.randomUUID();
      choices.set(id, resolve);
      send('agent:choice', { id, ...req });
      mobile?.broadcastChoice(id, req);
      setTimeout(() => {
        if (choices.has(id)) {
          choices.delete(id);
          resolve({ cancelled: true, note: '用户没有在 2 分钟内选择' });
        }
      }, 120000);
    }),
    requestApproval: (req) => new Promise((resolve) => {
      const id = crypto.randomUUID();
      approvals.set(id, resolve);
      send('agent:approval', { id, req });
      mobile?.broadcastApproval(id, req);
      setTimeout(() => {
        if (approvals.has(id)) {
          approvals.delete(id);
          resolve(false);
        }
      }, 120000);
    }),
  });
  mobile = new MobileServer({
    staticDir: path.join(APP_ROOT, 'src', 'mobile'),
    getState: () => mobileState(),
    chat: (payload) => mobileChat(payload),
    stop: () => agent.stop(),
    respondApproval: (id, approved) => {
      const resolve = approvals.get(id);
      if (resolve) {
        approvals.delete(id);
        resolve(!!approved);
      }
    },
    respondChoice: (id, answer) => {
      const resolve = choices.get(id);
      if (resolve) {
        choices.delete(id);
        resolve({ ...(answer || {}), ok: true });
      }
    },
  });
  if (qq) qq.agent = agent;
  pluginHost.reloadAll().catch((err) => console.error('[plugins] 初始化失败', err));
  if (config.get().qq?.enabled && qq) {
    qq.start().catch((err) => console.error('[qq] 启动失败', err.message));
  }
  if (config.get().mobile?.enabled) {
    mobile.start({ port: config.get().mobile.port, token: config.get().mobile.token })
      .then((st) => {
        if (st.token !== config.get().mobile.token) config.patch({ mobile: { token: st.token } });
        console.log('[mobile] 已启动', st.port);
      })
      .catch((err) => console.error('[mobile] 启动失败', err.message));
  }
}

function lastSession() {
  const list = sessions.list();
  if (!list.length) return null;
  const id = config.get().ui?.lastSessionId;
  const s = (id && sessions.get(id)) || sessions.get(list[0].id);
  return s ? agent.publicSession(s) : null;
}

function mobileState() {
  const cfg = config.get();
  const provider = cfg.activeProviderId === 'local-gguf' ? localModel.provider() : config.getProvider(cfg.activeProviderId);
  return {
    version: app.getVersion(),
    provider: provider ? { id: provider.id, name: provider.name, model: provider.model } : null,
    sessions: sessions.list(),
    session: lastSession(),
    local: localModel.status(),
    browser: agent.browser.status(),
  };
}

async function mobileChat(payload) {
  if (payload?.newSession) {
    const s = sessions.create(payload.title || '手机任务');
    return { sessionId: s.id, session: agent.publicSession(s) };
  }
  const text = String(payload?.text || '').trim();
  if (!text) throw new Error('内容为空');
  const s = sessions.get(payload.sessionId) || sessions.create(text.slice(0, 20));
  config.patch({ ui: { lastSessionId: s.id } });
  agent.run({ session: s, text, attachments: [] }).catch((err) => {
    console.error('[mobile] 任务失败', err.message);
  });
  return { sessionId: s.id, session: agent.publicSession(s) };
}

function registerProtocol() {
  protocol.handle('etcfile', async (request) => {
    try {
      const url = new URL(request.url);
      const encoded = url.searchParams.get('p') || decodeURIComponent(url.pathname.replace(/^\//, ''));
      const filePath = decodeURIComponent(encoded);
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      return new Response(`文件读取失败：${err.message}`, { status: 404 });
    }
  });
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: 'agent_etc',
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    appRoot: APP_ROOT,
    isDev,
  }));

  ipcMain.handle('config:get', () => config.get());

  ipcMain.handle('memory:list', () => memory.all(80));
  ipcMain.handle('memory:save', (_e, { text, importance }) => {
    const item = memory.remember(text, { importance, source: 'user' });
    return item ? { ok: true, id: item.id } : { ok: false, error: '内容为空' };
  });
  ipcMain.handle('memory:search', (_e, { query, limit }) => memory.search(query, limit || 10));
  ipcMain.handle('memory:forget', (_e, id) => ({ ok: memory.forget(id) }));

  ipcMain.handle('plugin:market-search', async (_e, { source, query }) => {
    try { return await marketplace.search({ source, query }); } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('plugin:market-install', async (_e, entry) => {
    try { return await marketplace.install(entry); } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('config:patch', (_e, patch) => {
    const next = config.patch(patch);
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'qq') && qq) {
      if (next.qq?.enabled) qq.start().catch((err) => console.error('[qq]', err.message));
      else qq.stop();
    }
    return next;
  });
  ipcMain.handle('qq:status', () => qq.status);
  ipcMain.handle('qq:test', () => qq.test());
  ipcMain.handle('qq:start', async () => { await qq.start(); return qq.status; });
  ipcMain.handle('qq:stop', () => { qq.stop(); return qq.status; });

  ipcMain.handle('provider:save', (_e, provider) => {
    if (!provider.id) {
      provider.id = `provider-${Math.random().toString(36).slice(2, 8)}`;
      return config.addProvider(provider);
    }
    return config.updateProvider(provider.id, provider);
  });
  ipcMain.handle('provider:delete', (_e, id) => {
    config.removeProvider(id);
    return config.get();
  });
  ipcMain.handle('provider:activate', (_e, id) => {
    config.patch({ activeProviderId: id });
    return config.get();
  });
  ipcMain.handle('provider:test', async (_e, provider) => {
    const { testProvider } = require('./providers');
    return testProvider(provider);
  });

  ipcMain.handle('session:list', () => sessions.list());
  ipcMain.handle('session:get', (_e, id) => {
    const s = sessions.get(id);
    return s ? agent.publicSession(s) : null;
  });
  ipcMain.handle('session:create', (_e, title) => {
    const s = sessions.create(title);
    return agent.publicSession(s);
  });
  ipcMain.handle('session:delete', (_e, id) => { sessions.remove(id); return true; });
  ipcMain.handle('session:rename', (_e, { id, title }) => {
    const s = sessions.rename(id, title);
    return s ? agent.publicSession(s) : null;
  });

  ipcMain.handle('chat:send', async (_e, { sessionId, text, attachments }) => {
    const s = sessions.get(sessionId) || sessions.create(text?.slice(0, 20));
    config.patch({ ui: { lastSessionId: s.id } });
    try {
      const result = await agent.run({ session: s, text, attachments: attachments || [] });
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('chat:stop', () => { agent.stop(); return true; });

  ipcMain.handle('plugin:list', () => pluginHost.list());
  ipcMain.handle('plugin:toggle', (_e, { id, enabled }) => pluginHost.setEnabled(id, enabled));
  ipcMain.handle('plugin:install', async () => {
    const picked = await dialog.showOpenDialog(win, { title: '选择插件目录（内含 plugin.json）', properties: ['openDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    return pluginHost.installFromFolder(picked.filePaths[0]);
  });
  ipcMain.handle('plugin:uninstall', (_e, id) => pluginHost.uninstall(id));
  ipcMain.handle('plugin:add-mcp', async (_e, server) => pluginHost.addMcpServer(server));

  ipcMain.handle('skill:list', () => agent.listSkills());
  ipcMain.handle('skill:toggle', (_e, { id, enabled }) => {
    agent.skills.setEnabled(id, !!enabled);
    return agent.listSkills();
  });
  ipcMain.handle('skill:open', async (_e, id) => {
    const skill = agent.listSkills().find((s) => s.id === id);
    if (skill) shell.openPath(skill.path);
    return true;
  });
  ipcMain.handle('skill:edit', async (_e, id) => {
    const skill = agent.listSkills().find((s) => s.id === id);
    if (!skill) return false;
    const res = await shell.openPath(skill.path);
    return res === '';
  });
  ipcMain.handle('skill:import-file', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: '导入技能（可多选 .md / .zip）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '技能', extensions: ['md', 'zip'] }, { name: '全部文件', extensions: ['*'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    const results = [];
    for (const p of picked.filePaths) results.push(await agent.skills.importPath(p));
    return { imported: results.reduce((n, r) => n + r.imported, 0), results, list: agent.listSkills() };
  });
  ipcMain.handle('skill:import-folder', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: '导入技能目录（含 SKILL.md，或目录内多个 .md）',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const r = await agent.skills.importPath(picked.filePaths[0]);
    return { ...r, list: agent.listSkills() };
  });
  ipcMain.handle('skill:import-harness', async () => {
    const r = await agent.skills.importFromHarness();
    return { ...r, list: agent.listSkills() };
  });
  ipcMain.handle('skill:remove', async (_e, id) => {
    const r = agent.skills.remove(id);
    return { ...r, list: agent.listSkills() };
  });

  ipcMain.handle('browser:status', () => agent.browser.status());
  ipcMain.handle('browser:launch', async () => {
    try {
      await agent.browser.launch();
      await agent.browser.connect();
      await agent.browser.attachPage();
      return { ok: true, status: await agent.browser.status() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('browser:stop', () => agent.browser.stopBrowser());

  ipcMain.handle('localmodel:status', () => localModel.status());
  ipcMain.handle('localmodel:start', async () => {
    try {
      const status = await localModel.start();
      config.patch({ activeProviderId: 'local-gguf' });
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: err.message, status: localModel.status() };
    }
  });
  ipcMain.handle('localmodel:stop', () => localModel.stop());
  ipcMain.handle('localmodel:pick-runtime', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: '选择 llama.cpp 运行时',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: '可执行文件', extensions: ['exe'] }] : [],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    config.patch({ localModel: { runtimePath: picked.filePaths[0] } });
    return picked.filePaths[0];
  });
  ipcMain.handle('localmodel:pick-model', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: '选择 GGUF 模型',
      properties: ['openFile'],
      filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    config.patch({ localModel: { modelPath: picked.filePaths[0] } });
    return picked.filePaths[0];
  });
  ipcMain.handle('localmodel:install-engine', async () => {
    try {
      const r = await localModel.installEngine();
      config.patch({ localModel: { runtimePath: r.path } });
      return { ok: true, path: r.path, version: r.version, logs: r.logs, status: localModel.status() };
    } catch (err) {
      return { ok: false, error: err.message, status: localModel.status() };
    }
  });
  ipcMain.handle('localmodel:inspect', () => localModel.status().engine);

  ipcMain.handle('app:check-update', async () => {
    try {
      return await checkUpdate(app.getVersion());
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('mobile:status', () => mobile.status());
  ipcMain.handle('mobile:start', async () => {
    try {
      const cfg = config.get().mobile || {};
      const st = await mobile.start({ port: Number(cfg.port) || 8787, token: cfg.token || '' });
      config.patch({ mobile: { enabled: true, token: st.token, port: st.port } });
      return { ok: true, ...st };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('mobile:stop', async () => {
    const st = await mobile.stop();
    config.patch({ mobile: { enabled: false } });
    return { ok: true, ...st };
  });
  ipcMain.handle('mobile:save', (_e, patch) => {
    config.patch({ mobile: patch || {} });
    return mobile.status();
  });

  ipcMain.handle('dialog:pick-files', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: '选择附件',
      properties: ['openFile', 'multiSelections'],
    });
    return picked.canceled ? [] : picked.filePaths;
  });
  ipcMain.handle('dialog:pick-folder', async () => {
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return picked.canceled ? null : picked.filePaths[0];
  });

  ipcMain.handle('app:open-external', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:open-path', async (_e, p) => {
    const target = p || config.get().workspace;
    const res = await shell.openPath(target);
    return res === '' ? { ok: true } : { ok: false, error: res };
  });

  ipcMain.handle('choice:respond', (_e, { id, answer }) => {
    const resolve = choices.get(id);
    if (resolve) {
      choices.delete(id);
      resolve({ ...(answer || {}), ok: true });
    }
    return true;
  });

  ipcMain.handle('approval:respond', (_e, { id, approved }) => {
    const resolve = approvals.get(id);
    if (resolve) {
      approvals.delete(id);
      resolve(!!approved);
    }
    return true;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  initServices();
  registerProtocol();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('second-instance', focusExistingWindow);
}).catch((err) => {
  const msg = String((err && err.stack) || err || '未知启动错误');
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'startup-error.log'), `${new Date().toISOString()} ${msg}\n`); } catch (_e) {}
  try { dialog.showErrorBox('agent_etc 启动失败', msg.slice(0, 1200)); } catch (_e) {}
  app.quit();
});

app.on('window-all-closed', () => {
  pluginHost?.shutdown();
  app.quit();
});

app.on('before-quit', () => {
  try { localModel?.stop(); } catch (_) { /* ignore */ }
  try { mobile?.stop(); } catch (_) { /* ignore */ }
  try { pluginHost?.shutdown(); } catch (_) { /* ignore */ }
});
