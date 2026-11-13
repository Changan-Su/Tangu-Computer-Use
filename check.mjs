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
  n.removeChild = (c) => { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); c.parentNode = null; return c }
  n.remove = () => { if (n.parentNode) n.parentNode.removeChild(n) }
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
// 引擎那半自己摆 Desk(src/deskPresent.ts)写死的视图 id 必须与这里的插件 id/视图 id 拼得出来,改一处不改另一处就是死链
const deskSrc = readFileSync(new URL('./src/deskPresent.ts', import.meta.url), 'utf8')
A.ok(deskSrc.includes(`plugin:${T.PLUGIN_ID}:${T.VIEW_ID}`), 'src/deskPresent.ts 里的视图 id 与插件不一致')
// 画面由插件自己摆(10-17):技能里再教模型调 desk_present 会重复摆、白占提示词
const skill = readFileSync(new URL('./skills/computer-use/SKILL.md', import.meta.url), 'utf8')
A.ok(!/desk_present\(/.test(skill), 'SKILL.md 又在教模型调 desk_present —— 画面已由插件自己摆')
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

// ══ 协议 20:取色上报 / 整轮结束 / 实时画面里的光标与环(契约 §1.4、§1.6、§1.7、§3)══
const fixture = JSON.parse(readFileSync(new URL('./harness/fixtures/liveview-reply.v20.json', import.meta.url), 'utf8'))
const routes = JSON.parse(readFileSync(new URL('./harness/fixtures/routes.v1.json', import.meta.url), 'utf8'))

// ── 文案成对:只加中文忘了英文不报错,英文界面里原样冒中文 ──
{
  const zh = Object.keys(T.MSG.zh).sort()
  const en = Object.keys(T.MSG.en).sort()
  A.deepEqual(en, zh, 'zh / en 键集必须一致')
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',')
  for (const k of en) {
    A.ok(!/[㐀-鿿]/.test(T.MSG.en[k]), `英文文案里不许有汉字:${k}`)
    A.equal(ph(T.MSG.en[k]), ph(T.MSG.zh[k]), `{占位符} zh / en 必须逐字一致:${k}`)
  }
  A.equal(T.fmt('en', 'ago.sec', { n: 3 }), '3s ago')
  A.ok(T.fmt('en', 'err.unknown', { code: 'weird_code' }).includes('weird_code'), '英文里未知错误码也要原样带出')
  A.equal(T.fmt('xx', 'st.looking'), '正在查看', '不认识的语言回落中文')
}

// ── 取色规则 + 描边亮度(纯函数)──
{
  const blue = T.hexToRgb('#2c5f9e')
  const paleBlue = T.hexToRgb('#8fb4e3')
  const orange = [255, 120, 24]
  const cream = T.hexToRgb('#1c1c1c')
  A.equal(T.toHex(blue), '#2c5f9e')
  A.equal(T.hexToRgb('nope'), null)
  A.equal(T.edgeFor(blue), '#ffffff', '柔蓝(深)配白边')
  A.equal(T.edgeFor(paleBlue), '#1c1b1f', '暗色下的浅柔蓝配深边')
  A.equal(T.edgeFor([255, 255, 255]), '#1c1b1f')
  A.equal(T.edgeFor([0, 0, 0]), '#ffffff')
  A.ok(Math.abs(T.relLuminance([255, 255, 255]) - 1) < 1e-9 && T.relLuminance([0, 0, 0]) === 0)
  // 经典 / 墨色:主题色就是正文色(无彩)→ --signal(缺省柔蓝)
  A.deepEqual(T.pickFill({ hasSignalSkin: true, accent: cream, signal: blue }), { source: 'signal', rgb: blue })
  // 彩色配色 → accent 本色
  A.deepEqual(T.pickFill({ hasSignalSkin: false, accent: orange, signal: blue }), { source: 'accent', rgb: orange })
  // ⚠️彩色的**自定义**主题色:宿主照样写了 --signal-skin(= accent-ink,lovableData.ts customAccentVars)——
  // 仍要用 accent 本色,不能被 --signal-skin 拐到加深的墨色或另选的强调色上
  A.deepEqual(T.pickFill({ hasSignalSkin: true, accent: orange, signal: [150, 60, 10] }), { source: 'accent', rgb: orange })
  // 近乎无彩的自定义色(RGB 极差 < 24)→ signal
  A.deepEqual(T.pickFill({ hasSignalSkin: false, accent: cream, signal: blue }), { source: 'signal', rgb: blue })
  A.equal(T.pickFill({ hasSignalSkin: false, accent: [100, 100, 123], signal: blue }).source, 'signal', '极差 23 算无彩')
  A.equal(T.pickFill({ hasSignalSkin: false, accent: [100, 100, 124], signal: blue }).source, 'accent', '极差 24 算彩色')
  // 读不出 → null = 不发(helper 用柔蓝,不回橙色)
  A.equal(T.pickFill({ hasSignalSkin: false, accent: null, signal: null }), null)
  A.equal(T.pickFill({ hasSignalSkin: true, accent: cream, signal: null }), null, '该用 signal 却读不出、accent 又无彩 → 不发')
  A.deepEqual(T.pickFill({ hasSignalSkin: true, accent: null, signal: blue }), { source: 'signal', rgb: blue }, 'accent 读不出 → signal')
  // 发出去的体与 routes.v1.json 逐字一致
  A.deepEqual(T.styleBody({ source: 'signal', rgb: blue }, false), routes.overlayStyle.body, '/overlay-style 的体必须照 routes.v1.json')
  A.equal(T.styleBody(null, true), null)
  A.equal(T.styleBody({ source: 'accent', rgb: orange }, true).reducedMotion, true)
  A.equal(T.ENGINE_ID, 'computer-use')
  const engineManifest = JSON.parse(readFileSync(new URL('./tangu-plugins/computer-use/tangu-plugin.json', import.meta.url), 'utf8'))
  A.equal(engineManifest.id, T.ENGINE_ID, 'ctx.tangu.request 的引擎 id 必须是捆绑的引擎插件 id')
  // 主窗判定 / 减少动态(宿主口径)
  A.equal(T.isMainWindow({ documentElement: { dataset: { window: 'mini' } } }), false, 'Mini 窗不上报')
  A.equal(T.isMainWindow({ documentElement: { dataset: { window: 'main' } } }), true)
  A.equal(T.isMainWindow({ documentElement: { dataset: {} } }), true, '旧宿主不写 data-window → 当主窗')
  A.equal(T.reducedMotionIn({ documentElement: { dataset: { motionFade: 'on' } } }), true, '宿主的「只淡入淡出」算减少动态')
}

