#!/usr/bin/env node
// 电脑历史 recordSubscribe(协议 13)的接线检查,不需要任何授权:直接起刚编好的 helper 二进制
// (serve 模式、临时 socket;不走 open,因为这里只查接线,不查 TCC 归属),然后断言:
//   1. diagnostics 报协议 13、订阅者 0,无痕扫描计数(recorderPrivateScan*)在且为 0;
//   2. recordSubscribe 的首行回包形状正确 —— ok:true + subscribed,或(dev 构建没授权时)ok:false + accessibility_denied;
//   3. 这条连接保持打开 1 秒;之后收到的每一行都是 {"ev":{t,kind}};
//   4. 订阅成功时 diagnostics 报 1 个订阅者,客户端关掉后回到 0(这里只看注册表;观察者 / 全局监听真的拆掉了
//      由 check:recorder-logic 的 debugState 断言覆盖);
//      被拒时这条连接仍是普通连接,照常应答 diagnostics;
//   5. 最后 shutdown(兜底 SIGKILL),删临时目录。
// 若本机终端恰好有辅助功能授权,订阅会真的开始记录:这里只打印事件的 kind 计数,绝不打印内容。
// 需要先 `npm run build:native`。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('recorder check skipped (not macOS)');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.arch === 'x64' ? 'x64' : 'arm64';
const binary = process.argv[2] ?? path.join(root, 'prebuilt', 'macos', arch, 'bridge');
if (!existsSync(binary)) {
  console.error(`FAIL missing helper binary ${binary} — run \`npm run build:native\` first`);
  process.exit(1);
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-rec-'));
const socketPath = path.join(temp, 'bridge.sock');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const EVENT_KINDS = new Set(['app', 'window', 'text', 'click', 'key', 'system']);

/** 一条连接:按行收 JSON。 */
function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const lines = [];
    const waiters = [];
    let buffer = '';
    let closed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        lines.push(JSON.parse(line));
        waiters.splice(0).forEach((wake) => wake());
      }
    });
    socket.on('close', () => { closed = true; waiters.splice(0).forEach((wake) => wake()); });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      socket.on('error', () => {});
      resolve({
        socket,
        lines,
        get closed() { return closed; },
        send(object) { socket.write(`${JSON.stringify(object)}\n`); },
        async next(timeoutMs = 3000) {
          const deadline = Date.now() + timeoutMs;
          while (lines.length === 0) {
            if (closed) throw new Error('connection closed before a reply');
            if (Date.now() > deadline) throw new Error('timed out waiting for a line');
            await new Promise((wake) => { waiters.push(wake); setTimeout(wake, 100); });
          }
          return lines.shift();
        },
      });
    });
  });
}

async function request(object) {
  const connection = await connect();
  try {
    connection.send(object);
    return await connection.next();
  } finally {
    connection.socket.destroy();
  }
}

