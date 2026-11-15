'use strict';

/**
 * 桌面「眼睛 + 手」与系统检索工具：
 * - screen_capture：截取当前屏幕，返回图片路径 + 给模型看的缩略图
 * - screen_click / screen_type / screen_key：真实控制鼠标键盘
 * - fs_search / fs_drives：在自己电脑上搜文件、列出磁盘
 * - ask_user：需要用户拍板时弹出选项，等用户选完再继续
 *
 * 人机验证（CAPTCHA）不做绕过：检测到就停下，交给用户本人完成。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function sh(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : '' });
    });
  });
}

function ps(script, timeout = 15000) {
  return sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], timeout);
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
}

async function captureScreen(workspace) {
  const { desktopCapturer, screen } = require('electron');
  const { width, height } = screen.getPrimaryDisplay().size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  if (!sources.length) throw new Error('没有拿到屏幕源（系统权限可能未授予）');
  const src = sources[0];
  const full = src.thumbnail;
  const dir = path.join(workspace, 'screenshots');
  ensureDir(dir);
  const file = path.join(dir, `screen-${Date.now()}.png`);
  fs.writeFileSync(file, full.toPNG());
  const small = full.getSize().width > 1280 ? full.resize({ width: 1280 }) : full;
  return {
    ok: true,
    path: file,
    width,
    height,
    imageDataUrl: `data:image/png;base64,${small.toPNG().toString('base64')}`,
    note: '坐标以屏幕左上角为原点，单位像素；点击前先用 screen_capture 确认位置。',
  };
}

async function click(x, y, button = 'left') {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('坐标无效');
  if (IS_WIN) {
    const down = button === 'right' ? '0x0008' : '0x0002';
    const up = button === 'right' ? '0x0010' : '0x0004';
    const r = await ps(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class M { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,System.UIntPtr e); }'; [M]::SetCursorPos(${px},${py}); Start-Sleep -Milliseconds 60; [M]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [M]::mouse_event(${up},0,0,0,[UIntPtr]::Zero); 'ok'`);
    if (!r.ok) throw new Error(r.error || r.stderr || '点击失败');
  } else if (IS_MAC) {
    throw new Error('macOS 的桌面点击暂未实现，请使用浏览器工具或手动操作');
  } else {
    const r = await sh('bash', ['-lc', `xdotool mousemove ${px} ${py} click ${button === 'right' ? 3 : 1}`]);
    if (!r.ok) throw new Error(r.error || r.stderr || '点击失败（需要 xdotool）');
  }
  return { ok: true, x: px, y: py, button };
}

async function typeText(text) {
  if (!text) return { ok: true };
  if (IS_WIN) {
    const b64 = Buffer.from(String(text), 'utf8').toString('base64');
    const r = await ps(`$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t; Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 120; [System.Windows.Forms.SendKeys]::SendWait('^v')`);
    if (!r.ok) throw new Error(r.error || r.stderr || '输入失败');
  } else {
    const r = await sh('bash', ['-lc', `xdotool type --delay 30 ${JSON.stringify(String(text))}`]);
    if (!r.ok) throw new Error(r.error || r.stderr || '输入失败（需要 xdotool）');
  }
  return { ok: true, chars: String(text).length };
}

async function pressKey(keys) {
  const seq = String(keys || '').trim();
  if (!seq) return { ok: true };
  if (IS_WIN) {
    const send = seq
      .replace(/\bctrl\b/gi, '^').replace(/\balt\b/gi, '%').replace(/\bshift\b/gi, '+')
      .replace(/\benter\b/gi, '{ENTER}').replace(/\btab\b/gi, '{TAB}')
      .replace(/\besc\b/gi, '{ESC}').replace(/\bwin\b/gi, '^{ESC}');
    const r = await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${send.replace(/'/g, "''")}')`);
    if (!r.ok) throw new Error(r.error || r.stderr || '按键失败');
  } else {
    const r = await sh('bash', ['-lc', `xdotool key ${seq.split(/[+,]/).map((s) => s.trim()).join('+')}`]);
    if (!r.ok) throw new Error(r.error || r.stderr || '按键失败（需要 xdotool）');
  }
  return { ok: true, keys: seq };
}

async function listDrives() {
  if (IS_WIN) {
    const r = await ps("Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | ConvertTo-Json -Compress");
    if (!r.ok) throw new Error(r.stderr || '读取磁盘失败');
    try { return JSON.parse(r.stdout || '[]'); } catch (_) { return []; }
  }
  const r = await sh('bash', ['-lc', "df -h --output=target,used,avail 2>/dev/null | tail -n +2"]);
  return String(r.stdout || '').trim().split('\n').filter(Boolean).map((line) => {
    const [mount, used, avail] = line.split(/\s+/);
    return { mount, used, avail };
  });
}

async function searchFiles({ query, root, maxResults = 60, exts = '', maxDepth = 8 }) {
  const q = String(query || '').toLowerCase();
  const roots = root ? [root] : (IS_WIN ? await listDrives().then((d) => (d || []).map((x) => `${x.Name}:\\`)).catch(() => ['C:\\']) : ['/home/user']);
  const extList = String(exts || '').split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  const skip = new Set(['node_modules', '.git', '.cache', 'AppData\\Local\\Temp', 'Windows\\WinSxS', '$Recycle.Bin', 'System Volume Information']);
  const deadline = Date.now() + 12000;

  const walk = (dir, depth) => {
    if (out.length >= maxResults || depth > maxDepth || Date.now() > deadline) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      if (out.length >= maxResults || Date.now() > deadline) return;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (skip.has(it.name) || it.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (it.isFile()) {
        if (q && !it.name.toLowerCase().includes(q)) continue;
        if (extList.length && !extList.some((e) => it.name.toLowerCase().endsWith(e.startsWith('.') ? e : `.${e}`))) continue;
        let size = 0; let mtime = 0;
        try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (_) { /* ignore */ }
        out.push({ path: full, size, mtime: Math.round(mtime) });
      }
    }
  };

  for (const r of roots) walk(r, 0);
  return { ok: true, query, roots, count: out.length, results: out, truncated: out.length >= maxResults };
}

