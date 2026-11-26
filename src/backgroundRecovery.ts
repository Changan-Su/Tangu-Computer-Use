// Track the last unresolved pointer action for each run and exact window. A fresh observation can change resolution, so compare
// window-relative coordinates. A different window has its own independent history.
import type { PictureGrid } from './vendor/outline.ts';
import { currentOverlayRunId } from './overlayState.ts';

interface WindowIdentity { pid: number; windowId: number }
interface Point { x: number; y: number }
interface Receipt extends WindowIdentity { point: Point; picture?: PictureGrid; verifiedWindow: boolean; freshCapture?: { stateId: string; timestamp: number }; retries: number; repeatRefused?: boolean; phase: 'background' | 'raising' | 'foreground' | 'sent' | 'blocked'; expires: number }
const receipts = new Map<string, Receipt>();

function receiptKey(window: WindowIdentity): string | undefined {
  const run = currentOverlayRunId();
  return run && window.windowId ? JSON.stringify([run, window.pid, window.windowId]) : undefined;
}

export function clickReceipt(window: WindowIdentity): Receipt | undefined {
  const id = receiptKey(window);
  const receipt = id ? receipts.get(id) : undefined;
  if (receipt && receipt.expires > Date.now() && receipt.pid === window.pid && receipt.windowId === window.windowId) return receipt;
}

export function sameClick(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= 0.006 && Math.abs(a.y - b.y) <= 0.006;
}

/** An already exhausted window was requested again. The host can finish this blocked turn. */
export function recoveryExhausted(message: string): Error {
  return Object.assign(new Error(message), { code: 'computer_use_recovery_exhausted' });
}

export function forgetClick(window: WindowIdentity): void {
  const id = receiptKey(window);
  if (id) receipts.delete(id);
}

export function rememberClick(window: WindowIdentity, point: Point, picture: PictureGrid | undefined, verifiedWindow: boolean): void {
  const id = receiptKey(window);
  if (!id) return;
  const prior = clickReceipt(window);
  const retries = prior?.phase === 'background' && sameClick(prior.point, point) ? prior.retries + 1 : 1;
  receipts.delete(id);
  receipts.set(id, { pid: window.pid, windowId: window.windowId, point, picture, verifiedWindow, retries, phase: 'background', expires: Date.now() + 120_000 });
  if (receipts.size > 128) receipts.delete(receipts.keys().next().value!);
}
