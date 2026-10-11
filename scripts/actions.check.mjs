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
 *   5) 按坐标的 scroll / drag 与坐标点击一样是真实输入(needsForeground);按 ref 的 scroll、严格后台不变。
 *
 *   6) 插件设置(严格后台等)注入之后,vendor 再加载一次配置也得还在 —— 它每次工具调用都重新加载。
 *   7) Mos 对滚轮的改写(反向、按 speed 放大)怎么抵:读它的设置 → 发出去的量。
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

// 6) 设置要活过 vendor 的重新加载。syncSettings 以前只改内存里的配置对象,而每次工具调用的 ensureReady 都会
// loadComputerUseConfig(整个对象换新)—— 设置页里的「严格后台」因此从未生效,[foreground] 那行还在劝用户去开它。
{
  const dist = path.join(root, 'tangu-plugins/computer-use/dist');
  const outfile = path.join(dist, `.settings-check-${process.pid}.mjs`); // 得落在 dist 里,原因见 untargeted-input.check.mjs
  let settings;
  try {
    await build({
      stdin: { contents: "export { syncSettings } from './src/tools.ts'\nexport { getComputerUseConfig, loadComputerUseConfig } from './src/vendor/config.ts'", resolveDir: root, loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent', external: ['node:*'],
      alias: { '@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts') },
      banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
    });
    settings = await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(outfile, { force: true });
  }
  const store = (values) => ({ getScopeSettings: () => values });
  settings.syncSettings(store({ headless: true, cursor_overlay: false, browser_use: false, managed_browser: 'helium' }));
  settings.loadComputerUseConfig(os.tmpdir()); // 每次工具调用都会发生的那一下
  assert.deepEqual({ ...settings.getComputerUseConfig() }, { browser_use: false, headless: true, cursor_overlay: false, managed_browser: 'helium' }, '设置在 vendor 重新加载配置之后必须还在');
  settings.syncSettings(store({ headless: false }));
  settings.loadComputerUseConfig(os.tmpdir());
  assert.equal(settings.getComputerUseConfig().headless, false, '关掉严格后台也要跟得上');
  assert.equal(process.env.PI_COMPUTER_USE_CURSOR_OVERLAY, undefined, '这次没给的项:上次写的环境变量撤掉');
  assert.equal(settings.getComputerUseConfig().cursor_overlay, true, '撤掉之后回到缺省值');
  process.env.PI_COMPUTER_USE_BROWSER_USE = 'false'; // 不是 syncSettings 写的(用户自己设的)
  settings.syncSettings(store({}));
  assert.equal(process.env.PI_COMPUTER_USE_BROWSER_USE, 'false', '不是我们写的环境变量不碰');
  delete process.env.PI_COMPUTER_USE_BROWSER_USE;
  console.log('✓ 插件设置(严格后台等)活过 vendor 的配置重新加载');
}

