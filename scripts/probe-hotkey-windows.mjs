#!/usr/bin/env node
// 全局手势订阅 Windows 侧(windows-bridge.exe serve 的 hotkeySubscribe)的真机实测台架 —— 只能在 Windows 上跑
// (本机是 mac 时走 CI:.github/workflows/windows-recorder-probe.yml,手动运行或推 ci/windows-recorder* 分支触发)。
//
// 用真命名管道订阅,然后真的往系统里注入左右 Ctrl(keybd_event;低层键盘钩子收得到注入的输入),记事本在前台,断言:
// 回包与事件的形状、恰好触发一次、Ctrl+C 之后再按另一个 Ctrl / 按着 Shift 不触发、按住重复不再触发、excludePids、
// 与电脑历史订阅并存、订阅者数、有手势订阅者时进程不会被空闲看门狗退掉(等过 60 秒)、断开后订阅者归零。
// 跑在 CI 的一次性桌面上,所以事件原样打印。
//
// 用法:node scripts/probe-hotkey-windows.mjs <windows-bridge.exe> [--out probe-hotkey-results.json] [--skip-idle]
// 退出码:必选断言有任何一条失败 → 1。所有事件与断言写进 --out(CI 作为 artifact 上传)。

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const exe = path.resolve(process.argv[2] ?? "native/windows/bridge-rs/target/release/windows-bridge.exe");
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex > 0 ? process.argv[outIndex + 1] : "probe-hotkey-results.json";
const skipIdle = process.argv.includes("--skip-idle");
if (process.platform !== "win32") {
	console.error("probe-hotkey-windows only runs on Windows (use the CI workflow from a mac).");
	process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const findings = {};
function check(name, ok, detail = "", required = true) {
	results.push({ name, ok: !!ok, required, detail });
	console.log(`${ok ? "PASS" : required ? "FAIL" : "INFO"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function ps(script) {
	try {
		return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30_000 }).trim();
	} catch (e) {
		return `ERROR: ${String(e.stderr || e.message).trim()}`;
	}
}

const USER32 = `Add-Type -Name U -Namespace W -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);
';`;

const VK = { LCTRL: 0xa2, RCTRL: 0xa3, LSHIFT: 0xa0, RSHIFT: 0xa1, C: 0x43 };
/** 一次 PowerShell 调用里按顺序注入一串按键:[虚拟键, 按下?]。右 Ctrl 带扩展键标志。 */
function keys(sequence, gapMs = 70) {
	const calls = sequence.map(([vk, down]) => {
		const flags = (vk === VK.RCTRL ? 1 : 0) | (down ? 0 : 2);
		return `[W.U]::keybd_event(${vk},0,${flags},[IntPtr]::Zero); Start-Sleep -Milliseconds ${gapMs}`;
	});
	return ps(`${USER32} ${calls.join("; ")}`);
}
const PAIR = [[VK.LCTRL, true], [VK.RCTRL, true], [VK.RCTRL, false], [VK.LCTRL, false]];

function foreground() {
	const out = ps(`${USER32} $h = [W.U]::GetForegroundWindow(); $p = 0; [W.U]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null; "$($h.ToInt64())|$p|$((Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName)"`);
	const [hwnd, pid, name] = out.split("|");
	return { hwnd: Number(hwnd) || 0, pid: Number(pid) || 0, name: (name ?? "").trim(), raw: out };
}
function focus(hwnd) {
	// 按住 Alt 解除前台锁再置前;Alt 按下抬起之间垫一个空键(F24),免得记事本进菜单模式(与 probe-recorder-windows 同一手法)。
	ps(`${USER32} [W.U]::keybd_event(0x12,0,0,[IntPtr]::Zero); [W.U]::keybd_event(0x87,0,0,[IntPtr]::Zero); [W.U]::keybd_event(0x87,0,2,[IntPtr]::Zero); [W.U]::keybd_event(0x12,0,2,[IntPtr]::Zero); [W.U]::ShowWindow([IntPtr]${hwnd}, 9) | Out-Null; [W.U]::SetForegroundWindow([IntPtr]${hwnd}) | Out-Null`);
}
function mainWindowOf(name) {
	const out = ps(`Get-Process -Name ${name} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { "$($_.Id)|$($_.MainWindowHandle)" }`);
	return out.split(/\r?\n/).filter((l) => l.includes("|")).map((l) => {
		const [pid, hwnd] = l.split("|");
		return { pid: Number(pid), hwnd: Number(hwnd) };
	});
}

// ── 管道 ──

const pipe = `\\\\.\\pipe\\tangu-computer-use-hotkey-probe-${randomBytes(4).toString("hex")}`;
const server = spawn(exe, ["serve", "--pipe", pipe], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
server.on("exit", (code) => console.log(`[probe] serve exited with ${code}`));

/** 发一行请求,首行回包之后的每一行进 lines。 */
function open(request, label) {
	return new Promise((resolve, reject) => {
		const lines = [];
		const socket = net.createConnection(pipe);
		let buffer = "";
		let reply = null;
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const part of parts) {
				if (!part.trim()) continue;
				const message = JSON.parse(part);
				if (!reply) {
					reply = message;
					clearTimeout(timer);
					resolve({ reply, lines, socket, events: () => lines.map((l) => l.ev).filter((ev) => ev?.kind === "hotkey") });
					continue;
				}
				lines.push(message);
				console.log(`[line:${label}] ${JSON.stringify(message)}`);
			}
		});
		socket.on("error", reject);
		// 只在回包之前生效。
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("reply timeout")); }, 5_000);
	});
}

