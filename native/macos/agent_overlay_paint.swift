import CoreGraphics
import Foundation

// 叠层的画法(Tangu,协议 20,非上游):**(状态, 配色, 时刻) → CGContext 上的笔画**,纯函数。
//
// 屏上的 SwiftUI Canvas 经 `GraphicsContext.withCGContext` 调这里;`npm run check:cursor` 的离屏测试程序
// 在 CGBitmapContext 上调同一套 —— 测的就是屏上那一份,不是另画一套。坐标一律是画布坐标(左上原点、y 向下),
// 离屏那边先把 CTM 翻成 y 向下再调。
//
// 不依赖 AppKit / SwiftUI:离屏测试只编这个文件 + agent_overlay_model.swift + agent_cursor_motion.swift。

enum OverlayPaint {
    static func color(_ rgb: OverlayRGB, _ alpha: Double) -> CGColor {
        CGColor(srgbRed: CGFloat(rgb.r), green: CGFloat(rgb.g), blue: CGFloat(rgb.b), alpha: CGFloat(max(0, min(1, alpha))))
    }

    // MARK: 光标

    /// 箭头外形(形状坐标:箭尖在 (14, 0),朝 +x;画的时候旋转 heading + π)。形状不换(方案「我替你定的细节」)。
    static let cursorTip = CGPoint(x: 14, y: 0)
    static let cursorShape: CGPath = {
        let points = [CGPoint(x: 14, y: 0), CGPoint(x: -8, y: -9), CGPoint(x: -3, y: 0), CGPoint(x: -8, y: 9)]
        let path = CGMutablePath()
        for index in points.indices {
            let previous = points[(index + points.count - 1) % points.count]
            let current = points[index]
            let next = points[(index + 1) % points.count]
            let entry = CGPoint(x: current.x + (previous.x - current.x) * 0.16, y: current.y + (previous.y - current.y) * 0.16)
            let exit = CGPoint(x: current.x + (next.x - current.x) * 0.16, y: current.y + (next.y - current.y) * 0.16)
            if index == points.startIndex { path.move(to: entry) } else { path.addLine(to: entry) }
            path.addQuadCurve(to: exit, control: current)
        }
        path.closeSubpath()
        return path
    }()

    /// 光标本体在画布上的变换:平移到位置、转到朝向,再绕箭尖摆动和缩放(箭尖始终对着落点)。
    static func cursorTransform(_ frame: CursorFrame, offset: CGSize = .zero) -> CGAffineTransform {
        var t = CGAffineTransform(translationX: frame.pose.point.x + offset.width, y: frame.pose.point.y + offset.height)
        t = t.rotated(by: CGFloat(frame.pose.heading + .pi))
        t = t.translatedBy(x: cursorTip.x, y: cursorTip.y)
        t = t.rotated(by: CGFloat(frame.wobble))
        t = t.scaledBy(x: CGFloat(frame.scale), y: CGFloat(frame.scale))
        t = t.translatedBy(x: -cursorTip.x, y: -cursorTip.y)
        return t
    }

    /// 箭尖在画布上的位置(测试用来核对「箭尖对准落点」)。
    static func cursorTipPoint(_ frame: CursorFrame) -> CGPoint {
        cursorTip.applying(cursorTransform(frame))
    }

    /// 光标:柔光(半径 14,0.34 → 0.10 → 0)+ 轻投影(0,1 / 模糊 1.5 / 黑 0.32)+ 渐变填色(尖端混 28% 白、
    /// 尾部混 18% 黑)+ 2pt 对比描边。出现时带一点模糊。
    static func drawCursor(_ ctx: CGContext, frame: CursorFrame, palette: OverlayPalette) {
        guard frame.visible, frame.opacity > 0.001 else { return }
        ctx.saveGState()
        ctx.setAlpha(CGFloat(frame.opacity))
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)

