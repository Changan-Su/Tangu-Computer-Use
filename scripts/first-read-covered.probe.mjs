#!/usr/bin/env node
/**
 * 探针:第一次读一扇网页窗口之前(或首读的等待期间),别的 App 抢了前台 / 盖住了它,首读还读不读得到网页内容。
 * 只读不按。走真 bridge.ts、真 helper、一个 Electron 替身,抢前台的是一扇原生替身窗口(vision-fixtures 的 cover)。
 *
 *   control      什么都不抢
 *   front        抢前台,但窗口不压在替身上(页面一直可见)
 *   coverBefore  抢前台并盖住替身,等页面 hidden 之后才第一次碰它
 *   coverDuring  第一次碰它之后立刻抢前台并盖住(落在首读那 2.5 秒等待里)
 *
 * 每轮记:首读有没有按钮;没有的话,还盖着的 8 秒里它自己出不出现;把盖窗关掉之后 6 秒里出不出现;页面的可见性事件。
 * 结果和说明见 docs/probes/first-read-covered/。
 *
 *   node scripts/first-read-covered.probe.mjs [--rounds 3] [--variants control,front,coverBefore,coverDuring] [--out <json>]
 *   PI_COMPUTER_USE_WEB_FLUSH=0 node scripts/first-read-covered.probe.mjs   # 关掉「读之前先问页面」再量一遍
 *
 * 会切前台,每轮结束还回去,要走 devlock。不动真鼠标。
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
import { buildFixture, quitFixture, waitForState } from './vision-fixtures.mjs'

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const root = path.resolve(arg('--root') ?? repo)
const electron = process.env.CU_ELECTRON ?? path.resolve(repo, '../../Forsion-Genesis/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const helperApp = process.env.PI_COMPUTER_USE_HELPER_APP_PATH ?? '/Applications/tangu-computer-use.app'
assert.ok(fs.existsSync(electron), `Electron not found: ${electron} (set CU_ELECTRON)`)
const sock = path.join(os.homedir(), 'Library/Caches', `cu-first-read-${process.pid}.sock`)
process.env.PI_CU_SOCKET_PATH = sock
process.env.PI_COMPUTER_USE_HELPER_APP_PATH = helperApp

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CU Web Covered</title></head><body>
<h1>Draft Desk</h1><p>Grocery list</p><button id="paint" autofocus>Repaint</button> <button id="save">Save draft</button><p id="status">Status: pending</p>
<script>
const post = (o) => fetch('/log', { method: 'POST', body: JSON.stringify(o), keepalive: true })
document.getElementById('save').addEventListener('click', (e) => {
  document.getElementById('status').textContent = 'Status: saved'
  post({ type: 'click', id: 'save', trusted: e.isTrusted, vis: document.visibilityState })
})
// 只改画面:按钮本来就有焦点,树里什么都不变
document.getElementById('paint').addEventListener('click', (e) => {
  document.body.style.background = 'rgb(0,160,0)'
  post({ type: 'click', id: 'paint', trusted: e.isTrusted, vis: document.visibilityState })
})
addEventListener('load', () => post({ type: 'load', vis: document.visibilityState }))
document.addEventListener('visibilitychange', () => post({ type: 'vis', vis: document.visibilityState }))
</script></body></html>`
const MAIN = `const { app, BrowserWindow, screen } = require('electron')
app.setPath('userData', process.env.CU_FIXTURE_DATA)
app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 520, height: 320, x: area.x + Math.round((area.width - 520) / 2), y: area.y + Math.round((area.height - 320) / 2), show: false, title: 'CU Web Covered' })
  win.once('ready-to-show', () => { win.showInactive(); console.log(JSON.stringify(win.getBounds())) })
  win.loadURL(process.env.CU_FIXTURE_URL)
})`

const events = []
const server = http.createServer((req, res) => {
  if (req.url === '/log') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { events.push({ ...JSON.parse(b), at: Date.now() }); res.end('ok') }); return }
  res.setHeader('content-type', 'text/html'); res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const dist = path.join(root, 'tangu-plugins/computer-use/dist')
fs.mkdirSync(dist, { recursive: true })
const outfile = path.join(dist, `.web-covered-check-${process.pid}.mjs`)
await build({
  stdin: { contents: "export { executeFind, executeObserve, ensureComputerUseSetup } from './src/vendor/bridge.ts'", resolveDir: root, loader: 'ts' },
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-first-read-'))
await execFileP('open', ['-n', '-g', helperApp, '--args', 'serve', '--socket', sock])
for (let i = 0; i < 75; i++) { try { await askHelper('diagnostics'); break } catch { await sleep(200) } }
await bridge.ensureComputerUseSetup(pctx)

const coverApp = await buildFixture('cover')
const coverState = path.join(tmp, 'cover.json')
fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "cu-web-covered", "version": "1.0.0", "main": "main.js" }')
fs.writeFileSync(path.join(tmp, 'main.js'), MAIN)
const outPath = path.resolve(arg('--out') ?? path.join(repo, 'docs/probes/first-read-covered', `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
const perVariant = Number(arg('--rounds') ?? 3)
const variants = (arg('--variants') ?? 'control,front,coverBefore,coverDuring').split(',')
const rows = []
const openCover = async (frame) => {
  fs.rmSync(coverState, { force: true })
  await execFileP('open', ['-n', coverApp, '--args', coverState, '--frame', frame.join(',')])
  return (await waitForState(coverState, (s) => s.ready, { timeoutMs: 8000 })).pid
}
const visNow = () => events.filter((e) => e.type === 'vis' || e.type === 'load').at(-1)?.vis
try {
  let n = 0
  for (let r = 1; r <= perVariant; r++) for (const variant of variants) {
    n++
    events.length = 0
    const t0 = Date.now()
    const child = spawn(electron, [tmp], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CU_FIXTURE_URL: `http://127.0.0.1:${server.address().port}/`, CU_FIXTURE_DATA: path.join(tmp, `data-${n}`) } })
    let out = ''; child.stdout.on('data', (d) => (out += d))
    let coverPid
    const front = await askHelper('getFrontmost')
    const row = { n, variant }
    try {
      for (let i = 0; i < 150 && !events.some((e) => e.type === 'load'); i++) await sleep(100)
      row.loadMs = Date.now() - t0
      row.loadVis = events.find((e) => e.type === 'load')?.vis
      await sleep(800)
      const b = JSON.parse(out.trim().split('\n').at(-1))
      const covering = [b.x - 200, b.y - 200, b.width + 400, b.height + 400]
      const aside = [20, 60, 320, 200]
      if (variant === 'front') { coverPid = await openCover(aside); await sleep(300) }
      if (variant === 'coverBefore') {
        coverPid = await openCover(covering)
        for (let i = 0; i < 50 && visNow() !== 'hidden'; i++) await sleep(100)
        await sleep(300)
      }
      row.visBeforeContact = visNow()
      row.grabberInFrontBeforeContact = (await askHelper('getFrontmost')).appName === 'CoverFixture'
      const c0 = Date.now()
      row.contactAt = c0 - t0
      const rootRef = text(await bridge.executeFind('', { pid: child.pid }, undefined, undefined, pctx)).match(/@r\d+/)?.[0]
      assert.ok(rootRef, 'no root')
      const observe = () => bridge.executeObserve('', { root: rootRef }, undefined, undefined, pctx)
      let coverP
      if (variant === 'coverDuring') coverP = openCover(covering)
      const o0 = Date.now()
      const body = text(await observe())
      row.firstMs = Date.now() - o0
      row.firstHasButton = Boolean(refOf(body, 'Save draft'))
      row.firstLines = body.split('\n').length
      if (coverP) coverPid = await coverP
      row.visAfterFirst = visNow()
      row.grabberInFrontAfterFirst = (await askHelper('getFrontmost')).appName === 'CoverFixture'
      // 首读没有:还盖着 / 还被抢着前台的时候接着读 8 秒,看它自己会不会出现
      let seen = row.firstHasButton ? Date.now() - c0 : undefined
      let polls = 0
      while (seen === undefined && Date.now() - o0 < 8000 + row.firstMs) {
        await sleep(500); polls++
        if (/Save draft/.test(text(await observe()))) seen = Date.now() - c0
      }
      row.seenWhileGrabbedMs = seen ?? null
      row.pollsWhileGrabbed = polls
      // 把抢前台的替身关掉,再读 6 秒:页面重新可见之后读不读得到
      if (coverPid) { await quitFixture(coverPid).catch(() => {}); coverPid = undefined }
      if (seen === undefined) {
        const u0 = Date.now()
        while (seen === undefined && Date.now() - u0 < 6000) {
          await sleep(500)
          if (/Save draft/.test(text(await observe()))) { seen = Date.now() - c0; row.seenAfterUncoverMs = Date.now() - u0 }
        }
        if (seen === undefined) row.seenAfterUncoverMs = null
        row.visAfterUncover = visNow()
      }
      row.vis = events.filter((e) => e.type === 'vis' || e.type === 'load').map((e) => `${e.at - t0}ms ${e.type}=${e.vis}`)
    } catch (e) { row.error = e.message.split('\n')[0] } finally {
      child.kill()
      if (coverPid) await quitFixture(coverPid).catch(() => {})
      await askHelper('restoreUserFocus', { pid: front.pid }).catch(() => {})
      await sleep(500)
    }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
} finally {
  await askHelper('shutdown').catch(() => {})
  const { stdout } = await execFileP('pgrep', ['-f', sock]).catch(() => ({ stdout: '' }))
  for (const pid of stdout.split('\n').filter(Boolean)) { try { process.kill(Number(pid)) } catch {} }
  server.close()
  for (const file of [sock, `${sock}.lock`]) fs.rmSync(file, { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log('\n组别         轮数  首读有按钮  抢着时自己出现  松开后出现  一直没有')
for (const v of variants) {
  const g = rows.filter((x) => x.variant === v && !x.error)
  const first = g.filter((x) => x.firstHasButton).length
  const during = g.filter((x) => !x.firstHasButton && x.seenWhileGrabbedMs != null).length
  const after = g.filter((x) => !x.firstHasButton && x.seenWhileGrabbedMs == null && x.seenAfterUncoverMs != null).length
  const never = g.filter((x) => !x.firstHasButton && x.seenWhileGrabbedMs == null && x.seenAfterUncoverMs == null).length
  console.log(`${v.padEnd(12)} ${String(g.length).padStart(4)}  ${String(first).padStart(8)}  ${String(during).padStart(12)}  ${String(after).padStart(8)}  ${String(never).padStart(6)}   出错 ${rows.filter((x) => x.variant === v && x.error).length}`)
}
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, `${JSON.stringify({ at: new Date().toISOString(), webFlush: process.env.PI_COMPUTER_USE_WEB_FLUSH !== '0', roundsPerVariant: perVariant, rows }, null, 2)}\n`)
console.log(`\n${path.relative(repo, outPath)}`)
process.exit(0)
