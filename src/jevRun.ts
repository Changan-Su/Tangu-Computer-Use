import type { AgentToolResult, ExtensionContext } from './pi-compat.ts';
import type { SerializedOutline, SerializedOutlineNode } from './vendor/outline.ts';
import { executeObserve, executeAct, type UiAction } from './vendor/bridge.ts';
import { executionSummary, foregroundNote } from './foregroundNote.ts';
import { elementRequest, elementSelection, visionRequest, visionSelection, verifyRequest, verifyAnswer, prepareJevImage, readJevConnection, requestJev, jevMode, jevThreshold, JEV_MODEL, type JevMode, type JevStep, type JevSelection, type PreparedImage, VERIFY_FLOOR } from './jev.ts';

interface ObservationDetails {
  capture?: { stateId: string; width: number; height: number; timestamp: number };
  target?: { pid: number; windowId: number; windowRef?: string };
  outline?: SerializedOutline;
  status?: string;
  execution?: { outcome?: string; error?: unknown; escalatedToForeground?: boolean };
}
interface JevArgs { root: string; steps: JevStep[]; mode?: JevMode; preview?: boolean }
export interface JevRunResult { report: Record<string, unknown>; last?: AgentToolResult }
const active = new Set<AbortController>();
export function stopJevRuns(): void { for (const run of active) run.abort(); }

/** How long Jev keeps looking for a step's `expect` (page loads, animations) before handing back; the checks shorten it. */
export const jevTiming = { verifyWindowMs: 4000, pollMs: 400 };
/** Whole-run limit grows with the steps (each may wait for its expect); the tool itself times out at 180 s. */
export const runLimitMs = (steps: number): number => Math.min(170_000, 20_000 + steps * 20_000);
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

const phrase = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 512;
export function parseJevArgs(args: Record<string, unknown>): JevArgs {
  if (typeof args.root !== 'string' || !/^@r\d+$/.test(args.root)) throw new Error('Pass an exact desktop root from find_roots.');
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 8) throw new Error('Pass 1–8 explicit steps.');
  const steps: JevStep[] = args.steps.map((step) => {
    if (!step || !['click', 'double_click', 'fill', 'scroll', 'type', 'key'].includes(step.action)) throw new Error('Each step needs action click, double_click, fill, scroll, type or key.');
    const focusInput = step.action === 'type' || step.action === 'key';
    if (!(focusInput && step.target === undefined) && !phrase(step.target)) throw new Error(`A ${step.action} step needs a target of 1–512 characters${focusInput ? ', or no target to use the current focus' : ''}.`);
    if (step.action === 'fill' && (typeof step.text !== 'string' || step.text.length > 10_000)) throw new Error('A fill step needs text of at most 10,000 characters.');
    if (step.action === 'type' && (typeof step.text !== 'string' || !step.text || step.text.length > 10_000)) throw new Error('A type step needs text of 1–10,000 characters.');
    if (step.action === 'key' && !(Array.isArray(step.keys) && step.keys.length >= 1 && step.keys.length <= 16 && step.keys.every((k: unknown) => typeof k === 'string' && k.trim() !== '' && k.length <= 32))) throw new Error('A key step needs keys: 1–16 key names, e.g. ["cmd","a"] or ["return"].');
    if (step.action === 'scroll') {
      if (!phrase(step.until)) throw new Error('A scroll step needs until: what must come into view, in 1–512 characters.');
      if (step.direction !== undefined && step.direction !== 'down' && step.direction !== 'up') throw new Error('direction must be down or up.');
      if (step.expect !== undefined) throw new Error('A scroll step is checked by until; leave expect out.');
    }
    if (step.expect !== undefined && !phrase(step.expect)) throw new Error('expect must describe the expected screen in 1–512 characters.');
    return { action: step.action, ...(step.target !== undefined ? { target: step.target.trim() } : {}),
      ...(step.action === 'fill' || step.action === 'type' ? { text: step.text } : {}), ...(step.action === 'key' ? { keys: [...step.keys] } : {}),
      ...(step.action === 'scroll' ? { until: step.until.trim(), direction: step.direction ?? 'down' } : {}), ...(step.expect ? { expect: step.expect.trim() } : {}) };
  });
  if (args.mode !== undefined && !['auto', 'elements', 'vision'].includes(String(args.mode))) throw new Error('Unknown Jev mode.');
  if (args.preview !== undefined && typeof args.preview !== 'boolean') throw new Error('preview must be boolean.');
  if (args.preview && steps.length !== 1) throw new Error('Preview accepts one step, because later steps need actual UI changes.');
  if (args.preview && steps[0].target === undefined) throw new Error('Preview locates a target; this step has none.');
  return { root: args.root, steps, mode: args.mode as JevMode | undefined, preview: args.preview === true };
}

