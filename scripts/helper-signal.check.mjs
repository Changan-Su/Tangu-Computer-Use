// Probe actual packaged bits, not Swift source or an injected foreground.json.
// Optional first argument checks a different installed/packaged executable.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') { console.log('SKIP macOS native helper'); process.exit(0); }
const root = path.resolve(import.meta.dirname, '..');
const executable = process.argv[2] || [
  'prebuilt/macos/universal/tangu-computer-use.app/Contents/MacOS/bridge',
  `prebuilt/macos/${process.arch}/tangu-computer-use.app/Contents/MacOS/bridge`,
  `prebuilt/macos/${process.arch}/bridge`,
].map(file => path.join(root, file)).find(existsSync);
assert.ok(executable, 'bundle must ship a macOS helper');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-signal-')), socket = path.join(temp, 'bridge.sock');
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
const child = spawn(executable, ['serve', '--socket', socket], { stdio: 'ignore' });
let spawnError;
child.on('error', error => { spawnError = error; });
try {
  let diagnostics;
  for (let i = 0; i < 50; i++) {
    if (spawnError) throw spawnError;
    try { diagnostics = await request('diagnostics'); break; } catch { await pause(100); }
  }
  assert.equal(diagnostics?.ok, true, 'native helper must start');
  const signal = JSON.parse(readFileSync(path.join(temp, 'foreground.json'), 'utf8'));
  assert.equal(signal.v, 1); assert.equal(signal.active, false); assert.equal(signal.helperPid, child.pid);
  assert.ok(Math.abs(Date.now() - signal.updatedAt) < 10000, 'signal belongs to this startup');
  assert.ok(signal.expiresAt <= Date.now(), 'idle startup cannot open Mini');
  console.log(`PASS native helper publishes an idle Mini signal (protocol ${diagnostics.result.protocolVersion})`);
} finally {
  await request('shutdown').catch(() => {}); await pause(300);
  if (child.exitCode === null) child.kill('SIGTERM'); // Only our isolated probe, never an installer or user daemon.
  rmSync(temp, { recursive: true, force: true });
}
