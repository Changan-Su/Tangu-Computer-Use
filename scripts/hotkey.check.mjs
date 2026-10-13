#!/usr/bin/env node
// 全局手势订阅 hotkeySubscribe(协议 15 引入)的接线检查,不需要任何授权:照 recorder.check.mjs 的做法,
// 直接起刚编好的 helper 二进制(serve 模式、临时 socket;不走 open、不碰用户常驻的 helper),然后断言:
//   1. diagnostics 报的协议号 = 这份 bridge.swift 源码里的号,手势订阅者(hotkeySubscribers)为 0;
//   2. 不认识的手势 → ok:false + unknown_gesture(这一步在查授权之前,所以没授权也能验),这条连接仍是普通连接;
//   3. hotkeySubscribe modPair 的首行回包 —— ok:true + 恰好 {subscribed:true},或(没授权时)ok:false + accessibility_denied;
//   4. 订阅成功:连接保持打开,diagnostics 报 1 个订阅者,期间收到的每一行都是 {"ev":{t,kind:"hotkey",…}};
//      客户端关掉后订阅者回到 0(全局监听真的拆掉了由 check:hotkey-logic 断言);
//      被拒:这条连接照常应答 diagnostics,订阅者仍是 0;
//   5. stdin 模式(没有 serve)下 hotkeySubscribe 回 unsupported;
//   6. 最后 shutdown(兜底 SIGKILL),删临时目录。
// 这里不按任何键:手势本身(状态机、事件形状)由 check:hotkey-logic 覆盖;真按键要在授权过的 helper 上人手按,
// 见 scripts/probe-hotkey.mjs。若本机终端恰好有辅助功能授权、检查期间又真的有人按了左右 ⌘,只打印事件条数,绝不打印内容。
// 需要先 `npm run build:native`。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeProtocolVersion } from './helper-protocol.mjs';

