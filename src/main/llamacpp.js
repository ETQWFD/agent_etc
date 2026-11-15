'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const engines = require('./engines');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 本地 GGUF 模型运行时：驱动 llama.cpp 的 llama-server，
 * 起来之后就是标准 OpenAI 兼容接口，Agent 可直接使用。
 *
 * 注意：MNN 的 llm_demo 不是 llama-server，只接受 config.json；
 * 选错时这里会给出明确提示，而不是让它把 --model 当配置路径。
 */
class LocalModelRunner {
  constructor({ getConfig, appRoot, userDataDir }) {
    this.getConfig = getConfig;
    this.appRoot = appRoot;
    this.userDataDir = userDataDir;
    this.proc = null;
    this.logs = [];
    this.state = 'idle'; // idle | starting | running | error
    this.error = '';
  }

  ctx() {
    return { appRoot: this.appRoot, userDataDir: this.userDataDir };
  }

  status() {
    const cfg = this.getConfig().localModel;
    const engine = engines.inspect(this.getConfig(), this.ctx());
    const modelOk = !!cfg.modelPath && fs.existsSync(cfg.modelPath);
    return {
      state: this.state,
      error: this.error,
      runtimePath: cfg.runtimePath,
      runtimeOk: engine.ok,
      engine,
      modelPath: cfg.modelPath,
      modelOk,
      port: cfg.port,
      ctx: cfg.ctx,
      gpuLayers: cfg.gpuLayers,
      logs: this.logs.slice(-40),
      modelSize: modelOk ? fs.statSync(cfg.modelPath).size : 0,
    };
  }

  log(line) {
    this.logs.push(line);
    if (this.logs.length > 200) this.logs = this.logs.slice(-200);
  }

  async installEngine() {
    this.state = 'starting';
    this.error = '';
    const res = await engines.installRuntime(this.ctx(), (line) => this.log(line));
    if (!res.ok) {
      this.state = 'error';
      this.error = res.error || '引擎安装失败';
      throw new Error(this.error);
    }
    this.state = 'idle';
    return res;
  }

  async start() {
    if (this.state === 'running' && this.proc) return this.status();
    const cfg = this.getConfig().localModel;
    const engine = engines.inspect(this.getConfig(), this.ctx());

    if (!engine.ok) {
      if (engine.kind === 'mnn-demo') {
        throw new Error('你选的是 MNN 的 llm_demo.exe：它只接受 config.json 与 MNN 模型目录，不能加载 .gguf。请改用 llama.cpp 的 llama-server，或点「自动安装引擎」。');
      }
      throw new Error(engine.message || '未找到可用的 llama-server，请点「自动安装引擎」');
    }
    if (!cfg.modelPath || !fs.existsSync(cfg.modelPath)) throw new Error('请先选择 .gguf 模型文件');
    if (this.proc) await this.stop();

    const runtime = engine.path;
    const args = [
      '--model', cfg.modelPath,
      '--host', '127.0.0.1',
      '--port', String(cfg.port || 8090),
      '--ctx-size', String(cfg.ctx || 8192),
    ];
    if (cfg.gpuLayers) args.push('--n-gpu-layers', String(cfg.gpuLayers));
    if (cfg.threads) args.push('--threads', String(cfg.threads));
    if (cfg.extraArgs) args.push(...String(cfg.extraArgs).split(/\s+/).filter(Boolean));

    this.state = 'starting';
    this.error = '';
    this.logs = [];
    this.log(`引擎：${engine.kind}${engine.version ? ` ${engine.version}` : ''}`);
    this.log(`启动：${runtime} ${args.join(' ')}`);

    this.proc = spawn(runtime, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => this.log(d.toString().trim().slice(0, 600)));
    this.proc.stderr.on('data', (d) => this.log(d.toString().trim().slice(0, 600)));
    this.proc.on('error', (err) => {
      this.state = 'error';
      this.error = err.message;
      this.log(`进程错误：${err.message}`);
    });
    this.proc.on('close', (code) => {
      if (this.state !== 'idle') this.state = 'idle';
      this.log(`进程退出 code=${code}`);
      this.proc = null;
    });

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (this.state === 'error') throw new Error(this.error);
      const ok = await this.ping(cfg.port);
      if (ok) {
        this.state = 'running';
        this.log('服务已就绪');
        return this.status();
      }
      if (!this.proc) break;
    }
    if (this.state !== 'running') {
      this.state = 'error';
      this.error = '模型加载超时，请查看运行日志';
      throw new Error(this.error);
    }
    return this.status();
  }

  async ping(port) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const text = await resp.text();
        try {
          const json = JSON.parse(text);
          return json.status === 'ok' || json.status === 'no slot available';
        } catch (_) { return true; }
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  async stop() {
    if (!this.proc) {
      this.state = 'idle';
      return this.status();
    }
    const child = this.proc;
    this.proc = null;
    try { child.kill(); } catch (_) { /* ignore */ }
    this.state = 'idle';
    this.log('已停止');
    await sleep(300);
    return this.status();
  }

  provider() {
    const cfg = this.getConfig().localModel;
    return {
      id: 'local-gguf',
      name: '本地 GGUF 模型',
      type: 'openai',
      baseUrl: `http://127.0.0.1:${cfg.port || 8090}/v1`,
      apiKey: '',
      model: path.basename(cfg.modelPath || 'local-model').replace(/\.gguf$/i, ''),
      toolMode: 'prompt',
      temperature: 0.6,
      maxTokens: 2048,
      headers: {},
    };
  }
}

module.exports = { LocalModelRunner };
