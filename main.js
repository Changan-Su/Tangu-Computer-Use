/**
 * Computer Use —— Forsion 桌面插件(裸 setup(ctx) 体,宿主 new Function('ctx', code) 装载)。
 *
 * 只做一件事:注册 `plugin:tangu-computer-use:live` 视图 —— 显示 agent 正在操控的那个窗口的画面。
 * agent 在 Agent Desk 上摆它(desk_present {type:'view'}),就成了"演出面板里的实况转播";
 * 用户也能在命令面板里单独打开看。
 *
 * 画面从哪来:主进程 `window.tangu.computerUseLiveView()` → CU 原生 helper 的 liveView 命令
 * (ScreenCaptureKit 后台截目标窗口,不抢焦点)。三条纪律照抄主进程那层:
 *   1. **只读**:helper 没跑就如实说"没在操控",绝不因为打开了视图去把辅助 App 拉起来。
 *   2. **不伪造**:拿不到画面就摆错误说明(最常见是没给录屏权限),不留一张旧图假装实时。
 *   3. **看不见就不拉**:页面隐藏 / 视图滚出可视区就停轮询 —— 每帧都是一次真实截屏,不能白烧。
 *
 * 配色一律吃宿主 token(--bg-card/--text/--border/--accent/--on-accent…),绝不写死颜色:
 * LCL 的 --accent 在 cream 暗色是纸白,写死白字必然压成 1.02:1 全瞎(青鸟踩过)。
 */
const PLUGIN_ID = 'tangu-computer-use'
const VIEW_ID = 'live'

/**
 * 轮询间隔(毫秒)≈ 8fps。
 * helper 那边已经是**常驻 ScreenCaptureKit 取景流**(live_stream.swift),取一帧只是从缓存里拿最新
 * 那张 + JPEG 编码,不再是"每帧重新协商一次采集会话"。所以这里可以按屏幕共享的节奏拉。
 * ⚠️别再调回 1000:1fps 是幻灯片,用户实报"不是 share screen 的实时画面,是掉帧的"。
 */
const TICK_MS = 120
/** 没在操控时放慢:纯问一句状态(不带图),便宜。 */
const IDLE_TICK_MS = 2500
/**
 * 看不见时的间隔。**是"降频"不是"停"**。
 * ⚠️曾经写成"不可见就一帧都不请求",结果:隐藏页面里浏览器不给做交集计算,
 * IntersectionObserver 连首次回调都不来 → 可见性永远停在初值「不可见」→ 视图**永久静默**。
 * 而 computer use 恰恰会把被操控的 App 拉到前台、让 Forsion 失去前台 ——
 * 越是需要看画面的时候越不刷新。宁可慢,不可死。
 */
const HIDDEN_TICK_MS = 6000

// ── 文案(zh / en 成对)────────────────────────────────────────────────────────
// 有 ctx.i18n.define(2026-10-26+)就交给宿主;旧宿主按 ctx.getLocale() 查自带的这张表,缺省中文。
// ⚠️加一条就两边都加:check.mjs 钉着键集一致、英文里没有汉字、{占位符} 两边逐字一致。
const MSG = {
  zh: {
    'err.unsupported_platform': '实时画面目前只有 macOS 支持(Windows 的 helper 是子进程,桌面端够不着)。',
    'err.helper_not_running': '还没有窗口正在被操控。让 agent 用 computer use 的工具动一下,画面就会出现。',
    'err.unsupported_helper': '本机的 Computer Use helper 还是旧版,不认识实时画面(边缘光效同样不会出现——两者在同一个二进制里)。让 agent 用一次 computer use 的工具,它会自动把 helper 更新到随包的版本;更新后 macOS 可能要求重新授权「辅助功能」与「屏幕录制」。',
    'err.capture_timeout': '截取窗口画面超时了,下一帧会重试。',
    'err.client_timeout': '等本机 helper 回画面超时了,下一帧会重试。',
    'err.capture_failed': '截不到这个窗口的画面 —— 多半是没给「屏幕录制」权限(系统设置 → 隐私与安全性)。',
    'err.screen_recording_denied': '没有「屏幕录制」权限,拿不到窗口画面(系统设置 → 隐私与安全性 → 屏幕录制)。',
    'err.encode_failed': '窗口画面编码失败,下一帧会重试。',
    'err.unknown': '实时画面暂时不可用({code})。',
    'ago.now': '刚刚',
    'ago.sec': '{n} 秒前',
    'ago.min': '{n} 分钟前',
    'win.numbered': '窗口 #{id}',
    'win.unknown': '未知窗口',
    'view.title': '被操控的窗口',
    'zoom.out': '缩小',
    'zoom.reset': '恢复默认比例(整幅可见)',
    'zoom.in': '放大',
    'img.alt': '正在被操控的窗口画面',
    'msg.needDesktop': '需要 Forsion 桌面端',
    'msg.needDesktopDetail': '实时画面要通过桌面主进程访问 Computer Use 的本机 helper。',
    'msg.none': '暂无正在被操控的窗口',
    'msg.noneDetail': '让 agent 用 computer use 的工具动一下,画面就会出现。',
    'msg.noFrame': '拿不到这一帧画面',
    'st.looking': '正在查看',
    'st.ended': '已结束',
    'st.click.doing': '正在点击「{label}」',
    'st.click.done': '已点击「{label}」',
    'st.click.doing.bare': '正在点击',
    'st.click.done.bare': '已点击',
    'st.rightClick.doing': '正在右键点击「{label}」',
    'st.rightClick.done': '已右键点击「{label}」',
    'st.rightClick.doing.bare': '正在右键点击',
    'st.rightClick.done.bare': '已右键点击',
    'st.type.doing': '正在向「{label}」输入',
    'st.type.done': '已向「{label}」输入',
    'st.type.doing.bare': '正在输入',
    'st.type.done.bare': '已输入',
    'st.scroll.doing': '正在滚动「{label}」',
    'st.scroll.done': '已滚动「{label}」',
    'st.scroll.doing.bare': '正在滚动',
    'st.scroll.done.bare': '已滚动',
    'st.drag.doing': '正在拖动「{label}」',
    'st.drag.done': '已拖动「{label}」',
    'st.drag.doing.bare': '正在拖动',
    'st.drag.done.bare': '已拖动',
    'st.key.doing.bare': '正在按键',
    'st.key.done.bare': '已按键',
    'st.move.doing.bare': '正在移动指针',
    'st.move.done.bare': '已移动指针',
    'done.steps': '已完成 · {n} 步',
    'done.step1': '已完成 · 1 步',
    'done.bare': '已完成',
    'btn.stop': '停止',
    'btn.stopTip': '停止这一轮',
  },
  en: {
    'err.unsupported_platform': "The live view is macOS only for now (on Windows the helper is a child process the desktop app can't reach).",
    'err.helper_not_running': 'No window is being controlled yet. The picture appears once the agent uses a computer use tool.',
    'err.unsupported_helper': "The Computer Use helper on this Mac is an older version without the live view (the edge glow won't appear either, as both live in the same binary). Have the agent use a computer use tool once and it updates the helper to the bundled version; macOS may then ask you to allow Accessibility and Screen Recording again.",
    'err.capture_timeout': 'Capturing the window timed out. The next frame will retry.',
    'err.client_timeout': 'Waiting for the local helper timed out. The next frame will retry.',
    'err.capture_failed': "Couldn't capture this window. Most likely Screen Recording isn't allowed (System Settings → Privacy & Security).",
    'err.screen_recording_denied': "Screen Recording isn't allowed, so the window can't be captured (System Settings → Privacy & Security → Screen Recording).",
    'err.encode_failed': 'Encoding the window picture failed. The next frame will retry.',
    'err.unknown': 'The live view is unavailable for now ({code}).',
    'ago.now': 'just now',
    'ago.sec': '{n}s ago',
    'ago.min': '{n} min ago',
    'win.numbered': 'Window #{id}',
    'win.unknown': 'Unknown window',
    'view.title': 'Controlled window',
    'zoom.out': 'Zoom out',
    'zoom.reset': 'Reset zoom (fit the whole window)',
    'zoom.in': 'Zoom in',
    'img.alt': 'Live picture of the controlled window',
    'msg.needDesktop': 'Requires Forsion desktop',
    'msg.needDesktopDetail': 'The live view reaches the local Computer Use helper through the desktop app.',
    'msg.none': 'No window is being controlled',
    'msg.noneDetail': 'The picture appears once the agent uses a computer use tool.',
    'msg.noFrame': "Couldn't get this frame",
    'st.looking': 'Looking',
    'st.ended': 'Ended',
    'st.click.doing': 'Clicking “{label}”',
    'st.click.done': 'Clicked “{label}”',
    'st.click.doing.bare': 'Clicking',
    'st.click.done.bare': 'Clicked',
    'st.rightClick.doing': 'Right-clicking “{label}”',
    'st.rightClick.done': 'Right-clicked “{label}”',
    'st.rightClick.doing.bare': 'Right-clicking',
    'st.rightClick.done.bare': 'Right-clicked',
    'st.type.doing': 'Typing in “{label}”',
    'st.type.done': 'Typed in “{label}”',
    'st.type.doing.bare': 'Typing',
    'st.type.done.bare': 'Typed',
    'st.scroll.doing': 'Scrolling “{label}”',
    'st.scroll.done': 'Scrolled “{label}”',
    'st.scroll.doing.bare': 'Scrolling',
    'st.scroll.done.bare': 'Scrolled',
    'st.drag.doing': 'Dragging “{label}”',
    'st.drag.done': 'Dragged “{label}”',
    'st.drag.doing.bare': 'Dragging',
    'st.drag.done.bare': 'Dragged',
    'st.key.doing.bare': 'Pressing keys',
    'st.key.done.bare': 'Pressed keys',
    'st.move.doing.bare': 'Moving the pointer',
    'st.move.done.bare': 'Moved the pointer',
    'done.steps': 'Done · {n} steps',
    'done.step1': 'Done · 1 step',
    'done.bare': 'Done',
    'btn.stop': 'Stop',
    'btn.stopTip': 'Stop this run',
  },
}

