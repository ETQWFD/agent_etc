'use strict';

/**
 * 本地模型引擎管理：
 * - 识别用户选的到底是 llama.cpp 的 llama-server，还是 MNN 的 llm_demo
 * - 自动寻找常见位置里的 llama-server
 * - 一键下载官方 llama.cpp 预编译包并解压到用户数据目录
 *
 * 背景：MNN 的 llm_demo 只接受 `config.json`，不能加载 .gguf；
 * 把 --model 传给它会被当成配置路径，出现 `Unable to open llm_config file: --modelllm_config.json`。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync, spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'llama-server.exe' : 'llama-server';

function fileExists(p) {
  try { return !!p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch (_) { return false; }
}

function runProbe(bin, args, timeout = 6000) {
  try {
    const r = spawnSync(bin, args, {
      timeout,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      stdout: (r.stdout || '').toString(),
      stderr: (r.stderr || '').toString(),
      status: r.status,
      error: r.error ? r.error.message : '',
    };
  } catch (err) {
    return { stdout: '', stderr: '', status: -1, error: err.message };
  }
}

/** 判断一个可执行文件是什么引擎 */
function probe(binPath) {
  if (!fileExists(binPath)) {
    return { kind: 'missing', ok: false, version: '', message: '文件不存在' };
  }
  const base = path.basename(binPath).toLowerCase();
  const r = runProbe(binPath, ['--help']);
  const all = `${r.stdout}\n${r.stderr}`;
  const low = all.toLowerCase();

  if (low.includes('llama-server') || low.includes('--ctx-size') || low.includes('llama.cpp')) {
    const m = all.match(/version:\s*([0-9][^\s]*)/i) || all.match(/build:\s*([0-9]+)/i);
    return { kind: 'llama.cpp', ok: true, version: m ? m[1] : '', message: 'llama.cpp 运行时' };
  }
  if (low.includes('config.json') && (base.includes('llm_demo') || low.includes('prompt.txt'))) {
    return {
      kind: 'mnn-demo',
      ok: false,
      version: '',
      message: '这是 MNN 的 llm_demo，只接受 config.json + MNN 模型目录，不能加载 .gguf',
    };
  }
  if (r.error) {
    return { kind: 'unknown', ok: false, version: '', message: `无法执行：${r.error}` };
  }
  return {
    kind: 'unknown',
    ok: false,
    version: '',
    message: `无法确认这个程序是不是 llama-server（${base}）。请选择 llama.cpp 里的 llama-server${IS_WIN ? '.exe' : ''}`,
  };
}

function findOnPath(name) {
  const r = IS_WIN
    ? runProbe('where.exe', [name], 4000)
    : runProbe('which', [name], 4000);
  const line = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line && fileExists(line) ? line : '';
}

/** 返回候选运行时路径列表（不判断是否有效） */
function candidates(cfg, ctx) {
  const out = [];
  if (cfg?.localModel?.runtimePath) out.push(cfg.localModel.runtimePath);
  if (process.resourcesPath) {
    out.push(path.join(process.resourcesPath, 'engines', 'llama-win', EXE));
    out.push(path.join(process.resourcesPath, 'engines', 'llama.cpp', EXE));
  }
  for (const root of [ctx.appRoot, ctx.userDataDir]) {
    if (!root) continue;
    out.push(path.join(root, 'engines', 'llama.cpp', EXE));
    out.push(path.join(root, 'engines', EXE));
  }
  const onPath = findOnPath(IS_WIN ? 'llama-server.exe' : 'llama-server');
  if (onPath) out.push(onPath);
  return [...new Set(out)];
}

/** 综合判断当前配置的引擎状态 */
function inspect(cfg, ctx) {
  const configured = (cfg?.localModel?.runtimePath || '').trim();
  if (configured) {
    const p = probe(configured);
    return { ...p, path: configured, configured: true };
  }
  for (const cand of candidates(cfg, ctx)) {
    if (!fileExists(cand)) continue;
    const p = probe(cand);
    if (p.ok) return { ...p, path: cand, configured: false };
  }
  return {
    kind: 'none',
    ok: false,
    version: '',
    path: '',
    configured: false,
    message: '还没找到 llama-server。可以点「自动安装引擎」，或手动选择 llama.cpp 里的 llama-server',
  };
}

