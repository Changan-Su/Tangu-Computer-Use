#!/usr/bin/env node
// 电脑历史 Windows 采集器(windows-bridge.exe serve)的真机实测台架 —— 只能在 Windows 上跑(本机是 mac 时走 CI:
// .github/workflows/windows-recorder-probe.yml,推 ci/windows-recorder* 分支触发)。
//
// 用真命名管道订阅 recordSubscribe,然后真的操作桌面:记事本打字 / 组合键 / 点菜单,stdio 助手 focusWindow(agent 标记),
// Chrome 普通窗口(标题 + 网址 + 排除站点)、Chrome 无痕 / Edge InPrivate(只能留不带标题的切换)、网页输入框与密码框。
// 输入走 SendKeys / mouse_event(注入的输入;采集器不按注入标记判 agent,所以照常记)。
//
// 用法:node scripts/probe-recorder-windows.mjs <windows-bridge.exe> [--out probe-results.json]
// 退出码:必选断言有任何一条失败 → 1。所有事件与断言写进 --out(CI 作为 artifact 上传)。

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const exe = path.resolve(process.argv[2] ?? "native/windows/bridge-rs/target/release/windows-bridge.exe");
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex > 0 ? process.argv[outIndex + 1] : "probe-results.json";
if (process.platform !== "win32") {
	console.error("probe-recorder-windows only runs on Windows (use the CI workflow from a mac).");
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
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);
public struct RECT { public int L; public int T; public int R; public int B; }
';`;

function mainWindow(pid) {
	return Number(ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`)) || 0;
}
function mainWindowOf(name) {
	const out = ps(`Get-Process -Name ${name} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { "$($_.Id)|$($_.MainWindowHandle)|$($_.MainWindowTitle)" }`);
	return out.split(/\r?\n/).filter((l) => l.includes("|")).map((l) => {
		const [pid, hwnd, ...title] = l.split("|");
		return { pid: Number(pid), hwnd: Number(hwnd), title: title.join("|") };
	});
}
function focus(hwnd) {
	// Alt 轻敲一下解除前台锁(SetForegroundWindow 对后台进程的限制),再置前。
	ps(`${USER32} [W.U]::keybd_event(0x12,0,0,[IntPtr]::Zero); [W.U]::keybd_event(0x12,0,2,[IntPtr]::Zero); [W.U]::ShowWindow([IntPtr]${hwnd}, 9) | Out-Null; [W.U]::SetForegroundWindow([IntPtr]${hwnd}) | Out-Null`);
}
function sendKeys(keys) {
	ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')`);
}
function clickAt(x, y) {
	ps(`${USER32} [W.U]::SetCursorPos(${x}, ${y}) | Out-Null; Start-Sleep -Milliseconds 100; [W.U]::mouse_event(2,0,0,0,[IntPtr]::Zero); [W.U]::mouse_event(4,0,0,0,[IntPtr]::Zero)`);
}
function windowRect(hwnd) {
	const out = ps(`${USER32} $r = New-Object W.U+RECT; [W.U]::GetWindowRect([IntPtr]${hwnd}, [ref]$r) | Out-Null; "$($r.L),$($r.T),$($r.R),$($r.B)"`);
	const [l, t, r, b] = out.split(",").map(Number);
	return { l, t, r, b };
}

// ── 管道订阅 ──

const user = randomBytes(4).toString("hex");
const pipe = `\\\\.\\pipe\\tangu-computer-use-recorder-probe-${user}`;
const server = spawn(exe, ["serve", "--pipe", pipe], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true, env: { ...process.env, TANGU_RECORDER_DEBUG: "1" } });
server.on("exit", (code) => console.log(`[probe] serve exited with ${code}`));

function subscribe(policy, label) {
	return new Promise((resolve, reject) => {
		const events = [];
		const socket = net.createConnection(pipe);
		let buffer = "";
		let reply = null;
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify({ id: `probe_${label}`, cmd: "recordSubscribe", policy })}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const msg = JSON.parse(line);
				if (!reply) {
					reply = msg;
					clearTimeout(timer);
					resolve({ reply, events, socket });
					continue;
				}
				if (msg.ev) {
					events.push(msg.ev);
					console.log(`[ev:${label}] ${JSON.stringify(msg.ev)}`);
				}
			}
		});
		socket.on("error", reject);
		// 只在回包之前生效(成功后清掉 —— 第四轮就是这个计时器到点把好好的订阅连接 destroy 了)。
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("subscribe timeout")); }, 5_000);
	});
}

