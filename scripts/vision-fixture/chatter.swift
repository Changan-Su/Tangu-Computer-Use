// 微信那一类(无障碍树是空的)的替身:浅色桌面聊天软件。全部自己画,没有控件,
// 无障碍树里只有窗口和标题栏按钮 —— 只能看截图、按坐标点 / 滚 / 打字。给 vision 场景的真模型测试用:
// 「在一堆长得很像的联系人(Sakura / Saku / Sakura 樱花 / 佐藤樱……)里找到对的那个 → 输入一段话 → 发出去」。
// 判定只读状态文件(argv[1],每次变化原子写入):sent 里记着真的发给了谁、发了什么,不信 agent 的自述。
//
// 命令行:<exe> <statePath> [--frame x,y,w,h] [--page <页>] [--sent <文字>] [--behind] [--selftest [--hold]]
//   --frame    整个窗口的位置和大小:全局屏幕点、左上角原点(与 CGWindowList 的 bounds 同一约定)
//   --page     直接开在某页(只给截图冒烟用):list | chat:<联系人> | search:<搜索词>
//   --sent     开场就已经给打开的那个聊天发过这段话(绿色气泡、记进 sent);同样只给截图校准用
//   --behind   窗口放到所有窗口后面:截图走 desktopIndependentWindow 不受遮挡,冒烟时不挡用户的屏幕
//   --selftest 进程内直接调用输入处理函数把流程走一遍(不经系统、不发任何真实输入),结果打到 stdout、写进状态的 selftest;
//              带 --hold 时跑完不退出、把窗口显示出来,给截图看交互之后的样子
// 窗口用 fullSizeContentView:内容铺满整个窗口(红绿灯压在最左边那条图标栏上),所以 content == window 尺寸,
// 画布坐标 = 窗口内坐标(左上角原点)。可点的东西都避开左上角红绿灯(x<76, y<32)。
// 行为照微信:点联系人 = 打开聊天并把光标放进输入框;搜索框里回车 = 打开第一个结果;回车发送,Shift/Option/Cmd+回车换行;
// 切走的聊天里没发的字留作草稿;发出去的那个聊天挪到列表最上面。
// SIGUSR1 = 把窗口收起来(同 main.swift),App 被激活时窗口回来。
import AppKit

// MARK: - 命令行

struct Options {
	var statePath = "/dev/null"
	var frame: NSRect?
	var page: String?
	var sent: String?
	var behind = false, selftest = false, hold = false
}

let options: Options = {
	var o = Options()
	let args = Array(CommandLine.arguments.dropFirst())
	var i = 0
	while i < args.count {
		let arg = args[i], next = i + 1 < args.count ? args[i + 1] : nil
		switch arg {
		case "--frame":
			let n = (next ?? "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
			if n.count == 4 { o.frame = NSRect(x: n[0], y: n[1], width: n[2], height: n[3]) }
			i += 1
		case "--page": o.page = next; i += 1
		case "--sent": o.sent = next; i += 1
		case "--behind": o.behind = true
		case "--selftest": o.selftest = true
		case "--hold": o.hold = true
		default: if i == 0 && !arg.hasPrefix("--") { o.statePath = arg }
		}
		i += 1
	}
	return o
}()

// MARK: - 画图小工具(和 melody.swift 同一套)

func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor { NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a) }
func font(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont { .systemFont(ofSize: size, weight: weight) }
func rectDict(_ r: NSRect) -> [String: Double] {
	func d(_ v: CGFloat) -> Double { (Double(v) * 10).rounded() / 10 }
	return ["x": d(r.minX), "y": d(r.minY), "w": d(r.width), "h": d(r.height)]
}
// ⚠️一律走 NSBezierPath:NSRect.fill() 是 copy 合成,半透明色会把底下抠成透明。
func fill(_ r: NSRect, _ c: NSColor, _ radius: CGFloat = 0) {
	c.setFill()
	(radius > 0 ? NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius) : NSBezierPath(rect: r)).fill()
}
func oval(_ r: NSRect, _ c: NSColor) { c.setFill(); NSBezierPath(ovalIn: r).fill() }
func stroke(_ r: NSRect, _ c: NSColor, _ radius: CGFloat, _ width: CGFloat = 1) {
	c.setStroke()
	let p = NSBezierPath(roundedRect: r.insetBy(dx: width / 2, dy: width / 2), xRadius: radius, yRadius: radius)
	p.lineWidth = width
	p.stroke()
}
func gradient(_ r: NSRect, _ a: NSColor, _ b: NSColor, _ radius: CGFloat, _ angle: CGFloat = 50) {
	NSGradient(starting: a, ending: b)?.draw(in: NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius), angle: angle)
}
func style(_ f: NSFont, _ c: NSColor, _ align: NSTextAlignment = .left, wrap: Bool = false, spacing: CGFloat = 0) -> [NSAttributedString.Key: Any] {
	let p = NSMutableParagraphStyle()
	p.alignment = align
	p.lineBreakMode = wrap ? .byWordWrapping : .byTruncatingTail
	p.lineSpacing = spacing
	return [.font: f, .foregroundColor: c, .paragraphStyle: p]
}
func measure(_ s: String, _ a: [NSAttributedString.Key: Any], width: CGFloat = 10_000) -> NSSize {
	let r = (s as NSString).boundingRect(with: NSSize(width: width, height: 10_000), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: a)
	return NSSize(width: ceil(r.width), height: ceil(r.height))
}
/// 单行字:在 r 里垂直居中,放不下截断加省略号。返回字实际占的框(layout 里记的就是它)。
@discardableResult func label(_ s: String, _ r: NSRect, _ f: NSFont, _ c: NSColor, _ align: NSTextAlignment = .left) -> NSRect {
	let a = style(f, c, align), m = measure(s, a), y = (r.midY - m.height / 2).rounded()
	(s as NSString).draw(with: NSRect(x: r.minX, y: y, width: r.width, height: m.height + 2),
		options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine, .usesFontLeading], attributes: a, context: nil)
	let w = min(m.width, r.width)
	return NSRect(x: align == .center ? r.midX - w / 2 : align == .right ? r.maxX - w : r.minX, y: y, width: w, height: m.height)
}
var symbolCache: [String: NSImage] = [:]
/// SF Symbol 按颜色画在 center 处(画进自绘画布,不产生无障碍节点)。
func symbol(_ name: String, _ center: NSPoint, _ size: CGFloat, _ c: NSColor, _ weight: NSFont.Weight = .regular) {
	let key = "\(name)|\(size)|\(weight.rawValue)|\(c)"
	if symbolCache[key] == nil,
		let base = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: size, weight: weight)) {
		// 单色模板图再按颜色上色:palette 模式会把多层符号的底层也涂满(iphone 会变成一块实心)
		symbolCache[key] = NSImage(size: base.size, flipped: false) { r in
			base.draw(in: r)
			c.set()
			r.fill(using: .sourceAtop)
			return true
		}
	}
	guard let img = symbolCache[key] else { return }
	let s = img.size
	img.draw(in: NSRect(x: (center.x - s.width / 2).rounded(), y: (center.y - s.height / 2).rounded(), width: s.width, height: s.height),
		from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
}

