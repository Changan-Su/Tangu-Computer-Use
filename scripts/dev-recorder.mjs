#!/usr/bin/env node
// 电脑历史 recorder 的真机台架(macOS)。把 `npm run build:native` 编出的 helper 包成一个**独立 bundle id**
// (com.forsion.tangu-computer-use.dev)的 app,用本机稳定的签名身份签 —— 于是:
//   - 辅助功能授权只给一次,重编不丢(ad-hoc 每次 cdhash 都变,得重新授权);
//   - 与正式 helper(com.forsion.tangu-computer-use)是两条 TCC 记录、两个 socket,绝不动用户正在用的 Computer Use 授权。
// 用法:
//   node scripts/dev-recorder.mjs build            -> build/tangu-computer-use-dev.app
//   node scripts/dev-recorder.mjs start            -> open -n -g 拉起 serve(socket 见下)
//   node scripts/dev-recorder.mjs grant            -> 弹辅助功能授权框(授权后 stop + start)
//   node scripts/dev-recorder.mjs tail [秒] [--show] -> 订阅并逐条打印(缺省只打 kind/App/长度,--show 才打内容)
//   node scripts/dev-recorder.mjs stop
//   node scripts/dev-recorder.mjs diag           -> 订阅者数 + 无痕扫描计数(recorderPrivateScan*,只有计数):
//                                                   浏览器窗口的遍历走了几次、几次没看完、各因什么停手
// Desktop 接这个 helper:PI_CU_SOCKET_PATH=<下面的 socket> 起 dev 实例。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const app = path.join(root, 'build/tangu-computer-use-dev.app');
export const socketPath = path.join(os.homedir(), 'Library/Caches/tangu-computer-use-dev/bridge.sock');
const [cmd = 'tail', ...rest] = process.argv.slice(2);
const show = rest.includes('--show');
const seconds = Number(rest.find((a) => /^\d+$/.test(a)) ?? 60);

function request(payload, { stream = false, onEvent } = {}) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = '';
		let first;
		socket.setEncoding('utf8');
		socket.on('connect', () => socket.write(JSON.stringify({ id: 'dev', ...payload }) + '\n'));
		socket.on('data', (chunk) => {
			buffer += chunk;
			let i;
			while ((i = buffer.indexOf('\n')) >= 0) {
				const line = JSON.parse(buffer.slice(0, i));
				buffer = buffer.slice(i + 1);
				if (first === undefined) {
					first = line;
					if (!stream || !line.ok) { socket.end(); resolve(line); }
					else resolve({ reply: line, socket });
				} else if (line.ev) onEvent?.(line.ev);
			}
		});
		socket.on('error', reject);
	});
}

if (cmd === 'build') {
	const binary = path.join(root, 'prebuilt/macos', process.arch === 'x64' ? 'x64' : 'arm64', 'bridge');
	if (!existsSync(binary)) throw new Error('run `npm run build:native` first');
	rmSync(app, { recursive: true, force: true });
	mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
	copyFileSync(binary, path.join(app, 'Contents/MacOS/bridge'));
	writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.forsion.tangu-computer-use.dev</string>
<key>CFBundleName</key><string>tangu-computer-use-dev</string>
<key>CFBundleExecutable</key><string>bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`);
	const ids = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
	const identity = ids.match(/"(Apple Development:[^"]+)"/)?.[1] ?? '-';
	execFileSync('codesign', ['--force', '--sign', identity, app], { stdio: 'inherit', timeout: 30_000 });
	console.log(`built ${app} (signed: ${identity === '-' ? 'ad-hoc — grant is lost on every rebuild' : identity})`);
} else if (cmd === 'start') {
	mkdirSync(path.dirname(socketPath), { recursive: true });
	execFileSync('open', ['-n', '-g', app, '--args', 'serve', '--socket', socketPath]);
	for (let i = 0; i < 20 && !existsSync(socketPath); i++) execFileSync('sleep', ['0.25']);
	console.log(existsSync(socketPath) ? `serving on ${socketPath}` : 'helper did not come up');
} else if (cmd === 'grant') {
	// 让 dev helper 出现在「辅助功能」列表里并弹系统授权框(只要辅助功能,不碰屏幕录制)。授权后要 stop + start 换新进程。
	console.log(JSON.stringify(await request({ cmd: 'registerPermissions', kind: 'accessibility' })));
} else if (cmd === 'diag') {
	const res = await request({ cmd: 'diagnostics' });
	if (!res.ok) { console.log(JSON.stringify(res)); process.exit(1); }
	const keys = ['protocolVersion', 'accessibility', 'recorderSubscribers', 'recorderPrivateScans', 'recorderPrivateScanIncomplete', 'recorderPrivateScanStops'];
	console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, res.result[key]])), null, 1));
} else if (cmd === 'stop') {
	console.log(await request({ cmd: 'shutdown' }).catch((e) => `not running (${e.code})`));
} else if (cmd === 'tail') {
	const counts = {};
	const res = await request({ cmd: 'recordSubscribe', policy: {} }, {
		stream: true,
		onEvent: (ev) => {
			const key = `${ev.app?.name ?? '-'} ${ev.kind}`;
			counts[key] = (counts[key] ?? 0) + 1;
			const time = new Date(ev.t).toTimeString().slice(0, 8);
			const detail = show
				? JSON.stringify({ title: ev.title, url: ev.url, el: ev.el, text: ev.text, keys: ev.keys, state: ev.state, resumed: ev.resumed })
				: `title=${ev.title?.length ?? '-'} url=${ev.url ? 'y' : '-'} text=${ev.text?.length ?? (ev.deleted ? `-${ev.deleted}` : '-')} el=${ev.el?.role ?? '-'}${ev.keys ? ' keys' : ''}${ev.state ? ` ${ev.state}` : ''}${ev.origin ? ' agent' : ''}${ev.app?.excluded ? ' excluded' : ''}${ev.resumed ? ' resumed' : ''}`;
			console.log(`${time} ${ev.kind.padEnd(6)} ${(ev.app?.name ?? '').padEnd(22)} ${detail}`);
		},
	});
	if (!res.socket) { console.log('subscribe failed:', JSON.stringify(res)); process.exit(1); }
	console.log('subscribed:', JSON.stringify(res.reply.result));
	setTimeout(() => { res.socket.end(); console.log('\ncounts:', JSON.stringify(counts, null, 1)); process.exit(0); }, seconds * 1000);
} else {
	throw new Error(`unknown command ${cmd}`);
}
