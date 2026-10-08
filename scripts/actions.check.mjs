#!/usr/bin/env node
/**
 * act_ui 动作准备(src/vendor/actions.ts)的纯单测:不带目标的 keypress / typeText / scroll 该怎么落。
 * 免 TCC、免真机、免先 build —— 用 esbuild 现编 actions.ts 一个文件再 import。
 *
 * 钉住的事(Forsion 反馈 96ecce8c:微信的无障碍树是空的,只能按坐标操作,模型两次各白跑一轮):
 *   1) 不带 ref / x / y 的按键:本批点过、或目标窗口此刻就在前台 → 跟随焦点;否则报错,文案写明两种改法。
 *      「在前台」只对真正没带目标的按键生效,且只管到本批第一个 click / press 为止。
 *   2) 严格后台(headless)永不跟随焦点 —— 那条路不许抢前台。
 *   3) 不带 ref / x / y 的 scroll:沿用本批里上一次 click / moveMouse 落下的位置;单独出现就报错并写明改法。
 *   4) 「目标窗口在前台」的判据:pid 与窗口都对上才算。跟随焦点的按键不会重新激活目标,
 *      判松了就会把字打进用户刚切过去的那个 App。
 *
 * 用法: node scripts/actions.check.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 编到临时文件再 import(不用 data: URL —— 断言红的时候堆栈里会带上整段 base64,没法读)。
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-actions-check-'));
let actions;
try {
  const outfile = path.join(temp, 'actions.mjs');
  await build({ entryPoints: [path.join(root, 'src/vendor/actions.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
  actions = await import(pathToFileURL(outfile).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const { prepareAction, followsFocus, needsFrontmostProbe, targetIsFrontmost } = actions;

const node = (over = {}) => ({ ref: '@e1', wireRef: 'w1', role: 'AXButton', actions: ['AXPress'], canPress: true, children: [], rect: { x: 100, y: 200, w: 40, h: 20 }, ...over });
const nodes = { '@e1': node(), '@e2': node({ ref: '@e2', wireRef: 'w2', role: 'AXScrollArea', actions: [], canPress: false }) };
const env = (over = {}) => ({
  headless: false,
  image: { width: 1000, height: 800 },
  node: (ref) => nodes[ref] ?? assert.fail(`unknown ref ${ref}`),
  center: (n) => ({ x: n.rect.x + n.rect.w / 2, y: n.rect.y + n.rect.h / 2 }),
  validatePoint: (x, y) => { if (x < 0 || y < 0) throw new Error('Coordinates are outside the look image.'); },
  ...over,
});
/** 一批动作的起始状态。frontmost = 桥接层在批次开头实测到「目标窗口在前台」;clicked = 本批已有点击建立了焦点。 */
const fresh = ({ frontmost = false, clicked = false } = {}) => ({ currentFocus: clicked, frontmost });
const message = (fn) => { try { fn(); } catch (error) { return error.message; } assert.fail('expected an error'); };

