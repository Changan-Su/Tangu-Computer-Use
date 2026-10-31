#!/usr/bin/env node
/**
 * 第一次读 Chromium 系 App 时的等待(src/webContent.ts)与 AXPress 的模型提示,纯单测:免 TCC、免真机、免先 build。
 * 端到端在 scripts/web-press.check.mjs。
 *
 * 用法: node scripts/web-content.check.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-web-content-check-'));
let mod;
try {
  const outfile = path.join(temp, 'bundle.mjs');
  await build({
    stdin: { contents: "export * from './src/webContent.ts'\nexport { executionNote } from './src/foregroundNote.ts'", resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent', external: ['node:*'],
  });
  mod = await import(pathToFileURL(outfile).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const { appBundleOf, hasChromiumFramework, hasWebArea, noteContact, webContentWait, executionNote, WEB_CONTENT_SETTLE_MS } = mod;

assert.equal(appBundleOf('/Applications/Visual Studio Code.app/Contents/MacOS/Electron'), '/Applications/Visual Studio Code.app');
assert.equal(appBundleOf('/Applications/Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper'), '/Applications/Code.app', 'the outer app, not the helper');
assert.equal(appBundleOf('/usr/local/bin/node'), undefined);

for (const name of ['Electron Framework.framework', 'Chromium Embedded Framework.framework', 'Google Chrome Framework.framework', 'Google Chrome for Testing Framework.framework', 'Microsoft Edge Framework.framework', 'Brave Browser Framework.framework', 'Vivaldi Framework.framework', 'ArcCore.framework']) {
  assert.equal(hasChromiumFramework(['Sparkle.framework', name]), true, name);
}
assert.equal(hasChromiumFramework(['Sparkle.framework', 'Squirrel.framework', 'EdgeKit.framework', 'OperationKit.framework', 'Qt5Core.framework']), false);
assert.equal(hasChromiumFramework([]), false);

assert.equal(hasWebArea({ role: 'AXWindow', children: [{ role: 'AXGroup', children: [{ role: 'AXWebArea', children: [] }] }] }), true);
assert.equal(hasWebArea({ role: 'AXWindow', children: [{ role: 'AXGroup', children: [] }] }), false);

const shell = { role: 'AXWindow', children: [{ role: 'AXGroup', children: [] }] };
const page = { role: 'AXWindow', children: [{ role: 'AXWebArea', children: [] }] };
const asked = [];
const chromium = (answer) => async (pid) => { asked.push(pid); return answer; };
assert.equal(await webContentWait(101, shell, chromium(false)), 0, 'not Chromium: never waits');
assert.equal(await webContentWait(102, page, chromium(true)), 0, 'web content already there');
assert.ok(!asked.includes(102), 'no need to look at the app bundle then');
const wait = await webContentWait(103, shell, chromium(true));
assert.ok(wait > WEB_CONTENT_SETTLE_MS - 200 && wait <= WEB_CONTENT_SETTLE_MS, `first contact now waits the full time (${wait})`);
assert.ok(await webContentWait(103, shell, chromium(true)) > 0, 'a cancelled wait is not used up');
assert.equal(await webContentWait(103, page, chromium(true)), 0, 'web content arrived');
assert.equal(await webContentWait(103, shell, chromium(true)), 0, 'one wait per process');
noteContact(106, Date.now() - WEB_CONTENT_SETTLE_MS - 1);
assert.equal(await webContentWait(106, shell, chromium(true)), 0, 'the wait ran out');
noteContact(106, Date.now());
assert.equal(await webContentWait(106, shell, chromium(true)), 0, 'and stays used up');
noteContact(104, Date.now() - 2000);
const rest = await webContentWait(104, shell, chromium(true));
assert.ok(rest > 300 && rest <= 500, `find_roots already started the clock (${rest})`);
noteContact(105, Date.now() - WEB_CONTENT_SETTLE_MS - 1000);
assert.equal(await webContentWait(105, shell, chromium(true)), 0, 'long enough ago: a page with no web content is just that');
console.log('✓ 首读等待');

const details = (step) => ({ config: { headless: false }, execution: { outcome: 'unknown', steps: [{ outcome: 'unknown', delivery: 'ax', ...step }] } });
assert.match(executionNote(details({ accessibilityPress: true })), /press the same element again/);
assert.doesNotMatch(executionNote(details({})), /press the same element again/, 'only after an accessibility press');
assert.doesNotMatch(executionNote(details({ accessibilityPress: false })), /press the same element again/);
assert.match(executionNote(details({ accessibilityPress: true, staleAccessibilityTree: 'current_screenshot' })), /only if the screenshot shows/);
assert.doesNotMatch(executionNote(details({ accessibilityPress: true, staleAccessibilityTree: 'current_screenshot' })), /changed nothing, press the same element again/);
assert.match(executionNote(details({ accessibilityPress: true, staleAccessibilityTree: 'no_screenshot' })), /Do not press again/);
assert.doesNotMatch(executionNote(details({ accessibilityPress: true, staleAccessibilityTree: 'no_screenshot' })), /screenshot is current/);
console.log('✓ 模型提示');
