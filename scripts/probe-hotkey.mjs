#!/usr/bin/env node
// 全局手势订阅(hotkeySubscribe)的真机探针:连上一个**已经在跑**的 helper,订阅 modPair,逐条打印收到的事件。
// 手势只能人手按(左右 ⌘ 同时按;Windows 上是左右 Ctrl)—— 本脚本不往系统里发任何按键。
//
// 用法:
//   node scripts/probe-hotkey.mjs [秒=30] [--socket <路径>] [--exclude <pid,pid>] [--show]
// 缺省连 macOS 的 dev helper(`node scripts/dev-recorder.mjs build && … start` 起的那个,独立 bundle id、独立 socket,
// 不碰正式 helper 的授权);Windows 上用 --socket 给出 `windows-bridge.exe serve --pipe <名字>` 的管道名。
// 缺省只打印 App 标识与标题的**长度**,--show 才打印标题与路径本身。
// 先后各问一次 diagnostics,核对订阅者数:订阅期间 +1,断开后回到原值。
// 退出码:回包不是 ok(没授权 = accessibility_denied、老 helper = unknown_command)→ 1。
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const show = args.includes('--show');
const seconds = Number(args.find((arg, index) => /^\d+$/.test(arg) && !['--socket', '--exclude'].includes(args[index - 1])) ?? 30);
const excludePids = (option('--exclude') ?? '').split(',').map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
const socketPath = option('--socket') ?? (process.platform === 'darwin'
	? path.join(os.homedir(), 'Library/Caches/tangu-computer-use-dev/bridge.sock')
	: undefined);
if (!socketPath) throw new Error('pass --socket <named pipe> on this platform');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function open(payload, onLine) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = '';
		let first = true;
		socket.setEncoding('utf8');
		socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on('data', (chunk) => {
			buffer += chunk;
			let index;
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (!line.trim()) continue;
				const message = JSON.parse(line);
				if (first) { first = false; resolve({ reply: message, socket }); } else onLine?.(message);
			}
		});
		socket.on('error', reject);
	});
}

async function diagnostics() {
	const { reply, socket } = await open({ id: 'probe-diag', cmd: 'diagnostics' });
	socket.destroy();
	return reply.result ?? {};
}

function describe(front) {
	if (front === null) return 'front=null';
	return Object.entries(front).map(([key, value]) => {
		if ((key === 'title' || key === 'path') && !show) return `${key}=<${String(value).length} chars>`;
		return `${key}=${JSON.stringify(value)}`;
	}).join(' ');
}

const before = await diagnostics();
console.log(`helper: protocol ${before.protocolVersion}, accessibility ${before.accessibility ?? 'n/a'}, hotkeySubscribers ${before.hotkeySubscribers}`);

let count = 0;
const { reply, socket } = await open({ id: 'probe-hotkey', cmd: 'hotkeySubscribe', gesture: 'modPair', excludePids }, (message) => {
	const event = message.ev;
	if (event?.kind !== 'hotkey') { console.log(`other line: ${JSON.stringify(Object.keys(message))} kind=${event?.kind ?? '-'}`); return; }
	count += 1;
	console.log(`${new Date(event.t).toTimeString().slice(0, 8)} hotkey ${event.gesture} ${describe(event.front)}`);
});
if (!reply.ok) {
	console.log(`subscribe failed: ${JSON.stringify(reply.error)}`);
	socket.destroy();
	process.exit(1);
}
console.log(`subscribed: ${JSON.stringify(reply)}${excludePids.length ? ` (excluding pids ${excludePids.join(', ')})` : ''}`);
const during = await diagnostics();
console.log(`hotkeySubscribers while subscribed: ${during.hotkeySubscribers}`);
console.log(`listening for ${seconds}s — press both ${process.platform === 'darwin' ? 'Command' : 'Ctrl'} keys together in any app…`);
await pause(seconds * 1000);
socket.destroy();
let after;
for (let attempt = 0; attempt < 30; attempt++) {
	after = await diagnostics();
	if (after.hotkeySubscribers === before.hotkeySubscribers) break;
	await pause(100);
}
console.log(`events: ${count}; hotkeySubscribers after disconnect: ${after.hotkeySubscribers} (was ${before.hotkeySubscribers})`);
process.exit(after.hotkeySubscribers === before.hotkeySubscribers ? 0 : 1);