export function selectedActions(step: JevStep, selection: JevSelection | undefined, nodes: SerializedOutlineNode[]): UiAction[] {
  if (step.action === 'type' || step.action === 'key') {
    const input: UiAction = step.action === 'type' ? { action: 'typeText', text: step.text } : { action: 'keypress', keys: step.keys };
    // The click in the same call is what puts the focus there; with no target the input follows the current focus.
    return selection?.point ? [{ action: 'click', ...selection.point }, input] : [input];
  }
  if (!selection) throw new Error('This step needs a located target.');
  const node = nodes.find((n) => n.ref === selection.ref);
  if (selection.ref && !node) throw new Error('Selected element is no longer in this observation.');
  const where = selection.ref ? { ref: selection.ref } : selection.point;
  if (step.action === 'click') return [{ action: node?.canPress ? 'press' : 'click', ...where }];
  if (step.action === 'double_click') return [{ action: 'click', clickCount: 2, ...where }];
  if (node?.canSetValue) return [{ action: 'setText', ref: node.ref, text: step.text }];
  throw new Error('Jev fill requires a native editable element supporting setText. Visual/keyboard fill is not supported; use the ordinary tools to inspect and fill this field.');
}

/** A scroll step scrolls at most this often. Each scroll moves half the list's height (at least a tenth of the window),
 * so nothing slides past between two checked frames even when the wheel travels further than asked. */
export const MAX_SCROLLS = 8;
export function scrollAction(selection: JevSelection, captureHeight: number, direction: JevStep['direction']): UiAction {
  const { top, bottom } = selection.box!;
  const distance = Math.round(Math.max(0.5 * (bottom - top), 0.1) * captureHeight);
  return { action: 'scroll', ...selection.point!, scrollY: direction === 'up' ? -distance : distance };
}

/** Injected seams are also used by the native fixture and the offline fault checks. */
export const jevRuntime = {
  observe: (root: string, visual: boolean, ctx: ExtensionContext, signal: AbortSignal) => executeObserve('', { root, mode: visual ? 'visual' : 'semantic', readText: 'never' }, signal, undefined, ctx),
  act: (stateId: string, actions: UiAction[], ctx: ExtensionContext, signal: AbortSignal) => executeAct('', { stateId, actions }, signal, undefined, ctx),
  request: requestJev,
  prepare: prepareJevImage,
  connection: readJevConnection,
};

const NOTE = 'attemptedSteps = inputs sent (a scroll step whose until was already in view counts, with scrolls 0). confirmedSteps = steps confirmed by the native executor or by Jev checking the step\'s expect on a fresh screenshot. '
  + 'Unknown is unverified, not failed: a step without expect whose native outcome is unknown stops the run, and so does an expect that did not appear in time. Look at the returned screenshot before continuing, '
  + 'and continue only the steps that were not confirmed; never repeat an attempted step blindly with jev_ui or act_ui. '
  + 'point is in Jev\'s own capture (see capture); pointFraction/box are fractions of the window, so compare them with other screenshots that way. '
  + 'A scroll step reports how often it scrolled and why it stopped (until_seen, max_scrolls, no_change, input_failed, window_resized, cancelled). '
  + 'Jev uses the SAME executor and foreground policy as act_ui; foregroundTaken describes this run only. Preview only locates and cannot test input delivery.';

