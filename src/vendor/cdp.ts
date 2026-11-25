// Minimal Chrome DevTools Protocol client.
//
// Opt-in: set PI_COMPUTER_USE_CDP_PORT to the --remote-debugging-port of a
// running Chromium-family browser. When active, navigate_browser uses
// Page.navigate (event-driven, no AppleScript) and recent console messages
// and uncaught exceptions are attached to tool results. Everything else
// keeps the AX/CGEvent path, so with the env var unset this module is inert.

import WebSocket from "ws";
import { browserOwner, browserPort } from "../managedBrowser.ts";
import { randomUUID } from "node:crypto";
import { parseLookResponse, serializeOutline, type SerializedOutline } from "./outline.ts";

export interface CdpConsoleEntry {
	level: string;
	text: string;
}

export interface CdpPageContext {
	contextId: string;
	targetId: string;
	title: string;
	url: string;
}

export interface CdpSnapshotTarget {
	ref: string;
	source: "browser_ax";
	role: string;
	name: string;
	value?: string;
	actions: string[];
	backendNodeId?: number;
}

export interface CdpPageSnapshot {
	owner?: string;
	viewport?: { width: number; height: number; cssWidth: number; cssHeight: number; stamp: string };
	contextId: string;
	snapshotId: string;
	targetId: string;
	title: string;
	url: string;
	capturedAt: number;
	text: string;
	targets: CdpSnapshotTarget[];
	outline: SerializedOutline;
	diagnostics: {
		cdp: "connected";
		targetCount: number;
	};
}

export interface CdpEvaluationResult {
	contextId: string;
	value: unknown;
}

/** Window frame in screen points, as reported by the AX side. */
export interface WindowFrame {
	x: number;
	y: number;
	w: number;
	h: number;
}

const COMMAND_TIMEOUT_MS = 5_000;
const CDP_CONTEXT_PREFIX = "browser:";
const NAVIGATE_LOAD_TIMEOUT_MS = 10_000;
const CONNECT_FAILURE_RETRY_MS = 5_000;
const CONSOLE_BUFFER_LIMIT = 20;

export class CdpTab {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
	private consoleBuffer: CdpConsoleEntry[] = [];
	private loadFired: (() => void) | undefined;

	private constructor(
		private readonly ws: WebSocket,
		readonly targetId: string,
		public title: string,
	) {}

