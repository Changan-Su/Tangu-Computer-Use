// Runs the compiled provider. The deliberately missing browser executable lets the
// test observe whether a visible launch passed the policy gate without opening a window.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import plugin from '../tangu-plugins/computer-use/dist/index.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'cu-grant-check-'));
const settings = { headless: false, managed_browser: 'chrome' };
let provider;
plugin.activate({ registerPlugin({ toolProvider }) { provider = toolProvider; }, registerCommand() {}, log() {},
  sdk: { pluginStore: { isPluginEnabledSync: () => true, getScopeSettings: () => settings } } });
const tools = new Map(provider.tools().map(t => [t.name, t]));
const grant = tools.get('allow_foreground_for_this_task');
const turn = new AbortController();
const base = { userTurnSignal: turn.signal, runId: 'run', userTurnId: 'turn', sessionId: 'conversation', appId: 'dev', userId: 'user', cwd: dir, execMode: 'host' };
const launch = overrides => tools.get('launch_browser').execute({ visible: true }, { ...base, ...overrides });
const blocked = /strict background|foreground approval/i;
try {
  process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = path.join(dir, 'missing');
  assert.equal(grant.capabilities.approval, 'always');
  await assert.rejects(launch({}), blocked);
  assert.match(await grant.execute({ reason: 'Show the hidden fixture' }, { ...base, runId: undefined }), /requires a current task/);
  // Emulate dispatch *after* the host's mandatory approval, only inside this test.
  assert.match(await grant.execute({ reason: 'Show the hidden fixture' }, base), /confirmed approval/);
  assert.match(await grant.execute({ reason: 'Show the hidden fixture' }, { ...base, userConfirmedCall: true, userTurnId: undefined }), /confirmed approval/);
  assert.match(await grant.execute({ reason: 'Show the hidden fixture' }, { ...base, userConfirmedCall: true }), /approved for this task only/);
  await assert.rejects(launch({}), /executable.*not found/);
  await Promise.all([{ userTurnId: 'next steer' }, { runId: 'next' }, { sessionId: 'other' }, { appId: 'other' },
    { userId: 'other' }, { runId: undefined }].map(scope => assert.rejects(launch(scope), blocked)));
  settings.headless = true;
  await assert.rejects(launch({}), blocked);
  assert.match(await grant.execute({ reason: 'fixture' }, base), /Strict background is enabled/);
  settings.headless = false;
  turn.abort();
  await assert.rejects(launch({}), blocked);
  assert.match(await grant.execute({reason: 'expired'}, {...base, userConfirmedCall: true}), /confirmed approval/);
  console.log('PASS mandatory approval, grant isolation, missing run, and strict background override.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
