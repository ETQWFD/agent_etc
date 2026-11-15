'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  info: null,
  config: null,
  sessions: [],
  session: null,
  messages: [],
  attachments: [],
  running: false,
  current: null,
  streamText: '',
  streamTimer: null,
  settingsTab: 'providers',
  pluginList: null,
  browserStatus: null,
  localStatus: null,
  approvalId: null,
};

/* ---------------- utils ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

function toast(msg, type = '') {
  const box = $('#toasts');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = msg;
  box.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => node.remove(), 3600);
}

function md(text) {
  if (!text) return '';
  const blocks = String(text).split(/```/);
  let out = '';
  blocks.forEach((block, idx) => {
    if (idx % 2 === 1) {
      const firstLine = block.split('\n')[0].trim();
      const isLang = /^[a-zA-Z0-9+#._-]{0,20}$/.test(firstLine) && !block.startsWith('\n');
      const code = isLang ? block.slice(firstLine.length).replace(/^\n/, '') : block;
      out += `<pre>${isLang && firstLine ? `<span class="lang">${esc(firstLine)}</span>` : ''}<code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      return;
    }
    const lines = block.split('\n');
    let listType = null;
    let para = [];
    let html = '';
    const flushPara = () => {
      if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; }
    };
    const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flushPara(); closeList(); continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { flushPara(); closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
      const ul = /^[-*•]\s+(.*)$/.exec(line);
      if (ul) {
        flushPara();
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += `<li>${inline(ul[1])}</li>`;
        continue;
      }
      const ol = /^(\d+)[.、]\s+(.*)$/.exec(line);
      if (ol) {
        flushPara();
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        html += `<li>${inline(ol[2])}</li>`;
        continue;
      }
      const q = /^>\s?(.*)$/.exec(line);
      if (q) { flushPara(); closeList(); html += `<blockquote>${inline(q[1])}</blockquote>`; continue; }
      if (listType) { html += `<li>${inline(line)}</li>`; continue; }
      para.push(line.trim());
    }
    flushPara(); closeList();
    out += html;
  });
  return out;
}

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}

/* ---------------- sidebar ---------------- */
function renderSessions() {
  const box = $('#sessionList');
  box.innerHTML = '';
  if (!state.sessions.length) {
    box.innerHTML = '<div style="padding:10px;color:#5f5f68;font-size:12px">还没有任务，点上面的「新建任务」开始。</div>';
    return;
  }
  for (const s of state.sessions) {
    const node = document.createElement('div');
    node.className = `session-item ${state.session?.id === s.id ? 'active' : ''}`;
    node.innerHTML = `<span class="s-title">${esc(s.title)}</span><span class="s-time">${fmtTime(s.updatedAt)}</span><button class="s-del" title="删除">×</button>`;
    node.addEventListener('click', () => loadSession(s.id));
    node.querySelector('.s-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await etc.sessions.remove(s.id);
      state.sessions = state.sessions.filter((x) => x.id !== s.id);
      if (state.session?.id === s.id) newSession();
      renderSessions();
    });
    box.appendChild(node);
  }
}

function renderTopbar() {
  const cfg = state.config;
  if (!cfg) return;
  const p = cfg.activeProviderId === 'local-gguf'
    ? { name: '本地 GGUF', model: cfg.localModel.modelPath ? cfg.localModel.modelPath.split(/[\\/]/).pop().replace(/\.gguf$/i, '') : '未选择模型' }
    : (cfg.providers.find((x) => x.id === cfg.activeProviderId) || cfg.providers[0] || { name: '未配置', model: '未配置' });
  $('#modelChip').textContent = `${p.name} · ${p.model || '默认'}`;
  $('#sessionTitle').textContent = state.session?.title || '新任务';
  $('#workspacePath').textContent = cfg.workspace || '—';
}

/* ---------------- messages ---------------- */
function scrollBottom() {
  const chat = $('#chat');
  chat.scrollTop = chat.scrollHeight;
}

function renderAll() {
  const box = $('#messages');
  box.innerHTML = '';
  $('#empty').style.display = state.messages.length ? 'none' : 'flex';
  state.messages
    .filter((m) => m.role !== 'assistant' || (m.content && m.content.trim()) || (m.tools && m.tools.length))
    .forEach((m) => box.appendChild(buildMessage(m)));
  scrollBottom();
}

