#!/usr/bin/env node
/**
 * 叠层在引擎半身里的那一截(helper 协议 20)的纯单测。免真机:esbuild 现编再 import,helper 的收发换成假的,
 * **绝不**连真 socket、不拉起 helper。
 *
 * 钉住的事:
 *   1) act / actBatch 每条(每一步)都带 clickAfterArrival;PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL=0 时是 false(负对照)。
 *   2) POST /overlay-style:合法的存进内存,之后每条动作带 overlayStyle / reduceMotion;不合法 400。
 *   3) POST /overlay-turn:转成 helper 的 overlayTurn;helper 没在跑 / 老 helper / 不是 macOS → { ok: false },不拉起 helper。
 *   4) 每条动作带这一轮的 runId(两个 run 并发也不串);这一轮中止时发一次带 runId 的 overlayTurn end,监听不越挂越多。
 *   5) 请求体 / 回包 / act 新字段 / overlayTurn 命令都对得上 scripts/fixtures/routes.v1.json。
 *
 * 用法: node scripts/overlay-routes.check.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-overlay-routes-check-'));
// helper 的 socket 指到一个不存在的临时路径(import 之前设):默认收发去连它只会失败,碰不到用户装着的 helper。
process.env.PI_CU_SOCKET_PATH = path.join(temp, 'no-helper.sock');
let mod;
try {
  const entry = path.join(temp, 'entry.ts');
  writeFileSync(entry, [
    `export * from ${JSON.stringify(path.join(root, 'src/overlayState.ts'))};`,
    `export * from ${JSON.stringify(path.join(root, 'src/overlayRoutes.ts'))};`,
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

const {
  clickAfterArrival, macosBackend, macosHelper, handleOverlayStyle, handleOverlayTurn, mountOverlayRoutes, registerOverlayRoutes,
  sendOverlayTurnEnd, resetOverlayStyle, setOverlayStyle, withOverlayRun, overlayActExtras, watchRunAbort, watchedRunCount,
} = mod;
const fixture = JSON.parse(readFileSync(path.join(root, 'scripts/fixtures/routes.v1.json'), 'utf8'));

// helper 的收发换成假的:记下发了什么,回一个像样的结果。真的 command() 会去连 / 拉起 helper。
const sent = [];
macosHelper.command = async (cmd, args) => { sent.push({ cmd, args }); return { outcome: 'worked', steps: [] }; };
let launched = 0;
macosHelper.launchDaemon = async () => { launched += 1; throw new Error('测试里不许拉起 helper'); };
macosHelper.ensureDaemon = async () => { launched += 1; return false; };

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

// 2) /overlay-style
resetOverlayStyle();
assert.deepEqual(Object.keys(overlayActExtras({})), ['clickAfterArrival'], '没交过配色:只带 clickAfterArrival,helper 用柔蓝');
for (const bad of [undefined, null, 'x', [], {}, { fill: 'orange' }, { fill: '#2c5f9' }, { fill: '#2c5f9e80' }, { fill: '#2c5f9e', edge: 'white' },
  { fill: '#2c5f9e', edge: 7 }, { fill: '#2c5f9e', reducedMotion: 'yes' }, { fill: 12 }]) {
  const reply = handleOverlayStyle(bad);
  assert.equal(reply.status, 400, `不合法的体要回 400:${JSON.stringify(bad)}`);
  assert.equal(reply.body.ok, false);
}
assert.deepEqual(Object.keys(overlayActExtras({})), ['clickAfterArrival'], '不合法的体不改缓存');
const styleReply = handleOverlayStyle(fixture.overlayStyle.body);
assert.equal(styleReply.status, 200);
assert.deepEqual(styleReply.body, fixture.overlayStyle.reply, '回包和样例一致');
assert.equal(fixture.overlayStyle.method, 'POST');
assert.equal(fixture.overlayStyle.path, '/overlay-style');
assert.deepEqual(withOverlayRun(fixture.helperActExtras.runId, () => overlayActExtras({})), fixture.helperActExtras, 'act 上的四个新字段和样例一致');
// 大写的十六进制收成小写;只给 fill 不带 edge(edge 由 helper 按亮度取);reducedMotion 没给就保留上一次的。
handleOverlayStyle({ fill: '#B36C46' });
assert.deepEqual(overlayActExtras({}), { overlayStyle: { fill: '#b36c46' }, reduceMotion: false, clickAfterArrival: true });
handleOverlayStyle({ fill: '#f8f7f6', edge: '#1C1B1F', reducedMotion: true });
assert.deepEqual(overlayActExtras({}).overlayStyle, { fill: '#f8f7f6', edge: '#1c1b1f' });
assert.equal(overlayActExtras({}).reduceMotion, true, 'reducedMotion → act 的 reduceMotion');

// 3) /overlay-turn
const turns = [];
const fakeSend = async (runId) => { turns.push(runId); return true; };
assert.equal(fixture.overlayTurn.path, '/overlay-turn');
const turnReply = await handleOverlayTurn(fixture.overlayTurn.body, fakeSend);
assert.equal(turnReply.status, 200);
assert.deepEqual(turnReply.body, fixture.overlayTurn.reply, '回包和样例一致');
assert.deepEqual(turns, [fixture.overlayTurn.body.runId], '带着 runId 转给 helper');
for (const bad of [undefined, null, {}, { phase: 'start' }, { phase: 'end', runId: 3 }, []]) {
  assert.equal((await handleOverlayTurn(bad, fakeSend)).status, 400, `不合法的体回 400:${JSON.stringify(bad)}`);
}
assert.deepEqual((await handleOverlayTurn({ phase: 'end' }, async () => false)).body, { ok: false }, 'helper 没在跑 → ok:false');
// helper 那头:发的就是样例里的 overlayTurn 命令;连不上 / 老 helper 回 unknown_command / 不是 macOS → false,不抛。
const wire = [];
assert.equal(await sendOverlayTurnEnd(fixture.helperOverlayTurn.runId, async (args) => { wire.push({ cmd: 'overlayTurn', ...args }); }, 'darwin'), true);
assert.deepEqual(wire, [fixture.helperOverlayTurn], 'overlayTurn 命令和样例一致');
assert.equal(await sendOverlayTurnEnd('r', async () => { throw Object.assign(new Error('Unknown command'), { code: 'unknown_command' }); }, 'darwin'), false, '老 helper(19)吞掉');
assert.equal(await sendOverlayTurnEnd('r', async () => { throw new Error('不该发'); }, 'win32'), false, '不是 macOS 不发');
// 默认收发:socket 不存在(= helper 没在跑)→ false,而且没去拉起 helper。
if (process.platform === 'darwin') {
  assert.equal(await sendOverlayTurnEnd('r'), false, 'helper 没在跑 → false');
  assert.deepEqual((await handleOverlayTurn({ phase: 'end', runId: 'r' })).body, { ok: false }, '路由缺省收发:helper 没在跑 → ok:false');
}
assert.equal(launched, 0, '/overlay-turn 不为这个去启动 helper');

// 路由怎么挂:有 registerScopedRoutes 才挂,挂两条 POST。
assert.equal(registerOverlayRoutes({}), false, '老引擎没有 registerScopedRoutes:不挂、不抛');
const routes = {};
const router = { post: (p, h) => { routes[p] = h; }, get() {}, put() {}, patch() {}, delete() {} };
assert.equal(registerOverlayRoutes({ registerScopedRoutes: (mount) => mount(router) }), true);
assert.deepEqual(Object.keys(routes).sort(), ['/overlay-style', '/overlay-turn']);
const call = async (route, body) => {
  let status = 200, json;
  await routes[route]({ body }, { status(s) { status = s; return this; }, json(b) { json = b; return this; } });
  return { status, json };
};
assert.deepEqual(await call('/overlay-style', fixture.overlayStyle.body), { status: 200, json: { ok: true } });
assert.deepEqual(await call('/overlay-style', { fill: 'red' }), { status: 400, json: { ok: false, error: 'invalid_overlay_style' } });
assert.equal((await call('/overlay-turn', { phase: 'nope' })).status, 400);
const viaDeps = {};
mountOverlayRoutes({ ...router, post: (p, h) => { viaDeps[p] = h; } }, { send: fakeSend });
let turnJson;
await viaDeps['/overlay-turn']({ body: { phase: 'end', runId: 'run_x' } }, { status() { return this; }, json(b) { turnJson = b; return this; } });
assert.deepEqual(turnJson, { ok: true });
assert.equal(turns.at(-1), 'run_x');

// 4) runId:每条动作带这一轮的;两个 run 并发不串;不在 run 里就不带。
sent.length = 0;
await Promise.all(['run_a', 'run_b'].map((runId, i) => withOverlayRun(runId, async () => {
  await new Promise((r) => setTimeout(r, 5 * (2 - i)));
  await macosBackend.act({ ...request, action: 'press' });
  await new Promise((r) => setTimeout(r, 5 * i));
  await macosBackend.actBatch([request, request]);
})));
const byRun = (id) => sent.filter((s) => s.cmd === 'act' ? s.args.runId === id : s.args.actions.every((a) => a.runId === id)).length;
assert.equal(byRun('run_a'), 2, 'run_a 的 act 和 actBatch 都带 run_a');
assert.equal(byRun('run_b'), 2, 'run_b 的 act 和 actBatch 都带 run_b');
await macosBackend.act(request);
assert.equal('runId' in sent.at(-1).args, false, '不在 run 里不带 runId');

// 调用方显式给的字段(act 顶层、actBatch 每一步)原样保留,extras 只补没给的;给成 undefined 算没给。
sent.length = 0;
setOverlayStyle({ fill: '#abcdef' }, true);
const explicit = { ...request, clickAfterArrival: false, runId: 'run_mine', overlayStyle: { fill: '#123456' }, reduceMotion: false };
await withOverlayRun('run_ctx', async () => {
  await macosBackend.act(explicit);
  await macosBackend.actBatch([explicit, { ...request, runId: 'run_step', clickAfterArrival: undefined }, request]);
});
const [explicitAct, explicitBatch] = sent;
assert.equal(explicitAct.args.clickAfterArrival, false, 'act:调用方给的 clickAfterArrival:false 不被改回 true');
assert.equal(explicitAct.args.runId, 'run_mine', 'act:调用方给的 runId 不被上下文覆盖');
assert.deepEqual(explicitAct.args.overlayStyle, { fill: '#123456' }, 'act:调用方给的 overlayStyle 不被缓存覆盖');
assert.equal(explicitAct.args.reduceMotion, false, 'act:调用方给的 reduceMotion 不被缓存覆盖');
const [s0, s1, s2] = explicitBatch.args.actions;
assert.deepEqual([s0.clickAfterArrival, s0.runId, s0.overlayStyle, s0.reduceMotion], [false, 'run_mine', { fill: '#123456' }, false], 'actBatch 第一步:显式字段原样');
assert.deepEqual([s1.runId, s1.clickAfterArrival, s1.overlayStyle, s1.reduceMotion], ['run_step', true, { fill: '#abcdef' }, true], 'actBatch 第二步:给了 runId 留着,给成 undefined 的照补');
assert.deepEqual([s2.runId, s2.clickAfterArrival, s2.overlayStyle, s2.reduceMotion], ['run_ctx', true, { fill: '#abcdef' }, true], 'actBatch 第三步:什么都没给就全补');
resetOverlayStyle();

// 中止:发一次带 runId 的 end;同一个 run 只挂一个监听;挂得再多也只留 16 个。
const ended = [];
const ac = new AbortController();
watchRunAbort('run_abort', ac.signal, (id) => ended.push(id), 'darwin');
watchRunAbort('run_abort', ac.signal, (id) => ended.push(id), 'darwin');
ac.abort();
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(ended, ['run_abort'], '中止时发一次 end,带 runId');
watchRunAbort('run_win', new AbortController().signal, () => { throw new Error('不是 macOS 不挂'); }, 'win32');
watchRunAbort(undefined, new AbortController().signal, () => { throw new Error('没有 runId 不发'); }, 'darwin');
const controllers = Array.from({ length: 24 }, () => new AbortController());
controllers.forEach((c, i) => watchRunAbort(`run_${i}`, c.signal, (id) => ended.push(id), 'darwin'));
assert.equal(watchedRunCount(), 16, '最多记 16 个 run');
controllers[0].abort();
await new Promise((r) => setTimeout(r, 0));
assert.equal(ended.includes('run_0'), false, '挤出去的 run 已摘掉监听');
controllers[23].abort();
await new Promise((r) => setTimeout(r, 0));
assert.equal(ended.at(-1), 'run_23');

// 工具返回时摘掉监听(不泄漏):摘掉以后再 abort 不发;只摘自己那只,同一 run 后来换上的不动。
for (const c of controllers) c.abort();
await new Promise((r) => setTimeout(r, 0));
assert.equal(watchedRunCount(), 0, '全 abort 完一个不剩');
const ret = new AbortController();
const unwatchRet = watchRunAbort('run_ret', ret.signal, (id) => ended.push(`ret:${id}`), 'darwin');
assert.equal(watchedRunCount(), 1);
unwatchRet();
assert.equal(watchedRunCount(), 0, '工具返回后监听被摘掉');
ret.abort();
await new Promise((r) => setTimeout(r, 0));
assert.equal(ended.includes('ret:run_ret'), false, '摘掉以后 abort 不发 end');
const first = new AbortController(), second = new AbortController();
const unwatchFirst = watchRunAbort('run_two', first.signal, (id) => ended.push(`two:${id}`), 'darwin');
watchRunAbort('run_two', second.signal, (id) => ended.push(`two:${id}`), 'darwin');
unwatchFirst();
assert.equal(watchedRunCount(), 1, '旧调用的 unwatch 不摘新调用的监听');
second.abort();
await new Promise((r) => setTimeout(r, 0));
assert.equal(ended.at(-1), 'two:run_two');
assert.equal(typeof watchRunAbort('run_win2', new AbortController().signal, () => undefined, 'win32'), 'function', '不挂的时候也回一个能调的 unwatch');

// 工具自己的超时也会 abort 这只 signal(引擎按 defaultTimeoutMs 给每次调用一个独立 signal),但这一轮并没结束:
// 显式 end 会让 helper 把这一轮之后的动作都当迟到的,所以超时那下不发。
let clock = 1_000;
const timed = new AbortController();
watchRunAbort('run_timeout', timed.signal, (id) => ended.push(`t:${id}`), 'darwin', { timeoutMs: 30_000, now: () => clock });
clock += 30_000;
timed.abort();
await new Promise((r) => setTimeout(r, 0));
assert.equal(ended.includes('t:run_timeout'), false, '工具超时触发的 abort 不发 end');
const early = new AbortController();
watchRunAbort('run_early', early.signal, (id) => ended.push(`t:${id}`), 'darwin', { timeoutMs: 30_000, now: () => clock });
clock += 5_000;
early.abort();
await new Promise((r) => setTimeout(r, 0));
assert.equal(ended.at(-1), 't:run_early', '超时之前的 abort(用户中止)照发');

// tools.ts 的接线:监听带上这个工具的 timeoutMs、返回时摘掉(上面的行为测的是 watchRunAbort 本身,这里钉住调用点)。
const toolsSource = readFileSync(path.join(root, 'src/tools.ts'), 'utf8');
assert.match(toolsSource, /const unwatch = watchRunAbort\(tcx\.runId, tcx\.signal, undefined, undefined, \{ timeoutMs: spec\.timeoutMs \}\);/, 'tools.ts 挂监听时要带 spec.timeoutMs(工具超时不发 end)');
assert.match(toolsSource, /finally \{ unwatch\(\); \}/, 'tools.ts 返回时要摘掉监听');

console.log('overlay routes check passed');