	static async connect(wsUrl: string, targetId: string, title: string): Promise<CdpTab> {
		const ws = new WebSocket(wsUrl);
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Timed out connecting to CDP target at ${wsUrl}`)), COMMAND_TIMEOUT_MS);
				ws.onopen = () => {
					clearTimeout(timer);
					resolve();
				};
				ws.onerror = () => {
					clearTimeout(timer);
					reject(new Error(`Failed to connect to CDP target at ${wsUrl}`));
				};
			});

			const tab = new CdpTab(ws, targetId, title);
			ws.onmessage = (event) => tab.handleMessage(String(event.data));
			ws.onclose = () => tab.rejectAllPending(new Error("CDP connection closed."));
			ws.onerror = () => tab.rejectAllPending(new Error("CDP connection error."));
			await Promise.all([tab.send("Runtime.enable"), tab.send("Page.enable"), tab.send("Accessibility.enable")]);
			return tab;
		} catch (error) {
			try {
				ws.close();
			} catch {
				// already closed
			}
			throw error;
		}
	}

	onClose(listener: () => void): void {
		if (this.isOpen) this.ws.once("close", listener); else listener();
	}

	get isOpen(): boolean {
		return this.ws.readyState === WebSocket.OPEN;
	}

	close(): void {
		this.loadFired?.();
		this.loadFired = undefined;
		this.rejectAllPending(new Error("CDP connection closed."));
		try {
			this.ws.close();
		} catch {
			// already closed
		}
	}

	/** Evaluates a JS expression in the page and returns its primitive value. */
	async evaluate(expression: string): Promise<unknown> {
		const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, timeout: COMMAND_TIMEOUT_MS, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		return result?.result?.value;
	}

	async viewportStamp(): Promise<string> {
		return String(await this.evaluate("JSON.stringify([performance.timeOrigin, location.href, visualViewport.pageLeft, visualViewport.pageTop, visualViewport.width, visualViewport.height, visualViewport.scale, devicePixelRatio])"));
	}

	async viewportImage() {
		const stamp = await this.viewportStamp();
		const { cssVisualViewport: viewport } = await this.send("Page.getLayoutMetrics");
		const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
		if (stamp !== await this.viewportStamp()) throw new Error("The viewport changed during the screenshot. Observe the page again.");
		const header = Buffer.from(data.slice(0, 40), "base64");
		return { data: String(data), geometry: { width: header.readUInt32BE(16), height: header.readUInt32BE(20),
			cssWidth: Number(viewport.clientWidth), cssHeight: Number(viewport.clientHeight), stamp } };
	}

	async accessibilityTree(): Promise<unknown[]> {
		const result = await this.send("Accessibility.getFullAXTree");
		return Array.isArray(result?.nodes) ? result.nodes : [];
	}

	async navigate(url: string): Promise<void> {
		const loaded = new Promise<void>((resolve) => {
			this.loadFired = resolve;
		});
		try {
			const navigation = await this.send("Page.navigate", { url });
			if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
			if (!navigation.loaderId) return; // A same-document navigation has no load event.
			// SPAs and slow pages may never fire load; cap the wait and move on.
			let timer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([loaded, new Promise<void>((resolve) => { timer = setTimeout(resolve, NAVIGATE_LOAD_TIMEOUT_MS); })]);
			} finally { clearTimeout(timer); }
		} finally {
			this.loadFired = undefined;
		}
	}

	async clickBackendNode(backendNodeId: number, clickCount: number): Promise<void> {
		// The AX ref identifies the node, including when several buttons have the same name.
		// Check the viewport hit target before sending any input. Only preflight may retry.
		const findPoint = () => this.withBackendNode(backendNodeId, `async function() {
			if (this.ownerDocument.defaultView !== top) throw Error('Observe the target frame before clicking.');
			this.scrollIntoView({block:'nearest', inline:'nearest', behavior:'instant'});
			const deadline = performance.now() + 1200;
			let last;
			do {
				if (!this.isConnected) throw Error('The target was detached. Observe the page again.');
				const rect = this.getBoundingClientRect();
				const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
				const topEdge = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
				const x = (left + right) / 2, y = (topEdge + bottom) / 2;
				let hit = this.ownerDocument.elementFromPoint(x, y);
				while (hit?.shadowRoot) {
					const inner = hit.shadowRoot.elementFromPoint(x, y);
					if (!inner || inner === hit) break;
					hit = inner;
				}
				const ready = left < right && topEdge < bottom && (hit === this || this.contains(hit))
					&& !this.closest('[aria-disabled="true"],[inert]') && !this.matches(':disabled')
					&& this.checkVisibility?.({checkOpacity:true, checkVisibilityCSS:true}) !== false;
				if (ready && last && Math.abs(last.x-x) < 0.5 && Math.abs(last.y-y) < 0.5) return {x, y};
				last = ready ? {x, y} : undefined;
				await new Promise(resolve => setTimeout(resolve, 32));
			} while (performance.now() < deadline);
			throw Error('The target is obscured, disabled, hidden or moving. No click was sent. Observe the page again.');
		}`);
		for (let count = 1; count <= clickCount; count++) {
			let point;
			try { point = await findPoint(); } catch (error) {
				if (count > 1) throw new Error(`${count - 1} click(s) already delivered. Stopped before click ${count}: ${error}`);
				throw error;
			}
			await this.mouseAt(point.x, point.y, "mousePressed", "left", count);
			await this.mouseAt(point.x, point.y, "mouseReleased", "left", count);
		}
	}

	async typeIntoBackendNode(backendNodeId: number, text: string, replace: boolean): Promise<void> {
		const selected = await this.withBackendNode(backendNodeId, `function(replace) {
			const input = this.matches('textarea,input:is([type=text i],[type=search i],[type=email i],[type=url i],[type=tel i],[type=password i],:not([type]))');
			if ((!input && !this.isContentEditable) || !this.isConnected || this.matches(':disabled,[readonly]')
				|| this.closest('[inert],[aria-disabled="true"],[aria-readonly="true"]')) throw Error('Target is not editable.');
			this.focus();
			if (this.getRootNode().activeElement !== this) throw Error('The requested field did not receive focus.');
			if (!replace) return false;
			if (input) { this.select(); return this.value.length > 0; }
			const selection = this.ownerDocument.getSelection();
			selection.selectAllChildren(this);
			return !selection.isCollapsed;
		}`, [replace]);
		await this.withBackendNode(backendNodeId, `function(replace) {
			if (!this.isConnected || this.getRootNode().activeElement !== this) throw Error('Focus moved before the edit. No input was sent.');
			if (!replace) return;
			if (this.isContentEditable) {
				const wanted = this.ownerDocument.createRange(); wanted.selectNodeContents(this);
				const selection = this.ownerDocument.getSelection();
				const actual = selection.rangeCount ? selection.getRangeAt(0) : null;
				if (!actual || wanted.compareBoundaryPoints(0, actual) || wanted.compareBoundaryPoints(2, actual)) throw Error('Selection changed before the edit.');
			} else if (this.selectionStart !== null && (this.selectionStart !== 0 || this.selectionEnd !== this.value.length)) throw Error('Selection changed before the edit.');
		}`, [replace]);
		if (text) await this.typeIntoFocused(text);
		else if (replace && selected) {
			await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
			await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
		}
	}

	async scrollBy(deltaX: number, deltaY: number, backendNodeId?: number): Promise<void> {
		if (backendNodeId) {
			await this.withBackendNode(backendNodeId, "function(dx, dy){ this.scrollIntoView({block:'center', inline:'center'}); this.scrollBy(dx, dy); }", [deltaX, deltaY]);
			return;
		}
		await this.send("Runtime.evaluate", { expression: `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)})` });
	}

	async typeIntoFocused(text: string): Promise<void> {
		await this.send("Input.insertText", { text });
	}

	async keypress(keys: string[], backendNodeId?: number): Promise<void> {
		if (backendNodeId !== undefined) await this.withBackendNode(backendNodeId, `function() {
			this.focus();
			if (!this.isConnected || this.getRootNode().activeElement !== this) throw Error('The requested control did not receive focus.');
		}`);
		const modifierBits: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 };
		const modifiers = keys.reduce((bits, key) => bits | (modifierBits[key.toLowerCase()] ?? 0), 0);
		for (const key of keys.filter((candidate) => modifierBits[candidate.toLowerCase()] === undefined)) {
			await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, text: key.length === 1 && modifiers === 0 ? key : undefined, modifiers });
			await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, modifiers });
		}
	}

	async mouseAt(x: number, y: number, type: "mouseMoved" | "mousePressed" | "mouseReleased", button: "left" | "right" | "middle" = "left", clickCount = 1): Promise<void> {
		await this.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : button, clickCount });
	}

	async dragPath(path: Array<{ x: number; y: number }>): Promise<void> {
		if (path.length < 2) throw new Error("CDP drag requires at least two points.");
		await this.mouseAt(path[0].x, path[0].y, "mousePressed");
		for (const point of path.slice(1)) await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", buttons: 1 });
		const end = path[path.length - 1];
		await this.mouseAt(end.x, end.y, "mouseReleased");
	}

	private async withBackendNode(backendNodeId: number, functionDeclaration: string, args: unknown[] = []): Promise<any> {
		const resolved = await this.send("DOM.resolveNode", { backendNodeId });
		const objectId = resolved?.object?.objectId;
		if (typeof objectId !== "string") throw new Error(`CDP could not resolve backend node ${backendNodeId}.`);
		try {
			const reply = await this.send("Runtime.callFunctionOn", {
				objectId, functionDeclaration, awaitPromise: true, returnByValue: true,
				arguments: args.map((value) => ({ value })),
			});
			if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
			return reply.result?.value;
		} finally {
			await this.send("Runtime.releaseObject", { objectId }).catch(() => {});
		}
	}

	/** Screen bounds of the browser window containing this tab. */
	async windowBounds(): Promise<WindowFrame | undefined> {
		const result = await this.send("Browser.getWindowForTarget", { targetId: this.targetId });
		const bounds = result?.bounds;
		if (typeof bounds?.left !== "number" || typeof bounds?.width !== "number") return undefined;
		return { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
	}

	/** Returns buffered console messages/exceptions and clears the buffer. */
	drainConsole(): CdpConsoleEntry[] {
		const entries = this.consoleBuffer;
		this.consoleBuffer = [];
		return entries;
	}

	private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP command '${method}' timed out after ${COMMAND_TIMEOUT_MS}ms.`));
			}, COMMAND_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (result) => {
					clearTimeout(timer);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.ws.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleMessage(raw: string): void {
		let message: any;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}

		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(`CDP error: ${message.error.message ?? "unknown"}`));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		switch (message.method) {
			case "Page.loadEventFired":
				this.loadFired?.();
				break;
			case "Runtime.consoleAPICalled": {
				const args = Array.isArray(message.params?.args) ? message.params.args : [];
				const text = args
					.map((arg: any) => (arg?.value !== undefined ? String(arg.value) : (arg?.description ?? "")))
					.filter(Boolean)
					.join(" ");
				this.pushConsole({ level: String(message.params?.type ?? "log"), text });
				break;
			}
			case "Runtime.exceptionThrown": {
				const details = message.params?.exceptionDetails;
				const text = details?.exception?.description ?? details?.text ?? "Uncaught exception";
				this.pushConsole({ level: "exception", text: String(text) });
				break;
			}
		}
	}

	private pushConsole(entry: CdpConsoleEntry): void {
		if (!entry.text) return;
		this.consoleBuffer.push(entry);
		if (this.consoleBuffer.length > CONSOLE_BUFFER_LIMIT) {
			this.consoleBuffer.shift();
		}
	}

	private rejectAllPending(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}