function buildMessage(m) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}${m.error ? ' error' : ''}`;
  if (m.role === 'user') {
    wrap.innerHTML = `<div class="body"><div class="bubble">${esc(m.content)}</div></div>`;
    return wrap;
  }
  wrap.innerHTML = `<div class="avatar"><span>A</span></div><div class="body"><div class="content ${m.streaming ? 'streaming' : ''} md"></div><div class="tools"></div><div class="msg-meta"></div></div>`;
  const content = wrap.querySelector('.content');
  content.innerHTML = md(m.content || '');
  const tools = wrap.querySelector('.tools');
  (m.tools || []).forEach((t) => tools.appendChild(buildTool(t)));
  if (m.meta) wrap.querySelector('.msg-meta').textContent = m.meta;
  return wrap;
}

function buildTool(t) {
  const node = document.createElement('div');
  node.className = `tool ${t.status || 'running'}`;
  node.dataset.id = t.id;
  const iconMap = {
    fs: '▤', shell: '▶', web: '◎', browser: '◐', plugin: '◫', mcp: '◆',
  };
  let icon = '⚙';
  if (t.name.startsWith('fs_')) icon = iconMap.fs;
  else if (t.name.startsWith('shell')) icon = iconMap.shell;
  else if (t.name.startsWith('web')) icon = iconMap.web;
  else if (t.name.startsWith('browser')) icon = iconMap.browser;
  else if (t.name.startsWith('mcp')) icon = iconMap.mcp;
  const stateText = { running: '执行中', ok: '完成', fail: '失败', skipped: '已跳过' }[t.status || 'running'];
  node.innerHTML = `
    <div class="tool-head">
      <div class="tool-icon">${icon}</div>
      <div class="tool-name">${esc(t.name)}</div>
      <div class="tool-args">${esc(t.brief || '')}</div>
      <div class="tool-state">${stateText}</div>
    </div>
    <div class="tool-body"></div>`;
  const body = node.querySelector('.tool-body');
  body.innerHTML = `<div class="tool-section-label">参数</div><pre>${esc(JSON.stringify(t.args || {}, null, 2))}</pre>`;
  if (t.result !== undefined) {
    body.innerHTML += `<div class="tool-section-label">结果</div><pre>${esc(JSON.stringify(t.result, null, 2))}</pre>`;
    const p = t.result && typeof t.result === 'object' ? (t.result.path || t.result.result?.path) : null;
    if (p && /\.(png|jpg|jpeg|webp)$/i.test(p)) {
      body.innerHTML += `<div class="shot"><img src="etcfile://local?p=${encodeURIComponent(p)}" /></div>`;
    }
  }
  node.querySelector('.tool-head').addEventListener('click', () => node.classList.toggle('open'));
  return node;
}

function updateStream(delta) {
  if (state.current && state.current.tools && state.current.tools.length) {
    state.current.streaming = false;
    state.current = null;
    state.streamText = '';
  }
  if (!state.current) newAssistantMessage();
  state.streamText += delta;
  if (state.streamTimer) return;
  state.streamTimer = setTimeout(() => {
    state.streamTimer = null;
    const node = $(`.msg[data-mid="${state.current.id}"] .content`);
    if (node) {
      node.innerHTML = md(state.streamText);
      scrollBottom();
    }
  }, 90);
}

function newAssistantMessage() {
  const m = {
    id: `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    role: 'assistant', content: '', tools: [], streaming: true,
  };
  state.messages.push(m);
  state.streamText = '';
  const box = $('#messages');
  $('#empty').style.display = 'none';
  const node = buildMessage(m);
  node.dataset.mid = m.id;
  box.appendChild(node);
  state.current = m;
  return node;
}

