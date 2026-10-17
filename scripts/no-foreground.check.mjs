#!/usr/bin/env node
/**
 * 前台行为的回归仪器。两部分:
 *   1) 默认:foregroundNote 判据的纯单测(免 TCC/免真机,CI 可跑)。钉住「什么算夺取前台」的定义,
 *      防上游同步或重构悄悄让透明化提示失效。需先 `npm run build`(读 dist/foregroundNote.js)。
 *   2) --live:ensure_app 的「后台启动不抢前台」不变量——open -g 一个临时文件到 TextEdit,断言终端仍是
 *      前台(TextEdit 没跳到前台)。需 macOS。这是我新增行为(ensure_app/透明化)的真机绿灯,不重复测 vendor。
 *
 * 用法: node scripts/no-foreground.check.mjs [--live]
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

async function unitTests() {
  const { foregroundNote, selfWindowNote, imageNote, expectNote, goneHint, noRootsHint, scrollNote } = await import(pathToFileURL(path.join(here, '..', 'tangu-plugins', 'computer-use', 'dist', 'foregroundNote.js')).href);
  const has = (s) => s.includes('[foreground]');

  // 无信号 → 空串
  assert.equal(foregroundNote(undefined), '', 'undefined → empty');
  assert.equal(foregroundNote(null), '', 'null → empty');
  assert.equal(foregroundNote({}), '', 'no signals → empty');
  assert.equal(foregroundNote({ delivery: 'ax', deliveryPolicy: 'background' }), '', 'pure background → empty');
  assert.equal(foregroundNote({ steps: [{ delivery: 'ax' }, { delivery: 'pid', deliveryPolicy: 'background' }] }), '', 'all-background steps → empty');

  // 各前台信号 → 提示
  assert.ok(has(foregroundNote({ escalatedToForeground: true })), 'escalated → note');
  assert.ok(has(foregroundNote({ delivery: 'hid' })), 'hid delivery → note');
  assert.ok(has(foregroundNote({ deliveryPolicy: 'foreground' })), 'foreground policy → note');

  // ⚠️右键 / 拖拽、后台没落下而升前台的坐标点击,policy 是 foreground;helper 却可能用 AX 命中测试
  // 在后台完成它。这时报「抢了前台」是**反的**,比不报更坏。
  assert.equal(foregroundNote({ delivery: 'ax', deliveryPolicy: 'foreground' }), '', 'ax delivery under a foreground policy → no note');
  assert.ok(has(foregroundNote({ delivery: 'ax', deliveryPolicy: 'foreground', escalatedToForeground: true })), 'ax + escalated → still a note');
  assert.ok(has(foregroundNote({ steps: [{ delivery: 'ax', deliveryPolicy: 'foreground' }, { delivery: 'hid' }] })), 'any hid step → note');
  assert.ok(has(foregroundNote({ steps: [{ delivery: 'ax' }, { escalatedToForeground: true }] })), 'any escalated step → note');

  // 升级原因透传
  const withReason = foregroundNote({ escalatedToForeground: true, escalationReason: 'foreground_required' });
  assert.ok(withReason.includes('foreground_required'), 'reason surfaced');
  assert.ok(has(foregroundNote({ delivery: 'ax', rootDelta: [{ change: 'focused' }] })), 'an accessibility provider can activate its own window');
  assert.ok(has(foregroundNote({ steps: [{ delivery: 'ax' }], rootDelta: [{ change: 'focused' }] })), 'batch-level focus evidence is not hidden by AX steps');
  assert.equal(foregroundNote({ delivery: 'ax', rootDelta: [{ change: 'appeared' }] }), '', 'a new root alone does not prove foreground activation');
  assert.equal(foregroundNote({ rootDelta: {}, steps: [null] }), '', 'malformed optional metadata does not break tool output');

  console.log('✓ unit: foregroundNote 判据 9 项全过');

  // 自家窗口提示(Forsion 反馈 6a239e58):目标 pid = 拉起引擎的桌面应用 → 提示改用界面命令;别的 App 不提示。
  const own = (s) => s.includes('[forsion]');
  assert.ok(own(selfWindowNote({ target: { pid: 80732 } }, 80732)), 'observe/act on the host app → note');
  assert.ok(own(selfWindowNote({ windows: [{ pid: 501 }, { pid: 80732 }] }, 80732)), 'find_roots listing a host window → note');
  assert.ok(selfWindowNote({ target: { pid: 80732 } }, 80732).includes('run_ui_command'), 'note names the UI tools');
  assert.equal(selfWindowNote({ target: { pid: 501 } }, 80732), '', 'another app → empty');
  assert.equal(selfWindowNote({ windows: [{ pid: 501 }] }, 80732), '', 'find_roots without host windows → empty');
  assert.equal(selfWindowNote({ windows: [{ pid: 0 }] }, 0), '', 'browser pages carry pid 0; no host pid → empty');
  assert.equal(selfWindowNote({ target: { pid: 1 } }, 1), '', 'orphaned engine (ppid 1) → empty');
  assert.equal(selfWindowNote(undefined, 80732), '', 'no details → empty');
  assert.equal(selfWindowNote({ tool: 'read_text' }, 80732), '', 'details without a target → empty');
  console.log('✓ unit: selfWindowNote 判据 9 项全过');

  // 下面四条来自 Forsion 反馈 55b984eb(微信:无障碍树是空的,只能看截图按坐标操作)。
  // 截图的坐标空间:只在这次结果附了截图时说;尺寸取 details.capture。
  const capture = { capture: { width: 900, height: 564 } };
  const image = imageNote(capture, true, 'darwin');
  assert.match(image, /\[image\].*900x564/, 'attached screenshot → its size');
  assert.match(image, /x 0-899, y 0-563/, 'valid range is stated');
  assert.match(image, /pixels in this screenshot/, 'coordinate space is stated');
  assert.match(image, /scrollX \/ scrollY distance.*same pixels/, 'macOS: scroll distance uses the same pixels');
  assert.doesNotMatch(imageNote(capture, true, 'win32'), /scrollX/, 'elsewhere the distance is not converted, so it is not claimed');
  assert.equal(imageNote(capture, false), '', 'no screenshot attached this time → empty');
  assert.equal(imageNote({ capture: { width: 0, height: 0 } }, true), '', 'outline-only look → empty');
  assert.equal(imageNote(undefined, true), '', 'no details → empty');
  // 反馈 69651ff8:同一个 App 叠在上面的窗口(搜索结果下拉)一起画进来时照实说,并说清那块按坐标点、别按被盖住那一行的 ref 点
  assert.match(image, /shows only the target window/, 'nothing drawn over it → the old wording');
  const popup = imageNote({ capture: { width: 900, height: 564, overlays: 1 } }, true, 'darwin');
  assert.match(popup, /with a window of the same app drawn over it/, 'one popup drawn in');
  assert.match(popup, /click what that window shows by x \/ y, never by the ref of a row it covers/, 'click it by coordinates');
  assert.doesNotMatch(popup, /shows only the target window/);
  assert.match(imageNote({ capture: { width: 900, height: 564, overlays: 2 } }, true, 'darwin'), /with 2 windows of the same app/, 'several');
  console.log('✓ unit: imageNote 判据 13 项全过');

  // expect 的结果:没满足要说、本来就满足要说、满足了不说。
  const exec = (verification, imageReason) => ({ execution: { verification }, imageReason });
  const failed = expectNote(exec({ status: 'failed', text: '朋友圈', timeoutMs: 8000 }));
  assert.match(failed, /\[expect\] NOT satisfied/, 'failed → note');
  assert.ok(failed.includes('"朋友圈"') && failed.includes('8000ms'), 'names the condition and the wait');
  assert.match(failed, /action itself was delivered/, 'says the action still went out');
  assert.doesNotMatch(failed, /leaving expect out/, 'a window with a real outline is not told to drop expect');
  for (const reason of ['unlabeled_ax_targets', 'sparse_ax_targets']) {
    assert.match(expectNote(exec({ status: 'failed', text: 'x', timeoutMs: 8000 }, reason)), /prefer leaving expect out/, `${reason} → advised to drop expect`);
  }
  assert.match(expectNote(exec({ status: 'failed', text: 'Loading', gone: true, timeoutMs: 500 })), /did not disappear from/, 'until=absent reads the other way');
  assert.match(expectNote(exec({ status: 'preexisting', text: 'Sakura' })), /already present before the action/, 'preexisting → proves nothing');
  assert.equal(expectNote(exec({ status: 'verified', text: 'x' })), '', 'verified → empty');
  assert.equal(expectNote({ execution: {} }), '', 'no expect → empty');
  assert.equal(expectNote(undefined), '', 'no details → empty');
  console.log('✓ unit: expectNote 判据 11 项全过');

  // 「窗口不在了」:补原因和一条能照抄的出路;别的报错原样返回。
  const gone = 'The current controlled window is no longer available. Call observe_ui to choose a new target window.';
  const hinted = goneHint(gone, { app: 'WeChat', bundleId: 'com.tencent.xinWeChat' });
  assert.ok(hinted.startsWith(gone), 'the original message is kept');
  assert.match(hinted, /another desktop \(Space\)/, 'names the other-desktop case');
  assert.doesNotMatch(hinted, /minimized/, 'minimized windows are still listed, so they are not a cause');
  assert.ok(hinted.includes('ensure_app({ bundleId: "com.tencent.xinWeChat" })'), 'gives the exact call');
  assert.ok(goneHint(gone, { app: 'WeChat' }).includes('ensure_app({ app: "WeChat" })'), 'falls back to the app name');
  assert.match(goneHint(gone), /ensure_app brings/, 'no remembered target → still names the tool');
  assert.equal(goneHint('State is stale for desktop-pid:1: expected epoch 8, current epoch 9.', { app: 'x' }), 'State is stale for desktop-pid:1: expected epoch 8, current epoch 9.', 'other errors pass through');
  console.log('✓ unit: goneHint 判据 7 项全过');

  const none = (query) => ({ tool: 'find_roots', windows: [], query });
  assert.match(noRootsHint(none({ pid: 6769 }), 'darwin'), /\[hint\].*ensure_app/, 'find_roots by pid with no roots → hint');
  assert.match(noRootsHint(none({ app: 'WeChat' }), 'darwin'), /another desktop \(Space\)/, 'by app → hint');
  assert.equal(noRootsHint(none({}), 'darwin'), '', 'an unfiltered listing → empty');
  assert.equal(noRootsHint({ tool: 'find_roots', windows: [{ pid: 1 }], query: { pid: 1 } }, 'darwin'), '', 'roots found → empty');
  assert.equal(noRootsHint(none({ pid: 1 }), 'win32'), '', 'ensure_app is macOS-only → no hint elsewhere');
  assert.equal(noRootsHint({ tool: 'observe_ui', windows: [] }, 'darwin'), '', 'not find_roots → empty');
  console.log('✓ unit: noRootsHint 判据 6 项全过');

  // 按坐标的滚动走了前台 = 真实滚轮输入:方向 / 距离不保证,要说;按 ref 的、没走前台的不说。
  const wheel = [{ action: 'click', x: 1, y: 2 }, { action: 'scroll', x: 500, y: 300, scrollY: 300 }];
  assert.match(scrollNote(wheel, { steps: [{ delivery: 'hid' }, { delivery: 'hid' }] }, 'darwin'), /\[scroll\].*positive scrollY scrolls down.*off the screenshot/, 'coordinate scroll in the foreground → note');
  assert.match(scrollNote([{ action: 'moveMouse', x: 1, y: 2 }, { action: 'scroll', scrollY: 3 }], { deliveryPolicy: 'foreground' }, 'darwin'), /\[scroll\]/, 'a scroll that reuses the pointer position counts');
  // 按这一步实际怎么送达判,不按写没写 ref:走无障碍动作的不说,pictureOnly 的 ref 落成真实输入的要说。
  assert.equal(scrollNote([{ action: 'scroll', ref: '@e2', scrollY: 3 }], { steps: [{ delivery: 'ax' }] }, 'darwin'), '', 'ref scroll done through accessibility → empty');
  assert.match(scrollNote([{ action: 'scroll', ref: '@e2', scrollY: 3 }], { steps: [{ delivery: 'hid' }] }, 'darwin'), /\[scroll\]/, 'ref scroll that resolved to real input → note');
  assert.equal(scrollNote([{ action: 'click', x: 1, y: 2 }, { action: 'scroll', ref: '@e2', scrollY: 3 }], { steps: [{ delivery: 'hid' }, { delivery: 'ax' }] }, 'darwin'), '', 'another step took the foreground, the scroll did not → empty');
  assert.equal(scrollNote(wheel, { steps: [{ delivery: 'hid' }] }, 'darwin'), '', 'the batch stopped before the scroll ran → empty');
  assert.match(scrollNote(wheel, { steps: [{ delivery: 'ax' }, { delivery: 'pid', deliveryPolicy: 'background' }] }, 'darwin'), /\[scroll\]/, 'a background wheel event (pid + window number) goes through the mouse utility too → note');
  assert.equal(scrollNote(wheel, { steps: [{ delivery: 'ax' }, { delivery: 'ax' }] }, 'darwin'), '', 'scrolled through accessibility only → empty');
  assert.equal(scrollNote([{ action: 'click', x: 1, y: 2 }], { delivery: 'hid' }, 'darwin'), '', 'no scroll → empty');
  assert.equal(scrollNote(undefined, { delivery: 'hid' }, 'darwin'), '', 'no actions → empty');
  assert.equal(scrollNote(wheel, { steps: [{ delivery: 'hid' }, { delivery: 'hid' }] }, 'win32'), '', 'not macOS → empty');
  console.log('✓ unit: scrollNote 判据 10 项全过');
}

async function frontmostBundleId() {
  const { stdout } = await execFileP('osascript', ['-e',
    'tell application "System Events" to get bundle identifier of first application process whose frontmost is true']);
  return stdout.trim();
}

async function liveTest() {
  if (process.platform !== 'darwin') { console.log('· live: 跳过(非 macOS)'); return; }
  const before = await frontmostBundleId();
  const dir = mkdtempSync(path.join(tmpdir(), 'cu-nofg-'));
  const file = path.join(dir, 'cu-no-foreground-probe.txt');
  writeFileSync(file, 'probe\n');
  try {
    // -g:后台打开(TextEdit 承接 .txt),不应置前台。
    await execFileP('open', ['-g', '-e', file], { timeout: 8_000 });
    await new Promise((r) => setTimeout(r, 1500));
    const after = await frontmostBundleId();
    assert.equal(after, before, `frontmost changed: ${before} → ${after}(后台启动却抢了前台)`);
    assert.notEqual(after, 'com.apple.TextEdit', 'TextEdit 跳到了前台');
    console.log(`✓ live: 后台启动 TextEdit,前台仍是 ${after}(未被抢)`);
  } finally {
    await execFileP('osascript', ['-e', 'tell application "TextEdit" to close (every document whose path is "' + file + '")']).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const live = process.argv.includes('--live');
await unitTests();
if (live) await liveTest();
console.log(`\n✅ no-foreground check 通过${live ? '(含 --live)' : ''}`);
