#!/usr/bin/env node
// Release gate for the npm package. npm versions are immutable: a version that ships without its
// engine bundle or a platform helper can only be deprecated, never fixed. The release workflow runs
// this after all helpers are in place; a local run reports the Windows/Linux helpers as missing.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appName, bundleId, releaseCertSha1 } from './macos-bundle.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const [info] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const files = new Set(info.files.map((f) => f.path));
const required = [
  'package.json', 'manifest.json', 'main.js', 'skills/computer-use/SKILL.md',
  'tangu-plugins/computer-use/tangu-plugin.json', 'tangu-plugins/computer-use/dist/index.js',
  'scripts/setup-helper.mjs', 'scripts/verify-macos-bundles.mjs',
  ...['arm64', 'x64'].flatMap((arch) => [
    `prebuilt/macos/${arch}/tangu-computer-use.app.zip`,
    `prebuilt/macos/${arch}/tangu-computer-use.app.json`,
  ]),
  'prebuilt/windows/windows-bridge.exe',
  'prebuilt/linux/x64/linux-bridge',
  'prebuilt/linux/arm64/linux-bridge',
];
const errors = [
  ...required.filter((f) => !files.has(f)).map((f) => `missing ${f}`),
  ...[...files].filter((f) => /(^|\/)target\/|\.map$|(^|\/)\.env/.test(f)).map((f) => `must not ship ${f}`),
];
const engine = JSON.parse(readFileSync('tangu-plugins/computer-use/tangu-plugin.json', 'utf8'));
for (const [file, version] of [['manifest.json', manifest.version], ['tangu-plugins/computer-use/tangu-plugin.json', engine.version]]) {
  if (version !== pkg.version) errors.push(`${file} ${version} != package.json ${pkg.version}`);
}

// Import and delay-import DLL names are plain ASCII: any of the VC++ runtime family means the helper was linked
// against it dynamically, and it will not start on a Windows without the VC++ Redistributable. build-native.mjs
// links it statically (+crt-static). Genesis's release-content pattern plus msvcr<nn> (the pre-2015 C runtime);
// the digits keep msvcrt.dll, which Windows ships, out.
const windowsHelper = 'prebuilt/windows/windows-bridge.exe';
if (existsSync(windowsHelper)) {
  const vcRuntime = readFileSync(windowsHelper).toString('latin1').match(/\b(?:vcruntime|msvcr|msvcp|concrt|vccorlib|vcomp|vcamp)\d+(?:_\w+)?\.dll/i);
  if (vcRuntime) errors.push(`${windowsHelper} imports ${vcRuntime[0]} (build it with scripts/build-native.mjs, which links +crt-static)`);
}

// A helper signed by anything but the release certificate (ad-hoc, a regenerated key) has a different
// designated requirement, and every macOS user would lose the Accessibility / Screen Recording grants.
if (process.platform !== 'darwin') errors.push('the macOS helper signature can only be verified on macOS');
else for (const arch of ['arm64', 'x64']) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-verify-signing-'));
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', `prebuilt/macos/${arch}/${appName}.zip`, temp]);
    // Check the real signer (leaf certificate extracted from the signature) and the exact requirement text:
    // a substring match would pass a crafted requirement such as `... leaf = H"<pin>" or leaf = H"<other>"`.
    const prefix = path.join(temp, 'signer');
    const shown = spawnSync('/usr/bin/codesign', ['-d', '-r-', `--extract-certificates=${prefix}`, path.join(temp, appName)], { encoding: 'utf8' });
    const designated = `${shown.stdout}${shown.stderr}`.match(/^(?:# )?designated => (.*)$/m)?.[1]?.trim() ?? '(none)';
    const signer = existsSync(`${prefix}0`) ? createHash('sha1').update(readFileSync(`${prefix}0`)).digest('hex') : 'ad-hoc';
    const expected = ['leaf', 'root'].map((kind) => `identifier "${bundleId}" and certificate ${kind} = H"${releaseCertSha1}"`);
    if (signer !== releaseCertSha1 || !expected.includes(designated)) {
      errors.push(`macOS ${arch} helper is not signed with the release certificate ${releaseCertSha1} (signer ${signer}; designated => ${designated})`);
    }
  } catch (error) {
    errors.push(`macOS ${arch} helper archive could not be inspected: ${error.message}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`${info.id}: ${info.entryCount} files, ${(info.size / 1048576).toFixed(1)} MB packed`);