/* ---------------- session ---------------- */
async function loadSession(id) {
  const s = await etc.sessions.get(id);
  if (!s) return;
  state.session = s;
  state.messages = [];
  const raw = s.messages || [];
  for (let i = 0; i < raw.length; i += 1) {
    const m = raw[i];
    if (m.role === 'user') {
      state.messages.push({ id: `h${i}`, role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const tools = [];
      for (const call of m.toolCalls || []) {
        const found = raw.slice(i + 1).find((x) => x.role === 'tool' && x.toolCallId === call.id)
          || raw.find((x) => x.role === 'tool' && x.toolCallId === call.id);
        let parsed;
        try { parsed = found ? JSON.parse(found.content) : undefined; } catch (_) { parsed = found?.content; }
        tools.push({
          id: call.id, name: call.name, args: safeJson(call.arguments), status: parsed && parsed.error ? 'fail' : 'ok', result: parsed, brief: '',
        });
      }
      state.messages.push({ id: `h${i}`, role: 'assistant', content: m.content || '', tools, error: !!m.error });
    }
  }
  const cfg = state.config;
  cfg.ui.lastSessionId = s.id;
  await etc.config.patch({ ui: { lastSessionId: s.id } });
  renderAll();
  renderSessions();
  renderTopbar();
  const chat = $('#chat');
  chat.scrollTop = chat.scrollHeight;
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch (_) { return {}; }
}

function newSession() {
  state.session = null;
  state.messages = [];
  state.current = null;
  renderAll();
  renderSessions();
  renderTopbar();
  $('#input').focus();
}

/* ---------------- sending ---------------- */
async function send() {
  if (state.running) { await stopRun(); return; }
  const input = $('#input');
  const text = input.value.trim();
  if (!text && !state.attachments.length) return;

  if (!state.session) {
    state.session = await etc.sessions.create(text.slice(0, 24) || '新任务');
    state.sessions.unshift({ id: state.session.id, title: state.session.title, updatedAt: Date.now(), messageCount: 0 });
    await etc.config.patch({ ui: { lastSessionId: state.session.id } });
  }

  state.messages.push({ id: `u${Date.now()}`, role: 'user', content: text });
  input.value = '';
  input.style.height = 'auto';
  state.running = true;
  $('#stepInfo').textContent = '';
  updateSendBtn();
  renderAll();
  const node = newAssistantMessage();
  node.dataset.mid = state.current.id;

  const attachments = state.attachments.slice();
  clearAttachments();

  const res = await etc.chat.send({ sessionId: state.session.id, text, attachments });
  state.running = false;
  updateSendBtn();
  if (state.current) state.current.streaming = false;
  $(`.msg[data-mid="${state.current?.id}"] .content`)?.classList.remove('streaming');
  if (!res || (!res.ok && !res.stopped)) {
    if (!state.lastErrorShown) {
      state.messages.push({ id: `e${Date.now()}`, role: 'assistant', content: `任务未完成：${(res && res.error) || '未知错误'}`, error: true });
      renderAll();
      if (String(res && res.error || '').includes('API Key') || String(res && res.error || '').includes('模型服务')) openSettings('providers');
    }
  }
  state.lastErrorShown = false;
  state.sessions = await etc.sessions.list();
  renderSessions();
  refreshStatus();
}

async function stopRun() {
  await etc.chat.stop();
  toast('正在停止…');
}

function updateSendBtn() {
  const btn = $('#btnSend');
  btn.classList.toggle('stop', state.running);
  btn.innerHTML = state.running ? '<span class="arrow">■</span>' : '<span class="arrow">↑</span>';
  $('#hintText').textContent = state.running ? '正在执行… 点击方块可停止' : '工具执行前会请求你的确认';
}

/* ---------------- attachments ---------------- */
function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = '';
  state.attachments.forEach((p, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = `<span>${esc(p.split(/[\\/]/).pop())}</span><button>×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.attachments.splice(idx, 1);
      renderAttachments();
    });
    box.appendChild(chip);
  });
}

/* ---------------- events ---------------- */
function bindAgentEvents() {
  window.etc.onAgentEvent(({ sessionId, event }) => {
    if (!state.session || sessionId !== state.session.id) return;
    switch (event.type) {
      case 'session': {
        if (event.session?.title) {
          state.session.title = event.session.title;
          const item = state.sessions.find((s) => s.id === sessionId);
          if (item) item.title = event.session.title;
          renderTopbar();
          renderSessions();
        }
        break;
      }
      case 'step': {
        $('#stepInfo').textContent = `第 ${event.step} / ${event.maxSteps} 步`;
        break;
      }
      case 'delta':
        if (!state.current) newAssistantMessage();
        updateStream(event.text);
        break;
      case 'assistant': {
        if (state.current) {
          state.current.streaming = false;
          state.current.content = state.streamText || state.current.content;
          const node = $(`.msg[data-mid="${state.current.id}"]`);
          if (node) {
            node.querySelector('.content').classList.remove('streaming');
            node.querySelector('.content').innerHTML = md(state.current.content);
          }
        }
        state.current = null;
        state.streamText = '';
        break;
      }
      case 'tool-start': {
        if (!state.current) newAssistantMessage();
        const tool = { id: event.id, name: event.name, args: event.args, status: 'running', brief: briefArgs(event.args) };
        state.current.tools.push(tool);
        const holder = $(`.msg[data-mid="${state.current.id}"] .tools`);
        if (holder) holder.appendChild(buildTool(tool));
        scrollBottom();
        break;
      }
      case 'tool-result': {
        const tool = state.current?.tools.find((t) => t.id === event.id);
        if (tool) {
          const out = event.outcome || {};
          tool.status = !out.ok ? 'fail' : (out.result?.skipped ? 'skipped' : 'ok');
          tool.result = out.ok ? out.result : { error: out.error };
          const node = $(`.msg[data-mid="${state.current.id}"] .tool[data-id="${event.id}"]`);
          if (node) {
            node.className = `tool ${tool.status}${node.classList.contains('open') ? ' open' : ''}`;
            node.querySelector('.tool-state').textContent = { running: '执行中', ok: '完成', fail: '失败', skipped: '已跳过' }[tool.status];
            const body = node.querySelector('.tool-body');
            body.innerHTML = `<div class="tool-section-label">参数</div><pre>${esc(JSON.stringify(tool.args || {}, null, 2))}</pre><div class="tool-section-label">结果</div><pre>${esc(JSON.stringify(tool.result, null, 2))}</pre>`;
            const p = tool.result?.path;
            if (p && /\.(png|jpg|jpeg|webp)$/i.test(p)) body.innerHTML += `<div class="shot"><img src="etcfile://local?p=${encodeURIComponent(p)}" /></div>`;
            if (tool.status === 'fail') node.classList.add('open');
          }
        }
        scrollBottom();
        break;
      }
      case 'done': {
        if (state.current) {
          state.current.streaming = false;
          state.current.content = state.streamText || state.current.content;
          state.current.meta = `完成 · ${event.steps || ''} 步`;
        }
        state.running = false;
        updateSendBtn();
        $('#stepInfo').textContent = '';
        renderAll();
        break;
      }
      case 'stopped': {
        if (state.current) {
          state.current.streaming = false;
          state.current.content = (state.current.content || '') + '\n\n_已停止。_';
        }
        state.running = false;
        updateSendBtn();
        renderAll();
        toast('已停止');
        break;
      }
      case 'error': {
        state.lastErrorShown = true;
        if (state.current) state.current.streaming = false;
        state.messages.push({ id: `e${Date.now()}`, role: 'assistant', content: `出错了：${event.message}`, error: true });
        state.running = false;
        updateSendBtn();
        renderAll();
        toast(event.message, 'err');
        break;
      }
      default: break;
    }
  });

  window.etc.onApproval(({ id, req }) => {
    state.approvalId = id;
    showApproval(req);
  });
}

function briefArgs(args) {
  if (!args) return '';
  const keys = Object.keys(args);
  if (!keys.length) return '';
  const first = args[keys[0]];
  return String(typeof first === 'string' ? first : JSON.stringify(first)).slice(0, 80);
}

/* ---------------- approval ---------------- */
function showApproval(req) {
  const overlay = $('#overlay');
  overlay.classList.add('show');
  overlay.innerHTML = `
    <div class="approve">
      <div class="approve-title">需要你确认<span class="tag">${esc(kindLabel(req.kind))}</span></div>
      <div class="approve-detail">${esc(req.detail || '')}</div>
      ${req.preview ? `<div class="approve-preview">${esc(req.preview)}</div>` : ''}
      <div class="approve-actions">
        <button class="btn" data-act="deny">拒绝</button>
        <button class="btn primary" data-act="allow">允许这一次</button>
      </div>
    </div>`;
  const respond = (approved) => {
    overlay.classList.remove('show');
    overlay.innerHTML = '';
    etc.approval.respond(state.approvalId, approved);
    state.approvalId = null;
  };
  overlay.querySelector('[data-act="allow"]').addEventListener('click', () => respond(true));
  overlay.querySelector('[data-act="deny"]').addEventListener('click', () => respond(false));
}

function kindLabel(kind) {
  return { shell: '执行命令', write: '写文件', browser: '浏览器操作', browserEval: '页面脚本', network: '网络请求' }[kind] || kind || '操作';
}

/* ---------------- status ---------------- */
async function refreshStatus() {
  try {
    const [browserStatus, localStatus] = await Promise.all([etc.browser.status(), etc.localmodel.status()]);
    state.browserStatus = browserStatus;
    state.localStatus = localStatus;
    const dots = $('#statusDots');
    const cur = state.config?.providers?.find((p) => p.id === state.config.activeProviderId);
    const localUrl = /127\.0\.0\.1|localhost/.test(cur?.baseUrl || '');
    const modelOk = !!state.config?.activeProviderId && (state.config.activeProviderId === 'local-gguf'
      ? localStatus.state === 'running'
      : !!cur && (!!cur.apiKey || localUrl));
    dots.querySelector('[data-key="model"]').className = `dot ${modelOk ? 'on' : 'err'}`;
    dots.querySelector('[data-key="browser"]').className = `dot ${browserStatus.running ? 'on' : (browserStatus.exePath ? 'warn' : '')}`;
    dots.querySelector('[data-key="local"]').className = `dot ${localStatus.state === 'running' ? 'on' : (localStatus.state === 'starting' ? 'warn' : '')}`;
  } catch (_) { /* ignore */ }
}

/* ---------------- settings ---------------- */
function openSettings(tab = 'providers') {
  state.settingsTab = tab;
  const overlay = $('#overlay');
  overlay.classList.add('show');
  overlay.innerHTML = `
    <div class="settings">
      <div class="settings-head">
        <div>
          <div class="settings-title">设置</div>
          <div class="settings-sub">模型、本地权重、浏览器、插件与权限，一切可改</div>
        </div>
        <button class="icon-btn" id="settingsClose">✕</button>
      </div>
      <div class="settings-body">
        <nav class="tabs">
          ${tabButton('providers', '模型服务')}
          ${tabButton('local', '本地 GGUF')}
          ${tabButton('browser', '浏览器')}
          ${tabButton('plugins', '插件')}
          ${tabButton('skills', '技能')}
          ${tabButton('permissions', '权限与工作区')}
          ${tabButton('about', '关于')}
        </nav>
        <div class="panel" id="settingsPanel"></div>
      </div>
    </div>`;
  $('#settingsClose').addEventListener('click', closeOverlay);
  $$('.tab', overlay).forEach((b) => b.addEventListener('click', () => {
    state.settingsTab = b.dataset.tab;
    $$('.tab', overlay).forEach((x) => x.classList.toggle('active', x.dataset.tab === state.settingsTab));
    renderPanel();
  }));
  renderPanel();
}

function tabButton(id, label) {
  return `<button class="tab ${state.settingsTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`;
}

function closeOverlay() {
  $('#overlay').classList.remove('show');
  $('#overlay').innerHTML = '';
}

async function renderPanel() {
  const panel = $('#settingsPanel');
  if (!panel) return;
  switch (state.settingsTab) {
    case 'providers': return renderProviders(panel);
    case 'local': return renderLocal(panel);
    case 'browser': return renderBrowser(panel);
    case 'plugins': return renderPlugins(panel);
    case 'skills': return renderSkills(panel);
    case 'permissions': return renderPermissions(panel);
    case 'about': return renderAbout(panel);
    default: return renderProviders(panel);
  }
}

function renderProviders(panel) {
  const cfg = state.config;
  panel.innerHTML = `
    <h3>模型服务</h3>
    <div class="desc">任意 OpenAI 兼容接口或 Anthropic 都能接：官方 API、DeepSeek、Moonshot、vLLM、Ollama、llama.cpp 均可。</div>
    <div id="providerCards"></div>
    <button class="btn" id="addProvider">＋ 添加模型服务</button>`;
  const holder = panel.querySelector('#providerCards');
  cfg.providers.forEach((p) => {
    const active = cfg.activeProviderId === p.id;
    const card = document.createElement('div');
    card.className = `card ${active ? 'active' : ''}`;
    card.innerHTML = `
      <div class="card-head">
        <div>
          <div class="card-title">${esc(p.name || p.id)}</div>
          <div class="card-sub">${esc(p.type)} · ${esc(p.baseUrl || '')}</div>
        </div>
        ${active ? '<span class="badge ok">使用中</span>' : `<button class="btn sm" data-act="use">设为当前</button>`}
      </div>
      <div class="grid2">
        <div class="field"><label>名称</label><input data-f="name" value="${esc(p.name || '')}" /></div>
        <div class="field"><label>类型</label><select data-f="type">
          <option value="openai" ${p.type === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
          <option value="anthropic" ${p.type === 'anthropic' ? 'selected' : ''}>Anthropic</option>
        </select></div>
      </div>
      <div class="field"><label>Base URL</label><input data-f="baseUrl" value="${esc(p.baseUrl || '')}" placeholder="https://api.openai.com/v1" /></div>
      <div class="field"><label>API Key</label><input data-f="apiKey" type="password" value="${esc(p.apiKey || '')}" placeholder="sk-..." /></div>
      <div class="grid2">
        <div class="field"><label>模型名</label><input data-f="model" value="${esc(p.model || '')}" /></div>
        <div class="field"><label>工具调用</label><select data-f="toolMode">
          <option value="auto" ${p.toolMode !== 'prompt' ? 'selected' : ''}>原生 function calling</option>
          <option value="prompt" ${p.toolMode === 'prompt' ? 'selected' : ''}>提示词协议（兼容小模型）</option>
        </select></div>
      </div>
      <div class="row" style="justify-content:space-between">
        <div class="row">
          <button class="btn sm" data-act="save">保存</button>
          <button class="btn sm ghost" data-act="test">测试连接</button>
          <span class="card-sub" data-test></span>
        </div>
        ${cfg.providers.length > 1 ? '<button class="btn sm danger" data-act="del">删除</button>' : ''}
      </div>`;
    card.querySelector('[data-act="save"]').addEventListener('click', async () => {
      const next = collectProvider(card, p.id);
      await etc.config.patch({ providers: cfg.providers.map((x) => (x.id === p.id ? next : x)) });
      state.config = await etc.config.get();
      toast('已保存', 'ok');
      renderProviders(panel);
      renderTopbar();
      refreshStatus();
    });
    card.querySelector('[data-act="test"]').addEventListener('click', async (e) => {
      const label = card.querySelector('[data-test]');
      label.textContent = '测试中…';
      const res = await etc.providers.test(collectProvider(card, p.id));
      label.textContent = res.message;
      label.style.color = res.ok ? 'var(--accent)' : 'var(--danger)';
    });
    card.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
      await etc.providers.remove(p.id);
      state.config = await etc.config.get();
      renderProviders(panel);
      renderTopbar();
    });
    card.querySelector('[data-act="use"]')?.addEventListener('click', async () => {
      await etc.providers.activate(p.id);
      state.config = await etc.config.get();
      renderProviders(panel);
      renderTopbar();
      refreshStatus();
    });
    holder.appendChild(card);
  });

  panel.querySelector('#addProvider').addEventListener('click', async () => {
    const p = {
      id: '', name: '新模型服务', type: 'openai', baseUrl: 'https://api.openai.com/v1',
      apiKey: '', model: 'gpt-4o-mini', toolMode: 'auto', temperature: 0.4, maxTokens: 4096, headers: {},
    };
    await etc.providers.save(p);
    state.config = await etc.config.get();
    renderProviders(panel);
    toast('已添加，请填写 Key 与模型名', 'ok');
  });
}

function collectProvider(card, id) {
  const get = (f) => card.querySelector(`[data-f="${f}"]`)?.value ?? '';
  return {
    id, name: get('name').trim() || '模型服务', type: get('type'),
    baseUrl: get('baseUrl').trim(), apiKey: get('apiKey').trim(), model: get('model').trim(),
    toolMode: get('toolMode'), temperature: 0.4, maxTokens: 4096, headers: {},
  };
}

async function renderLocal(panel) {
  const s = await etc.localmodel.status();
  state.localStatus = s;
  const cfg = state.config.localModel;
  panel.innerHTML = `
    <h3>本地 GGUF 模型</h3>
    <div class="desc">选择 llama.cpp 的 <code class="inline" style="background:#1c1c22;padding:1px 5px;border-radius:4px">llama-server</code> 可执行文件与 .gguf 权重，agent_etc 会自动拉起本地 OpenAI 兼容服务，并把模型切为当前。</div>
    <div class="field"><label>llama-server 运行时</label>
      <div class="row"><input id="runtimePath" readonly value="${esc(cfg.runtimePath || '')}" placeholder="尚未选择" />
      <button class="btn sm" id="pickRuntime">选择</button></div>
    </div>
    <div class="field"><label>GGUF 模型</label>
      <div class="row"><input id="modelPath" readonly value="${esc(cfg.modelPath || '')}" placeholder="尚未选择" />
      <button class="btn sm" id="pickModel">选择</button></div>
    </div>
    <div class="grid2">
      <div class="field"><label>端口</label><input id="lport" type="number" value="${cfg.port}" /></div>
      <div class="field"><label>上下文长度</label><input id="lctx" type="number" value="${cfg.ctx}" /></div>
      <div class="field"><label>GPU 层数（0 = 纯 CPU）</label><input id="lgpu" type="number" value="${cfg.gpuLayers}" /></div>
      <div class="field"><label>线程数（0 = 自动）</label><input id="lthreads" type="number" value="${cfg.threads}" /></div>
    </div>
    <div class="field"><label>附加参数</label><input id="lextra" value="${esc(cfg.extraArgs || '')}" placeholder="--flash-attn 等，空格分隔" /></div>
    <div class="row" style="margin:14px 0 12px">
      <button class="btn" id="saveLocal">保存配置</button>
      <button class="btn primary" id="startLocal" ${s.state === 'running' ? 'disabled' : ''}>启动模型服务</button>
      <button class="btn" id="stopLocal" ${s.state !== 'running' ? 'disabled' : ''}>停止</button>
      <span class="badge ${s.state === 'running' ? 'ok' : ''}">${stateLabel(s.state)}</span>
    </div>
    ${s.error ? `<div class="hintbox" style="border-color:rgba(255,122,122,.3);color:#ffb4b4">${esc(s.error)}</div>` : ''}
    <div class="field"><label>运行日志</label><div class="logbox">${esc((s.logs || []).join('\n') || '暂无日志')}</div></div>
    <div class="hintbox">没有运行时？到 github.com/ggml-org/llama.cpp/releases 下载 <b>llama-*-bin-win-x64.zip</b>，解压后指向其中的 <b>llama-server.exe</b>。首次加载大模型会慢一些，最长等待 3 分钟。</div>`;

  panel.querySelector('#pickRuntime').addEventListener('click', async () => {
    const p = await etc.localmodel.pickRuntime();
    if (p) { state.config = await etc.config.get(); renderLocal(panel); toast('运行时已设置', 'ok'); }
  });
  panel.querySelector('#pickModel').addEventListener('click', async () => {
    const p = await etc.localmodel.pickModel();
    if (p) { state.config = await etc.config.get(); renderLocal(panel); toast('模型已设置', 'ok'); }
  });
  panel.querySelector('#saveLocal').addEventListener('click', async () => {
    await etc.config.patch({
      localModel: {
        port: Number(panel.querySelector('#lport').value) || 8090,
        ctx: Number(panel.querySelector('#lctx').value) || 8192,
        gpuLayers: Number(panel.querySelector('#lgpu').value) || 0,
        threads: Number(panel.querySelector('#lthreads').value) || 0,
        extraArgs: panel.querySelector('#lextra').value,
      },
    });
    state.config = await etc.config.get();
    toast('已保存', 'ok');
    renderLocal(panel);
  });
  panel.querySelector('#startLocal').addEventListener('click', async () => {
    panel.querySelector('#startLocal').textContent = '启动中…';
    panel.querySelector('#startLocal').disabled = true;
    const res = await etc.localmodel.start();
    state.config = await etc.config.get();
    if (!res.ok) toast(res.error || '启动失败', 'err');
    else toast('本地模型已就绪，并切换为当前模型', 'ok');
    renderLocal(panel);
    renderTopbar();
    refreshStatus();
  });
  panel.querySelector('#stopLocal').addEventListener('click', async () => {
    await etc.localmodel.stop();
    renderLocal(panel);
    refreshStatus();
  });
}

function stateLabel(s) {
  return { idle: '未启动', starting: '启动中', running: '运行中', error: '错误' }[s] || s;
}

async function renderBrowser(panel) {
  const s = await etc.browser.status();
  state.browserStatus = s;
  panel.innerHTML = `
    <h3>浏览器操作</h3>
    <div class="desc">通过 Chrome DevTools 协议操作你本机的 Chrome / Edge，保留登录态与扩展。Agent 可以打开页面、读取正文、点击、填表、截图。</div>
    <div class="list-line">
      <div class="grow">
        <div class="t">调试端口 <span class="badge ${s.debuggingEndpoint ? 'ok' : ''}">${s.debuggingEndpoint ? '已开放' : '未开放'}</span></div>
        <div class="d">${s.running ? 'Agent 已连接，可直接操作' : '尚未连接，调用浏览器工具时会自动启动'}</div>
      </div>
      <button class="btn sm" id="bLaunch">启动 / 连接</button>
      <button class="btn sm ghost" id="bStop">停止</button>
    </div>
    <div class="field" style="margin-top:14px"><label>已检测到的浏览器</label>
      ${(s.detected || []).map((b) => `<div class="list-line"><div class="grow"><div class="t">${esc(b.name)}</div><div class="d">${esc(b.path)}</div></div></div>`).join('') || '<div class="hintbox">没有检测到 Chrome / Edge，请手动填写下面的路径。</div>'}
    </div>
    <div class="field"><label>浏览器可执行文件（留空自动检测）</label><input id="bexe" value="${esc(state.config.browser.exePath || '')}" placeholder="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" /></div>
    <div class="grid2">
      <div class="field"><label>调试端口</label><input id="bport" type="number" value="${state.config.browser.port}" /></div>
      <div class="field"><label>无头模式</label>
        <div class="row" style="padding-top:6px"><div class="switch ${state.config.browser.headless ? 'on' : ''}" id="bheadless"></div><span class="card-sub">无头模式无法复用可视化登录</span></div>
      </div>
    </div>
    <div class="row"><button class="btn" id="bSave">保存</button></div>
    <div class="hintbox" style="margin-top:14px">Agent 使用独立浏览器配置目录，不会影响你日常使用的浏览器；需要登录时会在弹出的窗口里让你手动登录一次。</div>`;

  panel.querySelector('#bheadless').addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));
  panel.querySelector('#bSave').addEventListener('click', async () => {
    await etc.config.patch({
      browser: {
        exePath: panel.querySelector('#bexe').value.trim(),
        port: Number(panel.querySelector('#bport').value) || 9222,
        headless: panel.querySelector('#bheadless').classList.contains('on'),
      },
    });
    state.config = await etc.config.get();
    toast('已保存', 'ok');
    renderBrowser(panel);
  });
  panel.querySelector('#bLaunch').addEventListener('click', async () => {
    const res = await etc.browser.launch();
    if (!res.ok) toast(res.error, 'err');
    else toast('浏览器已连接', 'ok');
    renderBrowser(panel);
    refreshStatus();
  });
  panel.querySelector('#bStop').addEventListener('click', async () => {
    await etc.browser.stop();
    toast('已断开');
    renderBrowser(panel);
    refreshStatus();
  });
}

