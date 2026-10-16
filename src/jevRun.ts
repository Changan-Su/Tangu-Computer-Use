import type { AgentToolResult, ExtensionContext } from './pi-compat.ts';
import type { SerializedOutline, SerializedOutlineNode } from './vendor/outline.ts';
import { executeObserve, executeAct, type UiAction } from './vendor/bridge.ts';
import { executionSummary, foregroundNote } from './foregroundNote.ts';
import { elementRequest, elementSelection, visionRequest, visionSelection, verifyRequest, verifyAnswer, prepareJevImage, readJevConnection, requestJev, jevMode, jevThreshold, JEV_MODEL, type JevMode, type JevStep, type JevSelection, type PreparedImage } from './jev.ts';

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

export function parseJevArgs(args: Record<string, unknown>): JevArgs {
  if (typeof args.root !== 'string' || !/^@r\d+$/.test(args.root)) throw new Error('Pass an exact desktop root from find_roots.');
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 8) throw new Error('Pass 1–8 explicit steps.');
  const steps: JevStep[] = args.steps.map((step) => {
    if (!step || !['click', 'double_click', 'fill'].includes(step.action) || typeof step.target !== 'string' || !step.target.trim() || step.target.length > 512) throw new Error('Each step needs action click/double_click/fill and a target of 1–512 characters.');
    if (step.action === 'fill' && (typeof step.text !== 'string' || step.text.length > 10_000)) throw new Error('A fill step needs text of at most 10,000 characters.');
    if (step.expect !== undefined && (typeof step.expect !== 'string' || !step.expect.trim() || step.expect.length > 512)) throw new Error('expect must describe the expected screen in 1–512 characters.');
    return { action: step.action, target: step.target.trim(), ...(step.action === 'fill' ? { text: step.text } : {}), ...(step.expect ? { expect: step.expect.trim() } : {}) };
  });
  if (args.mode !== undefined && !['auto', 'elements', 'vision'].includes(String(args.mode))) throw new Error('Unknown Jev mode.');
  if (args.preview !== undefined && typeof args.preview !== 'boolean') throw new Error('preview must be boolean.');
  if (args.preview && steps.length !== 1) throw new Error('Preview accepts one step, because later steps need actual UI changes.');
  return { root: args.root, steps, mode: args.mode as JevMode | undefined, preview: args.preview === true };
}

export function selectedActions(step: JevStep, selection: JevSelection, nodes: SerializedOutlineNode[]): UiAction[] {
  const node = nodes.find((n) => n.ref === selection.ref);
  if (selection.ref && !node) throw new Error('Selected element is no longer in this observation.');
  const where = selection.ref ? { ref: selection.ref } : selection.point;
  if (step.action === 'click') return [{ action: node?.canPress ? 'press' : 'click', ...where }];
  if (step.action === 'double_click') return [{ action: 'click', clickCount: 2, ...where }];
  if (node?.canSetValue) return [{ action: 'setText', ref: node.ref, text: step.text }];
  throw new Error('Jev fill requires a native editable element supporting setText. Visual/keyboard fill is not supported; use the ordinary tools to inspect and fill this field.');
}

/** Injected seams are also used by the native fixture and the offline fault checks. */
export const jevRuntime = {
  observe: (root: string, visual: boolean, ctx: ExtensionContext, signal: AbortSignal) => executeObserve('', { root, mode: visual ? 'visual' : 'semantic', readText: 'never' }, signal, undefined, ctx),
  act: (stateId: string, actions: UiAction[], ctx: ExtensionContext, signal: AbortSignal) => executeAct('', { stateId, actions }, signal, undefined, ctx),
  request: requestJev,
  prepare: prepareJevImage,
  connection: readJevConnection,
};

const NOTE = 'attemptedSteps = inputs sent. confirmedSteps = steps confirmed by the native executor or by Jev checking the step\'s expect on a fresh screenshot. '
  + 'Unknown is unverified, not failed: a step without expect whose native outcome is unknown stops the run, and so does an expect that did not appear in time. Look at the returned screenshot before continuing, '
  + 'and continue only the steps that were not confirmed; never repeat an attempted step blindly with jev_ui or act_ui. '
  + 'point is in Jev\'s own capture (see capture); pointFraction/box are fractions of the window, so compare them with other screenshots that way. '
  + 'Jev uses the SAME executor and foreground policy as act_ui; foregroundTaken describes this run only. Preview only locates and cannot test input delivery.';

