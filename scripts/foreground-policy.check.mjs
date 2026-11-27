// Runs the compiled provider. The deliberately missing browser executable lets the
// test observe whether a visible launch passed the policy gate without opening a window.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import plugin from '../tangu-plugins/computer-use/dist/index.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'cu-grant-check-'));
const settings = { headless: false, managed_browser: 'chrome' };
let provider;
plugin.activate({ registerPlugin({ toolProvider, settings: schema }) {
    const keys = schema.fields.map(field => field.key);
    assert.ok(keys.includes('cursor_overlay'));
    assert.ok(!keys.includes('headless'));
    provider = toolProvider;
  }, registerCommand() {}, log() {},
  sdk: { pluginStore: { isPluginEnabledSync: () => true, getScopeSettings: () => settings } } });
const tools = new Map(provider.tools().map(t => [t.name, t]));
const base = { runId: 'run', sessionId: 'conversation', cwd: dir, execMode: 'host' };
try {
  process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = path.join(dir, 'missing');
  const variants = tools.get('act_ui').definition.function.parameters.properties.actions.items.anyOf;
  for (const action of ['keypress', 'typeText']) {
    const variant = variants.find(v => v.properties.action.const === action);
    assert.equal(variant.properties.x.type, 'number');
    assert.equal(variant.properties.y.type, 'number');
  }
  assert.equal(tools.has('allow_foreground_for_this_task'), false);
  for (const name of ['ensure_app', 'act_ui', 'launch_browser']) assert.equal(tools.get(name).capabilities.approval, 'command');
  assert.equal(tools.get('observe_ui').capabilities.approval, undefined);
  const launch = () => tools.get('launch_browser').execute({ visible: true }, base);
  await assert.rejects(launch(), /executable.*not found/);
  const launchTool = tools.get('launch_browser');
  const activeTurn = new AbortController();
  await assert.rejects(launchTool.execute({ visible: true }, { ...base, userTurnSignal: activeTurn.signal }), /executable.*not found/);
  activeTurn.abort();
  await assert.rejects(launchTool.execute({ visible: true }, { ...base, userTurnSignal: activeTurn.signal }), /user turn has changed/);
  settings.headless = true;
  mkdirSync(path.join(dir, '.pi'));
  writeFileSync(path.join(dir, '.pi/computer-use.json'), '{"headless":true}');
  process.env.PI_COMPUTER_USE_HEADLESS = 'true'; // Left behind by older plugin versions on hot reload.
  await assert.rejects(launch(), /executable.*not found/);
  console.log('PASS standard command approval tier, full-access visible launch and legacy background settings ignored.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
