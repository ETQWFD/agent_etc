'use strict';

module.exports = {
  activate(ctx) {
    const { clipboard } = require('electron');
    ctx.registerTool({
      name: 'clipboard_read',
      description: '读取系统剪贴板中的文本。',
      parameters: { type: 'object', properties: {} },
      async run() {
        return { text: clipboard.readText().slice(0, 20000) };
      },
    });
    ctx.registerTool({
      name: 'clipboard_write',
      description: '把文本写入系统剪贴板。',
      danger: true,
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要写入的文本' } },
        required: ['text'],
      },
      async run(args, runCtx) {
        const approved = await (runCtx?.approve || (async () => true))({
          kind: 'write', title: '写入剪贴板', detail: String(args.text).slice(0, 200),
        });
        if (!approved) return { skipped: true };
        clipboard.writeText(String(args.text || ''));
        return { ok: true, chars: String(args.text || '').length };
      },
    });
  },
};
