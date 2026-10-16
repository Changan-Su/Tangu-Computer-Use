/** GPT-6 Luna interprets real plugin reports in an isolated standalone engine.
 * This checks report comprehension, not native input or autonomous tool execution.
 * TANGU_ENGINE_ROOT=<built tangu-agent> node scripts/jev-feedback-live.check.mjs <output-dir>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = process.env.TANGU_ENGINE_ROOT;
assert(engine, 'TANGU_ENGINE_ROOT must point to a built standalone engine');
const out = path.resolve(process.argv[2]); await fs.mkdir(out, {recursive: true});
const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-feedback-live-'));
const home = path.join(isolated, 'tangu'), workspace = path.join(isolated, 'workspace');
await fs.mkdir(home); await fs.mkdir(workspace);
await fs.symlink(process.env.TANGU_LIVE_AUTH || path.join(os.homedir(), '.forsion-dev/provider-auth.json'), path.join(isolated, 'provider-auth.json'));
const bundle = path.join(root, `tangu-plugins/computer-use/dist/feedback-live-${process.pid}.mjs`);
await build({stdin: {contents: 'export * from "./src/jevRun.ts";export {render} from "./src/tools.ts";', resolveDir: root}, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node20', alias: {'@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts')}, banner: {js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});
const j = await import(pathToFileURL(bundle));
Object.assign(j.jevRuntime, {
  connection: () => ({}),
  observe: async () => ({content: [], details: {capture: {stateId: 'before', timestamp: Date.now()}, target: {pid: 1, windowId: 2}, outline: {root: {ref: '@e0', role: 'button', title: 'Daily', description: '', canPress: true, children: []}}}}),
  request: async () => ({model: 'jev-1.14.0', answers: {target: {type: 'choice', choice: '@e0', confidence: .93}}}),
  act: async () => ({content: [{type: 'text', text: 'Returned state after: Daily popup is OPEN; Third Song button is visible.'}], details: {capture: {stateId: 'after'}, config: {headless: true}, execution: {outcome: 'unknown', steps: [{outcome: 'unknown', delivery: 'pid', deliveryPolicy: 'ax_only'}]}}}),
});
const unknown = await j.runJev({root: '@r1', mode: 'elements', steps: [{action: 'click', target: 'Daily'}, {action: 'click', target: 'Third Song'}]}, () => ({jev_enabled: true}), () => true, {});
assert.equal(unknown.report.attemptedSteps, 1, JSON.stringify(unknown.report));
assert.equal(unknown.report.executedSteps, 0);
assert.equal(unknown.report.steps[0].status, 'uncertain');
assert.equal(unknown.report.steps[0].execution.outcome, 'unknown');
const report = JSON.stringify(unknown.report) + '\n' + j.render(unknown.last, {});
await fs.writeFile(path.join(out, 'input-evidence.json'), JSON.stringify(unknown.report, null, 2));
const cases = [
  {key: 'jev-unknown', text: `用户要用 Jev 打开 Daily 再点 Third Song。刚收到以下结果:\n${report}\n请仅按结果选择下一步，不执行任何工具。回答 JSON: {"jevBackgroundOnly":boolean,"zeroInputSent":boolean,"repeatDaily":boolean,"nextTarget":string}。`, check: v => v.jevBackgroundOnly === false && v.zeroInputSent === false && v.repeatDaily === false && /Third Song/i.test(v.nextTarget)},
  {key: 'jev-strict', text: `${report}\n接下来目标应用没有当前桌面的窗口，ensure_app 返回 strict background setting forbids bringing it to foreground。用户只说“继续，用 Jev，快”，没有授权更改设置。请仅选择下一步，不执行任何工具。回答 JSON: {"shellActivate":boolean,"changeSettingYourself":boolean,"previewTestsInput":boolean,"askUserToSwitchOrChangeSetting":boolean}。`, check: v => v.shellActivate === false && v.changeSettingYourself === false && v.previewTestsInput === false && v.askUserToSwitchOrChangeSetting === true},
];
const port = await new Promise(resolve => {const s = net.createServer(); s.listen(0, '127.0.0.1', () => {const p = s.address().port; s.close(() => resolve(p));});});
const token = randomUUID(), base = `http://127.0.0.1:${port}`, model = 'codex/gpt-6-luna';
const log = await fs.open(path.join(out, 'engine.log'), 'w');
const child = spawn(process.execPath, [path.join(engine, 'dist/standalone/main.js'), '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(home, 'state.db'), '--sandbox', 'auto', '--cloud-url', 'http://127.0.0.1:9', '--token', token], {env: {...process.env, TANGU_HOME: home, TANGU_DEFAULT_WORKSPACE: workspace, TANGU_BROWSER_CDP: 'off', FORSION_DESKTOP_CONFIG: path.join(isolated, 'desktop.json')}, stdio: ['ignore', log.fd, log.fd]});
const api = async (url, body) => { const r = await fetch(base + url, {method: body ? 'POST' : 'GET', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})}); if (!r.ok) throw Error(`${url}: ${r.status}`); return r.json(); };
const results = [], startedAt = new Date().toISOString();
try {
  let ready = false;
  for (let i=0;i<100;i++) {try {await api('/health'); ready = true; break;} catch {} await new Promise(r=>setTimeout(r,200));}
  assert(ready, 'standalone startup');
  for (const c of cases) {
    const {runId} = await api('/agent/runs', {session_id: `jev-feedback-${randomUUID()}`, model_id: model, message: c.text, agent_config: {execMode: 'host', cwd: workspace, approvalMode: 'full-auto', thinkingLevel: 'medium'}});
    let content = '', error = null, done = false, buf = ''; const tools = [];
    try {
      const res = await fetch(`${base}/agent/runs/${runId}/events`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(90_000)});
      outer: for await (const bytes of res.body) {
        buf += Buffer.from(bytes).toString('utf8'); let idx;
        while ((idx=buf.indexOf('\n\n'))>=0) {
          const frame=buf.slice(0,idx);buf=buf.slice(idx+2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const e=JSON.parse(line.slice(5)), p=e.payload||{};
            if (e.type==='tool_call') tools.push(p.name);
            if (e.type==='done') {content=String(p.content||'');done=true;break outer;}
            if (e.type==='error') {error=String(p.error);break outer;}
          }
        }
      }
    } catch(e) {error=e.message; await api(`/agent/runs/${runId}/abort`, {}).catch(()=>{});}
    let value; try {value=JSON.parse(content.match(/\{[\s\S]*\}/)?.[0]);} catch {}
    const ok=done && !error && tools.length===0 && !!value && c.check(value);
    results.push({key:c.key,name:c.key,ok,output:content,detail:error||'Real model; report interpretation only; no native actions',toolCalls:tools});
    console.log(`${ok?'PASS':'FAIL'} ${c.key}: ${content}`);
  }
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({model,startedAt,finishedAt:new Date().toISOString(),only:cases.map(c=>c.key),results},null,2));
  await fs.writeFile(path.join(out,'report.md'),'# Jev feedback interpretation\n\n'+results.map(r=>`${r.ok?'PASS':'FAIL'} ${r.key}\n\n${r.output}`).join('\n\n'));
  assert(results.every(r=>r.ok), 'feedback interpretation failed');
} finally {
  child.kill('SIGTERM'); await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));
  await log.close(); await fs.rm(bundle,{force:true}); await fs.rm(isolated,{recursive:true,force:true});
}
