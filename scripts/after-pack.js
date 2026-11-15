'use strict';

/**
 * afterPack：不依赖 wine/rcedit，用纯 JS 给 Windows exe 写图标和版本信息。
 * 打包在 Linux 上也能稳定出带 ETC 图标的 exe。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exePath = path.join(context.appOutDir, 'agent_etc.exe');
  if (!fs.existsSync(exePath)) return;
  const iconPath = path.join(context.packager.info.projectDir, 'build', 'icon.ico');
  const version = context.packager.appInfo.version || '1.2.0';
  const parts = version.split('.').map((n) => Number(n) || 0);
  while (parts.length < 4) parts.push(0);

  const original = fs.readFileSync(exePath);
  const exe = NtExecutable.from(original, { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const items = Resource.VersionInfo.fromEntries(res.entries);
  if (items.length) {
    const vi = items[0];
    const lang = vi.getDefaultVersionLang() || { lang: 1033, codepage: 1200 };
    vi.setFileVersion(parts[0], parts[1], parts[2], parts[3]);
    vi.setProductVersion(parts[0], parts[1], parts[2], parts[3]);
    vi.setStringValues(lang, {
      ProductName: 'agent_etc',
      FileDescription: 'agent_etc — 可自改装的桌面 Agent 工作台',
      CompanyName: 'ETC',
      LegalCopyright: 'Copyright © 2026 ETC',
      OriginalFilename: 'agent_etc.exe',
      InternalName: 'agent_etc',
    });
    vi.outputToResourceEntries(res.entries);
    vi.outputToResourceEntries(res.entries, '040904B0');
  }

  if (fs.existsSync(iconPath)) {
    const iconFile = Data.IconFile.from(fs.readFileSync(iconPath));
    Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      1033,
      iconFile.icons.map((i) => i.data)
    );
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));

  // 用 ETC 证书给主程序签名（Linux 原生 osslsigncode，不经过 wine）
  const pfx = path.join(context.packager.info.projectDir, 'certs', 'ETC-CodeSigning.pfx');
  const passFile = path.join(context.packager.info.projectDir, 'certs', 'PASSWORD.txt');
  if (fs.existsSync(pfx)) {
    const pass = fs.existsSync(passFile) ? fs.readFileSync(passFile, 'utf8').trim() : 'ETC2026-agent-etc';
    const signed = `${exePath}.signed`;
    try {
      execFileSync('osslsigncode', ['sign', '-pkcs12', pfx, '-pass', pass,
        '-n', 'agent_etc', '-i', 'https://github.com/ETQWFD/agent_etc',
        '-in', exePath, '-out', signed], { stdio: 'pipe' });
      fs.renameSync(signed, exePath);
      console.log('[after-pack] signed:', exePath);
    } catch (err) {
      try { fs.unlinkSync(signed); } catch (_) { /* ignore */ }
      console.warn('[after-pack] sign skipped:', err.message);
    }
  }
  console.log('[after-pack] icon + version written:', exePath);
};
