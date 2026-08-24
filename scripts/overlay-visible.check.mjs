#!/usr/bin/env node
/**
 * 「虚拟光标 / 边缘光效到底有没有出现在用户屏幕上」的真机仪器。
 *
 * 为什么需要它:此前只有几何单测(agent_cursor_tests / agent_highlight_tests)—— 它们证明**算出来的
 * 坐标**对,却证明不了那个 NSWindow 真的被创建、真的可见、真的盖在目标窗口**上面**。用户报「辅助
 * 鼠标还是没有出现」时,这三件事差得很远,而我们一直只测了第一件。
 *
 * 观测手段:CGWindowListCopyWindowInfo(.optionOnScreenOnly)。
 *   - **不需要屏幕录制权限**(只有拿窗口标题才需要),所以任何终端都能跑。
 *   - 返回的数组是**前后顺序**(front-to-back),于是 "叠层的下标 < 目标窗口的下标" 就等价于
 *     "叠层确实盖在目标之上" —— 这正是 z-order bug 的判定式,光看 isVisible 是看不出来的。
 *   - 单点采样会被 linger(光效 2s)和动画时机骗过去,所以整段过程按 100ms **时间线采样**。
 *
 * **它不证明什么**:只看 NSWindow 的创建/层级/z 序与整窗 alpha。SwiftUI 画布画了个空、光标路径为空、
 * 局部坐标算错 —— 这些照样能过。要覆盖那一层需要屏幕录制权限去比像素,本脚本刻意不要求那个权限。
 *
 * 跑法:node scripts/overlay-visible.check.mjs
 * 需要:macOS、helper 已装并授权。会短暂打开「计算器」,跑完关掉。
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ensureDaemon, freshCalculator, killCalculator, HELPER_EXECUTABLE, SOCK } from './calc-fixture.mjs'

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (process.platform !== 'darwin') {
  console.log('overlay check skipped (not macOS)')
  process.exit(0)
}

let seq = 0
function ask(payload) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCK)
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`timeout: ${payload.cmd}`)) }, 20_000)
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
    sock.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      sock.end()
      const msg = JSON.parse(buf.slice(0, nl))
      if (!msg.ok) return reject(Object.assign(new Error(msg.error?.message || 'helper error'), { code: msg.error?.code }))
      resolve(msg.result)
    })
    sock.write(`${JSON.stringify({ id: `ov_${++seq}`, ...payload })}\n`)
  })
}

// ── 探针:按 100ms 采样在屏窗口栈,每次打一行 JSON。数组顺序 = 前后顺序。 ──────────────
const PROBE_SWIFT = `
import CoreGraphics
import Foundation

let seconds = Double(CommandLine.arguments[1]) ?? 6
let deadline = Date().addingTimeInterval(seconds)
let start = Date()
while Date() < deadline {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { continue }
    var out: [[String: Any]] = []
    for (index, info) in list.enumerated() {
        let b = info[kCGWindowBounds as String] as? [String: Any] ?? [:]
        out.append([
            "z": index,
            "pid": info[kCGWindowOwnerPID as String] as? Int32 ?? 0,
            "owner": info[kCGWindowOwnerName as String] as? String ?? "",
            "windowId": info[kCGWindowNumber as String] as? Int ?? 0,
            "layer": info[kCGWindowLayer as String] as? Int ?? 0,
            "alpha": info[kCGWindowAlpha as String] as? Double ?? 0,
            "w": b["Width"] as? Double ?? 0, "h": b["Height"] as? Double ?? 0,
        ])
    }
    let frame: [String: Any] = ["t": Int(Date().timeIntervalSince(start) * 1000), "windows": out]
    print(String(data: try! JSONSerialization.data(withJSONObject: frame), encoding: .utf8)!)
    fflush(stdout)
    Thread.sleep(forTimeInterval: 0.1)
}
`

const triple = process.arch === 'x64' ? 'x86_64-apple-macosx14.0' : 'arm64-apple-macosx14.0'
const swiftFile = path.join(os.tmpdir(), `tangu-cu-overlay-probe-${process.pid}.swift`)
const probeBin = path.join(os.tmpdir(), `tangu-cu-overlay-probe-${process.pid}`)
fs.writeFileSync(swiftFile, PROBE_SWIFT)
execFileSync('xcrun', ['swiftc', '-target', triple, '-O',
  '-module-cache-path', path.join(os.tmpdir(), `tangu-cu-overlay-cache-${process.arch}`),
  swiftFile, '-o', probeBin], { stdio: 'inherit' })

/** 后台采样 seconds 秒,返回每帧的窗口栈。 */
function watch(seconds) {
  const child = spawn(probeBin, [String(seconds)])
  const frames = []
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (line.trim()) frames.push(JSON.parse(line))
    }
  })
  return { frames, done: new Promise((r) => child.on('close', r)) }
}