/// 多行输入框:NSLayoutManager 排版,能拿到折行后的光标位置和每一行的框(选中全部时画底色)。
final class TextBox {
	let storage = NSTextStorage(), manager = NSLayoutManager(), container = NSTextContainer(size: .zero)
	init() {
		container.lineFragmentPadding = 0
		manager.addTextContainer(container)
		storage.addLayoutManager(manager)
	}
	func set(_ s: String, _ attrs: [NSAttributedString.Key: Any], width: CGFloat) {
		container.size = NSSize(width: width, height: 100_000)
		storage.setAttributedString(NSAttributedString(string: s, attributes: attrs))
		manager.ensureLayout(for: container)
	}
	var height: CGFloat { max(manager.usedRect(for: container).maxY, manager.extraLineFragmentRect.maxY) }
	func caret(lineHeight: CGFloat) -> NSRect {
		let extra = manager.extraLineFragmentRect
		if storage.length == 0 || extra.height > 0 { return NSRect(x: extra.minX, y: extra.minY, width: 1.5, height: extra.height > 0 ? extra.height : lineHeight) }
		let g = manager.numberOfGlyphs - 1
		let line = manager.lineFragmentRect(forGlyphAt: g, effectiveRange: nil)
		let box = manager.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: container)
		return NSRect(x: min(box.maxX, container.size.width - 1), y: line.minY, width: 1.5, height: line.height)
	}
	func lineRects() -> [NSRect] {
		var rects: [NSRect] = []
		manager.enumerateLineFragments(forGlyphRange: NSRange(location: 0, length: manager.numberOfGlyphs)) { _, used, _, _, _ in rects.append(used) }
		return rects
	}
	func draw(at p: NSPoint) { manager.drawGlyphs(forGlyphRange: NSRange(location: 0, length: manager.numberOfGlyphs), at: p) }
}

// MARK: - 配色(浅色,绿色强调,仿桌面聊天软件)

enum C {
	static let rail = rgb(228, 228, 228), list = rgb(241, 241, 241), chat = rgb(245, 245, 245)
	static let line = rgb(222, 222, 222), sel = rgb(214, 214, 214), field = rgb(226, 226, 226)
	static let text = rgb(25, 25, 25), text2 = rgb(150, 150, 150), text3 = rgb(178, 178, 178), icon = rgb(102, 102, 102)
	static let green = rgb(7, 193, 96), bubbleOut = rgb(149, 236, 105), bubbleIn = rgb(255, 255, 255), red = rgb(250, 81, 81)
	static let selection = rgb(178, 214, 255), link = rgb(87, 107, 149)
}

// MARK: - 内容(全部写死:没有随机、没有真实用户)

enum MsgKind { case text, image, file, voice }
struct Msg {
	let mine: Bool, text: String
	var sender: String? = nil, time: String? = nil, kind = MsgKind.text
	/// 列表预览 / layout 标签里的写法
	var summary: String {
		switch kind {
		case .text: return text
		case .image: return "[图片]"
		case .file: return "[文件] \(text)"
		case .voice: return "[语音] \(text)\""
		}
	}
}
enum ContactKind { case person, group, files, notice, service }
struct Contact {
	let name: String, kind: ContactKind, color: NSColor
	var time: String, unread: Int
	var messages: [Msg]
	var preview: String? = nil
	var initial: String {
		let first = name.prefix(1)
		return first.uppercased() == first.lowercased() ? String(first) : first.uppercased()
	}
}
func me(_ text: String, time: String? = nil, kind: MsgKind = .text) -> Msg { Msg(mine: true, text: text, time: time, kind: kind) }
func them(_ text: String, from sender: String? = nil, time: String? = nil, kind: MsgKind = .text) -> Msg { Msg(mine: false, text: text, sender: sender, time: time, kind: kind) }

// 长得很像的名字是故意的:Sakura / Saku / Sakura 樱花 / 佐藤樱 / 樱子,Sam / Samantha —— agent 得真的读字。
let initialContacts: [Contact] = [
	Contact(name: "项目群 · Forsion", kind: .group, color: rgb(120, 144, 196), time: "14:32", unread: 3, messages: [
		them("接口文档我更新到 v3 了,大家看一下", from: "李雷", time: "13:58"), them("收到,下午我对一下字段", from: "韩梅梅"),
		me("我下午把联调环境搭好"), them("今晚 8 点同步一下进度", from: "王工", time: "14:32"),
	]),
	Contact(name: "文件传输助手", kind: .files, color: rgb(7, 193, 96), time: "14:05", unread: 0, messages: [
		me("周报_第41周.pdf", time: "14:05", kind: .file),
	]),
	Contact(name: "Saku", kind: .person, color: rgb(255, 149, 0), time: "13:47", unread: 0, messages: [
		them("明天的分享会你去吗?", time: "13:40"), me("去的,我们一起"), them("好的,明天见～"),
	]),
	Contact(name: "妈妈", kind: .person, color: rgb(255, 104, 136), time: "12:20", unread: 1, messages: [
		them("降温了,出门多穿点", time: "12:05"), me("知道啦"), them("晚上回来吃饭吗?"),
	]),
	Contact(name: "Sakura 樱花", kind: .person, color: rgb(236, 120, 172), time: "11:58", unread: 0, messages: [
		them("今天拍的晚霞", time: "11:57"), them("", kind: .image),
	]),
	Contact(name: "Sam", kind: .person, color: rgb(80, 136, 250), time: "11:02", unread: 2, messages: [
		me("The build is green on my side", time: "10:48"), them("Did you push the fix?"),
	]),
	Contact(name: "佐藤樱", kind: .person, color: rgb(156, 112, 230), time: "10:15", unread: 0, messages: [
		me("资料我发你邮箱了", time: "10:12"), them("资料收到啦,谢谢!"),
	]),
	Contact(name: "Sakura", kind: .person, color: rgb(240, 128, 120), time: "昨天", unread: 0, messages: [
		them("最近美术馆有个插画展", time: "昨天 21:14"), me("听起来不错,几点开门?"), them("十点,我们早点去人少"), them("周末一起去看展吗?"),
	]),
	Contact(name: "订阅号消息", kind: .notice, color: rgb(66, 133, 244), time: "昨天", unread: -1, messages: [
		them("本周科技简报:端侧模型的三个新进展", time: "昨天 18:30"), them("城市夜跑路线推荐 | 本周六开跑"),
	], preview: "[2条] 城市夜跑路线推荐 | 本周六开跑"),
	Contact(name: "李雷", kind: .person, color: rgb(52, 190, 100), time: "昨天", unread: 0, messages: [
		them("12", time: "昨天 16:02", kind: .voice),
	]),
	Contact(name: "Samantha", kind: .person, color: rgb(0, 166, 170), time: "星期二", unread: 0, messages: [
		them("Thanks for the slides!", time: "星期二 15:20"), them("See you at the meetup"),
	]),
	Contact(name: "樱子", kind: .person, color: rgb(255, 176, 60), time: "星期二", unread: 0, messages: [
		me("照片发你了", time: "星期二 09:41"), them("收到,谢谢!"),
	]),
	Contact(name: "韩梅梅", kind: .person, color: rgb(226, 88, 78), time: "星期一", unread: 0, messages: [
		them("周五聚餐定在老地方,七点", time: "星期一 19:05"),
	]),
	Contact(name: "物业服务中心", kind: .service, color: rgb(255, 140, 40), time: "10/12", unread: 0, messages: [
		them("关于小区停水的通知:本周六 9:00-15:00 二期停水,请提前储水。", time: "10月12日 09:00"),
	]),
]
let allNames = initialContacts.map(\.name)

// MARK: - 画布

enum Field: String { case search, input }

final class Canvas: NSView {
	// 状态
	var contacts: [String: Contact] = Dictionary(uniqueKeysWithValues: initialContacts.map { ($0.name, $0) })
	var order: [String] = allNames
	var contact: String?
	var focus: Field?
	var search = "", input = "", selectAll = false
	var drafts: [String: String] = [:]
	var sent: [[String: Any]] = []
	var listOffset: CGFloat = 0, msgOffset: CGFloat = 0
	var clicks = 0, doubleClicks = 0, scrolls = 0, keys = 0
	var events: [[String: Any]] = []
	var drawn = false
	var extra: [String: Any] = [:]
	let box = TextBox()