async function renderPlugins(panel) {
  const list = await etc.plugins.list();
  state.pluginList = list;
  const row = (p) => `
    <div class="list-line">
      <div class="grow">
        <div class="t">${esc(p.name)} <span class="badge">${esc(p.kind)}</span> ${p.ready === false && p.kind === 'mcp' ? '<span class="badge" style="color:#ffb4b4">未连接</span>' : ''}</div>
        <div class="d">${esc(p.description || '')}${p.tools?.length ? ` · 工具 ${p.tools.length} 个` : ''}${p.error ? ` · ${esc(p.error)}` : ''}</div>
      </div>
      <div class="switch ${p.enabled ? 'on' : ''}" data-toggle="${esc(p.id)}"></div>
      ${p.kind === 'native' ? `<button class="btn sm danger" data-del="${esc(p.id)}">卸载</button>` : `<button class="btn sm" data-del="${esc(p.id)}">移除</button>`}
    </div>`;

  panel.innerHTML = `
    <h3>插件</h3>
    <div class="desc">两种插件都能装：本地插件目录（plugin.json + index.js，用 ctx.registerTool 注册工具），或任意 MCP 服务器（stdio JSON-RPC）。启用后工具会立刻出现在 Agent 的工具列表里。</div>
    <div class="card">
      <div class="card-head"><div><div class="card-title">已安装</div><div class="card-sub">共 ${list.native.length + list.mcp.length} 个</div></div>
        <button class="btn sm" id="installPlugin">从文件夹安装</button>
      </div>
      <div>${[...list.native, ...list.mcp].map(row).join('') || '<div class="hintbox">还没有插件。安装一个试试。</div>'}</div>
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:10px">添加 MCP 服务器</div>
      <div class="grid2">
        <div class="field"><label>名称</label><input id="mcpName" placeholder="例如 文件系统" /></div>
        <div class="field"><label>命令</label><input id="mcpCommand" placeholder="npx" /></div>
      </div>
      <div class="field"><label>参数（空格分隔）</label><input id="mcpArgs" placeholder="-y @modelcontextprotocol/server-filesystem /path/to/dir" /></div>
      <button class="btn" id="addMcp">添加</button>
    </div>
    <div class="field"><label>插件日志</label><div class="logbox">${esc((list.log || []).map((l) => l.line).join('\n') || '暂无日志')}</div></div>`;

  $$('[data-toggle]', panel).forEach((sw) => sw.addEventListener('click', async () => {
    const id = sw.dataset.toggle;
    const enabled = !sw.classList.contains('on');
    await etc.plugins.toggle(id, enabled);
    toast(enabled ? '已启用插件' : '已停用插件', 'ok');
    state.config = await etc.config.get();
    renderPlugins(panel);
  }));
  $$('[data-del]', panel).forEach((b) => b.addEventListener('click', async () => {
    try {
      await etc.plugins.uninstall(b.dataset.del);
      toast('已移除');
      renderPlugins(panel);
    } catch (err) {
      toast(err.message || '移除失败', 'err');
    }
  }));
  panel.querySelector('#installPlugin').addEventListener('click', async () => {
    try {
      const dest = await etc.plugins.install();
      if (dest) { toast('插件已安装', 'ok'); renderPlugins(panel); }
    } catch (err) { toast(err.message || '安装失败', 'err'); }
  });
  panel.querySelector('#addMcp').addEventListener('click', async () => {
    const name = panel.querySelector('#mcpName').value.trim();
    const command = panel.querySelector('#mcpCommand').value.trim();
    const args = panel.querySelector('#mcpArgs').value.trim() ? panel.querySelector('#mcpArgs').value.trim().split(/\s+/) : [];
    if (!command) return toast('请填写命令', 'err');
    await etc.plugins.addMcp({ name: name || command, command, args, env: {} });
    toast('已添加 MCP 服务器', 'ok');
    renderPlugins(panel);
  });
}

