import CoreGraphics
import Foundation

/// 光标的一个姿态:位置(画布坐标,左上原点、y 向下)+ 朝向(弧度,画箭头时旋转 heading + π)。
struct CursorPose: Equatable {
    var point: CGPoint
    var heading: Double

    /// 外形里箭尖到本体中心的距离(OverlayPaint.cursorShape 的箭尖就画在这里)。
    static let tipReach: Double = 14
    /// 落点(箭尖要对准的那一点)→ 光标停靠的位置。箭头是斜 45° 停的,本体中心在箭尖右下 tipReach 处。
    /// 这个距离必须和外形里的箭尖是同一个数:原来这里写死 16、外形的箭尖在 14,停稳后箭尖离落点差 2pt
    /// (2026-11-14 真机上连圆角和投影量到约 4pt,箭尖没落在点击环的圆心上)。
    static let restHeading = Double.pi / 4
    static func resting(atTip tip: CGPoint) -> CursorPose {
        CursorPose(point: CGPoint(x: tip.x + CGFloat(cos(restHeading) * tipReach), y: tip.y + CGFloat(sin(restHeading) * tipReach)), heading: restHeading)
    }
}

/// 一段飞行,**位置是时间的纯函数**(Tangu,协议 20):起点、终点、起飞时刻、时长 → 任意时刻的姿态。
///
/// 以前的飞行靠 SwiftUI 每帧 tick 推进(按速度曲线积分 + 弹簧收尾),窗口没在渲染就永远到不了,
/// 也没人知道「什么时候到」。现在重绘只是取样;到达时刻 = start + duration,调用方可以直接算出来。
///
/// 路线是起点到终点的直线,朝向从起飞时的朝向平滑转到停靠角 —— 停着起飞时两者相同,一路不转,像真鼠标那样平移过去。
/// 原来按 Dubins 曲线开(箭头只能朝自己指的方向走):箭头停着指向左上,别的方向都要先掉头、到了再掉回来。
/// 半径固定 80 时邻键 54pt 实际飞 557pt、探出连线 137pt,0.18 s 里一闪;半径按距离收小后近处不出窗了,
/// 但箭头仍原地转一整圈(邻键 327°、挪 8pt 也 360°),700pt 以上的远跳照样绕(半径下限 = 距离 / 10)。
/// 2026-11-14 四版并排的试玩页(docs/ToBeImproved/ComputerUse显示效果方案_2026-11-13/play.html)上选了「直线、不转头」。
struct CursorFlight: Equatable {
    let from: CursorPose
    let to: CursorPose
    let start: Double
    let duration: Double
    private let distance: Double

    /// 飞行时长按距离定:1100 pt/s,夹在 0.18–0.45 s;离落点不到 6 pt 就不飞(0)。
    static func duration(distance: Double) -> Double {
        guard distance.isFinite, distance >= 6 else { return 0 }
        return min(0.45, max(0.18, distance / 1100))
    }

    init(from: CursorPose, to: CursorPose, start: Double, duration: Double? = nil) {
        self.from = from
        self.to = to
        self.start = start
        let distance = Double(hypot(to.point.x - from.point.x, to.point.y - from.point.y))
        self.distance = distance
        self.duration = duration ?? Self.duration(distance: distance)
    }

    var arrival: Double { start + duration }

    /// 路线总长(不飞时为 0):就是起终点的直线距离。测试用它核对路线没有绕远。
    var routeLength: Double { duration > 0 ? distance : 0 }

    func pose(at t: Double) -> CursorPose {
        guard duration > 0, t < arrival else { return t < start && duration > 0 ? from : to }
        let u = max(0, min(1, (t - start) / duration))
        let k = easeInOut(u)
        let point = CGPoint(x: from.point.x + (to.point.x - from.point.x) * k, y: from.point.y + (to.point.y - from.point.y) * k)
        return CursorPose(point: point, heading: lerpAngle(from.heading, to.heading, smooth(u)))
    }

