/** Real macOS screenshot/input + local TypeSafe wire fixture. Does not measure Jev accuracy or speed.
 * Run with an already authorized protocol-compatible helper via PI_COMPUTER_USE_HELPER_APP_PATH
 * and PI_CU_SOCKET_PATH. Never installs/replaces the user's helper. Use the project's devlock.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { resolveMacosHelperAppPath } from '../src/vendor/platform/macos/helper-path.mjs';
import { runtimeProtocolVersion } from './helper-protocol.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), exec = promisify(execFile);
const socket = process.env.PI_CU_SOCKET_PATH;
assert(process.platform === 'darwin' && socket, 'Use macOS and an isolated PI_CU_SOCKET_PATH');
const ask = cmd => new Promise((resolve, reject) => {
  const s = net.connect(socket); let text = '';
  const timer = setTimeout(() => { s.destroy(); reject(new Error(`helper timeout: ${cmd}`)); }, 5000);
  s.on('error', e => { clearTimeout(timer); reject(e); });
  s.on('data', d => { text += d; if (!text.includes('\n')) return; clearTimeout(timer); s.end(); const m = JSON.parse(text.split('\n')[0]); m.ok ? resolve(m.result) : reject(new Error(m.error?.message)); });
  s.write(JSON.stringify({ id: `jev-${Date.now()}`, cmd }) + '\n');
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end = Date.now() + 10000; while (Date.now() < end) { try { const r = await fn(); if (r) return r; } catch {} await sleep(150); } throw new Error('Fixture timeout'); }
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-native-'));
const app = path.join(dir, 'JevFixture.app'), executable = path.join(app, 'Contents/MacOS/JevFixture'), stateFile = path.join(dir, 'state.json');
const bundleId = 'com.forsion.jev-native-fixture';
const outfile = path.join(root, `tangu-plugins/computer-use/dist/jev-native-${process.pid}.mjs`);
let cu, before, fixturePid, fieldsPid, helperStarted = false, prepared, boot, requests = 0;
const state = async () => JSON.parse(await fs.readFile(stateFile, 'utf8'));
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part;
    const b = JSON.parse(raw); requests++;
    assert.equal(req.url, '/v1/systemone'); assert.equal(req.headers.authorization, 'Bearer fixture-key');
    assert.equal(b.model, 'jev-1.14.0');
    if (!b.assets) {
      assert.equal(req.headers['typesafe-danger-zone-images'], undefined);
      const choice = Object.entries(b.questions.target.criteria).find(([ref, info]) => ref.startsWith('@e') && JSON.stringify(info).toLowerCase().includes(b.state.target.toLowerCase()))?.[0];
      assert(choice, 'semantic fixture target is present');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: b.model, answers: { target: { type: 'choice', choice, confidence: .99 } } }));
      return;
    }
    assert.equal(req.headers['typesafe-danger-zone-images'], 'true');
    assert(Object.values(b.assets)[0].data_base64.length > 100);
    const page = b.state.target === 'Page 3 button' ? 2 : 1;
    // The fixture owns geometry. The HTTP oracle returns a box in the actual uploaded image.
    const p = prepared, x = 32 / boot.window.w * p.contentWidth + p.left;
    const y = (boot.window.h - boot.content.h + 32 + page * boot.railWidth) / boot.window.h * p.contentHeight + p.top;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: b.model, answers: { visible: { type: 'noul', noul: .99 }, target: { type: 'box', confidence: .99, box: { left: (x-5)/p.width, right: (x+5)/p.width, top: (y-5)/p.height, bottom: (y+5)/p.height } } } }));
  } catch (e) { res.writeHead(400); res.end('fixture assertion failed'); console.error(e); }
});
try {
  await exec('open', ['-n', '-g', resolveMacosHelperAppPath(), '--args', 'serve', '--socket', socket]); helperStarted = true;
  const d = await until(() => ask('diagnostics'));
  assert.equal(d.protocolVersion, runtimeProtocolVersion()); assert(d.accessibility && d.screenRecording);
  before = await ask('getFrontmost');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>JevFixture</string><key>CFBundleExecutable</key><string>JevFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  await exec('xcrun', ['swiftc', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, '-O', path.join(root, 'scripts/vision-fixture/main.swift'), '-o', executable], { timeout: 180000 });
  await exec('open', ['-g', '-n', app, '--args', stateFile]);
  boot = await until(async () => { const s = await state(); return s.visible && s; }); fixturePid = boot.pid;
  await build({ stdin: { contents: 'export * from "./src/jevRun.ts";export {executeFind,ensureComputerUseSetup,shutdownComputerUseSession} from "./src/vendor/bridge.ts";', resolveDir: root }, outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', alias: { '@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts') }, banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' } });
  cu = await import(pathToFileURL(outfile));
  const ctx = { cwd: root, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
  await cu.ensureComputerUseSetup(ctx);
  const found = await cu.executeFind('', { bundleId }, undefined, undefined, ctx);
  const ref = found.content.filter(c => c.type === 'text').map(c => c.text).join('\n').match(/@r\d+/)?.[0]; assert(ref);
  const prepare = cu.jevRuntime.prepare; cu.jevRuntime.prepare = async (...a) => prepared = await prepare(...a);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const settings = { jev_enabled: true, jev_api_key: 'fixture-key', jev_api_url: `http://127.0.0.1:${server.address().port}/v1` };
  const run = (steps, preview = false) => cu.runJev({ root: ref, steps, preview, mode: 'vision' }, () => settings, () => true, ctx);
  const step = target => ({ action: 'click', target });
  const preview = await run([step('Page 3 button')], true);
  assert.equal(preview.report.status, 'preview', JSON.stringify(preview.report)); assert.equal((await state()).clicks, 0);
  const result = await run([step('Page 3 button'), step('Page 2 button')]);
  // A canvas has no semantic acknowledgement: native returns unknown even when the click landed.
  // The loop must stop after that attempt and hand the new screenshot back for verification.
  assert.equal(result.report.status, 'stopped', JSON.stringify(result.report));
  assert.equal(result.report.attemptedSteps, 1); assert.equal(result.report.executedSteps, 0);
  assert.equal(result.report.foregroundTaken, true);
  assert(result.last.content.some(c => c.type === 'image'));
  const final = await until(async () => { const s = await state(); return s.page === 2 && s.clicks === 1 && s; });
  assert.equal(requests, 2);
  const fieldsApp = path.join(dir, 'JevFields.app'), fieldsExe = path.join(fieldsApp, 'Contents/MacOS/JevFields'), fieldsState = path.join(dir, 'fields.json');
  await fs.mkdir(path.dirname(fieldsExe), { recursive: true });
  await fs.writeFile(path.join(fieldsApp, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.forsion.jev-fields</string><key>CFBundleName</key><string>JevFields</string><key>CFBundleExecutable</key><string>JevFields</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  await exec('xcrun', ['swiftc', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, '-O', path.join(root, 'scripts/jev-fixture.swift'), '-o', fieldsExe], { timeout: 180000 });
  await exec('open', ['-g', '-n', fieldsApp, '--args', fieldsState]);
  fieldsPid = (await until(async () => JSON.parse(await fs.readFile(fieldsState, 'utf8')))).pid;
  const fieldsRoot = (await cu.executeFind('', { bundleId: 'com.forsion.jev-fields' }, undefined, undefined, ctx)).content.filter(c => c.type === 'text').map(c => c.text).join('\n').match(/@r\d+/)?.[0]; assert(fieldsRoot);
  const semantic = await cu.runJev({ root: fieldsRoot, mode: 'elements', steps: [{ action: 'fill', target: 'Name', text: 'Jev fixture' }, step('Apply')] }, () => settings, () => true, ctx);
  assert.equal(semantic.report.executedSteps, 1, JSON.stringify(semantic.report));
  assert.equal(semantic.report.attemptedSteps, 2);
  assert.equal(semantic.report.steps[1].status, 'uncertain');
  const fieldsFinal = JSON.parse(await fs.readFile(fieldsState, 'utf8')); assert.equal(fieldsFinal.value, 'Jev fixture'); assert.equal(fieldsFinal.clicks, 1);
  assert.equal(requests, 4);
  console.log(JSON.stringify({ status: 'PASS', evidence: 'Real native capture/input with fixture Jev HTTP answers; no live Jev accuracy/speed claim', protocol: d.protocolVersion, page: final.page, clicks: final.clicks, report: result.report, semantic: semantic.report, fields: { clicks: fieldsFinal.clicks, value: fieldsFinal.value } }, null, 2));
} finally {
  await cu?.shutdownComputerUseSession().catch(() => {});
  server.closeAllConnections(); server.close();
  if (fixturePid) { try { process.kill(fixturePid, 'SIGTERM'); } catch {} }
  if (fieldsPid) { try { process.kill(fieldsPid, 'SIGTERM'); } catch {} }
  if (before?.bundleId) await exec('open', ['-b', before.bundleId]).catch(() => {});
  if (helperStarted) await ask('shutdown').catch(() => {});
  await fs.rm(outfile, { force: true }); await fs.rm(dir, { recursive: true, force: true });
}
