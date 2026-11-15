'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { chat } = require('./providers');
const { ToolRegistry, registerCoreTools } = require('./tools');
const { BrowserManager, registerBrowserTools } = require('./tools/browser');
const { registerDesktopTools } = require('./tools/desktop');
const { registerMemoryTools } = require('./memory');
const { SkillStore } = require('./skills');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

class Agent {
  constructor({ config, sessions, pluginHost, localModel, memory, emit, requestApproval, askUser, appRoot, userDataDir }) {
    this.config = config;
    this.sessions = sessions;
    this.pluginHost = pluginHost;
    this.localModel = localModel;
    this.emit = emit;
    this.requestApproval = requestApproval;
    this.askUser = askUser;
    this.memory = memory || null;
    this.appRoot = appRoot;
    this.userDataDir = userDataDir;
    this.skills = new SkillStore({
      appRoot,
      userDataDir,
      getConfig: () => this.config.get(),
      patchConfig: (patch) => this.config.patch(patch),
    });
    this.abort = null;
    this.registry = new ToolRegistry();
    this.browser = new BrowserManager({ getConfig: () => this.config.get() });
    registerCoreTools(this.registry, { getConfig: () => this.config.get() });
    registerBrowserTools(this.registry, this.browser, () => this.config.get().workspace);
    registerDesktopTools(this.registry, { getWorkspace: () => this.config.get().workspace });
    if (this.memory) registerMemoryTools(this.registry, this.memory);
    this.syncPluginTools();
  }

