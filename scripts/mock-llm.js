'use strict';
/** 开发自测用的 OpenAI 兼容 mock 服务：验证流式输出与工具调用链路。 */
const http = require('http');

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-etc', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch (_) { /* ignore */ }
    const messages = payload.messages || [];
    const last = messages[messages.length - 1] || {};
    const userText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: payload.model || 'mock-etc' };

    if (last.role === 'user') {
      let name = 'fs_list';
      let args = {};
      const t = String(userText);
      if (t.includes('屏幕')) { name = 'screen_capture'; }
      else if (t.includes('选择')) { name = 'ask_user'; args = { question: '你希望用哪种方式继续？', options: ['直接开始', '先看方案', '取消'] }; }
      else if (t.includes('记住')) { name = 'memory_save'; args = { text: t.replace(/^.*?记住[：:，,]?\s*/, '').slice(0, 120), importance: 4 }; }
      else if (t.includes('命令')) { name = 'shell_run'; args = { command: 'echo hello from agent_etc' }; }
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      send({
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          },
        }],
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const chunks = ['我已经完成', '这一步：', '工具返回了结果。', '\n\n- 链路正常', '\n- 工具已执行'];
      let i = 0;
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      const timer = setInterval(() => {
        if (i < chunks.length) {
          send({ ...base, choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }] });
          i += 1;
        } else {
          clearInterval(timer);
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 80);
    }
  });
});

server.listen(8899, '127.0.0.1', () => console.log('mock llm on 8899'));
