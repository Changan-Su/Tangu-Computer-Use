#!/usr/bin/env node
/**
 * 探针:页面 hidden 时后台 AXPress 之后,「直接读」对「先问再读」。
 *
 * 背景见 web-covered.check.mjs:窗口被完全盖住时页面进 hidden,AXPress 照样落地,但无障碍树停在按之前。
 * helper 的 look 读之前先对窗口里的 AXWebArea 做一次按 App 限定的位置查询(问页面一次),`flushWeb: false` 关掉。
 * 这里不经过 bridge.ts,只跟 helper 的私有 socket 说话,量 helper 自己:按完之后树多久变新。
 *
 * 2026-11-13 的 90 轮(docs/probes/web-flush/)是在探针提交 6b0d97e 的 helper 上跑的:那时开关缺省关,另有一组
 * askWait(问完等变化通知,最多 800 ms),15 轮一次通知都没等到,正式版去掉了那个参数,这里也不再有这一组。
 *
 * 一个 Electron 替身加一扇原生盖窗撑若干轮(--per-instance),每轮:
 *   1. 对齐:先问再读,直到树里的计数等于页面自己报的点击数(上一轮是对照组时树是旧的)
 *   2. 断言页面此刻 hidden
 *   3. ax_only 按一次 Save draft,等页面报这次点击(带当时的 visibilityState)
 *   4. 按这一轮的组别轮询 look,逐次记读到的计数、起止毫秒、问的证据
 *   5. 再看一次 hidden;读的过程中页面出现过 visible 的轮次作废,不进统计
 *
 * 组别:
 *   direct   每次都直接读(对照)。到 --window 毫秒还旧,末尾问一次,记晚问还救不救得回
 *   ask      每次读之前都问
 *   askOnce  只在第一次读之前问,之后直接读(问一次够不够、要多久)
 *
 *   PI_COMPUTER_USE_HELPER_APP_PATH=<带 flushWeb 的 helper.app> node scripts/web-flush.probe.mjs \
 *     [--arms direct:30,ask:30,askOnce:15] [--per-instance 6] [--window 3000] [--seed 20261113] [--out <目录>]
 *
 * 只要辅助功能授权,不截图。盖窗起来那一下会切前台,每个替身一次,切完马上还回去;要走 devlock。不动真鼠标。
 * 需要:macOS、Electron(CU_ELECTRON,缺省用 Forsion-Genesis/desktop 装的那份)。
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildFixture, quitFixture, waitForState } from './vision-fixtures.mjs'

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const helperApp = process.env.PI_COMPUTER_USE_HELPER_APP_PATH
assert.ok(helperApp && fs.existsSync(helperApp), 'set PI_COMPUTER_USE_HELPER_APP_PATH to a helper that knows flushWeb')
const electron = process.env.CU_ELECTRON ?? path.resolve(repo, '../../Forsion-Genesis/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
assert.ok(fs.existsSync(electron), `Electron not found: ${electron} (set CU_ELECTRON)`)
const arms = Object.fromEntries((arg('--arms') ?? 'direct:30,ask:30,askOnce:15').split(',').map((s) => { const [name, n] = s.split(':'); return [name, Number(n)] }))
for (const name of Object.keys(arms)) assert.ok(['direct', 'ask', 'askOnce'].includes(name), `unknown arm ${name}`)
const perInstance = Number(arg('--per-instance') ?? 6)
const windowMs = Number(arg('--window') ?? 3000)
const seed = Number(arg('--seed') ?? 20261113)
const outDir = path.resolve(arg('--out') ?? path.join(repo, 'docs/probes/web-flush'))
const sock = path.join(os.homedir(), 'Library/Caches', `cu-web-flush-${process.pid}.sock`)

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CU Web Flush</title></head><body>
<h1>Draft Desk</h1><p>Grocery list</p><button id="save">Save draft</button><p id="status">Status: pending</p>
<script>
let n = 0
const post = (o) => fetch('/log', { method: 'POST', body: JSON.stringify({ ...o, vis: document.visibilityState }), keepalive: true })
document.getElementById('save').addEventListener('click', (e) => {
  n += 1
  document.getElementById('status').textContent = 'Status: saved ' + n
  post({ type: 'click', n, trusted: e.isTrusted })
})
addEventListener('load', () => post({ type: 'load' }))
document.addEventListener('visibilitychange', () => post({ type: 'vis' }))
</script></body></html>`
const MAIN = `const { app, BrowserWindow, screen } = require('electron')
app.setPath('userData', process.env.CU_FIXTURE_DATA)
app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({ width: 520, height: 320, x: area.x + Math.round((area.width - 520) / 2), y: area.y + Math.round((area.height - 320) / 2), show: false, title: 'CU Web Flush' })
  win.once('ready-to-show', () => win.showInactive())
  win.loadURL(process.env.CU_FIXTURE_URL)
})`

/** 页面自己报的事:load / vis / click,各带当时的 visibilityState;rx 是这边收到的时刻。 */
let events = []
const server = http.createServer((req, res) => {
  if (req.url === '/log') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { events.push({ ...JSON.parse(b), rx: Date.now() }); res.end('ok') }); return }
  res.setHeader('content-type', 'text/html'); res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const vis = () => events.at(-1)?.vis
