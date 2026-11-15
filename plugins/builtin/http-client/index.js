'use strict';

module.exports = {
  activate(ctx) {
    ctx.registerTool({
      name: 'http_request',
      description: '发起 HTTP 请求（GET/POST/PUT/DELETE），返回状态码、响应头与正文。',
      danger: true,
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: '请求方法，默认 GET' },
          url: { type: 'string', description: '完整 URL' },
          headers: { type: 'object', description: '请求头对象' },
          body: { type: 'string', description: '请求体（字符串）' },
          maxChars: { type: 'number', description: '最多返回字符数，默认 6000' },
        },
        required: ['url'],
      },
      async run(args, runCtx) {
        const approved = await (runCtx?.approve || (async () => true))({
          kind: 'network', title: '发起 HTTP 请求', detail: `${args.method || 'GET'} ${args.url}`,
        });
        if (!approved) return { skipped: true, reason: '用户拒绝了这次请求' };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        try {
          const resp = await fetch(args.url, {
            method: args.method || 'GET',
            headers: args.headers || {},
            body: args.body,
            signal: ctrl.signal,
          });
          const text = await resp.text();
          return {
            status: resp.status,
            headers: Object.fromEntries(resp.headers.entries()),
            body: text.slice(0, Number(args.maxChars) || 6000),
          };
        } finally {
          clearTimeout(timer);
        }
      },
    });
  },
};
