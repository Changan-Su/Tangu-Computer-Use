/**
 * 桌面侧插件自检:用宿主同款 `new Function('ctx', src)` 求值 main.js,断言贡献点齐全,
 * 并在 DOM 垫片上跑一轮真实挂载 —— 重点验三件**错了不会报错、只会静默烧 CPU 或骗人**的事:
 *   ① 卸载必须停掉轮询(视图关了还在每秒截屏 = 白烧,而且用户看不见)
 *   ② 看不见时(document.hidden / 滚出可视区)不发请求
 *   ③ 没在操控 / 拿不到画面时,绝不留着上一帧假装实时
 * 跑法:node check.mjs
 */
import { readFileSync } from 'node:fs'
import { strict as A } from 'node:assert'

// ── 极简 DOM 垫片(只实现 main.js 真正用到的那点) ──
/**
 * 画布(.cu-live-viewport)的尺寸。实现自己用 layoutViewport 把宽高写进 style,所以垫片
 * 照读即可 —— 不必复刻任何布局规则,量到的就是实现算出来的那个数。
 * (⚠️曾经想让 CSS `aspect-ratio` 干这件事,真浏览器里不成立,见 main.js 里那段注释。)
 */
const viewportBoxOfNode = (n) => ({
  w: parseFloat(n.style.width) || 0,
  h: parseFloat(n.style.height) || 0,
})
const mkNode = (tag) => {
  const style = { setProperty(k, v) { style[k] = String(v) }, removeProperty(k) { delete style[k] } }
  const n = {
    tag, children: [], attrs: {}, parentNode: null, style, dataset: {},
    className: '', id: '', src: '', alt: '', title: '',
  }
  let own = ''
  Object.defineProperty(n, 'textContent', {
    get: () => own + n.children.map((c) => c.textContent || '').join(''),
    set: (x) => { n.children.forEach((c) => { c.parentNode = null }); n.children.length = 0; own = String(x) },
  })
  n.appendChild = (c) => { n.children.push(c); c.parentNode = n; return c }
  n.append = (...cs) => cs.forEach((c) => n.appendChild(c))
  n.replaceChildren = (...cs) => { n.children.forEach((c) => { c.parentNode = null }); n.children.length = 0; own = ''; cs.forEach((c) => n.appendChild(c)) }
  n.setAttribute = (k, v) => { n.attrs[k] = v }
  n.querySelector = () => null
  n.listeners = {}
  n.addEventListener = (t, fn) => { (n.listeners[t] ||= []).push(fn) }
  n.removeEventListener = (t, fn) => { n.listeners[t] = (n.listeners[t] || []).filter((f) => f !== fn) }
  n.fire = (t, ev = {}) => (n.listeners[t] || []).slice().forEach((f) => f({ preventDefault() {}, ...ev }))
  // 真几何:垫片里 clientWidth/Height 恒 0 的话,缩放那一整套代码在自检里等于裸奔(codex 指出)。
  // 画布是个例外 —— 它的尺寸不是谁设进来的,而是由自己的宽高比 + 舞台算出来的(同 CSS)。
  let ownW = 0
  let ownH = 0
  const isViewport = () => n.className.includes('cu-live-viewport')
  Object.defineProperty(n, 'clientWidth', {
    get: () => (isViewport() ? viewportBoxOfNode(n).w : ownW),
    set: (v) => { ownW = v },
  })
  Object.defineProperty(n, 'clientHeight', {
    get: () => (isViewport() ? viewportBoxOfNode(n).h : ownH),
    set: (v) => { ownH = v },
  })
  n.getBoundingClientRect = () => ({ left: 0, top: 0, width: n.clientWidth, height: n.clientHeight })
  n.captured = []
  n.setPointerCapture = (id) => { n.captured.push(id) }
  n.releasePointerCapture = (id) => { n.captured = n.captured.filter((x) => x !== id) }
  return n
}
const head = mkNode('head')
globalThis.document = {
  hidden: false,
  head,
  createElement: mkNode,
  createTextNode: (t) => { const n = mkNode('#text'); n.textContent = t; return n },
  getElementById: (id) => (head.children.find((c) => c.id === id) || null),
}
let observed = null
globalThis.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; observed = this }
  observe(el) { this.el = el }
  disconnect() { this.disconnected = true }
  fire(isIntersecting) { this.cb([{ isIntersecting }]) }
}
// 必须有:没有它,`resizeObserver.disconnect()` 漏掉的回归自检根本发现不了(codex 指出)。
let resized = null
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; resized = this }
  observe(el) { this.el = el }
  disconnect() { this.disconnected = true }
  fire() { this.cb([{}]) }
}

