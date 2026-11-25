// Real Chromium through the bundled tool provider, without the extension or desktop helper.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import plugin from '../tangu-plugins/computer-use/dist/index.js';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = [];
let scrollRequested = false;
const server = createServer(async (req, res) => {
  if (req.url === '/scroll') { res.end(String(scrollRequested)); return; }
  if (req.url === '/event' && req.method === 'POST') {
    let data = '';
    for await (const chunk of req) data += chunk;
    events.push(JSON.parse(data));
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Editor</title>
    <label>Text <input id="field" value="original"></label>
    <button id="apply">Apply</button><button id="blocked">Locked</button>
    <button id="vanish" onclick="this.remove()">Vanish</button><label>Read only <input readonly></label><label>Redirect <input id="redirect" value="old"></label><output></output>
    <canvas id="surface" style="position:fixed;left:80%;top:80%;width:10%;height:10%;background:green"></canvas>
    <div style="height:200vh"></div>
    <script>
    redirect.select = () => field.focus();
    surface.onclick = e => { document.querySelector('output').textContent = e.isTrusted ? 'Canvas pressed' : 'Synthetic'; };
    const interval = setInterval(async () => {
      if (await (await fetch('/scroll')).text() === 'true') {
        clearInterval(interval); scrollTo(0,300); document.title = 'Scrolled fixture';
      }
    }, 100);
    field.oninput = e => fetch('/event', {method:'POST', body:JSON.stringify(['input',field.value,e.isTrusted])});
    for (const button of document.querySelectorAll('button')) button.onclick = async e => {
      await fetch('/event', {method:'POST',body:JSON.stringify([button.id,field.value,e.isTrusted])});
      document.querySelector('output').textContent = 'Draft saved';
    };
    vanish.onclick = e => { e.currentTarget.remove(); };
    const cover = document.createElement('div');
    const rect = blocked.getBoundingClientRect();
    cover.style.cssText = 'position:fixed;z-index:5;background:#ccc;inset:' + rect.top+'px auto auto '+rect.left+'px;width:'+rect.width+'px;height:'+rect.height+'px';
    document.body.append(cover);
    </script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const settings = {};
let provider;
plugin.activate({ registerPlugin(meta) { provider = meta.toolProvider; }, registerCommand() {}, log() {},
  sdk: { pluginStore: { isPluginEnabledSync: () => true, getScopeSettings: () => settings } } });
const byName = new Map(provider.tools().map(t => [t.name, t]));
const images = [];
const run = (tool, args, sessionId = 'A') => byName.get(tool).execute(args, { appId:'fixture', userId:'fixture', execMode:'host', collectImage:image => images.push(image), sessionId });
const state = text => { const match = /State ([\da-f-]{36})\./.exec(text); assert.ok(match, text); return match[1]; };
const root = text => { const match = /@r\d+/.exec(text); assert.ok(match, text); return match[0]; };
const ref = (text, role, name) => {
  const match = new RegExp('(@e\\d+) ' + role + ' "' + name + '"').exec(text);
  assert.ok(match, text);
  return match[1];
};
const front = async () => (await exec('/usr/bin/lsappinfo', ['front'])).stdout.trim();
let sampling = process.platform === 'darwin';
const before = sampling ? await front() : undefined;
let samples = 0;
const focusChanges = [];
const sampler = (async () => {
  while (sampling) {
    const current = await front();
    samples++;
    if (current !== before) focusChanges.push(current);
    await sleep(40);
  }
})();
try {
  delete process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS;
  await assert.rejects(run('launch_browser', {url}), /Private|reserved|localhost/);
  process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = '1';
  const start = performance.now();
  const [a, b] = await Promise.all([run('launch_browser', {url}), run('launch_browser', {url}, 'B')]);
  const launchMs = Math.round(performance.now() - start);
  assert.notEqual(root(a), root(b));
  await assert.rejects(run('read_text', {stateId:state(a), ref:'@e1'}, 'B'), /another conversation/);
  await assert.rejects(run('observe_ui', {root:root(a)}, 'B'), /no longer available/);
  assert.match(await run('find_roots', {kind:'browser_page'}), /Found 1 matching root/);
  await assert.rejects(run('launch_browser', {url,visible:true}), /Strict background/);
  const actionStart = performance.now();
  const acted = await run('act_ui', {stateId:state(a), actions:[
    {action:'setText', ref:ref(a,'textbox','Text'), text:'Blue Finch'},
    {action:'click', ref:ref(a,'button','Apply')},
  ], expect:{text:'Draft saved'}});
  const actionMs = Math.round(performance.now() - actionStart);
  assert.match(acted, /Draft saved/);
  assert.deepEqual(events, [['input','Blue Finch',true],['apply','Blue Finch',true]]);
  await assert.rejects(run('act_ui', {stateId:state(a), actions:[{action:'click',ref:ref(a,'button','Apply')}]}), /stale|epoch/i);
  const observe = () => run('observe_ui', {root:root(a)});
  let view = await observe();
  await assert.rejects(run('act_ui', {stateId:state(view),actions:[{action:'click',ref:ref(view,'button','Locked')}]}), /obscured/);
  view = await observe();
  await assert.rejects(run('act_ui', {stateId:state(view), actions:[{action:'setText',ref:ref(view,'textbox','Read only'),text:'wrong'}]}), /not editable/);
  assert.equal(events.length, 2);
  view = await observe();
  await assert.rejects(run('act_ui',{stateId:state(view),actions:[{action:'setText',ref:ref(view,'textbox','Redirect'),text:'wrong field'}]}), /Focus moved/);
  view = await observe();
  await assert.rejects(run('act_ui', {stateId:state(view), actions:[{action:'click', ref:ref(view,'button','Vanish'),clickCount:2}]}), /1 click.s. already delivered/);
  view = await observe();
  await assert.rejects(run('act_ui',{stateId:state(view),actions:[{action:'click',x:1,y:1}]}), /mode=visual/);
  const visual = await run('observe_ui',{root:root(a),mode:'visual'});
  assert.match(images.at(-1)?.url ?? '', /^data:image\/png;base64,/);
  const match = /viewport (\d+) × (\d+)/.exec(visual);
  assert.ok(match, visual);
  const point = {action:'click', x: Math.floor(Number(match[1])*0.85), y: Math.floor(Number(match[2])*0.85)};
  assert.match(await run('act_ui',{stateId:state(visual),actions:[point],expect:{text:'Canvas pressed'}}), /Canvas pressed/);
  const oldScreen = await run('observe_ui',{root:root(a),mode:'visual'});
  scrollRequested = true;
  for (let i = 0; i < 30; i++) {
    if ((await run('find_roots',{kind:'browser_page'})).includes('Scrolled fixture')) break;
    await sleep(40);
  }
  await assert.rejects(run('act_ui',{stateId:state(oldScreen),actions:[point]}), /moved since the screenshot/);
  assert.equal(events.length, 2);
  const other = await run('evaluate_browser',{stateId:state(b),expression:'document.querySelector("input").value'},'B');
  assert.match(other, /Evaluation value: "original"/);
  const observations = [];
  for (let i = 0; i < 25; i++) {
    const t = performance.now();
    await observe();
    observations.push(performance.now() - t);
  }
  const imageCount = images.length;
  const picture = await run('launch_browser',{url,mode:'pixels'},'C');
  assert.match(picture,/Screenshot only/);
  assert.doesNotMatch(picture,/Blue Finch|Controls in this state|@e\d+|Page text/);
  assert.equal(images.length,imageCount+1);
  assert.match(images.at(-1).url,/^data:image\/png;base64,/);
  for (const [tool,args] of [
    ['evaluate_browser',{expression:'document.title'}], ['search_ui',{role:'button'}],
    ['read_text',{ref:'@e1'}], ['wait_for',{text:'Draft saved'}],
    ['act_ui',{actions:[{action:'click',ref:'@e1'}]}],
    ['act_ui',{actions:[{action:'click',x:1,y:1}],expect:{text:'Draft saved'}}],
  ]) await assert.rejects(run(tool,{...args,stateId:state(picture)},'C'),/Screenshot-only/);
  const discovery = await run('find_roots',{kind:'browser_page'},'C');
  assert.doesNotMatch(discovery, /Editor|127\.0\.0\.1/);
  await assert.rejects(run('act_ui',{stateId:state(picture),actions:[{action:'click',x:1,y:1},{action:'click',x:1,y:1}]},'C'),/one screenshot-grounded action/);
  const fresh = await run('observe_ui',{root:root(picture), magnify:{x:2,y:2,width:10,height:10}, samplePixels:[{x:2,y:2}]},'C');
  assert.match(fresh,/RGB\(255,255,255\)/);
  assert.match(fresh,/second image is a 2× detail/);
  assert.equal(images.at(-1).name,'detail-2x.png');
  const crop = Buffer.from(images.at(-1).url.split(',')[1], 'base64');
  assert.equal(crop.readUInt32BE(16),20);
  assert.equal(crop.readUInt32BE(20),20);
  const after = await run('act_ui',{stateId:state(fresh),actions:[{action:'moveMouse',x:10,y:10}]},'C');
  assert.match(after,/Screenshot only/);
  assert.equal(images.length,imageCount+4);
  settings.browser_use = false;
  await assert.rejects(observe(), /disabled/);
  sampling = false;
  await sampler;
  if (before !== undefined) {
    assert.match(before, /ASN:/);
    assert.ok(samples > 0);
    assert.deepEqual(focusChanges, [], 'Foreground changed during the fixture. Rerun on an idle desktop.');
  }
  observations.sort((x,y) => x-y);
  console.log(JSON.stringify({ launchTwoMs:launchMs, fillClickVerifyMs:actionMs, observeMedianMs:observations[12], focusSamples:samples, focusChanges:focusChanges.length, events }));
} finally {
  sampling = false;
  await sampler;
  server.close();
  await plugin.deactivate();
}
