// Probe actual packaged bits, not Swift source or an injected foreground.json.
// Optional first argument checks a different installed/packaged executable.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { appName, installMacosApp } from './macos-bundle.mjs';

if (process.platform !== 'darwin') { console.log('SKIP macOS native helper'); process.exit(0); }
const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-signal-')), socket = path.join(temp, 'bridge.sock');
const app = process.argv[2] ? undefined : path.join(temp, appName);
const executable = process.argv[2] || path.join(app, 'Contents/MacOS/bridge');
const pause = ms => new Promise(r => setTimeout(r, ms));
function request(cmd) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socket); let data = '';
    const finish = (error, result) => { clearTimeout(timer); s.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error('helper timeout')), 2000);
    s.on('connect', () => s.write(JSON.stringify({ id: 'signal-probe', cmd }) + '\n'));
    s.on('error', error => finish(error));
    s.on('data', chunk => { data += chunk; if (data.includes('\n')) { try { finish(null, JSON.parse(data.split('\n')[0])); } catch(error) { finish(error); } } });
  });
}
let child, spawnError;
try {
  if (app) await installMacosApp(root, app, { register: false });
  assert.ok(existsSync(executable), 'bundle must ship a macOS helper');
  child = app
    ? spawn('/usr/bin/open', ['-n', '-g', app, '--args', 'serve', '--socket', socket], { stdio: 'ignore' })
    : spawn(executable, ['serve', '--socket', socket], { stdio: 'ignore' });
  child.on('error', error => { spawnError = error; });
  let diagnostics;
  for (let i = 0; i < 50; i++) {
    if (spawnError) throw spawnError;
    try { diagnostics = await request('diagnostics'); break; } catch { await pause(100); }
  }
  assert.equal(diagnostics?.ok, true, 'native helper must start');
  const status = await request('permissionStatus');
  assert.equal(status.ok, true);
  if (app) {
    assert.equal(status.result.source.attribution, 'helper-app', 'LaunchServices must attribute permissions to the installed helper app');
    assert.equal(realpathSync(status.result.source.executablePath), realpathSync(executable));
  }
  const signal = JSON.parse(readFileSync(path.join(temp, 'foreground.json'), 'utf8'));
  assert.equal(signal.v, 1); assert.equal(signal.active, false); assert.equal(signal.helperPid, status.result.source.pid);
  assert.ok(Math.abs(Date.now() - signal.updatedAt) < 10000, 'signal belongs to this startup');
  assert.ok(signal.expiresAt <= Date.now(), 'idle startup cannot open Mini');
  console.log(`PASS native helper publishes an idle Mini signal (protocol ${diagnostics.result.protocolVersion})`);
} finally {
  await request('shutdown').catch(() => {}); await pause(300);
  if (child && child.exitCode === null) child.kill('SIGTERM'); // Only our isolated probe/launcher, never a user daemon.
  if (app) {
    try { execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app], { stdio: 'ignore' }); } catch {}
  }
  rmSync(temp, { recursive: true, force: true });
}
