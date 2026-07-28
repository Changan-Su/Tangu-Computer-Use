import AppKit
import CoreGraphics
import Foundation

/// 边缘光效里唯一「算错了肉眼未必看得出来」的部分:CG(左上原点)↔ AppKit(主屏左下原点)坐标换算。
/// 单屏、窗口居中时偏一个屏高会直接飞出屏幕(看得见);但多屏或窗口贴边时会变成"贴在别的窗口上",
/// 那种错误只在特定几何下出现,靠人工点验抓不住 —— 所以钉一组已知答案。
@main
struct AgentHighlightTests {
    static func main() {
        // ── 覆盖层几何(示意光标的"看不见"就出在这儿:覆盖层只开了主屏那么大)──
        let primary = CGRect(x: 0, y: 0, width: 1600, height: 1000)
        // 单屏:并集就是主屏,换算必须是恒等 —— 否则老的单屏行为就被改坏了
        expect(
            OverlayGeometry.union(of: [primary]) == primary,
            "单屏时并集应等于主屏"
        )
        expect(
            OverlayGeometry.canvasPoint(CGPoint(x: 300, y: 400), union: primary, primaryHeight: 1000)
                == CGPoint(x: 300, y: 400),
            "单屏时全局点到画布点必须是恒等换算"
        )

        // 副屏在主屏**右侧**:x 不变,y 也不变(并集顶边仍是主屏顶边)
        let right = CGRect(x: 1600, y: 0, width: 1920, height: 1080)
        let unionRight = OverlayGeometry.union(of: [primary, right])
        expect(unionRight == CGRect(x: 0, y: 0, width: 3520, height: 1080), "并集应横向扩到两屏,高度取更高的那块")
        // 副屏更高 → 并集顶边比主屏顶边高 80,全局 CG 的 y(从主屏顶边算)必须相应下移
        expect(
            OverlayGeometry.canvasPoint(CGPoint(x: 2000, y: 500), union: unionRight, primaryHeight: 1000)
                == CGPoint(x: 2000, y: 580),
            "右侧副屏更高时,画布 y 应比全局 y 多出并集顶边高出主屏的那 80"
        )

        // 副屏在主屏**左侧**:union.minX 为负,x 必须右移,否则画到覆盖层左边界之外(看不见)
        let left = CGRect(x: -1920, y: 0, width: 1920, height: 1080)
        let unionLeft = OverlayGeometry.union(of: [primary, left])
        expect(
            OverlayGeometry.canvasPoint(CGPoint(x: -500, y: 200), union: unionLeft, primaryHeight: 1000)
                == CGPoint(x: 1420, y: 200 + unionLeft.maxY - 1000),
            "副屏在左时 x 必须补上并集原点的负偏移"
        )

        // 副屏在主屏**上方**:并集顶边高过主屏顶边,y 必须下移
        let above = CGRect(x: 0, y: 1000, width: 1600, height: 900)
        let unionAbove = OverlayGeometry.union(of: [primary, above])
        expect(unionAbove.maxY == 1900, "上方副屏应把并集顶边抬到 1900")
        expect(
            OverlayGeometry.canvasPoint(CGPoint(x: 100, y: 50), union: unionAbove, primaryHeight: 1000)
                == CGPoint(x: 100, y: 950),
            "副屏在上时 y 必须下移一个副屏高度"
        )

        let primaryHeight: CGFloat = 1000

        // 顶到主屏顶部的窗口:CG y=0 → AppKit y = 屏高 - 窗高
        expect(
            AgentHighlight.toAppKit(CGRect(x: 10, y: 0, width: 300, height: 200), primaryHeight: primaryHeight)
                == CGRect(x: 10, y: 800, width: 300, height: 200),
            "窗口贴主屏顶部时,AppKit y 应为 屏高-窗高"
        )

        // 坐在主屏底部:CG maxY == 屏高 → AppKit y = 0
        expect(
            AgentHighlight.toAppKit(CGRect(x: 0, y: 800, width: 300, height: 200), primaryHeight: primaryHeight)
                == CGRect(x: 0, y: 0, width: 300, height: 200),
            "窗口贴主屏底部时,AppKit y 应为 0"
        )

        // 副屏在主屏上方:CG y 为负 → AppKit y 大于屏高(合法,不该被夹到 0)
        expect(
            AgentHighlight.toAppKit(CGRect(x: -400, y: -600, width: 300, height: 200), primaryHeight: primaryHeight)
                == CGRect(x: -400, y: 1400, width: 300, height: 200),
            "主屏上方的副屏窗口应换算出大于屏高的 AppKit y,不能夹紧"
        )

        // 宽高不参与换算
        let converted = AgentHighlight.toAppKit(CGRect(x: 5, y: 5, width: 123, height: 456), primaryHeight: primaryHeight)
        expect(converted.width == 123 && converted.height == 456, "换算不得改变尺寸")

        // 抖动阈值:亚像素差算相等(否则每帧都 setFrame 重绘),半像素以上算变化
        expect(
            AgentHighlight.nearlyEqual(CGRect(x: 0, y: 0, width: 10, height: 10), CGRect(x: 0.2, y: 0, width: 10, height: 10)),
            "亚像素抖动应视为未变化"
        )
        expect(
            !AgentHighlight.nearlyEqual(CGRect(x: 0, y: 0, width: 10, height: 10), CGRect(x: 0, y: 0, width: 11, height: 10)),
            "尺寸真变了必须视为变化"
        )

        print("agent highlight geometry checks passed")
    }

    private static func expect(_ condition: Bool, _ message: String) {
        if condition { return }
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}