function registerDesktopTools(registry, deps) {
  const getWorkspace = deps.getWorkspace;

  registry.register({
    name: 'screen_capture',
    description: '截取当前整个屏幕，保存到工作区并返回图片；可用于“看”用户桌面、确认按钮位置后再点击。',
    parameters: { type: 'object', properties: {} },
    source: 'builtin',
    run: async () => captureScreen(getWorkspace()),
  });

  registry.register({
    name: 'screen_click',
    description: '在屏幕绝对坐标处点击鼠标（左键/右键）。先用 screen_capture 看清目标位置。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 像素' },
        y: { type: 'number', description: '屏幕 Y 像素' },
        button: { type: 'string', enum: ['left', 'right'], description: '鼠标键' },
      },
      required: ['x', 'y'],
    },
    danger: true,
    source: 'builtin',
    run: async (args, ctx) => {
      const ok = await ctx.approve({
        kind: 'desktop',
        title: '控制鼠标',
        detail: `点击屏幕坐标 (${args.x}, ${args.y})（${args.button || 'left'}）`,
        preview: '',
      });
      if (!ok) return { ok: false, denied: true, error: '用户拒绝了鼠标操作' };
      return click(args.x, args.y, args.button || 'left');
    },
  });

  registry.register({
    name: 'screen_type',
    description: '向当前焦点窗口输入文本（先点击目标输入框）。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要输入的文本' } },
      required: ['text'],
    },
    danger: true,
    source: 'builtin',
    run: async (args, ctx) => {
      const ok = await ctx.approve({ kind: 'desktop', title: '控制键盘', detail: `输入 ${String(args.text || '').slice(0, 120)}`, preview: '' });
      if (!ok) return { ok: false, denied: true, error: '用户拒绝了键盘操作' };
      return typeText(args.text);
    },
  });

  registry.register({
    name: 'screen_key',
    description: '按快捷键，例如 ctrl+s、enter、alt+tab、ctrl+w。',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: '组合键，例如 ctrl+s' } },
      required: ['keys'],
    },
    danger: true,
    source: 'builtin',
    run: async (args, ctx) => {
      const ok = await ctx.approve({ kind: 'desktop', title: '控制键盘', detail: `按下 ${args.keys}`, preview: '' });
      if (!ok) return { ok: false, denied: true, error: '用户拒绝了按键操作' };
      return pressKey(args.keys);
    },
  });

  registry.register({
    name: 'fs_drives',
    description: '列出本机磁盘/分区与剩余空间。',
    parameters: { type: 'object', properties: {} },
    source: 'builtin',
    run: async () => ({ ok: true, drives: await listDrives() }),
  });

  registry.register({
    name: 'fs_search',
    description: '按文件名关键词递归搜索本机文件，可限定根目录、扩展名、最大结果数。比逐个目录 fs_list 快得多。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '文件名关键词（不区分大小写）' },
        root: { type: 'string', description: '搜索根目录，默认所有磁盘（Windows）或用户目录' },
        exts: { type: 'string', description: '限定扩展名，例如 .pdf,.docx' },
        maxResults: { type: 'number', description: '最多返回多少条，默认 60' },
      },
    },
    source: 'builtin',
    run: async (args) => searchFiles(args),
  });

  registry.register({
    name: 'ask_user',
    description: '需要用户在几个方案里做选择、或缺少关键信息时调用。会弹窗让用户点选，返回用户选中的项；不要自己猜。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题' },
        options: { type: 'array', items: { type: 'string' }, description: '2-4 个候选项' },
        allowMultiple: { type: 'boolean', description: '是否允许多选' },
      },
      required: ['question', 'options'],
    },
    source: 'builtin',
    run: async (args, ctx) => {
      if (!ctx.ask) throw new Error('当前环境不支持弹窗选择');
      const answer = await ctx.ask({
        question: String(args.question || '请选择'),
        options: (args.options || []).map(String).slice(0, 4),
        allowMultiple: !!args.allowMultiple,
      });
      return { ok: true, ...answer };
    },
  });
}

module.exports = { registerDesktopTools, captureScreen, listDrives, searchFiles };