function helperPid() {
  const out = execFileSync('pgrep', ['-f', HELPER_EXECUTABLE], { encoding: 'utf8' })
  const pid = Number(out.trim().split('\n')[0])
  assert.ok(Number.isFinite(pid) && pid > 0, 'helper daemon 没在跑')
  return pid
}

const CURSOR_LEVEL = 102 // NSWindow.Level.popUpMenu + 1(见 agent_cursor.swift)
const GLOW_LEVEL = 3 // NSWindow.Level.floating
const VISIBLE_ALPHA = 0.5 // 淡入淡出中的窗口不算"用户看得见"
const overlaysIn = (windowStack, hpid) => {
  const mine = windowStack.filter((x) => x.pid === hpid && x.alpha > VISIBLE_ALPHA)
  return { cursor: mine.find((x) => x.layer === CURSOR_LEVEL), glow: mine.find((x) => x.layer === GLOW_LEVEL) }
}

/**
 * 等到屏幕上一个叠层都不剩,再开始测。
 *
 * ⚠️这一步是**假绿灯防线**:光标空闲 8 秒才自动隐藏,而 check:live 会紧接着 check:liveview 跑 ——
 * 上一个仪器留下的光标窗口足以让本次的断言通过,哪怕本次这一下压根没画光标。
 */
async function waitForCleanSlate(hpid, timeoutMs = 14_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const w = watch(0.15)
    await w.done
    const last = w.frames.at(-1)
    if (last) {
      const { cursor, glow } = overlaysIn(last.windows, hpid)
      if (!cursor && !glow) return
    }
    await sleep(500)
  }
  throw new Error('等叠层散场超时 —— 上一次的光标还挂在屏上,此时测不出本次有没有画')
}

