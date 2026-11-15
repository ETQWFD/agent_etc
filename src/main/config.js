'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const DEFAULT_SYSTEM_EXTRA = [
  '你叫 agent_etc，是一个可自改装的桌面 Agent 工作台。',
  '你直接操作用户的电脑：读写文件、执行命令、使用浏览器。动手前先说明你要做什么，做完给出结论。',
  '回答使用与用户相同的语言；涉及文件时给出绝对路径。',
].join('\n');

function defaultConfig() {
  return {
    version: 1,
    activeProviderId: 'openai-compatible',
    providers: [
      {
        id: 'openai-compatible',
        name: 'OpenAI 兼容接口',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        toolMode: 'auto',
        temperature: 0.4,
        maxTokens: 4096,
        headers: {},
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: '',
        model: 'claude-sonnet-4-5',
        toolMode: 'auto',
        temperature: 0.4,
        maxTokens: 4096,
        headers: {},
      },
    ],
    localModel: {
      enabled: false,
      runtimePath: '',
      modelPath: '',
      port: 8090,
      ctx: 8192,
      gpuLayers: 0,
      threads: 0,
      extraArgs: '',
    },
    browser: {
      exePath: '',
      port: 9222,
      headless: false,
      profileDir: '',
    },
    permissions: {
      shell: 'ask',
      write: 'ask',
      browserEval: 'ask',
      desktop: 'ask',
      network: 'auto',
    },
    workspace: '',
    maxSteps: 24,
    systemExtra: DEFAULT_SYSTEM_EXTRA,
    qq: {
      enabled: false,
      endpoint: 'http://127.0.0.1:3001',
      token: '',
      allow: [],
      selfId: '',
    },
    plugins: {
      disabled: [],
      mcp: [],
    },
    skills: {
      disabled: [],
    },
    mobile: {
      enabled: false,
      port: 8787,
      token: '',
    },
    ui: {
      lastSessionId: '',
      showToolDetails: true,
    },
  };
}

class ConfigStore {
  constructor() {
    this.dir = app.getPath('userData');
    this.file = path.join(this.dir, 'agent_etc.config.json');
    this.data = defaultConfig();
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = mergeDeep(defaultConfig(), raw);
      }
    } catch (err) {
      console.error('[config] 读取失败，使用默认配置', err);
    }
    if (!this.data.workspace) {
      this.data.workspace = path.join(app.getPath('documents'), 'agent_etc');
    }
    try {
      fs.mkdirSync(this.data.workspace, { recursive: true });
    } catch (_) {
      this.data.workspace = path.join(os.homedir(), 'agent_etc');
      try { fs.mkdirSync(this.data.workspace, { recursive: true }); } catch (_e) { /* ignore */ }
    }
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[config] 保存失败', err);
    }
  }

  get() {
    return this.data;
  }

  patch(partial) {
    this.data = mergeDeep(this.data, partial || {});
    this.save();
    return this.data;
  }

  getProvider(id) {
    return this.data.providers.find((p) => p.id === id) || this.data.providers[0];
  }

  addProvider(provider) {
    this.data.providers.push(provider);
    this.save();
    return provider;
  }

  updateProvider(id, patchData) {
    const idx = this.data.providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error('模型服务不存在');
    this.data.providers[idx] = { ...this.data.providers[idx], ...patchData, id };
    this.save();
    return this.data.providers[idx];
  }

  removeProvider(id) {
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    if (this.data.activeProviderId === id) {
      this.data.activeProviderId = this.data.providers[0]?.id || '';
    }
    this.save();
  }
}

function mergeDeep(base, extra) {
  if (Array.isArray(extra)) return extra;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    for (const [k, v] of Object.entries(extra)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])
        ? mergeDeep(base[k], v)
        : v;
    }
    return out;
  }
  return extra;
}

module.exports = { ConfigStore, defaultConfig, mergeDeep, DEFAULT_SYSTEM_EXTRA };