	override var isFlipped: Bool { true }
	override var acceptsFirstResponder: Bool { true }
	override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
	override var mouseDownCanMoveWindow: Bool { false }

	// MARK: 几何(画、命中、selftest 共用这一套)

	let railW: CGFloat = 64, listX1: CGFloat = 320, rowH: CGFloat = 64, bottomH: CGFloat = 168
	var W: CGFloat { bounds.width }
	var H: CGFloat { bounds.height }
	var searchRect: NSRect { NSRect(x: railW + 12, y: 32, width: listX1 - railW - 60, height: 28) }
	var clearRect: NSRect { NSRect(x: searchRect.maxX - 24, y: searchRect.minY + 4, width: 20, height: 20) }
	var plusRect: NSRect { NSRect(x: searchRect.maxX + 8, y: 32, width: 28, height: 28) }
	var listTop: CGFloat { search.isEmpty ? 72 : 100 }
	var listView: NSRect { NSRect(x: railW, y: listTop, width: listX1 - railW, height: H - listTop) }
	func rowRect(_ i: Int) -> NSRect { NSRect(x: railW, y: listTop + CGFloat(i) * rowH - listOffset, width: listX1 - railW, height: rowH) }
	func rowRect(_ name: String) -> NSRect? { listed.firstIndex(of: name).map { rowRect($0) } }
	var chatRect: NSRect { NSRect(x: listX1, y: 0, width: W - listX1, height: H) }
	var msgView: NSRect { NSRect(x: listX1, y: 61, width: W - listX1, height: H - bottomH - 61) }
	var inputRect: NSRect { NSRect(x: listX1 + 20, y: H - bottomH + 40, width: W - listX1 - 40, height: 76) }
	var inputRegion: NSRect { NSRect(x: listX1, y: H - bottomH + 36, width: W - listX1, height: bottomH - 36) }
	var sendRect: NSRect { NSRect(x: W - 20 - 96, y: H - 46, width: 96, height: 32) }
	func tabCenter(_ i: Int) -> NSPoint { NSPoint(x: railW / 2, y: 112 + CGFloat(i) * 50) }

	/// 搜索结果:名字完全一样的排最前,再是前缀匹配,再是包含;同一档里保持列表原来的顺序(不区分大小写)。
	var listed: [String] {
		let q = search.trimmingCharacters(in: .whitespaces).lowercased()
		guard !q.isEmpty else { return order }
		let hits = order.filter { $0.lowercased().contains(q) }
		return hits.filter { $0.lowercased() == q } + hits.filter { $0.lowercased() != q && $0.lowercased().hasPrefix(q) } + hits.filter { !$0.lowercased().hasPrefix(q) }
	}
	var maxListOffset: CGFloat { max(0, CGFloat(listed.count) * rowH - listView.height) }

	struct Placed { let msg: Msg, avatar: NSRect, bubble: NSRect, senderY: CGFloat?, timeY: CGFloat? }
	/// 一个聊天里每条消息的位置(相对消息区内容顶端)。画、滚动上限都用它。
	func placed(_ c: Contact) -> (items: [Placed], height: CGFloat) {
		let x0 = listX1, maxText = min(340, (W - listX1) * 0.6)
		var y: CGFloat = 18, out: [Placed] = []
		for m in c.messages {
			var timeY: CGFloat?
			if m.time != nil { timeY = y; y += 34 }
			let showSender = c.kind == .group && !m.mine && m.sender != nil
			var size: NSSize
			switch m.kind {
			case .text: let t = measure(m.text, style(font(14), C.text, wrap: true, spacing: 2), width: maxText); size = NSSize(width: t.width + 24, height: max(36, t.height + 18))
			case .image: size = NSSize(width: 176, height: 118)
			case .file: size = NSSize(width: 240, height: 72)
			case .voice: size = NSSize(width: 70 + min(120, CGFloat(Int(m.text) ?? 1) * 4), height: 36)
			}
			let avatar = m.mine ? NSRect(x: W - 20 - 36, y: y, width: 36, height: 36) : NSRect(x: x0 + 20, y: y, width: 36, height: 36)
			let by = y + (showSender ? 19 : 0)
			let bubble = m.mine ? NSRect(x: avatar.minX - 10 - size.width, y: by, width: size.width, height: size.height)
				: NSRect(x: avatar.maxX + 10, y: by, width: size.width, height: size.height)
			out.append(Placed(msg: m, avatar: avatar, bubble: bubble, senderY: showSender ? y : nil, timeY: timeY))
			y = max(avatar.maxY, bubble.maxY) + 16
		}
		return (out, y + 4)
	}
	var maxMsgOffset: CGFloat { contact.flatMap { contacts[$0] }.map { max(0, placed($0).height - msgView.height) } ?? 0 }

	// MARK: 画(边画边记 layout:记下的框就是刚画的那个框,和画面对得上)

	var items: [[String: Any]] = [], layout: [[String: Any]] = [], itemClip = NSRect.zero, layoutAt: Int64 = 0
	/// 记一个看得见的条目(窗口坐标、左上角原点)。只记裁剪后还露着的部分,被裁掉一截的标 partial。
	func item(_ kind: String, _ text: String, _ r: NSRect, _ more: [String: Any] = [:]) {
		let v = r.intersection(itemClip)
		guard v.width > 0.5, v.height > 0.5 else { return }
		var d: [String: Any] = ["kind": kind, "label": text, "rect": rectDict(v)]
		if abs(v.width - r.width) > 0.5 || abs(v.height - r.height) > 0.5 { d["partial"] = true }
		for (k, x) in more { d[k] = x }
		items.append(d)
	}
	func clipped(_ r: NSRect, _ body: () -> Void) {
		let saved = itemClip
		NSGraphicsContext.saveGraphicsState()
		NSBezierPath(rect: r).addClip()
		itemClip = r.intersection(saved)
		body()
		NSGraphicsContext.restoreGraphicsState()
		itemClip = saved
	}

	override func draw(_ dirtyRect: NSRect) {
		items = []
		itemClip = bounds
		fill(bounds, C.chat)
		drawRail()
		drawList()
		if let name = contact, let c = contacts[name] { drawChat(c) } else { drawPlaceholder() }
		if !drawn || !(items as NSArray).isEqual(to: layout) {
			drawn = true
			layout = items
			layoutAt = nowMs()
			DispatchQueue.main.async { self.save() }
		}
	}

	func avatar(_ c: Contact?, mine: Bool = false, _ r: NSRect) {
		if mine {
			gradient(r, rgb(98, 178, 236), rgb(60, 120, 210), 6)
			symbol("person.fill", NSPoint(x: r.midX, y: r.midY + 1), r.width * 0.45, .white)
			return
		}
		guard let c else { return }
		switch c.kind {
		case .group:
			// 群头像:2×2 宫格
			fill(r, rgb(220, 220, 220), 6)
			let s = (r.width - 6) / 2, colors = [rgb(98, 160, 240), rgb(255, 168, 64), rgb(90, 200, 130), rgb(176, 120, 220)], letters = ["李", "韩", "王", "我"]
			for k in 0..<4 {
				let cell = NSRect(x: r.minX + 2 + CGFloat(k % 2) * (s + 2), y: r.minY + 2 + CGFloat(k / 2) * (s + 2), width: s, height: s)
				fill(cell, colors[k], 3)
				label(letters[k], cell, font(s * 0.5, .medium), .white, .center)
			}
		case .files: fill(r, c.color, 6); symbol("folder.fill", NSPoint(x: r.midX, y: r.midY + 1), r.width * 0.42, .white)
		case .notice: fill(r, c.color, 6); symbol("newspaper.fill", NSPoint(x: r.midX, y: r.midY + 1), r.width * 0.4, .white)
		case .service: fill(r, c.color, 6); symbol("building.2.fill", NSPoint(x: r.midX, y: r.midY + 1), r.width * 0.42, .white)
		case .person: fill(r, c.color, 6); label(c.initial, r, font(r.width * 0.42, .medium), .white, .center)
		}
	}

