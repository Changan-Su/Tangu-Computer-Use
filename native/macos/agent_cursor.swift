import AppKit
import SwiftUI

/// Visual-only cursor; native action delivery remains authoritative.
@MainActor
final class AgentCursor {
    typealias IdleHideScheduler = @MainActor (@escaping @MainActor () -> Void) -> Task<Void, Never>

    static let shared = AgentCursor(scheduleIdleHide: scheduleDefaultIdleHide)

    private var overlay: AgentCursorOverlayWindow?
    private var idleHideTask: Task<Void, Never>?
    private var idleGeneration: UInt = 0
    private let scheduleIdleHide: IdleHideScheduler

    init(scheduleIdleHide: @escaping IdleHideScheduler) {
        self.scheduleIdleHide = scheduleIdleHide
    }

    /// `above` 这个标签是上游的,但**跨进程的相对排序已经做不到了**(见下面被删掉的那行),
    /// 现在完全靠 window level 置顶。参数名留成 `_` 以免有人以为传进来的窗口号还起作用。
    func animate(to point: CGPoint, above _: UInt32) {
        idleHideTask?.cancel()
        idleHideTask = nil
        idleGeneration &+= 1

        let window = ensureWindow()
        // Tangu 补丁:覆盖层必须横跨**所有**屏幕,并且每次都重新对齐 —— 显示器可能中途插拔/改摆位。
        // 上游只开主屏那么大(见 ensureWindow),于是副屏上的点击把光标画到了覆盖层之外 = 用户看不见,
        // 报上来就是"辅助鼠标还是没有出现"。渲染器吃的是画布局部坐标,所以点也要跟着换算。
        let bounds = Self.overlayBounds()
        if window.frame != bounds.union { window.setFrame(bounds.union, display: false) }
        if !window.isVisible { window.orderFrontRegardless() }
        // ⚠️上游这里是 window.order(.above, relativeTo: Int(windowId)) —— 对**别的进程**的 window number
        // 是空操作(实测:窗口既不上移也不消失),它只在同一 App 自己的窗口之间有意义。
        // 跨进程置顶只能靠 window level,见 AgentCursorOverlayWindow.init。

        let local = OverlayGeometry.canvasPoint(point, union: bounds.union, primaryHeight: bounds.primaryHeight)
        let renderer = AgentCursorRenderer.shared
        if renderer.position.x < -100 {
            let frame = CGRect(origin: .zero, size: bounds.union.size)
            renderer.setInitialPosition(CGPoint(
                x: min(max(local.x - 140, frame.minX + 2), frame.maxX - 2),
                y: min(max(local.y - 140, frame.minY + 2), frame.maxY - 2)
            ))
        }
        renderer.moveTo(point: local)

        let generation = idleGeneration
        idleHideTask = scheduleIdleHide { [weak self, weak window] in
            guard let self, let window else { return }
            guard generation == idleGeneration, self.overlay === window else { return }

            renderer.cancelAnimation()
            window.orderOut(nil)
            window.contentView = nil
            window.close()
            overlay = nil
            idleHideTask = nil
        }
    }

    private static func scheduleDefaultIdleHide(_ hide: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled else { return }
            hide()
        }
    }

    /// 所有屏幕的并集 + 主屏高度(全局 CG 坐标换算要用)。没有屏幕时退化成零矩形。
    static func overlayBounds() -> (union: CGRect, primaryHeight: CGFloat) {
        let frames = NSScreen.screens.map(\.frame)
        let union = OverlayGeometry.union(of: frames)
        // ⚠️主屏 = frame 原点在 (0,0) 的那块(全局 CG 坐标的原点就定在它的左上角),**不是** NSScreen.main
        // (那是"当前有 key window 的那块",会跟着焦点跑)、也不保证是 screens.first。
        let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens.first
        return (union.isNull ? .zero : union, primary?.frame.height ?? union.height)
    }

    private func ensureWindow() -> AgentCursorOverlayWindow {
        if let overlay { return overlay }
        let window = AgentCursorOverlayWindow(
            contentRect: Self.overlayBounds().union,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: AgentCursorView())
        overlay = window
        return window
    }
}

/// Click-through overlay spanning every display; can never take focus.
private final class AgentCursorOverlayWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: styleMask, backing: backing, defer: flag)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        // Tangu 补丁:跨进程置顶只能靠 level(order(.above, relativeTo: 外部窗口号) 是空操作)。
        // 取「能盖住 agent 会碰到的一切」的**最低**档:比光效(.floating=3)高,比目标 App 自己弹的
        // 菜单(.popUpMenu=101)高一档 —— 指针指到哪儿是最关键的信息,菜单项被点时尤其不能被挡。
        // ⚠️别调到 .screenSaver(1000):那会连屏保、系统警告一起盖住,而光标最长要停留 8 秒。
        level = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue + 1)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
    }
}

@MainActor
private struct AgentCursorView: View {
    @Bindable private var renderer = AgentCursorRenderer.shared

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 120.0, paused: !renderer.isAnimating)) { context in
            Canvas { graphics, _ in
                renderer.tick(now: context.date.timeIntervalSinceReferenceDate)
                drawCursor(in: graphics)
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }

    private func drawCursor(in graphics: GraphicsContext) {
        let point = renderer.position
        guard point.x > -100 else { return }

        let bloom = Color(nsColor: NSColor(red: 1, green: 0x78 / 255, blue: 0x18 / 255, alpha: 1))
        let radius: CGFloat = 22
        graphics.fill(
            Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)),
            with: .radialGradient(
                Gradient(colors: [bloom.opacity(0.55), bloom.opacity(0.15), bloom.opacity(0)]),
                center: point,
                startRadius: 0,
                endRadius: radius
            )
        )

        let points = [
            CGPoint(x: 14, y: 0),
            CGPoint(x: -8, y: -9),
            CGPoint(x: -3, y: 0),
            CGPoint(x: -8, y: 9),
        ]
        var shape = Path()
        for index in points.indices {
            let previous = points[(index + points.count - 1) % points.count]
            let current = points[index]
            let next = points[(index + 1) % points.count]
            let entry = CGPoint(x: current.x + (previous.x - current.x) * 0.16, y: current.y + (previous.y - current.y) * 0.16)
            let exit = CGPoint(x: current.x + (next.x - current.x) * 0.16, y: current.y + (next.y - current.y) * 0.16)
            if index == points.startIndex { shape.move(to: entry) } else { shape.addLine(to: entry) }
            shape.addQuadCurve(to: exit, control: current)
        }
        shape.closeSubpath()

        let transformed = shape.applying(
            CGAffineTransform(translationX: point.x, y: point.y)
                .rotated(by: CGFloat(renderer.heading + .pi))
        )
        graphics.fill(
            transformed,
            with: .linearGradient(
                Gradient(colors: [
                    Color(red: 1, green: 0xD0 / 255, blue: 0x76 / 255),
                    Color(red: 1, green: 0x78 / 255, blue: 0x18 / 255),
                    Color(red: 0xE8 / 255, green: 0x4A / 255, blue: 0x0C / 255),
                ]),
                startPoint: CGPoint(x: point.x + 14, y: point.y - 9),
                endPoint: CGPoint(x: point.x - 8, y: point.y + 9)
            )
        )
        graphics.stroke(transformed, with: .color(.white), lineWidth: 2)
    }
}
