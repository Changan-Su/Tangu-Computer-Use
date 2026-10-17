#!/usr/bin/env node
/**
 * 键盘守卫(真 helper):目标不在最前,物理按键一个都不许发。
 * helper 自己是后台 App,macOS(协作式激活)常拒绝它去激活别的 App;拒了还照发,字就打进了用户正在用的 App
 * —— 10-17 凌晨那一轮 live 就是这么把评论打进了别处(那会儿还锁着屏,最前面的是 loginwindow)。
 *
 * 做法:替身 Melody 带 --no-activate 起(窗口照常在屏幕上,App 永远到不了前台 = 系统一直不让它过来),用前台策略
 * (物理事件)发 Shift 和空字符串,helper 必须拒掉(foreground_unavailable),Melody 一个键都没收到。
 * 锁着屏不能跑:那时 helper 先报 screen_locked,守卫没了也一样拒(Codex 评审:会假绿)。
 * 只按 Shift、只打空串:守卫坏了漏出去,也伤不到在前台的任何 App。负对照:换上 CU 446caaf 的 helper 跑,这里红。
 *
 * 跑法:node scripts/key-guard.check.mjs(PI_COMPUTER_USE_HELPER_APP_PATH 可指定 helper;要辅助功能 + 录屏授权)
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveMacosHelperAppPath } from '../src/vendor/platform/macos/helper-path.mjs'
import { buildFixture, launchFixture, quitFixture, readState } from './vision-fixtures.mjs'

if (process.platform !== 'darwin') {
  console.log('key guard check skipped (not macOS)')
  process.exit(0)
}

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const helperApp = resolveMacosHelperAppPath()
const socket = path.join(os.homedir(), 'Library', 'Caches', `forsion-key-guard-${process.pid}.sock`)
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
  s.write(`${JSON.stringify({ id: `kg-${Date.now()}`, cmd, ...args })}\n`)
})

const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cu-key-guard-')), 'melody.json')
let melody
try {
  assert.ok(fs.existsSync(helperApp), `computer-use helper not installed at ${helperApp}`)
  await execFileP('open', ['-n', '-g', helperApp, '--args', 'serve', '--socket', socket])
  let diag
  for (let i = 0; i < 75 && !diag; i++) diag = (await ask('diagnostics').catch(() => undefined))?.result ?? (await sleep(200), undefined)
  assert.ok(diag?.accessibility && diag?.screenRecording, 'isolated helper needs Accessibility and Screen Recording')

  melody = await launchFixture(await buildFixture('melody'), statePath, { frame: { x: 40, y: 60, w: 1000, h: 680 }, behind: true, args: ['--no-activate'] })
  const front = (await ask('getFrontmost')).result
  assert.notEqual(front?.pid, melody.pid, 'Melody came up frontmost; the check needs it in the background')
  const windowId = (await ask('listWindows', { pid: melody.pid })).result?.find((w) => w.windowId)?.windowId
  const lookId = (await ask('look', { windowId, maxDimension: 800, includeImage: true })).result?.lookId
  assert.ok(lookId, 'look failed')
  const base = { lookId, pid: melody.pid, target: { x: 20, y: 20 }, policy: 'foreground' }
  for (const [action, params] of [['typeText', { text: '' }], ['keypress', { keys: ['shift'] }]]) {
    const r = await ask('act', { ...base, action, params: { ...params, delivery: 'hid' } })
    assert.notEqual(r.error?.code, 'screen_locked', 'the screen is locked; unlock it and run again (a locked screen refuses keys with or without the guard)')
    assert.ok(!r.ok && r.error?.code === 'foreground_unavailable', `${action} to a background app must be refused, got ${JSON.stringify(r.ok ? r.result : r.error).slice(0, 200)}`)
    console.log(`PASS ${action} refused (${r.error.code})`)
  }
  assert.equal(readState(statePath).keys, 0, 'Melody received keys')
  console.log('PASS Melody received no keys')
} finally {
  if (melody) await quitFixture(melody).catch(() => {})
  await ask('shutdown').catch(() => {})
  const { stdout } = await execFileP('pgrep', ['-f', socket]).catch(() => ({ stdout: '' }))
  for (const pid of stdout.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid)) } catch { /* 已退出 */ } }
  fs.rmSync(socket, { force: true })
}