	/// 群里每个人用自己的头像(有单聊的就用同一个颜色),不是群的宫格头像
	func memberAvatar(_ sender: String, _ r: NSRect) {
		let h = sender.unicodeScalars.reduce(UInt32(5)) { ($0 &* 31) &+ $1.value }
		let color = contacts[sender]?.color ?? NSColor(hue: CGFloat(h % 360) / 360, saturation: 0.5, brightness: 0.85, alpha: 1)
		fill(r, color, 6)
		label(String(sender.prefix(1)), r, font(r.width * 0.42, .medium), .white, .center)
	}

	func drawRail() {
		fill(NSRect(x: 0, y: 0, width: railW, height: H), C.rail)
		let me = NSRect(x: 14, y: 44, width: 36, height: 36)
		avatar(nil, mine: true, me)
		item("avatar", "我", me)
		let tabs: [(String, String)] = [("聊天", "message.fill"), ("通讯录", "person"), ("收藏", "shippingbox"), ("朋友圈", "camera.aperture"), ("文件", "folder")]
		for (i, t) in tabs.enumerated() {
			let c = tabCenter(i)
			symbol(t.1, c, 19, i == 0 ? C.green : C.icon, i == 0 ? .regular : .light)
			item("tab", t.0, NSRect(x: c.x - 18, y: c.y - 18, width: 36, height: 36))
		}
		symbol("iphone", NSPoint(x: railW / 2, y: H - 76), 17, C.icon, .light)
		item("button", "手机", NSRect(x: railW / 2 - 16, y: H - 92, width: 32, height: 32))
		symbol("line.3.horizontal", NSPoint(x: railW / 2, y: H - 34), 17, C.icon, .light)
		item("button", "设置", NSRect(x: railW / 2 - 16, y: H - 50, width: 32, height: 32))
	}

	/// 单行输入框里的字:选中全部时画底色,聚焦时在末尾画一根不闪的光标(闪烁会让截图不确定)。
	func drawField(_ text: String, placeholder: String, in r: NSRect, focused on: Bool) {
		NSGraphicsContext.saveGraphicsState()
		NSBezierPath(rect: r.insetBy(dx: -2, dy: 0)).addClip()
		let f = font(13), w = measure(text, style(f, C.text)).width
		let shift = max(0, w - (r.width - 6))
		let tr = NSRect(x: r.minX - shift, y: r.minY, width: w + 6, height: r.height)
		if text.isEmpty { label(placeholder, r, f, C.text2) } else {
			if on && selectAll { fill(NSRect(x: tr.minX - 1, y: r.midY - 9, width: w + 2, height: 18), C.selection, 2) }
			label(text, tr, f, C.text)
		}
		if on && !(selectAll && !text.isEmpty) { fill(NSRect(x: (tr.minX + w + 1).rounded(), y: r.midY - 8, width: 1.5, height: 16), C.green) }
		NSGraphicsContext.restoreGraphicsState()
	}

	func drawList() {
		fill(NSRect(x: railW, y: 0, width: listX1 - railW, height: H), C.list)
		fill(NSRect(x: listX1 - 1, y: 0, width: 1, height: H), C.line)
		let r = searchRect, on = focus == .search
		fill(r, on ? .white : C.field, 6)
		if on { stroke(r, rgb(200, 200, 200), 6) }
		symbol("magnifyingglass", NSPoint(x: r.minX + 15, y: r.midY), 11, C.text2, .medium)
		drawField(search, placeholder: "搜索", in: NSRect(x: r.minX + 28, y: r.minY, width: r.width - (search.isEmpty ? 36 : 56), height: r.height), focused: on)
		item("field", "搜索", r, ["value": search, "focused": on])
		if !search.isEmpty {
			oval(clearRect.insetBy(dx: 3, dy: 3), C.text3)
			symbol("xmark", NSPoint(x: clearRect.midX, y: clearRect.midY), 7, .white, .bold)
			item("button", "清除", clearRect)
		}
		fill(plusRect, C.field, 6)
		symbol("plus", NSPoint(x: plusRect.midX, y: plusRect.midY), 12, C.icon, .medium)
		item("button", "+", plusRect)
		if !search.isEmpty {
			item("text", "联系人", label("联系人", NSRect(x: railW + 16, y: 74, width: 120, height: 22), font(12), C.text2))
		}
		let names = listed
		if names.isEmpty {
			item("text", "无搜索结果", label("无搜索结果", NSRect(x: railW, y: 130, width: listX1 - railW, height: 22), font(13), C.text2, .center))
		}
		clipped(listView) {
			for (i, name) in names.enumerated() {
				let row = rowRect(i)
				guard row.maxY > listView.minY, row.minY < listView.maxY, let c = contacts[name] else { continue }
				if name == contact { fill(row, C.sel) }
				let av = NSRect(x: row.minX + 12, y: row.minY + 12, width: 40, height: 40)
				avatar(c, av)
				let timeR = label(c.time, NSRect(x: row.maxX - 72, y: row.minY + 12, width: 60, height: 18), font(11), C.text3, .right)
				drawName(name, NSRect(x: av.maxX + 12, y: row.minY + 11, width: timeR.minX - av.maxX - 18, height: 20))
				let preview = previewText(c)
				let draft = name != contact ? (drafts[name] ?? "") : ""
				var px = av.maxX + 12
				if !draft.isEmpty { px = label("[草稿]", NSRect(x: px, y: row.minY + 34, width: 40, height: 18), font(12.5), C.red).maxX + 2 }
				label(draft.isEmpty ? preview : draft.replacingOccurrences(of: "\n", with: " "), NSRect(x: px, y: row.minY + 34, width: row.maxX - 12 - px, height: 18), font(12.5), C.text2)
				if c.unread > 0 {
					let t = "\(c.unread)", w = max(16, measure(t, style(font(10, .medium), .white)).width + 8)
					let b = NSRect(x: av.maxX - w / 2 - 2, y: av.minY - 6, width: w, height: 16)
					fill(b, C.red, 8)
					label(t, b, font(10, .medium), .white, .center)
				} else if c.unread < 0 {
					oval(NSRect(x: av.maxX - 6, y: av.minY - 3, width: 9, height: 9), C.red)
				}
				item("contact", name, row, ["preview": draft.isEmpty ? preview : "[草稿]\(draft)", "time": c.time, "unread": max(0, c.unread), "selected": name == contact])
			}
		}
	}

