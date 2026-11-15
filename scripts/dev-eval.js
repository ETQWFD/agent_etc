#!/usr/bin/env node
/**
 * 开发辅助：通过 Electron 远程调试端口在页面里执行一段 JS，用于界面自测。
 * 用法：node scripts/dev-eval.js "openSettings('providers')"
 */
const WebSocket = require('ws');

const port = process.env.ETC_CDP_PORT || 9333;
const expression = process.argv[2] || '1';

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!target) throw new Error('没有找到页面目标');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const id = 1;
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
  }));
  const result = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('超时')), 15000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) { clearTimeout(timer); res(msg); }
    });
  });
  if (result.result?.exceptionDetails) {
    console.error('执行异常：', JSON.stringify(result.result.exceptionDetails, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result.result?.result?.value ?? null));
  }
  ws.close();
})();