    static func == (lhs: CursorFlight, rhs: CursorFlight) -> Bool {
        lhs.from == rhs.from && lhs.to == rhs.to && lhs.start == rhs.start && lhs.duration == rhs.duration
    }
}

/// 拖动时沿路径匀速走(按住的姿态,朝向保持停靠角)。points 是光标位置(已加过箭尖偏移)。
struct CursorPolyline: Equatable {
    let points: [CGPoint]
    let start: Double
    let duration: Double

    /// 拖动路径按 900 pt/s 走,夹在 0.25–0.8 s(纯视觉;真实拖动事件照旧同步投递)。
    static func duration(points: [CGPoint]) -> Double {
        min(0.8, max(0.25, polylineLength(points) / 900))
    }

    var end: Double { start + duration }

    func point(at t: Double) -> CGPoint {
        guard let first = points.first else { return .zero }
        guard points.count > 1, duration > 0 else { return points.last ?? first }
        let u = max(0, min(1, (t - start) / duration))
        return polylinePoint(points, fraction: u)
    }
}

/// 光标的整条运动:若干段首尾相接(飞行 / 拖动),之前停在 rest。
enum CursorMotionSegment: Equatable {
    case flight(CursorFlight)
    case polyline(CursorPolyline)

    var start: Double {
        switch self { case .flight(let f): return f.start; case .polyline(let p): return p.start }
    }
    var end: Double {
        switch self { case .flight(let f): return f.arrival; case .polyline(let p): return p.end }
    }
    func pose(at t: Double) -> CursorPose {
        switch self {
        case .flight(let f): return f.pose(at: t)
        case .polyline(let p): return CursorPose(point: p.point(at: t), heading: CursorPose.restHeading)
        }
    }
}

func polylineLength(_ points: [CGPoint]) -> Double {
    zip(points, points.dropFirst()).reduce(0) { $0 + Double(hypot($1.1.x - $1.0.x, $1.1.y - $1.0.y)) }
}

/// 折线上按弧长比例取点(fraction 0…1)。
func polylinePoint(_ points: [CGPoint], fraction: Double) -> CGPoint {
    guard let first = points.first else { return .zero }
    let total = polylineLength(points)
    guard total > 0 else { return first }
    var remaining = total * max(0, min(1, fraction))
    for (a, b) in zip(points, points.dropFirst()) {
        let length = Double(hypot(b.x - a.x, b.y - a.y))
        if remaining <= length, length > 0 {
            let k = CGFloat(remaining / length)
            return CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k)
        }
        remaining -= length
    }
    return points.last ?? first
}

/// 折线截到 fraction 处(拖动轨迹「走到哪画到哪」)。
func polylinePrefix(_ points: [CGPoint], fraction: Double) -> [CGPoint] {
    guard points.count > 1 else { return points }
    if fraction >= 1 { return points }
    let total = polylineLength(points)
    var remaining = total * max(0, fraction)
    var out = [points[0]]
    for (a, b) in zip(points, points.dropFirst()) {
        let length = Double(hypot(b.x - a.x, b.y - a.y))
        if remaining <= length {
            let k = length > 0 ? CGFloat(remaining / length) : 0
            out.append(CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k))
            return out
        }
        out.append(b)
        remaining -= length
    }
    return out
}

func smooth(_ u: Double) -> Double {
    let x = max(0, min(1, u))
    return x * x * (3 - 2 * x)
}

func easeInOut(_ u: Double) -> Double {
    let x = max(0, min(1, u))
    return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x)
}

func easeOut(_ u: Double) -> Double {
    let x = max(0, min(1, u))
    return 1 - (1 - x) * (1 - x) * (1 - x)
}

func lerpAngle(_ a: Double, _ b: Double, _ k: Double) -> Double {
    var difference = b - a
    while difference > .pi { difference -= 2 * .pi }
    while difference < -.pi { difference += 2 * .pi }
    return a + difference * k
}
