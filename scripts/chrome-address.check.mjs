// Native Chrome, a disposable profile and a loopback server. The HTTP request is independent of the tool's receipt.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw Error('Requires macOS and Google Chrome.');
const directory = mkdtempSync(join(tmpdir(), 'cu-address-'));
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url === '/slow') {
    setTimeout(() => response.end('<title>Slow navigation</title>'), 2100);
    return;
  }
  if (request.url === '/no-content') {
    response.writeHead(204);
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const title = request.url.startsWith('/done') ? 'Address accepted' : 'Address fixture';
    response.write(`<title>${title}</title><input autofocus>`);
  }
  response.end();
});

let chrome, closed, helperPid;
try {
  const helper = join(directory, 'tangu-computer-use.app');
  process.env.PI_COMPUTER_USE_HELPER_APP_PATH = helper;
  process.env.PI_CU_SOCKET_PATH = join(directory, 'bridge.sock');
  const archive = fileURLToPath(new URL(`../prebuilt/macos/${process.arch}/tangu-computer-use.app.zip`, import.meta.url));
  execFileSync('ditto', ['-x', '-k', archive, directory]);
  execFileSync('open', ['-n', '-g', helper, '--args', 'serve', '--socket', process.env.PI_CU_SOCKET_PATH]);
  const marker = join(directory, 'foreground.json');
  for (let i = 0; i < 80 && !existsSync(marker); i++) await delay(100);
  helperPid = JSON.parse(readFileSync(marker, 'utf8')).helperPid;
  assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--user-data-dir=' + join(directory, 'profile'), '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--disable-search-engine-choice-screen', '--window-size=920,660', origin + '/start',
  ], { stdio: 'ignore' });
  closed = once(chrome, 'exit');
  const { default: plugin } = await import('../tangu-plugins/computer-use/dist/index.js');
  let provider;
  plugin.activate({
    registerPlugin(meta) { provider = meta.toolProvider; }, registerCommand() {}, log() {},
    sdk: { pluginStore: { isPluginEnabledSync: () => true, getScopeSettings: () => ({ headless: false }) } },
  });
  const tools = new Map(provider.tools().map(tool => [tool.name, tool]));
  const context = { runId: 'address-' + chrome.pid, sessionId: 'address-' + chrome.pid, cwd: directory, execMode: 'host', collectImage() { return true; } };
  const call = (name, args) => tools.get(name).execute(args, context);
  let root;
  for (let i = 0; i < 60 && !root; i++) {
    const list = await call('find_roots', { pid: chrome.pid, kind: 'window' });
    const fixture = list.split('\n').find(line => line.includes('pid ' + chrome.pid + ' ') && line.includes('Address fixture'));
    root = fixture?.match(/@r\d+/)?.[0];
    if (!root) await delay(250);
  }
  assert.ok(root, 'No window for the disposable Chrome profile');
  const observe = () => call('observe_ui', { root, mode: 'pixels' });
  const raise = () => call('ensure_app', { bundleId: 'com.google.Chrome', foregroundRoot: root });
  await delay(1200);
  assert.match(await raise(), /Brought|Mini recovery/);
  let frame = await observe();
  await raise(); // First observation may coincide with Chrome's startup focus changes.
  async function act(action) {
    const stateId = /State ([\da-f-]{36})/i.exec(frame)?.[1];
    assert.ok(stateId, frame.slice(0, 250));
    frame = await call('act_ui', { stateId, actions: [action] });
    const evidence = /"verification":"([^"]+)"/.exec(frame)?.[1];
    console.log(action.action, evidence ?? frame.slice(0, 180));
    return evidence;
  }
  const focus = () => act({ action: 'keypress', keys: ['Mod+L'] });
  const type = url => act({ action: 'typeText', text: url });
  const submit = () => act({ action: 'keypress', keys: ['Return'] });
  const exhausted = error => error.code === 'computer_use_recovery_exhausted';
  const destination = '/done?item=12345678901234567890&filter=history';
  assert.equal(await focus(), 'address_focus');
  assert.equal(await type(origin + destination), 'address_value');
  let submitted = await submit();
  if (submitted === 'address_waiting_for_match' || submitted === 'address_pending') {
    frame = await observe();
    submitted = await submit();
  }
  assert.equal(submitted, 'document_url', JSON.stringify({ submitted, requests }));
  assert.equal(requests.filter(url => url === destination).length, 1);
  console.log('PASS requested URL and query committed once in the original window');

  async function openUntilSubmitted(url) {
    frame = await observe();
    assert.equal(await focus(), 'address_focus');
    assert.equal(await type(url), 'address_value');
    let result = await submit();
    if (result === 'address_waiting_for_match') {
      frame = await observe();
      result = await submit();
    }
    return result;
  }

  // Start an independent run and select the address visually on the fixture's 1600px window screenshot.
  context.runId += '-pointer';
  frame = await observe();
  await act({ action: 'click', x: 480, y: 110, clickCount: 3 });
  const pointed = origin + '/from-pointer';
  let edit = await type(pointed);
  if (edit === 'address_mismatch') {
    assert.equal(await focus(), 'address_focus');
    edit = await type(pointed);
  }
  assert.equal(edit, 'address_value');
  let pointerResult = await submit();
  if (pointerResult === 'address_pending' || pointerResult === 'address_waiting_for_match') {
    frame = await observe();
    pointerResult = await submit();
  }
  assert.equal(pointerResult, 'document_url');
  assert.equal(requests.filter(url => url === '/from-pointer').length, 1);
  console.log('PASS screenshot address-field click enters the verified route');

  const slow = await openUntilSubmitted(origin + '/slow');
  if (slow === 'address_pending') {
    frame = await observe();
    assert.equal(await submit(), 'document_url');
  } else assert.equal(slow, 'document_url');
  assert.equal(requests.filter(url => url === '/slow').length, 1);
  console.log('PASS slow response commits with exactly one request');

  assert.equal(await openUntilSubmitted(origin + '/no-content'), 'address_pending');
  frame = await observe();
  await act({ action: 'keypress', keys: ['Left'] });
  frame = await observe();
  await assert.rejects(submit(), exhausted);
  frame = await observe();
  await focus();
  await assert.rejects(type(origin + '/no-content'), exhausted);
  assert.equal(requests.filter(url => url === '/no-content').length, 1);
  console.log('PASS 204 stops the host; observing and refocusing cannot resubmit');

  frame = await observe();
  await focus();
  const unsent = '/must-not-open';
  assert.equal(await type(origin + unsent), 'address_value');
  // A different run acts as a person switching tabs between the original run's two actions.
  const stateId = /State ([\da-f-]{36})/i.exec(frame)[1];
  await tools.get('act_ui').execute({ stateId, actions: [{ action: 'keypress', keys: ['cmd+t'] }] },
    { ...context, runId: context.runId + '-other' });
  frame = await observe();
  await assert.rejects(submit(), exhausted);
  assert.ok(!requests.includes(unsent));
  console.log('PASS a different selected tab cancels submission without sending the URL');

} catch (error) {
  console.error('Fixture requests:', requests);
  throw error;
} finally {
  if (chrome && closed) { chrome.kill(); await closed; }
  if (helperPid) { try { process.kill(helperPid, 'SIGTERM'); } catch {} }
  server.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