async function renderSkills(panel) {
  const list = await etc.skills.list();
  panel.innerHTML = `
    <h3>技能</h3>
    <div class="desc">技能是会被注入系统提示的 Markdown 说明，用来固化流程与口径。内置技能在安装目录 <code class="inline">skills/</code>，自定义技能放在用户数据目录 <code class="inline">skills/</code>。</div>
    <div class="card">
      ${list.map((s) => `
        <div class="list-line">
          <div class="grow"><div class="t">${esc(s.id)} ${s.builtin ? '<span class="badge">内置</span>' : '<span class="badge">自定义</span>'}</div>
          <div class="d">${esc(s.preview)} · ${s.bytes} 字</div></div>
          <button class="btn sm ghost" data-open="${esc(s.id)}">打开</button>
          <div class="switch ${s.enabled ? 'on' : ''}" data-skill="${esc(s.id)}"></div>
        </div>`).join('') || '<div class="hintbox">还没有技能文件。</div>'}
    </div>
    <div class="hintbox">把 .md 文件放进用户数据目录的 skills 文件夹即可新增技能；也可以直接点「打开」用默认编辑器改。</div>`;

  $$('[data-skill]', panel).forEach((sw) => sw.addEventListener('click', async () => {
    const enabled = !sw.classList.contains('on');
    await etc.skills.toggle(sw.dataset.skill, enabled);
    toast(enabled ? '技能已启用' : '技能已停用', 'ok');
    renderSkills(panel);
  }));
  $$('[data-open]', panel).forEach((b) => b.addEventListener('click', () => etc.skills.open(b.dataset.open)));
}

