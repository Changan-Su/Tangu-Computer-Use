// Read an already-running background application's first frame, without saving
// its pixels or sending them to a model. Usage: npm run check:mac-app -- '网易云音乐' com.netease.163music
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import plugin from '../tangu-plugins/computer-use/dist/index.js';

if (process.platform !== 'darwin') process.exit(0);
const [app, bundleId] = process.argv.slice(2);
assert.ok(app && bundleId, 'Supply the localized name and bundle ID of a running background app');
const exec = promisify(execFile);
await exec(process.execPath, [fileURLToPath(new URL('./setup-helper.mjs', import.meta.url)), '--check']);
const appInfo = async (...args) => {
  const { stdout } = await exec('/usr/bin/lsappinfo', args);
  const match = /^ASN:0x[0-9a-f]+-0x[0-9a-f]+/i.exec(stdout.trim());
  assert.ok(match, 'Launch Services did not return an application serial number');
  return match[0].toLowerCase();
};
const target = await appInfo('find', 'bundleid=' + bundleId);
const before = await appInfo('front');
assert.notEqual(before, target, 'The target must already be in the background');
let provider;
plugin.activate({ registerPlugin(meta) { provider = meta.toolProvider; }, registerCommand() {}, log() {},
  sdk: { pluginStore: { isPluginEnabledSync: () => true, getScopeSettings: () => ({ headless: false }) } } });
let shots = 0, sampling = true;
const samples = [before];
const monitor = (async () => { while (sampling) { samples.push(await appInfo('front')); await delay(35); } })();
const start = performance.now();
let result;
try {
  result = await provider.tools().find(t => t.name === 'ensure_app').execute({ app, mode: 'pixels' }, {
    userId: 'test', appId: 'test', runId: 'read-only', sessionId: 'test', execMode: 'host',
    collectImage(img) { assert.ok(img.url.startsWith('data:image/')); shots++; return true; },
  });
} finally { sampling = false; await monitor; samples.push(await appInfo('front')); }
assert.ok(result.includes(bundleId), 'Result must identify the requested application');
assert.equal(samples.filter(x => x === target).length, 0, 'The target received foreground focus');
const visible = shots === 1 && /stateId|State [\da-f-]{36}/i.test(result);
const hidden = shots === 0 && result.includes('allow_foreground_for_this_task');
assert.ok(visible || hidden, 'Expected a first image and state, or a background-safe hidden-window outcome');
console.log(JSON.stringify({ app, bundleId, outcome: visible ? 'first-image' : 'hidden-window', shots, ms: Math.round(performance.now()-start),
  samples: samples.length, foregroundChanges: samples.slice(1).filter((x,i) => x !== samples[i]).length, targetForegroundSamples: 0 }));
