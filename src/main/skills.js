'use strict';

/**
 * 技能仓库：兼容两种主流格式
 * 1) 豆包 / 通用单文件：skills/xxx.md（可选 YAML front matter：name / description）
 * 2) DeepSeek Harness / Claude 风格目录：skills/xxx/SKILL.md（带 front matter，目录内可放引用文件）
 *
 * 导入时统一拷到 userData/skills/imported/ 下，源文件不动。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MAX_PROMPT_CHARS = 24000;

function safeSlug(s) {
  return String(s || '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'skill';
}

function parseFrontMatter(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw };
  const block = raw.slice(3, end).trim();
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[m[1]] = v;
  }
  return { meta, body: raw.slice(end + 4).replace(/^\r?\n/, '') };
}

function deriveMeta(filePath, text) {
  const { meta, body } = parseFrontMatter(text);
  const fallbackName = path.basename(filePath).replace(/\.md$/i, '');
  let name = meta.name || meta.title || '';
  if (!name) {
    const h = body.match(/^\s*#\s+(.+)$/m);
    if (h) name = h[1].trim();
  }
  if (!name) name = fallbackName;
  let description = meta.description || '';
  if (!description) {
    const para = body
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith('#') && !s.startsWith('---') && !s.startsWith('>'));
    description = (para || '').slice(0, 160);
  }
  return {
    name: String(name).slice(0, 80),
    description: String(description).slice(0, 240),
    source: meta.source || '',
    version: meta.version || '',
  };
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function listMarkdownIn(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    if (it.isDirectory()) {
      if (it.name === 'node_modules' || it.name.startsWith('.')) continue;
      listMarkdownIn(path.join(dir, it.name), depth + 1, out);
    } else if (it.isFile() && /\.md$/i.test(it.name)) {
      out.push(path.join(dir, it.name));
    }
  }
  return out;
}

class SkillStore {
  constructor({ appRoot, userDataDir, getConfig, patchConfig }) {
    this.appRoot = appRoot;
    this.userDataDir = userDataDir;
    this.getConfig = getConfig;
    this.patchConfig = patchConfig;
    this.builtinDir = path.join(appRoot, 'skills');
    this.userDir = path.join(userDataDir, 'skills');
    try { fs.mkdirSync(this.userDir, { recursive: true }); } catch (_) { /* ignore */ }
  }

  disabledSet() {
    return new Set(this.getConfig()?.skills?.disabled || []);
  }

  scanDir(root, builtin) {
    const out = [];
    if (!fs.existsSync(root)) return out;

    const walk = (dir, rel, depth) => {
      if (depth > 3) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const it of entries) {
        if (it.name === 'node_modules' || it.name.startsWith('.')) continue;
        const full = path.join(dir, it.name);
        const relPath = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) {
          const skillFile = path.join(full, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            const content = fs.readFileSync(skillFile, 'utf8');
            const meta = deriveMeta(skillFile, content);
            out.push(this.makeItem({
              builtin,
              id: `${builtin ? 'builtin' : 'user'}/${relPath}`,
              name: meta.name,
              description: meta.description,
              entryPath: skillFile,
              dirPath: full,
              content,
              format: 'SKILL.md',
            }));
          } else {
            walk(full, relPath, depth + 1);
          }
        } else if (it.isFile() && /\.md$/i.test(it.name)) {
          const content = fs.readFileSync(full, 'utf8');
          const meta = deriveMeta(full, content);
          out.push(this.makeItem({
            builtin,
            id: `${builtin ? 'builtin' : 'user'}/${relPath.replace(/\.md$/i, '')}`,
            name: meta.name,
            description: meta.description,
            entryPath: full,
            dirPath: '',
            content,
            format: 'md',
          }));
        }
      }
    };

    walk(root, '', 0);
    return out;
  }

  makeItem({ builtin, id, name, description, entryPath, dirPath, content, format, origin }) {
    return {
      id,
      name: name || id,
      description: description || '',
      builtin,
      enabled: !this.disabledSet().has(id),
      bytes: content.length,
      preview: content.replace(/\s+/g, ' ').slice(0, 120),
      path: entryPath,
      dir: dirPath,
      format,
      origin: origin || (builtin ? '内置' : (id.includes('/imported/') ? '导入' : '自定义')),
    };
  }

  list() {
    const items = [
      ...this.scanDir(this.builtinDir, true),
      ...this.scanDir(this.userDir, false),
    ];
    return items.sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name, 'zh'));
  }

  find(id) {
    return this.list().find((s) => s.id === id);
  }

  contentOf(id) {
    const it = this.find(id);
    if (!it) return '';
    try { return fs.readFileSync(it.path, 'utf8'); } catch (_) { return ''; }
  }

  setEnabled(id, enabled) {
    const disabled = this.disabledSet();
    if (enabled) disabled.delete(id); else disabled.add(id);
    this.patchConfig({ skills: { disabled: [...disabled] } });
  }

  buildPrompt() {
    const enabled = this.list().filter((s) => s.enabled);
    const parts = [];
    let total = 0;
    for (const s of enabled) {
      let content = this.contentOf(s.id);
      if (!content) continue;
      content = parseFrontMatter(content).body.trim();
      if (content.length > 6000) content = `${content.slice(0, 6000)}\n…（已截断）`;
      const block = `## 技能：${s.name}\n${content}`;
      if (total + block.length > MAX_PROMPT_CHARS) break;
      total += block.length;
      parts.push(block);
    }
    return parts.join('\n\n');
  }

  async extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const cmd = isWin ? 'powershell' : 'unzip';
      const args = isWin
        ? ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`]
        : ['-o', zipPath, '-d', destDir];
      const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', (e) => reject(new Error(`解压失败：${e.message}`)));
      p.on('close', (code) => {
        if (code === 0) resolve(destDir);
        else reject(new Error(`解压失败 code=${code} ${err.slice(0, 200)}`));
      });
    });
  }

  uniqueDest(base, slug) {
    let dest = path.join(base, slug);
    let i = 2;
    while (fs.existsSync(dest)) {
      dest = path.join(base, `${slug}-${i}`);
      i += 1;
    }
    return dest;
  }

  copySkillDir(srcDir, base) {
    const slug = safeSlug(path.basename(srcDir));
    const dest = this.uniqueDest(base, slug);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(srcDir, dest, { recursive: true });
    return dest;
  }

  copySkillFile(srcFile, base) {
    const slug = safeSlug(path.parse(srcFile).name);
    const ext = path.extname(srcFile) || '.md';
    let dest = path.join(base, `${slug}${ext}`);
    let i = 2;
    while (fs.existsSync(dest)) { dest = path.join(base, `${slug}-${i}${ext}`); i += 1; }
    fs.mkdirSync(base, { recursive: true });
    fs.copyFileSync(srcFile, dest);
    return dest;
  }

  /**
   * 导入技能。支持：目录、单个 .md、.zip。
   * @returns {{ok:boolean, imported:number, items:string[], error?:string}}
   */
  async importPath(srcPath) {
    if (!fs.existsSync(srcPath)) return { ok: false, imported: 0, items: [], error: '路径不存在' };
    const base = path.join(this.userDir, 'imported');
    fs.mkdirSync(base, { recursive: true });
    const imported = [];

    if (isDir(srcPath)) {
      const skillFile = path.join(srcPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const dest = this.copySkillDir(srcPath, base);
        imported.push(dest);
      } else {
        const mds = listMarkdownIn(srcPath);
        for (const md of mds) {
          const dest = this.copySkillFile(md, base);
          imported.push(dest);
        }
      }
    } else if (/\.zip$/i.test(srcPath)) {
      const tmp = path.join(base, `.tmp-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      await this.extractZip(srcPath, tmp);
      const skills = listAllSkillDirs(tmp);
      if (skills.length) {
        for (const d of skills) imported.push(this.copySkillDir(d, base));
      } else {
        for (const md of listMarkdownIn(tmp)) imported.push(this.copySkillFile(md, base));
      }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    } else if (/\.md$/i.test(srcPath)) {
      imported.push(this.copySkillFile(srcPath, base));
    } else {
      return { ok: false, imported: 0, items: [], error: '只支持目录、.md 或 .zip' };
    }

    return { ok: imported.length > 0, imported: imported.length, items: imported, error: imported.length ? '' : '没有找到技能文件（需要 .md 或 目录里的 SKILL.md）' };
  }

  /** 扫描 DeepSeek Harness / Claude 常见技能目录，批量导入 */
  async importFromHarness() {
    const guesses = [
      path.join(os.homedir(), '.dsh', 'skills'),
      path.join(os.homedir(), '.deepseek', 'skills'),
      path.join(os.homedir(), '.deepseek-harness', 'skills'),
      path.join(os.homedir(), '.harness', 'skills'),
      path.join(os.homedir(), 'dsh', 'skills'),
    ];
    if (process.env.DSH_HOME) guesses.push(path.join(process.env.DSH_HOME, 'skills'));
    if (process.env.HARNESS_HOME) guesses.push(path.join(process.env.HARNESS_HOME, 'skills'));

    const found = guesses.filter((p) => isDir(p) && listMarkdownIn(p).length > 0);
    const imported = [];
    for (const dir of found) {
      const mds = listMarkdownIn(dir);
      for (const md of mds) {
        if (path.basename(md).toLowerCase() === 'skill.md') {
          imported.push(this.copySkillDir(path.dirname(md), path.join(this.userDir, 'imported')));
        } else {
          imported.push(this.copySkillFile(md, path.join(this.userDir, 'imported')));
        }
      }
    }
    return { ok: imported.length > 0, imported: imported.length, scanned: found, error: imported.length ? '' : '没有找到 DeepSeek Harness 技能目录（默认查 ~/.dsh/skills 等）' };
  }

  remove(id) {
    const it = this.find(id);
    if (!it) return { ok: false, error: '技能不存在' };
    if (it.builtin) return { ok: false, error: '内置技能不能删除' };
    try {
      if (it.dir && fs.existsSync(it.dir)) fs.rmSync(it.dir, { recursive: true, force: true });
      else fs.rmSync(it.path, { force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

function listAllSkillDirs(root, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of entries) {
    if (!it.isDirectory()) continue;
    const full = path.join(root, it.name);
    if (fs.existsSync(path.join(full, 'SKILL.md'))) out.push(full);
    else listAllSkillDirs(full, depth + 1, out);
  }
  return out;
}

module.exports = { SkillStore, parseFrontMatter, deriveMeta };