// ── 状态句 / 步数 / 补间 ──
{
  const click = (over) => ({ kind: 'click', seq: 1, label: '发送', ageMs: 100, ...over })
  A.equal(T.statusText('zh', { ended: false, lastAction: null }), '正在查看')
  A.equal(T.statusText('zh', { ended: false, lastAction: click() }), '正在点击「发送」')
  A.equal(T.statusText('zh', { ended: false, lastAction: click({ ageMs: T.DOING_MS + 1 }) }), '已点击「发送」')
  A.equal(T.statusText('zh', { ended: true, lastAction: click() }), '已结束')
  A.equal(T.statusText('en', { ended: false, lastAction: null }), 'Looking')
  A.equal(T.statusText('en', { ended: false, lastAction: click({ label: 'Send' }) }), 'Clicking “Send”')
  A.equal(T.statusText('en', { ended: false, lastAction: click({ label: 'Send', ageMs: 2000 }) }), 'Clicked “Send”')
  A.equal(T.statusText('en', { ended: true, lastAction: null }), 'Ended')
  A.equal(T.statusText('zh', { ended: false, lastAction: click({ label: undefined }) }), '正在点击', '没有控件名就不带引号')
  A.equal(T.statusText('zh', { ended: false, lastAction: click({ label: '   ' }) }), '正在点击', '全空白的名字当没有')
  A.equal(T.statusText('zh', { ended: false, lastAction: click({ kind: 'doubleClick' }) }), '正在点击「发送」', '双击按点击说')
  A.equal(T.statusText('zh', { ended: false, lastAction: click({ kind: 'setText', label: '消息' }) }), '正在向「消息」输入')
  A.equal(T.statusText('zh', { ended: false, lastAction: click({ kind: 'key' }) }), '正在按键', '纯按键没有控件名的说法')
  A.equal(T.statusText('zh', { ended: false, lastAction: click({ kind: 'teleport' }) }), '正在查看', '不认识的动作 → 正在查看')
  A.equal(T.statusText('zh', { ended: false, lastAction: click({ ageMs: T.LOOKING_AFTER_MS }) }), '正在查看', '上一个动作早过去了 → 又在看')
  A.equal(T.statusText('en', { ended: false, lastAction: fixture.lastAction }), 'Clicking “Send”', '样例回包')
  A.equal(T.stepCount(11, 17), 6)
  A.equal(T.stepCount(null, 17), null, '基数不知道 → 不编步数')
  A.equal(T.stepCount(20, 17), null)
  A.equal(T.doneText('zh', 6), '已完成 · 6 步')
  A.equal(T.doneText('en', 6), 'Done · 6 steps')
  A.equal(T.doneText('en', 1), 'Done · 1 step')
  A.equal(T.doneText('zh', null), '已完成')
  A.equal(T.doneText('en', null), 'Done')
  const a = { x: 0, y: 0 }
  const b = { x: 1, y: 0.5 }
  A.deepEqual(T.tweenPoint(a, b, 0), a)
  A.deepEqual(T.tweenPoint(a, b, 1), b)
  A.deepEqual(T.tweenPoint(a, b, 7), b, '超时也停在终点')
  const mid = T.tweenPoint(a, b, 0.5)
  A.ok(mid.x > 0.5 && mid.x < 1, `缓出:一半时间应已过半程,得到 ${mid.x}`)
  A.deepEqual(T.fracPoint({ x: 1.5, y: -2 }), { x: 1, y: 0 }, '比例夹到 0..1')
  A.equal(T.fracPoint({ x: 'a', y: 1 }), null)
  A.equal(T.fracPoint(undefined), null)
  A.deepEqual(T.fracPoint(fixture.cursor), fixture.cursor)
  A.deepEqual(T.overlayPx({ x: 0.5, y: 0.5 }, 800, 600, 0.5, 10, 20), { x: 210, y: 170 }, '光标位置 = 比例 × 画面像素 × 倍率 + 平移')
}

