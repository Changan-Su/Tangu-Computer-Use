#!/usr/bin/env node
/**
 * 「不带目标的按键 / 滚动」的真机仪器 —— 走真 helper、真 bridge.ts(executeObserve / executeAct),不是只测 actions.ts。
 *
 * 为什么要有它:`npm run check:actions` 只钉得住动作准备那一层。「上一次 act_ui 点过、这一次只按键」能不能成,
 * 还取决于两段单测够不着的东西:桥接层对「目标窗口此刻在不在前台」的实测,以及 helper 把跟随焦点的按键
 * 送到了哪。这里用计算器走一遍(全程只给坐标,不给 ref —— 微信那类无障碍树是空的 App 就是这么操作的):
 *
 *   ① 计算器在后台:不带目标的 keypress → 报错,文案带改法;前台 App 不变(没有任何按键被发出去)
 *   ② 点一下计算器的读数区(坐标点击,落在非按钮上 → 真的拿到前台)
 *   ③ **下一次** act_ui 只发 keypress 7 → 成功,且读数真的以 7 结尾
 *   ④ [moveMouse, scroll(只有 scrollY)] → 两步都执行;单独一个 scroll → 报错,文案带改法
 *
 * 跑法:node scripts/untargeted-input.check.mjs
 * 需要:macOS、helper 已装并授权。会打开「计算器」并**短暂把它拿到前台**(几秒),跑完关掉、把原来的前台 App 切回来。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { connect } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { SOCK, ensureDaemon, freshCalculator, killCalculator } from './calc-fixture.mjs'

if (process.platform !== 'darwin') {
  console.log('untargeted input check skipped (not macOS)')
  process.exit(0)
}

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
    sock.write(`${JSON.stringify({ id: `ui_${++seq}`, ...payload })}\n`)
  })
}

function findNode(node, pred) {
  if (!node) return null
  if (pred(node)) return node
  for (const child of node.children || []) {
    const hit = findNode(child, pred)
    if (hit) return hit
  }
  return null
}

// 真 bridge.ts 现编一份。⚠️产物必须落在 tangu-plugins/computer-use/dist/ 里:vendor 的 helper 用
// import.meta.url 上跳 3 级找包根(见 build.mjs 的 PACKAGE_ROOT 说明),放别处它就找不到 setup-helper。
const outfile = path.join(root, 'tangu-plugins/computer-use/dist', `.untargeted-check-${process.pid}.mjs`)
await build({
  stdin: { contents: "export { executeFind, executeObserve, executeAct, ensureComputerUseSetup } from './src/vendor/bridge.ts'", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent',
  external: ['node:*'],
  alias: { '@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts') },
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
})
let bridge
try { bridge = await import(pathToFileURL(outfile).href) } finally { rmSync(outfile, { force: true }) }

const pctx = { cwd: root, hasUI: false, ui: { notify: () => {}, select: async () => undefined }, sessionManager: { getBranch: () => [] } }
const text = (result) => result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
/** 对上一个结果的状态再发一批动作(每个结果的 details.capture.stateId 就是它之后那一批要带的 stateId)。 */
const act = (state, actions) => bridge.executeAct('', { stateId: state.capture.stateId, actions }, undefined, undefined, pctx)
const failure = async (promise) => { try { await promise } catch (error) { return error.message } assert.fail('expected act_ui to fail') }
const frontmost = () => ask({ cmd: 'getFrontmost' })

