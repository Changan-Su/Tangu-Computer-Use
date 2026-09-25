#!/usr/bin/env node
// Release gate for the npm package. npm versions are immutable: a version that ships without its
// engine bundle or a platform helper can only be deprecated, never fixed. The release workflow runs
// this after all helpers are in place; a local run reports the Windows/Linux helpers as missing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
if (manifest.version !== pkg.version) errors.push(`manifest.json ${manifest.version} != package.json ${pkg.version}`);
if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`${info.id}: ${info.entryCount} files, ${(info.size / 1048576).toFixed(1)} MB packed`);
