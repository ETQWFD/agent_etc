'use strict';

const https = require('https');

const REPO = 'ETQWFD/agent_etc';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES = `https://github.com/${REPO}/releases`;

function parseVersion(v) {
  const m = String(v || '').replace(/^v/i, '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : [0, 0, 0];
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function fetchJson(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout,
      headers: { 'user-agent': 'agent_etc-updater', accept: 'application/vnd.github+json' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(fetchJson(res.headers.location, timeout));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GitHub 返回 ${res.statusCode}（可能是网络或仓库不可达）`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('更新信息解析失败')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('检查更新超时')));
    req.on('error', reject);
  });
}

function latestTagFromRedirect() {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://github.com/${REPO}/releases/latest`, {
      timeout: 12000,
      headers: { 'user-agent': 'agent_etc-updater' },
    }, (res) => {
      res.resume();
      const loc = res.headers.location || '';
      const m = loc.match(/\/tag\/(.+)$/);
      if (m) resolve(decodeURIComponent(m[1]));
      else reject(new Error(`无法从 GitHub 页面解析版本（HTTP ${res.statusCode}）`));
    });
    req.on('timeout', () => req.destroy(new Error('检查更新超时')));
    req.on('error', reject);
  });
}

async function checkUpdate(currentVersion) {
  let rel = null;
  let apiError = '';
  try {
    rel = await fetchJson(API);
  } catch (err) {
    apiError = err.message;
  }

  if (rel) {
    const latest = String(rel.tag_name || rel.name || '').replace(/^v/i, '') || '0.0.0';
    return {
      ok: true,
      current: currentVersion,
      latest,
      hasUpdate: isNewer(latest, currentVersion),
      url: rel.html_url || RELEASES,
      notes: String(rel.body || '').slice(0, 4000),
      publishedAt: rel.published_at || '',
      assets: (rel.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
    };
  }

  // API 被限流（403）时，退回到 releases/latest 的跳转地址拿版本号
  const tag = await latestTagFromRedirect();
  const latest = String(tag).replace(/^v/i, '');
  return {
    ok: true,
    current: currentVersion,
    latest,
    hasUpdate: isNewer(latest, currentVersion),
    url: `https://github.com/${REPO}/releases/tag/${tag}`,
    notes: '',
    publishedAt: '',
    assets: [],
    degraded: true,
    apiError,
  };
}

module.exports = { checkUpdate, isNewer, parseVersion, REPO, RELEASES };
