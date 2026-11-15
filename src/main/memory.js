'use strict';

/**
 * 类人记忆：会记、会忘、会被提醒重新想起。
 * - 每条记忆有重要度和强度，强度随时间指数衰减（越久越淡）。
 * - 被检索命中会“回想”，强度回升。
 * - 低强度不会立刻删除，只是排到后面；低于阈值后仅在明确搜索时出现。
 */

const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const words = s.split(/[\s，。！？、；：,.!?;:'"“”‘’（）()\[\]{}<>/\\|@#$%^&*+=~`_-]+/).filter(Boolean);
  const grams = [];
  for (const w of words) {
    if (/^[a-z0-9._-]+$/.test(w)) { grams.push(w); continue; }
    const clean = w.replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
    if (clean.length <= 2) grams.push(clean);
    else for (let i = 0; i < clean.length - 1; i += 1) grams.push(clean.slice(i, i + 2));
  }
  return [...new Set(grams)].slice(0, 40);
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  let hit = 0;
  for (const t of a) if (set.has(t)) hit += 1;
  return hit / Math.max(4, Math.min(a.length, b.length));
}

class MemoryStore {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(raw.items) ? raw.items : [];
    } catch (_) {
      this.items = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, items: this.items }, null, 2));
    } catch (err) {
      console.error('[memory] 保存失败', err.message);
    }
  }

  strength(item, now = Date.now()) {
    const days = Math.max(0, (now - (item.lastRecallAt || item.createdAt)) / DAY);
    const halfLife = [0.7, 2, 7, 30, 120][Math.min(4, Math.max(0, (item.importance || 3) - 1))];
    const decayed = (item.strength || 1) * Math.pow(0.5, days / halfLife);
    return Math.max(0.02, Math.min(1, decayed));
  }

  remember(text, { importance = 3, tags = [], source = 'user' } = {}) {
    const clean = String(text || '').trim().replace(/^(请)?记住[：:，,]?\s*/, '').replace(/^记一下[：:，,]?\s*/, '').slice(0, 800);
    if (!clean) return null;
    const existing = this.items.find((x) => x.text === clean);
    if (existing) {
      existing.importance = Math.max(existing.importance || 3, importance);
      existing.lastRecallAt = Date.now();
      existing.strength = Math.min(1, (existing.strength || 1) + 0.25);
      existing.recallCount = (existing.recallCount || 0) + 1;
      this.save();
      return existing;
    }
    const item = {
      id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      text: clean,
      keywords: tokenize(clean),
      tags: (tags || []).map(String).slice(0, 8),
      importance: Math.max(1, Math.min(5, Number(importance) || 3)),
      createdAt: Date.now(),
      lastRecallAt: Date.now(),
      recallCount: 0,
      strength: 1,
      source,
    };
    this.items.push(item);
    if (this.items.length > 500) {
      this.items.sort((a, b) => this.strength(b) * (b.importance || 3) - this.strength(a) * (a.importance || 3));
      this.items = this.items.slice(0, 400);
    }
    this.save();
    return item;
  }

  search(query, limit = 6) {
    const q = tokenize(query);
    const now = Date.now();
    return this.items
      .map((item) => {
        const sim = overlap(q, item.keywords || tokenize(item.text));
        const st = this.strength(item, now);
        const imp = (item.importance || 3) / 5;
        return { item, score: sim * 0.65 + st * 0.25 + imp * 0.1, sim, st };
      })
      .filter((x) => x.sim > 0.08 || x.item.importance >= 4)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ item, score, st }) => ({
        id: item.id,
        text: item.text,
        importance: item.importance,
        strength: Number(st.toFixed(2)),
        ageDays: Number(((now - item.createdAt) / DAY).toFixed(1)),
        score: Number(score.toFixed(2)),
      }));
  }

  recall(id) {
    const item = this.items.find((x) => x.id === id);
    if (!item) return null;
    item.lastRecallAt = Date.now();
    item.recallCount = (item.recallCount || 0) + 1;
    item.strength = Math.min(1, this.strength(item) + 0.2);
    this.save();
    return item;
  }

  forget(id) {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
    return before !== this.items.length;
  }

  all(limit = 80) {
    const now = Date.now();
    return this.items
      .slice()
      .sort((a, b) => this.strength(b, now) * (b.importance || 3) - this.strength(a, now) * (a.importance || 3))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        text: item.text,
        importance: item.importance,
        strength: Number(this.strength(item, now).toFixed(2)),
        ageDays: Number(((now - item.createdAt) / DAY).toFixed(1)),
        recallCount: item.recallCount || 0,
      }));
  }

  /** 与当前对话相关的记忆，拼进系统提示 */
  contextFor(query, limit = 5) {
    const hits = this.search(query, limit);
    if (!hits.length) return '';
    for (const h of hits) this.recall(h.id);
    const lines = hits.map((h) => `- ${h.text}（重要度 ${h.importance}/5，记忆强度 ${h.strength}）`).join('\n');
    return `\n\n## 你记得的相关事情\n${lines}\n如果这些记忆和当前事实冲突，以用户当前说的为准。`;
  }

  /** 从用户话里自动记下稳定事实（不做全文存储） */
  observe(text) {
    const t = String(text || '').trim();
    if (t.length < 6 || t.length > 300) return null;
    const patterns = [
      { re: /(?:我叫|我的名字是|我是)\s*([^\s，。,.!?]{1,20})/, importance: 4 },
      { re: /(?:我喜欢|我偏好|我习惯|我常用)\s*([^\n。]{2,60})/, importance: 3 },
      { re: /(?:记住|请记住|以后都|今后都)\s*([^\n。]{2,120})/, importance: 4 },
      { re: /(?:我的|我用的是)\s*([^\n。]{2,80})/, importance: 3 },
    ];
    for (const p of patterns) {
      if (p.re.test(t)) {
        return this.remember(t.slice(0, 200), { importance: p.importance, source: 'auto' });
      }
    }
    return null;
  }
}

function registerMemoryTools(registry, memory) {
  registry.register({
    name: 'memory_save',
    description: '记住一件对以后有用的事（用户偏好、长期项目、重要结论）。重要度 1-5，默认 3。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的事实，写成一句完整的话' },
        importance: { type: 'number', description: '1-5，越大忘得越慢' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['text'],
    },
    source: 'builtin',
    run: async (args) => {
      const item = memory.remember(args.text, { importance: args.importance, tags: args.tags, source: 'tool' });
      return item ? { ok: true, id: item.id, text: item.text } : { ok: false, error: '内容为空' };
    },
  });

  registry.register({
    name: 'memory_search',
    description: '按关键词搜索长期记忆。记忆强度会随时间衰减，命中会重新加强。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
    source: 'builtin',
    run: async (args) => ({ ok: true, results: memory.search(args.query, args.limit || 6) }),
  });

  registry.register({
    name: 'memory_list',
    description: '列出当前记得的事情，按重要度和记忆强度排序。',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    source: 'builtin',
    run: async (args) => ({ ok: true, items: memory.all(args.limit || 30) }),
  });

  registry.register({
    name: 'memory_forget',
    description: '忘掉一条记忆（用户明确要求忘记时使用）。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    source: 'builtin',
    run: async (args) => ({ ok: memory.forget(args.id) }),
  });
}

module.exports = { MemoryStore, registerMemoryTools, tokenize };
