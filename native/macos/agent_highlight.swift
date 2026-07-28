import AppKit
import SwiftUI

/// 被操控窗口的边缘光效(Tangu 新增,非上游)。
///
/// 为什么放在 helper 里:光效必须画在**别人的 App 窗口**上,只有这个常驻的辅助进程能建一个悬在目标
/// 窗口之上的覆盖层。Forsion 自己的窗口画不到别人身上。
///
/// 三条纪律:
///  1. **绝不抢焦点、绝不吃事件** —— canBecomeKey=false + ignoresMouseEvents,与 AgentCursor 同款。
///     否则「后台操控」这个前提就没了。
///  2. **静态绘制,不做动画** —— 上游刚修过「光标空闲期一直重绘」(c089b30/5943c16)。呼吸灯要 120fps
///     的 TimelineView 常驻跑,代价是操控期间一直烧 GPU。这里只画一圈静态辉光,只有几何真变了才重绘。
///  3. **跟随窗口**:可见期间自己跑一个 8Hz 的 timer 拉 CGWindowList 的矩形(同步、便宜),几何没变
///     就什么都不做。窗口没了(拿不到矩形)直接熄灯。

/// 光效在最后一次动作后继续亮多久(秒)。短了会在连续动作之间闪烁,长了显得 agent 还在动。
/// 顶层常量而非 static:@MainActor 类型的 static 不能当非隔离上下文里的默认参数(Swift 6 会报错)。
private let highlightLingerSeconds: TimeInterval = 2.0
private let highlightFollowInterval: TimeInterval = 0.125

/// 覆盖层几何(光效与示意光标共用)。抽成顶层纯函数是为了可单测 —— 算错了不会报错,
/// 只会"光标/光效画在看不见的地方",而那种错误只在特定的多屏摆位下出现,人工点验抓不住。
enum OverlayGeometry {
    /// 所有屏幕的并集(AppKit 坐标,主屏左下为原点)。覆盖层必须按它开,否则副屏上的点画在窗口之外。
    static func union(of screenFrames: [CGRect]) -> CGRect {
        screenFrames.reduce(CGRect.null) { $0.union($1) }
    }

    /// 全局 CG 点(左上原点,y 向下)→ 覆盖层内的画布坐标(窗口左上原点,y 向下)。
    ///
    /// 单显示器时 union=(0,0,W,H)、primaryHeight=H,结果**恒等于输入** —— 与只有主屏时的老行为一致。
    /// 多显示器时:副屏在主屏上方 → union.maxY > primaryHeight,y 要相应下移;副屏在左侧 →
    /// union.minX < 0,x 要相应右移。
    static func canvasPoint(_ point: CGPoint, union: CGRect, primaryHeight: CGFloat) -> CGPoint {
        CGPoint(x: point.x - union.minX, y: point.y + union.maxY - primaryHeight)
    }
}

@MainActor
final class AgentHighlight {
    static let shared = AgentHighlight()

    private var overlay: HighlightOverlayWindow?
    private var hideTask: Task<Void, Never>?
    private var followTimer: Timer?
    private var generation: UInt = 0
    private(set) var currentWindowId: UInt32 = 0
    private var currentFrame: CGRect = .zero

    /// 光效外扩多少点(辉光要向外晕开,覆盖层比目标窗口大一圈)。
    private static let pad: CGFloat = 12