// ── 求值 main.js(宿主同款) ──
const src = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
const views = []
const ctx = { registerView: (v) => views.push(v) }
new Function('ctx', src)(ctx)

A.equal(views.length, 1, '应只注册一个视图')
A.equal(views[0].id, 'live', '视图 id 必须是 live —— 技能里写死了 plugin:tangu-computer-use:live')
A.equal(typeof views[0].mount, 'function', 'mount 必须是函数')

const T = globalThis.__CU_LIVE_TEST__
A.ok(T, 'main.js 必须暴露 __CU_LIVE_TEST__ 供自检')
// 技能 SKILL.md 里写死的视图 id 必须与插件 id/视图 id 拼得出来,改一处不改另一处就是死链
const skill = readFileSync(new URL('./skills/computer-use/SKILL.md', import.meta.url), 'utf8')
A.ok(skill.includes(`plugin:${T.PLUGIN_ID}:${T.VIEW_ID}`), 'SKILL.md 里的 desk_present 视图 id 与插件不一致')
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
A.equal(manifest.id, T.PLUGIN_ID, 'manifest.id 必须与 main.js 里的 PLUGIN_ID 一致(视图 id 由它拼)')
A.equal(manifest.main, 'main.js')

// ── 纯函数 ──
A.equal(T.ago(0), '刚刚')
A.equal(T.ago(3000), '3 秒前')
A.equal(T.ago(120000), '2 分钟前')
A.equal(T.describe({ app: 'TextEdit', title: '未命名' }), 'TextEdit — 未命名')
A.equal(T.describe({ app: 'TextEdit' }), 'TextEdit')
A.equal(T.describe({ windowId: 7 }), '窗口 #7')
A.equal(T.explain(''), '', '无错误码 → 空串')
A.ok(T.explain('helper_not_running').includes('还没有窗口'))
A.ok(T.explain('screen_recording_denied').includes('屏幕录制'))
A.ok(T.explain('some_new_code').includes('some_new_code'), '未知错误码必须原样带出,不许吞掉线索')
A.ok(T.explain('client_timeout').includes('超时'), '客户端超时与 helper 截图超时是两码事,都要有说法')

// ── 缩放几何(纯函数)──
// 默认比例 = 整幅塞进舞台
A.equal(T.fitScaleOf(1000, 500, 400, 400), 0.4, '宽受限时按宽算')
A.equal(T.fitScaleOf(500, 1000, 400, 400), 0.4, '高受限时按高算')
A.equal(T.fitScaleOf(0, 0, 400, 400), 1, '尺寸未知时不乱缩')
A.equal(T.fitScaleOf(1000, 500, 0, 0), 1, '舞台还没布局时不乱缩')

// 画布按窗口比例变形:宽窗口 → 画布变矮,高窗口 → 画布变窄。窗口比舞台小也**放大填满**
// (这是取景框不是原尺寸预览),所以两个方向上都必然有一边贴满舞台 —— 那正是"没有留白"。
{
  const wide = T.viewportBoxOf(1600, 500, 400, 300)
  A.ok(Math.abs(wide.w - 400) < 1e-6 && Math.abs(wide.h - 125) < 1e-6, `宽窗口画布应变矮,得到 ${JSON.stringify(wide)}`)
  const tall = T.viewportBoxOf(500, 1600, 400, 300)
  A.ok(Math.abs(tall.h - 300) < 1e-6 && Math.abs(tall.w - 93.75) < 1e-6, `高窗口画布应变窄,得到 ${JSON.stringify(tall)}`)
  const box = T.viewportBoxOf(800, 600, 400, 300)
  A.ok(Math.abs(box.w / box.h - 800 / 600) < 1e-9, '画布宽高比必须等于窗口宽高比')
  A.ok(Math.abs(box.w - 400) < 1e-6 || Math.abs(box.h - 300) < 1e-6, '画布必须有一边贴满舞台,否则就是白留了空间')
}