// ── 挂载:新回包 → 光标、环、状态句、停止;宿主状态说结束 → overlay-turn 只发一次、「已完成 · N 步」──
const findAll = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => findAll(c, pred, out)); return out }
const byClass = (n, cls) => findAll(n, (x) => typeof x.className === 'string' && x.className.split(' ').includes(cls))
const spyRings = () => {
  const made = []
  const orig = globalThis.document.createElement
  globalThis.document.createElement = (tag) => { const n = orig(tag); made.push(n); return n }
  return { rings: () => made.filter((n) => n.className === 'cu-live-ring'), restore: () => { globalThis.document.createElement = orig } }
}
{
  const RUN = fixture.runId
  const reqs = []
  const stops = []
  const subs = []
  let running = true
  const st = (live, sessionId) => (live
    ? { phase: 'tool', tool: 'act_ui', toolStage: 'exec', runId: RUN, sessionId: 's1', since: 0, textChars: 0, reasoningChars: 0 }
    : { phase: 'idle', runId: null, sessionId, since: 0, textChars: 0, reasoningChars: 0 })
  const tangu = {
    request: async (engine, path, opts) => { reqs.push({ engine, path, body: opts && opts.body }); return { ok: true } },
    stop: async (arg) => { stops.push(arg); return true },
    // 新宿主(契约 §2.3):认 { runId }
    agentStatus: (arg) => {
      if (arg && typeof arg === 'object') return st(running && arg.runId === RUN, null)
      return st(running && (arg === undefined || arg === 's1'), arg === undefined ? 's1' : arg)
    },
    subscribeAgentStatus: (cb, arg) => { const s = { cb, arg }; subs.push(s); return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1) } },
  }
  const views2 = []
  const ctx2 = { registerView: (v) => views2.push(v), getLocale: () => 'en', tangu }
  const disposeTop = new Function('ctx', src)(ctx2)
  A.equal(typeof disposeTop, 'function', 'setup 必须交回顶层的拆除函数(停用 / 重载时收观察器和订阅)')
  A.ok(subs.some((s) => s.arg === undefined), '主窗里应订阅主区会话的状态(没视图开着也要收尾)')

  let reply2 = { active: true, windowId: 4211, app: 'Chatter', ageMs: 50, jpegBase64: 'AAAA', width: 800, height: 524, frameSeq: 1,
    runId: 'run_prev', turnActive: false, actionCount: 11, lastAction: { kind: 'click', seq: 11, ageMs: 9000 } }
  globalThis.window = { tangu: { computerUseLiveView: async (o) => {
    if (o && o.image === false) { const { jpegBase64, width, height, ...rest } = reply2; return rest }
    return reply2
  } } }
  // 旧版插件在这扇窗里留下的同名样式表:升级 / 重载后必须换成新的,否则新节点全没样式
  const oldStyle = globalThis.document.getElementById('cu-live-style')
  A.ok(oldStyle, '前面的挂载应已插入样式表')
  oldStyle.textContent = '.cu-live{color:red}'
  const host2 = mkNode('div')
  const disposeView = views2[0].mount(host2)
  A.ok(globalThis.document.getElementById('cu-live-style').textContent.includes('.cu-live-cur'), '旧样式表必须被换成新版')
  const root2 = () => host2.children[0]
  root2().children[1].clientWidth = 400
  root2().children[1].clientHeight = 300
  await sleep(T.TICK_MS + 80)
  const ringSpy = spyRings()
  // 这一轮开始:样例回包,光标在 (0.2, 0.3),刚点了「Send」
  reply2 = { ...fixture, jpegBase64: 'BBBB', frameSeq: 2, actionCount: 12, cursor: { x: 0.2, y: 0.3 }, lastAction: { ...fixture.lastAction, seq: 12, ageMs: 100 } }
  await sleep(T.TICK_MS * 2 + 80)
  const cur = byClass(root2(), 'cu-live-cur')[0]
  A.ok(cur && cur.style.display === 'block', '新回包带 cursor → 画光标')
  // 800x524 塞进 400x300 → 画布 400x262、倍率 0.5;光标尖端对准 (0.2·800·0.5, 0.3·524·0.5)
  A.equal(cur.style.transform, `translate(${80 - 2}px, ${0.3 * 524 * 0.5 - 1}px)`, '光标位置必须按取景换算(垫片里没有 rAF → 直接到位)')
  A.equal(byClass(root2(), 'cu-live-status')[0].textContent, 'Clicking “Send”', '头部状态句(英文界面)')
  A.ok(ringSpy.rings().length >= 1, 'seq 变了且是点击 → 放一圈环')
  const stopBtn = byClass(root2(), 'cu-live-stop')[0]
  A.ok(stopBtn.className.includes('on'), '有 ctx.tangu.stop 且知道 runId → 露出停止')
  A.ok(subs.some((s) => s.arg && s.arg.runId === RUN), '新宿主上应对这一轮单独订阅 { runId } 状态')
  stopBtn.fire('click')
  await sleep(10)
  A.deepEqual(stops, [{ runId: RUN }], '停止必须带这一轮的 runId(绝不去停别的)')
  A.equal(stopBtn.disabled, true, '停止发出去以后先禁用,别连发')

  // 静止帧(unchanged、不带协议 20 的字段)不许把光标和状态句闪没
  {
    const keep = reply2
    reply2 = { active: true, windowId: 4211, app: 'Chatter', ageMs: 60, unchanged: true, frameSeq: 2 }
    await sleep(T.TICK_MS + 80)
    A.equal(byClass(root2(), 'cu-live-status')[0].textContent, 'Clicking “Send”', 'unchanged 回包没带字段时保留状态句')
    A.equal(byClass(root2(), 'cu-live-cur')[0].style.display, 'block', 'unchanged 回包没带字段时保留光标')
    reply2 = keep
  }

  // 双击 → 两圈
  const before2 = ringSpy.rings().length
  reply2 = { ...reply2, frameSeq: 3, actionCount: 17, lastAction: { kind: 'doubleClick', seq: 17, ageMs: 50, x: 0.5, y: 0.5 } }
  await sleep(T.TICK_MS + 80 + 150 + 60)
  A.equal(ringSpy.rings().length - before2, 2, '双击放两圈')
  ringSpy.restore()

  // 宿主状态说这一轮结束 → overlay-turn 发一次,带 runId
  running = false
  subs.filter((s) => s.arg && s.arg.runId === RUN).forEach((s) => s.cb(st(false, null)))
  await sleep(T.TICK_MS + 80)
  const turns = () => reqs.filter((r) => r.path === '/overlay-turn')
  A.equal(turns().length, 1, '这一轮结束只发一次 /overlay-turn')
  A.equal(turns()[0].engine, 'computer-use')
  A.deepEqual(turns()[0].body, routes.overlayTurn.body, '/overlay-turn 的体必须照 routes.v1.json(phase:end + runId)')
  A.equal(byClass(root2(), 'cu-live-status')[0].textContent, 'Ended')
  A.equal(byClass(root2(), 'cu-live-badge')[0].textContent, 'Done · 6 steps', '步数 = 结束时计数 − 这一轮之前看到的计数(17 − 11)')
  A.ok(byClass(root2(), 'cu-live-veil')[0].className.includes('on'), '结束后最后一帧盖一层底色')
  A.ok(!stopBtn.className.includes('on'), '结束后收起停止')
  subs.forEach((s) => s.cb(st(false, null)))
  await sleep(T.TICK_MS * 2 + 80)
  A.equal(turns().length, 1, '同一个 runId 绝不重发')

  // 旧回包(没有协议 20 的字段)→ 叠层全收,头部照旧,不报错
  reply2 = { active: true, windowId: 4211, app: 'Chatter', ageMs: 50, jpegBase64: 'CCCC', width: 800, height: 524, frameSeq: 4 }
  await sleep(T.TICK_MS + 80)
  A.equal(byClass(root2(), 'cu-live-status')[0].textContent, '', '旧回包:没有状态句')
  A.equal(byClass(root2(), 'cu-live-cur')[0].style.display, 'none', '旧回包:不画光标')
  A.ok(!byClass(root2(), 'cu-live-badge')[0].className.includes('on'), '旧回包:没有结束态')
  disposeView()
  disposeTop()
  A.equal(subs.length, 0, '停用后顶层的状态订阅必须全部退掉')
}