function renderPermissions(panel) {
  const cfg = state.config;
  const kinds = [
    ['shell', '执行命令', '运行 shell / cmd 命令'],
    ['write', '写入文件', '创建、覆盖文件'],
    ['network', '访问网络', '抓取网页与接口'],
    ['browserEval', '页面脚本', '在网页里执行 JavaScript'],
  ];
  panel.innerHTML = `
    <h3>权限</h3>
    <div class="desc">默认「询问」：每次有副作用的操作都会弹窗，由你决定。自动化程度高的任务可以改成「自动」。</div>
    ${kinds.map(([key, name, d]) => `
      <div class="list-line">
        <div class="grow"><div class="t">${name}</div><div class="d">${d}</div></div>
        <div class="radio-row" data-kind="${key}">
          ${['ask', 'auto', 'deny'].map((v) => `<button class="pill ${(cfg.permissions[key] || 'ask') === v ? 'on' : ''}" data-v="${v}">${{ ask: '询问', auto: '自动', deny: '禁止' }[v]}</button>`).join('')}
        </div>
      </div>`).join('')}
    <h3 style="margin-top:22px">工作区</h3>
    <div class="field"><label>默认读写目录</label>
      <div class="row"><input id="wsPath" value="${esc(cfg.workspace)}" /><button class="btn sm" id="pickWs">选择</button></div>
    </div>
    <div class="grid2">
      <div class="field"><label>单次任务最大步数</label><input id="maxSteps" type="number" value="${cfg.maxSteps}" /></div>
      <div class="field"><label>打开工作区</label><button class="btn" id="openWs" style="margin-top:2px">在资源管理器中打开</button></div>
    </div>
    <div class="field"><label>附加系统设定（会拼进系统提示）</label><textarea id="sysExtra" rows="5">${esc(cfg.systemExtra || '')}</textarea></div>
    <button class="btn primary" id="savePerm">保存</button>`;

  $$('[data-kind]', panel).forEach((row) => {
    row.querySelectorAll('.pill').forEach((p) => p.addEventListener('click', () => {
      row.querySelectorAll('.pill').forEach((x) => x.classList.remove('on'));
      p.classList.add('on');
    }));
  });
  panel.querySelector('#pickWs').addEventListener('click', async () => {
    const p = await etc.dialog.pickFolder();
    if (p) panel.querySelector('#wsPath').value = p;
  });
  panel.querySelector('#openWs').addEventListener('click', () => etc.app.openPath(state.config.workspace));
  panel.querySelector('#savePerm').addEventListener('click', async () => {
    const perms = { ...state.config.permissions };
    $$('[data-kind]', panel).forEach((row) => {
      const on = row.querySelector('.pill.on');
      if (on) perms[row.dataset.kind] = on.dataset.v;
    });
    await etc.config.patch({
      permissions: perms,
      workspace: panel.querySelector('#wsPath').value.trim(),
      maxSteps: Number(panel.querySelector('#maxSteps').value) || 24,
      systemExtra: panel.querySelector('#sysExtra').value,
    });
    state.config = await etc.config.get();
    toast('已保存', 'ok');
    renderTopbar();
  });
}

