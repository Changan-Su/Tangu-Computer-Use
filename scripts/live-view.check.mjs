#!/usr/bin/env node
/**
 * 「实时画面」的真机仪器 —— 证明 liveView 走的是**常驻取景流**而不是每帧现截,而且画面真的在动。
 *
 * 症状是"不是 share screen 的实时画面,是掉帧的"。掉帧有两种完全不同的成因,这个脚本分开钉:
 *   ① **取一帧要多久**(source=snapshot 时每帧都要重新协商采集会话,几十到几百毫秒不等)
 *   ② **帧到底新不新**(流没起来 / 只推 .idle 空帧的话,拿到的会是同一张,再快也是静止画)
 * 所以既量延迟也量**相邻帧的字节差异** —— 只量其一都能被另一种失败蒙混过去。
 *
 * 跑法:node scripts/live-view.check.mjs
 * 需要:macOS、helper 已装并授权(辅助功能 + 屏幕录制)。会短暂打开「计算器」,跑完关掉。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { ensureDaemon, freshCalculator, killCalculator } from './calc-fixture.mjs'

const SOCK = `${homedir()}/Library/Caches/tangu-computer-use/bridge.sock`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FRAMES = 24
const TICK_MS = 120 // 与 main.js 的轮询节奏一致

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
    sock.write(`${JSON.stringify({ id: `lv_${++seq}`, ...payload })}\n`)
  })
}

const findNode = (node, pred) => {
  if (!node) return null
  if (pred(node)) return node
  for (const c of node.children || []) { const hit = findNode(c, pred); if (hit) return hit }
  return null
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const diag = await ensureDaemon(ask)
assert.equal(diag.protocolVersion, 11, `helper 协议应为 11,实测 ${diag.protocolVersion}`)
assert.ok(diag.screenRecording, '需要「屏幕录制」权限,否则拿不到任何画面')

try {
  const { calc, win } = await freshCalculator(ask)
  const look = await ask({ cmd: 'look', pid: calc.pid, windowId: win.windowId, includeImage: true })
  const keyOf = (d) => {
    const n = findNode(look.outline, (x) => x.role === 'AXButton' && (x.description === d || x.title === d))
    assert.ok(n, `没找到数字键 ${d}`)
    return { x: n.rect.x + n.rect.w / 2, y: n.rect.y + n.rect.h / 2 }
  }
  // ⚠️policy 必须是 background:这里只是要把窗口内容点变以便验证帧在更新,
  // 用 foreground/hid 的话仪器每跑一次就抢 12 次用户焦点、还把实物鼠标拽走 ——
  // 测「不抢前台」的项目自己抢前台,荒唐。后台 AX 按压点得中数字键(check:blindclick 已证明)。
  const click = (d) => ask({
    cmd: 'act', lookId: look.lookId, pid: calc.pid, policy: 'background',
    cursorOverlay: true, action: 'click', target: keyOf(d), params: { button: 'left', clickCount: 1 },
  })

  // liveView 只认"最近被操控过的窗口" —— 先动一下,它才有东西可播
  await click('1')
  await sleep(300)

  const frames = []
  for (let i = 0; i < FRAMES; i++) {
    // 每帧之间改一下计算器的读数,窗口内容才会**真的**变 —— 否则静止窗口本来就该是同一张,
    // "帧不变"证明不了流没工作。
    if (i % 2 === 0) await click(String((i / 2) % 10))
    const t0 = process.hrtime.bigint()
    const f = await ask({ cmd: 'liveView', maxDimension: 800, quality: 0.55, activeWithinMs: 120_000 })
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    frames.push({
      ms,
      source: f.source,
      active: f.active,
      error: f.error,
      hash: f.jpegBase64 ? createHash('sha1').update(f.jpegBase64).digest('hex').slice(0, 8) : null,
      size: f.jpegBase64 ? f.jpegBase64.length : 0,
      dims: f.width ? `${f.width}x${f.height}` : null,
    })
    await sleep(TICK_MS)
  }

  const withImage = frames.filter((f) => f.hash)
  const streamed = frames.filter((f) => f.source === 'stream')
  const distinct = new Set(withImage.map((f) => f.hash)).size
  const lat = median(withImage.map((f) => f.ms))

  console.log(`  取到画面 ${withImage.length}/${FRAMES} 帧 ｜ 走取景流 ${streamed.length} 帧 ｜ 不重复画面 ${distinct} 种`)
  console.log(`  单帧耗时中位数 ${lat.toFixed(1)}ms ｜ 尺寸 ${withImage[0]?.dims} ｜ 约 ${(withImage[0]?.size / 1024).toFixed(0)}KB/帧`)
  const mark = (f) => ({ stream: 'S', snapshot: 'n', legacy: 'L' }[f.source] || (f.error ? '!' : '·'))
  console.log(`  source 序列: ${frames.map(mark).join('')}   (S=常驻流, n=单帧兜底, L=上游老路)`)

  assert.ok(withImage.length >= FRAMES - 2, `应该几乎每次都拿到画面,实得 ${withImage.length}/${FRAMES}`)
  assert.ok(streamed.length >= FRAMES - 3, `除头几帧外都应走常驻取景流,实得 ${streamed.length}/${FRAMES} —— 全是 snapshot 说明流没起来`)
  // 命门:延迟低但画面永远是同一张 = 静止画,照样是用户说的"掉帧"
  assert.ok(distinct >= FRAMES / 3, `画面必须真的在更新,${withImage.length} 帧里只有 ${distinct} 种`)
  assert.ok(lat < 100, `单帧耗时中位数应远低于轮询间隔(${TICK_MS}ms),实测 ${lat.toFixed(1)}ms —— 追不上就是掉帧`)
  // ⚠️"占不满有留白"的回归线:上游 captureWindow 不设宽高,ScreenCaptureKit 会按整块屏幕出图、
  // 把窗口摆在左上角、其余留白 —— 留白是**烤进 JPEG** 的,CSS 那头救不回来。
  // 所以每一帧的宽高比都必须等于窗口自己的宽高比。
  const wantAr = win.framePoints.w / win.framePoints.h
  for (const f of withImage) {
    const [w, h] = f.dims.split('x').map(Number)
    assert.ok(Math.abs(w / h - wantAr) < 0.02, `画面宽高比必须等于窗口(窗口 ${win.framePoints.w}x${win.framePoints.h} → ${wantAr.toFixed(3)}),实得 ${f.dims} → ${(w / h).toFixed(3)}(source=${f.source})`)
  }
  assert.ok(!frames.some((f) => f.source === 'legacy'), '不该退到上游那条会留白的老路')
  console.log(`✅ 实时画面:走常驻取景流、单帧亚百毫秒、画面确实在动、且每帧都是窗口原比例(无留白)`)
} finally {
  await killCalculator(ask).catch(() => {})
}