    /// 点亮 / 续期(每次 act 调一次)。窗口矩形现查现用,调用方不必提供。
    func show(windowId: UInt32, linger: TimeInterval = highlightLingerSeconds) {
        guard let cgFrame = cgWindowBounds(windowId: windowId) else {
            // 新目标定位不到(窗口刚关、或是没有 CG 窗口的菜单根)。**不能默默返回** ——
            // 那会把光效留在上一个窗口上直到它自己的 linger 到期,等于指着错的窗口说"正在操作这里"。
            if currentWindowId != 0 && currentWindowId != windowId { hide() }
            return
        }
        place(windowId: windowId, cgFrame: cgFrame)

        generation &+= 1
        let mine = generation
        hideTask?.cancel()
        hideTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(linger))
            guard !Task.isCancelled, mine == self.generation else { return }
            self.hide()
        }
        startFollowing()
    }

    func hide() {
        hideTask?.cancel()
        hideTask = nil
        followTimer?.invalidate()
        followTimer = nil
        generation &+= 1
        currentWindowId = 0
        currentFrame = .zero
        guard let window = overlay else { return }
        window.orderOut(nil)
        window.contentView = nil
        window.close()
        overlay = nil
    }

    /// 摆位(不续期):show 与跟随 timer 共用。
    private func place(windowId: UInt32, cgFrame: CGRect) {
        guard cgFrame.width > 1, cgFrame.height > 1 else { return }
        let appKitFrame = AgentHighlight.toAppKit(cgFrame).insetBy(dx: -AgentHighlight.pad, dy: -AgentHighlight.pad)
        let window = ensureWindow()
        // 只有几何真变了才动窗口 —— 不变时 setFrame 也会触发一次重绘。
        if currentWindowId != windowId || !AgentHighlight.nearlyEqual(currentFrame, appKitFrame) {
            currentWindowId = windowId
            currentFrame = appKitFrame
            window.setFrame(appKitFrame, display: true)
        }
        if !window.isVisible { window.orderFrontRegardless() }
        // 悬在目标窗口正上方:目标之上的其他窗口仍然正常盖住光效。
        window.order(.above, relativeTo: Int(windowId))
    }

    private func startFollowing() {
        guard followTimer == nil else { return }
        let timer = Timer(timeInterval: highlightFollowInterval, repeats: true) { _ in
            Task { @MainActor in AgentHighlight.shared.followTick() }
        }
        // .common:拖窗口/滚动时主 runloop 进 tracking mode,default mode 的 timer 会整个停掉 ——
        // 而"用户拖窗口"恰好是最需要跟随的时刻。
        RunLoop.main.add(timer, forMode: .common)
        followTimer = timer
    }

    private func followTick() {
        let id = currentWindowId
        guard overlay != nil, id != 0 else {
            followTimer?.invalidate()
            followTimer = nil
            return
        }
        guard let cgFrame = cgWindowBounds(windowId: id) else {
            hide() // 窗口关了/最小化了,别把光效留在原地
            return
        }
        place(windowId: id, cgFrame: cgFrame)
    }

    var isVisible: Bool { overlay?.isVisible == true }

    private func ensureWindow() -> HighlightOverlayWindow {
        if let overlay { return overlay }
        let window = HighlightOverlayWindow(
            contentRect: .zero,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: HighlightView(inset: AgentHighlight.pad))
        overlay = window
        return window
    }

    /// CG 全局坐标(左上原点)→ AppKit 全局坐标(主屏左下原点)。
    /// 主屏 = NSScreen.screens.first,**不是** NSScreen.main(后者是"当前有键盘焦点的屏")。
    /// 拆出纯函数版是为了可测:算错就是整块光效系统性偏移一个屏高,肉眼在单屏下还未必看得出来。
    nonisolated static func toAppKit(_ rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    static func toAppKit(_ rect: CGRect) -> CGRect {
        toAppKit(rect, primaryHeight: NSScreen.screens.first?.frame.height ?? 0)
    }

    nonisolated static func nearlyEqual(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) < 0.5 && abs(a.minY - b.minY) < 0.5
            && abs(a.width - b.width) < 0.5 && abs(a.height - b.height) < 0.5
    }
}

/// 按 CG 窗口号取窗口矩形(CG 全局坐标,左上原点)。
/// 顶层函数而非 Bridge 方法:AgentHighlight 是 @MainActor 单例,不该为了拿个矩形去持有 Bridge。
/// 只用 CGWindowList(同步、便宜),不碰 ScreenCaptureKit —— 8Hz 跟随经不起异步捕获那条路。
func cgWindowBounds(windowId: UInt32) -> CGRect? {
    let ids = [NSNumber(value: windowId)] as CFArray
    guard let entries = CGWindowListCreateDescriptionFromArray(ids) as? [[String: Any]],
        let entry = entries.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowId }),
        let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
        let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
    else { return nil }
    return bounds
}

/// 点击穿透、永不成为 key/main 的覆盖层。
private final class HighlightOverlayWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: styleMask, backing: backing, defer: flag)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
    }
}

/// 静态辉光边框:由外到内几道圆角描边,越外越淡 —— 一次绘制,不动画。
/// 颜色与 AgentCursor 同源(#FF7818),视觉上是同一个"agent 正在动手"的信号。
private struct HighlightView: View {
    let inset: CGFloat

    private static let accent = Color(red: 1, green: 0x78 / 255, blue: 0x18 / 255)
    /// (相对边框中心线的外扩量, 线宽, 不透明度)
    private static let rings: [(CGFloat, CGFloat, Double)] = [
        (7, 10, 0.10),
        (3.5, 7, 0.22),
        (0, 3, 0.85),
    ]

    var body: some View {
        Canvas { graphics, size in
            let base = CGRect(x: inset, y: inset, width: max(0, size.width - inset * 2), height: max(0, size.height - inset * 2))
            guard base.width > 2, base.height > 2 else { return }
            for (spread, width, opacity) in HighlightView.rings {
                let rect = base.insetBy(dx: -spread, dy: -spread)
                let path = Path(roundedRect: rect, cornerRadius: 12 + spread)
                graphics.stroke(path, with: .color(HighlightView.accent.opacity(opacity)), lineWidth: width)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}
