'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { ConfigStore } = require('./config');
const { SessionStore } = require('./sessions');
const { PluginHost } = require('./plugins');
const { LocalModelRunner } = require('./llamacpp');
const { Agent } = require('./agent');

const APP_ROOT = path.join(__dirname, '..', '..');
const isDev = !app.isPackaged;

protocol.registerSchemesAsPrivileged([
  { scheme: 'etcfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let config = null;
let sessions = null;
let pluginHost = null;
let localModel = null;
let agent = null;
const approvals = new Map();

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: '#0a0a0b',
    show: false,
    title: 'agent_etc',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
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
  pluginHost = new PluginHost({
    appRoot: APP_ROOT,
    userDataDir: app.getPath('userData'),
    getConfig: () => config.get(),
    onToolsChanged: () => { if (agent) agent.syncPluginTools(); },
  });
  localModel = new LocalModelRunner({ getConfig: () => config.get() });
  agent = new Agent({
    config,
    sessions,
    pluginHost,
    localModel,
    appRoot: APP_ROOT,
    userDataDir: app.getPath('userData'),
    emit: (sessionId, event) => send('agent:event', { sessionId, event }),
    requestApproval: (req) => new Promise((resolve) => {
      const id = crypto.randomUUID();
      approvals.set(id, resolve);
      send('agent:approval', { id, req });
      setTimeout(() => {
        if (approvals.has(id)) {
          approvals.delete(id);
          resolve(false);
        }
      }, 120000);
    }),
  });
  pluginHost.reloadAll().catch((err) => console.error('[plugins] 初始化失败', err));
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
  ipcMain.handle('config:patch', (_e, patch) => config.patch(patch));

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
    const cfg = config.get();
    const disabled = new Set(cfg.skills?.disabled || []);
    if (enabled) disabled.delete(id); else disabled.add(id);
    config.patch({ skills: { disabled: [...disabled] } });
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
});

app.on('window-all-closed', () => {
  pluginHost?.shutdown();
  app.quit();
});

app.on('before-quit', () => {
  try { localModel?.stop(); } catch (_) { /* ignore */ }
  try { pluginHost?.shutdown(); } catch (_) { /* ignore */ }
});
