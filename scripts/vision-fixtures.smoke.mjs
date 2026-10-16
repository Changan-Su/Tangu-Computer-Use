#!/usr/bin/env node
/**
 * 冒烟:两个自绘替身(Melody = 网易云那类播放器、Chatter = 微信那类聊天软件)能编、能后台起、
 * 进程内自检过、状态 JSON 形状对、每一页都能截到图。
 *
 * 跑法:node scripts/vision-fixtures.smoke.mjs [--shots <目录>] [--only melody|chatter]
 * 需要:macOS、swiftc、装好并授权了屏幕录制的 tangu-computer-use helper。
 *
 * 每一页额外验三件事:
 *   ① 无障碍树里只有窗口和标题栏按钮(画出来的字一个都不许进树,否则它就不是「只能看图」的 App)
 *   ② layout 里的框和截图对得上:在几个条目的框里取像素,颜色必须是那个条目画出来的颜色(选中的侧栏项是红的、
 *      发出去的气泡是绿的……)。框偏了几个点就会取到背景色而失败 —— 这就是 layout 当「目标真实位置」的底气
 *   ③ helper 报的窗口位置 = 状态里的 window(左上角原点的换算没错)
 * 外加 SIGUSR1 收起窗口后状态里 visible 变成 false。
 * Chatter 的 --popup 那一页(反馈 69651ff8):搜索结果在一扇单独的浮动窗口里,主窗口的截图里必须有它
 * (helper 报 image.overlays = 1,浮窗第一行的浅绿、第二行的白落在主窗口截图的对应位置)。只截主窗口的老 helper 在这里失败。
 * ⚠️这一页的浮窗在 .floating 层,截图那一两秒会浮在用户的窗口上面(主窗口照旧在最后面)。
 *
 * ⚠️不发任何鼠标 / 键盘输入、不抢前台:替身用 `open -g -n` 起,窗口放到所有窗口后面(--behind,截图走
 * desktopIndependentWindow 不受遮挡);截图用一个私有 socket 上单独起的 helper 实例(只调只读的 look),
 * 跑完按 pid 关掉它和每个替身。交互逻辑靠替身自己的 --selftest(进程内直接调输入处理函数)来验。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveMacosHelperAppPath } from '../src/vendor/platform/macos/helper-path.mjs'
import { DEFAULT_FIXTURE_DIR, FIXTURES, buildFixture, launchFixture, quitFixture, selfTestFixture, waitForState } from './vision-fixtures.mjs'

if (process.platform !== 'darwin') {
  console.log('vision fixtures smoke skipped (not macOS)')
  process.exit(0)
}

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const argValue = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const only = argValue('--only')
const shotsDir = path.resolve(argValue('--shots') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fixture-shots-')))
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fixture-state-'))
fs.mkdirSync(shotsDir, { recursive: true })

// 每个替身截哪些画面(都是启动参数摆出来的,或者 selftest 跑完 --hold 住的最后一个画面)
const VARIANTS = {
  melody: [
    { page: 'home' }, { page: 'daily' }, { page: 'daily', play: 3 }, { page: 'liked' }, { page: 'comments:3' }, { page: 'loading' },
    { page: 'featured' }, { page: 'playlist:每日新歌速递' }, { hold: true },
  ],
  chatter: [
    { page: 'list' }, { page: 'chat:Sakura' }, { page: 'chat:Sakura', sent: '好呀,周六上午十点美术馆门口见' },
    { page: 'search:saku' }, { page: 'chat:项目群 · Forsion' }, { page: 'chat:文件传输助手' }, { hold: true },
    { page: 'search:Sakura', popup: true },
  ],
}
const COMMON_KEYS = ['pid', 'windowNumber', 'visible', 'clicks', 'doubleClicks', 'scrolls', 'keys', 'window', 'content', 'events', 'layout', 'titlebarHeight']
const KEYS = {
  melody: [...COMMON_KEYS, 'page', 'loading', 'selected', 'playing', 'comments', 'offsets', 'catalog'],
  chatter: [...COMMON_KEYS, 'focus', 'search', 'contact', 'input', 'sent', 'contacts'],
}

// ── 私有 socket 上的 helper(只读 look)──
const helperApp = resolveMacosHelperAppPath()
const socket = path.join(os.homedir(), 'Library', 'Caches', `forsion-vision-smoke-${process.pid}.sock`)
let seq = 0
function ask(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const s = connect(socket)
    let text = ''
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`helper timeout: ${cmd}`)) }, 20_000)
    s.on('error', (e) => { clearTimeout(timer); reject(e) })
    s.on('data', (d) => {
      text += d
      if (!text.includes('\n')) return
      clearTimeout(timer)
      s.end()
      const m = JSON.parse(text.split('\n')[0])
      m.ok ? resolve(m.result) : reject(new Error(`${cmd}: ${JSON.stringify(m.error)}`))
    })
    s.write(`${JSON.stringify({ id: `vfs-${++seq}`, cmd, ...args })}\n`)
  })
}
async function startHelper() {
  assert.ok(fs.existsSync(helperApp), `computer-use helper not installed at ${helperApp}`)
  await execFileP('open', ['-n', '-g', helperApp, '--args', 'serve', '--socket', socket])
  for (let i = 0; i < 75; i++) {
    try { return await ask('diagnostics') } catch { await sleep(200) }
  }
  throw new Error('isolated helper did not answer diagnostics')
}
async function stopHelper() {
  await ask('shutdown').catch(() => {})
  // 只杀命令行里带这个私有 socket 路径的进程 = 这次起的那个 helper 实例
  const { stdout } = await execFileP('pgrep', ['-f', socket]).catch(() => ({ stdout: '' }))
  for (const pid of stdout.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid)) } catch { /* 已退出 */ } }
  fs.rmSync(socket, { force: true })
}

