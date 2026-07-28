#!/usr/bin/env node
/**
 * 「后台盲点」的真机仪器 —— 证明**坐标点击不抢前台**,而且真的落下去了。
 *
 * 为什么必须有它:症状是"点了就跳前台、虚拟鼠标不出现",而这条路上有三段各自都会静默失败的东西
 * (needsForeground 判定 → helper 的 AX 命中测试 → AXPress 到底打没打中)。纸面推理只能验证想到的
 * 那一段。这个脚本一次把三段都钉住:
 *
 *   ① `performed.delivery === "ax"` —— 走的是 AX 按压,没发物理事件(所以不动真鼠标)
 *   ② 前台 App 前后不变 —— 没抢焦点
 *   ③ **计算器的显示值真的变了** —— 这一条最重要:前两条都能在"点击压根没生效"时照样成立。
 *      没有 ③ 的话,"不抢前台"可以靠什么都不做来达成。
 *
 * 跑法:node scripts/blind-click.check.mjs
 * 需要:macOS、helper 已装并授权(辅助功能 + 屏幕录制)。会短暂打开「计算器」,跑完关掉。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const SOCK = `${homedir()}/Library/Caches/tangu-computer-use/bridge.sock`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let seq = 0
/** 一次请求一条连接 —— helper 的协议是一行 JSON 进、一行 JSON 出,不必维持长连。 */
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
    sock.write(`${JSON.stringify({ id: `bc_${++seq}`, ...payload })}\n`)
  })
}

/** 前台是谁 —— 问 helper 自己(NSWorkspace),**别走 osascript**:System Events 要额外的
 *  「自动化」授权,node 没有,只会 AppleEvent 超时(踩过)。 */
const frontmostApp = async () => `${(await ask({ cmd: 'getFrontmost' })).appName}`

/** 在 outline 里深度优先找第一个满足条件的节点。 */
function findNode(node, pred) {
  if (!node) return null
  if (pred(node)) return node
  for (const child of node.children || []) {
    const hit = findNode(child, pred)
    if (hit) return hit
  }
  return null
}

/** 等计算器真的起来并且有窗口 —— 固定 sleep 会在机器忙时随机失败,薄脆的仪器比没有更坏。 */
async function waitForCalculator(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const calc = (await ask({ cmd: 'listApps' })).find((a) => a.bundleId === 'com.apple.calculator')
    if (calc) {
      const win = (await ask({ cmd: 'listRoots', pid: calc.pid })).roots.find((r) => r.windowId)
      if (win) return { calc, win }
      last = '进程在但还没有可见窗口'
    } else {
      last = '还没看到计算器进程'
    }
    await sleep(300)
  }
  throw new Error(`等计算器就绪超时:${last}`)
}

const diag = await ask({ cmd: 'diagnostics' })
assert.equal(diag.protocolVersion, 10, `helper 协议应为 10,实测 ${diag.protocolVersion} —— 先重装 helper`)
assert.ok(diag.accessibility, '需要「辅助功能」权限')

// 后台打开计算器(-g = 不抢前台),留在终端/当前 App 前台
await execFileP('open', ['-g', '-a', 'Calculator'])
try {
  const before = await frontmostApp()
  const { calc, win } = await waitForCalculator()

  const look = await ask({ cmd: 'look', pid: calc.pid, windowId: win.windowId, includeImage: true })
  // ⚠️outline 里的 rect 已经是**图像坐标**(不是屏幕坐标),act 的 x/y 要的正是它 —— 别再换算一遍。
  const key5 = findNode(look.outline, (n) => n.role === 'AXButton' && (n.description === '5' || n.title === '5'))
  assert.ok(key5, '没在 outline 里找到数字键 5')
  const imgX = key5.rect.x + key5.rect.w / 2
  const imgY = key5.rect.y + key5.rect.h / 2

  /** 计算器的读数:第一个有值的静态文本。数字前有个 LTR 标记,只留数字。 */
  const displayIn = (outline) => String(findNode(outline, (n) => n.role === 'AXStaticText' && n.value)?.value ?? '').replace(/\D/g, '')
  const digitAt = (n) => {
    const node = findNode(look.outline, (x) => x.role === 'AXButton' && (x.description === n || x.title === n))
    assert.ok(node, `没在 outline 里找到数字键 ${n}`)
    // ⚠️outline 里的 rect 已经是**图像坐标**(不是屏幕坐标),act 的 x/y 要的正是它 —— 别再换算一遍。
    return { x: node.rect.x + node.rect.w / 2, y: node.rect.y + node.rect.h / 2 }
  }

  /** 只给 x/y(**没有 ref**)—— 这正是 agent 看着截图"盲点"时走的那条路,也正是上游会直接判
   *  needsForeground、跳去 HID 前台的那条路。policy/delivery 照 TS 层在这种情况下会发的值。 */
  const blindClick = async (digit) => {
    const p = digitAt(digit)
    const act = await ask({
      cmd: 'act',
      lookId: look.lookId,
      pid: calc.pid,
      policy: 'foreground',
      delivery: 'hid',
      cursorOverlay: true,
      action: 'click',
      target: { x: p.x, y: p.y },
      params: { button: 'left', clickCount: 1 },
    })
    await sleep(350)
    const fresh = await ask({ cmd: 'look', pid: calc.pid, windowId: win.windowId, includeImage: false })
    return { act, display: displayIn(fresh.outline) }
  }

  // 连点两个**不同**的数字:断言只看"最后一位是不是刚点的那个",与计算器的起始状态无关
  // (上一轮跑剩的数字会留在屏上 —— 拿 before≠after 当判据会被这个坑掉)。
  const five = await blindClick('5')
  const seven = await blindClick('7')
  const after = await frontmostApp()

  console.log(`  performed = ${JSON.stringify(five.act.performed)}`)
  console.log(`  前台: ${before} → ${after}`)
  console.log(`  计算器显示: 点 5 → ${five.display} ｜ 点 7 → ${seven.display}`)

  for (const [label, r] of [['5', five], ['7', seven]]) {
    assert.equal(r.act.performed?.delivery, 'ax', `点 ${label}:坐标点击应走后台 AX 按压(delivery=ax),不是物理事件`)
    assert.equal(r.act.performed?.grounding, 'hit_test', `点 ${label}:应经由 AX 命中测试落点`)
  }
  assert.equal(after, before, `点击不得夺取前台(${before} → ${after})`)
  // ⚠️这两条是命门:上面三条在"点击压根没生效"时照样全绿 —— "不抢前台"可以靠什么都不做换来。
  assert.ok(five.display.endsWith('5'), `点了 5,读数应以 5 结尾,实得 ${five.display}`)
  assert.ok(seven.display.endsWith('7'), `点了 7,读数应以 7 结尾,实得 ${seven.display}`)
  console.log('✅ 后台盲点:走 AX、不抢前台、且两次都真的点中了')
} finally {
  await execFileP('pkill', ['-x', 'Calculator']).catch(() => {})
}