// ⚠️实时画面的节奏线:helper 已是常驻取景流,这里再回到 1fps 就又变回用户实报的"掉帧幻灯片"。
A.ok(T.TICK_MS <= 200, `实时画面轮询必须 ≤200ms(现在 ${T.TICK_MS}ms)—— 慢过这个就不是 screen sharing 了`)

// 平移夹紧:图比舞台大 → 不许把边拖进舞台里面(拖出空白就再也找不回图了)
A.equal(T.clampOffset(500, 2000, 400), 0, '右边界:最多贴住左沿')
A.equal(T.clampOffset(-5000, 2000, 400), -1600, '左边界:最多贴住右沿')
A.equal(T.clampOffset(-100, 2000, 400), -100, '范围内原样保留')
// 图比舞台小 → 一律居中
A.equal(T.clampOffset(999, 200, 400), 100, '图比舞台小时强制居中')

// 以光标为锚缩放:锚点下的那个像素必须不动
{
  const anchor = 300
  const off0 = -100
  const s0 = 1
  const s1 = 2
  const off1 = T.anchoredOffset(off0, anchor, s0, s1)
  // 锚点在图片自身坐标系里的位置,缩放前后应一致
  A.ok(Math.abs((anchor - off0) / s0 - (anchor - off1) / s1) < 1e-9, '缩放后锚点像素发生了漂移')
}

// 倍率夹紧:下限是"整幅可见",上限 MAX_SCALE
A.equal(T.clampScale(0.01, 0.4), 0.4, '不许缩到比默认比例还小(只会徒增空白)')
A.equal(T.clampScale(999, 0.4), T.MAX_SCALE, '上限封顶')
A.equal(T.clampScale(2, 0.4), 2, '范围内原样保留')

// ── 挂载行为 ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const calls = []
let reply = { active: false }
// 假 API 必须**照实现主进程的语义**:image:false 就是不给图。
// (第一版偷懒无视这个参数,于是"没要图时保留画面"那条断言压根没被执行到 —— 没牙的断言比没有更坏。)
globalThis.window = {
  tangu: {
    computerUseLiveView: async (o) => {
      calls.push(o)
      if (o && o.image === false) { const { jpegBase64, width, height, ...rest } = reply; return rest }
      return reply
    },
  },
}

const host = mkNode('div')
const dispose = views[0].mount(host)
const rootOf = () => host.children[0]
const stageOf = () => rootOf().children[1]
const imgsIn = (n) => { const o = []; ;(function w(x) { if (x.tag === 'img') o.push(x); (x.children || []).forEach(w) })(n); return o }
const msgsIn = (n) => { const o = []; ;(function w(x) { if (x.className === 'cu-live-msg') o.push(x); (x.children || []).forEach(w) })(n); return o }
// 给舞台真尺寸,否则缩放几何在自检里全走"量不到→按 1"的退化分支
stageOf().clientWidth = 400
stageOf().clientHeight = 300

// ⚠️可见性**未知**必须按可见处理 —— 这是「永久静默」那个 bug 的回归线:
// 隐藏页面里浏览器根本不做交集计算,IntersectionObserver 连首次回调都不来,
// 初值若当成「不可见」就永远翻不了身(实测 ioHits=0,一帧都不请求)。
await sleep(30)
A.ok(calls.length >= 1, 'IO 还没表态时必须按可见处理并正常轮询(否则永久静默)')
A.ok(rootOf().textContent.includes('暂无正在被操控的窗口'), '没在操控时应给出说明')