const connectedTabs = new Map<string, CdpTab>();
const connectingTabs = new Map<string, Promise<CdpTab>>();
let lastConnectFailureAt = 0;

/** Close session-owned CDP state without affecting the browser process. */
export function disconnectCdp(): void {
	for (const pending of pageConnections.values()) void pending.then(tab => tab?.close(), () => {});
	pageConnections.clear();
	for (const tab of connectedTabs.values()) tab.close();
	connectedTabs.clear();
	connectingTabs.clear();
	lastConnectFailureAt = 0;
}

/**
 * Returns a CDP connection to the tab matching the controlled window's title
 * (and, when provided, the window's screen frame), or undefined when CDP is
 * disabled, unreachable, or no tab matches. Reuses the cached connection
 * while it still matches; failures are cached briefly so an unreachable
 * endpoint never adds per-call latency.
 */
export async function cdpTabForWindow(windowTitle: string, frame?: WindowFrame): Promise<CdpTab | undefined> {
	const port = process.env.PI_COMPUTER_USE_CDP_PORT;
	if (!port) return undefined; // Desktop console matching applies only to an explicitly attached browser.
	if (Date.now() - lastConnectFailureAt < CONNECT_FAILURE_RETRY_MS) return undefined;

	for (const [key, tab] of connectedTabs) {
		if (key.startsWith(`${port}|`) && tab.isOpen && titlesMatch(tab.title, windowTitle) && (await tabMatchesFrame(tab, frame))) return tab;
	}

	try {
		const pages = await cdpPages(port);
		const match = await pickTab(pages, windowTitle, frame);
		if (!match) return undefined;

		const key = `${port}|${match.id}`;
		const existing = connectedTabs.get(key);
		if (existing?.isOpen) {
			existing.title = match.title;
			return existing;
		}
		let connecting = connectingTabs.get(key);
		if (!connecting) {
			connecting = CdpTab.connect(match.webSocketDebuggerUrl!, match.id, match.title);
			connectingTabs.set(key, connecting);
		}
		let connected: CdpTab;
		try {
			connected = await connecting;
		} finally {
			connectingTabs.delete(key);
		}
		connectedTabs.set(key, connected);
		return connected;
	} catch {
		lastConnectFailureAt = Date.now();
		return undefined;
	}
}