const findNode = (node, pred) => {
  if (!node) return null
  if (pred(node)) return node
  for (const c of node.children || []) { const hit = findNode(c, pred); if (hit) return hit }
  return null
}
try {
  // 先发一条命令 —— daemon 是惰性启动的,没连过就没有进程可 pgrep。
  const diag = await ensureDaemon(ask)
  assert.ok(diag.accessibility, '需要「辅助功能」权限')
  const hpid = helperPid()

  const { calc, win } = await freshCalculator(ask)
  const look = await ask({ cmd: 'look', pid: calc.pid, windowId: win.windowId, includeImage: true })
  const five = findNode(look.outline, (x) => x.role === 'AXButton' && (x.description === '5' || x.title === '5'))
  assert.ok(five, '没找到数字键 5')

  // 干净起跑线:确认此刻一个叠层都没有,后面「出现了」才归功于这一次操作。
  await waitForCleanSlate(hpid)

  const w = watch(6)
  await sleep(400) // 这段是基线帧,必须是空的
  const actStartedAt = Date.now()
  // policy=background → helper delivery=pid/ax → 这一路**按设计必须**画虚拟光标 + 边缘光效。
  const acted = await ask({
    cmd: 'act', lookId: look.lookId, pid: calc.pid, policy: 'background',
    cursorOverlay: true, action: 'click',
    target: { x: five.rect.x + five.rect.w / 2, y: five.rect.y + five.rect.h / 2 },
    params: { button: 'left', clickCount: 1 },
  })
  const actMs = Date.now() - actStartedAt
  await w.done

  console.log(`  performed = ${JSON.stringify(acted.performed)}`)
  assert.ok(['ax', 'pid'].includes(acted.performed?.delivery),
    `policy=background 必须走后台投递,实得 delivery=${acted.performed?.delivery}`)

  // ── 时间线归约 ──────────────────────────────────────────────────────────────
  // ⚠️按 **window level** 分辨,不要按尺寸:关闭中的叠层会带着 alpha≈0.007 淡出好几帧,
  // 一度被误判成"边缘光效已上屏"而给出假绿灯。level 同时正是这次的修复点,一并钉死。
  const calcWinId = win.windowId
  const rows = w.frames.map((f) => {
    const target = f.windows.find((x) => x.windowId === calcWinId)
    return { t: f.t, ...overlaysIn(f.windows, hpid), targetZ: target?.z }
  })
  const baseline = rows.filter((r) => r.t < 400) // act 发出之前
  const after = rows.filter((r) => r.t >= 400 + actMs)
  const glyph = (o, targetZ) => (!o ? '·' : targetZ == null ? '?' : o.z < targetZ ? 'A' : 'b')
  console.log(`  示意光标: ${rows.map((r) => glyph(r.cursor, r.targetZ)).join('')}`)
  console.log(`  边缘光效: ${rows.map((r) => glyph(r.glow, r.targetZ)).join('')}`)
  console.log(`             (· 不在屏上 ｜ A 在目标窗口之上 ｜ b 被目标窗口盖住;前 ${baseline.length} 帧是基线)`)
  const sample = rows.find((r) => r.cursor)
  if (sample) console.log(`  示意光标窗口:layer=${sample.cursor.layer} alpha=${sample.cursor.alpha} ${sample.cursor.w}x${sample.cursor.h}`)
  const glowSample = rows.find((r) => r.glow)
  if (glowSample) console.log(`  边缘光效窗口:layer=${glowSample.glow.layer} alpha=${glowSample.glow.alpha} ${glowSample.glow.w}x${glowSample.glow.h}`)

  // ⚠️基线必须是空的,否则「出现了」可能是上一个仪器留下的窗口(光标空闲 8 秒才隐藏)。
  assert.ok(!baseline.some((r) => r.cursor), '动手之前就有示意光标在屏上 —— 这轮的断言会认错功劳')
  assert.ok(!baseline.some((r) => r.glow), '动手之前就有边缘光效在屏上 —— 这轮的断言会认错功劳')

  assert.ok(after.some((r) => r.cursor), '这一下之后示意光标没出现 —— AgentCursor 的 NSWindow 没被创建/显示')
  assert.ok(after.some((r) => r.glow), '这一下之后边缘光效没出现 —— AgentHighlight 没被点亮')
  // 命门:窗口在屏上 ≠ 用户看得见。level 没设的话它待在普通层(layer=0),
  // 而宿主是 .accessory 从不激活 → 永远被被操控的那个 App 压在下面 = 用户什么也看不到。
  assert.ok(after.some((r) => r.cursor && r.targetZ != null && r.cursor.z < r.targetZ), '示意光标始终被目标窗口盖住(z-order 在其下)—— 用户看不见,等于没画')
  assert.ok(after.some((r) => r.glow && r.targetZ != null && r.glow.z < r.targetZ), '边缘光效始终被目标窗口盖住(z-order 在其下)—— 用户看不见,等于没画')
  console.log('✅ 叠层可见性:这一下之后两个叠层都新上了屏,且都盖在被操控窗口之上')
  console.log('   (只验证窗口的创建/层级/z 序 —— 画布内容是否真画出了像素,本仪器不覆盖)')
} finally {
  await killCalculator(ask).catch(() => {})
  fs.rmSync(probeBin, { force: true })
  fs.rmSync(swiftFile, { force: true })
}
