// Real Chromium through the bundled tool provider, without the extension or desktop helper.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import WebSocket from 'ws';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import plugin from '../tangu-plugins/computer-use/dist/index.js';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = [];
let detailEvent;
const scrollReceipts = new Set();
const waitFor = async predicate => {
  for (let i=0; i<100; i++) { if (predicate()) return; await sleep(30); }
  assert.fail('Fixture did not acknowledge the event.');
};
let scrollRequested = false;
const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/scrolled?')) { scrollReceipts.add(req.url.split('?')[1]); res.end(); return; }
  if (req.url === '/detail-event' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    detailEvent = JSON.parse(body);
    res.end(); return;
  }
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
    <div id="probe" style="position:fixed;left:240px;top:110px;width:18px;height:14px;background:#50b12c"></div>
    <div id="cornerProbe" style="position:fixed;left:1050px;top:610px;width:18px;height:14px;background:#235bdf"></div>
    <div id="stripes" style="position:fixed;left:610px;top:370px;width:20px;height:20px;background:repeating-linear-gradient(90deg,black 0 .5px,white .5px 1px)"></div>
    <div style="height:200vh"></div>
    <script>
    probe.onpointerdown = cornerProbe.onpointerdown = stripes.onpointerdown = e => fetch('/detail-event', {method:'POST',body:JSON.stringify([e.clientX,e.clientY,scrollY,e.isTrusted])});
    redirect.select = () => field.focus();
    surface.onclick = e => { document.querySelector('output').textContent = e.isTrusted ? 'Canvas pressed' : 'Synthetic'; };
    const interval = setInterval(async () => {
      if (await (await fetch('/scroll')).text() === 'true') {
        clearInterval(interval); scrollTo(0,300); document.title = 'Scrolled fixture'; if (scrollY===300) fetch('/scrolled?'+location.search.slice(1));
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
const defaultActions = provider.tools().find(t => t.name === 'act_ui').definition.function.parameters;
assert.deepEqual(defaultActions.required, ['stateId','actions']);
assert.equal(defaultActions.properties.view,undefined);
settings.compact_browser_controls = true;
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
const privateProfiles = await mkdtemp(path.join(tmpdir(),'cu-geometry-check-'));
let geometrySocket;
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
  // Put just this test session's browser profile in a known empty directory.
  const tempVar = process.platform==='win32'?'TEMP':'TMPDIR';
  const previousTemp = process.env[tempVar];
  let picture;
  try {
    process.env[tempVar]=privateProfiles;
    picture = await run('launch_browser',{url:url+'?geometry',mode:'pixels'},'C');
  } finally {
    if (previousTemp===undefined) delete process.env[tempVar]; else process.env[tempVar]=previousTemp;
  }
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
  assert.match(fresh,/second image is visible, it is a 2× detail/);
  assert.equal(images.at(-1).name,'detail-2x.png');
  const crop = Buffer.from(images.at(-1).url.split(',')[1], 'base64');
  assert.equal(crop.readUInt32BE(16),20);
  assert.equal(crop.readUInt32BE(20),20);
  const after = await run('act_ui',{stateId:state(fresh),actions:[{action:'moveMouse',x:10,y:10}]},'C');
  assert.match(after,/Screenshot only/);
  assert.equal(images.length,imageCount+4);
  const centered = await run('observe_ui',{root:root(picture), magnify:{x:1,y:1}},'C');
  assert.doesNotMatch(centered, /first inspect the neighborhood/);
  assert.match(centered,/at \(0,0\), size 256 × 160/);
  await assert.rejects(run('observe_ui',{root:root(picture),magnify:{x:1,y:1,width:10}},'C'),/both detail dimensions/);
  const inspectArgs = {root:root(picture),mode:'pixels',magnify:{x:0,y:0,width:10,height:10}};
  let offered = 0;
  const capacity = await byName.get('observe_ui').execute(inspectArgs, {sessionId:'C',appId:'fixture',userId:'fixture',execMode:'host', collectImage:() => ++offered === 1});
  assert.match(capacity,/Magnified detail omitted/);
  await assert.rejects(run('observe_ui',{...inspectArgs,root:{}},'C'),/exact root/);
  const plain = await run('observe_ui',{root:root(picture),mode:'pixels'},'C');
  assert.doesNotMatch(plain,/first inspect the neighborhood/);
  const imageCountBeforeError=images.length;
  await assert.rejects(run('observe_ui',{...inspectArgs,magnify:{x:99999,y:0,width:2,height:2}},'C'),/within the full screenshot/);
  assert.equal(images.length,imageCountBeforeError);
  // Observe after a real page scroll. The striped control stays fixed in the viewport.
  await waitFor(()=>scrollReceipts.has('geometry'));
  const scrolledPixels = await run('observe_ui',{root:root(picture), mode:'pixels'},'C');
  const full = PNG.sync.read(Buffer.from(images.at(-1).url.split(',')[1],'base64'));
  const pxPerCss = full.width / 1280;
  const focusArgs = {root:root(picture),stateId:state(scrolledPixels),focus:{x:Math.round(620*pxPerCss),y:Math.round(380*pxPerCss)}};
  const viewOf = text => {
    const match = /view:"(v[0-9a-f]+-[a-z0-9]+)"/.exec(text);
    assert.ok(match,text); return match[1];
  };
  const detailState = await run('observe_ui',{view:viewOf(scrolledPixels),focus:focusArgs.focus},'C');
  assert.match(detailState,/Detail view/);
  const detail = PNG.sync.read(Buffer.from(images.at(-1).url.split(',')[1],'base64'));
  assert.deepEqual([detail.width,detail.height],[640,384]);
  if (pxPerCss === 1) {
    const line = (img,x,y) => Array.from({length:8},(_,i)=>img.data[(y*img.width+x+i)*4]);
    assert.equal(new Set(line(full,616,380)).size,1);
    assert.ok(new Set(line(detail,320,192)).size>1,'the detail must resolve subpixel stripes lost in the overview');
  }
  await assert.rejects(run('observe_ui',{...focusArgs,stateId:state(detailState)},'C'),/inside a full screenshot/);
  await assert.rejects(run('observe_ui',{...focusArgs,focus:{x:-1,y:0}},'C'),/inside a full screenshot/);
  await assert.rejects(run('observe_ui',{...focusArgs,root:root(a)},'C'),/belonging to this browser root/);
  await assert.rejects(run('observe_ui',focusArgs,'B'),/another conversation/);
  // A detail click must still use its original mapping after a later read gives the model a full image.
  await assert.rejects(run('observe_ui',{view:viewOf(detailState),samplePixels:[{x:0,y:0}]},'C'),/full-image coordinates/);
  await assert.rejects(run('observe_ui',{stateId:' '+state(detailState)+' ',root:root(a)},'C'),/belonging to this browser root/);
  const backToFull = await run('observe_ui',{stateId:' '+state(detailState)+' '},'C');
  assert.doesNotMatch(backToFull,/Detail view/);
  const bound = {view:viewOf(detailState),click:[320,192]};
  await assert.rejects(run('act_ui',bound,'B'),/another conversation/);
  await assert.rejects(run('act_ui',{...bound,actions:[{action:'keypress',keys:['return']}]},'C'),/takes only/);
  await assert.rejects(run('act_ui',{...bound,stateId:state(backToFull)},'C'),/one screenshot view/);
  await assert.rejects(run('act_ui',{view:'expired',click:[0,0]},'C'),/unavailable/);
  await assert.rejects(run('act_ui',{...bound,click:[640,384]},'C'),/outside/);
  assert.equal(detailEvent,undefined);
  await assert.rejects(run('act_ui',{stateId:state(detailState),click:[320,192]},'B'),/another conversation/);
  settings.compact_browser_controls = false;
  await assert.rejects(run('act_ui',bound,'C'),/disabled/);
  await assert.rejects(run('act_ui',{stateId:state(detailState),click:[320,192]},'C'),/disabled/);
  settings.compact_browser_controls = true;
  const reset = await run('act_ui',{stateId:state(detailState),click:[320,192]},'C');
  await assert.rejects(run('act_ui',bound,'C'),/stale|epoch/i);
  assert.doesNotMatch(reset,/Detail view/);
  await waitFor(()=>detailEvent);
  assert.deepEqual(detailEvent,[620,380,300,true]);
  await assert.rejects(run('observe_ui',focusArgs,'C'),/stale|epoch/i);
  const edge = await run('observe_ui',{root:root(picture),stateId:state(reset),focus:{x:0,y:0}},'C');
  assert.match(edge,/Detail view/);
  const profiles = (await readdir(privateProfiles,{withFileTypes:true}))
    .filter(entry=>entry.isDirectory() && entry.name.startsWith('tangu-browser-'));
  assert.equal(profiles.length,1,'Expected exactly one managed profile in the isolated test directory.');
  const profile = profiles[0].name;
  const portFile = await readFile(path.join(privateProfiles,profile,'DevToolsActivePort'),'utf8');
  const pages = await (await fetch('http://127.0.0.1:'+portFile.split('\n')[0]+'/json/list')).json();
  geometrySocket = new WebSocket(pages.find(p=>p.url===url+'?geometry').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{geometrySocket.once('open',resolve);geometrySocket.once('error',reject);});
  let cmdId=0;
  const emulation=(method,params)=>new Promise((resolve,reject)=>{
    const id=++cmdId;
    const timer=setTimeout(()=>{geometrySocket.off('message',result); reject(Error('CDP fixture timeout'));},3000);
    const result=data=>{
      const msg=JSON.parse(data);
      if(msg.id!==id)return;
      clearTimeout(timer);geometrySocket.off('message',result);
      if(msg.error)reject(Error(msg.error.message));else resolve();
    };
    geometrySocket.on('message',result);geometrySocket.send(JSON.stringify({id,method,params}));
  });
  const marker = (rgb = [80,177,44]) => {
    const img = PNG.sync.read(Buffer.from(images.at(-1).url.split(',')[1],'base64'));
    // First solid marker pixel, just inside its top left. Independent of the product's transform.
    for(let pos=0;pos<img.data.length;pos+=4) {
      if(img.data[pos]===rgb[0] && img.data[pos+1]===rgb[1] && img.data[pos+2]===rgb[2]) {
        return {x:(pos/4)%img.width+2,y:Math.floor(pos/4/img.width)+2};
      }
    }
    assert.fail('Colored marker absent from the returned image.');
  };
  await emulation('Emulation.setDeviceMetricsOverride',{width:1280,height:813,deviceScaleFactor:1.75,mobile:false});
  const observePixels = () => run('observe_ui',{root:root(picture),mode:'pixels'},'C');
  const fractional = await observePixels();
  const coarse = marker();
  const fractionalDetail = await run('observe_ui',{root:root(picture),stateId:state(fractional),focus:{x:coarse.x+78,y:coarse.y+40}},'C');
  detailEvent=undefined;
  const finePoint = marker();
  await run('act_ui',{view:viewOf(fractionalDetail),click:[finePoint.x,finePoint.y]},'C');
  await waitFor(()=>detailEvent);
  assert.ok(detailEvent[0]>=240 && detailEvent[0]<=242 && detailEvent[1]>=110 && detailEvent[1]<=112 && detailEvent[3],JSON.stringify(detailEvent));
  // Switch from the opposite corner to the top-left panel at fractional DPI.
  const regionBase = await observePixels();
  const regionArgs = {view:viewOf(regionBase),region:'bottom-right'};
  await assert.rejects(run('observe_ui',regionArgs,'B'),/another conversation/);
  await assert.rejects(run('observe_ui',{...regionArgs,focus:{x:0,y:0}},'C'),/one at a time/);
  await assert.rejects(run('observe_ui',{...regionArgs,region:'other'},'C'),/named region/);
  const corner = await run('observe_ui',regionArgs,'C');
  assert.match(corner,/Region: bottom-right/);
  const cornerPoint = marker([35,91,223]);
  detailEvent=undefined;
  await run('act_ui',{view:viewOf(corner),click:[cornerPoint.x,cornerPoint.y]},'C');
  await waitFor(()=>detailEvent);
  assert.ok(detailEvent[0]>=1050 && detailEvent[0]<=1052 && detailEvent[1]>=610 && detailEvent[1]<=612 && detailEvent[3],JSON.stringify(detailEvent));
  const refreshed = await observePixels();
  const sibling = await run('observe_ui',{view:viewOf(refreshed),region:'bottom-right'},'C');
  const panel = await run('observe_ui',{view:viewOf(sibling),region:'top-left'},'C');
  assert.match(panel,/Region: top-left/);
  const panelImage = PNG.sync.read(Buffer.from(images.at(-1).url.split(',')[1],'base64'));
  assert.ok(Math.max(panelImage.width,panelImage.height)<=1600);
  const panelPoint = marker();
  const precise = await run('observe_ui',{view:viewOf(panel),focus:panelPoint},'C');
  const precisePoint = marker();
  const zoomed = PNG.sync.read(Buffer.from(images.at(-1).url.split(',')[1],'base64'));
  assert.ok(Math.abs(zoomed.width-640)<6 && Math.abs(zoomed.height-384)<6);
  detailEvent=undefined;
  await run('act_ui',{view:viewOf(precise),click:[precisePoint.x,precisePoint.y]},'C');
  await waitFor(()=>detailEvent);
  assert.ok(detailEvent[0]>=240 && detailEvent[0]<=242 && detailEvent[1]>=110 && detailEvent[1]<=112 && detailEvent[3],JSON.stringify(detailEvent));
  await assert.rejects(run('observe_ui',regionArgs,'C'),/stale|epoch/i);
  const beforeZoom = await observePixels();
  const beforeZoomPanel = await run('observe_ui',{view:viewOf(beforeZoom),region:'left'},'C');
  await emulation('Emulation.setPageScaleFactor',{pageScaleFactor:2});
  await sleep(80);
  await assert.rejects(run('observe_ui',{view:viewOf(beforeZoomPanel),region:'right'},'C'),/viewport moved/i);
  const pinched = await observePixels();
  assert.match(pinched,/magnify/);
  assert.doesNotMatch(pinched,/region:POSITION/);
  const pinchPoint = marker();
  await assert.rejects(run('observe_ui',{view:viewOf(beforeZoom),samplePixels:[{x:0,y:0}]},'C'),/stale/);
  await assert.rejects(run('observe_ui',{root:root(picture),stateId:state(pinched),focus:pinchPoint},'C'),/page zoom/);
  detailEvent=undefined;
  await run('act_ui',{stateId:state(pinched),actions:[{action:'click',...pinchPoint}]},'C');
  await waitFor(()=>detailEvent);
  assert.ok(detailEvent[0]>=240 && detailEvent[0]<=242 && detailEvent[1]>=110 && detailEvent[1]<=112 && detailEvent[3],JSON.stringify(detailEvent));
  settings.compact_browser_controls = false;
  await assert.rejects(run('observe_ui',{stateId:state(pinched),region:'left'},'C'),/disabled/);
  assert.doesNotMatch(await observePixels(),/view:"v/);
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
  geometrySocket?.close();
  await plugin.deactivate();
  await rm(privateProfiles,{recursive:true,force:true,maxRetries:3});
}