interface CdpPageTarget {
	id: string;
	type: string;
	title: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

export async function listCdpPageContexts(): Promise<CdpPageContext[]> {
	const pages = await cdpPages();
	return pages.map((page) => ({
		contextId: cdpContextId(page.id),
		targetId: page.id,
		title: page.title,
		url: page.url ?? "",
	}));
}

export async function cdpClickForContext(contextId: string, backendNodeId: number, clickCount = 1): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		await tab.clickBackendNode(backendNodeId, clickCount);
		return true;
	})) === true;
}

export async function cdpTypeForContext(contextId: string, backendNodeId: number, text: string, replace: boolean): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		await tab.typeIntoBackendNode(backendNodeId, text, replace);
		return true;
	})) === true;
}

export async function cdpScrollForContext(contextId: string, deltaX: number, deltaY: number, backendNodeId?: number): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		await tab.scrollBy(deltaX, deltaY, backendNodeId);
		return true;
	})) === true;
}

export async function cdpTypeFocusedForContext(contextId: string, text: string): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => { await tab.typeIntoFocused(text); return true; })) === true;
}

export async function cdpKeypressForContext(contextId: string, keys: string[], backendNodeId?: number): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => { await tab.keypress(keys, backendNodeId); return true; })) === true;
}

export async function cdpMouseForContext(contextId: string, x: number, y: number, type: "mouseMoved" | "mousePressed" | "mouseReleased", button: "left" | "right" | "middle" = "left", clickCount = 1): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => { await tab.mouseAt(x, y, type, button, clickCount); return true; })) === true;
}