const clicks = () => events.filter((e) => e.type === 'click')

const askHelper = (cmd, args = {}, timeoutMs = 15_000) => new Promise((resolve, reject) => {
  const s = net.connect(sock); let t = ''
  const timer = setTimeout(() => { s.destroy(); reject(new Error(`helper ${cmd} timed out`)) }, timeoutMs)
  s.on('error', (e) => { clearTimeout(timer); reject(e) })
  s.on('data', (d) => { t += d; if (!t.includes('\n')) return; clearTimeout(timer); s.end(); const m = JSON.parse(t.split('\n')[0]); m.ok ? resolve(m.result) : reject(Object.assign(new Error(m.error?.message ?? 'helper error'), { code: m.error?.code })) })
  s.write(`${JSON.stringify({ id: 'web-flush', cmd, ...args })}\n`)
})
/** 大纲里的计数(Status: pending = 0,Status: saved N = N)和 Save draft 按钮的 ref。 */
const readOutline = (outline) => {
  let count, button
  const walk = (node) => {
    const label = [node.title, node.description, node.value].join(' ')
    const m = label.match(/Status: (pending|saved (\d+))/)
    if (m && count === undefined) count = m[1] === 'pending' ? 0 : Number(m[2])
    if (!button && node.role === 'AXButton' && /Save draft/.test(label)) button = node.ref
    for (const child of node.children ?? []) walk(child)
  }
  walk(outline)
  return { count, button }
}

// 排好每一轮的组别:按种子打乱,同一个替身里各组混着来,不让某一组总排在替身的头一轮。
let rng = seed >>> 0
const rand = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 2 ** 32)
const schedule = Object.entries(arms).flatMap(([name, n]) => Array(n).fill(name))
for (let i = schedule.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [schedule[i], schedule[j]] = [schedule[j], schedule[i]] }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-web-flush-'))
fs.writeFileSync(path.join(tmp, 'package.json'), '{ "name": "cu-web-flush", "version": "1.0.0", "main": "main.js" }')
fs.writeFileSync(path.join(tmp, 'main.js'), MAIN)
const coverApp = await buildFixture('cover')
const coverState = path.join(tmp, 'cover.json')
let diagnostics
const rounds = []
const instances = []
let next = 0
fs.mkdirSync(outDir, { recursive: true })