// 7) src/wheel.ts:Mos 的设置 → 发给 helper 的滚动量。实测的那组设置(reverse=1 / smooth=1 / speed=3)下 -100 滚 +267。
{
  const outfile = path.join(os.tmpdir(), `cu-wheel-check-${process.pid}.mjs`);
  let wheel;
  try {
    await build({ entryPoints: [path.join(root, 'src/wheel.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
    wheel = await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(outfile, { force: true });
  }
  const { parseMos, wheelFixFor, applyWheelFix } = wheel;
  const prefs = (o) => `{\n${Object.entries(o).map(([k, v]) => `    ${k} = ${v};`).join('\n')}\n}`;
  const fixFor = (globals, apps = [], exe) => wheelFixFor(parseMos(prefs(globals), JSON.stringify(apps)), exe);
  const measured = fixFor({ duration: '"3.9"', precision: 1, reverse: 1, smooth: 1, speed: 3, step: 35, whitelist: 0 });
  assert.deepEqual(measured, { sign: -1, gain: 3 }, '反向 + 平滑、speed 3');
  assert.equal(applyWheelFix(300, measured), -100, '要往下 300 → 发 -100(Mos 翻回来再乘 3)');
  assert.equal(applyWheelFix(-150, measured), 50);
  assert.equal(applyWheelFix(1, measured), -1, '非零的量不会被除成零');
  assert.equal(applyWheelFix(0, measured), 0, '零还是零(垫的那一下不受影响)');
  assert.deepEqual(fixFor({ reverse: 1, smooth: 0, speed: 3 }), { sign: -1, gain: 1 }, '只开反向:只翻方向');
  assert.deepEqual(fixFor({ reverse: 0, smooth: 1, speed: '"2.5"' }), { sign: 1, gain: 2.5 }, '只开平滑:只缩量;带引号的小数也认');
  assert.deepEqual(fixFor({ reverse: 0, smooth: 0, speed: 3 }), { sign: 1, gain: 1 }, '都没开:不动');
  assert.deepEqual(wheelFixFor(parseMos('', 'not json')), { sign: 1, gain: 1 }, '读不出设置:不动');
  assert.equal(applyWheelFix(300, { sign: 1, gain: 1 }), 300);
  // 分应用:照 Mos 自己的规则。清单里勾了「继承」的用全局;没勾的用它自己的;白名单开着时清单外的 App 它不碰。
  const on = { reverse: 1, smooth: 1, speed: 3, whitelist: 0 };
  const app = (over) => ({ path: '/Applications/A.app/Contents/MacOS/A', inherit: true, scrollBasic: { smooth: false, reverse: false }, scrollAdvanced: { speed: 5 }, ...over });
  assert.deepEqual(fixFor(on, [app()], '/Applications/A.app/Contents/MacOS/A'), { sign: -1, gain: 3 }, '清单里勾了继承 → 全局设置');
  assert.deepEqual(fixFor(on, [app({ inherit: false })], '/Applications/A.app/Contents/MacOS/A'), { sign: 1, gain: 1 }, '没勾继承、自己两样都关 → 不动(Mos 不碰它,我们也别抵)');
  assert.deepEqual(fixFor(on, [app({ inherit: false, scrollBasic: { smooth: true, reverse: false } })], '/Applications/A.app/Contents/MacOS/A'), { sign: 1, gain: 5 }, '没勾继承 → 用它自己的 speed');
  assert.deepEqual(fixFor(on, [app({ inherit: false })], '/Applications/B.app/Contents/MacOS/B'), { sign: -1, gain: 3 }, '别的 App 不受这条例外影响');
  assert.deepEqual(fixFor({ ...on, whitelist: 1 }, [app()], '/Applications/B.app/Contents/MacOS/B'), { sign: 1, gain: 1 }, '白名单开着、不在清单里 → Mos 不碰,不抵');
  assert.deepEqual(fixFor({ ...on, whitelist: 1 }, [app()], '/Applications/A.app/Contents/MacOS/A'), { sign: -1, gain: 3 }, '白名单开着、在清单里 → 照常');
  console.log('✓ Mos 对滚轮的改写:按它的设置抵掉方向和放大');
}

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

// ── 5) 按坐标的 scroll / drag 是真实输入(走前台),按 ref 的仍走后台 ──
// 反馈 55b984eb:微信里按坐标滚动投给进程(pid)没人理,outcome 又是 unknown,所以也没有任何重试。
{
  const foreground = (action, e = env(), state = fresh()) => prepareAction(action, state, e).needsForeground;
  const dragPath = [{ x: 400, y: 150 }, { x: 400, y: 500 }];
  assert.equal(foreground({ action: 'scroll', x: 300, y: 200, scrollY: 600 }), true, 'a coordinate scroll is real input');
  assert.equal(foreground({ action: 'drag', path: dragPath }), true, 'a drag is real input');
  const state = fresh();
  prepareAction({ action: 'moveMouse', x: 5, y: 5 }, state, env());
  assert.equal(prepareAction({ action: 'scroll', scrollY: 3 }, state, env()).needsForeground, true, 'a scroll that reuses the pointer position is a coordinate scroll too');
  assert.equal(foreground({ action: 'scroll', ref: '@e2', scrollY: 3 }), false, 'a ref scroll keeps the background accessibility path');
  assert.equal(foreground({ action: 'moveMouse', x: 5, y: 5 }), false, 'moveMouse alone does not take the foreground');
  assert.equal(foreground({ action: 'scroll', x: 300, y: 200, scrollY: 600 }, env({ headless: true })), false, 'strict background never takes the foreground');
  assert.equal(foreground({ action: 'drag', path: dragPath }, env({ headless: true })), false, 'strict background never takes the foreground (drag)');
}
console.log('✓ 按坐标的 scroll / drag 走前台,按 ref 的 scroll 与严格后台不变');

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
