#!/usr/bin/env node
// Release gate for the npm package. npm versions are immutable: a version that ships without its
// engine bundle or a platform helper can only be deprecated, never fixed. The release workflow runs
// this after all helpers are in place; a local run reports the Windows/Linux helpers as missing.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appName, isReleaseSigned, releaseDesignatedRequirement, releaseTeamId } from './macos-bundle.mjs';

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

// A helper signed by anything but the project's Developer ID (ad-hoc, another team) has a different designated
// requirement, and every macOS user would lose the Accessibility / Screen Recording grants. Without the hardened
// runtime or a secure timestamp Apple notarization rejects the helper, and with it the whole Forsion Desktop app.
if (process.platform !== 'darwin') errors.push('the macOS helper signature can only be verified on macOS');
else for (const arch of ['arm64', 'x64']) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-verify-signing-'));
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', `prebuilt/macos/${arch}/${appName}.zip`, temp]);
    const app = path.join(temp, appName);
    // Compare the exact requirement text: a substring match would pass a crafted requirement with an `or` branch.
    const shown = spawnSync('/usr/bin/codesign', ['-d', '-vv', '-r-', app], { encoding: 'utf8' });
    const out = `${shown.stdout}${shown.stderr}`;
    const designated = out.match(/^(?:# )?designated => (.*)$/m)?.[1]?.trim() ?? '(none)';
    const team = out.match(/^TeamIdentifier=(.*)$/m)?.[1]?.trim() ?? '(none)';
    const flags = out.match(/^CodeDirectory .*flags=(\S+)/m)?.[1] ?? '(none)';
    // `codesign -d` only displays; isReleaseSigned verifies the signature against the pinned requirement (an Apple
    // chain), so a self-signed certificate dressed up with the team OU and a copied requirement text fails here.
    if (team !== releaseTeamId || designated !== releaseDesignatedRequirement || !isReleaseSigned(app)) {
      errors.push(`macOS ${arch} helper is not signed with the Developer ID of team ${releaseTeamId} (team ${team}; designated => ${designated})`);
    }
    if (!/runtime/.test(flags)) errors.push(`macOS ${arch} helper lacks the hardened runtime (flags ${flags}); notarization would reject it`);
    if (!/^Timestamp=/m.test(out)) errors.push(`macOS ${arch} helper has no secure timestamp; notarization would reject it`);
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