  syncPluginTools() {
    for (const tool of this.registry.list()) {
      if (String(tool.source).startsWith('plugin:') || String(tool.source).startsWith('mcp:')) {
        this.registry.unregister(tool.name);
      }
    }
    for (const tool of this.pluginHost.tools()) {
      this.registry.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        danger: tool.danger,
        source: tool.source,
        run: async (args) => tool.run(args, {
          approve: (req) => this.approve({
            kind: req?.kind || 'shell',
            title: req?.title || '插件操作',
            detail: req?.detail || '',
            preview: req?.preview || '',
          }),
          config: this.config.get(),
        }),
      });
    }
  }

  resolveProvider() {
    const cfg = this.config.get();
    if (cfg.activeProviderId === 'local-gguf') return this.localModel.provider();
    return this.config.getProvider(cfg.activeProviderId);
  }

  buildSystemPrompt() {
    const cfg = this.config.get();
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    const skills = this.loadSkills();
    const browserStatus = this.browser.ws ? '已连接' : '未启动（调用 browser_* 工具时自动启动）';
    const pluginList = this.pluginHost.tools().map((t) => t.name).join('、') || '无';
    return [
      '你是 agent_etc —— 一个可以自改装的桌面 Agent 工作台，运行在用户自己的电脑上。',
      '你的风格：先把任务拆成步骤，逐步执行，每步都告诉用户你在做什么；结论先行，简洁、准确，不啰嗦。',
      '',
      `当前时间：${now}`,
      `工作区目录：${cfg.workspace}`,
      `浏览器：${browserStatus}`,
      `已加载插件工具：${pluginList}`,
      '',
      '# 工作原则',
      '1. 能动手就不要只给建议：需要文件就用 fs_*，需要验证就用 shell_run，需要网页就用 browser_*。',
      '2. 每次工具调用后先判断结果是否达成目标，再决定下一步；不要重复同一个失败调用。',
      '3. 写文件、执行命令、点击页面这类有副作用的操作，会有用户确认弹窗，被拒绝就换方案而不是硬闯。',
      '4. 用户说“看看/查一下”时，优先用浏览器读真实页面，而不是凭记忆回答。',
      '5. 最终回复用 Markdown，给出做了什么、结果在哪（绝对路径或链接）、下一步建议。',
      '6. 需要用户拍板时调用 ask_user 弹选项，不要替用户猜；用户拒绝的操作要换方案。',
      '7. 看桌面用 screen_capture，确认坐标后再 screen_click；找文件用 fs_search / fs_drives。',
      '8. 遇到人机验证 / 验证码 / CAPTCHA：立即停止自动操作，说明需要用户本人完成，绝不尝试绕过。',
      '9. 记忆：用户告诉你长期偏好/事实时用 memory_save 记下；需要回忆时用 memory_search；用户要求忘记才用 memory_forget。记忆会随时间变淡，别把旧记忆当成绝对事实。',
      '',
      cfg.systemExtra ? `# 附加设定\n${cfg.systemExtra}` : '',
      skills ? `# 已启用的技能\n${skills}` : '',
    ].filter(Boolean).join('\n');
  }

  loadSkills() {
    return this.skills.buildPrompt();
  }

  listSkills() {
    return this.skills.list();
  }

  async buildUserMessage(text, attachments, providerType) {
    const parts = [];
    const images = [];
    const fileNotes = [];
    for (const file of attachments || []) {
      const ext = path.extname(file).toLowerCase();
      try {
        if (IMAGE_EXT.has(ext) && fs.statSync(file).size < 8 * 1024 * 1024) {
          const data = await fsp.readFile(file);
          images.push({ path: file, dataUrl: `data:${MIME[ext] || 'image/png'};base64,${data.toString('base64')}` });
        } else {
          const stat = fs.statSync(file);
          if (stat.size <= 200 * 1024) {
            const content = await fsp.readFile(file, 'utf8');
            fileNotes.push(`附件 ${path.basename(file)}（${file}）：\n\`\`\`\n${content.slice(0, 20000)}\n\`\`\``);
          } else {
            fileNotes.push(`附件 ${path.basename(file)}（${file}，${Math.round(stat.size / 1024)}KB，过大未内联，请用 fs_read 分段读取）`);
          }
        }
      } catch (err) {
        fileNotes.push(`附件 ${file} 读取失败：${err.message}`);
      }
    }
    let full = text || '';
    if (fileNotes.length) full += `\n\n${fileNotes.join('\n\n')}`;

    if (providerType === 'openai' && images.length) {
      parts.push({ type: 'text', text: full });
      for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      return { content: parts, images };
    }
    if (providerType === 'anthropic' && images.length) {
      parts.push({ type: 'text', text: full });
      for (const img of images) {
        const m = /^data:(.*?);base64,(.*)$/.exec(img.dataUrl);
        parts.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      }
      return { content: parts, images };
    }
    return { content: full, images };
  }

  stop() {
    if (this.abort) {
      try { this.abort.abort(); } catch (_) { /* ignore */ }
    }
  }

  async run({ session, text, attachments }) {
    this.syncPluginTools();
    const provider = this.resolveProvider();
    if (!provider) throw new Error('没有可用的模型服务，请在设置里配置');
    if (!provider.apiKey && provider.type === 'anthropic') throw new Error('请先在设置里填写 Anthropic API Key');
    if (provider.id !== 'local-gguf' && /api\.openai\.com|api\.anthropic\.com/.test(provider.baseUrl) && !provider.apiKey) {
      throw new Error('请先在「设置 → 模型服务」里填写 API Key');
    }

    if (this.memory && text) {
      try { this.memory.observe(text); } catch (_) { /* ignore */ }
    }
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const sid = session.id;
    const send = (event) => this.emit(sid, event);

    const userMsg = await this.buildUserMessage(text, attachments, provider.type);
    session.messages.push({ role: 'user', content: userMsg.content, ts: Date.now(), text });
    if (session.title === '新任务' && text) session.title = text.slice(0, 28);
    session.providerId = provider.id;
    this.sessions.save(session);
    send({ type: 'session', session: this.publicSession(session) });

    const tools = this.registry.schemaForModel();
    const visionNotes = [];
    const visionOk = supportsVision(provider);
    const memoryCtx = this.memory ? this.memory.contextFor(text) : '';
    const system = { role: 'system', content: this.buildSystemPrompt() + memoryCtx };
    let step = 0;
    const maxSteps = Math.max(4, Number(this.config.get().maxSteps) || 24);

    try {
      while (step < maxSteps) {
        step += 1;
        if (signal.aborted) throw new Error('已停止');
        send({ type: 'step', step, maxSteps });
        const history = [system, ...session.messages.map(toProviderMessage), ...visionNotes];
        const res = await chat({
          provider,
          messages: history,
          tools,
          signal,
          onDelta: (delta) => send({ type: 'delta', text: delta }),
        });

        if (res.content) {
          session.messages.push({ role: 'assistant', content: res.content, ts: Date.now() });
          this.sessions.save(session);
        }

        if (!res.toolCalls || !res.toolCalls.length) {
          send({ type: 'assistant', content: res.content || '', messages: this.publicSession(session).messages });
          send({ type: 'done', steps: step });
          return { ok: true, content: res.content, steps: step };
        }

        session.messages.push({
          role: 'assistant',
          content: res.content || '',
          toolCalls: res.toolCalls,
          ts: Date.now(),
        });
        this.sessions.save(session);
        send({ type: 'assistant', content: res.content || '', toolCalls: res.toolCalls, messages: this.publicSession(session).messages });

        for (const call of res.toolCalls) {
          if (signal.aborted) throw new Error('已停止');
          let args = {};
          let parseError = '';
          try {
            args = JSON.parse(call.arguments || '{}');
          } catch (err) {
            parseError = `参数不是合法 JSON：${err.message}`;
          }
          send({ type: 'tool-start', id: call.id, name: call.name, args, parseError });
          let outcome;
          if (parseError) {
            outcome = { ok: false, error: parseError };
          } else {
            outcome = await this.registry.run(call.name, args, {
              approve: (req) => this.approve(req),
              emit: send,
              ask: (req) => (this.askUser ? this.askUser(req) : { cancelled: true, note: '当前环境不支持弹窗' }),
            });
          }
          const stored = JSON.parse(JSON.stringify(outcome));
          if (stored.result && stored.result.imageDataUrl) {
            delete stored.result.imageDataUrl;
            stored.result.note = `${stored.result.note || ''}（图片数据未写入会话，文件见 ${stored.result.path || ''}）`;
          }
          const toolMessage = {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify(outcome.ok ? stored.result : { error: stored.error }).slice(0, 60000),
            ts: Date.now(),
            display: stored,
          };
          session.messages.push(toolMessage);
          this.sessions.save(session);
          send({ type: 'tool-result', id: call.id, name: call.name, outcome });
          if (visionOk && outcome.ok && outcome.result && outcome.result.imageDataUrl) {
            visionNotes.push(imageMessage(outcome.result.imageDataUrl, provider.type, outcome.result.path || ''));
          }
        }
      }
      send({ type: 'done', steps: step, truncated: true });
      return { ok: true, truncated: true };
    } catch (err) {
      if (signal.aborted) {
        send({ type: 'stopped' });
        return { ok: false, stopped: true };
      }
      send({ type: 'error', message: err.message });
      session.messages.push({ role: 'assistant', content: `任务中断：${err.message}`, ts: Date.now(), error: true });
      this.sessions.save(session);
      return { ok: false, error: err.message };
    } finally {
      this.abort = null;
    }
  }

  async approve(req) {
    const cfg = this.config.get();
    const mode = cfg.permissions[req.kind] || 'ask';
    if (mode === 'auto') return true;
    if (mode === 'deny') return false;
    if (!this.requestApproval) return false;
    return this.requestApproval(req);
  }

  publicSession(session) {
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      providerId: session.providerId,
      messages: session.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
        toolCalls: m.toolCalls || null,
        toolCallId: m.toolCallId || null,
        name: m.name || null,
        ts: m.ts || 0,
        error: !!m.error,
      })),
    };
  }
}

function toProviderMessage(m) {
  if (m.role === 'tool') return { role: 'tool', toolCallId: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls) return { role: 'assistant', content: m.content || '', toolCalls: m.toolCalls };
  return { role: m.role, content: m.content };
}


function supportsVision(provider) {
  if (!provider) return false;
  if (provider.type === 'anthropic') return true;
  return /gpt-4o|gpt-4\.1|vision|vl|claude|gemini|glm-4v|qwen-vl|qwen2\.5-vl/i.test(String(provider.model || ''));
}

function imageMessage(dataUrl, providerType, filePath) {
  const cap = `（系统）这是工具 screen_capture 返回的屏幕截图${filePath ? `，文件在 ${filePath}` : ''}。请据此确认界面与坐标。`;
  if (providerType === 'anthropic') {
    const m = /^data:(.*?);base64,(.*)$/.exec(dataUrl);
    return { role: 'user', content: [
      { type: 'text', text: cap },
      { type: 'image', source: { type: 'base64', media_type: (m && m[1]) || 'image/png', data: (m && m[2]) || '' } },
    ] };
  }
  return { role: 'user', content: [
    { type: 'text', text: cap },
    { type: 'image_url', image_url: { url: dataUrl } },
  ] };
}

module.exports = { Agent };
