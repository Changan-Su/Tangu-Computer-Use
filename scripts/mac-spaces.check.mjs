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
const boot = await launchFixture(app, stateFile, { page: 'daily', behind: true, args: ['--inactive-space'] });
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
    sdk: { pluginStore: { isPluginEnabledSync: () => true, getScopeSettings: () => ({ headless: false }) } } });
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
  console.log(JSON.stringify({ activeSpace: placement.current, windowSpace: placement.target, image: size.slice(1),
    click: [x,y], played: after.playing.index, spaceChanges: 0, targetActivations: 0, ms: Math.round(performance.now()-start) }));
} finally {
  if (helperPid) { try { process.kill(helperPid, 'SIGTERM'); } catch {} }
  await quitFixture(boot.pid);
  rmSync(directory, { recursive: true, force: true });
}
