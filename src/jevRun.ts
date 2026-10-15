import type { AgentToolResult, ExtensionContext } from './pi-compat.ts';
import type { SerializedOutline, SerializedOutlineNode } from './vendor/outline.ts';
import { executeObserve, executeAct, type UiAction } from './vendor/bridge.ts';
import { foregroundNote } from './foregroundNote.ts';
import { elementRequest, elementSelection, visionRequest, visionSelection, prepareJevImage, readJevConnection, requestJev, jevMode, jevThreshold, JEV_MODEL, type JevMode, type JevStep, type JevSelection } from './jev.ts';

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

export function parseJevArgs(args: Record<string, unknown>): JevArgs {
  if (typeof args.root !== 'string' || !/^@r\d+$/.test(args.root)) throw new Error('Pass an exact desktop root from find_roots.');
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 8) throw new Error('Pass 1–8 explicit steps.');
  const steps: JevStep[] = args.steps.map((step) => {
    if (!step || (step.action !== 'click' && step.action !== 'fill') || typeof step.target !== 'string' || !step.target.trim() || step.target.length > 512) throw new Error('Each step needs action click/fill and a target of 1–512 characters.');
    if (step.action === 'fill' && (typeof step.text !== 'string' || step.text.length > 10_000)) throw new Error('A fill step needs text of at most 10,000 characters.');
    return { action: step.action, target: step.target.trim(), ...(step.action === 'fill' ? { text: step.text } : {}) };
  });
  if (args.mode !== undefined && !['auto', 'elements', 'vision'].includes(String(args.mode))) throw new Error('Unknown Jev mode.');
  if (args.preview !== undefined && typeof args.preview !== 'boolean') throw new Error('preview must be boolean.');
  if (args.preview && steps.length !== 1) throw new Error('Preview accepts one step, because later steps need actual UI changes.');
  return { root: args.root, steps, mode: args.mode as JevMode | undefined, preview: args.preview === true };
}

export function selectedActions(step: JevStep, selection: JevSelection, nodes: SerializedOutlineNode[]): UiAction[] {
  const node = nodes.find((n) => n.ref === selection.ref);
  if (selection.ref && !node) throw new Error('Selected element is no longer in this observation.');
  if (step.action === 'click') return [{ action: node?.canPress ? 'press' : 'click', ...(selection.ref ? { ref: selection.ref } : selection.point) }];
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

export async function runJev(args: Record<string, unknown>, settings: () => Record<string, unknown>, enabled: () => boolean, ctx: ExtensionContext, signal?: AbortSignal): Promise<JevRunResult> {
  const params = parseJevArgs(args);
  const config = settings();
  if (!enabled() || config.jev_enabled !== true) throw new Error('Enable Jev experimental acceleration in Computer Use settings first.');
  const connection = jevRuntime.connection(config);
  const mode = params.mode ?? jevMode(config.jev_mode), threshold = jevThreshold(config.jev_threshold);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(60_000);
  const abort = AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])]);
  active.add(controller);
  const started = performance.now();
  let last: AgentToolResult | undefined, executed = 0, attempted = 0, sentToForeground = false;
  let inputPending = false;
  let target: { pid: number; windowId: number } | undefined;
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
  const report = (status: string, error?: string) => ({ status, model: JEV_MODEL, mode, preview: params.preview, executedSteps: executed, attemptedSteps: attempted, requestedSteps: params.steps.length, elapsedMs: Math.round(performance.now() - started), foregroundTaken: sentToForeground ? true : inputPending ? null : false, steps: trace, ...(error ? { error } : {}), note: 'Executed means the input was delivered, not that the overall goal was verified. Inspect the returned state, or observe again if none was returned. Never replay completed or uncertain steps automatically.' });
  try {
    for (let i = 0; i < params.steps.length; i++) {
      check();
      const step = params.steps[i], stepStart = performance.now();
      const item: Record<string, unknown> = { step: i + 1, action: step.action, status: 'locating', mode: mode === 'vision' ? 'vision' : 'elements', observeMs: 0, decisionMs: 0 };
      trace.push(item);
      if (step.action === 'fill' && mode === 'vision') throw new Error('Jev vision mode supports click targeting only. Use Elements/Auto for native editable fields, or ordinary tools for web and visual text fields.');
      let observeStart = performance.now(), d = await observe(mode === 'vision');
      item.observeMs = Math.round(performance.now() - observeStart);
      let selection: JevSelection | undefined, nodes: SerializedOutlineNode[] = [];
      if (mode !== 'vision') {
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
        if (mode !== 'vision') {
          observeStart = performance.now();
          d = await observe(true);
          item.observeMs = Number(item.observeMs) + Math.round(performance.now() - observeStart);
          item.fallback = 'elements_to_vision';
        }
        item.mode = 'vision';
        const image = last!.content.find((c) => c.type === 'image');
        if (image?.type !== 'image') throw new Error('This observation has no screenshot for Jev.');
        const decisionStart = performance.now();
        const prepared = await jevRuntime.prepare({ ...image, width: d.capture!.width, height: d.capture!.height }, abort);
        check();
        const answer = await jevRuntime.request(connection, visionRequest(prepared, step), abort);
        item.decisionMs = Number(item.decisionMs) + Math.round(performance.now() - decisionStart);
        item.inputTokens = Number(item.inputTokens ?? 0) + Number(answer.usage?.input_tokens ?? 0);
        selection = visionSelection(answer, prepared, threshold);
        nodes = [];
      }
      Object.assign(item, { confidence: selection.confidence, model: selection.model, ref: selection.ref, point: selection.point });
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
      item.outcome = after.execution?.outcome ?? 'unknown';
      item.elapsedMs = Math.round(performance.now() - stepStart);
      if (!after.capture?.stateId || (after.status && after.status !== 'ok') || after.execution?.error || after.execution?.outcome !== 'worked') {
        item.status = 'uncertain';
        throw new Error('The action was attempted but could not be confirmed. Inspect the returned state before continuing; do not replay this step blindly.');
      }
      executed++;
      item.status = 'executed';
    }
    return { report: report('executed'), last };
  } catch (e) {
    if (trace.length && trace.at(-1)!.status === 'locating') trace.at(-1)!.status = 'stopped';
    return { report: report(abort.aborted ? 'cancelled' : 'stopped', abort.aborted ? 'Jev run cancelled or reached its 60-second limit. Inspect any attempted step before resuming.' : e instanceof Error ? e.message : 'Jev run failed.'), last };
  } finally { active.delete(controller); }
}