export async function cdpDragForContext(contextId: string, path: Array<{ x: number; y: number }>): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => { await tab.dragPath(path); return true; })) === true;
}

export async function cdpNavigateContext(contextId: string, url: string): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		await tab.navigate(url);
		return true;
	})) === true;
}

export async function cdpEvaluateForContext(contextId: string, expression: string): Promise<CdpEvaluationResult | undefined> {
	return withCdpContextTab(contextId, async tab => ({ contextId, value: await tab.evaluate(expression) }));
}

export async function cdpViewportStamp(contextId: string) {
	return withCdpContextTab(contextId, tab => tab.viewportStamp());
}

export async function cdpViewportForContext(contextId: string) {
	return withCdpContextTab(contextId, tab => tab.viewportImage());
}

export async function cdpSnapshotForContext(contextId: string): Promise<CdpPageSnapshot | undefined> {
	return withCdpContextTab(contextId, async tab => {
		const [documentInfo, nodes] = await Promise.all([
			tab.evaluate("({text:document.body?.innerText ?? '',title:document.title,url:location.href})") as Promise<{text:string; title:string; url:string}>,
			tab.accessibilityTree(),
		]);
		const snapshotId = randomUUID();
		const { targets, outline } = cdpSnapshotOutline(snapshotId, nodes);
		return {
			owner: browserOwner(),
			contextId,
			snapshotId,
			targetId: tab.targetId,
			title: documentInfo.title,
			url: documentInfo.url,
			capturedAt: Date.now(),
			text: documentInfo.text,
			targets,
			outline,
			diagnostics: { cdp: "connected", targetCount: targets.length },
		};
	});
}