/** 纯函数版:指定语言取一条,{占位符} 代入。缺的键回落中文,再回落键名本身。 */
function fmt(locale, key, vars) {
  const table = MSG[locale] || MSG.zh
  const raw = table[key] ?? MSG.zh[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])))
}
const currentLocale = () => {
  try { return (ctx.getLocale ? ctx.getLocale() : 'zh') === 'en' ? 'en' : 'zh' } catch { return 'zh' }
}
/** 界面里用的 t():宿主的 i18n 优先(它跟着切语言),否则按 getLocale 查自带的表。 */
let tr = (key, vars) => fmt(currentLocale(), key, vars)
try {
  if (ctx.i18n && typeof ctx.i18n.define === 'function') {
    const hostT = ctx.i18n.define(MSG)
    if (typeof hostT === 'function') tr = hostT
  }
} catch { /* 宿主的 i18n 坏了就用自带的表 */ }

/** 错误码 → 人话。未知码原样带出去,别吞掉线索。 */
function explain(code) {
  if (!code) return ''
  return MSG.zh[`err.${code}`] ? tr(`err.${code}`) : tr('err.unknown', { code })
}

// ── 取色:Agent 光标 / 点击环跟 Forsion 当前窗口正在显示的主题色 ────────────────────────
// 规则(契约 §3,与宿主 base.css / skins.css 对齐):
//   根上有 --signal-skin(经典 / 墨色这种单色配色、近乎无彩的自定义色才有)→ 用 --signal(缺省柔蓝,设置里另选了强调色就是选的);
//   否则用 --accent 本色。兜底:--accent 的 RGB 极差 < 24 也当无彩,改用 --signal。读不到 → 不发(helper 用柔蓝)。
// ⚠️颜色一律**读像素**,不解析 getPropertyValue 的字符串:值可能是 color-mix() / oklch() / 嵌套 var()。
const ENGINE_ID = 'computer-use'
const FALLBACK_FILL = '#2c5f9e'
const ACHROMATIC_RANGE = 24
const STYLE_DEBOUNCE_MS = 250

const chroma = (rgb) => Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])
const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''))
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null
}
/** WCAG 相对亮度(sRGB 线性化)。 */
function relLuminance(rgb) {
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}
/** 描边色(契约 §1.1):填色相对亮度 < 0.28 用白,否则用深色。 */
const edgeFor = (rgb) => (relLuminance(rgb) < 0.28 ? '#ffffff' : '#1c1b1f')

/** 取色规则本身(纯函数)。accent / signal 是读回的 [r,g,b] 或 null。返回 { source, rgb } 或 null(= 不发)。 */
function pickFill({ hasSignalSkin, accent, signal }) {
  const accentUsable = Boolean(accent) && chroma(accent) >= ACHROMATIC_RANGE
  if ((hasSignalSkin || !accentUsable) && signal) return { source: 'signal', rgb: signal }
  if (accentUsable) return { source: 'accent', rgb: accent }
  return null
}
/** 发给引擎 /overlay-style 的体(routes.v1.json 的形状)。pick 为空 → null,不发。 */
function styleBody(pick, reducedMotion) {
  if (!pick) return null
  return { fill: toHex(pick.rgb), edge: edgeFor(pick.rgb), reducedMotion: Boolean(reducedMotion) }
}

/** 宿主口径的「减少动态」(同 lcl/engine/spring.ts 的 reducedMotion):设置里的只淡入淡出,或系统设置。 */
function reducedMotionIn(doc) {
  try {
    const root = doc && doc.documentElement
    if (root && root.dataset && root.dataset.motionFade === 'on') return true
    const w = (doc && doc.defaultView) || globalThis
    return Boolean(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch { return false }
}

/** 一个 CSS 颜色表达式(如 'var(--accent)')在这份文档里**实际画出来**是什么颜色 → [r,g,b];读不出 → null。 */
const probeCanvas = new WeakMap()
function readRgb(doc, cssValue) {
  try {
    const w = doc.defaultView || globalThis
    if (typeof w.getComputedStyle !== 'function') return null
    const probe = doc.createElement('span')
    probe.style.cssText = 'position:fixed;left:-99px;top:0;width:1px;height:1px;pointer-events:none;visibility:hidden'
    probe.style.backgroundColor = cssValue
    ;(doc.body || doc.documentElement).appendChild(probe)
    const resolved = w.getComputedStyle(probe).backgroundColor
    probe.remove()
    if (!resolved) return null
    let g = probeCanvas.get(doc)
    if (!g) {
      const c = doc.createElement('canvas')
      c.width = 1
      c.height = 1
      g = c.getContext && c.getContext('2d', { willReadFrequently: true })
      if (!g) return null
      probeCanvas.set(doc, g)
    }
    // 哨兵:canvas 不认的颜色串会被静默忽略、fillStyle 保持旧值 —— 那样读回的就是哨兵,不是主题色。
    const SENTINEL = '#010203'
    g.fillStyle = SENTINEL
    g.fillStyle = resolved
    if (String(g.fillStyle).toLowerCase() === SENTINEL) return null
    g.clearRect(0, 0, 1, 1)
    g.fillRect(0, 0, 1, 1)
    const d = g.getImageData(0, 0, 1, 1).data
    if (d[3] !== 255) return null // 半透明 / 透明(变量没定义时 background-color 落成 transparent)
    return [d[0], d[1], d[2]]
  } catch { return null }
}

/** 当前窗口的取色结果:{ pick, reducedMotion };文档不可用 → null。 */
function readTheme(doc) {
  const root = doc && doc.documentElement
  const w = (doc && doc.defaultView) || globalThis
  if (!root || typeof w.getComputedStyle !== 'function') return null
  let hasSignalSkin = false
  // 只判**有没有**,不解析它的值。
  try { hasSignalSkin = w.getComputedStyle(root).getPropertyValue('--signal-skin').trim() !== '' } catch { /* 当没有 */ }
  const pick = pickFill({ hasSignalSkin, accent: readRgb(doc, 'var(--accent)'), signal: readRgb(doc, 'var(--signal)') })
  return { pick, reducedMotion: reducedMotionIn(doc) }
}

/**
 * 盯「主题色可能变了」的一切:<html> 的 class / style / data-*(主题、明暗、Space 外观、减少动态都落在这里),
 * 以及系统明暗与减少动态的媒体查询。防抖后回调。返回拆除函数(观察器、监听、定时器一起收)。
 */
function watchTheme(doc, cb, delay = STYLE_DEBOUNCE_MS) {
  const w = (doc && doc.defaultView) || globalThis
  const root = doc && doc.documentElement
  const offs = []
  let timer = null
  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; try { cb() } catch { /* 回调自己兜 */ } }, delay)
  }
  if (root && typeof w.MutationObserver === 'function') {
    const mo = new w.MutationObserver(fire)
    mo.observe(root, { attributes: true })
    offs.push(() => mo.disconnect())
  }
  if (typeof w.matchMedia === 'function') {
    for (const q of ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)']) {
      try {
        const mq = w.matchMedia(q)
        if (mq && mq.addEventListener) { mq.addEventListener('change', fire); offs.push(() => mq.removeEventListener('change', fire)) }
      } catch { /* 不支持就不听 */ }
    }
  }
  return () => {
    if (timer) clearTimeout(timer)
    timer = null
    offs.forEach((f) => f())
    offs.length = 0
  }
}

/** 主窗才上报 / 收尾(插件 setup 在每扇窗都跑,不拦的话 Mini 会和主窗抢着写)。旧宿主不写 data-window → 当主窗。 */
function isMainWindow(doc) {
  const root = doc && doc.documentElement
  const kind = root && root.dataset ? root.dataset.window : undefined
  return !kind || kind === 'main'
}