/** 一个替身:起窗口、盖住、还前台,然后跑到 perInstance 轮或者出状况为止。 */
async function runInstance(instance) {
  events = []
  const child = spawn(electron, [tmp], { stdio: 'ignore', env: { ...process.env, CU_FIXTURE_URL: `http://127.0.0.1:${server.address().port}/`, CU_FIXTURE_DATA: path.join(tmp, `data-${instance}`) } })
  const info = { instance, pid: child.pid, rounds: 0 }
  instances.push(info)
  let coverPid
  const front = await askHelper('getFrontmost')
  try {
    for (let i = 0; i < 150 && !events.some((e) => e.type === 'load'); i++) await sleep(100)
    assert.ok(events.some((e) => e.type === 'load'), 'fixture page did not load')
    await sleep(800)
    const root = (await askHelper('listRoots', { pid: child.pid })).roots.find((r) => r.title === 'CU Web Flush')
    assert.ok(root, 'fixture window not listed')
    const windowId = root.windowId
    const look = (flags = {}) => askHelper('look', { windowId, includeImage: false, readText: 'never', flushWeb: false, ...flags })
    // 头一次读会给这个进程打开网页无障碍,页面的树要过一会儿才长出来
    let first, firstOutline
    for (let i = 0; i < 30; i++) {
      firstOutline = (await look()).outline
      first = readOutline(firstOutline)
      if (first.count === 0 && first.button) break
      await sleep(200)
    }
    if (first.count !== 0 || !first.button) fs.writeFileSync(path.join(outDir, 'first-outline.json'), JSON.stringify(firstOutline, null, 1))
    assert.equal(first.count, 0, 'the visible page should read Status: pending')
    assert.ok(first.button, 'no Save draft button in the outline')

    const f = root.framePoints
    fs.rmSync(coverState, { force: true })
    await execFileP('open', ['-n', coverApp, '--args', coverState, '--frame', [f.x - 200, f.y - 200, f.w + 400, f.h + 400].join(',')])
    coverPid = (await waitForState(coverState, (s) => s.ready, { timeoutMs: 8000 })).pid
    for (let i = 0; i < 50 && vis() !== 'hidden'; i++) await sleep(100)
    await askHelper('restoreUserFocus', { pid: front.pid }).catch(() => {})
    await sleep(600)
    assert.equal(vis(), 'hidden', 'the cover did not make the page hidden')

    while (info.rounds < perInstance && next < schedule.length) {
      const arm = schedule[next]
      const base = clicks().length
      const round = { round: next + 1, arm, instance, indexInInstance: info.rounds, base }
      // 1. 对齐
      const syncStart = Date.now()
      let synced
      for (let i = 0; i < 20 && Date.now() - syncStart < 3000; i++) {
        const r = await look({ flushWeb: true })
        const seen = readOutline(r.outline)
        if (seen.count === base && seen.button) { synced = { lookId: r.lookId, button: seen.button, tries: i + 1, ms: Date.now() - syncStart }; break }
        await sleep(100)
      }
      if (!synced) { rounds.push({ ...round, valid: false, why: 'sync_failed' }); info.ended = 'sync_failed'; next += 1; return }
      round.sync = { tries: synced.tries, ms: synced.ms }
      // 2. 按之前 hidden
      round.hiddenBefore = vis() === 'hidden'
      const seenEvents = events.length
      // 3. 按
      const pressStart = Date.now()
      let act
      try { act = await askHelper('act', { lookId: synced.lookId, pid: child.pid, action: 'press', target: { ref: synced.button }, params: {}, policy: 'ax_only', cursorOverlay: false }) } catch (e) { rounds.push({ ...round, valid: false, why: `act_failed: ${e.message}` }); info.ended = 'act_failed'; next += 1; return }
      const pressDone = Date.now()
      round.act = { ms: pressDone - pressStart, outcome: act.outcome, delivery: act.performed?.delivery ?? act.delivery, grounding: act.performed?.grounding }
      for (let i = 0; i < 30 && clicks().length === base; i++) await sleep(50)
      const landed = clicks().slice(base)
      round.click = landed[0] ? { n: landed[0].n, vis: landed[0].vis, trusted: landed[0].trusted, afterPressStartMs: landed[0].rx - pressStart } : null
      const expected = base + 1
      // 4. 读
      const polls = []
      const deadline = pressDone + windowMs
      for (let i = 0; Date.now() < deadline; i++) {
        const asks = arm === 'ask' || (i === 0 && arm !== 'direct')
        const start = Date.now()
        const r = await look({ flushWeb: asks })
        const end = Date.now()
        const seen = readOutline(r.outline).count
        polls.push({ startMs: start - pressDone, endMs: end - pressDone, asked: asks, count: seen, describeMs: r.timings?.describeMs, ...(r.webFlush ? { flush: r.webFlush } : {}) })
        if (seen === expected) break
        await sleep(100)
      }
      round.polls = polls
      round.fresh = polls.at(-1)?.count === expected
      if (round.fresh) {
        round.freshAfterPressDoneMs = polls.at(-1).endMs
        round.freshAfterClickMs = landed[0] ? pressDone + polls.at(-1).endMs - landed[0].rx : null
        // 变新之后不问再读一次:问出来的新状态留不留得住
        round.plainReadAfterFresh = readOutline((await look()).outline).count
      } else if (arm === 'direct') {
        const rescueStart = Date.now()
        const rescue = { fresh: false, tries: 0 }
        for (let i = 0; i < 20 && Date.now() - rescueStart < 2000; i++) {
          rescue.tries += 1
          if (readOutline((await look({ flushWeb: true })).outline).count === expected) { rescue.fresh = true; rescue.ms = Date.now() - rescueStart; break }
          await sleep(100)
        }
        round.rescue = rescue
      }
      // 5. 读完还 hidden,期间没露过面
      await sleep(150)
      round.clicksLanded = clicks().length - base
      round.sawVisible = events.slice(seenEvents).some((e) => e.vis === 'visible')
      round.hiddenAfter = vis() === 'hidden'
      round.valid = round.hiddenBefore && round.hiddenAfter && !round.sawVisible && round.click?.vis === 'hidden' && round.clicksLanded === 1
      if (!round.valid) round.why = !round.click ? 'no_click' : round.clicksLanded !== 1 ? 'click_count' : 'not_hidden'
      rounds.push(round)
      info.rounds += 1
      next += 1
      console.log(`#${round.round} ${arm.padEnd(8)} ${round.valid ? '' : `作废(${round.why}) `}${round.fresh ? `新 ${round.freshAfterPressDoneMs}ms / ${polls.length} 次` : `旧 ${polls.length} 次${round.rescue ? `,晚问${round.rescue.fresh ? `救回 ${round.rescue.ms}ms` : '没救回'}` : ''}`}`)
      if (!round.valid) { info.ended = round.why; return }
    }
  } catch (e) {
    info.ended = `error: ${e.message.split('\n')[0]}`
    console.log(`✗ 替身 ${instance}: ${info.ended}`)
  } finally {
    child.kill()
    if (coverPid) await quitFixture(coverPid).catch(() => {})
    await askHelper('restoreUserFocus', { pid: front.pid }).catch(() => {})
    await sleep(400)
  }
}

