// Real macOS acceptance. Requires two existing Spaces on the main display and this build's signed helper.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildFixture, launchFixture, quitFixture, readState } from './vision-fixtures.mjs';

if (process.platform !== 'darwin') process.exit(0);
const strict = process.argv.includes('--strict');
const directory = mkdtempSync(path.join(tmpdir(), 'tangu-other-space-'));
const archive = fileURLToPath(new URL(`../prebuilt/macos/${process.arch}/tangu-computer-use.app.zip`, import.meta.url));
execFileSync('ditto', ['-x', '-k', archive, directory]);
const helper = path.join(directory, 'tangu-computer-use.app');
process.env.PI_COMPUTER_USE_HELPER_APP_PATH = helper;
process.env.PI_CU_SOCKET_PATH = path.join(directory, 'bridge.sock');
execFileSync(process.execPath, [fileURLToPath(new URL('./setup-helper.mjs', import.meta.url)), '--check']);
const { default: plugin } = await import('../tangu-plugins/computer-use/dist/index.js');
const stateFile = path.join(directory, 'player.json');
const app = await buildFixture('melody');
const boot = await launchFixture(app, stateFile, { page: 'daily', behind: true, args: ['--inactive-space','--test-button'] });
let helperPid;
try {
  execFileSync('open', ['-n', '-g', helper, '--args', 'serve', '--socket', process.env.PI_CU_SOCKET_PATH]);
  const signalFile = path.join(directory, 'foreground.json');
  for (let i = 0; i < 100 && !existsSync(signalFile); i++) await delay(50);
  helperPid = JSON.parse(readFileSync(signalFile, 'utf8')).helperPid;
  assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
  const placement = boot.spaceTest;
  assert.ok(placement?.membership.includes(placement.target) && !placement.membership.includes(placement.current),
    'Fixture must actually occupy a different Space. Prepare two regular Spaces on the main display.');
  let provider;
  plugin.activate({ registerPlugin(meta) { provider = meta.toolProvider; }, registerCommand() {}, log() {},
    sdk: { pluginStore: { isPluginEnabledSync: () => true, getScopeSettings: () => ({ headless: strict }) } } });
  const tools = new Map(provider.tools().map(tool => [tool.name, tool]));
  const context = { runId: 'off-space-test', sessionId: 'off-space-test', cwd: directory,
    execMode: 'host', collectImage(image) { assert.match(image.url, /^data:image\//); return true; } };
  const start = performance.now(), before = readState(stateFile);
  const frame = await tools.get('ensure_app').execute({ app, mode: 'pixels' }, context);
  const id = /State ([\da-f-]{36})/i.exec(frame)?.[1];
  const size = /attached screenshot is (\d+)x(\d+)/.exec(frame);
  assert.ok(id && size, 'Expected an off-Space screenshot and actionable state. '+frame.slice(0,350));
  const row = before.layout.find(item => item.kind === 'row' && !item.partial);
  assert.ok(row, 'Expected a visible song row in the fixture');
  const x = Math.round((row.rect.x + row.rect.w/2) * Number(size[1])/before.window.w);
  const y = Math.round((row.rect.y + row.rect.h/2) * Number(size[2])/before.window.h);
  const result = await tools.get('act_ui').execute({ stateId: id, actions: [{ action: 'click', x, y, clickCount: 2 }] }, context);
  const successor = /State ([\da-f-]{36})/i.exec(result)?.[1];
  assert.ok(successor, 'Expected the successor screenshot after the background click. ' + result.slice(0,500));
  const key = await tools.get('act_ui').execute({ stateId: successor, actions: [{action: 'keypress', keys: ['return']}] }, context)
    .catch(error => String(error));
  assert.match(key, /focus|foreground_required/i, key.slice(0,500));
  await delay(300);
  const after = readState(stateFile), events = after.events.slice(before.events.length);
  assert.equal(after.keys, before.keys, 'A keyboard gesture needing focus must stay undelivered');
  assert.equal(after.playing?.index, 1, result.slice(0,700));
  assert.equal(events.filter(e => e.kind === 'play').length, 1);
  assert.equal(events.filter(e => e.kind === 'spaceChanged').length, 0);
  assert.equal(events.filter(e => e.kind === 'frontChanged' && e.detail === String(boot.pid)).length, 0);
  assert.match(result, /"delivery":"pid"/);
  // Miss twice on an inert part of this off-Space window, then use a different control in the same process.
  const pixelStateId = text => /State ([\da-f-]{36})/i.exec(text)?.[1];
  const ensurePixels = () => tools.get('ensure_app').execute({ app, mode: 'pixels' }, context);
  const click = (stateId, x, y, clickCount = 1) => tools.get('act_ui').execute({
    stateId, actions: [{ action: 'click', x, y, clickCount }],
  }, context);
  const button = before.testButton;
  const ax = await click(pixelStateId(await ensurePixels()),
    Math.round((button.x + button.w / 2) * Number(size[1]) / before.window.w),
    Math.round((button.y + button.h / 2) * Number(size[2]) / before.window.h));
  assert.match(ax, /"delivery":"(?:ax|pid)"/, ax);
  const buttonDelivery = /"delivery":"(ax|pid)"/.exec(ax)[1];
  assert.equal(readState(stateFile).events.filter(e => e.kind === 'axButton').length, 1);
  let missFrame = await ensurePixels();
  for (let attempt = 0; attempt < 2; attempt++) {
    const stateId = pixelStateId(missFrame);
    assert.ok(stateId);
    missFrame = await click(stateId, Math.round(Number(size[1]) * 0.96), Math.round(Number(size[2]) * 0.12));
    assert.match(missFrame, /"outcome":"(?:didnt|unknown)"/);
    assert.match(missFrame, /"delivery":"pid"/);
  }
  const afterMisses = readState(stateFile);
  assert.equal(afterMisses.clicks, after.clicks + 2);
  assert.equal(afterMisses.playing?.index, after.playing.index);
  const stillBehind = afterMisses.events.slice(before.events.length);
  assert.ok(!stillBehind.some(e => e.kind === 'spaceChanged' || (e.kind === 'frontChanged' && e.detail === String(boot.pid))));
  const misses = afterMisses.clicks;
  const blocked = await click(pixelStateId(missFrame), Math.round(Number(size[1]) * 0.96),
    Math.round(Number(size[2]) * 0.12), 2).catch(String);
  assert.match(blocked, /No input sent/, blocked);
  assert.equal(readState(stateFile).clicks, misses);
  await assert.rejects(click(pixelStateId(missFrame), Math.round(Number(size[1]) * 0.96), Math.round(Number(size[2]) * 0.12)),
    error => error?.code === 'computer_use_recovery_exhausted');
  assert.equal(readState(stateFile).clicks, misses, 'Alternating a double and single click cannot extend the retry budget');
  if (strict) {
    const root = /Screenshot only for (@r\d+)/.exec(missFrame)?.[1];
    assert.ok(root);
    const denied = await tools.get('ensure_app').execute({ app, foregroundRoot: root }, context);
    assert.match(denied, /unavailable|cannot be raised/);
    assert.equal(readState(stateFile).clicks, misses);
  }
  if (process.argv.includes('--recover')) {
    const root = /foregroundRoot[^@]+(@r\d+)/.exec(missFrame)?.[1];
    assert.ok(root, missFrame);
    const raised = await tools.get('ensure_app').execute({ app, foregroundRoot: root }, context);
    assert.match(raised, /Mini recovery/, raised);
    assert.equal(readState(stateFile).clicks, misses, 'Raising a window must not replay input');
    const dims = /attached screenshot is (\d+)x(\d+)/.exec(raised);
    assert.ok(dims && pixelStateId(raised));
    const oldState = await click(pixelStateId(missFrame), Math.round(Number(size[1]) * 0.96), Math.round(Number(size[2]) * 0.12)).catch(String);
    assert.match(oldState, /No click sent|stale|state.*expired/i, oldState);
    assert.equal(readState(stateFile).clicks, misses, 'A pre-switch screenshot cannot authorize a physical click');
    const finalClick = await click(pixelStateId(raised), Math.round(Number(dims[1]) * 0.96), Math.round(Number(dims[2]) * 0.12));
    assert.match(finalClick, /"delivery":"hid"/, finalClick);
    const ended = readState(stateFile);
    assert.equal(ended.events.filter(e => e.kind === 'foregroundClick').length, 1);
    assert.equal(ended.clicks, misses + 1);
    console.log(JSON.stringify({activeSpace: placement.current, windowSpace: placement.target, backgroundCanvas: after.playing.index,
      backgroundButton: buttonDelivery, misses: 2, thirdClickBlocked: true, switchesDuringBackground: 0, foregroundActions: 1,
      spaceChanges: ended.events.filter(e => e.kind === 'spaceChanged').length, ms: Math.round(performance.now()-start)}));
  } else {
    process.kill(boot.pid, 'SIGUSR2');
    for (let i = 0; i < 35 && !readState(stateFile).returnedSpaces?.includes(placement.current); i++) await delay(100);
    assert.ok(readState(stateFile).returnedSpaces?.includes(placement.current));
    const again = await ensurePixels();
    const stateId = pixelStateId(again);
    const nextRow = before.layout.filter(item => item.kind === 'row' && !item.partial)[1];
    const nextSize = /attached screenshot is (\d+)x(\d+)/.exec(again);
    assert.ok(stateId && nextRow && nextSize);
    const next = await click(stateId,
      Math.round((nextRow.rect.x + nextRow.rect.w / 2) * Number(nextSize[1]) / before.window.w),
      Math.round((nextRow.rect.y + nextRow.rect.h / 2) * Number(nextSize[2]) / before.window.h), 2);
    assert.match(next, /"delivery":"pid"/, 'An earlier miss must not route a different button straight to foreground');
    const ended = readState(stateFile);
    assert.equal(ended.playing?.index, 2);
    const nextState = pixelStateId(next);
    assert.ok(nextState);
    const popup = await click(nextState, Math.round(Number(nextSize[1]) * 0.94), Math.round(Number(nextSize[2]) * 0.17));
    const opened = /New root: window \((@r\d+)\)/.exec(popup);
    assert.ok(opened, popup);
    assert.ok(!popup.includes('Melody Track Details'), 'Screenshot-only results must not reveal the window title from accessibility.');
    const details = await tools.get('observe_ui').execute({ root: opened[1], mode: 'pixels' }, context);
    assert.ok(pixelStateId(details), details);
    assert.match(popup, /"delivery":"pid"/);
    assert.doesNotMatch(popup, /"outcome":"didnt"|\[foreground\]/);
    const final = readState(stateFile);
    assert.equal(final.clicks, ended.clicks + 1, 'Opening the details window must send exactly one click.');
    const endEvents = final.events.slice(before.events.length);
    assert.equal(endEvents.filter(e => e.kind === 'play').length, 2);
    assert.equal(endEvents.filter(e => e.kind === 'spaceChanged' || (e.kind === 'frontChanged' && e.detail === String(boot.pid))).length, 0);
    console.log(JSON.stringify({ activeSpace: placement.current, windowSpace: placement.target, image: size.slice(1),
      click: [x,y], played: after.playing.index, playedAfterMisses: ended.playing.index, popupClicks: final.clicks - ended.clicks,
      spaceChanges: 0, targetActivations: 0, strict, ms: Math.round(performance.now() - start) }));
  }
} finally {
  if (process.argv.includes('--recover') && boot.originalFrontPid) {
    // Hand the desktop back only while our own disposable fixture still owns the foreground.
    execFileSync('osascript', ['-l','JavaScript','-e',
      `ObjC.import('AppKit'); if ($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier === ${boot.pid}) $.NSRunningApplication.runningApplicationWithProcessIdentifier(${boot.originalFrontPid}).activateWithOptions(0)`]);
  }
  if (helperPid) { try { process.kill(helperPid, 'SIGTERM'); } catch {} }
  await quitFixture(boot.pid);
  rmSync(directory, { recursive: true, force: true });
}