export async function runJev(args: Record<string, unknown>, settings: () => Record<string, unknown>, enabled: () => boolean, ctx: ExtensionContext, signal?: AbortSignal): Promise<JevRunResult> {
  const params = parseJevArgs(args);
  const config = settings();
  if (!enabled() || config.jev_enabled !== true) throw new Error('Enable Jev experimental acceleration in Computer Use settings first.');
  const connection = jevRuntime.connection(config);
  const mode = params.mode ?? jevMode(config.jev_mode), threshold = jevThreshold(config.jev_threshold), verifyThreshold = Math.max(threshold, VERIFY_FLOOR);
  // A scroll step can take up to MAX_SCROLLS rounds, so it counts twice.
  const limitMs = runLimitMs(params.steps.length + params.steps.filter((s) => s.action === 'scroll').length);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(limitMs);
  const abort = AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])]);
  active.add(controller);
  const started = performance.now();
  let last: AgentToolResult | undefined, confirmed = 0, attempted = 0, sentToForeground = false;
  let inputPending = false;
  let target: { pid: number; windowId: number } | undefined;
  // A visual observation left by the previous step's expect check: still fresh, so the next step locates on it.
  let carried: { details: ObservationDetails; last: AgentToolResult } | undefined;
  const trace: Array<Record<string, unknown>> = [];
  const check = () => {
    abort.throwIfAborted();
    if (!enabled() || settings().jev_enabled !== true) throw new Error('Jev was disabled; stopped before the next action.');
  };
  const observe = async (visual: boolean): Promise<ObservationDetails> => {
    check();
    last = await jevRuntime.observe(params.root, visual, ctx, abort);
    const d = last.details as ObservationDetails;
    if (!d.capture?.stateId || !d.outline?.root || !d.target?.pid || !d.target.windowId) throw new Error('Jev currently requires a native desktop window.');
    if (target && (target.pid !== d.target.pid || target.windowId !== d.target.windowId)) throw new Error('Target window changed; stopped. Discover the new window before continuing.');
    target = { pid: d.target.pid, windowId: d.target.windowId };
    return d;
  };
  const screenshot = async (d: ObservationDetails): Promise<PreparedImage> => {
    const image = last!.content.find((c) => c.type === 'image');
    if (image?.type !== 'image') throw new Error('This observation has no screenshot for Jev.');
    return jevRuntime.prepare({ ...image, width: d.capture!.width, height: d.capture!.height }, abort);
  };
  const report = (status: string, error?: string) => ({ status, model: JEV_MODEL, mode, threshold, verifyThreshold, preview: params.preview, executor: 'act_ui', confirmedSteps: confirmed, attemptedSteps: attempted, unattemptedSteps: params.steps.length - attempted, requestedSteps: params.steps.length, elapsedMs: Math.round(performance.now() - started), foregroundTaken: sentToForeground ? true : inputPending ? null : false, steps: trace, ...(error ? { error } : {}), note: NOTE });
  try {
    for (let i = 0; i < params.steps.length; i++) {
      check();
      const step = params.steps[i], stepStart = performance.now();
      const item: Record<string, unknown> = { step: i + 1, action: step.action, status: 'locating', mode: mode === 'vision' ? 'vision' : 'elements', observeMs: 0, decisionMs: 0 };
      trace.push(item);
      if (step.action === 'fill' && mode === 'vision') throw new Error('Jev vision mode supports click targeting only. Use Elements/Auto for native editable fields, or ordinary tools for web and visual text fields.');
      // Double-click, scroll, type and key are physical input checked on screenshots, which Elements mode never takes.
      const visual = step.action !== 'click' && step.action !== 'fill';
      if (visual && mode === 'elements') throw new Error(`${step.action} needs Auto or Vision mode (Elements mode never takes screenshots).`);
      const visualOnly = mode === 'vision' || visual;
      let d: ObservationDetails;
      if (carried && Date.now() - carried.details.capture!.timestamp < 3000) {
        ({ details: d, last } = carried);
        item.observation = 'reused_from_previous_check';
      } else {
        const observeStart = performance.now();
        d = await observe(visualOnly);
        item.observeMs = Math.round(performance.now() - observeStart);
      }
      carried = undefined;
      let selection: JevSelection | undefined, nodes: SerializedOutlineNode[] = [], prepared: PreparedImage | undefined;
      if (step.target !== undefined && !visualOnly) {
        let request: ReturnType<typeof elementRequest> | undefined;
        try { request = elementRequest(d.outline!.root, step); } catch (e) { if (mode === 'elements' || step.action === 'fill') throw e; }
        if (request) {
          nodes = request.nodes;
          check();
          const decisionStart = performance.now();
          const answer = await jevRuntime.request(connection, request.body, abort);
          item.decisionMs = Math.round(performance.now() - decisionStart);
          item.inputTokens = answer.usage?.input_tokens ?? 0;
          try { selection = elementSelection(answer, nodes, threshold); } catch (e) { if (mode === 'elements' || step.action === 'fill') throw e; }
        }
      }
      if (step.target !== undefined && !selection) {
        if (!last!.content.some((c) => c.type === 'image')) {
          const observeStart = performance.now();
          d = await observe(true);
          item.observeMs = Number(item.observeMs) + Math.round(performance.now() - observeStart);
          item.fallback = 'elements_to_vision';
        }
        item.mode = 'vision';
        const decisionStart = performance.now();
        prepared = await screenshot(d);
        check();
        const answer = await jevRuntime.request(connection, visionRequest(prepared, step), abort);
        item.decisionMs = Number(item.decisionMs) + Math.round(performance.now() - decisionStart);
        item.inputTokens = Number(item.inputTokens ?? 0) + Number(answer.usage?.input_tokens ?? 0);
        selection = visionSelection(answer, prepared, threshold);
        nodes = [];
      }
      // type / key without a target go to the current focus: nothing to locate, but the check compares with this frame.
      if (step.target === undefined && step.expect) prepared = await screenshot(d);
      if (selection) Object.assign(item, { confidence: selection.confidence, visibility: selection.visibility, model: selection.model, ref: selection.ref });
      if (selection?.point) {
        const { width, height } = d.capture!;
        Object.assign(item, { point: { x: Math.round(selection.point.x), y: Math.round(selection.point.y) }, capture: { width, height },
          pointFraction: { x: +(selection.point.x / width).toFixed(4), y: +(selection.point.y / height).toFixed(4) },
          box: Object.fromEntries(Object.entries(selection.box ?? {}).map(([k, v]) => [k, +v.toFixed(4)])) });
      }
      check();
      if (Date.now() - d.capture!.timestamp > 5000) throw new Error('The observation is over 5 seconds old; stopped before acting. Observe again.');
      if (params.preview) { item.status = 'preview'; item.elapsedMs = Math.round(performance.now() - stepStart); return { report: report('preview'), last }; }
      if (step.action === 'scroll') {
        // Jev scrolls the area it located until `until` is fully in view, checking every new frame itself.
        const goal: JevStep = { ...step, expect: `${step.until} (fully in view, not cut off at an edge)` };
        const scrollStart = performance.now();
        let frame = prepared!, scrolls = 0, seen = 0, tokens = 0, stopReason = '';
        const area = { width: d.capture!.width, height: d.capture!.height };
        const look = async (before?: PreparedImage) => {
          check();
          const answer = await jevRuntime.request(connection, verifyRequest(frame, goal, before), abort);
          tokens += Number(answer.usage?.input_tokens ?? 0);
          seen = verifyAnswer(answer);
          return seen >= verifyThreshold;
        };
        try {
          if (await look()) stopReason = 'until_seen';
          while (!stopReason) {
            if (scrolls === MAX_SCROLLS) { stopReason = 'max_scrolls'; break; }
            // The list was located once. Its point holds while the window keeps its size, so a frame left old by a slow
            // answer is just observed again; a window that changed size no longer vouches for that point.
            if (Date.now() - d.capture!.timestamp > 5000) d = await observe(true);
            if (d.capture!.width !== area.width || d.capture!.height !== area.height) { stopReason = 'window_resized'; break; }
            check();
            if (!scrolls) { attempted++; item.status = 'attempted'; }
            last = undefined;
            inputPending = true;
            last = await jevRuntime.act(d.capture!.stateId, [scrollAction(selection!, d.capture!.height, step.direction)], ctx, abort);
            inputPending = false;
            scrolls++;
            const after = last.details as ObservationDetails;
            sentToForeground ||= Boolean(foregroundNote(after.execution));
            item.execution = executionSummary(after);
            if (!after.capture?.stateId || (after.status && after.status !== 'ok') || after.execution?.error || after.execution?.outcome === 'didnt') { stopReason = 'input_failed'; break; }
            // ponytail: whole-frame comparison. An animating UI (a playing progress bar) never reads as unchanged, so
            // max_scrolls is the real cap there; crop to the area's box if that wastes rounds.
            let shot: PreparedImage | undefined;
            for (let k = 0; k < 2 && (!shot || shot.data === frame.data); k++) {
              await sleep(jevTiming.pollMs, abort);
              d = await observe(true);
              shot = await screenshot(d);
            }
            if (shot!.data === frame.data) { stopReason = 'no_change'; break; }
            const before = frame;
            frame = shot!;
            if (await look(before)) stopReason = 'until_seen';
          }
        } catch (e) {
          if (!scrolls) throw e;
          Object.assign(item, { status: 'unverified', scrolls, stopReason: abort.aborted ? 'cancelled' : 'stopped' });
          if (abort.aborted) throw e;
          const why = (e instanceof Error ? e.message : String(e)).replace(/[;.]?\s*no action was taken for this step\.?/i, '.');
          throw new Error(`Step ${i + 1} scrolled ${scrolls} time(s) and then stopped: ${why} ${params.steps.length - attempted} later step(s) were NOT attempted. Look at the returned screenshot before continuing.`);
        }
        Object.assign(item, { scrolls, stopReason, seen: +seen.toFixed(3), scrollMs: Math.round(performance.now() - scrollStart), inputTokens: Number(item.inputTokens ?? 0) + tokens, elapsedMs: Math.round(performance.now() - stepStart) });
        if (stopReason !== 'until_seen') {
          item.status = stopReason === 'input_failed' ? 'failed' : scrolls ? 'unverified' : 'stopped';
          const later = `${params.steps.length - attempted} later step(s) were NOT attempted. Look at the returned screenshot`;
          throw new Error(stopReason === 'input_failed' ? `Step ${i + 1}'s scroll #${scrolls} was attempted, but the executor reported a problem; ${later} and its execution facts before continuing, and do not replay it blindly.`
            : stopReason === 'window_resized' ? `Step ${i + 1}: the window changed size after ${scrolls} scroll(s), so the located list may have moved; ${later}, then locate it again with a new jev_ui call.`
            : stopReason === 'no_change' ? `Step ${i + 1}: the area stopped moving after ${scrolls} scroll(s) (the end of the list, or nothing scrolls at that point) and until is not in view; ${later}: it may be in the other direction or worded differently from what is drawn.`
            : `Step ${i + 1} scrolled ${MAX_SCROLLS} times without until coming fully into view (Jev visual check ${seen.toFixed(2)}, minimum ${verifyThreshold}); ${later}: it may be further away (call again to keep scrolling), in the other direction, or worded differently from what is drawn.`);
        }
        if (!scrolls) attempted++;
        confirmed++;
        Object.assign(item, { status: 'confirmed', confirmedBy: 'visual' });
        carried = { details: d, last: last! };
        continue;
      }
      const actions = selectedActions(step, selection, nodes);
      item.status = 'attempted';
      attempted++;
      const actStart = performance.now();
      // If native input is interrupted, the pre-action observation is stale and must not be returned.
      last = undefined;
      inputPending = true;
      last = await jevRuntime.act(d.capture!.stateId, actions, ctx, abort);
      inputPending = false;
      item.actionMs = Math.round(performance.now() - actStart);
      const after = last.details as ObservationDetails;
      sentToForeground ||= Boolean(foregroundNote(after.execution));
      item.execution = executionSummary(after);
      item.outcome = after.execution?.outcome ?? 'unknown';
      const nativeOk = after.execution?.outcome === 'worked' && !after.execution.error;
      if (!after.capture?.stateId || (after.status && after.status !== 'ok') || after.execution?.error || after.execution?.outcome === 'didnt') {
        if (nativeOk) confirmed++;
        item.status = nativeOk ? 'confirmed' : 'failed';
        item.elapsedMs = Math.round(performance.now() - stepStart);
        throw new Error(`Step ${i + 1} was attempted; ${params.steps.length - attempted} later step(s) were NOT attempted. Check its execution facts and returned state before continuing. Do not replay this step blindly or assume switching to act_ui changes the input policy.`);
      }
      if (step.expect && mode !== 'elements') {
        // Jev looks for the expected result itself; the main model only hears back when it does not appear.
        const verifyStart = performance.now();
        const before = prepared;
        let attempts = 0, noul = 0, tokens = 0;
        const verified = (met: boolean) => ({ met, noul: +noul.toFixed(3), attempts, waitedMs: Math.round(performance.now() - verifyStart), inputTokens: tokens });
        try {
          for (;;) {
            check();
            const vd = await observe(true);
            const shot = await screenshot(vd);
            check();
            const answer = await jevRuntime.request(connection, verifyRequest(shot, step, before), abort);
            attempts++; tokens += Number(answer.usage?.input_tokens ?? 0);
            noul = verifyAnswer(answer);
            if (noul >= verifyThreshold) { carried = { details: vd, last: last! }; break; }
            if (performance.now() - verifyStart + jevTiming.pollMs > jevTiming.verifyWindowMs) break;
            await sleep(jevTiming.pollMs, abort);
          }
        } catch (e) {
          if (abort.aborted) throw e;
          // The input is already out: an error here (429, network, window change) must not read as "nothing happened",
          // or the main model may send the step again (a second message, a second payment).
          item.status = 'unverified'; item.verify = verified(false);
          const why = (e instanceof Error ? e.message : String(e)).replace(/[;.]?\s*no action was taken for this step\.?/i, '.');
          throw new Error(`Step ${i + 1}'s input WAS sent, but checking its expect failed: ${why} ${params.steps.length - attempted} later step(s) were NOT attempted. Look at the returned screenshot before continuing; do not repeat this step blindly.`);
        }
        const met = noul >= verifyThreshold;
        item.verify = verified(met);
        item.elapsedMs = Math.round(performance.now() - stepStart);
        if (!met) {
          item.status = 'unverified';
          throw new Error(`Step ${i + 1} was attempted but its expect did not appear within ${jevTiming.verifyWindowMs / 1000} s (Jev visual check ${noul.toFixed(2)}, minimum ${verifyThreshold}); ${params.steps.length - attempted} later step(s) were NOT attempted. Look at the returned screenshot: the input may have hit another item, the app may still be loading, or expect may describe the screen differently.`);
        }
        confirmed++;
        Object.assign(item, { status: 'confirmed', confirmedBy: 'visual' });
        continue;
      }
      item.elapsedMs = Math.round(performance.now() - stepStart);
      if (!nativeOk) {
        item.status = 'uncertain';
        throw new Error(`Step ${i + 1} was attempted, but nothing confirmed it (native outcome unknown${step.expect ? '; Elements mode never takes screenshots, so expect was not checked' : ' and no expect was given'}); ${params.steps.length - attempted} later step(s) were NOT attempted. Look at the returned screenshot before continuing.${i + 1 < params.steps.length ? ' Give each step that changes the screen an expect so Jev can check it visually.' : ''}`);
      }
      confirmed++;
      Object.assign(item, { status: 'confirmed', confirmedBy: 'native' });
    }
    return { report: report('completed'), last };
  } catch (e) {
    if (inputPending && trace.length) trace.at(-1)!.status = 'uncertain';
    if (trace.length && trace.at(-1)!.status === 'locating') trace.at(-1)!.status = 'stopped';
    return { report: report(abort.aborted ? 'cancelled' : 'stopped', abort.aborted ? `Jev run cancelled or reached its ${limitMs / 1000}-second limit. Inspect any attempted step before resuming.` : e instanceof Error ? e.message : 'Jev run failed.'), last };
  } finally { active.delete(controller); }
}