export async function runJev(args: Record<string, unknown>, settings: () => Record<string, unknown>, enabled: () => boolean, ctx: ExtensionContext, signal?: AbortSignal): Promise<JevRunResult> {
  const params = parseJevArgs(args);
  const config = settings();
  if (!enabled() || config.jev_enabled !== true) throw new Error('Enable Jev experimental acceleration in Computer Use settings first.');
  const connection = jevRuntime.connection(config);
  const mode = params.mode ?? jevMode(config.jev_mode), threshold = jevThreshold(config.jev_threshold);
  const limitMs = runLimitMs(params.steps.length);
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
  const report = (status: string, error?: string) => ({ status, model: JEV_MODEL, mode, threshold, preview: params.preview, executor: 'act_ui', confirmedSteps: confirmed, attemptedSteps: attempted, unattemptedSteps: params.steps.length - attempted, requestedSteps: params.steps.length, elapsedMs: Math.round(performance.now() - started), foregroundTaken: sentToForeground ? true : inputPending ? null : false, steps: trace, ...(error ? { error } : {}), note: NOTE });
  try {
    for (let i = 0; i < params.steps.length; i++) {
      check();
      const step = params.steps[i], stepStart = performance.now();
      const item: Record<string, unknown> = { step: i + 1, action: step.action, status: 'locating', mode: mode === 'vision' ? 'vision' : 'elements', observeMs: 0, decisionMs: 0 };
      trace.push(item);
      if (step.action === 'fill' && mode === 'vision') throw new Error('Jev vision mode supports click targeting only. Use Elements/Auto for native editable fields, or ordinary tools for web and visual text fields.');
      // Double-click is a physical input at a point: it needs a screenshot, which Elements mode never takes.
      if (step.action === 'double_click' && mode === 'elements') throw new Error('double_click needs Auto or Vision mode (Elements mode never takes screenshots).');
      const visualOnly = mode === 'vision' || step.action === 'double_click';
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
      if (!visualOnly) {
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
      if (!selection) {
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
      Object.assign(item, { confidence: selection.confidence, visibility: selection.visibility, model: selection.model, ref: selection.ref });
      if (selection.point) {
        const { width, height } = d.capture!;
        Object.assign(item, { point: { x: Math.round(selection.point.x), y: Math.round(selection.point.y) }, capture: { width, height },
          pointFraction: { x: +(selection.point.x / width).toFixed(4), y: +(selection.point.y / height).toFixed(4) },
          box: Object.fromEntries(Object.entries(selection.box ?? {}).map(([k, v]) => [k, +v.toFixed(4)])) });
      }
      check();
      if (Date.now() - d.capture!.timestamp > 5000) throw new Error('The observation is over 5 seconds old; stopped before acting. Observe again.');
      if (params.preview) { item.status = 'preview'; item.elapsedMs = Math.round(performance.now() - stepStart); return { report: report('preview'), last }; }
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
        for (;;) {
          check();
          const vd = await observe(true);
          const shot = await screenshot(vd);
          check();
          const answer = await jevRuntime.request(connection, verifyRequest(shot, step, before), abort);
          attempts++; tokens += Number(answer.usage?.input_tokens ?? 0);
          noul = verifyAnswer(answer);
          if (noul >= threshold) { carried = { details: vd, last: last! }; break; }
          if (performance.now() - verifyStart + jevTiming.pollMs > jevTiming.verifyWindowMs) break;
          await sleep(jevTiming.pollMs, abort);
        }
        const met = noul >= threshold;
        item.verify = { met, noul: +noul.toFixed(3), attempts, waitedMs: Math.round(performance.now() - verifyStart), inputTokens: tokens };
        item.elapsedMs = Math.round(performance.now() - stepStart);
        if (!met) {
          item.status = 'unverified';
          throw new Error(`Step ${i + 1} was attempted but its expect did not appear within ${jevTiming.verifyWindowMs / 1000} s (Jev visual check ${noul.toFixed(2)}, minimum ${threshold}); ${params.steps.length - attempted} later step(s) were NOT attempted. Look at the returned screenshot: the input may have hit another item, the app may still be loading, or expect may describe the screen differently.`);
        }
        confirmed++;
        Object.assign(item, { status: 'confirmed', confirmedBy: 'visual' });
        continue;
      }
      item.elapsedMs = Math.round(performance.now() - stepStart);
      if (!nativeOk) {
        item.status = 'uncertain';
        throw new Error(`Step ${i + 1} was attempted, but nothing confirmed it (native outcome unknown${step.expect ? '; Elements mode never takes screenshots, so expect was not checked' : ' and no expect was given'}); ${params.steps.length - attempted} later step(s) were NOT attempted. Look at the returned screenshot before continuing. Give each step an expect so Jev can check it visually.`);
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