// ── 旧宿主:agentStatus 不认 { runId },把它当会话 id、回一个 idle —— 绝不能据此判「结束」──
{
  const reqs = []
  let mainRun = null // 主区会话正在跑哪一轮
  const tangu = {
    request: async (engine, path, opts) => { reqs.push({ path, body: opts && opts.body }); return { ok: true } },
    agentStatus: (sid) => {
      // 照旧宿主的 agentStatusOf:参数原样当 sessionId 回来
      if (sid && typeof sid === 'object') return { phase: 'idle', runId: null, sessionId: sid, since: 0, textChars: 0, reasoningChars: 0 }
      const id = sid === undefined ? 's9' : sid
      return id === 's9' && mainRun
        ? { phase: 'tool', tool: 'act_ui', runId: mainRun, sessionId: 's9', since: 0, textChars: 0, reasoningChars: 0 }
        : { phase: 'idle', runId: null, sessionId: id, since: 0, textChars: 0, reasoningChars: 0 }
    },
    subscribeAgentStatus: () => () => {},
  }
  const views3 = []
  const disposeTop = new Function('ctx', src)({ registerView: (v) => views3.push(v), tangu })
  // 这一轮不在主区会话里(主区没在跑它):状态拿不到 → 只能交给 helper
  let reply3 = { ...fixture, runId: 'run_side', actionCount: 5, turnActive: true }
  globalThis.window = { tangu: { computerUseLiveView: async () => reply3 } }
  const host3 = mkNode('div')
  const disposeView = views3[0].mount(host3)
  await sleep(T.TICK_MS * 3 + 80)
  A.equal(reqs.filter((r) => r.path === '/overlay-turn').length, 0, '旧宿主回的 idle 不能当成「这一轮结束了」')
  A.ok(!byClass(host3.children[0], 'cu-live-badge')[0].className.includes('on'), '旧宿主上 helper 还说在进行 → 不许标已完成')
  reply3 = { ...reply3, turnActive: false }
  await sleep(T.TICK_MS + 80)
  A.ok(byClass(host3.children[0], 'cu-live-badge')[0].className.includes('on'), 'helper 说这一轮结束了(状态通道没表态)→ 标已完成')
  A.equal(reqs.filter((r) => r.path === '/overlay-turn').length, 0, 'helper 自己结束的不用再发 end')
  // 主区会话里跑的那一轮:按会话 id 盯着,不跑了就发 end(一次)
  mainRun = 'run_main'
  reply3 = { ...fixture, runId: 'run_main', actionCount: 9, turnActive: true }
  await sleep(T.TICK_MS + 80)
  A.equal(reqs.filter((r) => r.path === '/overlay-turn').length, 0, '还在跑')
  mainRun = null
  await sleep(T.TICK_MS * 2 + 80)
  const ends = reqs.filter((r) => r.path === '/overlay-turn')
  A.equal(ends.length, 1, '旧宿主:按会话 id 看到它不跑了 → 发一次 end')
  A.deepEqual(ends[0].body, { phase: 'end', runId: 'run_main' })
  disposeView()
  disposeTop()
}