function checkShape(name, s, label) {
  for (const k of KEYS[name]) assert.ok(k in s, `${label}: state is missing "${k}"`)
  assert.ok(s.windowNumber > 0 && s.visible === true && s.ready === true, `${label}: window should be visible and drawn`)
  assert.equal(s.content.w, s.window.w, `${label}: canvas fills the whole window (fullSizeContentView)`)
  for (const it of s.layout) {
    assert.ok(typeof it.kind === 'string' && typeof it.label === 'string' && it.rect, `${label}: layout item shape ${JSON.stringify(it)}`)
    const r = it.rect
    assert.ok(r.w > 0 && r.h > 0 && r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= s.window.w + 0.5 && r.y + r.h <= s.window.h + 0.5,
      `${label}: layout rect outside the window ${JSON.stringify(it)}`)
  }
  if (name === 'melody') {
    assert.equal(s.catalog.daily.length, 30, `${label}: catalog.daily has 30 songs`)
    assert.equal(s.catalog.liked.length, 30, `${label}: catalog.liked has 30 songs`)
    assert.ok(s.catalog.hottest['3']?.text?.length > 0, `${label}: catalog.hottest["3"].text`)
  } else {
    assert.ok(s.contacts.includes('Sakura') && s.contacts.includes('Saku'), `${label}: contacts include Sakura and Saku`)
  }
}

