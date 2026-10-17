#!/usr/bin/env node
/**
 * 「第一下点击被焦点吞掉」(真 helper,会动真鼠标):App 不在前台时,一下物理点击能不能真的点到视图上。
 * 10-17 dev 里 Tangu 自己记进 HARNESS:「后台窗口第一次点击常只用于获取焦点,需再点一次」。查下来:
 * - 视图不接受首击(acceptsFirstMouse = NO,AppKit 缺省)时,App 不在前台,投给 pid 的点击一下都不交给视图(不只第一下)。
 *   截图没变 → 判 didnt → 插件升前台用物理点击重来。
 * - 物理点击前 helper 叫 App 激活,激活是异步的(替身实测 66–221ms),原来只等 20ms:点击常赶在激活之前到,
 *   App 把它只当激活用掉,视图什么也没收到,结果 unknown —— 模型只好再点一次。
 * 修法(协议 19):物理点击前等目标自己报在最前(AXFrontmost),最多 0.5s。
 *
 * 做法:替身 FirstClickFixture(acceptsFirstMouse 缺省)在后台起 TRIALS 次,每次一下前台策略的点击,替身必须在前台时收到
 * mouseDown;另有一次后台策略的点击,helper 必须判 didnt(这是升前台的前提)且视图没收到。负对照:jev.6(协议 18)的 helper
 * 加 --any-protocol 跑,前台那几下会有被吞的。
 * ⚠️会动真鼠标(点完还原)、替身会短暂到前台:跑之前占 devlock、先问过用户。点之前 helper 自己核对这一点最上面是替身的窗口。
 *
 * 跑法:node scripts/first-click.check.mjs [--trials 5] [--any-protocol](PI_COMPUTER_USE_HELPER_APP_PATH 可指定 helper;要辅助功能,后台那一下还要录屏)
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveMacosHelperAppPath } from '../src/vendor/platform/macos/helper-path.mjs'
import { runtimeProtocolVersion } from './helper-protocol.mjs'
import { buildFixture, launchFixture, quitFixture, readState } from './vision-fixtures.mjs'

if (process.platform !== 'darwin') {
  console.log('first click check skipped (not macOS)')
  process.exit(0)
}

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const argValue = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const TRIALS = Number(argValue('--trials', '5'))
const helperApp = resolveMacosHelperAppPath()
const socket = path.join(os.homedir(), 'Library', 'Caches', `forsion-first-click-${process.pid}.sock`)
const ask = (cmd, args = {}) => new Promise((resolve, reject) => {
  const s = connect(socket)
  let text = ''
  const timer = setTimeout(() => { s.destroy(); reject(new Error(`helper timeout: ${cmd}`)) }, 20_000)
  s.on('error', (e) => { clearTimeout(timer); reject(e) })
  s.on('data', (d) => {
    text += d
    if (!text.includes('\n')) return
    clearTimeout(timer)
    s.end()
    resolve(JSON.parse(text.split('\n')[0]))
  })
  s.write(`${JSON.stringify({ id: `fc-${Date.now()}`, cmd, ...args })}\n`)
})

const findNode = (node, pred) => {
  if (!node) return null
  if (pred(node)) return node
  for (const c of node.children || []) { const hit = findNode(c, pred); if (hit) return hit }
  return null
}
let screenRecording = false
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-first-click-'))
let fixture
/** 起一个在后台的替身,点它板子中间一下,回 {result, events(这一下之后的)}。 */
async function clickOnce(app, policy, index) {
  const statePath = path.join(dir, `fixture-${index}.json`)
  fixture = await launchFixture(app, statePath, { frame: { x: 80, y: 140, w: 600, h: 400 } })
  await sleep(300)
  assert.equal(readState(statePath).active, false, 'the fixture came up frontmost; the check needs it in the background')
  const look = (await ask('look', { pid: fixture.pid, windowId: fixture.windowNumber, includeImage: screenRecording })).result
  const pad = findNode(look?.outline, (n) => [n.label, n.title, n.description].includes('first-click pad'))
  assert.ok(look?.lookId && pad?.ref, 'look failed or the pad is not in the outline')
  const before = readState(statePath).events.length
  // 按 ref 点:板子没有按压动作,helper 在它中心发鼠标事件(和按坐标点同一条路)
  const r = await ask('act', {
    lookId: look.lookId, pid: fixture.pid, policy, cursorOverlay: false, action: 'click',
    target: { ref: pad.ref }, params: { button: 'left', clickCount: 1, delivery: policy === 'background' ? 'pid' : 'hid' },
  })
  assert.notEqual(r.error?.code, 'screen_locked', 'the screen is locked; unlock it and run again')
  await sleep(500)
  const events = readState(statePath).events.slice(before)
  await quitFixture(fixture)
  fixture = undefined
  await sleep(600) // 前台交回给原来那个 App,下一个替身才是真的在后台起
  return { result: r, events }
}

try {
  assert.ok(fs.existsSync(helperApp), `computer-use helper not installed at ${helperApp}`)
  await execFileP('open', ['-n', '-g', helperApp, '--args', 'serve', '--socket', socket])
  let diag
  for (let i = 0; i < 75 && !diag; i++) diag = (await ask('diagnostics').catch(() => undefined))?.result ?? (await sleep(200), undefined)
  assert.ok(diag?.accessibility, 'isolated helper needs Accessibility')
  screenRecording = diag.screenRecording === true
  if (!process.argv.includes('--any-protocol')) assert.equal(diag.protocolVersion, runtimeProtocolVersion(), 'helper protocol differs from this checkout')
  console.log(`helper ${helperApp} protocol ${diag.protocolVersion}`)
  const app = await buildFixture('firstmouse')

  // 后台那一下要截图判 didnt:没有录屏授权(开发证书签的 .dev helper)就跳过,照实说
  if (screenRecording) {
    const bg = await clickOnce(app, 'background', 0)
    assert.ok(bg.result.ok, `background click failed: ${JSON.stringify(bg.result.error)}`)
    assert.ok(!bg.events.some((e) => e.kind === 'mouseDown'), 'a background click reached a view that does not accept first mouse (AppKit changed?)')
    assert.equal(bg.result.result.outcome, 'didnt', `a background click the view never got must be judged didnt (that is what takes it to the foreground), got ${bg.result.result.outcome}`)
    console.log('PASS background click: view got nothing, helper judged didnt')
  } else console.log('SKIP background click: this helper has no Screen Recording grant, so it cannot judge didnt')

  const failures = []
  for (let i = 1; i <= TRIALS; i++) {
    const { result, events } = await clickOnce(app, 'foreground', i)
    const down = events.find((e) => e.kind === 'mouseDown')
    const line = `foreground ${i}: ${result.ok ? `sent, waited ${result.result.performed?.frontmostWaitMs ?? 'n/a'}ms` : `error ${result.error?.code}`}; view ${down ? `got the click (active=${down.active})` : 'got nothing'}; ${events.map((e) => e.kind).join(' ')}`
    console.log(line)
    if (!result.ok || !down || !down.active) failures.push(line)
  }
  assert.deepEqual(failures, [], 'a physical click on a background app must reach the view once the app is in front')
  console.log(`PASS ${TRIALS}/${TRIALS} physical clicks on a background app reached the view`)
} finally {
  if (fixture) await quitFixture(fixture).catch(() => {})
  await ask('shutdown').catch(() => {})
  const { stdout } = await execFileP('pgrep', ['-f', socket]).catch(() => ({ stdout: '' }))
  for (const pid of stdout.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid)) } catch { /* 已退出 */ } }
  fs.rmSync(socket, { force: true })
}
