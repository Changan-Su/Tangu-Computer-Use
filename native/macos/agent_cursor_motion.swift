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
struct CursorFlight: Equatable {
    let from: CursorPose
    let to: CursorPose
    let start: Double
    let duration: Double
    private let path: DubinsPlannedPath?

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
        let d = duration ?? Self.duration(distance: distance)
        self.duration = d
        path = d > 0 ? Self.route(from: from, to: to, distance: distance) : nil
    }

    /// 路线:带转弯弧线(Dubins),转弯半径从 80 起逐档收小,收到路线不超过直线的 routeStretch 倍为止。
    ///
    /// 半径原来固定 80。箭头只能朝自己指的方向(左上)走,目标不在那个方向时要先掉头、到了再掉回来,
    /// 两次掉头合起来正好多走一整圈(2π × 80 ≈ 503pt),和这一跳有多远无关:邻键 54pt 实际飞 557pt、探出连线 137pt。
    /// 0.7.2 按 200–900 pt/s 慢慢飞(这一圈约 1 秒),看得清;协议 20 把飞行压到 0.18–0.45 s,时长按直线距离给,
    /// 同一圈成了 3000 pt/s 以上的一闪(2026-11-14 真机取样到光标在窗口外面、离线量出上面的数)。
    /// 时长不动(0.18–0.45 s 是定过的,先到再点等的也是它),收的是路线:半径最小到直线距离的 1/10,
    /// 这时多出来的一圈是 2π × 0.1 = 0.63 倍,所以总能收到 routeStretch 以内。顺着箭头朝向的那一跳本来就是直线,不受影响。
    private static func route(from: CursorPose, to: CursorPose, distance: Double) -> DubinsPlannedPath {
        let smallest = max(0.5, distance * 0.1)
        var radius = 80.0
        while true {
            let path = planPath(
                x0: Double(from.point.x), y0: Double(from.point.y), th0: from.heading + .pi,
                x1: Double(to.point.x), y1: Double(to.point.y), th1: to.heading + .pi,
                R: radius, endVisualHeading: to.heading, targetPoint: to.point)
            if path.length <= distance * routeStretch || radius <= smallest { return path }
            radius = max(smallest, radius * 0.7)
        }
    }

    var arrival: Double { start + duration }

    /// 路线总长(不飞时为 0)。测试用它核对路线没有绕远。
    var routeLength: Double { path?.length ?? 0 }
    /// 路线最多是直线距离的几倍。
    static let routeStretch = 1.65

    func pose(at t: Double) -> CursorPose {
        guard let path, duration > 0, t < arrival else { return t < start && duration > 0 ? from : to }
        let u = max(0, min(1, (t - start) / duration))
        let s = path.length * easeInOut(u)
        let state = path.sample(at: s)
        // 起飞头 25% 从原来的朝向转向路径切线,最后 40% 转回停靠角(Dubins 末端切线本来就接近它)。
        var heading = lerpAngle(from.heading, state.heading + .pi, smooth(min(1, u / 0.25)))
        heading = lerpAngle(heading, to.heading, smooth(max(0, (u - 0.6) / 0.4)))
        return CursorPose(point: CGPoint(x: state.x, y: state.y), heading: heading)
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

struct DubinsPlannedPath {
    enum Kind { case dubins, linear }
    let kind: Kind
    let length: Double
    let endVisualHeading: Double
    let targetPoint: CGPoint
    let x0, y0, th0, R, seg1, seg2, seg3: Double
    let types: [Character]
    let x1, y1, th1: Double

    struct State { let x, y, heading: Double }

    func sample(at s: Double) -> State {
        switch kind { case .linear: return sampleLinear(s); case .dubins: return sampleDubins(s) }
    }

    private func sampleLinear(_ s: Double) -> State {
        let u = max(0, min(1, s / length))
        var diff = th1 - th0
        while diff > .pi  { diff -= 2 * .pi }
        while diff < -.pi { diff += 2 * .pi }
        return State(x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u, heading: th0 + diff * u)
    }

    private func sampleDubins(_ sIn: Double) -> State {
        guard sIn > 0 else { return State(x: x0, y: y0, heading: th0) }
        let L1 = seg1 * R, L2 = seg2 * R, L3 = seg3 * R
        let s = min(sIn, L1 + L2 + L3)
        var x = x0, y = y0, th = th0

        func advance(length L: Double, type: Character) {
            if type == "S" { x += cos(th) * L; y += sin(th) * L }
            else {
                let dth = L / R * (type == "L" ? 1.0 : -1.0)
                let perp: Double = (type == "L") ? .pi / 2 : -.pi / 2
                let cx = x + cos(th + perp) * R, cy = y + sin(th + perp) * R
                let ang = atan2(y - cy, x - cx)
                x = cx + cos(ang + dth) * R; y = cy + sin(ang + dth) * R; th += dth
            }
        }
        if s <= L1 { advance(length: s, type: types[0]); return State(x: x, y: y, heading: th) }
        advance(length: L1, type: types[0])
        if s <= L1 + L2 { advance(length: s - L1, type: types[1]); return State(x: x, y: y, heading: th) }
        advance(length: L2, type: types[1])
        advance(length: s - L1 - L2, type: types[2])
        return State(x: x, y: y, heading: th)
    }
}

typealias PlannedPath = DubinsPlannedPath

private func mod2pi(_ x: Double) -> Double {
    let tau = 2 * Double.pi; let r = x - tau * floor(x / tau); return r < 0 ? r + tau : r
}

private struct DubinsSolution { let t, p, q: Double; let types: [Character]; var length: Double { t + p + q } }

private func dubinsLSL(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let tmp0 = d + sin(a) - sin(b)
    let p2 = 2 + d * d - 2 * cos(a - b) + 2 * d * (sin(a) - sin(b))
    guard p2 >= 0 else { return nil }
    let tmp1 = atan2(cos(b) - cos(a), tmp0)
    return DubinsSolution(t: mod2pi(-a + tmp1), p: sqrt(p2), q: mod2pi(b - tmp1), types: ["L","S","L"])
}
private func dubinsRSR(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let tmp0 = d - sin(a) + sin(b)
    let p2 = 2 + d * d - 2 * cos(a - b) + 2 * d * (sin(b) - sin(a))
    guard p2 >= 0 else { return nil }
    let tmp1 = atan2(cos(a) - cos(b), tmp0)
    return DubinsSolution(t: mod2pi(a - tmp1), p: sqrt(p2), q: mod2pi(-b + tmp1), types: ["R","S","R"])
}
private func dubinsLSR(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let p2 = -2 + d * d + 2 * cos(a - b) + 2 * d * (sin(a) + sin(b))
    guard p2 >= 0 else { return nil }
    let p = sqrt(p2)
    let tmp1 = atan2(-cos(a) - cos(b), d + sin(a) + sin(b)) - atan2(-2, p)
    return DubinsSolution(t: mod2pi(-a + tmp1), p: p, q: mod2pi(-mod2pi(b) + tmp1), types: ["L","S","R"])
}
private func dubinsRSL(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let p2 = d * d - 2 + 2 * cos(a - b) - 2 * d * (sin(a) + sin(b))
    guard p2 >= 0 else { return nil }
    let p = sqrt(p2)
    let tmp1 = atan2(cos(a) + cos(b), d - sin(a) - sin(b)) - atan2(2, p)
    return DubinsSolution(t: mod2pi(a - tmp1), p: p, q: mod2pi(b - tmp1), types: ["R","S","L"])
}
private func dubinsRLR(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let tmp = (6 - d * d + 2 * cos(a - b) + 2 * d * (sin(a) - sin(b))) / 8
    guard abs(tmp) <= 1 else { return nil }
    let p = mod2pi(2 * .pi - acos(tmp))
    let t = mod2pi(a - atan2(cos(a) - cos(b), d - sin(a) + sin(b)) + p / 2)
    return DubinsSolution(t: t, p: p, q: mod2pi(a - b - t + p), types: ["R","L","R"])
}
private func dubinsLRL(_ d: Double, _ a: Double, _ b: Double) -> DubinsSolution? {
    let tmp = (6 - d * d + 2 * cos(a - b) + 2 * d * (sin(b) - sin(a))) / 8
    guard abs(tmp) <= 1 else { return nil }
    let p = mod2pi(2 * .pi - acos(tmp))
    let t = mod2pi(-a + atan2(-cos(a) + cos(b), d + sin(a) - sin(b)) + p / 2)
    return DubinsSolution(t: t, p: p, q: mod2pi(mod2pi(b) - a - t + p), types: ["L","R","L"])
}

func planPath(x0: Double, y0: Double, th0: Double,
                      x1: Double, y1: Double, th1: Double,
                      R: Double, endVisualHeading: Double,
                      targetPoint: CGPoint) -> PlannedPath {
    if let p = planDubins(x0: x0, y0: y0, th0: th0, x1: x1, y1: y1, th1: th1,
                          R: R, endVisualHeading: endVisualHeading, targetPoint: targetPoint) {
        return p
    }
    let D = max(1, hypot(x1 - x0, y1 - y0))
    return PlannedPath(kind: .linear, length: D, endVisualHeading: endVisualHeading,
                       targetPoint: targetPoint, x0: x0, y0: y0, th0: th0, R: R,
                       seg1: 0, seg2: 0, seg3: 0, types: [], x1: x1, y1: y1, th1: th1)
}

private func planDubins(x0: Double, y0: Double, th0: Double,
                        x1: Double, y1: Double, th1: Double,
                        R: Double, endVisualHeading: Double,
                        targetPoint: CGPoint) -> PlannedPath? {
    let dx = x1 - x0, dy = y1 - y0, D = hypot(dx, dy)
    guard D > 0.5 else { return nil }
    let d = D / R, theta = mod2pi(atan2(dy, dx))
    let a = mod2pi(th0 - theta), b = mod2pi(th1 - theta)
    let solvers: [(Double, Double, Double) -> DubinsSolution?] = [
        dubinsLSL, dubinsRSR, dubinsLSR, dubinsRSL, dubinsRLR, dubinsLRL,
    ]
    var best: DubinsSolution?; var bestLen = Double.infinity
    for s in solvers {
        if let sol = s(d, a, b), sol.length.isFinite, sol.length >= 0, sol.length < bestLen {
            bestLen = sol.length; best = sol
        }
    }
    guard let b = best else { return nil }
    return PlannedPath(kind: .dubins, length: (b.t + b.p + b.q) * R,
                       endVisualHeading: endVisualHeading, targetPoint: targetPoint,
                       x0: x0, y0: y0, th0: th0, R: R,
                       seg1: b.t, seg2: b.p, seg3: b.q, types: b.types,
                       x1: x1, y1: y1, th1: th1)
}