// ── ② 像素探针:截图(JPEG,经过色彩管理)解成 RGB,在 layout 框里取点,按「颜色大类」判断 ──
async function decodeCapture(jpg) {
  const bmp = path.join(stateDir, `probe-${process.pid}-${Date.now()}.bmp`)
  await execFileP('sips', ['-s', 'format', 'bmp', jpg, '--out', bmp])
  const b = fs.readFileSync(bmp)
  fs.rmSync(bmp, { force: true })
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22), bpp = b.readUInt16LE(28)
  assert.ok(bpp === 24 || bpp === 32, `unexpected BMP depth ${bpp}`)
  const h = Math.abs(hRaw), stride = Math.ceil((w * bpp) / 32) * 4
  return {
    w, h,
    rgb(x, y) {
      const px = Math.min(w - 1, Math.max(0, Math.round(x))), py = Math.min(h - 1, Math.max(0, Math.round(y)))
      const i = off + (hRaw > 0 ? h - 1 - py : py) * stride + px * (bpp / 8)
      return [b[i + 2], b[i + 1], b[i]]
    },
  }
}
const isRed = ([r, g, b]) => r > 150 && r > g + 60 && r > b + 40
const isGreen = ([r, g, b]) => g > 150 && g > r + 40 && g > b + 50
const isBlue = ([r, g, b]) => b > 150 && b > r + 30
const isWhite = (c) => Math.min(...c) > 244
const isColourful = (c) => Math.max(...c) - Math.min(...c) > 40
const isPopupSel = ([r, g, b]) => g > 215 && g > r + 20 && g > b + 12
const avg = (c) => (c[0] + c[1] + c[2]) / 3
const find = (s, kind, pred) => s.layout.find((it) => it.kind === kind && (typeof pred === 'string' ? it.label === pred : pred(it)))
/** 每一页的探针:[说明, layout 条目, 框内取点的偏移(点), 颜色判断] */
function probesFor(name, v, s) {
  const out = []
  const add = (what, it, dx, dy, test) => { if (!it) { out.push({ what, missing: true }); return } out.push({ what, x: it.rect.x + (typeof dx === 'function' ? dx(it.rect) : dx), y: it.rect.y + (typeof dy === 'function' ? dy(it.rect) : dy), test }) }
  const midY = (r) => r.h / 2
  if (name === 'melody') {
    const section = { featured: '精选', liked: '我喜欢的音乐' }[s.section] ?? '推荐'
    add(`sidebar ${section} is the red selected pill`, find(s, 'sidebar', section), 5, midY, isRed)
    add('sidebar 播客 is plain', find(s, 'sidebar', '播客'), 5, midY, (c) => avg(c) < 60)
    if (v.page === 'home') {
      add('card 每日推荐 cover is red', find(s, 'card', '每日推荐'), 10, 10, isRed)
      add('card 私人漫游 cover is blue', find(s, 'card', '私人漫游'), 10, 10, isBlue)
    }
    if ((s.page === 'daily' || s.page === 'liked') && !s.loading) add('button 播放全部 is red', find(s, 'button', '播放全部'), 5, midY, isRed)
    if (s.playing) add('play/pause circle is red', find(s, 'button', s.paused ? '播放' : '暂停'), 5, midY, isRed)
    if (v.hold) {
      add('selected row has the lighter row fill', find(s, 'row', (it) => it.selected), 5, midY, (c) => avg(c) > 34 && avg(c) < 90)
      add('plain odd row stays dark', find(s, 'row', (it) => !it.selected && !it.playing && it.index % 2 === 1), 5, midY, (c) => avg(c) < 32)
    }
    if (s.page === 'comments') add('hottest comment avatar', find(s, 'comment', (it) => it.section === '精彩评论' && it.rank === 1), 18, 22, (c) => avg(c) > 60)
  } else {
    add('tab 聊天 glyph is green', find(s, 'tab', '聊天'), (r) => r.w / 2, (r) => r.h / 2, isGreen)
    if (s.contact) {
      add('open chat row has the selected fill', find(s, 'contact', s.contact), (r) => r.w - 6, midY, (c) => avg(c) > 195 && avg(c) < 228)
      add('other rows keep the list colour', find(s, 'contact', (it) => it.label !== s.contact), (r) => r.w - 6, midY, (c) => avg(c) > 230 && !isWhite(c))
      const incoming = find(s, 'bubble', (it) => !it.mine && it.type === 'text')
      if (incoming) add('incoming text bubble is white', incoming, 5, midY, isWhite)
      const mine = s.layout.filter((it) => it.kind === 'bubble' && it.mine && it.type === 'text').pop()
      if (mine) add('sent bubble is green', mine, 5, midY, isGreen)
      const send = find(s, 'button', '发送(S)')
      add(send?.enabled ? 'send button is green' : 'send button is grey', send, 5, midY, send?.enabled ? isGreen : (c) => avg(c) > 222 && !isColourful(c))
    }
    if (v.popup) {
      add('popup: the highlighted first result is light green', s.popup?.rows?.[0], 8, midY, isPopupSel)
      add('popup: the second result is white', s.popup?.rows?.[1], 8, midY, isWhite)
    }
    const field = find(s, 'field', '搜索')
    add(field?.focused ? 'focused search field is white' : 'search field is grey', field, 4, midY, field?.focused ? isWhite : (c) => avg(c) > 210 && avg(c) < 236)
  }
  return out
}