if (process.platform !== 'darwin') {
  console.log('hotkey check skipped (not macOS)');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.arch === 'x64' ? 'x64' : 'arm64';
const binary = process.argv[2] ?? path.join(root, 'prebuilt', 'macos', arch, 'bridge');
if (!existsSync(binary)) {
  console.error(`FAIL missing helper binary ${binary} — run \`npm run build:native\` first`);
  process.exit(1);
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-hk-'));
const socketPath = path.join(temp, 'bridge.sock');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function subscribers() {
  return (await request({ id: 'diag', cmd: 'diagnostics' })).result.hotkeySubscribers;
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
  const protocol = nativeProtocolVersion();
  assert.equal(diagnostics.result.protocolVersion, protocol, `protocol must be ${protocol} (native/macos/bridge.swift), got ${diagnostics.result.protocolVersion} — this binary was not built from this source, run \`npm run build:native\``);
  assert.equal(diagnostics.result.hotkeySubscribers, 0, 'no hotkey subscribers at startup');
  console.log(`PASS helper answers diagnostics with protocol ${protocol} and no hotkey subscribers`);

  const rejected = await connect();
  rejected.send({ id: 'hk-0', cmd: 'hotkeySubscribe', gesture: 'tripleTap', excludePids: [] });
  const unknown = await rejected.next();
  assert.deepEqual([unknown.id, unknown.ok, unknown.error?.code], ['hk-0', false, 'unknown_gesture'], `an unknown gesture must be rejected with unknown_gesture, got ${JSON.stringify(unknown)}`);
  rejected.send({ id: 'hk-00', cmd: 'hotkeySubscribe' });
  assert.equal((await rejected.next()).error?.code, 'unknown_gesture', 'a missing gesture is rejected the same way');
  rejected.send({ id: 'diag-r', cmd: 'diagnostics' });
  const afterReject = await rejected.next();
  assert.deepEqual([afterReject.id, afterReject.result?.hotkeySubscribers], ['diag-r', 0], 'a rejected connection keeps serving ordinary requests and registers nothing');
  rejected.socket.destroy();
  console.log('PASS unknown or missing gesture replies unknown_gesture and leaves the connection usable');

  const subscription = await connect();
  subscription.send({ id: 'hk-1', cmd: 'hotkeySubscribe', gesture: 'modPair', excludePids: [process.pid, 1] });
  const reply = await subscription.next();
  assert.equal(reply.id, 'hk-1', 'reply echoes the request id');
  let subscribed = false;
  if (reply.ok) {
    assert.deepEqual(reply.result, { subscribed: true }, 'ok reply is exactly {subscribed:true}');
    subscribed = true;
    console.log('PASS hotkeySubscribe replied ok:true {subscribed:true} (this process tree has an Accessibility grant)');
  } else {
    assert.equal(reply.error?.code, 'accessibility_denied', `denied reply must use accessibility_denied, got ${reply.error?.code}`);
    assert.equal(typeof reply.error?.message, 'string', 'denied reply carries a message');
    console.log('PASS hotkeySubscribe replied ok:false accessibility_denied (expected for an ungranted dev build)');
  }

  await pause(1000);
  assert.equal(subscription.closed, false, 'the connection stays open for 1s');
  console.log('PASS connection stays open for 1s after the reply');

  if (subscribed) {
    assert.equal(await subscribers(), 1, 'one hotkey subscriber while the connection is open');
    const second = await connect();
    second.send({ id: 'hk-2', cmd: 'hotkeySubscribe', gesture: 'modPair' });
    assert.deepEqual((await second.next()).result, { subscribed: true }, 'a second subscriber (no excludePids) is accepted');
    assert.equal(await subscribers(), 2, 'two hotkey subscribers');
    second.socket.destroy();
    const events = subscription.lines.splice(0);
    for (const line of events) {
      assert.equal(typeof line.ev?.t, 'number', 'every streamed line is {"ev":{t,...}}');
      assert.equal(line.ev.kind, 'hotkey', `unexpected event kind ${line.ev?.kind}`);
      assert.equal(line.ev.gesture, 'modPair', 'the event names its gesture');
      assert.ok(line.ev.front === null || typeof line.ev.front?.pid === 'number', 'front is null or an object with a pid');
    }
    console.log(`PASS streamed lines are well-formed hotkey events (count only: ${events.length})`);
    subscription.socket.destroy();
    let after;
    for (let attempt = 0; attempt < 30; attempt++) {
      after = await subscribers();
      if (after === 0) break;
      await pause(100);
    }
    assert.equal(after, 0, 'closing the clients unsubscribes them');
    console.log('PASS closing the clients drops the hotkey subscribers back to 0');
  } else {
    assert.equal(subscription.lines.length, 0, 'a denied connection streams no events');
    subscription.send({ id: 'diag-3', cmd: 'diagnostics' });
    const same = await subscription.next();
    assert.equal(same.id, 'diag-3', 'a denied connection keeps serving ordinary requests');
    assert.equal(same.result.hotkeySubscribers, 0, 'denied subscription registers nothing');
    subscription.socket.destroy();
    console.log('PASS denied connection stays a normal request connection with no subscriber');
  }

  // stdin 模式没有能长开的连接,也没有主线程 run loop:明确拒绝,不装监听。
  const stdio = spawnSync(binary, [], { input: `${JSON.stringify({ id: 'hk-stdin', cmd: 'hotkeySubscribe', gesture: 'modPair' })}\n`, encoding: 'utf8', timeout: 10_000 });
  const stdinReply = JSON.parse(stdio.stdout.split('\n')[0]);
  assert.deepEqual([stdinReply.id, stdinReply.ok, stdinReply.error?.code], ['hk-stdin', false, 'unsupported'], `stdin mode must reply unsupported, got ${stdio.stdout}`);
  console.log('PASS stdin mode replies unsupported');
} finally {
  await request({ id: 'bye', cmd: 'shutdown' }).catch(() => {});
  for (let attempt = 0; attempt < 30 && child && child.exitCode === null && child.signalCode === null; attempt++) await pause(100);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); // 只杀我们自己起的隔离实例,绝不碰用户的常驻 helper
  rmSync(temp, { recursive: true, force: true });
}
