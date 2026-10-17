#!/usr/bin/env node
/**
 * 「第一次动手后自动把实时画面摆上 Agent Desk」(src/deskPresent.ts)的纯单测。免真机,用 esbuild 现编一个文件再 import。
 *
 * 钉住的事(10-17 用户报「开始操作后 Desk 不显示画面」:以前靠技能让模型调 desk_present,模型没调):
 *   1) act_ui / jev_ui 成功 → 摆一次;同一个 run 再动手不再摆(用户关掉 Desk 后不反复弹)。
 *   2) 观察类工具、Error 开头的结果不摆;没有 presentDesk(TUI / 云端)时什么都不做、结果原样返回。
 *   3) 没有 runId 时按 sessionId 记;摆的是插件的 live 视图、不带 name(标题由宿主按界面语言给)。
 *
 * 用法: node scripts/desk-present.check.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-desk-check-'));
let mod;
try {
  const outfile = path.join(temp, 'desk.mjs');
  await build({ entryPoints: [path.join(root, 'src/deskPresent.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
  mod = await import(pathToFileURL(outfile).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const { presentLiveViewOnce } = mod;

const specs = [];
const ctx = (runId, sessionId = 's1') => ({ userId: 'u', appId: 'a', sessionId, runId, presentDesk: (spec) => specs.push(spec) });

assert.equal(presentLiveViewOnce('observe_ui', ctx('r1'), 'ok'), 'ok');
assert.equal(presentLiveViewOnce('act_ui', ctx('r1'), 'Error: State is stale'), 'Error: State is stale');
assert.equal(specs.length, 0, '观察类工具和失败的动作不摆');

assert.equal(presentLiveViewOnce('act_ui', ctx('r1'), '[execution] worked'), '[execution] worked');
assert.deepEqual(specs, [{ views: [{ type: 'view', view: 'plugin:tangu-computer-use:live' }], size: 'half' }], '第一次成功动手摆 live 视图,不带 name');
presentLiveViewOnce('jev_ui', ctx('r1'), 'clicked');
presentLiveViewOnce('act_ui', ctx('r1'), 'worked');
assert.equal(specs.length, 1, '同一个 run 只摆一次');

presentLiveViewOnce('jev_ui', ctx('r2'), 'clicked');
assert.equal(specs.length, 2, '新的 run 再摆一次');

presentLiveViewOnce('act_ui', ctx(undefined, 's9'), 'worked');
presentLiveViewOnce('act_ui', ctx(undefined, 's9'), 'worked');
assert.equal(specs.length, 3, '没有 runId 时按 sessionId 记');

assert.equal(presentLiveViewOnce('act_ui', { userId: 'u', appId: 'a', sessionId: 's8', runId: 'r8' }, 'worked'), 'worked', '没有 Desk 时原样返回');
assert.equal(presentLiveViewOnce('act_ui', { ...ctx('r7'), presentDesk: () => { throw new Error('boom') } }, 'worked'), 'worked', '摆失败不影响结果');

console.log('desk present checks passed');