// ── 状态句 / 步数 / 补间(纯函数,check.mjs 钉着)──────────────────────────────────────
const KIND_GROUP = {
  click: 'click', doubleClick: 'click', press: 'click', rightClick: 'rightClick',
  type: 'type', setText: 'type', scroll: 'scroll', drag: 'drag', key: 'key', move: 'move',
}
const CLICK_KINDS = new Set(['click', 'doubleClick', 'rightClick', 'press'])
/** 动作发生后多久内算「正在」,之后算「已」。 */
const DOING_MS = 900
/** 上一个动作过去这么久了,还没有新动作 → 它多半又在看画面:回到「正在查看」。 */
const LOOKING_AFTER_MS = 4000

/**
 * 头部那句状态。input = { ended, lastAction }(lastAction 照回包,ageMs 是 helper 回包时刻量的)。
 * 「正在查看」→「正在点击「发送」」→「已点击「发送」」→「已结束」。读不懂的动作种类按「正在查看」。
 */
function statusText(locale, input) {
  if (input.ended) return fmt(locale, 'st.ended')
  const a = input.lastAction
  const group = a && KIND_GROUP[a.kind]
  if (!group) return fmt(locale, 'st.looking')
  const age = Number(a.ageMs)
  const ageKnown = Number.isFinite(age) && age >= 0
  if (ageKnown && age >= LOOKING_AFTER_MS) return fmt(locale, 'st.looking')
  const phase = ageKnown && age >= DOING_MS ? 'done' : 'doing'
  const label = typeof a.label === 'string' ? a.label.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  const withLabel = `st.${group}.${phase}`
  if (label && MSG.zh[withLabel]) return fmt(locale, withLabel, { label })
  return fmt(locale, `${withLabel}.bare`)
}

/** 这一轮做了几步:结束时的 actionCount − 这一轮开始前的 actionCount。基数不知道 → null(宁可不写数,也不编一个)。 */
function stepCount(base, count) {
  if (!Number.isFinite(base) || !Number.isFinite(count) || count < base) return null
  return count - base
}
function doneText(locale, steps) {
  if (steps === null || steps === undefined || !Number.isFinite(steps)) return fmt(locale, 'done.bare')
  if (steps === 1) return fmt(locale, 'done.step1')
  return fmt(locale, 'done.steps', { n: steps })
}

/** 回包里的 0..1 比例点;坏值 → null(不画)。 */
function fracPoint(p) {
  if (!p || typeof p !== 'object') return null
  const x = Number(p.x)
  const y = Number(p.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
}
const easeOut = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3
/** 两帧之间补间:t ∈ 0..1(已含缓动前的原始进度)。 */
function tweenPoint(from, to, t) {
  const k = easeOut(t)
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }
}
/** 画布坐标:比例点 × 画面像素 × 当前倍率 + 平移。光标本身不随倍率缩放,只有位置跟着走。 */
function overlayPx(frac, natW, natH, scale, offX, offY) {
  return { x: offX + frac.x * natW * scale, y: offY + frac.y * natH * scale }
}

// ── 整轮(插件顶层,所有视图共用一份)────────────────────────────────────────────────
// 每个 runId 一条记录:基数(这一轮开始前的 actionCount)、最新计数、helper 说的进行中、宿主状态说的结束。
// 「结束」只认**看到过它在跑**的那条状态通道:旧宿主不认 { runId } 参数,会把它当会话 id、回一个 idle ——
// 那和「已结束」长得一模一样,不设这道闸就会在一轮中途发 overlay-turn end、标「已完成」。
const runs = new Map()
const RUNS_KEEP = 32
let lastCount = null      // 最近一次看到的 actionCount
let lastCountRun = null   // 那一次属于哪个 runId(没有 = null)
const isAgentPhaseOver = (st) => !st || st.phase === 'idle' || st.phase === 'done' || st.phase === 'error'

function runRecord(runId) {
  let rec = runs.get(runId)
  if (!rec) {
    rec = { base: null, count: null, helperActive: null, sawRunning: false, statusEnded: false, viaRunArg: null }
    runs.set(runId, rec)
    while (runs.size > RUNS_KEEP) runs.delete(runs.keys().next().value)
  }
  return rec
}
/** 一轮看上去结束了吗:宿主状态说了算;状态通道没表态时,helper 说不在进行中也算。 */
function runEnded(runId) {
  const rec = runId && runs.get(runId)
  if (!rec) return false
  if (rec.statusEnded) return true
  if (rec.sawRunning) return false // 状态通道明确说还在跑(模型想得久,helper 的 45 s 先到了)
  return rec.helperActive === false
}
function runSteps(runId) {
  const rec = runId && runs.get(runId)
  return rec ? stepCount(rec.base, rec.count) : null
}

/**
 * 全插件共享的单飞:同一时刻最多一次取景请求,所有实例复用同一个 Promise。
 * 为什么必须是模块级而不是每个实例一份:每帧都是一次**真实截屏**(helper 那边最长能跑到 8 秒),
 * 而视图卸载后没法取消已经发出的 IPC —— 关掉再立刻打开,就会有两次捕获在 helper 里叠着跑。
 * 反正所有实例要的是同一帧,合并即可。
 */
let sharedFetch = null
let sharedWantsImage = null
let sharedKey = null
function fetchFrame(api, opts) {
  const wantsImage = opts.image !== false
  // 复用的前提是**要到的东西一样**。除了"要不要图",还得算上 sinceFrame:
  // 两个实例见过的帧号可能不同,共用一个回包会让其中一个收到与自己无关的 unchanged。
  const key = `${wantsImage}|${opts.sinceFrame || ''}`
  // ⚠️只在"要不要图"一致时才复用:否则慢速实例先发的 {image:false} 会被要图的实例捡走,
  // 那边看到没有 jpegBase64 就误判成"拿不到画面"——我们没要 ≠ 拿不到,这个坑换条路又冒出来过一次。
  if (!sharedFetch || sharedKey !== key) {
    sharedWantsImage = wantsImage
    sharedKey = key
    // ⚠️`finally` 里只许清**自己**那一份:另一种"要不要图"的请求可能已经把这个槽换成它的了,
    // 无条件清会让那个还在飞的请求失去单飞保护 —— 下一个实例立刻又发一次真实取景。
    const mine = Promise.resolve(api(opts)).finally(() => {
      if (sharedFetch === mine) { sharedFetch = null; sharedWantsImage = null; sharedKey = null }
    })
    sharedFetch = mine
  }
  return sharedFetch
}

/** 距上次动作多久 → "刚刚 / 3 秒前 / 2 分钟前"。 */
function ago(ms) {
  const s = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (s < 1.5) return tr('ago.now')
  if (s < 60) return tr('ago.sec', { n: Math.round(s) })
  return tr('ago.min', { n: Math.round(s / 60) })
}

/** 标题栏文案:App 名 + 窗口标题,都没有就退回窗口号。 */
function describe(frame) {
  const app = frame.app || ''
  const title = frame.title || ''
  if (app && title) return `${app} — ${title}`
  return app || title || (frame.windowId ? tr('win.numbered', { id: frame.windowId }) : tr('win.unknown'))
}

// ── 缩放的纯几何(抽出来是为了可单测:算错只会"看着不对劲",不会报错)────────────────

/** 整幅塞进舞台(等价 object-fit:contain)。量不到尺寸时按 1 处理。 */
function fitScaleOf(natW, natH, stageW, stageH) {
  if (!(natW > 0 && natH > 0 && stageW > 0 && stageH > 0)) return 1
  return Math.min(stageW / natW, stageH / natH)
}

/**
 * 画布(.cu-live-viewport)在舞台里的实际尺寸 —— **画布的宽高比 = 窗口的宽高比**。
 * 于是画面严丝合缝地铺满画布,内部零留白;剩下的空间落在画布**之外**,是卡片底色而不是
 * 画中的黑边。这就是"根据窗口大小自适应调节"。
 *
 * 曾经的做法是画布占满整格、再用 fit/cover 启发式在"留黑边"与"裁掉一半界面"之间二选一 ——
 * 两头都不讨好(用户实报留白)。让画布自己变形就没有这个取舍了。
 */
function viewportBoxOf(natW, natH, stageW, stageH) {
  if (!(natW > 0 && natH > 0 && stageW > 0 && stageH > 0)) return { w: stageW || 0, h: stageH || 0 }
  const scale = Math.min(stageW / natW, stageH / natH)
  return { w: natW * scale, h: natH * scale }
}

/**
 * 平移量夹紧:图比舞台大时不许把边拖进舞台内部(否则会拖出一片空白再也找不回图);
 * 图比舞台小时一律居中。返回的是图片左上角相对舞台左上角的偏移。
 */
function clampOffset(off, scaled, stage) {
  if (scaled <= stage) return (stage - scaled) / 2
  return Math.min(0, Math.max(stage - scaled, off))
}

