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
 *   ⑦ 按完树一点没变(页面被盖住时就是这样,这里用「按已经有焦点、点了没反应的按钮」造):提窗口、带截图、不叫模型再按
 *
 * 不动真鼠标、不抢前台:bridge 和 helper 之间夹一层代理,记下每个 act 的 policy 和激活请求,policy = foreground 的 act
 * 和激活都不转发、直接回一个假结果。所以 ③ ⑦ 证明的是「决定这么做」,不是真实点击、也不是激活后的截图(那个看 web-stale.probe.mjs)。
 * 替身被别的窗口完全盖住时 ② 的按压会走 ⑦ 的路径,② 会红:别让窗口压在屏幕右下角。
 *
 * 负对照(应该在 ① 和 ② 红):node scripts/web-press.check.mjs --root <没有这处改动的检出>
 * 负对照(应该只在 ⑦ 红):--root <a855a69 的检出>
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
<button id="save">Probe Save</button> <button id="other">Probe Other</button> <button id="stale">Probe Stale</button> <button id="focus">Probe Focus</button> <button id="still">Probe Still</button>
<script>
document.getElementById('focus').addEventListener('click', () => document.getElementById('still').focus())
const post = (o) => fetch('/log', { method: 'POST', body: JSON.stringify(o), keepalive: true })
document.addEventListener('click', (e) => post({ type: 'click', id: e.target.id, trusted: e.isTrusted }), true)
addEventListener('load', () => post({ type: 'load' }))
</script></body></html>`
const MAIN = `const { app, BrowserWindow, screen } = require('electron')
app.setPath('userData', process.env.CU_FIXTURE_DATA)
app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 420, height: 240, x: area.x + area.width - 440, y: area.y + area.height - 260, show: false, title: 'CU Web Press' })
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
  const press = async (label) => {
    const state = await observe()
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

  await press('Probe Focus')
  await sleep(500)
  policies.length = 0
  activations.length = 0
  const unchanged = await press('Probe Still')
  const stillPolicies = [...policies]
  await sleep(500)
  check(`⑦ 按完树没变:提窗口、带截图、不叫模型再按(${stillPolicies.join(' → ')})`, () => {
    assert.deepEqual(stillPolicies, ['ax_only'])
    assert.equal(clicks('still').length, 1)
    assert.deepEqual(activations, [child.pid], 'the window was not brought forward')
    assert.ok(unchanged.content.some((block) => block.type === 'image'), 'no screenshot attached')
    assert.doesNotMatch(unchanged.content[0].text, /requested explicitly/)
    assert.match(bridge.executionNote(unchanged.details), /only if the screenshot shows/, 'the model is not told to judge by the screenshot')
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