	/// 联系人名字;搜索时把命中的那一段标成绿色(和微信一样)
	func drawName(_ name: String, _ r: NSRect) {
		let a = NSMutableAttributedString(string: name, attributes: style(font(14), C.text))
		let q = search.trimmingCharacters(in: .whitespaces)
		if !q.isEmpty, let range = name.range(of: q, options: .caseInsensitive) { a.addAttribute(.foregroundColor, value: C.green, range: NSRange(range, in: name)) }
		let h = a.size().height
		a.draw(with: NSRect(x: r.minX, y: (r.midY - h / 2).rounded(), width: r.width, height: h + 2), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine, .usesFontLeading], context: nil)
	}

	func previewText(_ c: Contact) -> String {
		if let p = c.preview { return p }
		guard let m = c.messages.last else { return "" }
		return c.kind == .group && !m.mine && m.sender != nil ? "\(m.sender!): \(m.summary)" : m.summary
	}

	func drawPlaceholder() {
		symbol("bubble.left.and.bubble.right.fill", NSPoint(x: chatRect.midX, y: chatRect.midY - 10), 64, rgb(222, 222, 222))
	}

	func drawChat(_ c: Contact) {
		let x0 = listX1
		// 标题栏
		let title = label(c.name, NSRect(x: x0 + 24, y: 18, width: W - x0 - 120, height: 28), font(16, .medium), C.text)
		item("text", c.name, title)
		if c.kind == .group { label("(8)", NSRect(x: title.maxX + 2, y: 18, width: 40, height: 28), font(16), C.text2) }
		symbol("ellipsis", NSPoint(x: W - 36, y: 32), 16, C.icon, .medium)
		item("button", "更多", NSRect(x: W - 52, y: 18, width: 32, height: 28))
		fill(NSRect(x: x0, y: 60, width: W - x0, height: 1), C.line)
		// 消息
		clipped(msgView) {
			let top = msgView.minY - msgOffset
			for p in placed(c).items {
				let m = p.msg
				if let ty = p.timeY, let t = m.time {
					item("text", t, label(t, NSRect(x: x0, y: top + ty + 6, width: W - x0, height: 20), font(11.5), C.text3, .center))
				}
				let av = p.avatar.offsetBy(dx: 0, dy: top)
				if c.kind == .group && !m.mine, let sender = m.sender { memberAvatar(sender, av) } else { avatar(c, mine: m.mine, av) }
				item("avatar", m.mine ? "我" : (m.sender ?? c.name), av)
				if let sy = p.senderY, let s = m.sender {
					item("text", s, label(s, NSRect(x: p.bubble.minX + 2, y: top + sy, width: 200, height: 16), font(11.5), C.text2))
				}
				let b = p.bubble.offsetBy(dx: 0, dy: top)
				drawBubble(m, b)
				var more: [String: Any] = ["type": "\(m.kind)"]
				if m.mine { more["mine"] = true }
				item("bubble", m.summary, b, more)
			}
		}
		// 输入区
		fill(NSRect(x: x0, y: H - bottomH, width: W - x0, height: 1), C.line)
		let tools: [(String, String)] = [("表情", "face.smiling"), ("文件", "folder"), ("截图", "scissors"), ("聊天记录", "bubble.left")]
		for (i, t) in tools.enumerated() {
			let cx = x0 + 32 + CGFloat(i) * 38, cy = H - bottomH + 20
			symbol(t.1, NSPoint(x: cx, y: cy), 17, C.icon, .light)
			item("button", t.0, NSRect(x: cx - 14, y: cy - 14, width: 28, height: 28))
		}
		for (i, t) in [("语音通话", "phone"), ("视频通话", "video")].enumerated() {
			let cx = W - 72 + CGFloat(i) * 38, cy = H - bottomH + 20
			symbol(t.1, NSPoint(x: cx, y: cy), 16, C.icon, .light)
			item("button", t.0, NSRect(x: cx - 14, y: cy - 14, width: 28, height: 28))
		}
		drawInput()
		// 输入框 = 工具栏下面整块空白(点哪儿都把光标放进来,和微信一样);发送按钮是压在里面的更小的一块
		item("field", "输入", inputRegion, ["value": input, "focused": focus == .input])
		let canSend = !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		fill(sendRect, canSend ? C.green : rgb(233, 233, 233), 5)
		label("发送(S)", sendRect, font(14, canSend ? .medium : .regular), canSend ? .white : C.text3, .center)
		item("button", "发送(S)", sendRect, ["enabled": canSend])
	}

	func drawBubble(_ m: Msg, _ b: NSRect) {
		switch m.kind {
		case .text, .voice:
			let color = m.mine ? C.bubbleOut : C.bubbleIn
			fill(b, color, 6)
			// 指向头像的小三角
			let tip = NSBezierPath(), ty = b.minY + 18
			if m.mine { tip.move(to: NSPoint(x: b.maxX - 1, y: ty - 6)); tip.line(to: NSPoint(x: b.maxX + 6, y: ty)); tip.line(to: NSPoint(x: b.maxX - 1, y: ty + 6)) }
			else { tip.move(to: NSPoint(x: b.minX + 1, y: ty - 6)); tip.line(to: NSPoint(x: b.minX - 6, y: ty)); tip.line(to: NSPoint(x: b.minX + 1, y: ty + 6)) }
			tip.close()
			color.setFill()
			tip.fill()
			if m.kind == .voice {
				symbol("wave.3.right", NSPoint(x: b.minX + 20, y: b.midY), 14, C.text)
				label("\(m.text)\"", NSRect(x: b.minX + 34, y: b.minY, width: b.width - 40, height: b.height), font(13.5), C.text)
			} else {
				let a = style(font(14), C.text, wrap: true, spacing: 2), t = measure(m.text, a, width: b.width - 24)
				(m.text as NSString).draw(with: NSRect(x: b.minX + 12, y: b.midY - t.height / 2, width: b.width - 24, height: t.height + 1),
					options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: a, context: nil)
			}
		case .image:
			// 「晚霞」照片:画出来的渐变 + 太阳 + 远山
			NSGraphicsContext.saveGraphicsState()
			NSBezierPath(roundedRect: b, xRadius: 6, yRadius: 6).addClip()
			NSGradient(colors: [rgb(255, 170, 110), rgb(236, 110, 130), rgb(120, 90, 170)])?.draw(in: b, angle: 90)
			oval(NSRect(x: b.midX - 18, y: b.minY + 38, width: 36, height: 36), rgb(255, 226, 160))
			let hills = NSBezierPath()
			hills.move(to: NSPoint(x: b.minX, y: b.maxY))
			hills.line(to: NSPoint(x: b.minX, y: b.maxY - 26))
			hills.curve(to: NSPoint(x: b.midX, y: b.maxY - 30), controlPoint1: NSPoint(x: b.minX + 40, y: b.maxY - 50), controlPoint2: NSPoint(x: b.midX - 30, y: b.maxY - 18))
			hills.curve(to: NSPoint(x: b.maxX, y: b.maxY - 40), controlPoint1: NSPoint(x: b.midX + 30, y: b.maxY - 44), controlPoint2: NSPoint(x: b.maxX - 30, y: b.maxY - 52))
			hills.line(to: NSPoint(x: b.maxX, y: b.maxY))
			hills.close()
			rgb(70, 52, 110).setFill()
			hills.fill()
			NSGraphicsContext.restoreGraphicsState()
		case .file:
			fill(b, .white, 6)
			stroke(b, rgb(232, 232, 232), 6)
			label(m.text, NSRect(x: b.minX + 14, y: b.minY + 14, width: b.width - 76, height: 20), font(13.5), C.text)
			label("1.2 MB", NSRect(x: b.minX + 14, y: b.minY + 40, width: 100, height: 16), font(11), C.text2)
			let icon = NSRect(x: b.maxX - 50, y: b.minY + 14, width: 36, height: 44)
			fill(icon, rgb(234, 84, 74), 4)
			label("PDF", icon, font(10, .bold), .white, .center)
		}
	}

	func drawInput() {
		let r = inputRect, on = focus == .input
		let attrs = style(font(14), C.text, wrap: true, spacing: 3)
		box.set(input, attrs, width: r.width)
		let caret = box.caret(lineHeight: 20)
		let shift = max(0, caret.maxY - r.height)
		NSGraphicsContext.saveGraphicsState()
		NSBezierPath(rect: r.insetBy(dx: -2, dy: 0)).addClip()
		let origin = NSPoint(x: r.minX, y: r.minY - shift)
		if on && selectAll && !input.isEmpty {
			for line in box.lineRects() { fill(line.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -1, dy: 0), C.selection, 2) }
		}
		box.draw(at: origin)
		if on && !(selectAll && !input.isEmpty) { fill(caret.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: 0, dy: 1), C.green) }
		NSGraphicsContext.restoreGraphicsState()
	}

	// MARK: 输入(真实事件只做坐标换算,逻辑在 handle*;selftest 直接调 handle*)

	override func mouseDown(with event: NSEvent) {
		window?.makeFirstResponder(self)
		handleClick(convert(event.locationInWindow, from: nil), count: event.clickCount)
	}
	override func scrollWheel(with event: NSEvent) {
		let k: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 16
		handleScroll(convert(event.locationInWindow, from: nil), dx: event.scrollingDeltaX * k, dy: event.scrollingDeltaY * k)
	}
	override func keyDown(with event: NSEvent) {
		handleKey(event.characters ?? "", ignoring: event.charactersIgnoringModifiers ?? "", code: event.keyCode, flags: event.modifierFlags)
	}

	func handleClick(_ p: NSPoint, count: Int) {
		clicks += 1
		if count == 2 { doubleClicks += 1 }
		// 点在了哪儿:按点下去那一刻屏幕上的 layout 找(最小的那个包含这个点的条目)
		log("click", "\(Int(p.x.rounded())),\(Int(p.y.rounded())) x\(count) → \(hitLabel(p))")
		defer { changed() }
		if !search.isEmpty && clearRect.contains(p) { setSearch(""); setFocus(.search); return }
		if searchRect.contains(p) { setFocus(.search); return }
		// 命中按「当前列出来的」那份(搜索过滤 / 排序之后),不是全量联系人
		if listView.contains(p) {
			let k = Int(floor((p.y - listTop + listOffset) / rowH))
			let names = listed
			if k >= 0 && k < names.count { open(names[k]) } else { setFocus(nil) }
			return
		}
		if contact != nil {
			if sendRect.contains(p) { setFocus(.input); send(); return }
			if inputRegion.contains(p) { setFocus(.input); return }
		}
		setFocus(nil)
	}

	func handleScroll(_ p: NSPoint, dx: CGFloat, dy: CGFloat) {
		// 只数带位移的:桥接层垫的那个零位移事件不算一次滚动(同 main.swift)
		guard dx != 0 || dy != 0 else { return }
		scrolls += 1
		defer { changed() }
		if listView.contains(p) {
			let new = min(maxListOffset, max(0, listOffset - dy))
			if new != listOffset { listOffset = new; log("scroll", "list:\(Int(new))", coalesce: true) }
		} else if contact != nil, msgView.contains(p) {
			let new = min(maxMsgOffset, max(0, msgOffset - dy))
			if new != msgOffset { msgOffset = new; log("scroll", "messages:\(Int(new))", coalesce: true) }
		}
	}

	func handleKey(_ chars: String, ignoring: String, code: UInt16, flags: NSEvent.ModifierFlags) {
		keys += 1
		defer { changed() }
		let mods = modifierNames(flags)
		// 有名字的键单独记一条 key 事件(回车 / 删除 / Esc / 方向键 / Cmd 组合键);打的字并进 text 事件
		if let name = keyName(code) {
			log("key", mods + name)
			guard let f = focus else { return }
			switch code {
			case 36, 76: if f == .input && !flags.intersection([.shift, .option, .command, .control]).isEmpty { insert("\n") } else { submit() }
			case 51: backspace()
			case 117: if selectAll { backspace() }
			case 53: setFocus(nil)
			default: break
			}
			return
		}
		if flags.contains(.command) || flags.contains(.control) {
			let key = ignoring.lowercased()
			log("key", mods + key.uppercased())
			guard let f = focus else { return }
			if flags.contains(.command) && key == "a" { selectAll = !text(f).isEmpty; if selectAll { log("select-all", f.rawValue) } }
			else if flags.contains(.command) && key == "v", let s = NSPasteboard.general.string(forType: .string) { insert(s); log("paste", f.rawValue) }
			return
		}
		var run = ""
		for ch in chars {
			if ch == "\r" || ch == "\n" || ch == "\u{3}" { typed(run); run = ""; log("key", "Return"); submit() }
			else if ch == "\u{7F}" || ch == "\u{8}" { typed(run); run = ""; log("key", "Delete"); backspace() }
			else if ch == "\u{1B}" { typed(run); run = ""; log("key", "Esc"); setFocus(nil) }
			else if let u = ch.unicodeScalars.first, u.value >= 0x20, !(0xF700...0xF8FF).contains(u.value) { run.append(ch) }
		}
		typed(run)
	}
	/// 打的字:有焦点就进那个框;没焦点就记一条「打到了空气里」的 key 事件(连着打的并成一条)
	func typed(_ s: String) {
		guard !s.isEmpty else { return }
		if focus != nil { insert(s); return }
		let tail = " → nothing"
		if let last = events.last, last["kind"] as? String == "key", let d = last["detail"] as? String, d.hasSuffix(tail) {
			events[events.count - 1] = ["t": nowMs(), "kind": "key", "detail": String(d.dropLast(tail.count)) + s + tail]
		} else {
			log("key", s + tail)
		}
	}

	func text(_ f: Field) -> String { f == .search ? search : input }
	func setText(_ f: Field, _ s: String) {
		if f == .search { setSearch(s) } else { input = s; log("text", "input=\(s)", coalesce: true, within: .max) }
	}
	func setSearch(_ s: String) {
		guard s != search else { return }
		search = s
		listOffset = 0
		log("text", "search=\(s)", coalesce: true, within: .max)
	}
	func insert(_ s: String) {
		guard let f = focus else { return }
		let clean = f == .search ? s.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ") : s.replacingOccurrences(of: "\r", with: "\n")
		guard !clean.isEmpty else { return }
		let base = selectAll ? "" : text(f)
		selectAll = false
		setText(f, base + clean)
	}
	func backspace() {
		guard let f = focus, !text(f).isEmpty else { return }
		if selectAll { selectAll = false; setText(f, "") } else { setText(f, String(text(f).dropLast())) }
	}
	func submit() {
		if focus == .search { if let first = listed.first { open(first) } } else if focus == .input { send() }
	}
	func setFocus(_ f: Field?) {
		selectAll = false
		guard f != focus else { return }
		focus = f
		log("focus", f?.rawValue ?? "none")
	}

	/// 打开一个聊天:光标进输入框;从搜索结果打开的话搜索清空、列表回到原样;没发的字按聊天各自留草稿。
	func open(_ name: String) {
		if name != contact {
			if let old = contact { drafts[old] = input }
			contact = name
			input = drafts[name] ?? ""
			drafts[name] = nil
			contacts[name]?.unread = 0
			log("contact", name)
		}
		if !search.isEmpty { setSearch("") }
		setFocus(.input)
		msgOffset = maxMsgOffset
	}

	func send() {
		guard let name = contact else { return }
		let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty else { return }
		deliver(text, to: name)
		input = ""
		selectAll = false
		log("send", "\(name): \(text)")
	}
	/// 发出去:绿色气泡、记进 sent、这个聊天挪到列表最上面、消息区滚到底
	func deliver(_ text: String, to name: String) {
		contacts[name]?.messages.append(me(text))
		contacts[name]?.time = "刚刚"
		contacts[name]?.preview = nil
		order.removeAll { $0 == name }
		order.insert(name, at: 0)
		sent.append(["to": name, "text": text, "t": nowMs()])
		msgOffset = maxMsgOffset
	}

	/// --page / --sent:只给截图冒烟用,直接摆好画面(不算用户操作,不记事件)。
	func apply(page spec: String?, sent text: String?) {
		if let spec, !spec.isEmpty {
			let parts = spec.split(separator: ":", maxSplits: 1).map(String.init)
			let arg = parts.count > 1 ? parts[1] : ""
			switch parts[0] {
			case "chat":
				if contacts[arg] != nil { contact = arg; contacts[arg]?.unread = 0; focus = .input }
			case "search": focus = .search; search = arg
			default: break
			}
		}
		if let text, !text.isEmpty, let name = contact { deliver(text, to: name) }
		msgOffset = maxMsgOffset
	}

	// MARK: 状态

	/// 过程记录。coalesce:和上一条同类、同目标(detail 里 = 或 : 之前那段)就并成一条,t 取最新的 ——
	/// 连续滚动(600ms 内)、连续打字(中间没别的事件)各算一条,别把 500 条的额度刷光。点击从不合并。
	func log(_ kind: String, _ detail: String, coalesce: Bool = false, within: Int64 = 600) {
		let t = nowMs()
		func target(_ d: String) -> Substring { d.prefix { $0 != "=" && $0 != ":" } }
		if coalesce, let last = events.last, last["kind"] as? String == kind, let lt = last["t"] as? Int64, t - lt <= within,
			let ld = last["detail"] as? String, target(ld) == target(detail) {
			events[events.count - 1] = ["t": t, "kind": kind, "detail": detail]
			return
		}
		events.append(["t": t, "kind": kind, "detail": detail])
		if events.count > 500 { events.removeFirst(events.count - 500) }
	}
	/// 点下去那一刻屏幕上这个点落在哪个条目上:包含它的最小那个,"<kind> <label>";都不在就是 nothing
	func hitLabel(_ p: NSPoint) -> String {
		var best: (area: Double, name: String)?
		for it in layout {
			guard let r = it["rect"] as? [String: Double], let x = r["x"], let y = r["y"], let w = r["w"], let h = r["h"] else { continue }
			let px = Double(p.x), py = Double(p.y)
			guard px >= x, px <= x + w, py >= y, py <= y + h else { continue }
			if best == nil || w * h < best!.area {
				let name = "\(it["kind"] as? String ?? "") \(it["label"] as? String ?? "")".trimmingCharacters(in: .whitespaces)
				best = (w * h, name)
			}
		}
		return best?.name ?? "nothing"
	}
	func keyName(_ code: UInt16) -> String? {
		[36: "Return", 76: "Enter", 51: "Delete", 117: "ForwardDelete", 53: "Esc", 48: "Tab", 123: "Left", 124: "Right", 125: "Down", 126: "Up",
			115: "Home", 119: "End", 116: "PageUp", 121: "PageDown"][code]
	}
	func modifierNames(_ flags: NSEvent.ModifierFlags) -> String {
		[(NSEvent.ModifierFlags.control, "Ctrl+"), (.option, "Option+"), (.shift, "Shift+"), (.command, "Cmd+")].filter { flags.contains($0.0) }.map(\.1).joined()
	}

	func changed() { needsDisplay = true; save() }

	func save() {
		let ph = NSScreen.screens.first?.frame.height ?? 0
		let f = window?.frame ?? .zero
		var state: [String: Any] = [
			"pid": Int(getpid()), "windowNumber": window?.windowNumber ?? 0, "visible": window?.isVisible ?? false, "ready": drawn,
			"page": contact == nil ? "list" : "chat",
			"focus": focus.map { $0.rawValue as Any } ?? NSNull(),
			"search": search, "selectAll": selectAll,
			"contact": contact.map { $0 as Any } ?? NSNull(),
			"input": input,
			"drafts": drafts.filter { !$0.value.isEmpty },
			"sent": sent,
			"listed": listed,
			"contacts": allNames,
			"offsets": ["list": Double(listOffset), "messages": Double(msgOffset)],
			"clicks": clicks, "doubleClicks": doubleClicks, "scrolls": scrolls, "keys": keys,
			"window": ["x": Double(f.minX), "y": Double(ph - f.maxY), "w": Double(f.width), "h": Double(f.height)],
			"content": ["w": Double(bounds.width), "h": Double(bounds.height)],
			// layout:当前画面上看得见的条目(窗口坐标、左上角原点、点)。fullSizeContentView 下画布 = 整个窗口,
			// 所以这些框直接对应整窗截图,不用再加标题栏;titlebarHeight 只是说明红绿灯那条压在内容上有多高。
			// layout 是「最后画出来的那一帧」:状态变了以后下一帧(≤16ms)才跟上,layoutAt = 那一帧画完的时刻
			"layout": layout, "layoutAt": layoutAt,
			"titlebarHeight": Double((window.map { $0.frame.height - $0.contentLayoutRect.height }) ?? 0),
			"fullSizeContent": true,
			"events": events,
		]
		for (k, v) in extra { state[k] = v }
		if let data = try? JSONSerialization.data(withJSONObject: state) {
			try? data.write(to: URL(fileURLWithPath: options.statePath), options: .atomic)
		}
	}
}