// A connected page socket targets one immutable tab. Never redispatch an action after a disconnect.
const pageConnections = new Map<string, Promise<CdpTab | undefined>>();
async function withCdpContextTab<T>(contextId: string, run: (tab: CdpTab) => Promise<T>): Promise<T | undefined> {
	const port = browserPort();
	if (!port || !contextId.startsWith(CDP_CONTEXT_PREFIX)) return undefined;
	const key = JSON.stringify([browserOwner(), port, contextId]);
	let connection = pageConnections.get(key);
	if (!connection) {
		const targetId = contextId.slice(CDP_CONTEXT_PREFIX.length);
		connection = cdpPages(port).then(pages => {
			const page = pages.find(candidate => candidate.id === targetId);
			return page?.webSocketDebuggerUrl ? CdpTab.connect(page.webSocketDebuggerUrl, page.id, page.title) : undefined;
		});
		pageConnections.set(key, connection);
		const forget = () => { if (pageConnections.get(key) === connection) pageConnections.delete(key); };
		void connection.then(tab => { if (tab) tab.onClose(forget); else forget(); }, forget);
	}
	const tab = await connection;
	return tab && run(tab);
}

async function cdpPages(port = browserPort()): Promise<CdpPageTarget[]> {
	if (!port || !/^\d+$/.test(port) || Number(port) > 65535) return [];
	const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000), redirect: "error" });
	const targets = (await response.json()) as CdpPageTarget[];
	return targets.filter((target) =>
		target.type === "page" && target.webSocketDebuggerUrl && isLocalDebuggerWebSocket(target.webSocketDebuggerUrl, port),
	);
}

function cdpContextId(targetId: string): string {
	return `${CDP_CONTEXT_PREFIX}${targetId}`;
}

function axString(raw: any): string {
	const value = raw?.value ?? raw;
	return typeof value === "string" ? value.trim() : "";
}

function cdpSnapshotOutline(snapshotId: string, nodes: unknown[]): { targets: CdpSnapshotTarget[]; outline: SerializedOutline } {
	const records = new Map<string, any>();
	for (const raw of nodes as any[]) {
		const nodeId = String(raw?.nodeId ?? "");
		if (nodeId) records.set(nodeId, raw);
	}
	const targets: CdpSnapshotTarget[] = [];
	const build = (raw: any, seen: Set<string>): any => {
		const nodeId = String(raw?.nodeId ?? randomUUID());
		if (seen.has(nodeId)) return undefined;
		seen.add(nodeId);
		const role = axString(raw?.role);
		const name = axString(raw?.name);
		const actions = browserActionsForAxRole(role);
		const backendNodeId = Number.isFinite(raw?.backendDOMNodeId) ? Math.trunc(raw.backendDOMNodeId) : undefined;
		const wireRef = `cdp:${nodeId}`;
		if (actions.length > 0 && backendNodeId) {
			targets.push({ ref: wireRef, source: "browser_ax", role, name, value: axString(raw?.value) || undefined, actions, backendNodeId });
		}
		const childIds: string[] = Array.isArray(raw?.childIds) ? raw.childIds.map(String) : [];
		return {
			ref: wireRef,
			role,
			subrole: "",
			identifier: "",
			title: name,
			description: axString(raw?.description),
			value: axString(raw?.value),
			actions,
			canPress: actions.includes("click"),
			canFocus: actions.length > 0,
			canSetValue: actions.includes("set_text"),
			canScroll: false,
			canIncrement: false,
			canDecrement: false,
			isTextInput: actions.includes("set_text"),
			rect: { x: 0, y: 0, w: 0, h: 0 },
			children: childIds.map((id: string) => records.get(id)).filter(Boolean).map((child: any) => build(child, seen)).filter(Boolean),
		};
	};
	const roots = (nodes as any[]).filter((raw) => !raw?.parentId || !records.has(String(raw.parentId)));
	const children = roots.map((root) => build(root, new Set())).filter(Boolean);
	const rawOutline = children.length === 1 ? children[0] : {
		ref: `cdp:root:${snapshotId}`,
		role: "document",
		subrole: "",
		identifier: "",
		title: "Browser page",
		description: "",
		value: "",
		actions: [],
		canPress: false,
		canFocus: false,
		canSetValue: false,
		canScroll: false,
		canIncrement: false,
		canDecrement: false,
		isTextInput: false,
		rect: { x: 0, y: 0, w: 0, h: 0 },
		children,
	};
	const parsed = parseLookResponse({
		lookId: snapshotId,
		capturedAt: Date.now() / 1000,
		window: { windowId: 0, framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1, isModal: false, role: "document", subrole: "" },
		outline: rawOutline,
		timings: {},
	}).parsedOutline!;
	const modelRefByWire = parsed.wireRefToRef;
	for (const target of targets) target.ref = modelRefByWire.get(target.ref) ?? target.ref;
	return { targets, outline: serializeOutline(parsed) };
}

