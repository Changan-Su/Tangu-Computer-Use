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
            "x": b["X"] as? Double ?? 0, "y": b["Y"] as? Double ?? 0,
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

// 遮挡窗:另一个进程开一扇普通窗口盖住目标并把自己激活,扮演「用户的前台 App」。
const COVER_SWIFT = `
import AppKit
let a = CommandLine.arguments.dropFirst().compactMap { Double($0) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens[0]
let frame = NSRect(x: a[0] - 20, y: primary.frame.height - a[1] - a[3] - 20, width: a[2] + 40, height: a[3] + 40)
let w = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
w.title = "tangu-cu overlay check cover"
w.backgroundColor = .systemGray
w.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { exit(0) }
app.run()
`
const coverFile = path.join(os.tmpdir(), `tangu-cu-overlay-cover-${process.pid}.swift`)
const coverBin = path.join(os.tmpdir(), `tangu-cu-overlay-cover-${process.pid}`)
fs.writeFileSync(coverFile, COVER_SWIFT)
execFileSync('xcrun', ['swiftc', '-target', triple, '-O',
  '-module-cache-path', path.join(os.tmpdir(), `tangu-cu-overlay-cache-${process.arch}`),
  coverFile, '-o', coverBin], { stdio: 'inherit' })
/** 开一扇盖住 frame(CG 全局坐标)的遮挡窗,返回子进程。 */
async function openCover(frame) {
  const child = spawn(coverBin, [frame.x, frame.y, frame.w, frame.h].map(String), { stdio: 'ignore' })
  await sleep(300)
  return child
}

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

const VISIBLE_ALPHA = 0.5 // 淡入淡出中的窗口不算"用户看得见"
const GLOW_PAD = 12 // agent_highlight.swift 的 pad:光效窗口比目标每边大 12pt
// 两个叠层现在都跟目标同层(钉在目标正上方,10-17),不能再按 level 分:按 helper 进程 + 尺寸分。
// 光效 = 目标矩形外扩 pad;示意光标 = 铺满所有屏幕的那扇(远大于目标)。alpha 门槛照旧挡住淡出中的残影。
const overlaysIn = (windowStack, hpid, target) => {
  const mine = windowStack.filter((x) => x.pid === hpid && x.alpha > VISIBLE_ALPHA)
  const glow = target && mine.find((x) => Math.abs(x.w - target.w - GLOW_PAD * 2) <= 2 && Math.abs(x.h - target.h - GLOW_PAD * 2) <= 2)
  const cursor = mine.find((x) => x !== glow && x.w * x.h > 4 * (target ? target.w * target.h : 0) && x.w >= 640)
  return { cursor, glow }
}

/**
 * 等到屏幕上一个叠层都不剩,再开始测。
 *
 * ⚠️这一步是**假绿灯防线**:光标空闲 8 秒才自动隐藏,而 check:live 会紧接着 check:liveview 跑 ——
 * 上一个仪器留下的光标窗口足以让本次的断言通过,哪怕本次这一下压根没画光标。
 */