function renderAbout(panel) {
  const info = state.info || {};
  panel.innerHTML = `
    <h3>关于 agent_etc</h3>
    <div class="card">
      <div class="list-line"><div class="grow"><div class="t">版本</div><div class="d">${esc(info.version || '1.0.0')}</div></div></div>
      <div class="list-line"><div class="grow"><div class="t">运行平台</div><div class="d">${esc(info.platform || '')}</div></div></div>
      <div class="list-line"><div class="grow"><div class="t">用户数据</div><div class="d">${esc(info.userData || '')}</div></div></div>
      <div class="list-line"><div class="grow"><div class="t">安装目录</div><div class="d">${esc(info.appRoot || '')}</div></div></div>
    </div>
    <div class="hintbox" style="margin-bottom:10px">agent_etc 是一个本地优先的桌面 Agent 工作台：模型由你接，工具由你装，权限由你定。所有会话、配置、插件都保存在本机。</div>
    <div class="row">
      <button class="btn sm" id="openData">打开用户数据目录</button>
      <button class="btn sm ghost" id="openGithub">GitHub 仓库</button>
    </div>
    <h3 style="margin-top:22px">代码签名</h3>
    <div class="hintbox">安装包与便携版均由 <b>ETC</b> 代码签名证书签名。若系统提示「未知发布者」，可安装随包提供的 ETC-Root.crt 到「受信任的根证书颁发机构」，签名即可验证通过。</div>`;

  panel.querySelector('#openData').addEventListener('click', () => etc.app.openPath(info.userData));
  panel.querySelector('#openGithub').addEventListener('click', () => etc.app.openExternal('https://github.com/'));
}

