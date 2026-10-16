import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'tangu-plugins/computer-use/dist/jev-check.mjs');
await build({ stdin: { contents: 'export * from "./src/jev.ts"; export * from "./src/jevRun.ts"; export {render} from "./src/tools.ts";', resolveDir: root }, outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', alias: { '@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts') }, banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' } });
const j = await import(pathToFileURL(outfile));
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const node = (ref, title, extra = {}) => ({ ref, title, description: '', role: 'button', canPress: true, children: [], ...extra });
const tree = node('@e0', 'Fixture', { canPress: false, children: [node('@e1', 'Next'), node('@e2', 'Name', { canPress: false, canSetValue: true, isTextInput: true })] });
const choice = (ref = '@e1', confidence = 0.99) => ({ model: j.JEV_MODEL, answers: { target: { type: 'choice', choice: ref, confidence } }, usage: { input_tokens: 100 } });
const box = (visible = .99, confidence = .99) => ({ model: j.JEV_MODEL, answers: { visible: { type: 'noul', noul: visible }, target: { type: 'box', confidence, box: { left: .1, right: .3, top: .2, bottom: .4 } } } });
const step = { action: 'click', target: 'Next' };
const image = { data: 'unused', width: 1000, height: 500, sourceWidth: 2000, sourceHeight: 1000, contentWidth: 1000, contentHeight: 500, left: 0, top: 0 };
const ctx = { cwd: root, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
const originals = { ...j.jevRuntime };
let calls, settings, observed;
function reset() {
  calls = []; observed = 0; settings = { jev_enabled: true };
  Object.assign(j.jevRuntime, originals, {
    connection: () => ({ apiUrl: j.JEV_API_URL, key: 'test-key' }), prepare: async (i) => ({ ...image, ...i, sourceWidth: i.width, sourceHeight: i.height, contentWidth: i.width, contentHeight: i.height }),
    observe: async (_r, visual) => { calls.push(`observe:${visual}`); observed++; return { content: visual ? [{ type: 'image', data: 'unused' }] : [], details: { capture: { stateId: `s${observed}`, timestamp: Date.now(), width: 1000, height: 500 }, target: { pid: 1, windowId: 2 }, outline: { root: tree } } }; },
    request: async (_k, b) => { calls.push(b.assets ? 'box' : 'choice'); return b.assets ? box() : choice(); },
    act: async (stateId, actions) => { calls.push({ stateId, actions }); return { content: [], details: { capture: { stateId: `after-${stateId}` }, execution: { outcome: 'worked' } } }; },
  });
}
const run = (args = {}, signal) => j.runJev({ root: '@r1', steps: [step], ...args }, () => settings, () => true, ctx, signal);
try {
  await test('bounded arguments and preview cannot simulate later UI states', () => {
    for (const args of [{}, { root: 'front', steps: [step] }, { root: '@r1', steps: Array(9).fill(step) }, { root: '@r1', steps: [{ action: 'fill', target: 'Name' }] }, { root: '@r1', steps: [step, step], preview: true }]) assert.throws(() => j.parseJevArgs(args));
  });
  await test('candidate membership, missing/ambiguous outcomes and confidence', () => {
    const r = j.elementRequest(tree, step);
    assert.deepEqual(r.nodes.map(n => n.ref), ['@e1']);
    for (const ref of ['@e99', 'not_found', 'ambiguous']) assert.throws(() => j.elementSelection(choice(ref), r.nodes, .85));
    assert.throws(() => j.elementSelection(choice('@e1', .4), r.nodes, .85), /confidence=0.4.*minimum 0.85/);
    // Element choice has no calibration data: a low knob does not lower it below CHOICE_FLOOR.
    assert.throws(() => j.elementSelection(choice('@e1', .7), r.nodes, .6), /confidence=0.7.*minimum 0.75/);
    assert.equal(j.elementSelection(choice(), r.nodes, .85).ref, '@e1');
    assert(!JSON.stringify(j.elementRequest(tree, { action: 'fill', target: 'Name', text: 'private-content' }).body).includes('private-content'));
    assert.throws(() => j.elementRequest(node('@e0', '', { children: Array.from({ length: 254 }, (_, i) => node(`@e${i+1}`, 'button')) }), step));
    const focusOnly = node('@e3', 'Field', { canPress: false, canFocus: true, isTextInput: true });
    assert.equal(j.candidates(focusOnly, step).length, 0);
    assert.equal(j.candidates(focusOnly, { action: 'fill', target: 'Field', text: 'text' }).length, 0);
    assert.equal(j.candidates(node('@e8', 'web', { role: 'AXWebArea', canPress: false, children: [tree.children[1]] }), { action: 'fill', target: 'Name' }).length, 0);
    assert.equal(j.candidates({ ...focusOnly, canPress: true }, step).length, 0);
  });
  await test('box presence, finite geometry and original screenshot coordinates', () => {
    const point = j.visionSelection(box(), image, .85).point;
    assert(Math.abs(point.x - 400) < .001 && Math.abs(point.y - 300) < .001);
    assert.throws(() => j.visionSelection(box(.1), image, .85), /visibility=0.1 \(minimum 0.85\), box confidence=0.99 \(minimum 0.5\)/);
    // 10-16 calibration: box confidence is box fit, not identity. Right targets came back as low as 0.57;
    // a greyed-out button got 0.91 with visibility 0.01. Visibility decides; the box only has a sanity floor.
    assert.equal(j.visionSelection(box(.9, .57), image, j.DEFAULT_THRESHOLD).confidence, .57);
    assert.throws(() => j.visionSelection(box(.01, .91), image, j.DEFAULT_THRESHOLD), /visibility=0.01/);
    assert.equal(j.DEFAULT_THRESHOLD, .55);
    // Visibility follows the configured threshold; it used to be floored at 0.9 whatever the setting said.
    assert.equal(j.visionSelection(box(.8, .8), image, .75).visibility, .8);
    assert.throws(() => j.visionSelection(box(.7, .99), image, .75), /visibility=0.7/);
    assert.deepEqual(j.visionSelection(box(), image, .85).box, { left: .1, right: .3, top: .2, bottom: .4 });
    assert.throws(() => j.visionSelection(box(.99, .3), image, .85));
    const malformed = box(); malformed.answers.target.box.left = NaN;
    assert.throws(() => j.visionSelection(malformed, image, .85));
    assert.throws(() => j.visionSelection(box(), { ...image, left: 500 }, .85));
    const body = j.visionRequest(image, step);
    assert.equal(Object.keys(body.assets).length, 1);
    assert.equal(body.questions.visible.type, 'noul');
  });
  await test('fill is semantic only; never emits focus-following replacement keys', async () => {
    const fill = { action: 'fill', target: 'Name', text: 'Jane' };
    assert.deepEqual(j.selectedActions(fill, { ref: '@e2' }, tree.children), [{ action: 'setText', ref: '@e2', text: 'Jane' }]);
    assert.throws(() => j.selectedActions(fill, { point: { x: 10, y: 20 } }, []), /native editable/);
    reset(); let r = await run({ steps: [fill], mode: 'vision' }); assert.equal(r.report.attemptedSteps, 0); assert.deepEqual(calls, []);
    reset(); j.jevRuntime.request = async () => choice('not_found'); r = await run({ steps: [fill] }); assert.equal(r.report.attemptedSteps, 0); assert(!calls.includes('box'));
  });
  await test('two-step loop gets a fresh state each time', async () => {
    reset(); const r = await run({ steps: [step, step], mode: 'elements' });
    assert.equal(r.report.status, 'completed'); assert.equal(r.report.confirmedSteps, 2);
    assert.deepEqual(calls.filter(x => typeof x === 'object').map(x => x.stateId), ['s1', 's2']);
    assert.equal(r.report.steps.length, 2);
  });
  await test('preview never inputs; elements mode never uploads screenshots', async () => {
    reset(); assert.equal((await run({ preview: true, mode: 'elements' })).report.status, 'preview');
    assert.deepEqual(calls, ['observe:false', 'choice']);
  });
  await test('auto can recover via a new visual observation', async () => {
    reset(); j.jevRuntime.request = async (_k, b) => b.assets ? box() : choice('not_found');
    const r = await run(); assert.equal(r.report.status, 'completed');
    assert.equal(r.report.steps[0].fallback, 'elements_to_vision');
    assert.equal(calls.at(-1).stateId, 's2');
  });
  await test('missing visual target and ambiguous elements never click', async () => {
    reset(); j.jevRuntime.request = async () => box(.1);
    assert.equal((await run({ mode: 'vision' })).report.attemptedSteps, 0);
    reset(); j.jevRuntime.request = async () => choice('ambiguous');
    assert.equal((await run({ mode: 'elements' })).report.attemptedSteps, 0);
  });
  await test('API failures do not trigger extra retries or fallback requests', async () => {
    reset(); j.jevRuntime.request = async () => { calls.push('failed'); throw new Error('Jev HTTP 429'); };
    assert.equal((await run()).report.status, 'stopped'); assert.deepEqual(calls, ['observe:false', 'failed']);
  });
  await test('cancel/disable while Jev is responding prevents the action', async () => {
    reset(); const ac = new AbortController();
    j.jevRuntime.request = async () => { ac.abort(); return choice(); };
    assert.equal((await run({}, ac.signal)).report.attemptedSteps, 0);
    reset(); j.jevRuntime.request = async () => { settings.jev_enabled = false; return choice(); };
    assert.equal((await run()).report.attemptedSteps, 0);
    reset(); j.jevRuntime.request = async () => { j.stopJevRuns(); return choice(); };
    assert.equal((await run()).report.status, 'cancelled');
  });
  await test('uncertain action stops the remaining sequence and preserves progress', async () => {
    reset(); let n = 0;
    j.jevRuntime.act = async () => ({ content: [], details: { capture: { stateId: 'after' }, execution: { outcome: ++n === 1 ? 'worked' : 'unknown' } } });
    const r = await run({ steps: [step, step, step] });
    assert.equal(n, 2); assert.equal(r.report.confirmedSteps, 1); assert.equal(r.report.attemptedSteps, 2);
    assert.equal(r.report.steps[1].status, 'uncertain');
  });
  await test('native result contract, foreground delivery and interrupted input', async () => {
    reset();
    j.jevRuntime.act = async () => ({ content: [], details: { capture: { stateId: 'after' }, execution: { outcome: 'worked', steps: [{ delivery: 'hid', deliveryPolicy: 'foreground' }] } } });
    let r = await run(); assert.equal(r.report.confirmedSteps, 1); assert.equal(r.report.foregroundTaken, true);
    reset(); j.jevRuntime.act = async () => ({ content: [], details: { status: 'target_closed', execution: { outcome: 'worked' } } });
    r = await run({steps: [step, step]});
    assert.equal(r.report.confirmedSteps, 1); assert.equal(r.report.attemptedSteps, 1);
    assert.equal(r.report.status, 'stopped'); assert.equal(r.report.steps[0].status, 'confirmed');
    reset(); const ac = new AbortController();
    j.jevRuntime.act = async () => { ac.abort(); throw new Error('native input interrupted'); };
    r = await run({}, ac.signal); assert.equal(r.report.attemptedSteps, 1); assert.equal(r.last, undefined); assert.equal(r.report.foregroundTaken, null);
  });
  await test('feedback regression: unknown is not zero inputs or a Jev-only background restriction', async () => {
    reset();
    const after = { content: [{type: 'text', text: 'Attempted 1 UI action. Returned state after.'}], details: {
      capture: {stateId: 'after'}, config: {headless: true, jev_api_key: 'must-not-leak'},
      execution: {outcome: 'unknown', steps: [{outcome: 'unknown', delivery: 'pid', deliveryPolicy: 'ax_only', performed: {grounding: 'coordinates', verification: 'caller_required', text: 'private-value'}}]},
    }};
    j.jevRuntime.act = async () => after;
    const r = await run({steps: [step, step], mode: 'vision'});
    assert.equal(r.report.confirmedSteps, 0); assert.equal(r.report.attemptedSteps, 1); assert.equal(r.report.unattemptedSteps, 1);
    assert.equal(r.report.executor, 'act_ui'); assert.equal(r.report.steps[0].execution.strictBackground, true);
    assert.equal(r.report.steps[0].execution.steps[0].delivery, 'pid');
    const text = JSON.stringify(r.report) + j.render(after, {});
    for (const fact of ['not failed', 'SAME executor', 'Strict background is ON', 'Do not bypass', 'Preview only locates']) assert(text.includes(fact), fact);
    assert(!text.includes('must-not-leak')); assert(!text.includes('private-value'));
    assert.equal(calls.filter(c => c === 'box').length, 1);
  });
  await test('native failure is distinct from uncertainty and preserves the reason', async () => {
    reset(); j.jevRuntime.act = async () => ({content: [], details: {capture: {stateId: 'after'}, execution: {outcome: 'didnt', error: {code: 'foreground_required', message: 'Input requires foreground'}}}});
    const r = await run({steps: [step, step]});
    assert.equal(r.report.steps[0].status, 'failed');
    assert.equal(r.report.steps[0].execution.error.code, 'foreground_required');
    assert.match(j.render(r.last, {}), /executor reported a failure/);
    assert.equal(r.report.attemptedSteps, 1);
  });
  await test('old captures and changed windows fail closed', async () => {
    reset(); const observe = j.jevRuntime.observe;
    j.jevRuntime.observe = async (...args) => { const r = await observe(...args); r.details.capture.timestamp -= 6000; return r; };
    assert.equal((await run()).report.attemptedSteps, 0);
    reset(); const observe2 = j.jevRuntime.observe;
    j.jevRuntime.observe = async (...args) => { const r = await observe2(...args); if (observed > 1) r.details.target.pid = 9; return r; };
    assert.equal((await run({ steps: [step, step] })).report.confirmedSteps, 1);
  });
  await test('HTTP adapter uses the configured endpoint, pins model and redacts upstream errors', async () => {
    const fetch = globalThis.fetch;
    const connection = j.readJevConnection({ jev_api_key: 'test-key', jev_api_url: 'https://custom.example/v1/systemone' });
    try {
      globalThis.fetch = async (url, opts) => { assert.equal(url, connection.apiUrl); assert.equal(opts.headers.Authorization, 'Bearer test-key'); assert.equal(opts.redirect, 'error'); assert.equal(JSON.parse(opts.body).model, j.JEV_MODEL); assert.equal(opts.headers['TypeSafe-Danger-Zone-Images'], 'true'); return new Response(JSON.stringify(box())); };
      await j.requestJev(connection, j.visionRequest(image, step));
      globalThis.fetch = async () => new Response('test-key secret raw error', { status: 401 });
      await assert.rejects(j.requestJev(connection, {}), e => /401/.test(e.message) && !e.message.includes('test-key'));
      globalThis.fetch = async () => new Response('invalid');
      await assert.rejects(j.requestJev(connection, {}), /invalid JSON/);
    } finally { globalThis.fetch = fetch; }
  });
  await test('manual settings validate API URL and key without echoing secrets', () => {
    assert.deepEqual(j.readJevConnection({ jev_api_key: ' test-key ' }), { apiUrl: j.JEV_API_URL, key: 'test-key' });
    assert.equal(j.readJevConnection({ jev_api_key: 'k', jev_api_url: 'https://api.typesafe.ai/v1/' }).apiUrl, j.JEV_API_URL);
    assert.equal(j.readJevConnection({ jev_api_key: 'k', jev_api_url: 'https://api.typesafe.ai' }).apiUrl, j.JEV_API_URL);
    assert.equal(j.readJevConnection({ jev_api_key: 'k', jev_api_url: 'http://127.0.0.1:1234/v1' }).apiUrl, 'http://127.0.0.1:1234/v1/systemone');
    for (const url of ['ftp://example.com', 'http://example.com', 'https://secret@example.com', 'https://example.com/?key=secret', 'bad-secret']) assert.throws(() => j.readJevConnection({ jev_api_key: 'k', jev_api_url: url }), e => !e.message.includes('secret'));
    for (const key of ['', 'bad secret', 'k'.repeat(4097)]) assert.throws(() => j.readJevConnection({ jev_api_key: key }));
  });
  if (process.platform === 'darwin') await test('real sips resize/padding maps back to original screenshot', async () => {
    // Valid deterministic PNG; no image-generation service or external fixtures needed.
    const crc = b => { let c = 0xffffffff; for (const v of b) { c ^= v; for (let k=0;k<8;k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; };
    const chunk = (kind, b) => { const name = Buffer.from(kind), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(b.length); sum.writeUInt32BE(crc(Buffer.concat([name,b]))); return Buffer.concat([len,name,b,sum]); };
    const png = (w,h) => { const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=2; return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.alloc((w*3+1)*h,0))),chunk('IEND',Buffer.alloc(0))]).toString('base64'); };
    for (const [width,height] of [[1600,900],[300,100]]) {
      const p = await originals.prepare({ width,height,data:png(width,height),mimeType:'image/png' });
      assert(p.width <= 1568 && p.height <= 1568 && p.width*p.height >= 78400);
      const r=box();r.answers.target.box={left:p.left/p.width,right:(p.left+p.contentWidth)/p.width,top:p.top/p.height,bottom:(p.top+p.contentHeight)/p.height};
      const point=j.visionSelection(r,p,.85).point;
      assert(Math.abs(point.x-width/2)<.001 && Math.abs(point.y-height/2)<.001);
    }
  });

  // ── 10-16: you plan, Jev clicks and checks (feedback 0c0cd24f: canvas apps stopped after every step) ──
  const verdict = (noul) => ({ model: j.JEV_MODEL, answers: { done: { type: 'noul', noul } }, usage: { input_tokens: 50 } });
  const unknownAct = async (stateId, actions) => { calls.push({ stateId, actions }); return { content: [], details: { capture: { stateId: `after-${stateId}` }, execution: { outcome: 'unknown' } } }; };
  j.jevTiming.verifyWindowMs = 300; j.jevTiming.pollMs = 50;
  await test('double_click is a two-count physical click and needs a screenshot', async () => {
    assert.deepEqual(j.parseJevArgs({ root: '@r1', steps: [{ action: 'double_click', target: 'Row 3', expect: 'Row 3 is playing' }] }).steps[0], { action: 'double_click', target: 'Row 3', expect: 'Row 3 is playing' });
    assert.deepEqual(j.selectedActions({ action: 'double_click', target: 'Row' }, { point: { x: 5, y: 6 } }, []), [{ action: 'click', clickCount: 2, x: 5, y: 6 }]);
    assert.throws(() => j.parseJevArgs({ root: '@r1', steps: [{ action: 'triple_click', target: 'x' }] }));
    assert.throws(() => j.parseJevArgs({ root: '@r1', steps: [{ action: 'click', target: 'x', expect: '' }] }));
    reset(); let r = await run({ steps: [{ action: 'double_click', target: 'Row 3' }], mode: 'elements' });
    assert.equal(r.report.attemptedSteps, 0); assert.match(r.report.error, /double_click needs Auto or Vision/);
    reset(); r = await run({ steps: [{ action: 'double_click', target: 'Row 3' }] });
    assert.deepEqual(calls.slice(0, 2), ['observe:true', 'box'], 'auto mode goes straight to vision for double_click');
    const [a] = calls[2].actions; assert.deepEqual([a.action, a.clickCount, Math.round(a.x), Math.round(a.y)], ['click', 2, 200, 150]);
  });
  await test('expect lets a canvas sequence continue: Jev confirms each step on a fresh screenshot', async () => {
    reset(); j.jevRuntime.act = unknownAct;
    j.jevRuntime.request = async (_k, b) => { calls.push(b.questions.done ? `verify:${Object.keys(b.assets).length}` : b.assets ? 'box' : 'choice'); return b.questions.done ? verdict(.97) : box(); };
    const r = await run({ mode: 'vision', steps: [{ ...step, expect: 'The list page is shown' }, { action: 'double_click', target: 'Row 3', expect: 'Row 3 is playing' }] });
    assert.equal(r.report.status, 'completed', JSON.stringify(r.report)); assert.equal(r.report.confirmedSteps, 2); assert.equal(r.report.attemptedSteps, 2);
    assert.deepEqual(r.report.steps.map(s => s.confirmedBy), ['visual', 'visual']);
    assert.equal(r.report.steps[0].verify.met, true); assert.equal(r.report.steps[0].verify.attempts, 1);
    // before (locate shot) + after frame; step 2 locates on the check's observation instead of observing again.
    assert.deepEqual(calls.filter(c => typeof c === 'string'), ['observe:true', 'box', 'observe:true', 'verify:2', 'box', 'observe:true', 'verify:2']);
    assert.equal(r.report.steps[1].observation, 'reused_from_previous_check');
    assert.deepEqual(r.report.steps[0].capture, { width: 1000, height: 500 });
    assert.deepEqual(r.report.steps[0].pointFraction, { x: .2, y: .3 });
  });
  await test('expect waits for a slow page, then stops with the screenshot when it never appears', async () => {
    reset(); j.jevRuntime.act = unknownAct; let n = 0;
    j.jevRuntime.request = async (_k, b) => b.questions.done ? verdict(++n < 3 ? .1 : .9) : box();
    let r = await run({ mode: 'vision', steps: [{ ...step, expect: 'Loaded' }] });
    assert.equal(r.report.status, 'completed'); assert.equal(r.report.steps[0].verify.attempts, 3);
    reset(); j.jevRuntime.act = unknownAct;
    j.jevRuntime.request = async (_k, b) => b.questions.done ? verdict(.2) : box();
    r = await run({ mode: 'vision', steps: [{ ...step, expect: 'Loaded' }, step] });
    assert.equal(r.report.status, 'stopped'); assert.equal(r.report.confirmedSteps, 0); assert.equal(r.report.attemptedSteps, 1);
    assert.equal(r.report.steps[0].status, 'unverified'); assert.equal(r.report.steps[0].verify.met, false);
    assert(r.report.steps[0].verify.attempts > 1); assert.match(r.report.error, /expect did not appear/);
    assert(r.last.content.some(c => c.type === 'image'), 'the latest screenshot goes back to the main model');
  });
  await test('a low knob never lowers the expect check below VERIFY_FLOOR', async () => {
    reset(); settings.jev_threshold = .6; j.jevRuntime.act = unknownAct;
    j.jevRuntime.request = async (_k, b) => b.questions.done ? verdict(.7) : box(.9, .6);
    const r = await run({ mode: 'vision', steps: [{ ...step, expect: 'Chat with Sakura is open' }, step] });
    assert.equal(r.report.threshold, .6); assert.equal(r.report.verifyThreshold, j.VERIFY_FLOOR);
    assert.equal(r.report.steps[0].status, 'unverified'); assert.equal(r.report.attemptedSteps, 1, 'the next step is not attempted on an unconfirmed screen');
    assert.match(r.report.error, /visual check 0.70, minimum 0.8/);
  });
  await test('a failed expect check after the input says the input was sent', async () => {
    reset(); j.jevRuntime.act = unknownAct;
    j.jevRuntime.request = async (_k, b) => { if (b.questions.done) throw new Error('Jev HTTP 429: rate limit reached. No action was taken for this step.'); return box(); };
    const r = await run({ mode: 'vision', steps: [{ ...step, expect: 'Message sent' }, step] });
    assert.equal(r.report.attemptedSteps, 1); assert.equal(r.report.steps[0].status, 'unverified');
    assert.match(r.report.error, /input WAS sent.*429.*1 later step\(s\) were NOT attempted/); assert.doesNotMatch(r.report.error, /No action was taken/i);
  });
  await test('expect is never checked with screenshots in Elements mode', async () => {
    reset(); j.jevRuntime.act = unknownAct;
    const r = await run({ mode: 'elements', steps: [{ ...step, expect: 'Next page' }] });
    assert.equal(r.report.steps[0].status, 'uncertain'); assert.match(r.report.error, /Elements mode never takes screenshots/);
    assert(!calls.includes('observe:true')); assert(!calls.includes('box'));
  });
  await test('natively confirmed steps without expect still continue; the run limit grows with steps', async () => {
    reset(); const r = await run({ mode: 'elements', steps: [step, step, step] });
    assert.deepEqual(r.report.steps.map(s => s.confirmedBy), ['native', 'native', 'native']);
    assert.equal(j.runLimitMs(1), 40_000); assert.equal(j.runLimitMs(8), 170_000);
    const v = j.verifyRequest(image, { ...step, expect: 'Done' });
    assert.equal(Object.keys(v.assets).length, 1); assert.equal(v.questions.done.type, 'noul'); assert.equal(v.state.expected, 'Done');
    assert.throws(() => j.verifyAnswer({ answers: { done: { type: 'noul', noul: 2 } } }));
  });

  // ── 10-16 feedback d995c9a2: Jev also scrolls, types and presses keys, so act_ui is left with drag only ──
  const tall = (visible = .99) => ({ model: j.JEV_MODEL, answers: { visible: { type: 'noul', noul: visible }, target: { type: 'box', confidence: .9, box: { left: .1, right: .3, top: .1, bottom: .9 } } }, usage: { input_tokens: 80 } });
  /** Frames differ per observation unless `same` says otherwise; until shows up at look number `seenAt` (0 = before any scroll). */
  const scrolling = ({ seenAt = Infinity, same = () => false, act } = {}) => {
    let looks = 0, data = '';
    j.jevRuntime.observe = async (_r, visual) => {
      observed++; calls.push(`observe:${visual}`);
      if (!same(observed)) data = `frame${observed}`;
      return { content: [{ type: 'image', data }], details: { capture: { stateId: `s${observed}`, timestamp: Date.now(), width: 1000, height: 500 }, target: { pid: 1, windowId: 2 }, outline: { root: tree } } };
    };
    j.jevRuntime.request = async (_k, b) => {
      if (b.questions.done) { calls.push(`look:${Object.keys(b.assets).length}`); return verdict(looks++ >= seenAt ? .95 : .1); }
      calls.push('box'); return tall();
    };
    j.jevRuntime.act = act ?? unknownAct;
  };
  const scrollStep = { action: 'scroll', target: 'the song list', until: 'the row titled Blue Skies' };
  const acts = () => calls.filter(c => typeof c === 'object');
  await test('new step types: arguments are validated before anything runs', () => {
    for (const bad of [
      { action: 'scroll', target: 'list' }, { ...scrollStep, expect: 'Blue Skies is shown' }, { ...scrollStep, direction: 'left' },
      { action: 'scroll', until: 'x' }, { action: 'type' }, { action: 'type', text: '' }, { action: 'type', target: '', text: 'hi' },
      { action: 'key' }, { action: 'key', keys: [] }, { action: 'key', keys: Array(17).fill('a') }, { action: 'key', keys: [1] }, { action: 'click' },
    ]) assert.throws(() => j.parseJevArgs({ root: '@r1', steps: [bad] }), undefined, JSON.stringify(bad));
    assert.throws(() => j.parseJevArgs({ root: '@r1', steps: [{ action: 'key', keys: ['return'] }], preview: true }), /Preview locates a target/);
    assert.deepEqual(j.parseJevArgs({ root: '@r1', steps: [scrollStep] }).steps[0], { ...scrollStep, direction: 'down' });
    assert.deepEqual(j.parseJevArgs({ root: '@r1', steps: [{ action: 'type', text: 'hi', keys: ['x'], until: 'y' }] }).steps[0], { action: 'type', text: 'hi' });
    assert.deepEqual(j.parseJevArgs({ root: '@r1', steps: [{ action: 'key', target: ' Search ', keys: ['cmd', 'a'], text: 'dropped' }] }).steps[0], { action: 'key', target: 'Search', keys: ['cmd', 'a'] });
  });
  await test('type and key: one input call, a click first only when there is a target', async () => {
    assert.deepEqual(j.selectedActions({ action: 'type', target: 'Message', text: 'hi' }, { point: { x: 5, y: 6 } }, []), [{ action: 'click', x: 5, y: 6 }, { action: 'typeText', text: 'hi' }]);
    assert.deepEqual(j.selectedActions({ action: 'key', keys: ['return'] }, undefined, []), [{ action: 'keypress', keys: ['return'] }]);
    reset(); j.jevRuntime.act = unknownAct;
    j.jevRuntime.request = async (_k, b) => { calls.push(b.questions.done ? `verify:${Object.keys(b.assets).length}` : 'box'); return b.questions.done ? verdict(.97) : box(); };
    const r = await run({ steps: [{ action: 'type', target: 'the message field', text: 'private-text', expect: 'the field shows the message' }, { action: 'key', keys: ['return'], expect: 'the message is in the chat' }] });
    assert.equal(r.report.status, 'completed', JSON.stringify(r.report)); assert.equal(r.report.confirmedSteps, 2);
    assert.deepEqual(acts().map(c => c.actions.map(a => a.action)), [['click', 'typeText'], ['keypress']]);
    assert.deepEqual(acts()[1].actions[0].keys, ['return']);
    // The key step has no target: no locate request, the check still compares with a before frame.
    assert.deepEqual(calls.filter(c => typeof c === 'string'), ['observe:true', 'box', 'observe:true', 'verify:2', 'observe:true', 'verify:2']);
    assert(!JSON.stringify(r.report).includes('private-text'), 'typed text never lands in the report');
    const v = j.verifyRequest(image, { action: 'type', target: 'Message', text: 'private-text', expect: 'sent' });
    assert(!JSON.stringify(v.state).includes('private-text')); assert.equal(j.verifyRequest(image, { action: 'key', keys: ['cmd', 'a'], expect: 'x' }).state.action, 'key ["cmd","a"]');
  });
  await test('scroll, type and key need screenshots: Elements mode refuses them before any request', async () => {
    for (const s of [scrollStep, { action: 'type', text: 'hi' }, { action: 'key', keys: ['return'] }]) {
      reset(); const r = await run({ mode: 'elements', steps: [s] });
      assert.equal(r.report.attemptedSteps, 0); assert.match(r.report.error, new RegExp(`${s.action} needs Auto or Vision`)); assert.deepEqual(calls, []);
    }
  });
  await test('scroll: until already in view sends no input', async () => {
    reset(); scrolling({ seenAt: 0 });
    const r = await run({ steps: [scrollStep] });
    assert.equal(r.report.status, 'completed', JSON.stringify(r.report)); assert.equal(acts().length, 0);
    assert.deepEqual([r.report.steps[0].scrolls, r.report.steps[0].stopReason, r.report.confirmedSteps, r.report.attemptedSteps], [0, 'until_seen', 1, 1]);
    const locate = j.visionRequest(image, scrollStep);
    assert.match(locate.questions.target.instructions, /scrollable list or panel/);
  });
  await test('scroll: half the list per wheel at its centre, until checked on every new frame', async () => {
    reset(); scrolling({ seenAt: 3 });
    let r = await run({ steps: [scrollStep, { action: 'double_click', target: 'the row titled Blue Skies', expect: 'Blue Skies is playing' }] });
    assert.equal(r.report.status, 'completed', JSON.stringify(r.report));
    const wheel = acts().filter(c => c.actions[0].action === 'scroll').map(c => c.actions[0]);
    assert.equal(wheel.length, 3); assert.deepEqual(wheel[0], { action: 'scroll', x: 200, y: 250, scrollY: 200 });
    assert.deepEqual(acts().slice(0, 3).map(c => c.stateId), ['s1', 's2', 's3'], 'each scroll goes out on the latest observation');
    assert.deepEqual([r.report.steps[0].scrolls, r.report.steps[0].stopReason, r.report.steps[0].confirmedBy], [3, 'until_seen', 'visual']);
    assert.deepEqual(calls.filter(c => typeof c === 'string' && c.startsWith('look')), ['look:1', 'look:2', 'look:2', 'look:2', 'look:2'], 'later frames are compared with the one before (the fifth is the double_click expect)');
    assert.equal(r.report.steps[1].observation, 'reused_from_previous_check');
    reset(); scrolling({ seenAt: 1 });
    r = await run({ steps: [{ ...scrollStep, direction: 'up' }] });
    assert.equal(acts()[0].actions[0].scrollY, -200);
    // A box that is only a row tall still moves a tenth of the window, so eight scrolls cover real ground.
    assert.equal(j.scrollAction({ point: { x: 1, y: 2 }, box: { top: .5, bottom: .52 } }, 500, 'down').scrollY, 50);
  });
  await test('scroll: never seen stops at MAX_SCROLLS; later steps are not attempted', async () => {
    reset(); scrolling();
    const r = await run({ steps: [scrollStep, step] });
    assert.equal(acts().length, j.MAX_SCROLLS); assert.equal(r.report.status, 'stopped');
    assert.deepEqual([r.report.steps[0].status, r.report.steps[0].stopReason, r.report.attemptedSteps, r.report.confirmedSteps], ['unverified', 'max_scrolls', 1, 0]);
    assert.match(r.report.error, /scrolled 8 times without until.*1 later step\(s\) were NOT attempted/);
    assert(r.last.content.some(c => c.type === 'image'), 'the latest frame goes back to the main model');
  });
  await test('scroll: a frame that stops changing ends it early (the end of the list)', async () => {
    reset(); scrolling({ same: (n) => n > 3 });
    const r = await run({ steps: [scrollStep] });
    assert.deepEqual([r.report.steps[0].stopReason, r.report.steps[0].scrolls, r.report.steps[0].status], ['no_change', 3, 'unverified']);
    assert.equal(observed, 5, 'one extra look before calling it unchanged');
    assert.match(r.report.error, /stopped moving after 3 scroll/);
  });
  await test('scroll: a failure after the first wheel says input went out; before it, nothing was sent', async () => {
    reset(); scrolling(); let looks = 0;
    j.jevRuntime.request = async (_k, b) => { if (!b.questions.done) return tall(); if (++looks === 2) throw new Error('Jev HTTP 429: rate limit reached. No action was taken for this step.'); return verdict(.1); };
    let r = await run({ steps: [scrollStep] });
    assert.equal(r.report.attemptedSteps, 1); assert.equal(r.report.steps[0].status, 'unverified');
    assert.match(r.report.error, /scrolled 1 time\(s\) and then stopped.*429/); assert.doesNotMatch(r.report.error, /No action was taken/i);
    reset(); scrolling();
    j.jevRuntime.request = async (_k, b) => { if (b.questions.done) throw new Error('Jev HTTP 429: rate limit reached. No action was taken for this step.'); return tall(); };
    r = await run({ steps: [scrollStep] });
    assert.equal(r.report.attemptedSteps, 0); assert.equal(acts().length, 0); assert.match(r.report.error, /No action was taken/);
    reset(); scrolling({ act: async (stateId, actions) => { calls.push({ stateId, actions }); return { content: [], details: { capture: { stateId: 'after' }, execution: { outcome: 'didnt', error: { code: 'foreground_required', message: 'Input requires foreground' } } } }; } });
    r = await run({ steps: [scrollStep] });
    assert.deepEqual([r.report.steps[0].status, r.report.steps[0].stopReason, acts().length], ['failed', 'input_failed', 1]);
  });
  await test('scroll (Codex review): a stale frame is observed again; a resized window, a cancel and an executor problem stop with the input accounted for', async () => {
    reset(); scrolling({ seenAt: 2 }); const observe = j.jevRuntime.observe;
    j.jevRuntime.observe = async (...a) => { const r = await observe(...a); if (observed === 2) r.details.capture.timestamp -= 6000; return r; };
    let r = await run({ steps: [scrollStep] });
    assert.deepEqual([r.report.steps[0].stopReason, r.report.steps[0].scrolls, observed], ['until_seen', 2, 4]);
    assert.deepEqual(acts().map(c => c.stateId), ['s1', 's3'], 'the second scroll goes out on the fresh observation, not the stale one');
    reset(); scrolling(); const observe2 = j.jevRuntime.observe;
    j.jevRuntime.observe = async (...a) => { const r = await observe2(...a); if (observed >= 2) r.details.capture.width = 1200; return r; };
    r = await run({ steps: [scrollStep] });
    assert.deepEqual([r.report.steps[0].stopReason, r.report.steps[0].scrolls, acts().length], ['window_resized', 1, 1]);
    reset(); scrolling(); const ac = new AbortController(); let looks = 0;
    j.jevRuntime.request = async (_k, b) => { if (!b.questions.done) return tall(); if (++looks === 2) ac.abort(); return verdict(.1); };
    r = await run({ steps: [scrollStep] }, ac.signal);
    assert.equal(r.report.status, 'cancelled');
    assert.deepEqual([r.report.steps[0].status, r.report.steps[0].scrolls, r.report.steps[0].stopReason, r.report.attemptedSteps], ['unverified', 1, 'cancelled', 1]);
    reset(); scrolling({ act: async (stateId, actions) => { calls.push({ stateId, actions }); return { content: [], details: { status: 'target_closed', execution: { outcome: 'worked' } } }; } });
    r = await run({ steps: [scrollStep] });
    assert.equal(r.report.steps[0].status, 'failed'); assert.match(r.report.error, /was attempted, but the executor reported a problem/); assert.doesNotMatch(r.report.error, /not delivered/);
  });
  console.log(`${passed} Jev checks passed (Jev responses are fixtures; no live API claim).`);
} finally { Object.assign(j.jevRuntime, originals); await fs.rm(outfile, { force: true }); }