function browserActionsForAxRole(role: string): string[] {
	const normalized = role.toLowerCase();
	if (["button", "link", "checkbox", "radio", "menuitem", "tab"].includes(normalized)) return ["click"];
	if (["textbox", "searchbox", "combobox"].includes(normalized)) return ["click", "set_text"];
	if (["listbox", "slider", "spinbutton"].includes(normalized)) return ["click"];
	return [];
}

function isLocalDebuggerWebSocket(wsUrl: string, expectedPort: string | undefined): boolean {
	try {
		const parsed = new URL(wsUrl);
		const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
		return (parsed.protocol === "ws:" || parsed.protocol === "wss:") && localHosts.has(parsed.hostname) && parsed.port === expectedPort;
	} catch {
		return false;
	}
}

/**
 * Picks the tab for a window title. Disambiguation order, applied only while
 * more than one candidate remains:
 *   1. exact title matches beat prefix matches;
 *   2. the tab whose browser window frame matches the controlled window
 *      (separates same-titled tabs in different windows);
 *   3. the visible tab (separates same-titled tabs in one window — the
 *      active tab is "visible", background tabs are "hidden").
 * /json/list ordering is never trusted; it is an undocumented MRU detail.
 */
async function pickTab(pages: CdpPageTarget[], windowTitle: string, frame?: WindowFrame): Promise<CdpPageTarget | undefined> {
	const matches = pages.filter((target) => titlesMatch(target.title, windowTitle));
	if (matches.length === 0) return pages.length === 1 ? pages[0] : undefined;
	if (matches.length === 1) return matches[0];

	const wanted = windowTitle.trim().toLowerCase();
	const exact = matches.filter((target) => target.title.trim().toLowerCase() === wanted);
	const pool = exact.length > 0 ? exact : matches;
	if (pool.length === 1) return pool[0];

	let visibleFallback: CdpPageTarget | undefined;
	for (const candidate of pool) {
		try {
			const tab = await CdpTab.connect(candidate.webSocketDebuggerUrl!, candidate.id, candidate.title);
			const inFrame = await tabMatchesFrame(tab, frame, false);
			const visibility = await tab.evaluate("document.visibilityState").catch(() => undefined);
			tab.close();
			if (frame && inFrame && visibility === "visible") return candidate;
			if (frame && inFrame && !visibleFallback) visibleFallback = candidate;
			if (!frame && visibility === "visible") return candidate;
		} catch {
			// candidate unreachable; try the next one
		}
	}
	return visibleFallback ?? pool[0];
}

/**
 * Whether the tab's browser window frame matches the AX window frame.
 * `trustOnUnknown` controls the answer when bounds cannot be read: cache
 * verification trusts the existing connection, candidate selection does not.
 */
async function tabMatchesFrame(tab: CdpTab, frame: WindowFrame | undefined, trustOnUnknown = true): Promise<boolean> {
	if (!frame) return true;
	const bounds = await tab.windowBounds().catch(() => undefined);
	if (!bounds) return trustOnUnknown;
	const tolerance = 50;
	return (
		Math.abs(bounds.x + bounds.w / 2 - (frame.x + frame.w / 2)) <= tolerance &&
		Math.abs(bounds.y + bounds.h / 2 - (frame.y + frame.h / 2)) <= tolerance
	);
}

// The AX window title for a Chrome-family browser is usually the active tab
// title, sometimes suffixed (" - Google Chrome", profile name), so compare
// by prefix in both directions.
function titlesMatch(tabTitle: string, windowTitle: string): boolean {
	const tab = tabTitle.trim().toLowerCase();
	const win = windowTitle.trim().toLowerCase();
	if (!tab || !win) return false;
	return tab === win || win.startsWith(tab) || tab.startsWith(win);
}