// ── 1) 按键跟随焦点 ──
for (const action of [{ action: 'keypress', keys: ['UP'] }, { action: 'typeText', text: 'hi' }]) {
  const name = action.action;
  // 两种「焦点已知」:本批点过;或上一次调用点过、目标窗口此刻仍在前台(反馈里的场景)
  for (const [why, state] of [['a click in this batch', fresh({ clicked: true })], ['a frontmost target window', fresh({ frontmost: true })]]) {
    const focused = prepareAction(action, state, env());
    assert.equal(focused.usesCurrentFocus, true, `${name}: follows the focus after ${why}`);
    assert.deepEqual(focused.target, { focus: { x: 500, y: 400 } }, `${name}: focus target is the image center`);
  }

  // 无从判断 → 报错,且两种改法都写明
  const lost = message(() => prepareAction(action, fresh(), env()));
  assert.match(lost, /same act_ui call/, `${name}: error names the same-call click`);
  assert.match(lost, /x and y/, `${name}: error names x and y`);
  assert.match(lost, /frontmost/, `${name}: error says why`);

  // 自带坐标的不吃「在前台」这条:照旧按坐标目标走(后台优先),坐标照旧要过校验
  const pointed = prepareAction({ ...action, x: 10, y: 20 }, fresh({ frontmost: true }), env());
  assert.equal(pointed.usesCurrentFocus, false, `${name}: x/y on a frontmost window stays a point target`);
  assert.deepEqual(pointed.target, { x: 10, y: 20 });
  assert.match(message(() => prepareAction({ ...action, x: -1, y: -1 }, fresh({ frontmost: true }), env())), /outside the look image/, `${name}: x/y is still validated`);
  // 上游原有行为不变:本批点击建立焦点后,自带坐标的按键也跟随焦点
  assert.equal(prepareAction({ ...action, x: 10, y: 20 }, fresh({ clicked: true }), env()).usesCurrentFocus, true, `${name}: upstream behaviour after an in-batch click is unchanged`);

  // 「在前台」只管到本批第一个 click / press 为止:那一下可能把前台交给别的 App,之后的字就会打错地方
  for (const click of [{ action: 'press', ref: '@e1' }, { action: 'click', ref: '@e1' }, { action: 'click', x: 5, y: 5 }]) {
    const state = fresh({ frontmost: true });
    prepareAction(click, state, env());
    assert.match(message(() => prepareAction(action, state, env())), /no focus to follow/, `${name}: a ${click.action} ends the frontmost claim`);
  }
  // 不涉及点击的动作不打断它
  {
    const state = fresh({ frontmost: true });
    prepareAction({ action: 'moveMouse', x: 5, y: 5 }, state, env());
    prepareAction({ action: 'scroll', scrollY: 3 }, state, env());
    prepareAction({ action: 'keypress', keys: ['DOWN'] }, state, env());
    assert.equal(prepareAction(action, state, env()).usesCurrentFocus, true, `${name}: moveMouse / scroll / keypress keep the frontmost claim`);
  }

  // ── 2) 严格后台永不跟随焦点,哪怕状态里(误)写了有焦点 ──
  for (const state of [fresh({ clicked: true }), fresh({ frontmost: true })]) {
    const strict = message(() => prepareAction(action, state, env({ headless: true })));
    assert.match(strict, /requires either ref or both x and y/, `${name}: headless still demands a target`);
    assert.match(strict, /Strict background/, `${name}: headless error says why`);
    assert.doesNotMatch(strict, /same act_ui call/, `${name}: headless error does not suggest a click (it would not help)`);
  }
  assert.equal(prepareAction({ ...action, x: 10, y: 20 }, fresh({ clicked: true, frontmost: true }), env({ headless: true })).usesCurrentFocus, false, `${name}: headless never uses the focus`);
}
console.log('✓ keypress / typeText:跟随焦点、无从判断时的报错文案、严格后台不放宽');

// ── 3) scroll 沿用本批指针位置 ──
{
  // 反馈里的原样调用:moveMouse 后跟一个只有 scrollY 的 scroll
  const state = fresh();
  prepareAction({ action: 'moveMouse', x: 729, y: 455 }, state, env());
  const scroll = prepareAction({ action: 'scroll', scrollY: 471 }, state, env());
  assert.deepEqual(scroll.target, { x: 729, y: 455 }, 'scroll reuses the moveMouse position');
  assert.deepEqual(scroll.params, { scrollX: 0, scrollY: 471 });
  assert.deepEqual(prepareAction({ action: 'scroll', scrollY: 100 }, state, env()).target, { x: 729, y: 455 }, 'a second bare scroll stays there');
}
{
  const state = fresh();
  prepareAction({ action: 'click', x: 300, y: 310 }, state, env());
  assert.deepEqual(prepareAction({ action: 'scroll', scrollY: 5 }, state, env()).target, { x: 300, y: 310 }, 'scroll reuses a coordinate click');
}
{
  const state = fresh();
  prepareAction({ action: 'click', ref: '@e1' }, state, env());
  assert.deepEqual(prepareAction({ action: 'scroll', scrollY: 5 }, state, env()).target, { ref: 'w1' }, 'scroll reuses a ref click');
}
{
  // 自己带目标的 scroll 不看指针,并成为新的位置
  const state = fresh();
  prepareAction({ action: 'moveMouse', x: 1, y: 2 }, state, env());
  assert.deepEqual(prepareAction({ action: 'scroll', x: 50, y: 60, scrollY: 5 }, state, env()).target, { x: 50, y: 60 });
  assert.deepEqual(prepareAction({ action: 'scroll', ref: '@e2', scrollY: 5 }, state, env()).target, { ref: 'w2' });
  assert.deepEqual(prepareAction({ action: 'scroll', scrollY: 5 }, state, env()).target, { ref: 'w2' }, 'the last targeted scroll is the new position');
}
{
  // 按键、拖拽不算「指针落点」
  const state = fresh({ clicked: true });
  prepareAction({ action: 'keypress', keys: ['a'] }, state, env());
  prepareAction({ action: 'drag', path: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }, state, env());
  assert.equal(state.pointer, undefined, 'keypress / drag leave no pointer position');
}
{
  // 单独出现(含:上一批 moveMouse 过 —— 每批状态是新的)→ 报错并写明改法
  const alone = message(() => prepareAction({ action: 'scroll', scrollY: 471 }, fresh(), env()));
  assert.match(alone, /x and y/, 'scroll error names x and y');
  assert.match(alone, /moveMouse/, 'scroll error names moveMouse');
  assert.match(alone, /same act_ui call/, 'scroll error names the same-call rule');
}
{
  // 坐标推断不涉及焦点,严格后台同样适用
  const state = fresh();
  prepareAction({ action: 'moveMouse', x: 7, y: 8 }, state, env({ headless: true }));
  assert.deepEqual(prepareAction({ action: 'scroll', scrollY: 5 }, state, env({ headless: true })).target, { x: 7, y: 8 }, 'headless scroll reuses the position too');
}
// 其余动作的报错不变
assert.equal(message(() => prepareAction({ action: 'click' }, fresh(), env())), 'click requires either ref or both x and y.');
assert.equal(message(() => prepareAction({ action: 'moveMouse' }, fresh({ clicked: true, frontmost: true }), env())), 'moveMouse requires either ref or both x and y.');
console.log('✓ scroll:沿用本批 click / moveMouse 的位置、单独出现时的报错文案');