/** 以 anchor(舞台坐标)为锚点缩放后的新偏移 —— 光标下的那个像素保持不动。 */
function anchoredOffset(off, anchor, oldScale, newScale) {
  return anchor - (anchor - off) * (newScale / oldScale)
}

/**
 * 缩放上限 8 倍原始像素;下限"整幅可见",再往下缩只是徒增空白。
 * ⚠️例外:小窗口塞进大面板时 fit 会 >1,此时"整幅可见"已经是放大插值,
 * 若拿它当下限,双击去 1:1 看真实像素就被夹回去、永远到不了。所以下限取 min(fit, 1)。
 */
const MAX_SCALE = 8
function clampScale(scale, fit) {
  return Math.min(MAX_SCALE, Math.max(Math.min(fit, 1), scale))
}

const CSS = `
.cu-live{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg-card,var(--bg,transparent));color:var(--text,inherit);font-size:13px}
.cu-live-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border,rgba(128,128,128,.25));flex:0 0 auto}
.cu-live-dot{width:8px;height:8px;border-radius:999px;background:var(--accent,#ff7818);flex:0 0 auto}
.cu-live-dot.idle{background:var(--text-faint,rgba(128,128,128,.6))}
.cu-live-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.cu-live-age{flex:0 0 auto;color:var(--text-muted,var(--text-light,rgba(128,128,128,.9)));font-variant-numeric:tabular-nums}
.cu-live-zoom{display:none;align-items:center;gap:2px;flex:0 0 auto}
.cu-live-zoom.on{display:flex}
.cu-live-zoom button{font:inherit;line-height:1;padding:3px 7px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--text-muted,var(--text-light,inherit));cursor:pointer}
.cu-live-zoom button:hover:not(:disabled){background:var(--accent-light,var(--overlay-light,rgba(128,128,128,.14)));color:var(--accent-hover,var(--accent,inherit))}
.cu-live-zoom button:disabled{opacity:.38;cursor:default}
.cu-live-pct{min-width:4.2em;text-align:center;font-variant-numeric:tabular-nums}
/* ⚠️舞台**不留 padding**:画布尺寸是拿 stage.clientWidth/Height 算的,而 client* 是**含 padding** 的,
   留了 padding 就等于把它当成可用空间,画布必然溢出(实测 382 高的舞台画布也是 382,顶穿内边距)。
   实时画面本来就该像屏幕共享那样满铺,不需要这圈缝。 */
.cu-live-stage{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none}
/* 画布的宽高由 JS 按窗口比例算好写死(layoutViewport)。⚠️别改回 CSS aspect-ratio:
   它只推导「没被指定的那一边」,两种朝向不能同时成立 —— width:100% 时高被 max-height 夹掉、
   宽不会跟着缩(实测宽屏窗口画布停在 620x362,留白原样回来);换成 height:100% 则极宽窗口的
   宽被 max-width 夹掉,同一个病换个方向。真浏览器量出来的,别再试。 */
/* ⚠️flex:0 0 auto 不能少:画布是 flex item,默认 flex-shrink:1 会在它比舞台宽时把宽压回去,
   高却不动 —— 比例当场就错了(实测 640x150 被压成 620x150)。尺寸只许 layoutViewport 说了算。 */
.cu-live-viewport{position:relative;flex:0 0 auto;overflow:hidden;border-radius:3px;background:var(--overlay-subtle,rgba(128,128,128,.06))}
.cu-live-viewport.zoomed{cursor:grab}
.cu-live-viewport.panning{cursor:grabbing}
.cu-live-viewport img{position:absolute;top:0;left:0;transform-origin:0 0;max-width:none;max-height:none;-webkit-user-select:none;user-select:none;-webkit-user-drag:none}
.cu-live-msg{max-width:34em;text-align:center;line-height:1.6;color:var(--text-muted,var(--text-light,rgba(128,128,128,.9)))}
.cu-live-msg b{display:block;margin-bottom:6px;color:var(--text,inherit);font-weight:500}
/* ── 实时画面里的 Agent 光标 / 点击环 / 结束态 ──
   颜色:--cu-fill 由 JS 按取色规则指向 var(--signal) 或 var(--accent)(直接用宿主变量,随明暗自己跟);
   --cu-edge 是按填色亮度算好的白 / 深。光标与环**不随画面缩放**,只有位置跟着取景走。
   ⚠️类名别带 cu-live-viewport:那是画布自己的类名,check.mjs 的垫片按它认画布。 */
.cu-live-status{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;color:var(--text-muted,var(--text-light,rgba(128,128,128,.9)))}
.cu-live-status:empty{display:none}
.cu-live-status span{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
.cu-live-status span.roll{animation:cu-live-roll .28s cubic-bezier(.2,.8,.2,1)}
@keyframes cu-live-roll{from{transform:translateY(70%);opacity:0}to{transform:none;opacity:1}}
.cu-live-head.has-status .cu-live-title{flex:0 1 auto;max-width:42%}
.cu-live-stop{display:none;flex:0 0 auto;font:inherit;line-height:1;padding:3px 9px;border-radius:7px;border:1px solid var(--border,rgba(128,128,128,.25));background:transparent;color:var(--text,inherit);cursor:pointer}
.cu-live-stop.on{display:inline-block}
.cu-live-stop:hover:not(:disabled){border-color:var(--cu-fill,var(--accent,currentColor));color:var(--cu-fill,var(--accent,inherit))}
.cu-live-stop:disabled{opacity:.45;cursor:default}
.cu-live-ovl{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.cu-live-cur{position:absolute;left:0;top:0;width:18px;height:18px;display:none;will-change:transform;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.32))}
.cu-live-cur svg{display:block;width:18px;height:18px;overflow:visible}
.cu-live-ring{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:999px;box-sizing:border-box;border:2.5px solid var(--cu-fill,#2c5f9e);box-shadow:0 0 0 1px var(--cu-edge-soft,rgba(255,255,255,.5)),inset 0 0 0 1px var(--cu-edge-soft,rgba(255,255,255,.5));opacity:0;animation:cu-live-ring .5s ease-out forwards}
@keyframes cu-live-ring{0%{transform:scale(.27);opacity:.95}36%{opacity:.7}100%{transform:scale(1);opacity:0}}
.cu-live-veil{position:absolute;inset:0;background:var(--bg-card,var(--bg,#fff));opacity:0;transition:opacity .4s ease}
.cu-live-veil.on{opacity:.55}
.cu-live-badge{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:none;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:var(--bg-card,var(--bg,#fff));border:1px solid var(--border,rgba(128,128,128,.25));color:var(--text,inherit);font-weight:500;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.12)}
.cu-live-badge.on{display:inline-flex}
.cu-live-badge i{width:8px;height:8px;border-radius:999px;background:var(--cu-fill,#2c5f9e);flex:0 0 auto}
/* 减少动态:状态句直接换、环固定大小只淡出、结束态不渐变(宿主设置里的「只淡入淡出」同样算) */
@keyframes cu-live-ring-fade{0%{opacity:.95}100%{opacity:0}}
@media (prefers-reduced-motion: reduce){
  .cu-live-status span.roll{animation:none}
  .cu-live-ring{animation-name:cu-live-ring-fade;transform:none}
  .cu-live-veil{transition:none}
}
html[data-motion-fade="on"] .cu-live-status span.roll{animation:none}
html[data-motion-fade="on"] .cu-live-ring{animation-name:cu-live-ring-fade;transform:none}
html[data-motion-fade="on"] .cu-live-veil{transition:none}
`

