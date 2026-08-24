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

const ERROR_TEXT = {
  unsupported_platform: '实时画面目前只有 macOS 支持(Windows 的 helper 是子进程,桌面端够不着)。',
  helper_not_running: '还没有窗口正在被操控。让 agent 用 computer use 的工具动一下,画面就会出现。',
  unsupported_helper: '本机的 Computer Use helper 还是旧版,不认识实时画面(边缘光效同样不会出现——两者在同一个二进制里)。让 agent 用一次 computer use 的工具,它会自动把 helper 更新到随包的版本;更新后 macOS 可能要求重新授权「辅助功能」与「屏幕录制」。',
  capture_timeout: '截取窗口画面超时了,下一帧会重试。',
  client_timeout: '等本机 helper 回画面超时了,下一帧会重试。',
  capture_failed: '截不到这个窗口的画面 —— 多半是没给「屏幕录制」权限(系统设置 → 隐私与安全性)。',
  screen_recording_denied: '没有「屏幕录制」权限,拿不到窗口画面(系统设置 → 隐私与安全性 → 屏幕录制)。',
  encode_failed: '窗口画面编码失败,下一帧会重试。',
}

/** 错误码 → 人话。未知码原样带出去,别吞掉线索。 */
function explain(code) {
  if (!code) return ''
  return ERROR_TEXT[code] || `实时画面暂时不可用(${code})。`
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
  if (s < 1.5) return '刚刚'
  if (s < 60) return `${Math.round(s)} 秒前`
  return `${Math.round(s / 60)} 分钟前`
}

/** 标题栏文案:App 名 + 窗口标题,都没有就退回窗口号。 */
function describe(frame) {
  const app = frame.app || ''
  const title = frame.title || ''
  if (app && title) return `${app} — ${title}`
  return app || title || (frame.windowId ? `窗口 #${frame.windowId}` : '未知窗口')
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
`

ctx.registerView({
  id: VIEW_ID,
  title: '被操控的窗口',
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
    title.textContent = '被操控的窗口'
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
    const btnOut = mkBtn('−', '缩小')
    const btnPct = mkBtn('100%', '恢复默认比例(整幅可见)')
    btnPct.className = 'cu-live-pct'
    const btnIn = mkBtn('+', '放大')
    zoomBar.append(btnOut, btnPct, btnIn)
    head.append(dot, title, age, zoomBar)
    const stage = doc.createElement('div')
    stage.className = 'cu-live-stage'
    root.append(head, stage)
    el.appendChild(root)

    // 画布:宽高比跟着被操控窗口走(见 CSS 里的 --cu-ar)。缩放/平移的取景框就是它,不是整个舞台。
    const viewport = doc.createElement('div')
    viewport.className = 'cu-live-viewport'
    const img = doc.createElement('img')
    img.alt = '正在被操控的窗口画面'
    viewport.appendChild(img)
    const msg = doc.createElement('div')
    msg.className = 'cu-live-msg'

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
        showMessage('需要 Forsion 桌面端', '实时画面要通过桌面主进程访问 Computer Use 的本机 helper。')
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
        title.textContent = '被操控的窗口'
        age.textContent = ''
        showMessage('暂无正在被操控的窗口', explain(frame.error) || '让 agent 用 computer use 的工具动一下,画面就会出现。')
        return schedule(unseen() ? HIDDEN_TICK_MS : IDLE_TICK_MS)
      }

      dot.className = 'cu-live-dot'
      const label = describe(frame)
      title.textContent = label
      title.title = label
      age.textContent = ago(frame.ageMs)
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
      else showMessage('拿不到这一帧画面', explain(frame.error))
      schedule(unseen() ? HIDDEN_TICK_MS : TICK_MS)
    }

    void tick()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (observer) observer.disconnect()
      if (resizeObserver) resizeObserver.disconnect()
      offs.forEach((f) => f())
      offs.length = 0
      img.src = ''
      el.replaceChildren()
    }
  },
})

// 纯函数暴露给 check.mjs(宿主装载时 ctx 存在,check 里只取这个挂点)。
globalThis.__CU_LIVE_TEST__ = {
  explain, ago, describe, PLUGIN_ID, VIEW_ID, TICK_MS, IDLE_TICK_MS,
  fitScaleOf, viewportBoxOf, fetchFrame, clampOffset, anchoredOffset, clampScale, MAX_SCALE, HIDDEN_TICK_MS,
}
