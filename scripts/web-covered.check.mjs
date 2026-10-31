#!/usr/bin/env node
/**
 * 网页被完全盖住时的后台 AXPress —— 走真 bridge.ts、真 helper、一个 Electron 替身加一扇原生盖窗。
 *
 * 10-31 真模型台架里有一轮:页面已经变了,无障碍树一直是旧的,模型以为没按上又按了一次,页面收到两次点击。
 * 根因:窗口被完全盖住时页面进 hidden,AXPress 照样落地,但无障碍树和画面都停在按之前,按压前也看不出来。
 * 激活 App 约 1 秒后画面回来,树有时跟着回来(这里的盖窗),有时要等页面下一次变化(10-31 用真 App 的窗口盖住时量到的)。
 * 所以按完树一点没变时,提窗口、带截图,让模型按画面判断。
 *
 * 每轮判据:页面 hidden 时收到的点击只有一次,动作结果带的截图是新的(点击后页面变绿,读截图像素),提示叫模型按截图判断。
 *
 * 盖窗要连替身的阴影一起盖住:只比替身大 30 点时页面不进 hidden。Electron 窗口当盖窗也不行,要原生窗口。
 * 会切前台,每轮结束还回去,要走 devlock。不动真鼠标。
 *
 *   node scripts/web-covered.check.mjs [--root <被测检出>] [--rounds 3]
 *
 * 负对照(应该在「带截图」红):--root <a855a69 的检出>
 *
 * 需要:macOS、协议版本和 vendor 一致且已授权的 helper(PI_COMPUTER_USE_HELPER_APP_PATH,缺省用已安装的那份)、
 * Electron(CU_ELECTRON,缺省用 Forsion-Genesis/desktop 装的那份)。
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { buildFixture, quitFixture, waitForState } from './vision-fixtures.mjs'

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const root = path.resolve(arg('--root') ?? repo)
const rounds = Number(arg('--rounds') ?? 3)
const electron = process.env.CU_ELECTRON ?? path.resolve(repo, '../../Forsion-Genesis/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const helperApp = process.env.PI_COMPUTER_USE_HELPER_APP_PATH ?? '/Applications/tangu-computer-use.app'
assert.ok(fs.existsSync(electron), `Electron not found: ${electron} (set CU_ELECTRON)`)
const sock = path.join(os.homedir(), 'Library/Caches', `cu-web-covered-${process.pid}.sock`)
process.env.PI_CU_SOCKET_PATH = sock
process.env.PI_COMPUTER_USE_HELPER_APP_PATH = helperApp

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CU Web Covered</title></head><body>
<h1>Draft Desk</h1><p>Grocery list</p><button id="save">Save draft</button><p id="status">Status: pending</p>
<script>
const post = (o) => fetch('/log', { method: 'POST', body: JSON.stringify(o), keepalive: true })
document.getElementById('save').addEventListener('click', (e) => {
  document.getElementById('status').textContent = 'Status: saved'
  document.body.style.background = 'rgb(0,160,0)'
  post({ type: 'click', trusted: e.isTrusted, vis: document.visibilityState })
})
addEventListener('load', () => post({ type: 'load', vis: document.visibilityState }))
document.addEventListener('visibilitychange', () => post({ type: 'vis', vis: document.visibilityState }))
</script></body></html>`
const MAIN = `const { app, BrowserWindow, screen } = require('electron')
app.setPath('userData', process.env.CU_FIXTURE_DATA)
app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 520, height: 320, x: area.x + Math.round((area.width - 520) / 2), y: area.y + Math.round((area.height - 320) / 2), show: false, title: 'CU Web Covered' })
  win.once('ready-to-show', () => win.showInactive())
  win.loadURL(process.env.CU_FIXTURE_URL)
})`

const events = []
const server = http.createServer((req, res) => {
  if (req.url === '/log') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { events.push(JSON.parse(b)); res.end('ok') }); return }
  res.setHeader('content-type', 'text/html'); res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const dist = path.join(root, 'tangu-plugins/computer-use/dist')
fs.mkdirSync(dist, { recursive: true })
const outfile = path.join(dist, `.web-covered-check-${process.pid}.mjs`)
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
const askHelper = (cmd, args = {}) => new Promise((resolve, reject) => {
  const s = net.connect(sock); let t = ''
  s.on('error', reject)
  s.on('data', (d) => { t += d; if (!t.includes('\n')) return; s.end(); const m = JSON.parse(t.split('\n')[0]); m.ok ? resolve(m.result) : reject(new Error(m.error?.message)) })
  s.write(`${JSON.stringify({ id: 'web-covered', cmd, ...args })}\n`)
})
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-web-covered-'))
/** 截图里点击之后的画面到了没有:页面中间靠右那一格是不是绿的。 */
const showsClick = (block) => {
  const jpg = path.join(tmp, 'shot.jpg')
  fs.writeFileSync(jpg, Buffer.from(block.data, 'base64'))
  execFileSync('sips', ['-s', 'format', 'bmp', jpg, '--out', `${jpg}.bmp`], { stdio: 'ignore' })
  const b = fs.readFileSync(`${jpg}.bmp`)
  const w = b.readInt32LE(18), h = Math.abs(b.readInt32LE(22)), bytes = b.readUInt16LE(28) / 8
  const p = b.readUInt32LE(10) + (h >> 1) * (Math.ceil(w * bytes / 4) * 4) + (w - 20) * bytes
  return b[p + 1] > 110 && b[p + 2] < 80
}