// ══ 过程行的句子(ctx.registerToolLabel,契约 §2.4 / §3 卡 8)══
{
  // ① 认领的名单 == 引擎半身真正注册的工具(src/tools.ts 的 SPECS);新加一个工具忘了认领,这里红
  const toolsSrc = readFileSync(new URL('./src/tools.ts', import.meta.url), 'utf8')
  const specs = toolsSrc.slice(toolsSrc.indexOf('const SPECS'), toolsSrc.indexOf('];', toolsSrc.indexOf('const SPECS')))
  const specNames = [...specs.matchAll(/^\s+name: '([a-z_]+)'/gm)].map((m) => m[1]).sort()
  A.ok(specNames.length >= 13, `SPECS 里应读出全部工具名(读到 ${specNames.length} 个)`)
  A.deepEqual([...T.CU_TOOLS].sort(), specNames, 'registerToolLabel 认领的工具必须正好是 src/tools.ts 的 SPECS')

  // ② 格式金丝雀:句子靠的是 vendor 的结果文字。vendor 升级改了这些模板,这里先红,而不是句子悄悄降级
  const bridge = readFileSync(new URL('./src/vendor/bridge.ts', import.meta.url), 'utf8')
  const outline = readFileSync(new URL('./src/vendor/outline.ts', import.meta.url), 'utf8')
  const viewTs = readFileSync(new URL('./src/vendor/view.ts', import.meta.url), 'utf8')
  const jevRun = readFileSync(new URL('./src/jevRun.ts', import.meta.url), 'utf8')
  for (const [file, text, frag] of [
    ['bridge.ts', bridge, '`Attempted ${executedActions.length} UI action${executedActions.length === 1 ? "" : "s"} in ${target.appName} — ${target.windowTitle}.`'],
    ['bridge.ts', bridge, 'Returned state ${capture.capture.stateId}.'],
    ['bridge.ts', bridge, '`Stopped UI action sequence${execution.stoppedAt !== undefined ? ` at action ${execution.stoppedAt + 1}` : ""}'],
    ['bridge.ts', bridge, '`Observed ${mode} ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}.'],
    ['bridge.ts', bridge, 'Outline (${folded.nodeCount} nodes, stateId ${result.capture.stateId}'],
    ['bridge.ts', bridge, 'Changes (${transition!.changedNodeCount}, ${base!.stateId} → ${result.capture.stateId}):'],
    ['bridge.ts', bridge, '`- ${window.windowRef} ${window.kind} ${window.app} pid ${window.pid} — '],
    ['bridge.ts', bridge, '"No roots matched the supplied filters."'],
    ['bridge.ts', bridge, '`${match.ref} ${match.role || "Unknown"} ${JSON.stringify(match.label || "(unlabeled)")}'],
    ['outline.ts', outline, '`${"  ".repeat(depth)}${node.ref} ${displayName(node)}'],
    ['outline.ts', outline, '${label ? ` ${JSON.stringify(label)}` : ""}'],
    ['view.ts', viewTs, '`+ ${change.ref}${change.parent ? ` under ${change.parent}` : ""} ${JSON.stringify(label(change.node))}`'],
    ['jevRun.ts', jevRun, 'requestedSteps: params.steps.length'],
    ['jevRun.ts', jevRun, "report(abort.aborted ? 'cancelled' : 'stopped'"],
  ]) A.ok(text.includes(frag), `vendor 结果文字的模板变了(${file}):${frag.slice(0, 60)}… —— 同步改 main.js 的解析与 harness/fixtures/tool-calls.json`)

  // ③ 表驱动:样例调用(结果照真实模板写)× 进行中 / 完成 / 出错 × zh / en
  const { calls } = JSON.parse(readFileSync(new URL('./harness/fixtures/tool-calls.json', import.meta.url), 'utf8'))
  const byId = Object.fromEntries(calls.map((c, i) => [c.id, i]))
  const icons = new Map([['Chatter', 'com.example.chatter']])
  const run = (id, phase, locale, iconOf = (a) => icons.get(a)) => {
    const i = byId[id]
    const c = calls[i]
    const earlier = calls.slice(0, i).map(({ tool, args, result }) => ({ tool, args, result }))
    return T.describeCall({ tool: c.tool, args: c.args, result: phase === 'error' ? c.errorResult : phase === 'running' ? undefined : c.result, phase, locale, earlier }, iconOf)
  }
  const R = 'running'
  const D = 'done'
  const E = 'error'
  const table = [
    // [样例, phase, zh, en]
    ['find', R, '正在查找 Chatter 的窗口', 'Finding Chatter windows'],
    ['find', D, '已找到 Chatter 的窗口', 'Found Chatter windows'],
    ['find', E, '没能找到 Chatter 的窗口', "Couldn't find Chatter windows"],
    ['findNone', D, '没有找到 Calculator 的窗口', 'Found no Calculator windows'],
    ['observe', R, '正在查看 Chatter', 'Looking at Chatter'],
    ['observe', D, '已查看 Chatter', 'Looked at Chatter'],
    ['observe', E, '没能查看 Chatter', "Couldn't look at Chatter"],
    ['observeFront', R, '正在查看屏幕', 'Looking at the screen'],
    ['observeFront', D, '已查看微信', 'Looked at 微信'],
    ['clickRow', R, '正在 Chatter 中点击「Zhang San」', 'Clicking “Zhang San” in Chatter'],
    ['clickRow', D, '已在 Chatter 中点击「Zhang San」', 'Clicked “Zhang San” in Chatter'],
    ['setText', R, '正在 Chatter 中输入「See you tomorrow」', 'Typing “See you tomorrow” in Chatter'],
    ['setText', D, '已在 Chatter 中输入「See you tomorrow」', 'Typed “See you tomorrow” in Chatter'],
    // 控件名在差量结果里没有:沿 s3 → s2 → s1 找回 observe 的大纲
    ['pressSend', R, '正在 Chatter 中点击「Send」', 'Clicking “Send” in Chatter'],
    ['pressSend', D, '已在 Chatter 中点击「Send」', 'Clicked “Send” in Chatter'],
    ['pressSend', E, '没能在 Chatter 中点击「Send」', "Couldn't click “Send” in Chatter"],
    // 批量:进行中说第一步;做完说最后一步并带步数(步数取结果里的 Attempted N)
    ['batch', R, '正在 Chatter 中点击「Message」', 'Clicking “Message” in Chatter'],
    ['batch', D, '已在 Chatter 中按下 Return(共 3 步)', 'Pressed Return in Chatter (3 steps)'],
    ['batch', E, '没能在 Chatter 中完成这些操作', "Couldn't finish the actions in Chatter"],
    // 中途停下:结果是正常返回(phase done),但不许说「已…」;卡住的那步没有名字(只有角色)→ 不带引号
    ['stopped', R, '正在 Chatter 中点击「Send」', 'Clicking “Send” in Chatter'],
    ['stopped', D, '没能在 Chatter 中点击(第 2 步,共 2 步)', "Couldn't click in Chatter (step 2 of 2)"],
    ['search', R, '正在 Chatter 中查找「Send」', 'Searching for “Send” in Chatter'],
    ['inspect', D, '已在 Chatter 中查看「Send」', 'Looked at “Send” in Chatter'],
    ['expand', R, '正在 Chatter 中查看界面元素', 'Looking at an element in Chatter'],
    ['scroll', D, '已在 Chatter 中滚动「Conversation」', 'Scrolled “Conversation” in Chatter'],
    ['keys', D, '已在 Chatter 中按下 Cmd+A', 'Pressed Cmd+A in Chatter'],
    ['rightClickXY', R, '正在 Chatter 中右键点击', 'Right-clicking in Chatter'],
    ['doubleClick', D, '已在 Chatter 中双击「Zhang San」', 'Double-clicked “Zhang San” in Chatter'],
    ['drag', R, '正在 Chatter 中拖动', 'Dragging in Chatter'],
    ['move', D, '已在 Chatter 中移动指针', 'Moved the pointer in Chatter'],
    ['clear', D, '已在 Chatter 中清空「Message」', 'Cleared “Message” in Chatter'],
    ['waitFor', R, '正在 Chatter 中等待「Delivered」', 'Waiting for “Delivered” in Chatter'],
    ['waitFor', D, '已在 Chatter 中等到「Delivered」', 'Waited for “Delivered” in Chatter'],
    ['waitGone', R, '正在 Chatter 中等待「See you tomorrow」消失', 'Waiting for “See you tomorrow” to disappear in Chatter'],
    ['readText', D, '已在 Chatter 中读取「See you tomorrow」', 'Read “See you tomorrow” in Chatter'],
    ['readMore', R, '正在读取后续输出', 'Reading more of the output'],
    ['jev', R, '正在 Chatter 中点击「Zhang San」', 'Clicking “Zhang San” in Chatter'],
    ['jev', D, '已在 Chatter 中点击「Send」(共 3 步)', 'Clicked “Send” in Chatter (3 steps)'],
    ['jevStopped', D, '没能在 Chatter 中点击「Pinned files」(第 2 步,共 2 步)', "Couldn't click “Pinned files” in Chatter (step 2 of 2)"],
    ['ensure', R, '正在打开 Notes', 'Opening Notes'],
    ['ensure', D, '已打开 Notes', 'Opened Notes'],
    ['ensure', E, '没能打开 Notes', "Couldn't open Notes"],
    ['wechatSend', D, '已在微信中点击「发送」', 'Clicked “发送” in 微信'],
    ['launch', R, '正在打开 example.com', 'Opening example.com'],
    ['navigate', D, '已打开 forum.example.org', 'Opened forum.example.org'],
    ['evaluate', R, '正在读取网页内容', 'Reading the page'],
  ]
  const covered = new Set()
  for (const [id, phase, zh, en] of table) {
    A.ok(id in byId, `样例里没有 ${id}`)
    covered.add(calls[byId[id]].tool)
    for (const [locale, want] of [['zh', zh], ['en', en]]) {
      const got = run(id, phase, locale)
      A.ok(got && typeof got.text === 'string', `${id} / ${phase} / ${locale} 应给出句子`)
      A.equal(got.text, want, `${id} / ${phase} / ${locale}`)
      if (locale === 'en') A.ok(!/[㐀-鿿]/.test(got.text.replace(/[“”][^“”]*[“”]|微信/g, '')), `英文句子的骨架里不许有汉字:${got.text}`)
    }
  }
  A.deepEqual([...covered].sort(), [...T.CU_TOOLS].sort(), '表驱动断言必须覆盖每一种工具')
  // 图标:只在学到过「App 名 → bundleId」时给;ensure_app 直接用参数里的 bundleId
  A.deepEqual(run('pressSend', D, 'zh').icon, { appBundleId: 'com.example.chatter' })
  A.equal(run('wechatSend', D, 'zh').icon, undefined, '没学到过的 App 不给图标')
  A.deepEqual(run('ensure', D, 'en', () => undefined).icon, { appBundleId: 'com.apple.Notes' })
  A.equal(run('pressSend', D, 'zh', () => 'not a bundle id!').icon, undefined, '不像 bundleId 的不给')

  // ④ 降级顺序:有 App 没控件名 →「正在 Chatter 中点击」;两样都没有 →「正在点击」;认不出动作 → 空
  const one = (tool, args, earlier = [], phase = R, locale = 'zh', result) => T.describeCall({ tool, args, result, phase, locale, earlier }, () => undefined)
  const press14 = { stateId: 'x1', actions: [{ action: 'press', ref: '@e14' }] }
  A.equal(one('act_ui', press14).text, '正在点击', '跨消息(更早的调用不在 earlier 里)→ 不带 App 也不带名字')
  A.equal(one('act_ui', press14, [], R, 'en').text, 'Clicking')
  A.equal(one('act_ui', press14, [], D, 'zh', 'Attempted 1 UI action in Chatter — Main. Returned state x2.').text, '已在 Chatter 中点击', '做完了能从自己的结果拿到 App 名')
  A.equal(one('act_ui', press14, [], D, 'en', 'Attempted 1 UI action in Chatter — Main. Returned state x2.').text, 'Clicked in Chatter')
  const searchOnly = [{ tool: 'search_ui', args: { stateId: 'x1', text: 'Send' }, result: '@e14 AXButton "Send" [exact]\n  path: AXWindow ▸ AXButton "Send"' }]
  A.equal(one('act_ui', press14, searchOnly).text, '正在点击「Send」', '只有同一个 state 的搜索结果:有名字、没有 App')
  A.equal(one('act_ui', press14, searchOnly, R, 'en').text, 'Clicking “Send”')
  // ⚠️别的 state 里同号的 @e 不算:号会重发,错名比没名更糟
  const otherState = [{ tool: 'observe_ui', args: {}, result: 'Observed fused Chatter — Main. Returned the latest outline state.\n\nOutline (2 nodes, stateId x9):\n@e1 AXWindow "Main"\n  @e14 AXButton "Delete" {press}' }]
  A.equal(one('act_ui', press14, otherState).text, '正在点击', '控件名只认拥有这个 stateId 的结果')
  A.equal(one('act_ui', { stateId: 'x9', actions: [{ action: 'press', ref: '@e14' }] }, otherState).text, '正在 Chatter 中点击「Delete」')
  A.equal(one('act_ui', { stateId: 'x9', actions: [{ action: 'press', ref: '@e1' }] }, otherState).text, '正在 Chatter 中点击「Main」', '@e1 不能匹配到 @e14 那行')
  A.equal(one('act_ui', { stateId: 'x1', actions: [{ action: 'teleport' }] }), null, '认不出的动作 → 空,让宿主照旧显示')
  A.equal(one('act_ui', { stateId: 'x1', actions: [] }), null)
  A.equal(one('act_ui', '{not json'), null, '参数不是 JSON → 空')
  A.equal(one('act_ui', JSON.stringify(press14)).text, '正在点击', '参数是 JSON 字符串时照样解析')
  A.equal(one('navigate_browser', { stateId: 'b1' }), null, '没有网址 → 空')
  A.equal(one('ensure_app', {}), null, '没有 App → 空')
  A.equal(one('some_other_tool', { x: 1 }), null, '不是本插件的工具 → 空')
  // 输入的文字截到 24 字加省略号(按码点,不拆 emoji)
  const long = one('act_ui', { stateId: 'x1', actions: [{ action: 'typeText', text: '明天见,记得带上那份已经打印好的合同和两把伞,还有充电器' }] })
  A.equal(long.text, '正在输入「明天见,记得带上那份已经打印好的合同和两把伞,还…」')
  A.equal(Array.from('明天见,记得带上那份已经打印好的合同和两把伞,还').length, 24)
  A.equal(Array.from(T.tlClip('😀'.repeat(30))).length, 25, '按码点截:24 个 + 省略号')
  A.equal(T.tlClip('  a \n\t b  '), 'a b', '收空白')
  A.equal(T.keysText(['cmd', 'shift', 'z']), 'Cmd+Shift+Z')
  A.equal(T.keysText(['cmd+a', 'delete']), 'Cmd+A, Delete')
  A.equal(T.keysText(['return']), 'Return')
  A.equal(T.joinZh(['已在', 'QQ', '音乐', '中']), '已在 QQ 音乐中')
  // 绝不抛错:坏输入一律当没有
  const junk = [null, undefined, 3, 'x', {}, { tool: 'act_ui' }, { tool: 'act_ui', args: null, earlier: 'nope' },
    { tool: 'act_ui', args: { stateId: 5, actions: [null, 7, { action: 'press', ref: 9 }] }, result: 42, phase: 'done', earlier: [null, 1, { tool: 'observe_ui', result: {} }] },
    { tool: 'jev_ui', args: { root: {}, steps: 'x' }, phase: 'done' }, { tool: 'jev_ui', args: { steps: [{ action: 'click' }] }, result: '{"status":"stopped","steps":"?"}', phase: 'done' },
    { tool: 'find_roots', args: { app: 7 }, phase: 'done', result: null }, { tool: 'wait_for', args: { ref: '@e1', stateId: '(' }, phase: 'running', earlier: [{ result: 'stateId (' }] }]
  for (const c of junk) { let r; A.doesNotThrow(() => { r = T.describeCall(c, () => undefined) }, `坏输入不许抛:${JSON.stringify(c)}`); A.ok(r === null || (r && typeof r.text === 'string' && r.text)) }

  // ⑤ 注册:新宿主上认领全部工具,describe 包着 try —— 宿主传来的东西再怪也只回 undefined
  const contributions = []
  const ctxL = { registerView() {}, registerToolLabel: (def) => contributions.push(def) }
  const disposeL = new Function('ctx', src)(ctxL)
  A.equal(contributions.length, 1, '应登记一份 registerToolLabel')
  A.deepEqual([...contributions[0].tool].sort(), [...T.CU_TOOLS].sort())
  const T2 = globalThis.__CU_LIVE_TEST__
  T2.learnBundle('Chatter', 'com.example.chatter')
  const viaHost = contributions[0].describe({ tool: 'observe_ui', args: { root: '@r1' }, phase: 'running', locale: 'en', earlier: [{ tool: 'find_roots', args: {}, result: calls[0].result }] })
  A.deepEqual(viaHost, { text: 'Looking at Chatter', icon: { appBundleId: 'com.example.chatter' } }, '经宿主调用:图标来自实时画面学到的对应')
  const evil = { get tool() { throw new Error('boom') } }
  A.equal(contributions[0].describe(evil), undefined, 'describe 里抛错 → undefined(宿主照旧显示)')
  A.equal(contributions[0].describe({ tool: 'act_ui', args: { actions: [{ action: '??' }] }, phase: 'running', locale: 'zh', earlier: [] }), undefined)
  // 旧宿主:registerToolLabel 抛错也不能把插件弄坏
  A.doesNotThrow(() => new Function('ctx', src)({ registerView() {}, registerToolLabel() { throw new Error('old host') } }))
  if (typeof disposeL === 'function') disposeL()
}

