#!/usr/bin/env node
/**
 * 叠层在引擎半身里的那一截(helper 协议 20)的纯单测。免真机:esbuild 现编再 import,helper 的收发换成假的,
 * **绝不**连真 socket、不拉起 helper。
 *
 * 钉住的事:
 *   1) act / actBatch 每条(每一步)都带 clickAfterArrival;PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL=0 时是 false(负对照)。
 *
 * 用法: node scripts/overlay-routes.check.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-overlay-routes-check-'));
let mod;
try {
  const entry = path.join(temp, 'entry.ts');
  writeFileSync(entry, [
    `export * from ${JSON.stringify(path.join(root, 'src/overlayState.ts'))};`,
    `export { macosBackend } from ${JSON.stringify(path.join(root, 'src/vendor/platform/macos/backend.ts'))};`,
    `export { macosHelper } from ${JSON.stringify(path.join(root, 'src/vendor/platform/macos/helper.ts'))};`,
  ].join('\n'));
  const outfile = path.join(temp, 'entry.mjs');
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent',
    alias: { '@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts') },
  });
  mod = await import(pathToFileURL(outfile).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const { clickAfterArrival, macosBackend, macosHelper } = mod;

// helper 的收发换成假的:记下发了什么,回一个像样的结果。真的 command() 会去连 / 拉起 helper。
const sent = [];
macosHelper.command = async (cmd, args) => { sent.push({ cmd, args }); return { outcome: 'worked', steps: [] }; };
macosHelper.daemonCommand = async () => { throw new Error('测试里不许连真 socket'); };

// 1) clickAfterArrival
assert.equal(clickAfterArrival({}), true, '缺省等光标飞到再点');
assert.equal(clickAfterArrival({ PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL: '1' }), true);
assert.equal(clickAfterArrival({ PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL: '0' }), false, '=0 是负对照:照旧立刻投递');

const request = { pid: 1, lookId: 'l1', action: 'click', target: { x: 1, y: 2 }, params: {}, policy: 'default' };
const saved = process.env.PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL;
try {
  delete process.env.PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL;
  await macosBackend.act(request);
  assert.equal(sent.at(-1).cmd, 'act');
  assert.equal(sent.at(-1).args.clickAfterArrival, true, 'act 缺省带 clickAfterArrival: true');
  process.env.PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL = '0';
  await macosBackend.act(request);
  assert.equal(sent.at(-1).args.clickAfterArrival, false, 'act 在 =0 时带 false');
  await macosBackend.actBatch([request, { ...request, action: 'scroll' }]);
  assert.equal(sent.at(-1).cmd, 'actBatch');
  assert.deepEqual(sent.at(-1).args.actions.map((a) => a.clickAfterArrival), [false, false], 'actBatch 每一步都带');
} finally {
  if (saved === undefined) delete process.env.PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL; else process.env.PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL = saved;
}

console.log('overlay routes check passed');