// MARK: - selftest:进程内直接调 handle*,不经系统、不发真实输入

final class SelfTest {
	let c: Canvas
	var failures: [String] = []
	init(_ canvas: Canvas) { c = canvas }
	func expect(_ ok: Bool, _ what: String) { if !ok { failures.append(what) } }
	func click(_ r: NSRect?, _ count: Int = 1) {
		guard let r else { failures.append("missing target rect"); return }
		refresh()
		c.handleClick(NSPoint(x: r.midX, y: r.midY), count: count)
	}
	/// 离屏真画一帧(cacheDisplay 会走 draw):layout 跟上当前画面,click 事件里「点在了哪儿」才是真的
	func refresh() { if let rep = c.bitmapImageRepForCachingDisplay(in: c.bounds) { c.cacheDisplay(in: c.bounds, to: rep) } }
	/// 上一次点击落在的条目(按 layout 找的)必须是 what 开头 —— 等于验 layout 的框和点击处理用的是同一个框
	func expectHit(_ what: String) {
		let d = c.events.last { $0["kind"] as? String == "click" }?["detail"] as? String ?? ""
		expect(d.contains("→ \(what)"), "click should land on \(what): \(d)")
	}
	func key(_ s: String, code: UInt16 = 0, flags: NSEvent.ModifierFlags = []) { c.handleKey(s, ignoring: s, code: code, flags: flags) }
	/// 像 helper 那样一个字符一个按键地打(ASCII 走物理键码,其余走 unicode 串)
	func typeKeys(_ s: String) { for ch in s { key(String(ch)) } }
	func returnKey(_ flags: NSEvent.ModifierFlags = []) { key("\r", code: 36, flags: flags) }
	func sentTexts() -> [String] { c.sent.compactMap { $0["text"] as? String } }

