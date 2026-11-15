'use strict';

/**
 * QQ 助手：通过 OneBot v11 网关（NapCat / LLOneBot 等）收发私聊。
 * 不在本应用里收集 QQ 密码，也不做扫码；扫码登录由用户在网关客户端自己完成。
 */

const http = require('http');
const https = require('https');
const WebSocket = require('ws');

function httpJson(url, body, token, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body || {});
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.write(payload);
    req.end();
  });
}

class QQBridge {
  constructor({ getConfig, agent, sessions, onChange }) {
    this.getConfig = getConfig;
    this.agent = agent;
    this.sessions = sessions;
    this.onChange = onChange || (() => {});
    this.ws = null;
    this.status = { state: 'stopped', error: '', selfId: '', lastAt: 0 };
    this.timer = null;
    this.manualStop = false;
  }

  config() {
    return this.getConfig().qq || {};
  }

  async start() {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.endpoint) { this.stop(); return this.status; }
    this.manualStop = false;
    const base = String(cfg.endpoint).replace(/\/+$/, '');
    const wsUrl = base.replace(/^http/, 'ws') + (cfg.token ? `?access_token=${encodeURIComponent(cfg.token)}` : '');
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this.status = { state: 'error', error: err.message, selfId: '', lastAt: Date.now() };
      this.onChange(this.status);
      return this.status;
    }
    this.status = { state: 'connecting', error: '', selfId: '', lastAt: Date.now() };
    this.onChange(this.status);

    this.ws.on('open', async () => {
      this.status = { state: 'online', error: '', selfId: this.status.selfId, lastAt: Date.now() };
      this.onChange(this.status);
      try {
        const info = await httpJson(`${base}/get_login_info`, {}, cfg.token);
        if (info?.data?.user_id) {
          this.status.selfId = String(info.data.user_id);
          this.onChange(this.status);
        }
      } catch (_) { /* 网关不一定允许 HTTP；不影响收消息 */ }
    });
    this.ws.on('message', (buf) => {
      let ev;
      try { ev = JSON.parse(buf.toString()); } catch (_) { return; }
      if (ev.post_type === 'message') this.handleMessage(ev).catch((err) => console.error('[qq]', err.message));
    });
    this.ws.on('error', (err) => {
      this.status = { state: 'error', error: err.message, selfId: this.status.selfId, lastAt: Date.now() };
      this.onChange(this.status);
    });
    this.ws.on('close', () => {
      this.ws = null;
      if (this.manualStop) return;
      this.status = { ...this.status, state: 'reconnecting', lastAt: Date.now() };
      this.onChange(this.status);
      this.timer = setTimeout(() => this.start(), 5000);
    });
    return this.status;
  }

  stop() {
    this.manualStop = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { this.ws?.close(); } catch (_) { /* ignore */ }
    this.ws = null;
    this.status = { state: 'stopped', error: '', selfId: '', lastAt: Date.now() };
    this.onChange(this.status);
  }

  async handleMessage(ev) {
    const cfg = this.config();
    if (ev.message_type !== 'private') return;
    const userId = String(ev.user_id || '');
    if (!userId || userId === String(ev.self_id || cfg.selfId || '')) return;
    const allow = (cfg.allow || []).map(String).filter(Boolean);
    if (allow.length && !allow.includes(userId)) return;

    const text = String(ev.raw_message || ev.message || '').replace(/\[CQ:[^\]]+\]/g, '').trim();
    if (!text) return;
    this.status.lastAt = Date.now();
    this.onChange(this.status);

    let session = this.sessions.list().find((s) => s.title === `QQ ${userId}`);
    if (!session) session = this.sessions.create(`QQ ${userId}`);
    let answer = '';
    try {
      await this.agent.run({ session, text, attachments: [] });
      const msgs = session.messages || [];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content);
      answer = last ? String(last.content) : '';
    } catch (err) {
      answer = `执行失败：${err.message}`;
    }
    if (!answer) answer = '我处理完了，但没有生成文字回复。';
    await this.sendPrivate(userId, answer.slice(0, 3000));
  }

  async sendPrivate(userId, text) {
    const cfg = this.config();
    const base = String(cfg.endpoint || '').replace(/\/+$/, '');
    if (!base) throw new Error('缺少 OneBot 地址');
    return httpJson(`${base}/send_private_msg`, { user_id: Number(userId), message: text, auto_escape: true }, cfg.token);
  }

  async test() {
    const cfg = this.config();
    const base = String(cfg.endpoint || '').replace(/\/+$/, '');
    if (!base) return { ok: false, error: '先填 OneBot HTTP 地址，例如 http://127.0.0.1:3001' };
    try {
      const info = await httpJson(`${base}/get_login_info`, {}, cfg.token, 8000);
      if (info?.retcode === 0 || info?.data) {
        return { ok: true, selfId: String(info?.data?.user_id || ''), nickname: info?.data?.nickname || '' };
      }
      return { ok: false, error: info?.message || info?.wording || '网关返回异常' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

module.exports = { QQBridge };
