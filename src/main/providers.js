'use strict';

/**
 * 模型服务适配层。
 * 支持 OpenAI 兼容接口（OpenAI / DeepSeek / Moonshot / Ollama / llama.cpp / vLLM 等）
 * 与 Anthropic Messages API；对不支持原生工具调用的模型提供提示词工具协议回退。
 */

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/v1$/.test(base) && suffix.startsWith('/v1/')) return base + suffix.slice(3);
  return base + suffix;
}

function trimSnippet(text, n = 400) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

async function readSSE(response, onLine, signal) {
  if (!response.body) throw new Error('接口没有返回数据流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new Error('已取消');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const lines = chunk.split(/\r?\n/);
        for (const line of lines) {
          const m = /^data:\s?(.*)$/.exec(line);
          if (!m) continue;
          const data = m[1].trim();
          if (!data || data === '[DONE]') continue;
          try {
            onLine(JSON.parse(data));
          } catch (_) {
            /* 忽略非 JSON 心跳 */
          }
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch (_) { /* ignore */ }
  }
}

async function httpError(response, label) {
  let text = '';
  try { text = await response.text(); } catch (_) { /* ignore */ }
  const msg = `[${label}] 请求失败：HTTP ${response.status} ${trimSnippet(text, 300)}`;
  const err = new Error(msg);
  err.status = response.status;
  return err;
}

async function openaiChat({ provider, messages, tools, signal, onDelta }) {
  const headers = {
    'Content-Type': 'application/json',
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    ...(provider.headers || {}),
  };
  const body = {
    model: provider.model,
    messages: normalizeOpenAIMessages(messages),
    stream: true,
    temperature: typeof provider.temperature === 'number' ? provider.temperature : 0.4,
  };
  if (provider.maxTokens) body.max_tokens = provider.maxTokens;
  if (tools.length && provider.toolMode !== 'prompt') {
    body.tools = toOpenAITools(tools);
    body.tool_choice = 'auto';
  }

  const resp = await fetch(joinUrl(provider.baseUrl, '/v1/chat/completions'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw await httpError(resp, provider.name || '模型服务');

  let content = '';
  const calls = new Map();
  let finishReason = '';
  await readSSE(resp, (data) => {
    const choice = (data.choices || [])[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onDelta && onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const idx = part.index ?? calls.size;
        const cur = calls.get(idx) || { id: '', name: '', arguments: '' };
        if (part.id) cur.id = part.id;
        if (part.function?.name) cur.name += part.function.name;
        if (part.function?.arguments) cur.arguments += part.function.arguments;
        calls.set(idx, cur);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }, signal);

  return {
    content,
    toolCalls: [...calls.values()]
      .filter((c) => c.name)
      .map((c) => ({ id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.name, arguments: c.arguments || '{}' })),
    finishReason,
  };
}

function normalizeOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        })),
      };
    }
    if (Array.isArray(m.content)) return { role: m.role, content: m.content };
    return { role: m.role, content: String(m.content ?? '') };
  });
}

function toAnthropicMessages(messages) {
  const out = [];
  let pendingToolResults = [];
  const flushTools = () => {
    if (pendingToolResults.length) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: String(m.content ?? ''),
      });
      continue;
    }
    flushTools();
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) {
        let input = {};
        try { input = JSON.parse(c.arguments || '{}'); } catch (_) { input = {}; }
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (Array.isArray(m.content)) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    out.push({ role: m.role, content: [{ type: 'text', text: String(m.content ?? '') }] });
  }
  flushTools();
  return out;
}