const slug = (v) => v.hold ? 'selftest-hold' : [v.page, v.play && `play${v.play}`, v.sent && 'sent', v.popup && 'popup'].filter(Boolean).join('-').replace(/[^\w一-鿿-]+/g, '_')
const shots = []
const failures = []
const running = new Set()
let helperUp = false
try {
  const names = Object.keys(FIXTURES).filter((n) => !only || n === only)
  const apps = {}
  for (const name of names) {
    const t0 = Date.now()
    apps[name] = await buildFixture(name, DEFAULT_FIXTURE_DIR)
    console.log(`built ${name}: ${apps[name]} (${Date.now() - t0}ms)`)
  }
  for (const name of names) {
    const r = await selfTestFixture(apps[name], path.join(stateDir, `${name}-selftest.json`))
    console.log(`selftest ${name}: ${r.pass ? 'PASS' : 'FAIL'}${r.loadingMs ? ` (loading ${r.loadingMs.join('/')}ms)` : ''}`)
    if (!r.pass) failures.push(`${name} selftest: ${r.failures.join('; ')}`)
    if (name === 'chatter') {
      const p = await selfTestFixture(apps[name], path.join(stateDir, `${name}-popup-selftest.json`), { args: ['--popup'] })
      console.log(`selftest ${name} --popup: ${p.pass ? 'PASS' : 'FAIL'}`)
      if (!p.pass) failures.push(`${name} --popup selftest: ${p.failures.join('; ')}`)
    }
  }

  const diag = await startHelper()
  helperUp = true
  assert.ok(diag.screenRecording, 'isolated helper has no Screen Recording permission')
  for (const name of names) {
    const { w, h } = FIXTURES[name].size
    for (const v of VARIANTS[name]) {
      const label = `${name}/${slug(v)}`
      const statePath = path.join(stateDir, `${name}-${slug(v)}.json`)
      let s
      try {
        s = await launchFixture(apps[name], statePath, {
          frame: { x: 40, y: 60, w, h }, page: v.page, play: v.play, sent: v.sent, behind: true, args: [...(v.popup ? ['--popup'] : []), ...(v.hold ? ['--selftest', '--hold'] : [])],
        })
        running.add(s.pid)
        if (v.hold) s = await waitForState(statePath, (x) => x.selftest, { timeoutMs: 20_000 })
        if (v.hold) assert.ok(s.selftest.pass, `${label}: selftest failed: ${s.selftest.failures?.join('; ')}`)
        await sleep(250) // 让最后一帧落定(selftest 收尾的那几下会触发重画)
        s = await waitForState(statePath, (x) => x.ready)
        checkShape(name, s, label)
        const look = await ask('look', { windowId: s.windowNumber, maxDimension: 1600, readText: 'never', includeImage: true })
        const fp = look.window?.framePoints
        assert.ok(fp && ['x', 'y', 'w', 'h'].every((k) => Math.abs(fp[k] - s.window[k]) <= 1),
          `${label}: helper frame ${JSON.stringify(fp)} != state window ${JSON.stringify(s.window)}`)
        assert.ok(look.image?.jpegBase64, `${label}: look returned no image`)
        if (v.popup) {
          assert.ok(s.popup?.visible && s.popup?.onScreen, `${label}: the results popup should be on screen: ${JSON.stringify(s.popup)}`)
          assert.equal(look.image.overlays, 1, `${label}: the helper should draw the results popup into the main window's screenshot (image.overlays)`)
          // 叠窗那块识别出的字挂在根下当图片文字(不挂进被盖住的节点),中文读得出(OCR 语言)
          const read = await ask('look', { windowId: s.windowNumber, maxDimension: 1600, readText: 'always', includeImage: false })
          const pics = (read.outline?.children ?? []).filter((c) => c.pictureOnly).map((c) => c.title)
          assert.ok(['粉丝群', '读书会'].every((w) => pics.some((t) => t.includes(w))), `${label}: the popup's text should hang at the outline root as picture-only text: ${pics.join(' | ')}`)
          const deeper = []
          const walkText = (n, depth) => { if (!n) return; if (depth > 0 && !n.pictureOnly && JSON.stringify(n.text ?? []).includes('粉丝群')) deeper.push(n.role); for (const c of n.children ?? []) walkText(c, depth + 1) }
          walkText(read.outline, 0)
          assert.equal(deeper.length, 0, `${label}: the popup's text must not attach to the nodes it covers (${deeper.join(', ')})`)
        } else {
          assert.equal(look.image.overlays, undefined, `${label}: nothing is drawn over the window`)
        }
        // ① 无障碍树:只许有窗口和标题栏按钮
        const nodes = []
        const walk = (n) => { if (!n) return; nodes.push(n); for (const c of n.children ?? []) walk(c) }
        walk(look.outline)
        const extra = nodes.filter((n) => !['AXWindow', 'AXButton', 'AXGroup'].includes(n.role) || (n.role !== 'AXWindow' && (n.title || n.value || n.description)))
        assert.ok(nodes.length > 0 && nodes.length <= 6 && extra.length === 0,
          `${label}: accessibility tree must stay window + title-bar buttons, got ${nodes.map((n) => `${n.role}:${n.title || n.value || ''}`).join(', ')}`)
        const file = path.join(shotsDir, `${name}-${slug(v)}.jpg`)
        fs.writeFileSync(file, Buffer.from(look.image.jpegBase64, 'base64'))
        fs.writeFileSync(file.replace(/\.jpg$/, '.state.json'), JSON.stringify(s, null, 2))
        // ② layout 框 ↔ 截图像素
        const img = await decodeCapture(file)
        const scale = img.w / s.window.w
        const probes = probesFor(name, v, s)
        for (const p of probes) {
          assert.ok(!p.missing, `${label}: layout has no item for probe "${p.what}"`)
          const c = img.rgb(p.x * scale, p.y * scale)
          assert.ok(p.test(c), `${label}: probe "${p.what}" at (${p.x.toFixed(1)},${p.y.toFixed(1)}) saw rgb(${c.join(',')})`)
        }
        // SIGUSR1 = 收起窗口(模拟窗口不在当前桌面)
        if (v.page === 'home' || v.page === 'list') {
          process.kill(s.pid, 'SIGUSR1')
          await waitForState(statePath, (x) => x.visible === false && x.events.some((e) => e.kind === 'window' && e.detail === 'hidden'), { timeoutMs: 5000 })
        }
        shots.push({ label, file, image: `${look.image.width}x${look.image.height}`, items: s.layout.length, probes: probes.length })
      } catch (error) {
        failures.push(`${label}: ${error.message}`)
      } finally {
        if (s) { await quitFixture(s); running.delete(s.pid) }
      }
    }
  }
} catch (error) {
  failures.push(error.message)
} finally {
  for (const pid of running) await quitFixture(pid)
  if (helperUp) await stopHelper()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

for (const s of shots) console.log(`shot ${s.label}: ${s.file} (${s.image}, ${s.items} layout items, ${s.probes} pixel probes ok)`)
if (failures.length) {
  console.error(`FAIL\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`PASS (${shots.length} screenshots in ${shotsDir})`)