        // 柔光(跟着本体缩放,不跟着摆)。
        let center = CGPoint(x: frame.pose.point.x, y: frame.pose.point.y)
        let radius = 14 * CGFloat(frame.scale)
        if let bloom = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [
            color(palette.fill, 0.34), color(palette.fill, 0.10), color(palette.fill, 0),
        ] as CFArray, locations: [0, 0.5, 1]) {
            ctx.drawRadialGradient(bloom, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
        }

        // 轻投影:往下 1pt 的一份黑色外形,四周再补几份做 1.5pt 的模糊。
        ctx.saveGState()
        ctx.setAlpha(0.32)
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        for (dx, dy, alpha) in [(0.0, 0.0, 0.7), (0.75, 0, 0.3), (-0.75, 0, 0.3), (0, 0.75, 0.3), (0, -0.75, 0.3)] {
            fillShape(ctx, transform: cursorTransform(frame, offset: CGSize(width: dx, height: 1 + dy)), color: color(.black, alpha))
        }
        ctx.endTransparencyLayer()
        ctx.restoreGState()

        // 本体。模糊 = 在半径 blur 的一圈上叠几份(纯 CG,离屏和屏上一致)。
        let taps: [CGSize] = frame.blur > 0.25
            ? [.zero] + (0..<8).map { i in
                let a = Double(i) * .pi / 4
                return CGSize(width: cos(a) * frame.blur, height: sin(a) * frame.blur)
            }
            : [.zero]
        let tapAlpha = taps.count > 1 ? 0.28 : 1.0
        for tap in taps {
            ctx.saveGState()
            ctx.setAlpha(CGFloat(tapAlpha))
            drawCursorBody(ctx, transform: cursorTransform(frame, offset: tap), palette: palette)
            ctx.restoreGState()
        }

        ctx.endTransparencyLayer()
        ctx.restoreGState()
    }

    private static func fillShape(_ ctx: CGContext, transform: CGAffineTransform, color: CGColor) {
        var t = transform
        guard let path = cursorShape.copy(using: &t) else { return }
        ctx.addPath(path)
        ctx.setFillColor(color)
        ctx.fillPath()
    }

    private static func drawCursorBody(_ ctx: CGContext, transform: CGAffineTransform, palette: OverlayPalette) {
        var t = transform
        guard let path = cursorShape.copy(using: &t) else { return }
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()
        if let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [
            color(palette.fill.mixed(with: .white, 0.28), 1), color(palette.fill, 1), color(palette.fill.mixed(with: .black, 0.18), 1),
        ] as CFArray, locations: [0, 0.5, 1]) {
            ctx.drawLinearGradient(gradient, start: cursorTip.applying(transform), end: CGPoint(x: -8, y: 0).applying(transform), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
        ctx.restoreGState()
        ctx.addPath(path)
        ctx.setStrokeColor(color(palette.edge, 1))
        ctx.setLineWidth(2)
        ctx.setLineJoin(.round)
        ctx.strokePath()
    }

    // MARK: 效果

    /// 点击环:2.5pt 填色线,内外各一道 1pt 对比色(0.5)。
    static func drawRing(_ ctx: CGContext, _ ring: RingFrame, palette: OverlayPalette) {
        guard ring.opacity > 0.001 else { return }
        let r = CGFloat(ring.diameter / 2)
        func circle(_ radius: CGFloat, width: CGFloat, color c: CGColor) {
            guard radius > 0 else { return }
            ctx.addEllipse(in: CGRect(x: ring.center.x - radius, y: ring.center.y - radius, width: radius * 2, height: radius * 2))
            ctx.setStrokeColor(c)
            ctx.setLineWidth(width)
            ctx.strokePath()
        }
        circle(r + 1.75, width: 1, color: color(palette.edge, 0.5 * ring.opacity))
        circle(r - 1.75, width: 1, color: color(palette.edge, 0.5 * ring.opacity))
        circle(r, width: 2.5, color: color(palette.fill, ring.opacity))
    }

    /// 拖动轨迹:2pt 填色(0.4)。底下垫一道很淡的对比色,近白的填色落在浅色窗口上也看得见。
    static func drawTrail(_ ctx: CGContext, points: [CGPoint], opacity: Double, palette: OverlayPalette) {
        guard points.count > 1, opacity > 0.001 else { return }
        ctx.saveGState()
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        ctx.addLines(between: points)
        ctx.setStrokeColor(color(palette.edge, opacity * 0.35))
        ctx.setLineWidth(3.5)
        ctx.strokePath()
        ctx.addLines(between: points)
        ctx.setStrokeColor(color(palette.fill, opacity))
        ctx.setLineWidth(2)
        ctx.strokePath()
        ctx.restoreGState()
    }

    /// 滚动小箭头:8pt 宽的人字,线宽 2,顺方向。
    static func drawArrow(_ ctx: CGContext, center: CGPoint, direction: CGVector, opacity: Double, palette: OverlayPalette) {
        guard opacity > 0.001 else { return }
        let d = CGPoint(x: direction.dx, y: direction.dy)
        let perp = CGPoint(x: -d.y, y: d.x)
        let tip = CGPoint(x: center.x + d.x * 3, y: center.y + d.y * 3)
        let wingA = CGPoint(x: center.x - d.x * 3 + perp.x * 4, y: center.y - d.y * 3 + perp.y * 4)
        let wingB = CGPoint(x: center.x - d.x * 3 - perp.x * 4, y: center.y - d.y * 3 - perp.y * 4)
        ctx.saveGState()
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        for (c, width) in [(color(palette.edge, opacity * 0.5), CGFloat(3.5)), (color(palette.fill, opacity), CGFloat(2))] {
            ctx.addLines(between: [wingA, tip, wingB])
            ctx.setStrokeColor(c)
            ctx.setLineWidth(width)
            ctx.strokePath()
        }
        ctx.restoreGState()
    }

    /// 输入框描边:2pt 填色(0.88)+ 外侧 1pt 对比色(0.42)+ 更外一圈 3pt 填色(0.2)。
    static func drawField(_ ctx: CGContext, rect: CGRect, opacity: Double, palette: OverlayPalette) {
        guard opacity > 0.001, rect.width > 1, rect.height > 1 else { return }
        for (spread, width, c) in [
            (CGFloat(4.5), CGFloat(3), color(palette.fill, 0.2 * opacity)),
            (CGFloat(2.5), CGFloat(1), color(palette.edge, 0.42 * opacity)),
            (CGFloat(1), CGFloat(2), color(palette.fill, 0.88 * opacity)),
        ] {
            ctx.addPath(roundedRect(rect.insetBy(dx: -spread, dy: -spread), radius: 5 + spread))
            ctx.setStrokeColor(c)
            ctx.setLineWidth(width)
            ctx.strokePath()
        }
    }

    /// 整张光标画布在 t 时刻:输入框描边、拖动线、点击环、滚动箭头,最上面是光标。
    static func drawCursorScene(_ ctx: CGContext, scene: CursorScene, palette: OverlayPalette, at t: Double) {
        for field in scene.fields {
            if let opacity = field.opacity(at: t) { drawField(ctx, rect: field.rect, opacity: opacity, palette: palette) }
        }
        for trail in scene.trails {
            if let frame = trail.frame(at: t) { drawTrail(ctx, points: frame.points, opacity: frame.opacity, palette: palette) }
        }
        for ring in scene.rings {
            if let frame = ring.frame(at: t) { drawRing(ctx, frame, palette: palette) }
        }
        for arrow in scene.arrows {
            for frame in arrow.frames(at: t) {
                drawArrow(ctx, center: frame.center, direction: arrow.direction, opacity: frame.opacity, palette: palette)
            }
        }
        drawCursor(ctx, frame: scene.cursorFrame(at: t), palette: palette)
    }

    // MARK: 边缘光

    /// (相对边框中心线的外扩量, 线宽, 不透明度):三道环几何不变,颜色换成填色。
    static let highlightRings: [(CGFloat, CGFloat, Double)] = [(7, 10, 0.10), (3.5, 7, 0.22), (0, 3, 0.85)]

    /// 边缘光:三道填色环,实线外侧多一道 1pt 对比色(0.42);整体乘 opacity(动手 1.0 / 在想 0.45 / 淡出)。
    static func drawHighlight(_ ctx: CGContext, size: CGSize, inset: CGFloat, palette: OverlayPalette, opacity: Double) {
        guard opacity > 0.001 else { return }
        let base = CGRect(x: inset, y: inset, width: max(0, size.width - inset * 2), height: max(0, size.height - inset * 2))
        guard base.width > 2, base.height > 2 else { return }
        for (spread, width, alpha) in highlightRings {
            ctx.addPath(roundedRect(base.insetBy(dx: -spread, dy: -spread), radius: 12 + spread))
            ctx.setStrokeColor(color(palette.fill, alpha * opacity))
            ctx.setLineWidth(width)
            ctx.strokePath()
        }
        ctx.addPath(roundedRect(base.insetBy(dx: -2, dy: -2), radius: 14))
        ctx.setStrokeColor(color(palette.edge, 0.42 * opacity))
        ctx.setLineWidth(1)
        ctx.strokePath()
    }

    /// CGPath 的圆角超过半边长会断言崩溃,先夹住。
    static func roundedRect(_ rect: CGRect, radius: CGFloat) -> CGPath {
        let r = max(0, min(radius, rect.width / 2, rect.height / 2))
        return CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
    }
}