async function connectWithRetry(policy, label) {
	for (let i = 0; i < 40; i++) {
		try {
			return await subscribe(policy, label);
		} catch (e) {
			if (i % 10 === 0) console.log(`[probe] connect attempt ${i} (${label}): ${e.code || e.message}`);
			if (!String(e.code || e.message).match(/ENOENT|EBUSY|timeout/)) throw e;
			await sleep(250);
		}
	}
	throw new Error("could not connect to the recorder pipe");
}

const since = (events, t0) => events.filter((e) => e.t >= t0 - 50);
/** recorder 线程此刻卡在哪一步(phase / phaseMs / backlog),每个场景后打一行,卡死时直接看出卡在哪个 UIA 调用。 */
async function logDiag(label) {
	const d = await diagnostics();
	console.log(`[probe] diag after ${label}: ${JSON.stringify(d?.result)}`);
	(findings.diag ??= []).push({ label, ...d?.result });
}

async function main() {
	const main = await connectWithRetry({}, "open");
	check("recordSubscribe reply", main.reply?.ok === true && main.reply?.result?.protocolVersion === 13 && main.reply?.result?.axTrusted === true, JSON.stringify(main.reply));
	await sleep(1500);
	findings.initialEvents = main.events.slice();
	check("initial snapshot or system state", main.events.length > 0, JSON.stringify(main.events.slice(0, 3)));
	if (main.events.some((e) => e.kind === "system" && e.state === "locked")) {
		check("session is not locked on the runner", false, "the recorder thinks the input desktop is locked; nothing else can be observed");
	}

	// ── 记事本:切换、打字、组合键、点菜单 ──
	let t0 = Date.now();
	const notepad = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
	await sleep(2500);
	const npWindows = mainWindowOf("notepad");
	const np = npWindows.find((w) => w.hwnd) ?? { hwnd: mainWindow(notepad.pid), pid: notepad.pid };
	findings.notepad = np;
	focus(np.hwnd);
	await sleep(1500);
	await logDiag("notepad-switch");
	const npEvents = () => since(main.events, t0).filter((e) => e.app?.bundleId === "notepad.exe");
	check("switching to Notepad emits an app event with the exe name", npEvents().some((e) => e.kind === "app"), JSON.stringify(npEvents().slice(0, 2)));
	check("Notepad app event has a display name", npEvents().some((e) => e.kind === "app" && e.app?.name && e.app.name !== "notepad.exe"), JSON.stringify(npEvents().find((e) => e.kind === "app")?.app));

	t0 = Date.now();
	sendKeys("hello world");
	await sleep(3500);
	const typed = since(main.events, t0).filter((e) => e.kind === "text");
	check("typing in Notepad produces a text event", typed.some((e) => e.text?.includes("hello world")), JSON.stringify(typed));
	await logDiag("notepad-typing");
	check("text event carries the field role", typed.some((e) => typeof e.el?.role === "string"), JSON.stringify(typed[0]?.el));

	t0 = Date.now();
	sendKeys("^a");
	await sleep(800);
	const keys = since(main.events, t0).filter((e) => e.kind === "key");
	check("Ctrl+A is recorded as a shortcut", keys.some((e) => e.keys === "Ctrl+A"), JSON.stringify(keys));
	sendKeys("{DEL}");
	await sleep(2500);

	t0 = Date.now();
	const rect = windowRect(np.hwnd);
	findings.notepadRect = rect;
	// 经典记事本:标题栏下方第一项菜单「File / 文件」
	clickAt(rect.l + 30, rect.t + 45);
	await sleep(1200);
	sendKeys("{ESC}");
	await sleep(500);
	await logDiag("notepad-click");
	const clicks = since(main.events, t0).filter((e) => e.kind === "click");
	check("clicking a menu item records role and label", clicks.some((e) => e.el?.role === "MenuItem" && e.el?.label), JSON.stringify(clicks), false);
	check("a click in Notepad is recorded", clicks.length > 0, JSON.stringify(clicks));

	// ── agent 标记:stdio 助手 focusWindow 期间切过去的前台 → origin:"agent" ──
	const explorer = spawn("explorer.exe", [os.tmpdir()], { detached: true, stdio: "ignore" });
	await sleep(2500);
	const other = mainWindowOf("explorer").find((w) => w.title) ;
	if (other) focus(other.hwnd);
	await sleep(1200);
	t0 = Date.now();
	const agentResult = await stdioFocus(np.pid);
	findings.agentFocus = agentResult;
	await sleep(1500);
	await logDiag("agent-focus");
	const agentEvents = since(main.events, t0).filter((e) => e.app?.bundleId === "notepad.exe");
	check("foreground change by the agent carries origin=agent", agentEvents.some((e) => e.origin === "agent"), JSON.stringify(agentEvents));
	explorer.unref();

	// ── 浏览器 ──
	const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find(existsSync);
	const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
	const flags = (dir) => [`--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen", "--disable-features=PrivacySandboxSettings4"];
	if (chrome) {
		const siteOff = await connectWithRetry({ excludeDomains: ["example.com"] }, "siteOff");
		t0 = Date.now();
		const profile = mkdtempSync(path.join(os.tmpdir(), "probe-chrome-"));
		spawn(chrome, [...flags(profile), "https://example.com/?q=secret#frag"], { detached: true, stdio: "ignore" }).unref();
		await sleep(7000);
		const win = mainWindowOf("chrome").find((w) => w.title);
		findings.chromeNormal = win;
		if (win) focus(win.hwnd);
		// 第一次遍历可能走不完(Chrome 此刻才打开无障碍):采集器按无痕先不记,约 1 秒后自己重走,这里多等几轮。
		await sleep(6000);
		const ev = since(main.events, t0).filter((e) => e.app?.bundleId === "chrome.exe");
		check("Chrome normal window has a title", ev.some((e) => e.title?.includes("Example")), JSON.stringify(ev.slice(-3)));
		check("Chrome URL is read and sanitized", ev.some((e) => /^https:\/\/example\.com\/?$/.test(e.url ?? "")), JSON.stringify(ev.map((e) => e.url)));
		const off = since(siteOff.events, t0).filter((e) => e.app?.bundleId === "chrome.exe");
		check("an excluded site leaves only a content-free marker", off.length > 0 && off.every((e) => !e.title && !e.url && (e.app?.excluded || e.kind === "app")), JSON.stringify(off.slice(-3)));
		siteOff.socket.destroy();

		// 网页输入框与密码框
		t0 = Date.now();
		spawn(chrome, [...flags(profile), "data:text/html,<title>Form</title><input id=a autofocus placeholder=Name>"], { detached: true, stdio: "ignore" }).unref();
		await sleep(4000);
		const formWin = mainWindowOf("chrome").find((w) => w.title.startsWith("Form"));
		if (formWin) focus(formWin.hwnd);
		await sleep(1500);
		sendKeys("plain words");
		await sleep(3500);
		const webText = since(main.events, t0).filter((e) => e.kind === "text");
		check("typing in a web input is recorded", webText.some((e) => e.text?.includes("plain words")), JSON.stringify(webText), false);
		t0 = Date.now();
		spawn(chrome, [...flags(profile), "data:text/html,<title>Login</title><input type=password autofocus>"], { detached: true, stdio: "ignore" }).unref();
		await sleep(4000);
		const loginWin = mainWindowOf("chrome").find((w) => w.title.startsWith("Login"));
		if (loginWin) focus(loginWin.hwnd);
		await sleep(1500);
		sendKeys("hunter2secret");
		await sleep(3500);
		const leaked = since(main.events, t0).filter((e) => JSON.stringify(e).includes("hunter2"));
		check("password fields are never recorded", leaked.length === 0, JSON.stringify(leaked));

		// 无痕:先关掉前面的普通窗口,免得前台落回普通窗口时误判
		ps("Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force");
		await sleep(1500);
		t0 = Date.now();
		spawn(chrome, [...flags(profile), "--incognito", "https://example.com/incognito-page"], { detached: true, stdio: "ignore" }).unref();
		await sleep(6000);
		const incognito = mainWindowOf("chrome");
		findings.chromeIncognitoTitles = incognito.map((w) => w.title);
		const incWin = incognito[0];
		if (incWin) focus(incWin.hwnd);
		await sleep(2500);
		const incEvents = since(main.events, t0).filter((e) => e.app?.bundleId === "chrome.exe");
		findings.chromeIncognitoEvents = incEvents;
		check("the incognito window was observed at all", incEvents.length > 0, JSON.stringify(incEvents));
		check("Chrome incognito never leaks title or URL", incEvents.every((e) => !String(e.title ?? "").length || !/incognito-page|Example/.test(e.title)) && incEvents.every((e) => !String(e.url ?? "").includes("incognito-page")), JSON.stringify(incEvents));
	} else {
		check("Chrome is installed on the runner", false, "skipped Chrome scenarios", false);
	}
	if (edge) {
		t0 = Date.now();
		const profile = mkdtempSync(path.join(os.tmpdir(), "probe-edge-"));
		spawn(edge, [...flags(profile), "--inprivate", "https://example.com/inprivate-page"], { detached: true, stdio: "ignore" }).unref();
		await sleep(8000);
		const wins = mainWindowOf("msedge");
		findings.edgeInPrivateTitles = wins.map((w) => w.title);
		const w = wins.find((x) => /inprivate/i.test(x.title)) ?? wins.at(-1);
		if (w) focus(w.hwnd);
		await sleep(2500);
		const edgeEvents = since(main.events, t0).filter((e) => e.app?.bundleId === "msedge.exe");
		findings.edgeInPrivateEvents = edgeEvents;
		check("the InPrivate window was observed at all", edgeEvents.length > 0, JSON.stringify(edgeEvents));
		check("Edge InPrivate never leaks title or URL", edgeEvents.every((e) => !/inprivate-page|Example/.test(e.title ?? "") && !String(e.url ?? "").includes("inprivate-page")), JSON.stringify(edgeEvents));
	} else {
		check("Edge is installed on the runner", false, "skipped Edge scenarios", false);
	}

	// ── 退订后采集器拆干净、空闲后退出 ──
	main.socket.destroy();
	findings.allEvents = main.events;
	await sleep(1000);
	const diag = await diagnostics();
	check("diagnostics after unsubscribe reports no subscribers", diag?.result?.subscribers === 0, JSON.stringify(diag));
	notepad.unref();
}

function diagnostics() {
	return new Promise((resolve) => {
		const s = net.createConnection(pipe);
		let buf = "";
		s.setEncoding("utf8");
		s.on("connect", () => s.write(`${JSON.stringify({ id: "diag", cmd: "diagnostics" })}\n`));
		s.on("data", (c) => { buf += c; if (buf.includes("\n")) { s.destroy(); resolve(JSON.parse(buf.split("\n")[0])); } });
		s.on("error", () => resolve(null));
		setTimeout(() => resolve(null), 5000);
	});
}

/** stdio 助手:listRoots(pid) → focusWindow(rootRef)。 */
function stdioFocus(pid) {
	return new Promise((resolve) => {
		const child = spawn(exe, [], { stdio: ["pipe", "pipe", "inherit"] });
		let buf = "";
		const send = (id, cmd, args) => child.stdin.write(`${JSON.stringify({ protocolVersion: 4, id, cmd, args })}\n`);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buf += chunk;
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const msg = JSON.parse(line);
				if (msg.id === "roots") {
					const root = (msg.result?.roots ?? msg.result?.windows ?? []).find((r) => r.rootRef);
					if (!root) { child.kill(); return resolve({ error: "no root", msg }); }
					send("focus", "focusWindow", { rootRef: root.rootRef });
				} else if (msg.id === "focus") {
					setTimeout(() => child.kill(), 1500);
					resolve(msg);
				}
			}
		});
		send("roots", "listRoots", { pid });
		setTimeout(() => { child.kill(); resolve({ error: "timeout" }); }, 15_000);
	});
}

try {
	await main();
} catch (e) {
	check("probe ran to completion", false, String(e?.stack || e));
}
writeFileSync(outPath, JSON.stringify({ results, findings }, null, 2));
server.kill();
const failed = results.filter((r) => r.required && !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