// 光标形状:实心箭头,尖端在 (2,1)。尺寸固定 18px,不跟画面缩放。
const CURSOR_SVG = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2 1 L2 15.2 L5.9 11.6 L8.6 17 L11.1 15.8 L8.5 10.6 L13.8 10.6 Z" fill="var(--cu-fill,#2c5f9e)" stroke="var(--cu-edge,#fff)" stroke-width="1.6" stroke-linejoin="round"/></svg>'
const CURSOR_TIP = { x: 2, y: 1 }
const TWEEN_MS = 140
const RING_MS = 500
const DOUBLE_RING_GAP_MS = 150
/** 挂载后看到的第一个动作:只有够新才放环(否则一打开视图就对着一个早就点完的按钮放一圈)。 */
const FIRST_RING_MAX_AGE_MS = 600
const ACTION_TOOL_RE = /(?:^|[^a-z0-9])(?:act_ui|jev_ui)$/

// ── 整轮:状态通道、收尾、每轮开始重发颜色 ─────────────────────────────────────────────
const sentEnds = new Set()
const styledRuns = new Set()
const trimSet = (set) => { while (set.size > RUNS_KEEP) set.delete(set.values().next().value) }
let reporter = null // 主窗里的取色上报器(见文件末尾),没有就 null

function onTurnStart(runId) {
  if (!runId || styledRuns.has(runId)) return
  styledRuns.add(runId)
  trimSet(styledRuns)
  if (reporter) reporter.turnStart() // 引擎重启会丢颜色:每一轮开始时也发一次
}

/** 这一轮结束 → POST /overlay-turn(带 runId,同一个 runId 只发一次;只在主窗发)。 */
function endTurn(runId) {
  if (!runId || sentEnds.has(runId)) return
  sentEnds.add(runId)
  trimSet(sentEnds)
  const tg = ctx.tangu
  if (!tg || typeof tg.request !== 'function' || !isMainWindow(globalThis.document)) return
  try {
    Promise.resolve(tg.request(ENGINE_ID, '/overlay-turn', { method: 'POST', body: { phase: 'end', runId } })).catch(() => { /* 旧引擎没有这条路由:交给 helper 的超时 */ })
  } catch { /* 同上 */ }
}

/**
 * 取某个 runId 的宿主状态。新宿主(契约 §2.3)认 { runId };旧宿主把它当会话 id,回来的 sessionId 就是我们传的那个对象 ——
 * 认出来以后改走「主区会话里正跑着它 → 记下会话 id,之后按会话 id 问」。都对不上 → undefined(= 不知道)。
 */
function readRunStatus(runId) {
  const tg = ctx.tangu
  if (!tg || typeof tg.agentStatus !== 'function') return undefined
  const rec = runRecord(runId)
  try {
    if (rec.viaRunArg !== false) {
      const arg = { runId }
      const st = tg.agentStatus(arg)
      if (st && typeof st === 'object' && st.sessionId !== arg) { rec.viaRunArg = true; return st }
      rec.viaRunArg = false
    }
    if (rec.sessionId) return tg.agentStatus(rec.sessionId)
    const main = tg.agentStatus()
    if (main && main.runId === runId && typeof main.sessionId === 'string') { rec.sessionId = main.sessionId; return main }
  } catch { /* 当不知道 */ }
  return undefined
}

/** 用一份状态推进某一轮:先得**看到它在跑**,之后它不在跑了才算结束。 */
function applyRunStatus(runId, st) {
  const rec = runs.get(runId)
  if (!rec || st === undefined || rec.statusEnded) return
  if (st && st.runId === runId && !isAgentPhaseOver(st)) { rec.sawRunning = true; return }
  if (rec.sawRunning) { rec.statusEnded = true; endTurn(runId); unwatchRun(runId) }
}
const pollRunStatus = (runId) => applyRunStatus(runId, readRunStatus(runId))

// 新宿主上,对最近一轮单独订阅一路 { runId } 状态 —— 视图看不见(6 s 慢速)时也能及时收尾。只在主窗。
let watchedRun = null
let watchedRunOff = null
function unwatchRun(runId) {
  if (runId && runId !== watchedRun) return
  if (watchedRunOff) { try { watchedRunOff() } catch { /* 宿主会统一收 */ } }
  watchedRun = null
  watchedRunOff = null
}
function watchRun(runId) {
  const tg = ctx.tangu
  const rec = runs.get(runId)
  if (!rec || rec.viaRunArg !== true || rec.statusEnded || watchedRun === runId) return
  if (!tg || typeof tg.subscribeAgentStatus !== 'function' || !isMainWindow(globalThis.document)) return
  unwatchRun()
  watchedRun = runId
  try { watchedRunOff = tg.subscribeAgentStatus((st) => applyRunStatus(runId, st), { runId }) } catch { watchedRun = null }
}

/** 每个视图拿到的每一帧(含 unchanged / 不带图的)都过一遍这里:记基数、计数、helper 的进行中,顺手问一次状态。 */
function noteFrame(frame) {
  const count = Number.isFinite(frame.actionCount) ? frame.actionCount : null
  const runId = typeof frame.runId === 'string' && frame.runId ? frame.runId : null
  if (runId) {
    const rec = runRecord(runId)
    if (!rec.seenFrame) {
      rec.seenFrame = true
      // 基数只认「这一轮之前看到过的计数」;第一眼就已经在这一轮里 → 不知道,结束时只写「已完成」不写步数。
      rec.base = lastCount !== null && lastCountRun !== runId ? lastCount : null
      if (frame.turnActive !== false) onTurnStart(runId) // 已经收了的上一轮不必重发颜色
    }
    if (count !== null) rec.count = count
    if (typeof frame.turnActive === 'boolean') rec.helperActive = frame.turnActive
    pollRunStatus(runId)
    watchRun(runId)
  }
  if (count !== null) { lastCount = count; lastCountRun = runId }
}

ctx.registerView({
  id: VIEW_ID,
  // Agent Desk 卡片标题也用它(插件第一次动手时自己摆上 Desk,不带名字)。
  // ponytail: 装载时按语言取一次;切换界面语言后要重载插件才跟上(老宿主的视图标题只认字符串)。
  title: (ctx.getLocale ? ctx.getLocale() : 'zh') === 'en' ? 'Controlled window' : '被操控的窗口',
  mount(el) {
    const doc = el.ownerDocument || document
    if (!doc.getElementById('cu-live-style')) {
      const style = doc.createElement('style')
      style.id = 'cu-live-style'
      style.textContent = CSS
      doc.head.appendChild(style)
    }

    const root = doc.createElement('div')
    root.className = 'cu-live'
    const head = doc.createElement('div')
    head.className = 'cu-live-head'
    const dot = doc.createElement('span')
    dot.className = 'cu-live-dot idle'
    const title = doc.createElement('span')
    title.className = 'cu-live-title'
    title.textContent = tr('view.title')
    // 这一步在做什么(「正在点击「发送」」…)。旧回包没有动作字段 → 空着,头部照旧。
    const status = doc.createElement('span')
    status.className = 'cu-live-status'
    const age = doc.createElement('span')
    age.className = 'cu-live-age'
    const zoomBar = doc.createElement('span')
    zoomBar.className = 'cu-live-zoom'
    const mkBtn = (label, tip) => {
      const b = doc.createElement('button')
      b.textContent = label
      b.title = tip
      return b
    }
    const btnOut = mkBtn('−', tr('zoom.out'))
    const btnPct = mkBtn('100%', tr('zoom.reset'))
    btnPct.className = 'cu-live-pct'
    const btnIn = mkBtn('+', tr('zoom.in'))
    zoomBar.append(btnOut, btnPct, btnIn)
    // 停止:宿主给了 ctx.tangu.stop(契约 §2.2)且知道这一轮的 runId 才露出来。
    const btnStop = mkBtn(tr('btn.stop'), tr('btn.stopTip'))
    btnStop.className = 'cu-live-stop'
    head.append(dot, title, status, age, zoomBar, btnStop)
    const stage = doc.createElement('div')
    stage.className = 'cu-live-stage'
    root.append(head, stage)
    el.appendChild(root)

    // 画布:宽高比跟着被操控窗口走(见 CSS 里的 --cu-ar)。缩放/平移的取景框就是它,不是整个舞台。
    const viewport = doc.createElement('div')
    viewport.className = 'cu-live-viewport'
    const img = doc.createElement('img')
    img.alt = tr('img.alt')
    viewport.appendChild(img)
    // 叠层:光标、点击环、结束时的那层底色与「已完成 · N 步」。都是 div(舞台上只许有一张 img),
    // 都在画布里 —— 画面被错误说明顶掉时它们跟着一起走,不会悬在说明上。
    const ovl = doc.createElement('div')
    ovl.className = 'cu-live-ovl'
    const cursorEl = doc.createElement('div')
    cursorEl.className = 'cu-live-cur'
    cursorEl.innerHTML = CURSOR_SVG
    const veil = doc.createElement('div')
    veil.className = 'cu-live-veil'
    const badge = doc.createElement('div')
    badge.className = 'cu-live-badge'
    ovl.append(cursorEl, veil, badge)
    viewport.appendChild(ovl)
    const msg = doc.createElement('div')
    msg.className = 'cu-live-msg'

    // 颜色:同一条取色规则,但界面里直接引用宿主变量(明暗切换时自己跟上);描边按读回的填色亮度定。
    const applyColors = () => {
      const th = readTheme(doc)
      const pick = th && th.pick
      const edge = pick ? edgeFor(pick.rgb) : '#ffffff'
      root.style.setProperty('--cu-fill', pick ? `var(--${pick.source})` : FALLBACK_FILL)
      root.style.setProperty('--cu-edge', edge)
      root.style.setProperty('--cu-edge-soft', edge === '#ffffff' ? 'rgba(255,255,255,.5)' : 'rgba(28,27,31,.5)')
    }
    applyColors()
    const unwatchColors = watchTheme(doc, applyColors)

    // ── 缩放/平移状态 ────────────────────────────────────────────────
    // natW/natH = 这一帧画面的像素尺寸;scale = 相对原始像素的倍率(100% = 1:1);
    // atFit = 还停在默认比例(未被用户缩放过)——**新帧到来时只有 atFit 才重新贴合**,
    // 否则用户刚放大到某个按钮上,下一秒的帧就把他弹回全景了。
    let natW = 0
    let natH = 0
    let scale = 1
    let atFit = true
    let offX = 0
    let offY = 0
    let shownWindowId = null
    // 上一帧的序号。带回给 helper,画面没变它就只回一句 unchanged —— 静止的窗口占绝大多数,
    // 不带这个的话同一张图会被每秒重编 8 次 JPEG + base64 + 过 IPC + 换一次 <img src>,纯白烧。
    let shownFrameSeq = null

    /** 把画布变形成这一帧窗口的形状。几何全从它量,所以任何改变 natW/natH 或舞台尺寸的事之后都得先调它。 */
    const layoutViewport = () => {
      const box = viewportBoxOf(natW, natH, stage.clientWidth || 0, stage.clientHeight || 0)
      viewport.style.width = `${box.w}px`
      viewport.style.height = `${box.h}px`
      return box
    }
    /** 取景框 = 画布(已按窗口比例变形),不是舞台 —— 舞台里画布之外那圈是卡片留白,不参与取景。 */
    const stageBox = () => ({
      w: viewport.clientWidth || 0,
      h: viewport.clientHeight || 0,
    })
    /**
     * 缩放下限 = 整幅可见。画布与画面同比例,所以这同时就是"恰好铺满画布"——
     * fit 与 cover 在这里是同一个值,不再需要在留黑边和裁画面之间做取舍。
     */
    const fitScale = () => {
      const { w, h } = stageBox()
      return fitScaleOf(natW, natH, w, h)
    }
    const defaultScale = fitScale

    const paintZoom = () => {
      const fit = fitScale()
      const zoomed = scale > fit * 1.001
      img.style.width = `${natW}px`
      img.style.height = `${natH}px`
      img.style.transform = `translate(${offX}px, ${offY}px) scale(${scale})`
      // 放大到超过原始像素时关掉平滑,让人看清真实像素(这正是"查看细节"要的)
      img.style.imageRendering = scale > 1.5 ? 'pixelated' : 'auto'
      btnPct.textContent = `${Math.round(scale * 100)}%`
      btnOut.disabled = !zoomed
      btnIn.disabled = scale >= MAX_SCALE - 1e-6
      viewport.className = `cu-live-viewport${zoomed ? ' zoomed' : ''}`
      placeOverlay()
    }

    /** 回到默认比例(恰好铺满画布),居中。 */
    const resetZoom = () => {
      scale = defaultScale()
      atFit = true
      const { w, h } = stageBox()
      // ⚠️传居中值而不是 0:亚像素误差会让画面比画布大上零点几个像素,0 在合法区间内 →
      // 贴左上角对齐,于是那零点几像素全被切在右/下边。居中才是"取中间那块"。
      offX = clampOffset((w - natW * scale) / 2, natW * scale, w)
      offY = clampOffset((h - natH * scale) / 2, natH * scale, h)
      paintZoom()
    }

    /** 以舞台坐标 (ax, ay) 为锚点缩放到 next。 */
    const zoomTo = (next, ax, ay) => {
      const fit = fitScale()
      const target = clampScale(next, fit)
      if (Math.abs(target - scale) < 1e-6) return
      const { w, h } = stageBox()
      offX = anchoredOffset(offX, ax, scale, target)
      offY = anchoredOffset(offY, ay, scale, target)
      scale = target
      // 只有回到默认比例才算"没自己缩放过";落在默认与 fit 之间也算用户在取景。
      atFit = Math.abs(scale - defaultScale()) < 1e-3
      offX = clampOffset(offX, natW * scale, w)
      offY = clampOffset(offY, natH * scale, h)
      paintZoom()
    }
    const zoomByStep = (factor) => {
      const { w, h } = stageBox()
      zoomTo(scale * factor, w / 2, h / 2)
    }

    /** 画布形状可能变了(换窗口 / 窗口改尺寸 / 面板被拖动)→ 重新变形,再收拾取景。
     *  还停在默认比例就整个复位;用户正放大着就守住倍率,但**必须把平移夹回新边界** ——
     *  paintZoom 只画不夹,旧偏移相对新画布可能已经越界,画面会整块滑出去。 */
    const reflow = (prevNatW) => {
      if (!natW) return
      layoutViewport()
      if (atFit) return resetZoom()
      // ⚠️同一个窗口换了**编码分辨率**(取景放大时我们主动要更高清的原图,maxDimension 800→1600):
      // scale 是"相对原始像素"的倍率,像素翻倍而 scale 不动,画面就凭空放大一倍、锚点也跟着跳。
      // 按像素比反向补偿,保住用户看到的大小。窗口真的变大时这样做同样对 —— 视觉尺寸不该因此突变。
      if (prevNatW > 0 && prevNatW !== natW) scale *= prevNatW / natW
      const { w, h } = stageBox()
      scale = clampScale(scale, fitScale())
      offX = clampOffset(offX, natW * scale, w)
      offY = clampOffset(offY, natH * scale, h)
      paintZoom()
    }

    /** 画布正挂在舞台上(而不是被错误说明顶掉了)—— 所有交互的前提。 */
    const showingImage = () => viewport.parentNode === stage

    /** 只换文本,不重建节点 —— 每秒重建几次 DOM 没必要,也会让选中/滚动位置抖。 */
    const showMessage = (headline, detail) => {
      if (msg.parentNode !== stage) stage.replaceChildren(msg)
      zoomBar.className = 'cu-live-zoom'
      msg.replaceChildren()
      const b = doc.createElement('b')
      b.textContent = headline
      msg.append(b, doc.createTextNode(detail || ''))
    }
    const showImage = (dataUrl, w, h, forceReset) => {
      const resized = w !== natW || h !== natH
      const prevNatW = natW
      natW = w || natW
      natH = h || natH
      img.src = dataUrl
      if (!showingImage()) stage.replaceChildren(viewport)
      zoomBar.className = 'cu-live-zoom on'
      // 换了窗口一律复位:尺寸恰好相同时 resized=false,不强制的话新窗口会套用上一个窗口的取景框。
      if (forceReset) { layoutViewport(); return resetZoom() }
      if (resized) return reflow(prevNatW)
      paintZoom()
    }

    // ── 交互:滚轮/触控板缩放、拖拽平移、按钮、键盘 ──────────────────────
    const offs = []
    const on = (target, type, fn, opts) => {
      if (!target.addEventListener) return
      target.addEventListener(type, fn, opts)
      offs.push(() => target.removeEventListener(type, fn, opts))
    }
    /** 事件坐标 → **画布**坐标(offX/offY 就是相对画布左上角量的,拿舞台去减会整体错位)。 */
    const localPoint = (e) => {
      const r = viewport.getBoundingClientRect ? viewport.getBoundingClientRect() : { left: 0, top: 0 }
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    on(btnIn, 'click', () => zoomByStep(1.4))
    on(btnOut, 'click', () => zoomByStep(1 / 1.4))
    on(btnPct, 'click', () => resetZoom())

    // ── 叠层:光标 / 点击环 / 状态句 / 结束态 / 停止 ─────────────────────────────────
    // 位置一律存成 0..1 比例,由 placeOverlay 按当前取景换算 —— 缩放、平移时它们跟着画面走,自己的大小不变。
    const win = doc.defaultView || globalThis
    const raf = typeof win.requestAnimationFrame === 'function' ? (f) => win.requestAnimationFrame(f) : null
    const caf = typeof win.cancelAnimationFrame === 'function' ? (id) => win.cancelAnimationFrame(id) : () => {}
    const nowMs = () => (win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now())
    let curPt = null        // 光标此刻画在哪(补间进行中就是中间点)
    let tween = null        // { from, to, t0 }
    let rafId = null
    const rings = []        // { el, pt }
    const overlayTimers = new Set()
    let lastSeq = null
    let shownStatus = ''
    let shownDone = ''
    let stopRun = null
    let stoppingRun = null

    function placeOverlay() {
      if (!natW || !natH) return
      if (curPt) {
        const p = overlayPx(curPt, natW, natH, scale, offX, offY)
        cursorEl.style.transform = `translate(${p.x - CURSOR_TIP.x}px, ${p.y - CURSOR_TIP.y}px)`
      }
      for (const r of rings) {
        const p = overlayPx(r.pt, natW, natH, scale, offX, offY)
        r.el.style.left = `${p.x}px`
        r.el.style.top = `${p.y}px`
      }
    }
    const stepTween = () => {
      rafId = null
      if (!tween || stopped) return
      const t = (nowMs() - tween.t0) / TWEEN_MS
      curPt = tweenPoint(tween.from, tween.to, t)
      placeOverlay()
      if (t < 1) rafId = raf(stepTween)
      else tween = null
    }
    /** 光标去 pt(比例点;null = 不画)。两帧之间补着走;减少动态 / 看不见(rAF 不来)/ 第一次出现 → 直接到位。 */
    const setCursor = (pt) => {
      if (!pt) {
        curPt = null
        tween = null
        cursorEl.style.display = 'none'
        return
      }
      cursorEl.style.display = 'block'
      if (!curPt || !raf || reducedMotionIn(doc) || unseen()) {
        tween = null
        curPt = pt
        placeOverlay()
        return
      }
      const goal = tween ? tween.to : curPt
      if (goal.x === pt.x && goal.y === pt.y) return
      tween = { from: curPt, to: pt, t0: nowMs() }
      if (rafId === null) rafId = raf(stepTween)
    }
    const later = (fn, ms) => {
      const id = setTimeout(() => { overlayTimers.delete(id); if (!stopped) fn() }, ms)
      overlayTimers.add(id)
    }
    const spawnRing = (pt) => {
      const ringEl = doc.createElement('div')
      ringEl.className = 'cu-live-ring'
      const r = { el: ringEl, pt }
      rings.push(r)
      ovl.appendChild(ringEl)
      placeOverlay()
      later(() => {
        const i = rings.indexOf(r)
        if (i >= 0) rings.splice(i, 1)
        if (ringEl.remove) ringEl.remove()
      }, RING_MS + 120)
    }
    /** 点击类动作放一次环,双击两圈(间隔 0.15 s)。落点优先用动作自己的坐标,没有就用光标。 */
    const playRings = (a, fallback) => {
      const pt = fracPoint({ x: a.x, y: a.y }) || fallback
      if (!pt) return
      spawnRing(pt)
      if (a.kind === 'doubleClick') later(() => spawnRing(pt), DOUBLE_RING_GAP_MS)
    }
    /** 状态句:变了才换,换的时候滚一下(减少动态时 CSS 不滚)。 */
    const setStatus = (text) => {
      if (text === shownStatus) return
      shownStatus = text
      head.className = text ? 'cu-live-head has-status' : 'cu-live-head'
      if (!text) { status.replaceChildren(); return }
      const s = doc.createElement('span')
      s.className = 'roll'
      s.textContent = text
      s.title = text
      status.replaceChildren(s)
    }
    /** 这一轮结束:最后一帧盖一层卡片底色(0.55),正中「已完成 · N 步」。 */
    const setDone = (text) => {
      if (text === shownDone) return
      shownDone = text
      veil.className = text ? 'cu-live-veil on' : 'cu-live-veil'
      badge.className = text ? 'cu-live-badge on' : 'cu-live-badge'
      badge.replaceChildren()
      if (text) badge.append(doc.createElement('i'), doc.createTextNode(text))
    }
    const setStop = (runId) => {
      const can = Boolean(runId) && Boolean(ctx.tangu && typeof ctx.tangu.stop === 'function')
      stopRun = can ? runId : null
      btnStop.className = can ? 'cu-live-stop on' : 'cu-live-stop'
      btnStop.disabled = can && stoppingRun === runId
    }
    on(btnStop, 'click', () => {
      const runId = stopRun
      if (!runId || stoppingRun === runId) return
      stoppingRun = runId
      btnStop.disabled = true
      let p
      try { p = Promise.resolve(ctx.tangu.stop({ runId })) } catch { p = Promise.resolve(false) }
      p.catch(() => false).then((ok) => {
        // 没停成(找不到这一轮)→ 还给用户再按一次;停成了就等这一轮真的结束,按钮跟着收起。
        if (!ok && stoppingRun === runId) { stoppingRun = null; if (!stopped && stopRun === runId) btnStop.disabled = false }
      })
    })
    const clearOverlay = () => {
      setCursor(null)
      setStatus('')
      setDone('')
      setStop(null)
    }
    /** 一帧(活跃的)到手后更新叠层。旧回包(没有协议 20 的字段)→ 全部收起,头部照现在的样子。 */
    const updateOverlay = (frame) => {
      const fresh = frame.lastAction !== undefined || frame.cursor !== undefined || frame.runId !== undefined
        || frame.turnActive !== undefined || frame.actionCount !== undefined
      if (!fresh) return clearOverlay()
      noteFrame(frame)
      const runId = typeof frame.runId === 'string' && frame.runId ? frame.runId : null
      const ended = runId ? runEnded(runId) : frame.turnActive === false
      const a = frame.lastAction && typeof frame.lastAction === 'object' ? frame.lastAction : null
      const cur = fracPoint(frame.cursor)
      setCursor(cur)
      if (a && Number.isFinite(a.seq)) {
        const isNew = lastSeq !== null ? a.seq !== lastSeq : Number(a.ageMs) < FIRST_RING_MAX_AGE_MS
        if (isNew && !ended && CLICK_KINDS.has(a.kind)) playRings(a, cur)
        lastSeq = a.seq
      }
      const locale = currentLocale()
      setStatus(statusText(locale, { ended, lastAction: a }))
      setDone(ended ? doneText(locale, runId ? runSteps(runId) : null) : '')
      setStop(ended ? null : runId)
    }

    // 触控板捏合在 macOS 上就是 ctrlKey 的 wheel;普通滚轮这里也当缩放(它是个看图器)。
    // passive:false + preventDefault:否则滚轮会冒泡去滚外层面板。
    on(viewport, 'wheel', (e) => {
      if (!showingImage()) return
      e.preventDefault()
      const p = localPoint(e)
      const factor = Math.exp(-(e.deltaY || 0) * (e.ctrlKey ? 0.01 : 0.0022))
      zoomTo(scale * factor, p.x, p.y)
    }, { passive: false })

    // 双击:默认比例 ↔ 1:1 原始像素,在光标处切换
    on(viewport, 'dblclick', (e) => {
      if (!showingImage()) return
      const p = localPoint(e)
      if (atFit) zoomTo(1, p.x, p.y)
      else resetZoom()
    })

    let drag = null
    on(viewport, 'pointerdown', (e) => {
      if (!showingImage() || scale <= fitScale() * 1.001) return
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
      if (viewport.setPointerCapture) viewport.setPointerCapture(e.pointerId)
      viewport.className = 'cu-live-viewport zoomed panning'
    })
    on(viewport, 'pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return
      const { w, h } = stageBox()
      offX = clampOffset(offX + (e.clientX - drag.x), natW * scale, w)
      offY = clampOffset(offY + (e.clientY - drag.y), natH * scale, h)
      drag.x = e.clientX
      drag.y = e.clientY
      img.style.transform = `translate(${offX}px, ${offY}px) scale(${scale})`
      placeOverlay()
    })
    const endDrag = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return
      drag = null
      paintZoom()
    }
    on(viewport, 'pointerup', endDrag)
    on(viewport, 'pointercancel', endDrag)
    on(viewport, 'lostpointercapture', endDrag)
    // ⚠️兜底:setPointerCapture 失败/不支持时,指针移出舞台再松手,pointerup 落在别处 →
    // drag 永远清不掉,之后鼠标一动画面就跟着跑。切到别的 App 松手同理(渲染进程收不到 up)。
    // 无参调用 endDrag 会无条件收场(它只在传了不匹配的 pointerId 时才拒绝)。
    const forceEndDrag = () => endDrag()
    on(doc, 'pointerup', forceEndDrag)
    on(doc, 'pointercancel', forceEndDrag)
    if (globalThis.window) on(window, 'blur', forceEndDrag)

    // 键盘:+ / - / 0(0 = 恢复默认比例)
    stage.setAttribute('tabindex', '0')
    on(stage, 'keydown', (e) => {
      if (!showingImage()) return
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomByStep(1.4) }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomByStep(1 / 1.4) }
      else if (e.key === '0') { e.preventDefault(); resetZoom() }
    })

    // 面板被拖宽/收窄 → 画布要重新变形。⚠️观察的是**舞台**不是画布:画布的尺寸是我们自己写进去的,
    // 观察它就会被自己的写入再次唤醒 → 死循环。
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => reflow()) : null
    if (resizeObserver) resizeObserver.observe(stage)

    let timer = null
    let stopped = false
    let inFlight = false

    const schedule = (ms) => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(tick, ms)
    }

    // 可见性是**节奏**,不是开关。三态:null=还没人告诉我(当可见处理),true/false=IO 的判断。
    // ⚠️绝不能因为"不可见"就完全停:隐藏页面里浏览器不做交集计算,IO 连首次回调都不来,
    // 初值若是 false 就永远翻不了身(实测 ioHits=0,视图一帧都不请求)。
    const hasObserver = typeof IntersectionObserver === 'function'
    let onScreen = null
    const observer = hasObserver
      ? new IntersectionObserver((entries) => {
          const now = entries.some((e) => e.isIntersecting)
          const appeared = now && onScreen === false
          onScreen = now
          // 刚露出来就立刻补一帧,别让用户对着慢速间隔干等。
          if (appeared && !stopped && !inFlight) schedule(0)
        }, { threshold: 0.01 })
      : null
    if (observer) observer.observe(root)
    /** 明确不可见(IO 说的,或页面整个隐藏)→ 降到慢速;其余按正常节奏。 */
    const unseen = () => onScreen === false || doc.hidden === true

    async function tick() {
      timer = null
      if (stopped) return
      if (inFlight) return schedule(TICK_MS)
      const api = globalThis.window && window.tangu && window.tangu.computerUseLiveView
      if (!api) {
        showMessage(tr('msg.needDesktop'), tr('msg.needDesktopDetail'))
        dot.className = 'cu-live-dot idle'
        age.textContent = ''
        return // 不再重排:这个环境永远不会有
      }
      inFlight = true
      // 慢速期主动不要图(省掉真正贵的那一步:一次窗口截屏)。记下来 —— 下面判断
      // "没图" 是我们没要,还是真的拿不到,两者的处理完全不同。
      const wantedImage = !unseen()
      let frame
      try {
        // 放大了就要更高分辨率的原图,否则"查看细节"看到的只是被放大的马赛克。
        // 2560 是主进程那边的上限,再高会被夹回去。
        frame = await fetchFrame(api, wantedImage
          ? { maxDimension: atFit ? 800 : 1600, quality: atFit ? 0.55 : 0.8, sinceFrame: shownFrameSeq || '' }
          : { image: false })
      } catch (e) {
        frame = { active: false, error: String((e && e.message) || e) }
      } finally {
        inFlight = false
      }
      if (stopped) return

      if (!frame.active) {
        dot.className = 'cu-live-dot idle'
        title.textContent = tr('view.title')
        age.textContent = ''
        clearOverlay()
        showMessage(tr('msg.none'), explain(frame.error) || tr('msg.noneDetail'))
        return schedule(unseen() ? HIDDEN_TICK_MS : IDLE_TICK_MS)
      }

      dot.className = 'cu-live-dot'
      const label = describe(frame)
      title.textContent = label
      title.title = label
      age.textContent = ago(frame.ageMs)
      // 光标 / 环 / 状态句 / 结束态:unchanged 与不带图的回包里也有这些字段,每帧都过。
      updateOverlay(frame)
      // 换了个窗口就回到默认比例:上一个窗口的取景框套在新窗口上毫无意义(还可能停在一片空白上)
      const switchedWindow = Boolean(frame.windowId) && frame.windowId !== shownWindowId
      if (switchedWindow) { shownWindowId = frame.windowId; shownFrameSeq = null }
      if (frame.jpegBase64) {
        shownFrameSeq = frame.frameSeq || null
        showImage(`data:image/jpeg;base64,${frame.jpegBase64}`, frame.width, frame.height, switchedWindow)
      }
      // helper 说"和你上次看到的那一帧一样":静止的窗口本来就该长这样,保留现有画面,只刷标题与时间。
      else if (frame.unchanged) { /* 画面没变 */ }
      // 慢速期是**我们自己没要图**(image:false),不是拿不到 —— 保留正在显示的那一帧,
      // 别把画面换成"拿不到这一帧画面"。真拿不到(该给图却没给)才报。
      else if (!wantedImage) { /* 保留现有画面,只刷新标题与时间 */ }
      else showMessage(tr('msg.noFrame'), explain(frame.error))
      schedule(unseen() ? HIDDEN_TICK_MS : TICK_MS)
    }

    void tick()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (observer) observer.disconnect()
      if (resizeObserver) resizeObserver.disconnect()
      if (rafId !== null) caf(rafId)
      rafId = null
      overlayTimers.forEach((id) => clearTimeout(id))
      overlayTimers.clear()
      unwatchColors()
      offs.forEach((f) => f())
      offs.length = 0
      img.src = ''
      el.replaceChildren()
    }
  },
})