// 有画面 → 显示 img,且头部换成窗口名。**必须带真尺寸**:没有尺寸就走不到缩放几何。
reply = { active: true, windowId: 3, app: 'Safari', title: '标签页', ageMs: 500, jpegBase64: 'AAAA', width: 800, height: 600 }
await sleep(T.IDLE_TICK_MS + 60)
A.equal(imgsIn(rootOf()).length, 1, '有画面时舞台上应只有一个 img')
A.equal(imgsIn(rootOf())[0].src, 'data:image/jpeg;base64,AAAA')
A.equal(msgsIn(stageOf()).length, 0, '有画面时舞台上不许还留着说明文案(图与文案互斥)')
A.ok(rootOf().textContent.includes('Safari'), '头部应显示 App 名')
// 舞台 400x300、画面 800x600(同为 4:3)→ 画布铺满舞台,默认比例 = 400/800 = 50%
const pctNow = () => { let t = null; ;(function w(n) { if (n.className === 'cu-live-pct') t = n.textContent; (n.children || []).forEach(w) })(rootOf()); return t }
A.equal(pctNow(), '50%', '默认比例应按真实几何算出(800x600 塞进 400x300 = 50%)')
// ⚠️"没有适配窗口 size"的回归线:画布的宽高比必须每帧跟着被操控窗口写进去。
const viewportOf = () => { let v = null; ;(function w(n) { if (n.className.includes('cu-live-viewport')) v = n; (n.children || []).forEach(w) })(rootOf()); return v }
A.equal(`${viewportOf().style.width}x${viewportOf().style.height}`, '400px x300px'.replace(' ', ''), '画布必须按这一帧的窗口比例变形(800x600 → 铺满 400x300)')

// ⚠️静止窗口:helper 回 unchanged(不含图)时必须**保留**现有画面,而不是当成"拿不到画面"。
// 同时必须真的把上次的 frameSeq 带回去,否则 helper 永远认不出"没变",每秒重编 8 次 JPEG。
{
  reply = { active: true, windowId: 3, app: 'Safari', ageMs: 300, jpegBase64: 'SEQ1', width: 800, height: 600, frameSeq: '42' }
  await sleep(T.TICK_MS + 120)
  A.equal(imgsIn(rootOf()).length, 1, '先要有一帧画面')
  await sleep(T.TICK_MS + 120)
  A.equal(calls[calls.length - 1].sinceFrame, '42', '必须把上次的 frameSeq 带回去,否则省不掉重编')
  reply = { active: true, windowId: 3, app: 'Safari', ageMs: 400, unchanged: true }
  await sleep(T.TICK_MS + 120)
  A.equal(imgsIn(rootOf()).length, 1, 'unchanged 时必须保留现有画面,不许换成"拿不到画面"')
}

// 转为「拿不到画面」→ 必须把旧图撤下,不能留着上一帧假装实时
reply = { active: true, windowId: 3, app: 'Safari', error: 'screen_recording_denied' }
await sleep(T.TICK_MS + 80)
A.equal(imgsIn(rootOf()).length, 0, '拿不到画面时必须撤下旧图(不许留着上一帧冒充实时)')
A.ok(rootOf().textContent.includes('屏幕录制'), '应说明是权限问题')

// 滚出可视区 → **降频**(不是停),且主动不要图(省掉真正贵的那一步:一次真实截屏)
reply = { active: true, windowId: 3, app: 'Safari', ageMs: 10, jpegBase64: 'BBBB', width: 800, height: 600 }
await sleep(T.TICK_MS + 80)               // 先在可见态拿到一帧真画面
observed.fire(false)
const before = calls.length
await sleep(T.HIDDEN_TICK_MS + 200)
A.ok(calls.length > before, '看不见也必须继续问状态 —— 只降频,绝不完全停(永久静默的教训)')
A.equal(calls[calls.length - 1].image, false, '看不见时不该要图')
// 而且不许因为"这一帧没图"把已经在显示的画面撤成错误文案
const imgs3 = []
;(function walk(n) { if (n.tag === 'img') imgs3.push(n); (n.children || []).forEach(walk) })(rootOf())
A.equal(imgs3.length, 1, '我们主动没要图时,应保留正在显示的那一帧,而不是换成"拿不到画面"')
observed.fire(true)
await sleep(120)
A.ok(calls[calls.length - 1].image !== false, '重新可见后应立刻恢复要图')

