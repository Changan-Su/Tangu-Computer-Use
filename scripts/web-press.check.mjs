#!/usr/bin/env node
/**
 * 网页按钮后台 AXPress 与首读等待的真机仪器 —— 走真 bridge.ts、真 helper、一个一次性的 Electron 替身。
 *
 * 判据看页面真正收到的 DOM 事件:helper 对 AXPress 一律回 unknown,不能作为依据。
 *
 *   ① 全新启动的替身,find_roots 之后立刻 observe_ui,读得到网页按钮(不是空壳)
 *   ② 按钮走 ax_only:页面收到一次 isTrusted 的 click,前台没变,结果里有 AXPress 那句提示
 *   ③ 对同一元素再按一次:直接走真实点击,不先走后台(后台那下可能落地,再补一次就按了两下)
 *   ④ 换一个元素:又走回 ax_only
 *   ⑤ helper 报 stale_ref 的那次没送达,再按同一元素还是 ax_only,不算重复
 *   ⑥ 再 observe_ui 不再等
 *   ⑦ 按完网页内容一点没变(这里用「按已经有焦点、点了没反应的按钮」造):提窗口、带截图、叫模型先看不要再按
 *   ⑧ 模型还是再按了同一个元素,窗口从那次按压到现在都没变:照常发真实点击
 *   ⑨ 按完没变、过几秒页面才变(慢页面),模型再按同一个元素:先比出页面变了,这一次什么都不发,告诉模型页面变了、先看
 *   ⑨b 上一条说了「再按一次就是真实点击」:再按,发的确实是真实点击
 *   ⑩ 同一个元素换成右键:那是另一个动作,照常发
 *   ⑪ 计数按钮(每按一下页面上的数字加一):连按三下都走 AXPress,前台不变,提示改成「再按是新的一下、还在后台」
 *   ⑫ 慢按钮(按完 4 秒页面才变):等页面变了再按,还是 AXPress(那一下已经生效,这是新的一下)
 *   ⑬ 已知的取舍:页面自己一直在变时,一个按了没反应的按钮再按一次不再是真实点击(分不清是它起的作用还是页面自己变的)
 *
 * 不动真鼠标、不抢前台:bridge 和 helper 之间夹一层代理,记下每个 act 的 policy 和激活请求,policy = foreground 的 act
 * 和激活都不转发、直接回一个假结果。所以 ③ ⑦ ⑧ 证明的是「决定这么做」,不是真实点击、也不是激活后的截图(那个看 web-covered.check.mjs)。
 * 替身被别的窗口完全盖住时 ② 的按压会走 ⑦ 的路径,② 会红:别让窗口压在屏幕右下角。
 *
 * 负对照(应该在 ① 和 ② 红):node scripts/web-press.check.mjs --root <没有这处改动的检出>
 * 负对照(应该只在 ⑨ 红):--root <把 bridge.ts 里 earlierPressTookEffect 那次调用去掉的副本>
 * 负对照(应该只在 ⑪ ⑫ ⑬ 红):--root <「上一下生效了就不当重试」这处改动之前的检出>
 *
 * 需要:macOS、协议版本和 vendor 一致且已授权的 helper(PI_COMPUTER_USE_HELPER_APP_PATH,缺省用已安装的那份)、
 * Electron(CU_ELECTRON,缺省用 Forsion-Genesis/desktop 装的那份)。
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootArg = process.argv.indexOf('--root')
const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : repo
const electron = process.env.CU_ELECTRON ?? path.resolve(repo, '../../Forsion-Genesis/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const helperApp = process.env.PI_COMPUTER_USE_HELPER_APP_PATH ?? '/Applications/tangu-computer-use.app'
assert.ok(fs.existsSync(electron), `Electron not found: ${electron} (set CU_ELECTRON)`)

const caches = path.join(os.homedir(), 'Library/Caches')
const helperSock = path.join(caches, `cu-web-press-${process.pid}.sock`)
const proxySock = path.join(caches, `cu-web-press-proxy-${process.pid}.sock`)
process.env.PI_CU_SOCKET_PATH = proxySock
process.env.PI_COMPUTER_USE_HELPER_APP_PATH = helperApp

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CU Web Press</title></head><body>
<button id="save">Probe Save</button> <button id="other">Probe Other</button> <button id="stale">Probe Stale</button> <button id="focus">Probe Focus</button> <button id="still">Probe Still</button> <button id="aim">Probe Aim</button> <button id="late">Probe Late</button><p id="lateStatus">Late: idle</p>
<button id="count">Probe Count</button><p id="countStatus">Count: 0</p> <button id="slow">Probe Slow</button><p id="slowStatus">Slow: 0</p>
<button id="tick">Probe Tick</button> <button id="dead">Probe Dead</button><p id="tickStatus">Tick: off</p>
<script>
// 计数按钮:每按一下马上变。慢按钮:按完 4 秒才变(动作结果回去时页面上只有焦点移了过去)。
let counted = 0, slowed = 0, ticked = 0
document.getElementById('count').addEventListener('click', () => { document.getElementById('countStatus').textContent = 'Count: ' + (++counted) })
document.getElementById('slow').addEventListener('click', () => setTimeout(() => { document.getElementById('slowStatus').textContent = 'Slow: ' + (++slowed) }, 4000))
// 按了 Tick 之后页面自己一直在变;Dead 什么都不做
document.getElementById('tick').addEventListener('click', () => setInterval(() => { document.getElementById('tickStatus').textContent = 'Tick: ' + (++ticked) }, 250), { once: true })
document.getElementById('focus').addEventListener('click', () => document.getElementById('still').focus())
document.getElementById('aim').addEventListener('click', () => document.getElementById('late').focus())
// 慢页面:按下去 7 秒后才有变化,动作结果回去的时候(提窗口再等 2 秒)页面还是老样子
let lateDone = 0
document.getElementById('late').addEventListener('click', () => setTimeout(() => { document.getElementById('lateStatus').textContent = 'Late: done ' + (++lateDone) }, 7000))
const post = (o) => fetch('/log', { method: 'POST', body: JSON.stringify(o), keepalive: true })
document.addEventListener('click', (e) => post({ type: 'click', id: e.target.id, trusted: e.isTrusted }), true)
addEventListener('load', () => post({ type: 'load' }))
</script></body></html>`
const MAIN = `const { app, BrowserWindow, screen } = require('electron')
app.setPath('userData', process.env.CU_FIXTURE_DATA)
app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 420, height: 240, x: area.x + area.width - 440, y: area.y + area.height - 260, show: false, title: 'CU Web Press' })
  // 人切到别的桌面(Space)之后,helper 列不到只在原桌面上的窗口(root_not_found):让替身窗口在每个桌面上都在
  win.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true })
  win.once('ready-to-show', () => win.showInactive())
  win.loadURL(process.env.CU_FIXTURE_URL)
})`

const events = []
const server = http.createServer((req, res) => {
  if (req.url === '/log') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { events.push(JSON.parse(b)); res.end('ok') }); return }
  res.setHeader('content-type', 'text/html'); res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

// 代理:一次连接一条 JSON,和 helper 自己的协议一样
const policies = []
const activations = []
let staleNextAct = false
const proxy = net.createServer((client) => {
  let buffer = ''
  client.on('error', () => {})
  client.on('data', (chunk) => {
    buffer += chunk
    const end = buffer.indexOf('\n')
    if (end < 0) return
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    const request = JSON.parse(line)
    if (request.cmd === 'act') policies.push(request.policy)
    if (request.cmd === 'restoreUserFocus') {
      activations.push(request.pid)
      client.end(`${JSON.stringify({ id: request.id, ok: true, result: { restored: true, appRestored: true, windowRestored: false } })}\n`)
      return
    }
    if (request.cmd === 'focusWindow') { client.end(`${JSON.stringify({ id: request.id, ok: true, result: { focused: true } })}\n`); return }
    if (request.cmd === 'act' && staleNextAct) {
      staleNextAct = false
      client.end(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'stale_ref', message: 'Element reference is stale' } })}\n`)
      return
    }
    if (request.cmd === 'act' && request.policy === 'foreground') {
      client.end(`${JSON.stringify({ id: request.id, ok: true, result: { outcome: 'worked', performed: { delivery: 'hid', grounding: 'coordinates' } } })}\n`)
      return
    }
    const helper = net.connect(helperSock)
    helper.on('error', () => client.destroy())
    helper.pipe(client)
    helper.write(`${line}\n`)
  })
})
await new Promise((r) => proxy.listen(proxySock, r))

const askHelper = (cmd, args = {}) => new Promise((resolve, reject) => {
  const s = net.connect(helperSock); let text = ''
  s.on('error', reject)
  s.on('data', (d) => { text += d; if (!text.includes('\n')) return; s.end(); const m = JSON.parse(text.split('\n')[0]); m.ok ? resolve(m.result) : reject(new Error(m.error?.message)) })
  s.write(`${JSON.stringify({ id: 'web-press', cmd, ...args })}\n`)
})

// 编到被测检出的 dist 里:vendor 按 import.meta.url 算包根
const dist = path.join(root, 'tangu-plugins/computer-use/dist')
fs.mkdirSync(dist, { recursive: true })
const outfile = path.join(dist, `.web-press-check-${process.pid}.mjs`)
await build({
  stdin: { contents: "export { executeFind, executeObserve, executeAct, ensureComputerUseSetup } from './src/vendor/bridge.ts'\nexport { executionNote } from './src/foregroundNote.ts'", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent', external: ['node:*'],
  alias: { '@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts') },
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
})
let bridge
try { bridge = await import(pathToFileURL(outfile).href) } finally { fs.rmSync(outfile, { force: true }) }

const pctx = { cwd: root, hasUI: false, ui: { notify: () => {}, select: async () => undefined }, sessionManager: { getBranch: () => [] } }
const text = (result) => result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
const refOf = (body, label) => body.match(new RegExp(`(@e\\d+)[^\\n]*${label}`))?.[1]

await execFileP('open', ['-n', '-g', helperApp, '--args', 'serve', '--socket', helperSock])
for (let i = 0; i < 75; i++) { try { await askHelper('diagnostics'); break } catch { await sleep(200) } }

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-web-press-'))
fs.writeFileSync(path.join(appDir, 'package.json'), '{ "name": "cu-web-press", "version": "1.0.0", "main": "main.js" }')
fs.writeFileSync(path.join(appDir, 'main.js'), MAIN)
const child = spawn(electron, [appDir], { stdio: 'ignore', env: { ...process.env, CU_FIXTURE_URL: `http://127.0.0.1:${server.address().port}/`, CU_FIXTURE_DATA: path.join(appDir, 'data') } })
const clicks = (id) => events.filter((e) => e.type === 'click' && e.id === id)
const failures = []
const check = (name, fn) => { try { fn(); console.log(`✓ ${name}`) } catch (e) { failures.push(name); console.log(`✗ ${name}\n  ${e.message.split('\n')[0]}`) } }
try {
  for (let i = 0; i < 150 && !events.some((e) => e.type === 'load'); i++) await sleep(100)
  assert.ok(events.some((e) => e.type === 'load'), 'fixture did not load')
  await sleep(800)
  await bridge.ensureComputerUseSetup(pctx)
  const found = text(await bridge.executeFind('', { pid: child.pid }, undefined, undefined, pctx))
  const rootRef = found.match(/@r\d+/)?.[0]
  assert.ok(rootRef, `no root: ${found.slice(0, 200)}`)

  const started = Date.now()
  const first = await bridge.executeObserve('', { root: rootRef }, undefined, undefined, pctx)
  const firstMs = Date.now() - started
  const firstBody = text(first)
  check(`① 首读就有网页内容(${firstMs} ms)`, () => assert.ok(refOf(firstBody, 'Probe Save'), 'the first read has no web content'))

  if (!refOf(firstBody, 'Probe Save')) await sleep(3000)
  const observe = () => bridge.executeObserve('', { root: rootRef }, undefined, undefined, pctx)
  // 动作结果只带变化,没有完整大纲,所以每次按之前都重新观察(ref 也每次都换)
  const observed = [] // 排查用:每次按之前那次观察的全文(CU_WEB_PRESS_DUMP 时落盘)
  const press = async (label) => {
    const state = await observe()
    observed.push({ label, body: text(state) })
    return bridge.executeAct('', { stateId: state.details.capture.stateId, actions: [{ action: 'click', ref: refOf(text(state), label) }] }, undefined, undefined, pctx)
  }
  policies.length = 0
  const state = await observe()
  // 紧贴着动作采前台:隔得久了,用户切 App 也会算到这次按压头上
  const frontBefore = await askHelper('getFrontmost')
  const pressed = await bridge.executeAct('', { stateId: state.details.capture.stateId, actions: [{ action: 'click', ref: refOf(text(state), 'Probe Save') }] }, undefined, undefined, pctx)
  const frontAfter = await askHelper('getFrontmost')
  await sleep(500)
  const firstPolicies = [...policies]
  check(`② 按钮走 AXPress(${firstPolicies.join(' → ')})`, () => {
    assert.deepEqual(firstPolicies, ['ax_only'])
    assert.equal(clicks('save').length, 1, 'the page got no click')
    assert.equal(clicks('save')[0].trusted, true)
    assert.equal(pressed.details.execution.steps?.[0]?.delivery ?? pressed.details.execution.delivery, 'ax')
    assert.equal(pressed.details.execution.steps?.[0]?.accessibilityPress ?? pressed.details.execution.accessibilityPress, true)
    assert.match(bridge.executionNote(pressed.details), /press the same element again/, 'the model is not told what to do next')
    assert.ok(!(pressed.details.execution.steps?.[0]?.pressConfirmed ?? pressed.details.execution.pressConfirmed), 'only focus moved onto the button: that is not the press acting')
    assert.deepEqual(activations, [], 'the tree changed, so nothing should have come forward')
  })
  check(`② 前台没变(${frontBefore.appName} → ${frontAfter.appName})`, () => { assert.equal(frontAfter.pid, frontBefore.pid); assert.notEqual(frontAfter.pid, child.pid) })

  policies.length = 0
  await press('Probe Save')
  const repeatPolicies = [...policies]
  check(`③ 再按同一元素走真实点击(${repeatPolicies.join(' → ')})`, () => { assert.deepEqual(repeatPolicies, ['foreground']); assert.equal(clicks('save').length, 1, 'the repeat reached the page before the real click') })

  policies.length = 0
  await press('Probe Other')
  await sleep(500)
  const otherPolicies = [...policies]
  check(`④ 换一个元素回到 AXPress(${otherPolicies.join(' → ')})`, () => { assert.deepEqual(otherPolicies, ['ax_only']); assert.equal(clicks('other').length, 1) })

  staleNextAct = true
  await press('Probe Stale').catch(() => {})
  policies.length = 0
  await press('Probe Stale')
  await sleep(500)
  const staleRetry = [...policies]
  check(`⑤ 没送达的那次不算重复(${staleRetry.join(' → ')})`, () => { assert.deepEqual(staleRetry, ['ax_only']); assert.equal(clicks('stale').length, 1) })

  const again = Date.now()
  await observe()
  const againMs = Date.now() - again
  check(`⑥ 之后的观察不再等(${againMs} ms)`, () => assert.ok(againMs < 1500))

  const focused = await press('Probe Focus')
  await sleep(500)
  policies.length = 0
  activations.length = 0
  const unchanged = await press('Probe Still')
  const stillPolicies = [...policies]
  await sleep(500)
  check(`⑦ 按完网页没变:提窗口、带截图、叫模型先看不要再按(${stillPolicies.join(' → ')})`, () => {
    assert.deepEqual(stillPolicies, ['ax_only'])
    assert.equal(clicks('still').length, 1)
    assert.deepEqual(activations, [child.pid], 'the window was not brought forward')
    assert.ok(unchanged.content.some((block) => block.type === 'image'), 'no screenshot attached')
    assert.doesNotMatch(unchanged.content[0].text, /requested explicitly/)
    assert.equal(unchanged.details.execution.pressUnconfirmed, 'current_screenshot')
    assert.match(bridge.executionNote(unchanged.details), /Do not press again now/, 'the model is not told to hold off')
    assert.match(bridge.executionNote(unchanged.details), /only look/, 'the next step offered is not a read')
  })

  policies.length = 0
  const repeated = await press('Probe Still')
  const repeatedPolicies = [...policies]
  // 排查用:CU_WEB_PRESS_DUMP=<目录> 时把 ⑦ 之前、⑦ 之后、⑧ 这三次返回的状态文字落盘,红了能直接比树里哪一行变了
  if (process.env.CU_WEB_PRESS_DUMP) {
    fs.mkdirSync(process.env.CU_WEB_PRESS_DUMP, { recursive: true })
    for (const [name, r] of [['1-after-focus', focused], ['2-after-still', unchanged], ['3-repeat-still', repeated]]) {
      fs.writeFileSync(path.join(process.env.CU_WEB_PRESS_DUMP, `${name}.txt`), `${text(r)}

--- execution
${JSON.stringify(r.details?.execution ?? null, null, 2)}
`)
    }
    // 按之前各次观察的整棵树(最后三次 = ⑦ 之前那次聚焦、⑦、⑧),加上 ⑧ 之后再看一眼:多出来的节点在这里找
    observed.slice(-3).forEach((o, i) => fs.writeFileSync(path.join(process.env.CU_WEB_PRESS_DUMP, `0-observe-${i + 1}-before-${o.label.replace(/\s+/g, '-')}.txt`), o.body))
    fs.writeFileSync(path.join(process.env.CU_WEB_PRESS_DUMP, '4-observe-after-repeat.txt'), text(await observe()))
  }
  check(`⑧ 再按、窗口一直没变:照常发真实点击(${repeatedPolicies.join(' → ') || '没有动作'}${repeated.details?.execution?.earlierPressTookEffect ? `,被拦下的依据:${repeated.details.execution.earlierPressTookEffect}` : ''})`, () => {
    assert.deepEqual(repeatedPolicies, ['foreground'])
    assert.ok(!repeated.details.execution.earlierPressTookEffect, 'nothing moved, yet the click was held back')
  })

  await press('Probe Aim')
  await sleep(500)
  policies.length = 0
  const slow = await press('Probe Late')
  const slowPolicies = [...policies]
  for (let i = 0; i < 100 && !/Late: done 1/.test(text(await observe())); i++) await sleep(200)
  policies.length = 0
  const held = await press('Probe Late')
  const heldPolicies = [...policies]
  check(`⑨ 再按之前页面已经变了:这一次什么都不发,告诉模型页面变了、先看(${slowPolicies.join(' → ')} 之后 ${heldPolicies.join(' → ') || '没有动作'})`, () => {
    assert.deepEqual(slowPolicies, ['ax_only'])
    assert.equal(slow.details.execution.pressUnconfirmed, 'current_screenshot', 'the slow press was not left unconfirmed, so this case tests nothing')
    assert.deepEqual(heldPolicies, [], 'a second press went out')
    assert.equal(clicks('late').length, 1)
    assert.equal(held.details.execution.earlierPressTookEffect, 'tree')
    assert.match(text(held), /Nothing was sent/)
    assert.match(bridge.executionNote(held.details), /most likely took effect late/)
    assert.match(bridge.executionNote(held.details), /Check the returned state/)
  })
  policies.length = 0
  await press('Probe Late')
  const promisedPolicies = [...policies]
  check(`⑨b 上一条许诺的「再按一次是真实点击」兑现了(${promisedPolicies.join(' → ') || '没有动作'})`, () => assert.deepEqual(promisedPolicies, ['foreground']))

  await press('Probe Aim')
  await sleep(500)
  const slowAgain = await press('Probe Late')
  for (let i = 0; i < 100 && !/Late: done 2/.test(text(await observe())); i++) await sleep(200)
  policies.length = 0
  const lateState = await observe()
  const rightClick = await bridge.executeAct('', { stateId: lateState.details.capture.stateId, actions: [{ action: 'click', ref: refOf(text(lateState), 'Probe Late'), button: 'right' }] }, undefined, undefined, pctx)
  const rightPolicies = [...policies]
  check(`⑩ 同一个元素换成右键:照常发(${rightPolicies.join(' → ')})`, () => {
    assert.equal(slowAgain.details.execution.pressUnconfirmed, 'current_screenshot', 'the slow press was not left unconfirmed, so this case tests nothing')
    assert.ok(rightPolicies.length > 0, 'the right click was held back')
    assert.ok(!rightClick.details.execution.earlierPressTookEffect)
  })

  const stepOf = (r) => r.details.execution.steps?.[0] ?? r.details.execution
  // ── ⑪ 计数按钮:上一下在页面上看得到效果,再按同一个是新的一下,不是重试 ──
  policies.length = 0
  const activatedBefore = activations.length
  const countFrontBefore = await askHelper('getFrontmost')
  const counts = []
  for (let i = 0; i < 3; i++) { counts.push(await press('Probe Count')); await sleep(400) }
  const countFrontAfter = await askHelper('getFrontmost')
  const countPolicies = [...policies]
  check(`⑪ 计数按钮连按三下都走 AXPress,前台不变(${countPolicies.join(' → ')})`, () => {
    assert.deepEqual(countPolicies, ['ax_only', 'ax_only', 'ax_only'])
    assert.equal(clicks('count').length, 3, 'the page did not get three clicks')
    assert.ok(clicks('count').every((c) => c.trusted))
    assert.equal(activations.length, activatedBefore, 'a window was brought forward')
    assert.equal(countFrontAfter.pid, countFrontBefore.pid); assert.notEqual(countFrontAfter.pid, child.pid)
    for (const r of counts) {
      assert.equal(stepOf(r).pressConfirmed, true, 'the press was not marked as having acted')
      assert.match(bridge.executionNote(r.details), /is a new press/, 'the model is not told that a repeat stays in the background')
      assert.doesNotMatch(bridge.executionNote(r.details).split('\n').find((l) => /This press went through accessibility/.test(l)) ?? '', /real click/, 'a real click is still promised')
    }
  })

  // ── ⑫ 慢按钮:结果回去时只有焦点移了过去(没确认),页面 4 秒后才变;模型看到变了再按 → 新的一下 ──
  policies.length = 0
  const slowFirst = await press('Probe Slow')
  const slowFirstPolicies = [...policies]
  for (let i = 0; i < 100 && !/Slow: 1/.test(text(await observe())); i++) await sleep(200)
  policies.length = 0
  await press('Probe Slow')
  await sleep(400)
  const slowRepeatPolicies = [...policies]
  check(`⑫ 页面慢一点才变:等它变了再按,还是 AXPress(${slowFirstPolicies.join(' → ')} 之后 ${slowRepeatPolicies.join(' → ') || '没有动作'})`, () => {
    assert.deepEqual(slowFirstPolicies, ['ax_only'])
    assert.ok(!stepOf(slowFirst).pressConfirmed, 'the slow press was confirmed at once, so this case tests nothing')
    assert.ok(!stepOf(slowFirst).pressUnconfirmed, 'the slow press showed nothing at all (not even focus), so this case tests nothing')
    assert.match(bridge.executionNote(slowFirst.details), /while the page still shows no change/)
    assert.deepEqual(slowRepeatPolicies, ['ax_only'])
    assert.equal(clicks('slow').length, 2)
  })

  // ── ⑬ 已知的取舍(放最后:按了 Tick 之后页面就一直在变) ──
  // 页面自己在变时,「上一下之后页面变了」分不清是按钮起的作用还是页面自己变的,所以没反应的按钮再按一次也还是后台按下。
  // 以后要是改成「按之前再读一次树、和它比」,这里会变成 ax_only → foreground,把断言一起改掉。
  await press('Probe Tick')
  await sleep(700)
  policies.length = 0
  await press('Probe Dead')
  await sleep(400)
  await press('Probe Dead')
  const deadPolicies = [...policies]
  check(`⑬ 已知的取舍:页面自己在变时,没反应的按钮再按一次不再是真实点击(${deadPolicies.join(' → ')})`, () => {
    assert.deepEqual(deadPolicies, ['ax_only', 'ax_only'])
    assert.equal(clicks('dead').length, 2)
  })
} finally {
  child.kill()
  await askHelper('shutdown').catch(() => {})
  const { stdout } = await execFileP('pgrep', ['-f', helperSock]).catch(() => ({ stdout: '' }))
  for (const pid of stdout.split('\n').filter(Boolean)) { try { process.kill(Number(pid)) } catch {} }
  server.close(); proxy.close()
  for (const file of [helperSock, `${helperSock}.lock`, proxySock]) fs.rmSync(file, { force: true })
  await sleep(300); fs.rmSync(appDir, { recursive: true, force: true })
}
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1) }
process.exit(0)