// ── 侧边拼接:把一扇对话面板贴在某个 App 窗口旁边,拖动 / 移动 / 缩放都像一个窗口 ──────────────
// 面板、跟随、读划线都在宿主(electron/appDock.ts,经本包 helper 的 dockProbe / selection 命令);这里只是入口。
// 面板打开后先列出屏上的窗口让用户挑,所以命令本身不带目标。老宿主没有这条 IPC、或不是 macOS(跟随靠 helper 的
// CGWindowList / AX,宿主那边直接回 unsupported_platform)→ 不注册,免得给出一个点了没反应的命令。
const dockOpen = globalThis.window && window.tangu && window.tangu.platform === 'darwin' && window.tangu.appDockOpen
if (dockOpen) {
  const en = () => (ctx.getLocale ? ctx.getLocale() : 'zh') === 'en'
  ctx.registerCommand({
    id: 'dock-chat',
    title: () => (en() ? 'Dock a chat beside an app' : '把对话贴到应用旁边'),
    keywords: 'side panel dock attach app window chat 侧边 贴边 拼接 应用 窗口 对话 tiebian pinjie',
    run: () => { void dockOpen() },
  })
}

// ── 取色上报(插件顶层,只在主窗)────────────────────────────────────────────────────
// 经 ctx.tangu.request 交给自家引擎半身的 /overlay-style(契约 §1.6),引擎塞进之后每条 act。
// 旧宿主没有 ctx.tangu.request → 什么都不做(helper 用柔蓝)。内容没变不重发;每一轮开始时强制重发一次。
const teardown = []
{
  const doc = globalThis.document
  const tg = ctx.tangu
  if (tg && typeof tg.request === 'function' && doc && doc.documentElement && isMainWindow(doc)) {
    let lastKey = null
    let dead = false
    const send = (force) => {
      if (dead) return
      const th = readTheme(doc)
      const body = th && styleBody(th.pick, th.reducedMotion)
      if (!body) return // 读不出就不发
      const key = JSON.stringify(body)
      if (!force && key === lastKey) return
      lastKey = key
      let p
      try { p = Promise.resolve(tg.request(ENGINE_ID, '/overlay-style', { method: 'POST', body })) } catch (e) { p = Promise.reject(e) }
      // 失败(旧引擎没这条路由 / 引擎没起来)不刷屏;清掉记号,下次变化或下一轮再试。
      p.catch(() => { if (lastKey === key) lastKey = null })
    }
    const unwatch = watchTheme(doc, () => send(false))
    reporter = { turnStart: () => send(true) }
    send(false)
    teardown.push(() => { dead = true; unwatch(); reporter = null })
  }
}

