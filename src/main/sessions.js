'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

class SessionStore {
  constructor(userDataDir) {
    this.dir = path.join(userDataDir, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  list() {
    const items = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        items.push({
          id: s.id,
          title: s.title || '未命名任务',
          updatedAt: s.updatedAt || s.createdAt || 0,
          createdAt: s.createdAt || 0,
          messageCount: (s.messages || []).length,
          providerId: s.providerId || '',
        });
      } catch (_) { /* 跳过坏文件 */ }
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    } catch (_) {
      return null;
    }
  }

  save(session) {
    session.updatedAt = Date.now();
    fs.writeFileSync(this.file(session.id), JSON.stringify(session, null, 2), 'utf8');
    return session;
  }

  create(title) {
    const id = crypto.randomUUID();
    const session = {
      id,
      title: title || '新任务',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      providerId: '',
      messages: [],
    };
    this.save(session);
    return session;
  }

  remove(id) {
    try { fs.unlinkSync(this.file(id)); } catch (_) { /* ignore */ }
  }

  rename(id, title) {
    const s = this.get(id);
    if (!s) return null;
    s.title = title;
    return this.save(s);
  }
}

module.exports = { SessionStore };