/* ---------------- init ---------------- */
function bindStatic() {
  $('#btnNew').addEventListener('click', newSession);
  $('#btnSettings').addEventListener('click', () => openSettings('providers'));
  $('#modelChip').addEventListener('click', () => openSettings('providers'));
  $('#btnOpenWorkspace').addEventListener('click', () => etc.app.openPath(state.config.workspace));
  $$('.side-btn').forEach((b) => b.addEventListener('click', () => {
    const panel = b.dataset.panel;
    openSettings(panel === 'plugins' ? 'plugins' : (panel === 'skills' ? 'skills' : 'providers'));
  }));
  $$('.suggest button').forEach((b) => b.addEventListener('click', () => {
    $('#input').value = b.dataset.q;
    $('#input').focus();
  }));
  $('#btnAttach').addEventListener('click', async () => {
    const files = await etc.dialog.pickFiles();
    if (files.length) { state.attachments.push(...files); renderAttachments(); }
  });
  $('#btnSend').addEventListener('click', send);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#input').addEventListener('input', () => {
    const el = $('#input');
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
    if (e.key === 'Escape') {
      if ($('#overlay').classList.contains('show')) closeOverlay();
    }
  });
  $('#overlay').addEventListener('click', (e) => {
    if (e.target.id === 'overlay') closeOverlay();
  });
}

async function init() {
  state.info = await etc.info();
  if (state.info.platform === 'win32') document.body.classList.add('win');
  state.config = await etc.config.get();
  state.sessions = await etc.sessions.list();
  bindStatic();
  bindAgentEvents();
  renderSessions();
  renderTopbar();
  renderAll();
  if (state.config.ui?.lastSessionId) {
    await loadSession(state.config.ui.lastSessionId);
  }
  refreshStatus();
  setInterval(refreshStatus, 5000);
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#ddd">初始化失败：${esc(err.message)}</div>`;
});