const maxInstances = Math.ceil(schedule.length / perInstance) + 8
const startedAt = new Date()
await execFileP('open', ['-n', '-g', helperApp, '--args', 'serve', '--socket', sock])
try {
  for (let i = 0; i < 75; i++) { try { diagnostics = await askHelper('diagnostics'); break } catch { await sleep(200) } }
  assert.ok(diagnostics, 'helper did not answer on the private socket')
  assert.ok(diagnostics.accessibility, `this helper has no Accessibility grant: ${helperApp}`)
  for (let instance = 1; next < schedule.length && instance <= maxInstances; instance++) {
    await runInstance(instance)
    // 连着两个替身一轮都没跑成:环境不对,别再一个个弹窗口
    if (instances.length >= 2 && instances.slice(-2).every((i) => i.rounds === 0)) break
  }
} finally {
  await askHelper('shutdown').catch(() => {})
  const { stdout } = await execFileP('pgrep', ['-f', sock]).catch(() => ({ stdout: '' }))
  for (const pid of stdout.split('\n').filter(Boolean)) { try { process.kill(Number(pid)) } catch {} }
  server.close()
  for (const file of [sock, `${sock}.lock`]) fs.rmSync(file, { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
}

const text = async (cmd, args) => (await execFileP(cmd, args).catch((e) => ({ stdout: '', stderr: e.stderr ?? '' }))).stdout.trim()
const signature = (await execFileP('codesign', ['-dv', helperApp]).catch((e) => ({ stderr: e.stderr ?? '' }))).stderr ?? ''
const meta = {
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  macOS: await text('sw_vers', ['-productVersion']),
  electron: JSON.parse(fs.readFileSync(path.resolve(path.dirname(electron), '../../../../package.json'), 'utf8')).version,
  repoHead: await text('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']),
  repoDirty: (await text('git', ['-C', repo, 'status', '--porcelain', '--', 'native', 'src'])).length > 0,
  helper: { identifier: signature.match(/^Identifier=(.*)$/m)?.[1], teamId: signature.match(/^TeamIdentifier=(.*)$/m)?.[1], protocolVersion: diagnostics.protocolVersion, accessibility: diagnostics.accessibility, screenRecording: diagnostics.screenRecording },
  arms, perInstance, windowMs, seed,
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] : null }
const summary = {}
for (const name of Object.keys(arms)) {
  const all = rounds.filter((r) => r.arm === name)
  const valid = all.filter((r) => r.valid)
  const fresh = valid.filter((r) => r.fresh)
  const firstAsk = valid.map((r) => r.polls.find((p) => p.flush)?.flush).filter(Boolean)
  summary[name] = {
    rounds: all.length, valid: valid.length, fresh: fresh.length, stale: valid.length - fresh.length,
    freshAfterPressDoneMs: { median: median(fresh.map((r) => r.freshAfterPressDoneMs)), p90: p90(fresh.map((r) => r.freshAfterPressDoneMs)), max: fresh.length ? Math.max(...fresh.map((r) => r.freshAfterPressDoneMs)) : null },
    freshOnPoll: fresh.reduce((acc, r) => { acc[r.polls.length] = (acc[r.polls.length] ?? 0) + 1; return acc }, {}),
    plainReadAfterFreshAgrees: fresh.filter((r) => r.plainReadAfterFresh === r.base + 1).length,
    ...(name === 'direct' ? { rescued: valid.filter((r) => r.rescue?.fresh).length, rescueMs: median(valid.filter((r) => r.rescue?.fresh).map((r) => r.rescue.ms)) } : {}),
    ...(firstAsk.length ? {
      asked: firstAsk.filter((f) => f.asked).length, hitInWindow: firstAsk.filter((f) => f.hitInWindow).length, hitInWebArea: firstAsk.filter((f) => f.hitInWebArea).length,
      hitRoles: firstAsk.reduce((acc, f) => { for (const role of f.hitRoles ?? [f.reason]) acc[role] = (acc[role] ?? 0) + 1; return acc }, {}),
      askMs: { median: median(firstAsk.map((f) => f.ms)), max: Math.max(...firstAsk.map((f) => f.ms)) },
      searched: firstAsk.filter((f) => f.visits !== undefined).length,
    } : {}),
    describeMs: median(valid.flatMap((r) => r.polls.map((p) => p.describeMs ?? 0))),
  }
}
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `results-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(outFile, `${JSON.stringify({ meta, summary, instances, rounds }, null, 1)}\n`)
console.log(`\n${JSON.stringify(summary, null, 2)}\n\n原始数据:${outFile}`)
const short = Object.entries(arms).filter(([name, n]) => summary[name].valid < n)
if (short.length) { console.log(`有效轮次不够:${short.map(([name, n]) => `${name} ${summary[name].valid}/${n}`).join(',')}`); process.exit(1) }
process.exit(0)