	func run() -> [String: Any] {
		expect(c.contact == nil && c.focus == nil && c.listed == allNames && allNames.count == 14, "starts on the list")
		click(c.searchRect)
		expectHit("field 搜索")
		expect(c.focus == .search, "search focus")
		typeKeys("saku")
		expect(c.search == "saku" && c.listed == ["Saku", "Sakura 樱花", "Sakura"], "filter saku: \(c.listed)")
		click(c.rowRect("Sakura"))
		expectHit("contact Sakura")
		expect(c.contact == "Sakura" && c.search.isEmpty && c.focus == .input && c.listed == allNames, "open Sakura from the filtered list")
		key("你好")
		key(" ", code: 49)
		key("world")
		expect(c.input == "你好 world", "type into input: \(c.input)")
		key("a", flags: .command)
		key("周末")
		expect(c.input == "周末", "cmd+a then type replaces")
		returnKey(.shift)
		key("见")
		expect(c.input == "周末\n见", "shift+return inserts a newline")
		returnKey()
		expect(sentTexts() == ["周末\n见"] && c.sent.first?["to"] as? String == "Sakura" && c.input.isEmpty, "return sends")
		expect(c.listed.first == "Sakura", "sent chat moves to the top")
		returnKey()
		expect(c.sent.count == 1, "empty input does not send")
		key("好的")
		click(c.sendRect)
		expectHit("button 发送(S)")
		expect(sentTexts() == ["周末\n见", "好的"], "send button sends")
		click(c.sendRect)
		expect(c.sent.count == 2, "send button with empty input does nothing")
		key("草稿内容")
		click(c.rowRect("妈妈"))
		expectHit("contact 妈妈")
		expect(c.contact == "妈妈" && c.input.isEmpty && c.drafts["Sakura"] == "草稿内容", "draft kept when switching chats")
		click(c.rowRect("Sakura"))
		expect(c.input == "草稿内容", "draft restored")
		key("a", flags: .command)
		key("\u{7F}", code: 51)
		expect(c.input.isEmpty, "cmd+a, delete clears")
		key("\u{1B}", code: 53)
		expect(c.focus == nil, "escape blurs")
		key("x")
		expect(c.input.isEmpty && c.search.isEmpty, "typing without focus does nothing")
		click(c.searchRect)
		key("樱")
		expect(c.listed == ["樱子", "Sakura 樱花", "佐藤樱"], "filter 樱: \(c.listed)")
		key("\u{7F}", code: 51)
		expect(c.search.isEmpty && c.listed.count == 14, "clearing the search restores the list")
		typeKeys("zzz")
		expect(c.listed.isEmpty, "no results")
		key("a", flags: .command)
		key("\u{7F}", code: 51)
		typeKeys("sam")
		expect(c.listed == ["Sam", "Samantha"], "exact match first: \(c.listed)")
		returnKey()
		expect(c.contact == "Sam" && c.search.isEmpty, "return in search opens the first result")
		click(c.searchRect)
		key("妈")
		click(c.clearRect)
		expectHit("button 清除")
		expect(c.search.isEmpty && c.focus == .search, "clear button")
		let listPoint = NSPoint(x: c.listView.midX, y: c.listView.midY)
		c.handleScroll(listPoint, dx: 0, dy: -200)
		expect(c.listOffset == 200, "list scroll \(c.listOffset)")
		c.handleScroll(listPoint, dx: 0, dy: -10_000)
		expect(c.listOffset == c.maxListOffset && c.maxListOffset > 0, "list scroll clamps")
		click(c.rowRect("物业服务中心"), 1)
		click(c.rowRect("物业服务中心"), 2)
		expect(c.contact == "物业服务中心" && c.doubleClicks == 1, "double click opens too")
		c.handleScroll(listPoint, dx: 0, dy: 10_000)
		expect(c.listOffset == 0, "list scroll back to top")
		c.handleScroll(NSPoint(x: c.msgView.midX, y: c.msgView.midY), dx: 0, dy: 100)
		expect(c.msgOffset >= 0 && c.msgOffset <= c.maxMsgOffset, "message scroll stays in range")
		click(NSRect(x: c.msgView.midX, y: c.msgView.midY, width: 1, height: 1))
		expect(c.focus == nil, "click on messages blurs")
		click(NSRect(x: c.inputRegion.minX + 40, y: c.inputRegion.maxY - 20, width: 1, height: 1))
		expectHit("field 输入")
		expect(c.focus == .input, "click anywhere in the input pane focuses the input")
		// 收尾摆成一个信息量大的画面(给 --hold 截图):Sakura 的聊天里有发出去的两条,输入框里一段折行的长草稿
		click(c.rowRect("Sakura"))
		key("这是一段比较长的消息,用来检查输入框里的自动换行和光标位置是否正常。Mixed English text wraps here too.")
		returnKey(.shift)
		key("第三行")
		expect(c.contact == "Sakura" && c.input.hasSuffix("\n第三行") && c.sent.count == 2, "final state")
		return ["pass": failures.isEmpty, "failures": failures]
	}
}