async function anthropicChat({ provider, messages, tools, signal, onDelta }) {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => String(m.content || ''));
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(provider.apiKey ? { 'x-api-key': provider.apiKey } : {}),
    ...(provider.headers || {}),
  };
  const body = {
    model: provider.model,
    max_tokens: provider.maxTokens || 4096,
    temperature: typeof provider.temperature === 'number' ? provider.temperature : 0.4,
    system: systemParts.join('\n\n'),
    messages: toAnthropicMessages(messages),
    stream: true,
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
  }

  const resp = await fetch(joinUrl(provider.baseUrl, '/v1/messages'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw await httpError(resp, provider.name || 'Anthropic');

  let content = '';
  const blocks = new Map();
  let current = -1;
  await readSSE(resp, (data) => {
    if (data.type === 'content_block_start') {
      current = data.index;
      const block = data.content_block || {};
      if (block.type === 'tool_use') blocks.set(current, { id: block.id, name: block.name, arguments: '' });
    } else if (data.type === 'content_block_delta') {
      const d = data.delta || {};
      if (d.type === 'text_delta') {
        content += d.text;
        onDelta && onDelta(d.text);
      } else if (d.type === 'input_json_delta') {
        const b = blocks.get(data.index);
        if (b) b.arguments += d.partial_json || '';
      }
    } else if (data.type === 'content_block_stop') {
      current = -1;
    }
  }, signal);

  return {
    content,
    toolCalls: [...blocks.values()].map((b) => ({
      id: b.id,
      name: b.name,
      arguments: b.arguments || '{}',
    })),
    finishReason: '',
  };
}

const TOOL_PROTOCOL = `

# 工具调用协议
你没有原生工具调用能力，必须用下面的格式发起工具调用，一次可以发起一个或多个：

<tool_call>
{"name": "工具名", "arguments": {"参数": "值"}}
</tool_call>

工具执行结果会以 "TOOL_RESULT" 开头的消息返回给你。收到结果后继续推理，直到任务完成再给出最终答复。不要凭空编造工具结果。`;

function buildPromptTools(tools) {
  const list = tools.map((t) => `- ${t.name}: ${t.description || ''}\n  JSON Schema: ${JSON.stringify(t.parameters || { type: 'object', properties: {} })}`).join('\n');
  return `${TOOL_PROTOCOL}\n\n# 可用工具\n${list}`;
}

function parsePromptToolCalls(text) {
  const calls = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1]);
      const name = obj.name || obj.tool;
      const args = obj.arguments || obj.args || {};
      if (name) calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      });
    } catch (_) { /* 忽略坏块 */ }
  }
  return calls;
}

async function chat({ provider, messages, tools, signal, onDelta }) {
  if (provider.type === 'anthropic') {
    return anthropicChat({ provider, messages, tools, signal, onDelta });
  }
  if (provider.toolMode === 'prompt') {
    const withPrompt = messages.map((m) => ({ ...m }));
    const sys = withPrompt.find((m) => m.role === 'system');
    const suffix = buildPromptTools(tools);
    if (sys) sys.content = `${sys.content}${suffix}`;
    else withPrompt.unshift({ role: 'system', content: suffix.trim() });
    const res = await openaiChat({ provider, messages: withPrompt, tools: [], signal, onDelta });
    const promptCalls = parsePromptToolCalls(res.content);
    return { ...res, content: res.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim(), toolCalls: promptCalls };
  }
  return openaiChat({ provider, messages, tools, signal, onDelta });
}

async function testProvider(provider) {
  const headers = {
    'Content-Type': 'application/json',
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    ...(provider.type === 'anthropic' && provider.apiKey ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' } : {}),
    ...(provider.headers || {}),
  };
  const url = joinUrl(provider.baseUrl, '/v1/models');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    if (!resp.ok) return { ok: false, message: await httpError(resp, provider.name || '接口').then((e) => e.message) };
    let models = [];
    try {
      const json = await resp.json();
      models = (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean);
    } catch (_) { /* ignore */ }
    return { ok: true, message: `连接成功${models.length ? `，可用模型 ${models.length} 个` : ''}`, models };
  } catch (err) {
    return { ok: false, message: `连接失败：${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, testProvider, joinUrl, buildPromptTools, parsePromptToolCalls };