await execFileP('open', ['-n', '-g', helperApp, '--args', 'serve', '--socket', sock])
for (let i = 0; i < 75; i++) { try { await askHelper('diagnostics'); break } catch { await sleep(200) } }
await bridge.ensureComputerUseSetup(pctx)

const coverApp = await buildFixture('cover')
const coverState = path.join(tmp, 'cover.json')
fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "cu-web-covered", "version": "1.0.0", "main": "main.js" }')
fs.writeFileSync(path.join(tmp, 'main.js'), MAIN)
const failures = []
const check = (name, fn) => { try { fn(); console.log(`✓ ${name}`) } catch (e) { failures.push(name); console.log(`✗ ${name}\n  ${e.message.split('\n')[0]}`) } }
const hidden = () => events.some((e) => e.type === 'vis' && e.vis === 'hidden')
try {
  for (let round = 1; round <= rounds; round++) {
    events.length = 0
    const child = spawn(electron, [tmp], { stdio: 'ignore', env: { ...process.env, CU_FIXTURE_URL: `http://127.0.0.1:${server.address().port}/`, CU_FIXTURE_DATA: path.join(tmp, `data-${round}`) } })
    let coverPid
    const front = await askHelper('getFrontmost')
    try {
      for (let i = 0; i < 150 && !events.some((e) => e.type === 'load'); i++) await sleep(100)
      await sleep(800)
      const rootRef = text(await bridge.executeFind('', { pid: child.pid }, undefined, undefined, pctx)).match(/@r\d+/)?.[0]
      assert.ok(rootRef, 'no root')
      const observe = () => bridge.executeObserve('', { root: rootRef }, undefined, undefined, pctx)
      const body = text(await observe())
      const state = await observe() // 没变时不再带完整大纲,ref 从上一次取
      const f = (await askHelper('listRoots', { pid: child.pid })).roots.find((r) => r.title === 'CU Web Covered').framePoints
      fs.rmSync(coverState, { force: true })
      await execFileP('open', ['-n', coverApp, '--args', coverState, '--frame', [f.x - 200, f.y - 200, f.w + 400, f.h + 400].join(',')])
      coverPid = (await waitForState(coverState, (s) => s.ready, { timeoutMs: 8000 })).pid
      for (let i = 0; i < 50 && !hidden(); i++) await sleep(100)
      await sleep(300)
      assert.ok(hidden(), 'the cover did not make the page hidden, so this round tests nothing')

      const pressed = await bridge.executeAct('', { stateId: state.details.capture.stateId, actions: [{ action: 'click', ref: refOf(text(state), 'Save draft') ?? refOf(body, 'Save draft') }] }, undefined, undefined, pctx)
      await sleep(500)
      const clicks = events.filter((e) => e.type === 'click')
      const image = pressed.content.find((b) => b.type === 'image')
      check(`第 ${round} 轮 页面 hidden 时点击落地一次`, () => { assert.equal(clicks.length, 1); assert.equal(clicks[0].vis, 'hidden') })
      check(`第 ${round} 轮 带截图,截图是新的`, () => { assert.ok(image, 'no screenshot in the result'); assert.ok(showsClick(image), 'the screenshot is still the page before the press') })
      check(`第 ${round} 轮 提示按截图判断`, () => assert.match(bridge.executionNote(pressed.details), /only if the screenshot shows/))
    } catch (e) { failures.push(`round ${round}`); console.log(`✗ 第 ${round} 轮: ${e.message.split('\n')[0]}`) } finally {
      child.kill()
      if (coverPid) await quitFixture(coverPid).catch(() => {})
      await askHelper('restoreUserFocus', { pid: front.pid }).catch(() => {})
      await sleep(400)
    }
  }
} finally {
  await askHelper('shutdown').catch(() => {})
  const { stdout } = await execFileP('pgrep', ['-f', sock]).catch(() => ({ stdout: '' }))
  for (const pid of stdout.split('\n').filter(Boolean)) { try { process.kill(Number(pid)) } catch {} }
  server.close()
  for (const file of [sock, `${sock}.lock`]) fs.rmSync(file, { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
}
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1) }
process.exit(0)