// ── 缩放/取景的行为(几何在垫片里是真的了,这些才有意义)──
const scaleNow = () => { let t = null; ;(function w(n) { if (n.tag === 'img') t = n.style.transform; (n.children || []).forEach(w) })(rootOf()); return t }
reply = { active: true, windowId: 3, app: 'Safari', ageMs: 10, jpegBase64: 'CCCC', width: 800, height: 600 }
observed.fire(true)
await sleep(T.TICK_MS + 120)
const fitTf = scaleNow()
// 放大一档(点 + 按钮)
let btnIn = null
;(function w(n) { if (n.tag === 'button' && n.textContent === '+') btnIn = n; (n.children || []).forEach(w) })(rootOf())
btnIn.fire('click')
const zoomedTf = scaleNow()
A.notEqual(zoomedTf, fitTf, '点 + 应该真的改变缩放')

// ⚠️用户放大着,新帧到来不许把取景弹回默认
await sleep(T.TICK_MS + 120)
A.equal(scaleNow(), zoomedTf, '常规新帧不得重置用户的取景')

// ⚠️用户一放大,我们就主动要更高清的原图(maxDimension 800→1600)→ 同一个窗口回来的像素翻倍。
// scale 是「相对原始像素」的倍率,像素翻倍而 scale 不动,画面就凭空放大一倍、锚点跟着跳。
// 判据只能是「用户看到的宽度」不变,不能是 scale 不变。
const visualWidthOf = (nat) => { const m = /scale\(([\d.]+)\)/.exec(scaleNow()); return nat * Number(m[1]) }
{
  const before = visualWidthOf(800)
  reply = { ...reply, jpegBase64: 'CCCC2', width: 1600, height: 1200 }
  await sleep(T.TICK_MS + 120)
  const after = visualWidthOf(1600)
  A.ok(Math.abs(after - before) < 0.01, `换高清源不得改变看到的大小:${before} → ${after}`)
}

// ⚠️用户放大着,目标窗口改了尺寸 → 守住倍率,但平移必须夹回新边界(不能让画面滑出舞台)
reply = { ...reply, jpegBase64: 'DDDD', width: 300, height: 200 }
await sleep(T.TICK_MS + 120)
{
  const vp = viewportOf()
  const ar = parseFloat(vp.style.width) / parseFloat(vp.style.height)
  A.ok(Math.abs(ar - 300 / 200) < 1e-6, `窗口改了尺寸,画布比例必须跟着改,实得 ${vp.style.width}x${vp.style.height}`)
}
{
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(scaleNow())
  A.ok(m, '变形应可解析')
  const [, ox, oy, sc] = m.map(Number)
  // 边界是**画布**的,不是舞台的 —— 画布已经按 300x200 变形过了
  const { w: sw, h: sh } = T.viewportBoxOf(300, 200, 400, 300)
  const w = 300 * sc, h = 200 * sc
  const okX = w <= sw ? Math.abs(ox - (sw - w) / 2) < 0.5 : ox <= 0.001 && ox >= sw - w - 0.001
  const okY = h <= sh ? Math.abs(oy - (sh - h) / 2) < 0.5 : oy <= 0.001 && oy >= sh - h - 0.001
  A.ok(okX && okY, `窗口改尺寸后平移必须夹回边界,现在是 ${scaleNow()}`)
}