async function openWithRetry(request, label) {
	for (let i = 0; i < 40; i++) {
		try {
			return await open(request, label);
		} catch (e) {
			if (!String(e.code || e.message).match(/ENOENT|EBUSY|timeout/)) throw e;
			await sleep(250);
		}
	}
	throw new Error("could not connect to the serve pipe");
}

async function diagnostics() {
	try {
		const { reply, socket } = await open({ id: "diag", cmd: "diagnostics" }, "diag");
		socket.destroy();
		return reply.result ?? {};
	} catch {
		return {};
	}
}

/** 注入一串按键,等投递,返回订阅 a 新收到的手势事件。 */
async function gesture(subscription, sequence) {
	const before = subscription.events().length;
	const output = keys(sequence);
	if (output.startsWith("ERROR")) console.log(`[probe] key injection: ${output}`);
	await sleep(900);
	return subscription.events().slice(before);
}

async function main() {
	const a = await openWithRetry({ id: "hk_a", cmd: "hotkeySubscribe", gesture: "modPair", excludePids: [] }, "a");
	check("hotkeySubscribe reply is exactly {subscribed:true}", a.reply?.id === "hk_a" && a.reply?.ok === true && JSON.stringify(a.reply?.result) === '{"subscribed":true}', JSON.stringify(a.reply));

	const unknown = await open({ id: "hk_x", cmd: "hotkeySubscribe", gesture: "tripleTap" }, "x");
	check("an unknown gesture is rejected with unknown_gesture", unknown.reply?.ok === false && unknown.reply?.error?.code === "unknown_gesture", JSON.stringify(unknown.reply));
	unknown.socket.destroy();
	const missing = await open({ id: "hk_y", cmd: "hotkeySubscribe" }, "y");
	check("a missing gesture is rejected with unknown_gesture", missing.reply?.error?.code === "unknown_gesture", JSON.stringify(missing.reply));
	missing.socket.destroy();

	let diag = await diagnostics();
	check("diagnostics counts the hotkey subscriber and no recorder subscriber", diag.hotkeySubscribers === 1 && diag.subscribers === 0, JSON.stringify(diag));
	check("the recorder's own hooks are not installed for a hotkey subscription", diag.hooks === 0, JSON.stringify(diag));

	// ── 记事本在前台 ──
	const notepad = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
	notepad.unref();
	await sleep(2500);
	const np = mainWindowOf("notepad")[0] ?? { pid: notepad.pid, hwnd: 0 };
	if (np.hwnd) focus(np.hwnd);
	await sleep(1200);
	let fg = foreground();
	findings.notepad = np;
	findings.foreground = fg;
	check("Notepad is the foreground window", fg.hwnd !== 0 && fg.name.toLowerCase() === "notepad", JSON.stringify(fg));

	// ── 手势 ──
	const t0 = Date.now();
	let fired = await gesture(a, PAIR);
	const first = fired[0];
	findings.firstEvent = first;
	check("left Ctrl then right Ctrl fires exactly once", fired.length === 1, JSON.stringify(fired));
	check("the event is {t,kind,gesture,front}", !!first && Object.keys(first).sort().join() === "front,gesture,kind,t" && first.gesture === "modPair", JSON.stringify(first));
	check("t is the epoch time of the gesture", typeof first?.t === "number" && first.t >= t0 - 1000 && first.t <= Date.now() + 1000, `${first?.t} vs ${t0}`);
	const front = first?.front;
	check("front has exactly exe, path, app, pid, windowId, title", !!front && Object.keys(front).sort().join() === "app,exe,path,pid,title,windowId", JSON.stringify(front));
	check("front.exe is the lower-case file name", front?.exe === `${fg.name.toLowerCase()}.exe`, `${front?.exe} vs ${fg.name}`);
	check("front.path is the full path of that exe", typeof front?.path === "string" && /^[a-z]:\\/i.test(front.path) && front.path.toLowerCase().endsWith(`\\${front.exe}`), String(front?.path));
	check("front.app is a display name", typeof front?.app === "string" && front.app.length > 0, String(front?.app));
	check("front.pid owns the foreground window", front?.pid === fg.pid, `${front?.pid} vs ${fg.pid}`);
	check("front.windowId is the foreground HWND", front?.windowId === fg.hwnd, `${front?.windowId} vs ${fg.hwnd}`);
	check("front.title is the window title", typeof front?.title === "string" && front.title.length > 0, String(front?.title));

	fired = await gesture(a, [[VK.RCTRL, true], [VK.LCTRL, true], [VK.LCTRL, false], [VK.RCTRL, false]]);
	check("right Ctrl then left Ctrl fires once", fired.length === 1, JSON.stringify(fired));

	fired = await gesture(a, [[VK.LCTRL, true], [VK.C, true], [VK.C, false], [VK.RCTRL, true], [VK.RCTRL, false], [VK.LCTRL, false]]);
	check("Ctrl+C then the other Ctrl does not fire", fired.length === 0, JSON.stringify(fired));

	fired = await gesture(a, [[VK.LSHIFT, true], [VK.LCTRL, true], [VK.RCTRL, true], [VK.RCTRL, false], [VK.LCTRL, false], [VK.LSHIFT, false]]);
	check("holding Shift does not fire", fired.length === 0, JSON.stringify(fired));

	fired = await gesture(a, [[VK.LCTRL, true], [VK.LCTRL, false], [VK.RCTRL, true], [VK.RCTRL, false]]);
	check("one Ctrl after the other without overlap does not fire", fired.length === 0, JSON.stringify(fired));

	fired = await gesture(a, [[VK.LCTRL, true], [VK.LCTRL, true], [VK.RCTRL, true], [VK.RCTRL, true], [VK.LCTRL, true], [VK.RCTRL, false], [VK.RCTRL, true], [VK.RCTRL, false], [VK.LCTRL, false]]);
	check("key repeat and re-pressing one key while the other is held fire only once", fired.length === 1, JSON.stringify(fired));

	// ── 0.7.1:双 Shift 是另一个手势;订 shiftPair 的只收它,订 modPair 的收不到它 ──
	const sp = await open({ id: "hk_s", cmd: "hotkeySubscribe", gesture: "shiftPair", excludePids: [] }, "s");
	check("a shiftPair subscription is accepted", sp.reply?.ok === true, JSON.stringify(sp.reply));
	const aBefore = a.events().length;
	fired = await gesture(sp, [[VK.LSHIFT, true], [VK.RSHIFT, true], [VK.RSHIFT, false], [VK.LSHIFT, false]]);
	check("both Shift keys fire shiftPair once, to the shiftPair subscriber only", fired.length === 1 && fired[0]?.gesture === "shiftPair" && a.events().length === aBefore, JSON.stringify(fired));
	fired = await gesture(sp, PAIR);
	check("both Ctrl keys do not reach the shiftPair subscriber", fired.length === 0, JSON.stringify(fired));
	sp.socket.destroy();
	await sleep(300);

	// ── excludePids:订阅方自己的进程在前台时不推 ──
	fg = foreground();
	const b = await open({ id: "hk_b", cmd: "hotkeySubscribe", gesture: "modPair", excludePids: [fg.pid, 4] }, "b");
	check("a second subscriber is accepted", b.reply?.ok === true, JSON.stringify(b.reply));
	diag = await diagnostics();
	check("diagnostics counts two hotkey subscribers", diag.hotkeySubscribers === 2, JSON.stringify(diag));
	fired = await gesture(a, PAIR);
	check("a subscriber that does not exclude the foreground pid gets the event", fired.length === 1, JSON.stringify(fired));
	check("a subscriber that excludes the foreground pid gets nothing", b.events().length === 0 && b.lines.length === 0, JSON.stringify(b.lines));
	b.socket.destroy();
	await sleep(800);
	diag = await diagnostics();
	check("closing a connection unsubscribes it", diag.hotkeySubscribers === 1, JSON.stringify(diag));

	// ── 与电脑历史订阅并存:两边各自的钩子都在,手势照样只报一次,电脑历史那条连接收不到手势事件 ──
	const recorder = await open({ id: "rec", cmd: "recordSubscribe", policy: {} }, "rec");
	check("recordSubscribe still answers on the same serve process", recorder.reply?.ok === true && recorder.reply?.result?.subscribed === true, JSON.stringify(recorder.reply));
	await sleep(1500);
	diag = await diagnostics();
	check("diagnostics counts both kinds of subscribers", diag.hotkeySubscribers === 1 && diag.subscribers === 1, JSON.stringify(diag));
	fired = await gesture(a, PAIR);
	check("the gesture still fires once while the recorder is subscribed", fired.length === 1, JSON.stringify(fired));
	check("the recorder connection never carries hotkey events", !recorder.lines.some((l) => l.ev?.kind === "hotkey"), "");
	recorder.socket.destroy();
	await sleep(1500);

	// ── 空闲看门狗:最后一个电脑历史订阅者走后 60 秒进程会自己退,但有手势订阅者时不能退 ──
	if (!skipIdle) {
		console.log("[probe] waiting 75s to outlive the idle watchdog…");
		await sleep(75_000);
		check("serve stays alive past the idle timeout while a hotkey subscriber is connected", server.exitCode === null, `exitCode ${server.exitCode}`);
		fired = await gesture(a, PAIR);
		check("the gesture still fires after the idle timeout", fired.length === 1, JSON.stringify(fired));
	}

	check("every streamed line is a hotkey ev", a.lines.every((l) => l.ev?.kind === "hotkey" && typeof l.ev.t === "number"), "");
	findings.events = a.events();
	a.socket.destroy();
	await sleep(1000);
	diag = await diagnostics();
	check("the last subscriber leaving drops the count to zero", diag.hotkeySubscribers === 0, JSON.stringify(diag));
	const late = keys(PAIR);
	check("keys can still be injected after the hook is removed", !late.startsWith("ERROR"), late, false);

	try { process.kill(np.pid); } catch { /* 已经关了 */ }
}

let failed = false;
try {
	await main();
} catch (e) {
	failed = true;
	check("probe ran to completion", false, String(e?.stack || e));
} finally {
	server.kill();
	writeFileSync(outPath, JSON.stringify({ results, findings }, null, 1));
}
const requiredFailures = results.filter((r) => r.required && !r.ok);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed; ${requiredFailures.length} required failure(s)`);
process.exit(failed || requiredFailures.length ? 1 : 0);
