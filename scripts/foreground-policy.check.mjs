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
const base = { runId: 'run', sessionId: 'conversation', cwd: dir, execMode: 'host' };
try {
  process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = path.join(dir, 'missing');
  assert.equal(tools.has('allow_foreground_for_this_task'), false);
  for (const name of ['ensure_app', 'act_ui', 'launch_browser']) assert.equal(tools.get(name).capabilities.approval, 'command');
  assert.equal(tools.get('observe_ui').capabilities.approval, undefined);
  const launch = () => tools.get('launch_browser').execute({ visible: true }, base);
  await assert.rejects(launch(), /executable.*not found/);
  settings.headless = true;
  await assert.rejects(launch(), /strict background/i);
  console.log('PASS standard command approval tier, full-access visible launch and strict background override.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