// ══ 悬浮小画面(契约 §2.5,卡 7 的 C)══
{
  A.equal(T.pipStageHeight(800, 524, 264), 173, '264 宽、800×524 的窗口 ≈ 173')
  A.equal(T.pipStageHeight(1080, 1920, 264), 300, '竖长的窗口夹到 300,不把小窗撑到半屏')
  A.equal(T.pipStageHeight(2560, 600, 264), 96, '极宽的夹到 96')
  A.equal(T.pipStageHeight(0, 0, 264), T.PIP_STAGE_DEFAULT, '量不到尺寸 → 缺省 173')
  const pipCalls = []
  let pipIsOpen = false
  const bridge = {
    open: async () => { pipCalls.push('open'); pipIsOpen = true; return true },
    close: async () => { pipCalls.push('close'); pipIsOpen = false },
    isOpen: async () => pipIsOpen,
  }
  const frame = { active: true, windowId: 4211, app: 'Chatter', bundleId: 'com.example.chatter', ageMs: 50, jpegBase64: 'AAAA', width: 800, height: 524, frameSeq: 1 }
  const viewsP = []
  const ctxP = { registerView: (v) => viewsP.push(v), getLocale: () => 'zh' }
  const disposeP = new Function('ctx', src)(ctxP)
  const btnOf = (host, cls) => byClass(host, cls)[0]
  // 主区 / Desk:有桥 → 头部有「移到悬浮窗」;点了调 open(),开着时同一个按钮变「放回去」
  globalThis.window = { tangu: { computerUseLiveView: async () => frame, computerUsePip: bridge } }
  const hostM = mkNode('div')
  const disposeM = viewsP[0].mount(hostM, { surface: 'main' })
  await sleep(20)
  const pipBtn = btnOf(hostM, 'cu-live-pip')
  A.ok(pipBtn, '有 computerUsePip 桥 → 头部有「移到悬浮窗」')
  A.ok(pipBtn.textContent.includes('移到悬浮窗') && pipBtn.attrs['aria-label'] === '移到悬浮窗')
  A.equal(btnOf(hostM, 'cu-live-back'), undefined, '不在悬浮窗里就没有「放回去」那颗')
  pipBtn.fire('click')
  await sleep(20)
  A.deepEqual(pipCalls, ['open'], '点「移到悬浮窗」→ open()')
  A.ok(pipBtn.textContent.includes('放回去'), '悬浮窗开着 → 同一个按钮变「放回去」')
  pipBtn.fire('click')
  await sleep(20)
  A.deepEqual(pipCalls, ['open', 'close'], '再点一下 → close()')
  A.ok(pipBtn.textContent.includes('移到悬浮窗'))
  disposeM()
  // 网页 / 手机:没有这个桥 → 不画入口
  globalThis.window = { tangu: { computerUseLiveView: async () => frame } }
  const hostW = mkNode('div')
  const disposeW = viewsP[0].mount(hostW)
  await sleep(20)
  A.equal(btnOf(hostW, 'cu-live-pip'), undefined, '没有 computerUsePip → 不画「移到悬浮窗」')
  disposeW()
  // 悬浮窗里:紧凑卡 —— 画面在上、一行说明在下,有「放回去」,没有「移到悬浮窗」,舞台高度按比例写死
  globalThis.window = { tangu: { computerUseLiveView: async () => frame, computerUsePip: bridge } }
  pipCalls.length = 0
  const hostP = mkNode('div')
  const disposePip = viewsP[0].mount(hostP, { surface: 'pip' })
  const rootP = hostP.children[0]
  A.ok(rootP.className.split(' ').includes('is-pip'), 'surface pip → 紧凑卡')
  A.equal(rootP.children[0].className, 'cu-live-stage', '悬浮窗里画面在上')
  A.ok(rootP.children[1].className.startsWith('cu-live-head'), '说明一行在下')
  A.equal(rootP.children[0].style.height, '173px', '还没有画面时舞台先占 173')
  rootP.children[0].clientWidth = 264
  await sleep(T.TICK_MS + 40)
  A.equal(rootP.children[0].style.height, '173px', '264 宽 × 800×524 → 173')
  A.equal(btnOf(hostP, 'cu-live-pip'), undefined, '悬浮窗里不再给「移到悬浮窗」')
  const back = btnOf(hostP, 'cu-live-back')
  A.ok(back && back.textContent === '放回去')
  back.fire('click')
  await sleep(10)
  A.deepEqual(pipCalls, ['close'], '「放回去」→ close()')
  // 悬浮窗里不缩放:滚轮不被吃掉
  let prevented = false
  const vp = byClass(hostP, 'cu-live-viewport')[0]
  vp.fire('wheel', { deltaY: -100, preventDefault() { prevented = true } })
  A.equal(prevented, false, '悬浮窗里滚轮不缩放、不拦')
  disposePip()
  // 悬浮窗里没有桥(理论上不会):「放回去」退回视图自己的 close
  globalThis.window = { tangu: { computerUseLiveView: async () => frame } }
  let closedByView = 0
  const hostQ = mkNode('div')
  const disposeQ = viewsP[0].mount(hostQ, { surface: 'pip', close: () => { closedByView++ } })
  btnOf(hostQ, 'cu-live-back').fire('click')
  A.equal(closedByView, 1)
  disposeQ()
  if (typeof disposeP === 'function') disposeP()
}

console.log('✅ computer-use 插件自检通过')
process.exit(0)