let child;
try {
  child = spawn(binary, ['serve', '--socket', socketPath], { stdio: ['ignore', 'ignore', 'inherit'] });
  let diagnostics;
  for (let attempt = 0; attempt < 100 && !diagnostics; attempt++) {
    if (child.exitCode !== null) throw new Error(`helper exited early (code ${child.exitCode})`);
    try { diagnostics = await request({ id: 'diag-0', cmd: 'diagnostics' }); } catch { await pause(100); }
  }
  assert.equal(diagnostics?.ok, true, 'helper must answer diagnostics');
  assert.equal(diagnostics.result.protocolVersion, 13, `protocol must be 13, got ${diagnostics.result.protocolVersion}`);
  assert.equal(diagnostics.result.recorderSubscribers, 0, 'no subscribers at startup');
  console.log('PASS helper answers diagnostics with protocol 13 and no subscribers');
  // 无痕扫描计数(只有计数):真机探针据此判断「扫描不完整时仍按普通窗口记」要不要改。刚起的 helper 全是 0。
  assert.equal(diagnostics.result.recorderPrivateScans, 0, 'recorderPrivateScans is a number, 0 at startup');
  assert.equal(diagnostics.result.recorderPrivateScanIncomplete, 0, 'recorderPrivateScanIncomplete is a number, 0 at startup');
  assert.deepEqual(diagnostics.result.recorderPrivateScanStops, { afterWebArea: 0, depthCap: 0, nodeCap: 0, deadline: 0 }, 'recorderPrivateScanStops lists every stop reason');
  console.log('PASS diagnostics reports private-scan counters');

  const subscription = await connect();
  subscription.send({
    id: 'rec-1',
    cmd: 'recordSubscribe',
    policy: { excludeBundleIds: ['com.example.never'], titleOnlyBundleIds: ['com.forsion.*'], excludeDomains: ['example.com'], text: true, clicks: true, keys: true },
  });
  const reply = await subscription.next();
  assert.equal(reply.id, 'rec-1', 'reply echoes the request id');
  let subscribed = false;
  if (reply.ok) {
    assert.equal(reply.result?.subscribed, true, 'ok reply says subscribed');
    assert.equal(reply.result?.protocolVersion, 13, 'ok reply carries protocol 13');
    assert.equal(typeof reply.result?.axTrusted, 'boolean', 'ok reply carries axTrusted');
    subscribed = true;
    console.log('PASS recordSubscribe replied ok:true subscribed (this process tree has an Accessibility grant)');
  } else {
    assert.equal(reply.error?.code, 'accessibility_denied', `denied reply must use accessibility_denied, got ${reply.error?.code}`);
    assert.equal(typeof reply.error?.message, 'string', 'denied reply carries a message');
    console.log('PASS recordSubscribe replied ok:false accessibility_denied (expected for an ungranted dev build)');
  }

  await pause(1000);
  assert.equal(subscription.closed, false, 'the subscription connection stays open for 1s');
  console.log('PASS connection stays open for 1s after the reply');

  if (subscribed) {
    const kinds = {};
    for (const line of subscription.lines.splice(0)) {
      assert.equal(typeof line.ev?.t, 'number', 'every streamed line is {"ev":{t,...}}');
      assert.ok(EVENT_KINDS.has(line.ev.kind), `unknown event kind ${line.ev?.kind}`);
      kinds[line.ev.kind] = (kinds[line.ev.kind] ?? 0) + 1;
    }
    console.log(`PASS streamed lines are well-formed events (kinds only: ${JSON.stringify(kinds)})`);
    const during = await request({ id: 'diag-1', cmd: 'diagnostics' });
    assert.equal(during.result.recorderSubscribers, 1, 'one subscriber while the connection is open');
    subscription.socket.destroy();
    let after;
    for (let attempt = 0; attempt < 30; attempt++) {
      after = await request({ id: 'diag-2', cmd: 'diagnostics' });
      if (after.result.recorderSubscribers === 0) break;
      await pause(100);
    }
    assert.equal(after.result.recorderSubscribers, 0, 'closing the client unsubscribes it');
    console.log('PASS closing the client drops the subscriber back to 0');
  } else {
    assert.equal(subscription.lines.length, 0, 'a denied connection streams no events');
    subscription.send({ id: 'diag-3', cmd: 'diagnostics' });
    const same = await subscription.next();
    assert.equal(same.id, 'diag-3', 'a denied connection keeps serving ordinary requests');
    assert.equal(same.result.recorderSubscribers, 0, 'denied subscription registers nothing');
    subscription.socket.destroy();
    console.log('PASS denied connection stays a normal request connection with no subscriber');
  }
} finally {
  await request({ id: 'bye', cmd: 'shutdown' }).catch(() => {});
  for (let attempt = 0; attempt < 30 && child && child.exitCode === null && child.signalCode === null; attempt++) await pause(100);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); // 只杀我们自己起的隔离实例,绝不碰用户的常驻 helper
  rmSync(temp, { recursive: true, force: true });
}