// ── 主区会话的整轮(插件顶层,只在主窗)──────────────────────────────────────────────
// 没有视图开着时也要收尾:主区会话里跑过 act_ui / jev_ui 的那一轮,不跑了就发 overlay-turn end。
// 这里拿到的 runId 是宿主的;引擎把同一个 id 交给工具(tcx.runId)—— 对不上时 helper 照契约不做事,无害。
{
  const tg = ctx.tangu
  if (tg && typeof tg.subscribeAgentStatus === 'function' && isMainWindow(globalThis.document)) {
    let lastMainRun = null
    const onStatus = (st) => {
      if (!st || typeof st !== 'object') return
      const runId = typeof st.runId === 'string' && st.runId ? st.runId : null
      if (runId && runId !== lastMainRun) { lastMainRun = runId; onTurnStart(runId) }
      if (runId && !isAgentPhaseOver(st) && typeof st.tool === 'string' && ACTION_TOOL_RE.test(st.tool)) {
        const rec = runRecord(runId)
        rec.sawRunning = true
        if (typeof st.sessionId === 'string') rec.sessionId = st.sessionId
      }
      // 每次主区状态变了,把还没收尾的几轮都问一遍(它们各自按会话 id / runId 问,不会被主区切会话骗)。
      for (const [id, rec] of runs) if (rec.sawRunning && !rec.statusEnded) pollRunStatus(id)
    }
    let off = null
    try { off = tg.subscribeAgentStatus(onStatus) } catch { off = null }
    try { if (typeof tg.agentStatus === 'function') onStatus(tg.agentStatus()) } catch { /* 拿不到初值就等回调 */ }
    teardown.push(() => { if (typeof off === 'function') { try { off() } catch { /* 宿主会统一收 */ } } })
  }
}
teardown.push(() => unwatchRun())

// 纯函数暴露给 check.mjs(宿主装载时 ctx 存在,check 里只取这个挂点)。
globalThis.__CU_LIVE_TEST__ = {
  explain, ago, describe, PLUGIN_ID, VIEW_ID, TICK_MS, IDLE_TICK_MS,
  fitScaleOf, viewportBoxOf, fetchFrame, clampOffset, anchoredOffset, clampScale, MAX_SCALE, HIDDEN_TICK_MS,
  MSG, fmt, chroma, toHex, hexToRgb, relLuminance, edgeFor, pickFill, styleBody, statusText, stepCount, doneText,
  fracPoint, easeOut, tweenPoint, overlayPx, isMainWindow, reducedMotionIn, ENGINE_ID, FALLBACK_FILL,
  DOING_MS, LOOKING_AFTER_MS, TWEEN_MS,
}

// 停用 / 重载插件:拆掉顶层的观察器、订阅、定时器(视图实例各自的清理在 mount 返回的函数里)。
return () => {
  while (teardown.length) { try { teardown.pop()() } catch { /* 继续拆别的 */ } }
}