async function waitForCleanSlate(hpid, targetId, timeoutMs = 14_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const w = watch(0.15)
    await w.done
    const last = w.frames.at(-1)
    if (last) {
      const { cursor, glow } = overlaysIn(last.windows, hpid, last.windows.find((x) => x.windowId === targetId))
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
  await waitForCleanSlate(hpid, win.windowId)

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
    return { t: f.t, ...overlaysIn(f.windows, hpid, target), targetZ: target?.z }
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
  // 命门:窗口在屏上 ≠ 用户看得见。叠层没钉到目标上面的话(跨进程 order 没生效、level 不对),
  // 宿主是 .accessory 从不激活 → 永远被被操控的那个 App 压在下面 = 用户什么也看不到。
  assert.ok(after.some((r) => r.cursor && r.targetZ != null && r.cursor.z < r.targetZ), '示意光标始终被目标窗口盖住(z-order 在其下)—— 用户看不见,等于没画')
  assert.ok(after.some((r) => r.glow && r.targetZ != null && r.glow.z < r.targetZ), '边缘光效始终被目标窗口盖住(z-order 在其下)—— 用户看不见,等于没画')
  console.log('✅ 叠层可见性:这一下之后两个叠层都新上了屏,且都盖在被操控窗口之上')

  // ── 第二段:目标被别的 App 的窗口盖住时,叠层必须在那扇窗口**下面**(10-17 用户定「特效跟着窗口可见部分」)。
  // 以前叠层压在一切之上,后台操作时光效和光标画在用户的前台窗口上。现在叠层钉在目标正上方一层。
  const calcFrame = w.frames.at(-1)?.windows.find((x) => x.windowId === calcWinId)
  assert.ok(calcFrame, '第一段结束时找不到计算器窗口')
  const cover = await openCover(calcFrame)
  try {
    await sleep(900)
    const look2 = await ask({ cmd: 'look', pid: calc.pid, windowId: win.windowId, includeImage: true })
    const five2 = findNode(look2.outline, (x) => x.role === 'AXButton' && (x.description === '5' || x.title === '5'))
    assert.ok(five2, '盖窗后没找到数字键 5')
    const w2 = watch(3)
    await sleep(200)
    const acted2 = await ask({
      cmd: 'act', lookId: look2.lookId, pid: calc.pid, policy: 'background',
      cursorOverlay: true, action: 'click',
      target: { x: five2.rect.x + five2.rect.w / 2, y: five2.rect.y + five2.rect.h / 2 },
      params: { button: 'left', clickCount: 1 },
    })
    await w2.done
    assert.ok(['ax', 'pid'].includes(acted2.performed?.delivery), `盖窗时必须走后台投递,实得 delivery=${acted2.performed?.delivery}`)
    const rows2 = w2.frames.map((f) => {
      const target = f.windows.find((x) => x.windowId === calcWinId)
      const coverWin = f.windows.find((x) => x.pid === cover.pid && x.layer === 0)
      return { t: f.t, ...overlaysIn(f.windows, hpid, target), targetZ: target?.z, coverZ: coverWin?.z }
    }).filter((r) => r.t >= 200)
    const g2 = (o, r) => (!o || r.targetZ == null || r.coverZ == null ? '·' : o.z < r.coverZ ? 'X' : o.z < r.targetZ ? 'S' : 'b')
    console.log(`  盖窗后光标: ${rows2.map((r) => g2(r.cursor, r)).join('')}`)
    console.log(`  盖窗后光效: ${rows2.map((r) => g2(r.glow, r)).join('')}`)
    console.log('             (· 不在屏上 ｜ S 夹在遮挡窗和目标之间 ｜ X 盖在遮挡窗上面 ｜ b 被目标盖住)')
    assert.ok(rows2.some((r) => r.coverZ != null && r.targetZ != null && r.coverZ < r.targetZ), '遮挡窗没盖到计算器上面 —— 这一段测不出东西')
    const sandwiched = (o, r) => o && r.coverZ != null && r.targetZ != null && r.coverZ < o.z && o.z < r.targetZ
    const onTop = (o, r) => o && r.coverZ != null && o.z < r.coverZ
    assert.ok(rows2.some((r) => sandwiched(r.glow, r)), '盖窗时边缘光效没夹在遮挡窗和目标之间')
    assert.ok(!rows2.some((r) => onTop(r.glow, r)), '盖窗时边缘光效盖到了遮挡窗上面 —— 后台操作画在用户的前台窗口上')
    assert.ok(rows2.some((r) => sandwiched(r.cursor, r)), '盖窗时示意光标没夹在遮挡窗和目标之间')
    assert.ok(!rows2.some((r) => onTop(r.cursor, r)), '盖窗时示意光标盖到了遮挡窗上面 —— 后台操作画在用户的前台窗口上')
    console.log('✅ 盖窗:两个叠层都在遮挡窗下面、目标上面')
  } finally {
    cover.kill()
  }

  // ── 第三段(协议 20):带 runId 的一轮里叠层整轮亮着,显式结束后散场。
  // 真机上跑过(2026-11-14,四份演练包):红了先看打印出来的时间线,再判断是产品还是这段断言。
  // 前两段的 act 不带 runId,走的是旧时长(光效 2 s、光标 8 s);这里要证的是「带 runId 就不按旧时长熄」。
  await waitForCleanSlate(hpid, win.windowId)
  const look3 = await ask({ cmd: 'look', pid: calc.pid, windowId: win.windowId, includeImage: true })
  const five3 = findNode(look3.outline, (x) => x.role === 'AXButton' && (x.description === '5' || x.title === '5'))
  assert.ok(five3, '第三段没找到数字键 5')
  const runId = `overlay-check-${process.pid}`
  const HOLD_MS = 4200 // 远超旧的 2 s 光效时长,又远不到 45 s 的空闲兜底
  const GONE_MS = 2500 // 结束后停 1.0 s + 淡出 0.4 s,再留余量
  const w3 = watch(11)
  const t0 = Date.now()
  await sleep(300)
  // 帧数(diagnostics.overlayFrames):两扇叠层的画布各重画了多少次。窗口在屏上不等于动画在放 ——
  // 2026-11-14 真机上量到过渡只画了起点那一帧(画布没用到 TimelineView 的时刻,SwiftUI 不逐帧重画)。
  const frames = async () => (await ask({ cmd: 'diagnostics' })).overlayFrames ?? null
  const f0 = await frames()
  await ask({
    cmd: 'act', lookId: look3.lookId, pid: calc.pid, policy: 'background',
    cursorOverlay: true, action: 'click', runId,
    target: { x: five3.rect.x + five3.rect.w / 2, y: five3.rect.y + five3.rect.h / 2 },
    params: { button: 'left', clickCount: 1 },
  })
  const actedAt = Date.now() - t0
  await sleep(1000) // 出场 / 飞行 / 点击环 / 0.3 s 后退到「在想」的 0.4 s 过渡,都落在这一秒里
  const f1 = await frames()
  await sleep(2000) // 这两秒只剩「在想」时的轻摆(30 fps)
  const f2 = await frames()
  await sleep(Math.max(0, HOLD_MS - (Date.now() - t0 - actedAt)))
  const ended = await ask({ cmd: 'overlayTurn', phase: 'end', runId })
  const endedAt = Date.now() - t0
  await w3.done
  assert.equal(ended?.ok, true, 'overlayTurn end 没被接受')
  const rows3 = w3.frames.map((f) => {
    const target = f.windows.find((x) => x.windowId === calcWinId)
    return { t: f.t, ...overlaysIn(f.windows, hpid, target) }
  })
  const mark = (o) => (o ? '#' : '·')
  console.log(`  整轮光标: ${rows3.map((r) => mark(r.cursor)).join('')}`)
  console.log(`  整轮光效: ${rows3.map((r) => mark(r.glow)).join('')}`)
  console.log(`             (# 在屏上 ｜ · 不在;act 返回于 ${actedAt}ms,发结束于 ${endedAt}ms,每格约 100ms)`)
  // 旧时长下光效在 act 之后 2 s 就熄了:取「act 后 3 s 到发结束之前」这一段,必须还亮着。
  const held = rows3.filter((r) => r.t >= actedAt + 3000 && r.t < endedAt - 100)
  assert.ok(held.length >= 3, '第三段采样太少,测不出东西')
  assert.ok(held.every((r) => r.glow), '带 runId 的一轮里边缘光效中途熄了 —— 还在按旧的 2 s 时长走')
  assert.ok(held.every((r) => r.cursor), '带 runId 的一轮里示意光标中途没了')
  const gone = rows3.filter((r) => r.t >= endedAt + GONE_MS)
  assert.ok(gone.length >= 3, '第三段结束后的采样太少,测不出东西')
  assert.ok(!gone.some((r) => r.cursor || r.glow), `发了结束 ${GONE_MS}ms 之后叠层还在屏上 —— 整轮结束没让它散场`)
  console.log('✅ 整轮:带 runId 时两个叠层一直亮到显式结束,结束后散场')

  // ── 逐帧重画:过渡期间画布的重画次数要跟得上帧率,不是每次状态变化只画一帧。
  if (!f0 || !f1 || !f2) {
    console.log('   (这份 helper 的 diagnostics 没有 overlayFrames,逐帧重画这一条跳过)')
  } else {
    const reduce = await execFileP('defaults', ['read', 'com.apple.universalaccess', 'reduceMotion']).then((r) => r.stdout.trim() === '1', () => false)
    const d = { glowEnter: f1.highlight - f0.highlight, cursorEnter: f1.cursor - f0.cursor, cursorThink: f2.cursor - f1.cursor, glowThink: f2.highlight - f1.highlight }
    console.log(`  重画次数: 动手后 1 s 内 光效 ${d.glowEnter} / 光标 ${d.cursorEnter};之后在想的 2 s 光标 ${d.cursorThink} / 光效 ${d.glowThink}${reduce ? '(系统开了减少动态效果)' : ''}`)
    // 光效:亮起 + 0.3 s 后退到在想那一档的 0.4 s 过渡,60 fps 下三十帧上下;不逐帧重画时只有两三帧。
    assert.ok(d.glowEnter >= 12, `边缘光效的过渡没有逐帧重画(1 s 内只画了 ${d.glowEnter} 帧)—— 屏上看到的会是过渡的起点值`)
    if (reduce) {
      console.log('   (系统开了「减少动态效果」:光标不飞行、不摆动,光标的两条跳过)')
    } else {
      assert.ok(d.cursorEnter >= 12, `示意光标的出场 / 飞行 / 点击环没有逐帧重画(1 s 内只画了 ${d.cursorEnter} 帧)`)
      assert.ok(d.cursorThink >= 20, `在想时示意光标没有轻摆(2 s 里只画了 ${d.cursorThink} 帧,30 fps 应当六十帧上下)`)
    }
    // 光效退到在想那一档之后就停表,不留常驻重绘。
    assert.ok(d.glowThink <= 6, `边缘光效静止时还在重画(2 s 里 ${d.glowThink} 帧)—— 过渡放完没有停表`)
    console.log('✅ 逐帧重画:过渡在按帧率画,静止时停表')
  }

  console.log('   (只验证窗口的创建/层级/z 序与重画次数 —— 画布内容是否真画出了像素,本仪器不覆盖)')
} finally {
  await killCalculator(ask).catch(() => {})
  fs.rmSync(probeBin, { force: true })
  fs.rmSync(swiftFile, { force: true })
  fs.rmSync(coverBin, { force: true })
  fs.rmSync(coverFile, { force: true })
}