await ensureDaemon(ask)
const before = await frontmost()
try {
  const { calc, win } = await freshCalculator(ask)
  await bridge.ensureComputerUseSetup(pctx)
  const found = text(await bridge.executeFind('', { bundleId: 'com.apple.calculator' }, undefined, undefined, pctx))
  const rootRef = found.match(/@r\d+/)?.[0]
  assert.ok(rootRef, `find_roots 没给出计算器的 @r:\n${found}`)
  const observe = async () => (await bridge.executeObserve('', { root: rootRef }, undefined, undefined, pctx)).details
  let state = await observe()
  assert.ok(state.capture?.stateId, 'observe_ui 没返回 stateId')

  /** 读数与读数区的中心点(图像坐标)。读数是第一个有值的静态文本;数字前有个 LTR 标记,只留数字。 */
  const readout = async () => {
    const look = await ask({ cmd: 'look', pid: calc.pid, windowId: win.windowId, includeImage: false })
    const node = findNode(look.outline, (n) => n.role === 'AXStaticText' && n.value)
    assert.ok(node, '没在 outline 里找到读数')
    return { digits: String(node.value).replace(/\D/g, ''), x: node.rect.x + node.rect.w / 2, y: node.rect.y + node.rect.h / 2 }
  }
  const display = await readout()

  // ① 后台 + 不带目标的按键 → 报错,前台不变
  assert.notEqual((await frontmost()).pid, calc.pid, '夹具应把计算器开在后台')
  const lost = await failure(act(state, [{ action: 'keypress', keys: ['7'] }]))
  assert.match(lost, /no focus to follow/, `① 应报「无焦点可跟随」,实得:${lost}`)
  assert.match(lost, /same act_ui call/, '① 报错应写明「同一批里先点一下」')
  assert.match(lost, /x and y/, '① 报错应写明「或给出 x / y」')
  assert.equal((await frontmost()).pid, before.pid, '① 报错的那一次不得动前台')
  assert.equal((await readout()).digits, display.digits, '① 报错的那一次不得有按键落进计算器')
  console.log(`  ① 后台按键被拒:${lost.slice(0, 96)}…`)
  state = await observe() // 失败的那次 act_ui 已让原状态过期(与本次改动无关,一向如此)

  // ② 坐标点击读数区(不是按钮 → AX 命中测试落空 → 物理点击,拿到前台)
  state = (await act(state, [{ action: 'click', x: display.x, y: display.y }])).details
  await sleep(300)
  assert.equal((await frontmost()).pid, calc.pid, '② 坐标点击后计算器应在前台')

  // ③ 下一次 act_ui 只按键 —— 修之前这里必报 `keypress requires either ref or both x and y.`
  const pressed = (await act(state, [{ action: 'keypress', keys: ['7'] }])).details
  await sleep(300)
  const after = await readout()
  console.log(`  ③ 跨调用按键:outcome=${pressed.execution?.outcome} 读数 ${display.digits || '(空)'} → ${after.digits}`)
  // ⚠️命门:没有这一条,「不报错」可以靠什么都没发出去换来。
  assert.ok(after.digits.endsWith('7'), `③ 按了 7,读数应以 7 结尾,实得 ${after.digits}`)
  state = pressed

  // ④ moveMouse 后跟只有 scrollY 的 scroll —— 修之前第二步必报 `scroll requires either ref or both x and y.`
  const scrolled = (await act(state, [{ action: 'moveMouse', x: display.x, y: display.y }, { action: 'scroll', scrollY: 3 }])).details
  assert.equal(scrolled.execution?.actionCount, 2, `④ 两步都应执行,实得 ${scrolled.execution?.actionCount}`)
  console.log(`  ④ moveMouse + scroll:执行了 ${scrolled.execution.actionCount} 步`)
  const alone = await failure(act(scrolled, [{ action: 'scroll', scrollY: 3 }]))
  assert.match(alone, /scroll has no position/, `④ 单独的 scroll 应报错,实得:${alone}`)
  assert.match(alone, /moveMouse/, '④ 报错应写明改法')
  console.log('✅ 不带目标的按键 / 滚动:后台被拒且不动前台、跨调用按键真的落下、scroll 沿用指针位置')
} finally {
  await killCalculator(ask).catch(() => {})
  // 把跑之前的前台 App 切回来(计算器退出后系统多半会自己切,这里兜一下)。
  if (before.bundleId) await execFileP('open', ['-b', before.bundleId]).catch(() => {})
}