// MARK: - App

final class Delegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
	let window: NSWindow
	let canvas = Canvas()
	var hide: DispatchSourceSignal?
	var activity: NSObjectProtocol?

	override init() {
		let f = options.frame ?? NSRect(x: 160, y: 110, width: 900, height: 640)
		let ph = NSScreen.screens.first?.frame.height ?? (f.maxY + 100)
		window = NSWindow(contentRect: NSRect(x: f.minX, y: ph - f.minY - f.height, width: f.width, height: f.height),
			styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
		super.init()
	}

	func applicationDidFinishLaunching(_ notification: Notification) {
		activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: "CU fixture")
		window.title = "Chatter"
		// 和微信一样不显示标题文字:无障碍树里只剩窗口和标题栏按钮(同 main.swift)
		window.titleVisibility = .hidden
		window.titlebarAppearsTransparent = true
		window.appearance = NSAppearance(named: .aqua)
		window.backgroundColor = C.chat
		window.isRestorable = false
		window.isReleasedWhenClosed = false
		window.contentView = canvas
		window.delegate = self
		if let f = options.frame, let ph = NSScreen.screens.first?.frame.height {
			window.setFrame(NSRect(x: f.minX, y: ph - f.minY - f.height, width: f.width, height: f.height), display: false)
		}
		window.makeFirstResponder(canvas)
		canvas.apply(page: options.page, sent: options.sent)
		canvas.log("launch", (canvas.contact.map { "chat:\($0)" } ?? (canvas.search.isEmpty ? "list" : "search:\(canvas.search)")) + (options.sent != nil ? " sent" : ""))
		signal(SIGUSR1, SIG_IGN)
		hide = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
		hide?.setEventHandler { [self] in window.orderOut(nil); canvas.log("window", "hidden"); canvas.save() }
		hide?.resume()
		if options.selftest {
			if options.hold { show() }
			let result = SelfTest(canvas).run()
			canvas.extra["selftest"] = result
			canvas.changed()
			if let data = try? JSONSerialization.data(withJSONObject: result), let line = String(data: data, encoding: .utf8) { print(line) }
			fflush(stdout)
			if !options.hold { exit((result["pass"] as? Bool) == true ? 0 : 1) }
		} else {
			show()
		}
		canvas.save()
	}
	func show() {
		if options.behind { window.orderBack(nil) } else { window.orderFrontRegardless() }
		canvas.save()
	}
	func windowDidMove(_ notification: Notification) { canvas.save() }
	func windowDidResize(_ notification: Notification) { canvas.save() }
	func windowWillClose(_ notification: Notification) {
		DispatchQueue.main.async { [self] in canvas.log("window", "closed"); canvas.save() }
	}
	// 只有 App 被激活时窗口才回来(同 main.swift):后台打开不管用,激活了系统才切过去
	func applicationDidBecomeActive(_ notification: Notification) {
		if !window.isVisible { window.makeKeyAndOrderFront(nil); canvas.log("window", "shown") } else { window.makeKey() }
		window.makeFirstResponder(canvas)
		canvas.save()
	}
	func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { false }
}

// 被 SIGKILL 过的 App 下次启动可能弹「要重新打开窗口吗」,台架会挂住:不存也不读窗口状态
UserDefaults.standard.register(defaults: ["ApplePersistenceIgnoreState": true])
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(options.selftest && !options.hold ? .accessory : .regular)
app.run()