// ⚠️换了窗口(哪怕尺寸恰好相同)必须复位,不能套用上一个窗口的取景
reply = { active: true, windowId: 99, app: 'Notes', ageMs: 10, jpegBase64: 'EEEE', width: 300, height: 200 }
await sleep(T.TICK_MS + 120)
A.equal(scaleNow(), defaultTfFor(300, 200), '换窗口必须回到默认比例(哪怕尺寸与上一个窗口相同)')
/** 用与实现同一条规则算期望值,别手推 —— 画布先按比例变形,再在画布里贴合。 */
function defaultTfFor(w, h) {
  const { w: vw, h: vh } = T.viewportBoxOf(w, h, 400, 300)
  const s = T.fitScaleOf(w, h, vw, vh)
  const off = (box, scaled) => (scaled <= box ? (box - scaled) / 2 : Math.min(0, Math.max(box - scaled, (box - scaled) / 2)))
  return `translate(${off(vw, w * s)}px, ${off(vh, h * s)}px) scale(${s})`
}

// 卸载 → 停轮询 + 断开两个 observer + 清空宿主
dispose()
A.ok(resized.disconnected, '卸载后必须断开 ResizeObserver')
const afterDispose = calls.length
await sleep(T.TICK_MS + T.IDLE_TICK_MS + 120)
A.equal(calls.length, afterDispose, '卸载后必须停止轮询')
A.ok(observed.disconnected, '卸载后必须断开 IntersectionObserver')
A.equal(host.children.length, 0, '卸载后必须清空宿主元素')

// ── 跨实例单飞:每帧都是一次真实截屏(helper 最长 8s),两个实例同时在场不能各截各的 ──
{
  let release
  const hang = new Promise((r) => { release = r })
  let hits = 0
  globalThis.window = { tangu: { computerUseLiveView: async () => { hits++; await hang; return { active: false } } } }
  const a = mkNode('div')
  const b = mkNode('div')
  const da = views[0].mount(a)
  const oa = observed
  const db = views[0].mount(b)
  const ob = observed
  oa.fire(true)
  ob.fire(true)
  await sleep(30)
  A.equal(hits, 1, '两个实例同时取景只应发一次请求(共享单飞)')
  release({ active: false })
  await sleep(10)
  da(); db()
}

// ⚠️落地时只许清**自己**那一份单飞槽:另一个桶的请求可能已经把槽换成它的了,
// 无条件清会让那个还在飞的请求失去保护 —— 下一个实例立刻又发一次真实取景(codex 指出)。
{
  const gates = []
  const seen = []
  globalThis.window = { tangu: { computerUseLiveView: (o) => { seen.push(o.image); return new Promise((r) => gates.push(() => r({ active: false }))) } } }
  const a = T.fetchFrame(globalThis.window.tangu.computerUseLiveView, { image: false })
  const b = T.fetchFrame(globalThis.window.tangu.computerUseLiveView, { maxDimension: 800 })
  A.equal(seen.length, 2, '两个桶各应发一次')
  gates[0]()                       // 先落地的是**另一个桶**的 a
  await a
  const c = T.fetchFrame(globalThis.window.tangu.computerUseLiveView, { maxDimension: 800 })
  A.equal(seen.length, 2, 'a 落地不得清掉 b 的单飞槽,否则 c 会再发一次真实取景')
  A.equal(c, b, 'c 应复用还在飞的 b')
  gates[1]()
  await Promise.all([b, c])
}

// ⚠️单飞不许跨"要不要图"复用:慢速实例先发的 {image:false} 被要图的实例捡走,
// 那边看到没有 jpegBase64 就会误判成"拿不到画面" —— 我们没要 ≠ 拿不到。
{
  const seen = []
  let release
  const hang = new Promise((r) => { release = r })
  globalThis.window = { tangu: { computerUseLiveView: async (o) => { seen.push(o.image); await hang; return { active: false } } } }
  const p1 = T.fetchFrame(globalThis.window.tangu.computerUseLiveView, { image: false })
  const p2 = T.fetchFrame(globalThis.window.tangu.computerUseLiveView, { maxDimension: 1280 })
  A.notEqual(p1, p2, '要图与不要图的请求不得共用同一个 Promise')
  A.deepEqual(seen, [false, undefined], '两种请求都应真的发出去')
  release()
  await Promise.all([p1, p2])
}

console.log('✅ computer-use 插件自检通过')
process.exit(0)
