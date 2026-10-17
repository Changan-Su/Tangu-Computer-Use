#!/usr/bin/env node
/**
 * 「第一次动手后自动把实时画面摆上 Agent Desk」(src/deskPresent.ts)的纯单测。免真机,用 esbuild 现编一个文件再 import。
 *
 * 钉住的事(10-17 用户报「开始操作后 Desk 不显示画面」:以前靠技能让模型调 desk_present,模型没调):
 *   1) act_ui / jev_ui 成功 → 摆一次;同一个 run 再动手不再摆(用户关掉 Desk 后不反复弹)。
 *   2) 观察类工具、没真发出输入的(失败 / didnt / Jev 预览)不摆;非 macOS、没有 presentDesk(TUI / 云端)时什么都不做、结果原样返回。
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
const { presentLiveViewOnce: present, inputWasSent } = mod;
const presentLiveViewOnce = (tool, tcx, result) => present(tool, tcx, result, 'darwin');
const ok = (outcome = 'worked') => `[execution] ${JSON.stringify({ outcome, strictBackground: false, steps: [{ outcome, delivery: 'pid' }] })}\nThe native executor confirmed this action.`;
const jev = (r) => `${JSON.stringify({ status: 'done', confirmedSteps: 1, attemptedSteps: 1, ...r })}\nmore`;

// Codex 评审:失败的 act_ui 不以 Error 开头,Jev 的失败 / 预览是 JSON —— 都不算动过手
assert.equal(inputWasSent('act_ui', ok()), true);
assert.equal(inputWasSent('act_ui', ok('unknown')), true, 'unknown = 输入发了、只是没法自证');
assert.equal(inputWasSent('act_ui', ok('didnt')), false);
assert.equal(inputWasSent('act_ui', `[execution] ${JSON.stringify({ outcome: 'unknown', error: { code: 'occluded_target' } })}`), false);
assert.equal(inputWasSent('act_ui', 'Error: State is stale'), false);
assert.equal(inputWasSent('act_ui', 'Observed something'), false, '认不出来就当没发');
assert.equal(inputWasSent('jev_ui', jev()), true);
assert.equal(inputWasSent('jev_ui', jev({ status: 'preview', preview: true, attemptedSteps: 0 })), false);
assert.equal(inputWasSent('jev_ui', jev({ status: 'stopped', attemptedSteps: 0, confirmedSteps: 0 })), false);
assert.equal(present('act_ui', { userId: 'u', appId: 'a', sessionId: 'w', runId: 'w1', presentDesk: () => { throw new Error('Windows 上不该摆') } }, ok(), 'win32'), ok(), 'Windows 不摆(实时画面只有 macOS 有)');

const specs = [];
const ctx = (runId, sessionId = 's1') => ({ userId: 'u', appId: 'a', sessionId, runId, presentDesk: (spec) => specs.push(spec) });

assert.equal(presentLiveViewOnce('observe_ui', ctx('r1'), 'ok'), 'ok');
assert.equal(presentLiveViewOnce('act_ui', ctx('r1'), ok('didnt')), ok('didnt'));
assert.equal(specs.length, 0, '观察类工具和失败的动作不摆');

assert.equal(presentLiveViewOnce('act_ui', ctx('r1'), ok()), ok());
assert.deepEqual(specs, [{ views: [{ type: 'view', view: 'plugin:tangu-computer-use:live' }], size: 'half' }], '第一次成功动手摆 live 视图,不带 name');
presentLiveViewOnce('jev_ui', ctx('r1'), jev());
presentLiveViewOnce('act_ui', ctx('r1'), ok());
assert.equal(specs.length, 1, '同一个 run 只摆一次');

presentLiveViewOnce('jev_ui', ctx('r2'), jev());
assert.equal(specs.length, 2, '新的 run 再摆一次');

presentLiveViewOnce('act_ui', ctx(undefined, 's9'), ok());
presentLiveViewOnce('act_ui', ctx(undefined, 's9'), ok());
assert.equal(specs.length, 3, '没有 runId 时按 sessionId 记');

assert.equal(presentLiveViewOnce('act_ui', { userId: 'u', appId: 'a', sessionId: 's8', runId: 'r8' }, ok()), ok(), '没有 Desk 时原样返回');
assert.equal(presentLiveViewOnce('act_ui', { ...ctx('r7'), presentDesk: () => { throw new Error('boom') } }, ok()), ok(), '摆失败不影响结果');

console.log('desk present checks passed');