// ── 4) 判据 ──
assert.equal(followsFocus({ action: 'keypress', keys: ['UP'] }), true);
assert.equal(followsFocus({ action: 'typeText', text: 'x' }), true);
assert.equal(followsFocus({ action: 'keypress', keys: ['UP'], ref: '  ' }), true, 'a blank ref is no ref');
assert.equal(followsFocus({ action: 'keypress', keys: ['UP'], x: 1 }), true, 'half a point is no point');
assert.equal(followsFocus({ action: 'keypress', keys: ['UP'], ref: '@e1' }), false);
assert.equal(followsFocus({ action: 'keypress', keys: ['UP'], x: 1, y: 2 }), false);
assert.equal(followsFocus({ action: 'scroll', scrollY: 1 }), false);
assert.equal(followsFocus({ action: 'click', x: 1, y: 2 }), false);

// 只有「不带目标的按键出现在本批第一个 click / press 之前」才值得去问一次前台
const bare = { action: 'keypress', keys: ['UP'] };
assert.equal(needsFrontmostProbe([bare]), true);
assert.equal(needsFrontmostProbe([{ action: 'moveMouse', x: 1, y: 2 }, { action: 'scroll', scrollY: 3 }, bare]), true);
assert.equal(needsFrontmostProbe([{ action: 'click', x: 1, y: 2 }, bare]), false, 'the usual click-then-type batch needs no probe');
assert.equal(needsFrontmostProbe([{ action: 'press', ref: '@e1' }, bare]), false);
assert.equal(needsFrontmostProbe([bare, { action: 'click', x: 1, y: 2 }]), true);
assert.equal(needsFrontmostProbe([{ action: 'keypress', keys: ['UP'], x: 1, y: 2 }, { action: 'scroll', scrollY: 3 }]), false);
assert.equal(needsFrontmostProbe([]), false);

assert.equal(targetIsFrontmost({ pid: 9, windowId: 5 }, { pid: 9, windowId: 5 }), true);
assert.equal(targetIsFrontmost({ pid: 9, windowId: 5 }, { pid: 8, windowId: 5 }), false, 'another app is frontmost');
assert.equal(targetIsFrontmost({ pid: 9, windowId: 5 }, { pid: 9, windowId: 6 }), false, 'another window of the same app');
assert.equal(targetIsFrontmost({ pid: 9 }, { pid: 9, windowId: 5 }), false, 'same app but the window cannot be confirmed');
assert.equal(targetIsFrontmost({ pid: 9 }, { pid: 9, windowId: 0 }), false, 'nothing to compare is not a match');
assert.equal(targetIsFrontmost({ pid: 9, windowId: 0 }, { pid: 9, windowId: 0 }), false, 'two unknown window ids are not a match');
console.log('✓ followsFocus / needsFrontmostProbe / targetIsFrontmost 判据');