function pickAsset(assets) {
  const names = (assets || []).map((a) => a.name);
  const isZip = (n) => /\.zip$/i.test(n);
  const prefer = IS_WIN
    ? [/bin-win-cpu-x64\.zip$/i, /bin-win-avx2-x64\.zip$/i, /bin-win-x64\.zip$/i, /win.*x64.*\.zip$/i]
    : [/bin-ubuntu-x64\.zip$/i, /bin-linux-x64\.zip$/i, /ubuntu.*x64.*\.zip$/i, /linux.*x64.*\.zip$/i];
  for (const re of prefer) {
    const hit = names.find((n) => isZip(n) && re.test(n));
    if (hit) return assets.find((a) => a.name === hit);
  }
  const any = names.find((n) => isZip(n) && /x64|amd64/i.test(n));
  return any ? assets.find((a) => a.name === any) : null;
}

function httpJson(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout,
      headers: { 'user-agent': 'agent_etc/1.1', accept: 'application/vnd.github+json' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(httpJson(res.headers.location, timeout));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GitHub 返回 ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('GitHub 响应解析失败')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求 GitHub 超时')); });
    req.on('error', reject);
  });
}

function download(url, dest, onLog) {
  return new Promise((resolve, reject) => {
    const go = (u, redirects = 0) => {
      https.get(u, { timeout: 30000, headers: { 'user-agent': 'agent_etc/1.1' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          go(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`下载失败 HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (d) => {
          got += d.length;
          if (total && onLog) {
            const pct = Math.round((got / total) * 100);
            if (pct % 10 === 0) onLog(`下载 ${pct}%（${(got / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB）`);
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      }).on('error', reject);
    };
    go(url);
  });
}

function latestTag() {
  return new Promise((resolve, reject) => {
    https.get('https://github.com/ggml-org/llama.cpp/releases/latest', {
      timeout: 12000,
      headers: { 'user-agent': 'agent_etc/1.1' },
    }, (res) => {
      res.resume();
      const m = (res.headers.location || '').match(/\/tag\/(.+)$/);
      if (m) resolve(decodeURIComponent(m[1]));
      else reject(new Error(`无法解析 llama.cpp 最新版本（HTTP ${res.statusCode}）`));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('请求超时')); });
  });
}

function httpText(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const go = (u, n = 0) => {
      https.get(u, { timeout, headers: { 'user-agent': 'Mozilla/5.0 agent_etc' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < 5) {
          res.resume();
          go(new URL(res.headers.location, u).toString(), n + 1);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 8 * 1024 * 1024) res.destroy(); });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    };
    go(url);
  });
}

/** 取最近一个带预编译包的构建号（llama.cpp 的二进制在 b#### 预发布里） */
async function latestBuildTag() {
  const html = await httpText('https://github.com/ggml-org/llama.cpp/releases');
  const tags = [...html.matchAll(/\/llama\.cpp\/releases\/tag\/(b\d+)/g)].map((m) => m[1]);
  const uniq = [...new Set(tags)].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  if (!uniq.length) throw new Error('没有解析到 llama.cpp 构建号');
  return uniq[0];
}

async function assetsForTag(tag) {
  const html = await httpText(`https://github.com/ggml-org/llama.cpp/releases/expanded_assets/${tag}`);
  const re = new RegExp(`releases/download/${tag}/([^"?]+?\\.zip)`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const name = decodeURIComponent(m[1]);
    if (!out.some((a) => a.name === name)) {
      out.push({ name, tag, browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${m[1]}` });
    }
  }
  return out;
}

function headOk(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 8000, headers: { 'user-agent': 'agent_etc/1.1' } }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    let cmd;
    let args;
    if (IS_WIN) {
      cmd = 'powershell';
      args = ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`];
    } else {
      cmd = 'unzip';
      args = ['-o', zipPath, '-d', destDir];
    }
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => reject(new Error(`解压失败：${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) resolve(destDir);
      else reject(new Error(`解压失败（code=${code}）${err ? `：${err.slice(0, 300)}` : ''}`));
    });
  });
}

function walkFind(dir, name, depth = 0) {
  if (depth > 4) return '';
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return ''; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isFile() && it.name.toLowerCase() === name.toLowerCase()) return full;
  }
  for (const it of items) {
    if (it.isDirectory()) {
      const hit = walkFind(path.join(dir, it.name), name, depth + 1);
      if (hit) return hit;
    }
  }
  return '';
}

/**
 * 下载并安装 llama.cpp 官方预编译包。
 * @returns {Promise<{ok:boolean, path?:string, version?:string, error?:string, logs:string[]}>}
 */
async function installRuntime(ctx, onLog = () => {}) {
  const logs = [];
  const log = (s) => { logs.push(s); try { onLog(s); } catch (_) { /* ignore */ } };
  let tag = '';
  let asset = null;
  try {
    const rel = await httpJson('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
    tag = rel.tag_name || '';
    asset = pickAsset(rel.assets);
  } catch (err) {
    log(`GitHub API 不可用（${err.message}），改用 Release 跳转解析版本`);
  }
  if (!asset) {
    try {
      const buildTag = await latestBuildTag();
      const assets = await assetsForTag(buildTag);
      asset = pickAsset(assets);
      if (asset) tag = buildTag;
    } catch (err) {
      log(`Release 页面解析失败：${err.message}`);
    }
  }
  if (!tag) tag = await latestTag();
  if (!asset) {
    const guesses = IS_WIN
      ? [`llama-${tag}-bin-win-avx2-x64.zip`, `llama-${tag}-bin-win-x64.zip`]
      : [`llama-${tag}-bin-ubuntu-x64.zip`, `llama-${tag}-bin-linux-x64.zip`];
    for (const name of guesses) {
      const url = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${name}`;
      if (await headOk(url)) { asset = { name, browser_download_url: url }; break; }
    }
  }
  if (!asset) {
    return { ok: false, error: `在 llama.cpp ${tag} 里没有找到匹配当前平台的 zip 包`, logs };
  }
  if (!IS_WIN && /-win-|cudart|xcframework/i.test(asset.name)) {
    return { ok: false, error: 'llama.cpp 官方当前只发布 Windows 预编译包；Linux 请自行编译 llama-server 或改用 Windows 版', logs };
  }
  log(`发现 llama.cpp ${tag}：${asset.name}`);
  const engineDir = path.join(ctx.userDataDir, 'engines', 'llama.cpp');
  fs.mkdirSync(engineDir, { recursive: true });
  const zipPath = path.join(engineDir, asset.name);
  await download(asset.browser_download_url, zipPath, log);
  log('下载完成，开始解压');
  const unpackDir = path.join(engineDir, 'unpack');
  fs.rmSync(unpackDir, { recursive: true, force: true });
  fs.mkdirSync(unpackDir, { recursive: true });
  await extractZip(zipPath, unpackDir);
  const bin = walkFind(unpackDir, IS_WIN ? 'llama-server.exe' : 'llama-server');
  if (!bin) return { ok: false, error: '解压完成但没找到 llama-server', logs };
  const finalDir = path.join(engineDir, 'bin');
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.mkdirSync(finalDir, { recursive: true });
  fs.cpSync(path.dirname(bin), finalDir, { recursive: true });
  const finalBin = path.join(finalDir, path.basename(bin));
  try { fs.chmodSync(finalBin, 0o755); } catch (_) { /* ignore */ }
  const p = probe(finalBin);
  if (!p.ok) return { ok: false, error: p.message, logs };
  log(`安装完成：${finalBin}`);
  try { fs.rmSync(zipPath, { force: true }); } catch (_) { /* ignore */ }
  try { fs.rmSync(unpackDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  return { ok: true, path: finalBin, version: tag, logs };
}

function platformHint() {
  return IS_WIN ? 'Windows x64' : `${os.platform()} ${os.arch()}`;
}

module.exports = { probe, inspect, candidates, installRuntime, platformHint, IS_WIN };
