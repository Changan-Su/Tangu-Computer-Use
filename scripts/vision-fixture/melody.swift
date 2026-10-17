// 网易云音乐那一类(CEF 内核,无障碍树是空的)的替身:暗色桌面音乐播放器。全部自己画,没有控件,
// 无障碍树里只有窗口和标题栏按钮 —— 只能看截图、按坐标点 / 滚 / 打字。给 vision 场景的真模型测试用:
// 「打开每日推荐(先转 700ms 的圈)→ 双击播放某一首 → 点底栏的「评论」→ 读最热的那条评论」。
// 判定只读状态文件(argv[1],每次变化原子写入),不信 agent 的自述;catalog 字段是答案表,测试不必再抄一份数据。
//
// 命令行:<exe> <statePath> [--frame x,y,w,h] [--page <页>] [--play <序号>] [--behind] [--no-activate] [--selftest [--hold]]
//   --frame    整个窗口的位置和大小:全局屏幕点、左上角原点(与 CGWindowList 的 bounds 同一约定)
//   --page     直接开在某页(只给截图冒烟用):home | daily | comments:<序号> | loading | playlist:<歌单名>
//              | featured | podcast | roam | follow | liked | recent | local
//   --play     开场就在放每日推荐里的第几首(行里是喇叭、底栏有歌、状态 playing 有值);同样只给截图校准用
//   --behind   窗口放到所有窗口后面:截图走 desktopIndependentWindow 不受遮挡,冒烟时不挡用户的屏幕
//   --no-activate 窗口照常显示,App 永远到不了前台(.prohibited):给 check:key-guard 造「系统不让目标到前台」
//   --selftest 进程内直接调用输入处理函数把流程走一遍(不经系统、不发任何真实输入),结果打到 stdout、写进状态的 selftest;
//              带 --hold 时跑完不退出、把窗口显示出来,给截图看交互之后的样子
// 窗口用 fullSizeContentView:内容铺满整个窗口(和真 App 一样红绿灯压在侧栏上),所以 content == window 尺寸,
// 画布坐标 = 窗口内坐标(左上角原点)。可点的东西都避开左上角红绿灯(x<76, y<32)。
// SIGUSR1 = 把窗口收起来(同 main.swift),App 被激活时窗口回来。
import AppKit

// MARK: - 命令行

struct Options {
	var statePath = "/dev/null"
	var frame: NSRect?
	var page: String?
	var play: Int?
	var behind = false, selftest = false, hold = false, noActivate = false
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
		case "--play": o.play = Int(next ?? ""); i += 1
		case "--behind": o.behind = true
		case "--no-activate": o.noActivate = true
		case "--selftest": o.selftest = true
		case "--hold": o.hold = true
		default: if i == 0 && !arg.hasPrefix("--") { o.statePath = arg }
		}
		i += 1
	}
	return o
}()

// MARK: - 画图小工具

func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor { NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a) }
func font(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont { .systemFont(ofSize: size, weight: weight) }
func digits(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont { .monospacedDigitSystemFont(ofSize: size, weight: weight) }
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
/// 多行字:从 (x, y) 起按宽度折行;画和量用同一套参数,高度不会对不上。maxHeight > 0 时超出部分截断。
@discardableResult func para(_ s: String, x: CGFloat, y: CGFloat, width: CGFloat, _ f: NSFont, _ c: NSColor,
	spacing: CGFloat = 4, maxHeight: CGFloat = 0, draw: Bool = true) -> CGFloat {
	let a = style(f, c, wrap: true, spacing: spacing)
	var h = measure(s, a, width: width).height
	if maxHeight > 0 { h = min(h, maxHeight) }
	if draw {
		(s as NSString).draw(with: NSRect(x: x, y: y, width: width, height: h + 1),
			options: [.usesLineFragmentOrigin, .usesFontLeading, .truncatesLastVisibleLine], attributes: a, context: nil)
	}
	return h
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

// MARK: - 配色(暗色,红色强调,仿桌面音乐播放器)

enum C {
	static let bg = rgb(19, 19, 26), side = rgb(25, 25, 33), bar = rgb(27, 27, 35)
	static let surface = rgb(38, 38, 48), raised = rgb(48, 48, 60), line = rgb(40, 40, 50)
	static let rowAlt = rgb(23, 23, 31), rowSel = rgb(46, 46, 58)
	static let text = rgb(236, 236, 241), text2 = rgb(152, 152, 164), text3 = rgb(104, 104, 116)
	static let accent = rgb(252, 61, 73), accentDeep = rgb(214, 36, 68), accentLight = rgb(255, 92, 98)
	static let link = rgb(126, 165, 226), gold = rgb(226, 182, 96), selection = rgb(70, 90, 140)
}

// MARK: - 内容(全部写死,没有随机、没有真实歌曲 / 用户)

struct Song {
	let index: Int, title: String, artist: String, album: String, duration: String, tag: String
	var seconds: Int { let p = duration.split(separator: ":"); return (Int(p[0]) ?? 0) * 60 + (Int(p[1]) ?? 0) }
}
// 相似的歌手名是故意的(林以安 / 林以宁、周屿 / 周屿白、Mira Lane / Mila Lane……):agent 得真的读字。
let songRows: [(String, String, String, String, String)] = [
	("夏夜的回声", "林以安", "夏夜的回声", "03:42", ""),
	("Paper Lanterns", "Mira Lane", "Night Market", "03:18", "SQ"),
	("夜に溶ける", "青山ハル", "夜に溶ける", "04:05", "VIP"),
	("风停在城南", "林以宁", "城南旧事", "04:11", ""),
	("Afterglow Drive", "The Low Tides", "Coastline", "03:56", "SQ"),
	("雨落之前", "周屿", "雨落之前", "03:29", ""),
	("Blue Hour Radio", "Mira Lane", "Night Market", "02:58", ""),
	("星を数えて", "青山ハル", "星を数えて", "03:47", ""),
	("半糖海盐", "陈小柚", "海盐气泡", "03:33", "SQ"),
	("灯塔与鲸", "周屿白", "深海来信", "04:20", ""),
	("Slow Summer", "The Low Tide", "Summer Tapes", "03:12", "VIP"),
	("晚风信箱", "陈小柚", "晚风信箱", "03:05", ""),
	("月光列车", "林以安", "月光列车", "04:02", ""),
	("Sugar Rush Hour", "Mila Lane", "Sugar", "02:47", "SQ"),
	("桜の坂道", "青山ハルカ", "桜の坂道", "04:31", ""),
	("旧城旧梦", "苏南", "旧城", "03:58", ""),
	("Electric Bloom", "NOVA K", "Bloom", "03:24", "SQ"),
	("借你一片晴天", "苏楠", "晴天预报", "03:40", ""),
	("遗忘的诗", "叶知秋", "遗忘的诗", "04:15", ""),
	("Midnight Sodas", "NOVA KAI", "Fizz", "03:01", "VIP"),
	("山海之间的邮差", "叶知秋", "山海", "05:02", ""),
	("透明な夏", "水野ユキ", "透明な夏", "03:36", "SQ"),
	("Neon Lullaby", "Mira Lane", "Neon", "03:49", ""),
	("白日梦旅馆", "许眠", "白日梦旅馆", "03:27", ""),
	("北纬三十一度", "许眠眠", "北纬", "04:08", ""),
	("Gravity Again", "The Low Tides", "Coastline", "03:15", ""),
	("青柠气泡水", "陈小柚", "海盐气泡", "02:55", "SQ"),
	("雪の降る街", "水野ユキ", "冬の手紙", "04:22", ""),
	("时间的海", "林以安", "时间的海", "04:44", ""),
	("Last Tram Home", "NOVA K", "Bloom", "03:38", ""),
]
let songs: [Song] = songRows.enumerated().map { Song(index: $0.offset + 1, title: $0.element.0, artist: $0.element.1, album: $0.element.2, duration: $0.element.3, tag: $0.element.4) }
/// 「我喜欢的音乐」:同一批歌换个固定顺序,行号是在这个歌单里的位置,不是歌的编号(第 18 首 ≠ 每日推荐的第 18 首)。
/// 页头和网易云一样写「<昵称>喜欢的音乐」,不是侧栏上的「我喜欢的音乐」:照侧栏的字去猜标题的 expect 对不上。
let likedOrder: [Int] = [12, 5, 27, 1, 19, 8, 30, 14, 3, 22, 9, 17, 25, 6, 28, 11, 2, 20, 15, 29, 4, 23, 10, 26, 7, 18, 13, 24, 16, 21]
let likedTitle = "听风的人喜欢的音乐"

struct Card { let title: String, from: NSColor, to: NSColor, icon: String, plays: String }
let topCards: [Card] = [
	Card(title: "每日推荐", from: rgb(255, 104, 96), to: rgb(208, 28, 66), icon: "", plays: ""),
	Card(title: "私人漫游", from: rgb(104, 96, 232), to: rgb(40, 128, 236), icon: "dot.radiowaves.left.and.right", plays: "3.2亿"),
	Card(title: "华语私藏 · 每周更新", from: rgb(246, 170, 74), to: rgb(222, 86, 62), icon: "music.mic", plays: "8640万"),
	Card(title: "深夜写字楼", from: rgb(52, 62, 112), to: rgb(116, 78, 172), icon: "building.2", plays: "2186万"),
	Card(title: "跑步节拍 160", from: rgb(34, 196, 150), to: rgb(22, 114, 164), icon: "figure.run", plays: "967万"),
	Card(title: "雨天的钢琴", from: rgb(122, 150, 180), to: rgb(58, 78, 112), icon: "cloud.rain", plays: "4512万"),
]
// 「热门歌单」一排是干扰项:好几张标题里也带「每日」「推荐」,封面也是红色系。
let hotCards: [Card] = [
	Card(title: "每周推荐 · 华语新声", from: rgb(232, 74, 126), to: rgb(146, 52, 164), icon: "music.note.list", plays: "1.1亿"),
	Card(title: "每日新歌速递", from: rgb(255, 130, 86), to: rgb(228, 56, 62), icon: "sparkles", plays: "5320万"),
	Card(title: "推荐 · 日系清晨", from: rgb(244, 182, 198), to: rgb(144, 164, 228), icon: "sun.horizon", plays: "2875万"),
	Card(title: "私人雷达 · 每日更新", from: rgb(64, 184, 222), to: rgb(40, 92, 204), icon: "scope", plays: "6.8亿"),
	Card(title: "每日一首晚安曲", from: rgb(78, 54, 132), to: rgb(24, 24, 58), icon: "moon.stars", plays: "1964万"),
	Card(title: "独立民谣精选", from: rgb(178, 146, 96), to: rgb(110, 88, 60), icon: "guitars", plays: "743万"),
]

enum Page: String { case home, daily, comments, playlist, featured, podcast, roam, follow, liked, recent, local }
struct Nav { let title: String, icon: String, page: Page }
let nav: [Nav] = [
	Nav(title: "推荐", icon: "house", page: .home),
	Nav(title: "精选", icon: "star", page: .featured),
	Nav(title: "播客", icon: "mic", page: .podcast),
	Nav(title: "漫游", icon: "dot.radiowaves.left.and.right", page: .roam),
	Nav(title: "关注", icon: "person.2", page: .follow),
	Nav(title: "我喜欢的音乐", icon: "heart", page: .liked),
	Nav(title: "最近播放", icon: "clock", page: .recent),
	Nav(title: "本地音乐", icon: "arrow.down.circle", page: .local),
]

// 评论:每首歌固定生成。最热那条 = 精彩评论第一条,模板里一定带歌名,所以 30 首的最热评论互不相同。
struct Comment { let user: String, text: String, date: String, likes: Int }
func countText(_ n: Int) -> String {
	guard n >= 10_000 else { return "\(n)" }
	let v = (Double(n) / 1000).rounded() / 10
	return v == v.rounded() ? "\(Int(v))万" : String(format: "%.1f万", v)
}
let users: [String] = [
	"晚风吹过的街角", "momo今天不加班", "一颗柠檬绿", "Kiyo_", "北岛以北", "失眠的鱼", "阿秃不秃", "小熊软糖",
	"风起时想你", "Mr.橘子", "早睡早起的猫", "迟到的夏天", "南有乔木", "Cloud_9", "山茶花开了", "是阿斌呀",
	"海盐芝士", "夜航船", "木子李", "白开水不加糖", "Lumi", "鹿角巷口", "七月的风", "Yuki雪",
	"不吃香菜", "橘子汽水", "考拉不睡觉", "一只小透明", "隔壁老周", "Neko_neko", "长夜未央", "清风徐来",
	"Hana", "小鱼干", "云朵收集者", "番茄炒蛋", "夏目", "Echo", "麦田守望", "温一壶酒",
]
let hotTemplates: [String] = [
	"第一次听《{title}》是在高三的晚自习,现在已经毕业五年了。",
	"凌晨两点还在循环《{title}》,明天的早八大概起不来了。",
	"《{title}》的前奏一响,整个夏天好像都回来了。",
	"去年冬天最难熬的时候,是《{title}》陪我走完那段路。",
	"把《{title}》设成了闹钟,结果每天都舍不得按掉。",
	"在地铁上听《{title}》听到哭,旁边的大叔递来一张纸巾。",
	"《{title}》适合一个人骑车回家的晚上,风很轻,路很长。",
	"爸爸开车时总放《{title}》,现在换我开车载他了。",
	"毕业那天大家一起唱《{title}》,唱到最后谁都没出声。",
	"《{title}》里那句副歌,替我说完了没说出口的话。",
	"每次加班到深夜,打车回家的路上都要听一遍《{title}》。",
	"十年后再听《{title}》,希望我们还是现在的样子。",
]
let hotPool: [String] = [
	"耳机里放着这首歌,窗外刚好下起了雨,时间都慢了下来。",
	"单曲循环了一整个下午,作业一个字都没写。",
	"这个编曲太舒服了,副歌的鼓点简直踩在心跳上。",
	"推荐给室友之后,现在整个宿舍每天早上都在放这首。",
	"下班路上听到这首,突然觉得今天也没有那么糟糕。",
	"评论区的大家晚上好,今天也辛苦了,早点休息吧。",
	"歌词写得太细腻了,每一句都像在讲我自己的故事。",
	"听了三年了,还是会在同一个地方起鸡皮疙瘩。",
	"第一次在现场听到这首,全场大合唱的时候我哭了。",
	"适合一个人在深夜的便利店门口,喝一罐冰汽水。",
	"这首歌的间奏让我想起外婆家门口的那条小河。",
	"高中时偷偷用 MP3 听的歌,没想到在这里又遇见了。",
	"考研那年每天都听,今年终于上岸了,回来报个喜。",
	"如果你也在听这首歌,希望你今天过得开心一点。",
	"前奏的钢琴一出来,就知道这首会被我循环一整年。",
	"朋友说这首歌很像我,听完之后我沉默了很久。",
	"混音好干净,戴上耳机像是一个人站在海边。",
	"被这段和声惊艳到了,反复听了好多遍才舍得切歌。",
	"从冬天听到了夏天,从一个人听到了两个人。",
	"每日推荐终于懂我了一次,这首必须加进歌单。",
]
let newPool: [String] = [
	"刚从每日推荐过来的", "打卡,今天第三遍了", "好听到想把耳机焊在耳朵上", "有没有人和我一样是被推荐过来的",
	"前奏绝了", "收藏了,下次接着听", "晚安,听完这首就睡", "这首歌应该被更多人听到", "跑步的时候听刚刚好",
	"第一次听,已经爱上了", "周末的早上就该听这个", "副歌一出来就起鸡皮疙瘩", "谁懂啊,这个声音太温柔了",
	"每天上班路上必听", "从热评过来的,确实好听", "开车的时候放这首真舒服", "下雨天和这首更配", "歌手的声音好干净",
	"希望能出现场版", "听完想去旅行了",
]
let newDates = ["刚刚", "2分钟前", "6分钟前", "13分钟前", "27分钟前", "48分钟前", "1小时前", "3小时前", "今天 08:42", "昨天 23:15"]

struct Rng {
	var s: UInt64
	mutating func next(_ n: Int) -> Int {
		s &+= 0x9E37_79B9_7F4A_7C15
		var z = s
		z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
		z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
		z ^= z >> 31
		return Int(z % UInt64(n))
	}
}
var commentCache: [Int: (hot: [Comment], latest: [Comment])] = [:]
/// 精彩评论 5 条(按赞数从高到低,第一条就是最热)+ 最新评论 10 条。画页面和写 catalog 都走这一个函数。
func commentsOf(_ index: Int) -> (hot: [Comment], latest: [Comment]) {
	if let c = commentCache[index] { return c }
	let song = songs[index - 1]
	var rng = Rng(s: UInt64(index) &* 0x2545_F491_4F6C_DD1D)
	var usedUsers = Set<Int>(), usedHot = Set<Int>(), usedNew = Set<Int>()
	func pick(_ n: Int, _ used: inout Set<Int>, _ preferred: Int? = nil) -> Int {
		var k = preferred ?? rng.next(n)
		while used.contains(k) { k = (k + 1) % n }
		used.insert(k)
		return k
	}
	func date() -> String { "\(2018 + rng.next(8))年\(1 + rng.next(12))月\(1 + rng.next(28))日" }
	var likes = 62_000 + rng.next(58_000)
	let top = hotTemplates[(index - 1) % hotTemplates.count].replacingOccurrences(of: "{title}", with: song.title)
	var hot = [Comment(user: users[pick(users.count, &usedUsers, (index * 11) % users.count)], text: top, date: date(), likes: likes)]
	for _ in 0..<4 {
		likes = Int(Double(likes) * (0.42 + Double(rng.next(30)) / 100))
		hot.append(Comment(user: users[pick(users.count, &usedUsers)], text: hotPool[pick(hotPool.count, &usedHot)], date: date(), likes: likes))
	}
	var latest: [Comment] = []
	for k in 0..<10 {
		latest.append(Comment(user: users[pick(users.count, &usedUsers)], text: newPool[pick(newPool.count, &usedNew)], date: newDates[k], likes: rng.next(40)))
	}
	commentCache[index] = (hot, latest)
	return (hot, latest)
}
func commentTotal(_ index: Int) -> Int { 2_000 + (index * 7_919) % 120_000 }
func hottestDict(_ index: Int) -> [String: Any] {
	let c = commentsOf(index).hot[0]
	return ["user": c.user, "text": c.text, "likes": countText(c.likes)]
}
let catalog: [String: Any] = [
	"daily": songs.map { ["index": $0.index, "title": $0.title, "artist": $0.artist] as [String: Any] },
	"liked": likedOrder.enumerated().map { ["position": $0.offset + 1, "index": $0.element, "title": songs[$0.element - 1].title, "artist": songs[$0.element - 1].artist] as [String: Any] },
	"likedTitle": likedTitle,
	"hottest": Dictionary(uniqueKeysWithValues: songs.map { ("\($0.index)", hottestDict($0.index)) }),
]

func avatarColor(_ seed: String) -> NSColor {
	let h = seed.unicodeScalars.reduce(UInt32(7)) { ($0 &* 31) &+ $1.value }
	return NSColor(hue: CGFloat(h % 360) / 360, saturation: 0.45, brightness: 0.72, alpha: 1)
}
func songColors(_ s: Song) -> (NSColor, NSColor) {
	let h = CGFloat((s.index * 47) % 360) / 360
	return (NSColor(hue: h, saturation: 0.55, brightness: 0.88, alpha: 1), NSColor(hue: (h + 0.09).truncatingRemainder(dividingBy: 1), saturation: 0.7, brightness: 0.46, alpha: 1))
}

// MARK: - 画布

final class Canvas: NSView {
	// 状态
	var page = Page.home, section = Page.home
	var playlist: String?, commentsFor: Int?
	var history: [(page: Page, playlist: String?, comments: Int?)] = []
	var offsets: [Page: CGFloat] = [:]
	var loading = false, loadGen = 0, spin: CGFloat = 0, spinner: Timer?
	var selected: Int?, playing: Int?, paused = false
	var focused = false, search = "", selectAll = false
	var clicks = 0, doubleClicks = 0, scrolls = 0, keys = 0
	var events: [[String: Any]] = []
	var drawn = false
	var extra: [String: Any] = [:]

	override var isFlipped: Bool { true }
	override var acceptsFirstResponder: Bool { true }
	override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
	// 点到内容上永远是点击,不拖窗口(标题栏那条也归画布,见 hit test 实验)
	override var mouseDownCanMoveWindow: Bool { false }

	// MARK: 几何(画、命中、selftest、状态里的 layout 共用这一套)

	let sideW: CGFloat = 200, topH: CGFloat = 72, barH: CGFloat = 64, padX: CGFloat = 32, gap: CGFloat = 14
	var W: CGFloat { bounds.width }
	var H: CGFloat { bounds.height }
	var mainRect: NSRect { NSRect(x: sideW, y: topH, width: W - sideW, height: H - topH - barH) }
	var searchRect: NSRect { NSRect(x: sideW + 24, y: 28, width: 260, height: 32) }
	func navRect(_ i: Int) -> NSRect {
		NSRect(x: 12, y: i < 5 ? 100 + CGFloat(i) * 42 : 360 + CGFloat(i - 5) * 42, width: sideW - 24, height: 38)
	}
	func off(_ p: Page) -> CGFloat { offsets[p] ?? 0 }
	// 首页
	var cardW: CGFloat { floor((mainRect.width - padX * 2 - gap * 5) / 6) }
	func coverRect(_ row: Int, _ col: Int) -> NSRect {
		let y = mainRect.minY - off(.home) + 58 + CGFloat(row) * (cardW + 102)
		return NSRect(x: mainRect.minX + padX + CGFloat(col) * (cardW + gap), y: y, width: cardW, height: cardW)
	}
	func captionHeight(_ title: String) -> CGFloat { para(title, x: 0, y: 0, width: cardW, font(12.5), C.text, spacing: 2, maxHeight: 36, draw: false) }
	/// 卡片 = 封面 + 下面的标题(一行或两行),点哪儿都算点这张卡;layout 里记的也是这个框
	func cardHit(_ row: Int, _ col: Int) -> NSRect {
		let c = coverRect(row, col)
		return NSRect(x: c.minX, y: c.minY, width: c.width, height: c.height + 8 + captionHeight([topCards, hotCards][row][col].title))
	}
	func cardRect(_ title: String) -> NSRect? {
		for (row, cards) in [topCards, hotCards].enumerated() { if let col = cards.firstIndex(where: { $0.title == title }) { return cardHit(row, col) } }
		return nil
	}
	// 列表页:每日推荐 / 我喜欢的音乐(整页一起滚,表头不吸顶),行号 = 在当前这页里的位置
	var listPage: Page { page == .liked ? .liked : .daily }
	func order(_ p: Page) -> [Int] { p == .liked ? likedOrder : songs.map(\.index) }
	var dailyTop: CGFloat { mainRect.minY - off(listPage) }
	var playAllRect: NSRect { NSRect(x: mainRect.minX + padX, y: dailyTop + 108, width: 124, height: 34) }
	var collectRect: NSRect { NSRect(x: mainRect.minX + padX + 136, y: dailyTop + 108, width: 112, height: 34) }
	let rowH: CGFloat = 44
	func rowRect(_ index: Int) -> NSRect {
		NSRect(x: mainRect.minX + 16, y: dailyTop + rowsTop + CGFloat(index - 1) * rowH, width: mainRect.width - 32, height: rowH)
	}
	var colTitle: CGFloat { mainRect.minX + 78 }
	var colArtist: CGFloat { mainRect.minX + 350 }
	var colAlbum: CGFloat { mainRect.minX + 504 }
	// 表头压得紧一点:1000×680 的窗口里一进来就能看到 8 行整的(滚走表头后 12 行)
	let rowsTop: CGFloat = 188
	var dailyHeight: CGFloat { rowsTop + CGFloat(songs.count) * rowH + 24 }
	// 评论页 / 歌单页:标题栏固定,下面滚
	var backRect: NSRect { NSRect(x: mainRect.minX + 24, y: mainRect.minY + 12, width: 32, height: 32) }
	var commentsView: NSRect { NSRect(x: mainRect.minX, y: mainRect.minY + 57, width: mainRect.width, height: mainRect.height - 57) }
	// 底栏
	var barTop: CGFloat { H - barH }
	var chipRect: NSRect { NSRect(x: 96, y: barTop + 33, width: 84, height: 22) }
	var playRect: NSRect { NSRect(x: W / 2 - 17, y: barTop + 8, width: 34, height: 34) }
	var prevRect: NSRect { NSRect(x: W / 2 - 68, y: barTop + 11, width: 28, height: 28) }
	var nextRect: NSRect { NSRect(x: W / 2 + 40, y: barTop + 11, width: 28, height: 28) }

	func maxOffset(_ p: Page) -> CGFloat {
		switch p {
		case .daily, .liked: return max(0, dailyHeight - mainRect.height)
		case .comments: return max(0, (commentsFor.map { commentLayout(songs[$0 - 1]).height } ?? 0) - commentsView.height)
		case .home: return max(0, 58 + 2 * (cardW + 102) - mainRect.height)
		default: return 0
		}
	}
	func rowAt(_ p: NSPoint) -> Int? {
		guard mainRect.contains(p), p.x >= rowRect(1).minX, p.x <= rowRect(1).maxX else { return nil }
		let k = Int(floor((p.y - rowRect(1).minY) / rowH)) + 1
		return (1...songs.count).contains(k) ? k : nil
	}

	struct Block { let header: String?, comment: Comment?, y: CGFloat, h: CGFloat, textH: CGFloat, section: String, rank: Int }
	/// 评论页的竖向排版(相对可滚区域顶端):画、量最大滚动距离都用它。
	func commentLayout(_ song: Song) -> (blocks: [Block], height: CGFloat) {
		let (hot, latest) = commentsOf(song.index)
		let textW = mainRect.width - 72 - 40
		var y: CGFloat = 112, blocks: [Block] = []
		for (section, title, list) in [("精彩评论", "精彩评论", hot), ("最新评论", "最新评论 \(commentTotal(song.index))", latest)] {
			blocks.append(Block(header: title, comment: nil, y: y, h: 34, textH: 0, section: section, rank: 0))
			y += 34
			for (k, c) in list.enumerated() {
				let th = para(c.text, x: 0, y: 0, width: textW, font(14), C.text, draw: false)
				blocks.append(Block(header: nil, comment: c, y: y, h: th + 76, textH: th, section: section, rank: k + 1))
				y += th + 76
			}
			y += 18
		}
		return (blocks, y + 12)
	}

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
		fill(bounds, C.bg)
		drawSidebar()
		drawTopBar()
		clipped(mainRect) {
			if loading { drawSpinner() } else {
				switch page {
				case .home: drawHome()
				case .daily, .liked: drawDaily()
				case .comments: drawComments()
				case .playlist: drawPlaylist()
				default: drawEmpty(nav.first { $0.page == page }?.title ?? "")
				}
			}
		}
		drawBar()
		// 画面内容变了才写状态:加载圈每帧重画,但 layout 不变,不会按帧写文件
		if !drawn || !(items as NSArray).isEqual(to: layout) {
			drawn = true
			layout = items
			layoutAt = nowMs()
			DispatchQueue.main.async { self.save() }
		}
	}

	func drawSidebar() {
		fill(NSRect(x: 0, y: 0, width: sideW, height: barTop), C.side)
		gradient(NSRect(x: 24, y: 50, width: 30, height: 30), C.accentLight, C.accentDeep, 15)
		symbol("music.note", NSPoint(x: 39, y: 65), 14, .white, .bold)
		let mark = label("Melody", NSRect(x: 62, y: 49, width: 120, height: 32), font(21, .bold), C.text)
		item("text", "Melody", NSRect(x: 24, y: 50, width: mark.maxX - 24, height: 30))
		for (i, it) in nav.enumerated() {
			let r = navRect(i), on = it.page == section
			if on { gradient(r, C.accentLight, C.accentDeep, 10, 0) }
			symbol(it.icon, NSPoint(x: r.minX + 22, y: r.midY), 14, on ? .white : C.text2, on ? .semibold : .regular)
			label(it.title, NSRect(x: r.minX + 42, y: r.minY, width: r.width - 50, height: r.height), font(14, on ? .semibold : .regular), on ? .white : C.text)
			item("sidebar", it.title, r)
		}
		fill(NSRect(x: 24, y: 322, width: sideW - 48, height: 1), C.line)
		item("text", "我的", label("我的", NSRect(x: 24, y: 332, width: 100, height: 22), font(12), C.text3))
	}

	/// 单行输入框里的字:选中全部时画底色,聚焦时在末尾画一根不闪的光标(闪烁会让截图不确定)。
	func drawField(_ text: String, placeholder: String, in r: NSRect, focused on: Bool) {
		NSGraphicsContext.saveGraphicsState()
		NSBezierPath(rect: r.insetBy(dx: -2, dy: 0)).addClip()
		let f = font(13.5), w = measure(text, style(f, C.text)).width
		let shift = max(0, w - (r.width - 6))
		let tr = NSRect(x: r.minX - shift, y: r.minY, width: w + 6, height: r.height)
		if text.isEmpty { label(placeholder, r, f, C.text3) } else {
			if on && selectAll { fill(NSRect(x: tr.minX - 1, y: r.midY - 9, width: w + 2, height: 18), C.selection, 2) }
			label(text, tr, f, C.text)
		}
		if on && !(selectAll && !text.isEmpty) { fill(NSRect(x: (tr.minX + w + 1).rounded(), y: r.midY - 8, width: 1.5, height: 16), C.accent) }
		NSGraphicsContext.restoreGraphicsState()
	}

	func drawTopBar() {
		let r = searchRect
		fill(r, focused ? C.raised : C.surface, r.height / 2)
		if focused { stroke(r, C.accent.withAlphaComponent(0.55), r.height / 2) }
		symbol("magnifyingglass", NSPoint(x: r.minX + 18, y: r.midY), 12, C.text2, .medium)
		drawField(search, placeholder: "搜索音乐、歌手", in: NSRect(x: r.minX + 34, y: r.minY, width: r.width - 48, height: r.height), focused: focused)
		item("field", "搜索", r, ["value": search, "placeholder": "搜索音乐、歌手", "focused": focused])
		let ax = W - 196
		gradient(NSRect(x: ax, y: 29, width: 30, height: 30), rgb(255, 198, 122), rgb(236, 104, 120), 15)
		label("听", NSRect(x: ax, y: 29, width: 30, height: 30), font(13, .semibold), .white, .center)
		let name = label("听风的人", NSRect(x: ax + 38, y: 29, width: 70, height: 30), font(13), C.text2)
		symbol("chevron.down", NSPoint(x: name.maxX + 10, y: 44), 9, C.text3, .semibold)
		item("button", "听风的人", NSRect(x: ax, y: 29, width: name.maxX + 16 - ax, height: 30))
		symbol("envelope", NSPoint(x: W - 72, y: 44), 15, C.text2)
		item("button", "消息", NSRect(x: W - 84, y: 32, width: 24, height: 24))
		symbol("gearshape", NSPoint(x: W - 40, y: 44), 15, C.text2)
		item("button", "设置", NSRect(x: W - 52, y: 32, width: 24, height: 24))
	}

	func drawCover(_ card: Card, _ r: NSRect) {
		gradient(r, card.from, card.to, 12)
		if card.title == "每日推荐" {
			// 日历样式:顶上星期,中间大号日期。日期固定 16(不跟着今天变,截图可复现)。
			label("星期五", NSRect(x: r.minX, y: r.minY + 10, width: r.width, height: 16), font(11, .semibold), NSColor.white.withAlphaComponent(0.85), .center)
			label("16", NSRect(x: r.minX, y: r.minY + r.height * 0.2, width: r.width, height: r.height * 0.56), digits(r.width * 0.4, .heavy), .white, .center)
			label("每日推荐", NSRect(x: r.minX, y: r.maxY - 28, width: r.width, height: 18), font(11.5, .semibold), NSColor.white.withAlphaComponent(0.92), .center)
			return
		}
		NSGradient(starting: NSColor.black.withAlphaComponent(0.32), ending: NSColor.black.withAlphaComponent(0))?
			.draw(in: NSBezierPath(roundedRect: NSRect(x: r.minX, y: r.minY, width: r.width, height: 34), xRadius: 12, yRadius: 12), angle: 90)
		symbol(card.icon, NSPoint(x: r.midX, y: r.midY + 6), (r.width * 0.28).rounded(), NSColor.white.withAlphaComponent(0.9), .medium)
		let a = style(font(10.5, .medium), .white), w = measure(card.plays, a).width
		label(card.plays, NSRect(x: r.maxX - 8 - w, y: r.minY + 5, width: w + 2, height: 18), font(10.5, .medium), .white)
		symbol("play.fill", NSPoint(x: r.maxX - 15 - w, y: r.minY + 14), 7, .white)
	}

	func drawHome() {
		let m = mainRect, y0 = m.minY - off(.home)
		item("text", "下午好", label("下午好", NSRect(x: m.minX + padX, y: y0 + 12, width: 300, height: 36), font(24, .bold), C.text))
		for (row, cards) in [topCards, hotCards].enumerated() {
			if row == 1 {
				let hy = coverRect(1, 0).minY - 38
				item("text", "热门歌单", label("热门歌单", NSRect(x: m.minX + padX, y: hy, width: 200, height: 28), font(18, .bold), C.text))
				item("button", "更多 ›", label("更多 ›", NSRect(x: m.maxX - padX - 80, y: hy, width: 80, height: 28), font(12.5), C.text2, .right))
			}
			for (col, card) in cards.enumerated() {
				let r = coverRect(row, col)
				drawCover(card, r)
				para(card.title, x: r.minX, y: r.maxY + 8, width: r.width, font(12.5), C.text, spacing: 2, maxHeight: 36)
				item("card", card.title, cardHit(row, col))
			}
		}
	}

	func badge(_ tag: String, x: CGFloat, midY: CGFloat) {
		let color = tag == "VIP" ? C.accent : C.gold, f = font(9, .bold)
		let w = measure(tag, style(f, color)).width + 8
		let r = NSRect(x: x, y: (midY - 7).rounded(), width: w, height: 14)
		stroke(r, color, 3)
		label(tag, r, f, color, .center)
	}

	func cover(_ s: Song, _ r: NSRect, radius: CGFloat) {
		let (a, b) = songColors(s)
		gradient(r, a, b, radius)
		label(String(s.title.prefix(1)), r, font((r.height * 0.42).rounded(), .bold), NSColor.white.withAlphaComponent(0.92), .center)
	}

	func drawDaily() {
		let m = mainRect, cy = dailyTop
		let tile = NSRect(x: m.minX + padX, y: cy + 14, width: 80, height: 80), liked = page == .liked
		gradient(tile, rgb(255, 104, 96), C.accentDeep, 14)
		if liked {
			symbol("heart.fill", NSPoint(x: tile.midX, y: tile.midY), 30, .white)
		} else {
			label("星期五", NSRect(x: tile.minX, y: tile.minY + 7, width: tile.width, height: 15), font(10.5, .semibold), NSColor.white.withAlphaComponent(0.85), .center)
			label("16", NSRect(x: tile.minX, y: tile.minY + 19, width: tile.width, height: 54), digits(37, .heavy), .white, .center)
			item("text", "16", tile)
		}
		let title = liked ? likedTitle : "每日推荐"
		item("text", title, label(title, NSRect(x: m.minX + 130, y: cy + 18, width: 400, height: 40), font(27, .bold), C.text))
		let sub = liked ? "歌单 · 听风的人 · 2024-03-02 创建" : "根据你的音乐口味生成 · 每天 6:00 更新"
		item("text", sub, label(sub, NSRect(x: m.minX + 130, y: cy + 62, width: 420, height: 20), font(13), C.text2))
		let pa = playAllRect
		gradient(pa, C.accentLight, C.accentDeep, pa.height / 2, 0)
		symbol("play.fill", NSPoint(x: pa.minX + 27, y: pa.midY), 12, .white)
		label("播放全部", NSRect(x: pa.minX + 42, y: pa.minY, width: pa.width - 48, height: pa.height), font(14, .semibold), .white)
		item("button", "播放全部", pa)
		let co = collectRect
		fill(co, C.surface, co.height / 2)
		symbol("plus.square.on.square", NSPoint(x: co.minX + 24, y: co.midY), 12, C.text)
		label("收藏全部", NSRect(x: co.minX + 40, y: co.minY, width: co.width - 46, height: co.height), font(14), C.text)
		item("button", "收藏全部", co)
		let total = "共 \(songs.count) 首"
		item("text", total, label(total, NSRect(x: co.maxX + 16, y: co.minY, width: 100, height: co.height), font(12.5), C.text3))
		let hy = cy + rowsTop - 34
		for (title, x, w, align) in [("#", m.minX + padX, CGFloat(30), NSTextAlignment.left), ("标题", colTitle, 100, .left), ("歌手", colArtist, 100, .left),
			("专辑", colAlbum, 100, .left), ("时长", m.maxX - 36 - 60, 60, .right)] {
			item("text", title, label(title, NSRect(x: x, y: hy, width: w, height: 28), font(12), C.text3, align))
		}
		fill(NSRect(x: m.minX + 16, y: hy + 29, width: m.width - 32, height: 1), C.line)
		for (k, i) in order(listPage).enumerated() {
			let s = songs[i - 1], pos = k + 1, r = rowRect(pos)
			guard r.maxY > m.minY, r.minY < m.maxY else { continue }
			let isSel = selected == s.index, isPlay = playing == s.index
			if isSel { fill(r, C.rowSel, 8) } else if pos % 2 == 0 { fill(r, C.rowAlt, 8) }
			if isPlay { symbol(paused ? "speaker.fill" : "speaker.wave.2.fill", NSPoint(x: m.minX + padX + 8, y: r.midY), 12, C.accent) }
			else { label(String(format: "%02d", pos), NSRect(x: m.minX + padX, y: r.minY, width: 30, height: r.height), digits(13), C.text3) }
			let tr = label(s.title, NSRect(x: colTitle, y: r.minY, width: 240, height: r.height), font(14, isPlay ? .medium : .regular), isPlay ? C.accent : C.text)
			if !s.tag.isEmpty { badge(s.tag, x: min(tr.maxX + 8, colArtist - 40), midY: r.midY) }
			label(s.artist, NSRect(x: colArtist, y: r.minY, width: 140, height: r.height), font(13), isPlay ? C.accent.withAlphaComponent(0.85) : C.text2)
			label(s.album, NSRect(x: colAlbum, y: r.minY, width: 150, height: r.height), font(13), C.text2)
			label(s.duration, NSRect(x: m.maxX - 36 - 60, y: r.minY, width: 60, height: r.height), digits(13), C.text3, .right)
			item("row", "\(String(format: "%02d", pos)) \(s.title) — \(s.artist)", r,
				["index": s.index, "position": pos, "title": s.title, "artist": s.artist, "album": s.album, "playing": isPlay, "selected": isSel])
		}
	}

	func backButton() {
		oval(backRect, C.surface)
		symbol("chevron.left", NSPoint(x: backRect.midX - 1, y: backRect.midY), 13, C.text, .semibold)
		item("button", "‹", backRect)
	}

	func drawComments() {
		guard let index = commentsFor else { return }
		let s = songs[index - 1], m = mainRect, view = commentsView
		clipped(view) {
			let cy = view.minY - off(.comments)
			let card = NSRect(x: m.minX + 24, y: cy + 16, width: m.width - 48, height: 76)
			fill(card, C.surface.withAlphaComponent(0.55), 12)
			cover(s, NSRect(x: card.minX + 12, y: card.minY + 12, width: 52, height: 52), radius: 8)
			item("text", s.title, label(s.title, NSRect(x: card.minX + 78, y: card.minY + 13, width: card.width - 100, height: 24), font(15, .semibold), C.text))
			let meta = "歌手:\(s.artist)      专辑:\(s.album)"
			item("text", meta, label(meta, NSRect(x: card.minX + 78, y: card.minY + 41, width: card.width - 100, height: 20), font(12.5), C.text2))
			let textW = m.width - 72 - 40
			for b in commentLayout(s).blocks {
				let by = cy + b.y
				guard by + b.h > view.minY, by < view.maxY else { continue }
				if let h = b.header {
					item("text", h, label(h, NSRect(x: m.minX + 24, y: by + 2, width: 300, height: 28), font(16, .bold), C.text))
					continue
				}
				guard let c = b.comment else { continue }
				let av = NSRect(x: m.minX + 24, y: by + 14, width: 36, height: 36)
				oval(av, avatarColor(c.user))
				label(String(c.user.prefix(1)), av, font(14, .semibold), .white, .center)
				label(c.user, NSRect(x: m.minX + 72, y: by + 12, width: 320, height: 20), font(13), C.link)
				para(c.text, x: m.minX + 72, y: by + 38, width: textW, font(14), C.text)
				let ly = by + 38 + b.textH + 10
				label(c.date, NSRect(x: m.minX + 72, y: ly, width: 200, height: 18), font(12), C.text3)
				let likes = c.likes > 0 ? countText(c.likes) : ""
				let lw = measure(likes, style(font(12), C.text2)).width
				label(likes, NSRect(x: m.maxX - 40 - lw, y: ly, width: lw + 2, height: 18), font(12), C.text2)
				symbol("hand.thumbsup", NSPoint(x: m.maxX - 40 - lw - (likes.isEmpty ? 0 : 12), y: ly + 9), 12, C.text2)
				fill(NSRect(x: m.minX + 72, y: by + b.h - 1, width: m.width - 112, height: 1), C.line)
				// 一条评论 = 头像、名字、正文、日期、赞数那一整块
				item("comment", String(c.text.prefix(20)), NSRect(x: m.minX + 24, y: by + 10, width: m.width - 64, height: b.textH + 58),
					["section": b.section, "rank": b.rank, "user": c.user, "text": c.text, "likes": likes, "date": c.date])
			}
		}
		backButton()
		let title = "歌曲评论 · \(s.title)"
		item("text", title, label(title, NSRect(x: m.minX + 68, y: m.minY + 12, width: m.width - 100, height: 32), font(18, .bold), C.text))
		fill(NSRect(x: m.minX + 24, y: m.minY + 56, width: m.width - 48, height: 1), C.line)
	}

	func drawPlaylist() {
		let m = mainRect, card = (topCards + hotCards).first { $0.title == playlist } ?? hotCards[0]
		backButton()
		item("text", "歌单", label("歌单", NSRect(x: m.minX + 68, y: m.minY + 12, width: 200, height: 32), font(18, .bold), C.text))
		drawCover(card, NSRect(x: m.minX + padX, y: m.minY + 72, width: 132, height: 132))
		item("text", card.title, label(card.title, NSRect(x: m.minX + 188, y: m.minY + 84, width: m.width - 220, height: 36), font(24, .bold), C.text))
		let meta = "歌单 · 共 0 首 · 播放 \(card.plays.isEmpty ? "0" : card.plays) 次"
		item("text", meta, label(meta, NSRect(x: m.minX + 188, y: m.minY + 126, width: 420, height: 20), font(13), C.text2))
		symbol("tray", NSPoint(x: m.midX, y: m.minY + 300), 38, C.text3, .light)
		item("text", "暂无内容", label("暂无内容", NSRect(x: m.minX, y: m.minY + 334, width: m.width, height: 22), font(14), C.text3, .center))
	}

	func drawEmpty(_ title: String) {
		let m = mainRect
		item("text", title, label(title, NSRect(x: m.minX + padX, y: m.minY + 12, width: 400, height: 36), font(24, .bold), C.text))
		symbol("tray", NSPoint(x: m.midX, y: m.midY - 12), 40, C.text3, .light)
		item("text", "暂无内容", label("暂无内容", NSRect(x: m.minX, y: m.midY + 24, width: m.width, height: 22), font(14), C.text3, .center))
	}

	func drawSpinner() {
		let m = mainRect, c = NSPoint(x: m.midX, y: m.midY - 18), r: CGFloat = 16
		let track = NSBezierPath()
		track.appendArc(withCenter: c, radius: r, startAngle: 0, endAngle: 360)
		track.lineWidth = 3
		C.surface.setStroke()
		track.stroke()
		let arc = NSBezierPath()
		arc.appendArc(withCenter: c, radius: r, startAngle: spin, endAngle: spin + 110)
		arc.lineWidth = 3
		arc.lineCapStyle = .round
		C.accent.setStroke()
		arc.stroke()
		item("spinner", "", NSRect(x: c.x - r - 2, y: c.y - r - 2, width: 2 * r + 4, height: 2 * r + 4))
		item("text", "加载中...", label("加载中...", NSRect(x: m.minX, y: c.y + 30, width: m.width, height: 20), font(13), C.text2, .center))
	}

	func drawBar() {
		let y0 = barTop, cx = W / 2
		fill(NSRect(x: 0, y: y0, width: W, height: barH), C.bar)
		fill(NSRect(x: 0, y: y0, width: W, height: 1), C.line)
		let coverR = NSRect(x: 16, y: y0 + 10, width: 44, height: 44)
		if let i = playing {
			let s = songs[i - 1]
			cover(s, coverR, radius: 8)
			let t = label(s.title, NSRect(x: 72, y: y0 + 9, width: 180, height: 22), font(14, .medium), C.text)
			let a = label(" - \(s.artist)", NSRect(x: t.maxX, y: y0 + 9, width: max(0, cx - 110 - t.maxX), height: 22), font(12.5), C.text2)
			item("text", "\(s.title) - \(s.artist)", t.union(a))
			symbol("heart", NSPoint(x: 81, y: y0 + 44), 13, C.text2)
			item("button", "喜欢", NSRect(x: 72, y: y0 + 36, width: 18, height: 16))
			stroke(chipRect, C.text3, chipRect.height / 2)
			let chip = "评论 \(countText(commentTotal(i)))"
			label(chip, chipRect, font(11.5), C.text2, .center)
			item("chip", chip, chipRect, ["for": i])
		} else {
			fill(coverR, C.surface, 8)
			symbol("music.note", NSPoint(x: coverR.midX, y: coverR.midY), 16, C.text3)
			item("text", "未在播放", label("未在播放", NSRect(x: 72, y: y0 + 12, width: 200, height: 40), font(14), C.text2))
		}
		let active = playing != nil, showPause = active && !paused
		symbol("backward.end.fill", NSPoint(x: prevRect.midX, y: prevRect.midY), 14, active ? C.text : C.text3)
		oval(playRect, active ? C.accent : C.surface)
		symbol(showPause ? "pause.fill" : "play.fill", NSPoint(x: playRect.midX + (showPause ? 0 : 1), y: playRect.midY), 14, active ? .white : C.text3)
		symbol("forward.end.fill", NSPoint(x: nextRect.midX, y: nextRect.midY), 14, active ? C.text : C.text3)
		item("button", "上一首", prevRect)
		item("button", showPause ? "暂停" : "播放", playRect)
		item("button", "下一首", nextRect)
		let track = NSRect(x: cx - 170, y: y0 + 51, width: 340, height: 3)
		fill(track, C.raised, 1.5)
		var elapsed = "00:00", total = "00:00"
		if let i = playing {
			// 进度是静止的(固定 32%):播放进度一直走的话截图永远「稳定不下来」
			let s = songs[i - 1], sec = Int(Double(s.seconds) * 0.32)
			elapsed = String(format: "%02d:%02d", sec / 60, sec % 60)
			total = s.duration
			fill(NSRect(x: track.minX, y: track.minY, width: track.width * 0.32, height: 3), C.accent, 1.5)
			oval(NSRect(x: track.minX + track.width * 0.32 - 4, y: track.midY - 4, width: 8, height: 8), .white)
		}
		item("text", elapsed, label(elapsed, NSRect(x: track.minX - 50, y: y0 + 44, width: 42, height: 16), digits(10.5), C.text3, .right))
		item("text", total, label(total, NSRect(x: track.maxX + 8, y: y0 + 44, width: 42, height: 16), digits(10.5), C.text3))
		let ly = NSRect(x: W - 162, y: y0 + 22, width: 20, height: 20)
		stroke(ly, C.text2, 4)
		label("词", ly, font(11, .medium), C.text2, .center)
		item("button", "词", ly)
		symbol("speaker.wave.2", NSPoint(x: W - 108, y: y0 + 32), 14, C.text2)
		item("button", "音量", NSRect(x: W - 120, y: y0 + 22, width: 24, height: 20))
		symbol("list.bullet", NSPoint(x: W - 66, y: y0 + 32), 14, C.text2)
		label("\(songs.count)", NSRect(x: W - 56, y: y0 + 20, width: 30, height: 14), font(9.5, .semibold), C.text3)
		item("button", "播放列表", NSRect(x: W - 78, y: y0 + 20, width: 40, height: 24))
	}

	// MARK: 输入(真实事件只做坐标换算,逻辑在 handle*;selftest 直接调 handle*)

	override func mouseDown(with event: NSEvent) {
		window?.makeFirstResponder(self)
		handleClick(convert(event.locationInWindow, from: nil), count: event.clickCount)
	}
	override func scrollWheel(with event: NSEvent) {
		// 像素单位(helper 发的就是)直接用;老式滚轮的「行」换成点
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
		if searchRect.contains(p) {
			if !focused { focused = true; log("focus", "search") }
			selectAll = false
			return
		}
		if focused { blur() }
		for (i, item) in nav.enumerated() where navRect(i).contains(p) { goSection(item); return }
		if p.y >= barTop { clickBar(p); return }
		guard mainRect.contains(p), !loading else { return }
		switch page {
		case .home:
			for (row, cards) in [topCards, hotCards].enumerated() {
				for (col, card) in cards.enumerated() where cardHit(row, col).contains(p) { openCard(card); return }
			}
		case .daily, .liked:
			if playAllRect.contains(p) { play(order(page)[0]); return }
			if let k = rowAt(p) {
				let i = order(page)[k - 1]
				if selected != i { selected = i; log("select", "\(i) \(songs[i - 1].title)") }
				if count >= 2 { play(i) }
			}
		case .comments, .playlist:
			if backRect.contains(p) { back() }
		default: break
		}
	}

	func clickBar(_ p: NSPoint) {
		guard let i = playing else { return }
		if chipRect.contains(p) { openComments(i) }
		else if playRect.contains(p) { paused.toggle(); log(paused ? "pause" : "resume", "\(i) \(songs[i - 1].title)") }
		else if prevRect.contains(p) { play(i == 1 ? songs.count : i - 1) }
		else if nextRect.contains(p) { play(i == songs.count ? 1 : i + 1) }
	}

	func handleScroll(_ p: NSPoint, dx: CGFloat, dy: CGFloat) {
		// 只数带位移的:桥接层垫的那个零位移事件不算一次滚动(同 main.swift)
		guard dx != 0 || dy != 0 else { return }
		scrolls += 1
		defer { changed() }
		guard mainRect.contains(p), !loading, [.home, .daily, .liked, .comments].contains(page) else { return }
		let old = off(page), new = min(maxOffset(page), max(0, old - dy))
		if new != old { offsets[page] = new; log("scroll", "\(page.rawValue):\(Int(new))", coalesce: true) }
	}

	func handleKey(_ chars: String, ignoring: String, code: UInt16, flags: NSEvent.ModifierFlags) {
		keys += 1
		defer { changed() }
		let mods = modifierNames(flags)
		// 有名字的键单独记一条 key 事件(回车 / 删除 / Esc / 方向键 / Cmd 组合键);打的字并进 text 事件
		if let name = keyName(code) {
			log("key", mods + name)
			guard focused else { return }
			switch code {
			case 36, 76: submit()
			case 51: backspace()
			case 117: if selectAll { backspace() }
			case 53: blur()
			default: break
			}
			return
		}
		if flags.contains(.command) || flags.contains(.control) {
			let key = ignoring.lowercased()
			log("key", mods + key.uppercased())
			guard focused else { return }
			if flags.contains(.command) && key == "a" { selectAll = !search.isEmpty; if selectAll { log("select-all", "search") } }
			else if flags.contains(.command) && key == "v", let s = NSPasteboard.general.string(forType: .string) { insert(s); log("paste", "search") }
			return
		}
		var run = ""
		for ch in chars {
			if ch == "\r" || ch == "\n" || ch == "\u{3}" { typed(run); run = ""; log("key", "Return"); if focused { submit() } }
			else if ch == "\u{7F}" || ch == "\u{8}" { typed(run); run = ""; log("key", "Delete"); if focused { backspace() } }
			else if ch == "\u{1B}" { typed(run); run = ""; log("key", "Esc"); if focused { blur() } }
			else if let u = ch.unicodeScalars.first, u.value >= 0x20, !(0xF700...0xF8FF).contains(u.value) { run.append(ch) }
		}
		typed(run)
	}
	/// 打的字:搜索框有焦点就进去;没焦点就记一条「打到了空气里」的 key 事件(连着打的并成一条)
	func typed(_ s: String) {
		guard !s.isEmpty else { return }
		if focused { insert(s); return }
		let tail = " → nothing"
		if let last = events.last, last["kind"] as? String == "key", let d = last["detail"] as? String, d.hasSuffix(tail) {
			events[events.count - 1] = ["t": nowMs(), "kind": "key", "detail": String(d.dropLast(tail.count)) + s + tail]
		} else {
			log("key", s + tail)
		}
	}

	func insert(_ s: String) {
		let clean = s.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
		guard !clean.isEmpty else { return }
		if selectAll { search = ""; selectAll = false }
		search += clean
		log("text", "search=\(search)", coalesce: true, within: .max)
	}
	func backspace() {
		guard !search.isEmpty else { return }
		if selectAll { search = ""; selectAll = false } else { search.removeLast() }
		log("text", "search=\(search)", coalesce: true, within: .max)
	}
	// 搜索没做(spec 允许):回车只记一条事件
	func submit() { log("search", search) }
	func blur() { focused = false; selectAll = false; log("focus", "none") }

	// MARK: 导航

	func setPage(_ p: Page, playlist name: String? = nil, comments: Int? = nil) {
		page = p
		playlist = p == .playlist ? name : nil
		commentsFor = p == .comments ? comments : nil
		log("page", p == .playlist ? "playlist:\(name ?? "")" : p == .comments ? "comments:\(comments ?? 0)" : p.rawValue)
	}
	func push() { history.append((page, playlist, commentsFor)) }
	func goSection(_ item: Nav) {
		if loading { stopLoading("cancel") }
		history = []
		section = item.page
		offsets[item.page] = 0
		setPage(item.page)
	}
	func openCard(_ card: Card) {
		push()
		if card.title == "每日推荐" { offsets[.daily] = 0; setPage(.daily) } else { setPage(.playlist, playlist: card.title) }
		startLoading(autoEnd: true)
	}
	func openComments(_ i: Int) {
		if page != .comments { push() }
		offsets[.comments] = 0
		setPage(.comments, comments: i)
		log("comments", "\(i) \(songs[i - 1].title)")
	}
	func back() {
		let prev = history.popLast() ?? (.home, nil, nil)
		log("back", page.rawValue)
		setPage(prev.page, playlist: prev.playlist, comments: prev.comments)
	}
	func play(_ i: Int) {
		playing = i
		paused = false
		log("play", "\(i) \(songs[i - 1].title) - \(songs[i - 1].artist)")
	}

	/// 700ms 的加载圈:圈按 20fps 转(截图前后两张不一样,「等画面稳定」才有意义),但不按帧写状态。
	/// loadGen 防止上一次加载的定时器在别的页面上把 loading 掐掉。
	func startLoading(autoEnd: Bool) {
		loading = true
		loadGen += 1
		let gen = loadGen
		log("loading", "start")
		spinner?.invalidate()
		let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
			guard let self else { return }
			self.spin = (self.spin + 24).truncatingRemainder(dividingBy: 360)
			self.needsDisplay = true
		}
		RunLoop.main.add(timer, forMode: .common)
		spinner = timer
		guard autoEnd else { return }
		// 显式 1ms 容差:asyncAfter 的缺省容差会把 700ms 拖到 730+
		let end = DispatchSource.makeTimerSource(queue: .main)
		end.schedule(deadline: .now() + .milliseconds(700), leeway: .milliseconds(1))
		end.setEventHandler { [weak self] in
			end.cancel()
			guard let self, self.loading, self.loadGen == gen else { return }
			self.stopLoading("end")
			self.changed()
		}
		end.resume()
	}
	func stopLoading(_ how: String) {
		loading = false
		loadGen += 1
		spinner?.invalidate()
		spinner = nil
		log("loading", how)
	}

	/// --page:只给截图冒烟用,直接摆到某一页。
	func apply(page spec: String?) {
		guard let spec, !spec.isEmpty else { return }
		let parts = spec.split(separator: ":", maxSplits: 1).map(String.init)
		let arg = parts.count > 1 ? parts[1] : ""
		switch parts[0] {
		case "home": break
		case "daily": history = [(.home, nil, nil)]; page = .daily
		case "loading": history = [(.home, nil, nil)]; page = .daily; startLoading(autoEnd: false)
		case "comments":
			let i = min(songs.count, max(1, Int(arg) ?? 1))
			history = [(.home, nil, nil), (.daily, nil, nil)]
			page = .comments; commentsFor = i; playing = i
		case "playlist":
			history = [(.home, nil, nil)]
			page = .playlist; playlist = (topCards + hotCards).first { $0.title == arg }?.title ?? hotCards[1].title
		default:
			if let p = Page(rawValue: parts[0]), nav.contains(where: { $0.page == p }) { page = p; section = p }
		}
	}
	/// --play:开场就在放这一首(不选中、不记 play 事件 —— 不是用户操作)
	func apply(play index: Int?) {
		guard let index, (1...songs.count).contains(index) else { return }
		playing = index
		paused = false
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
			"page": page.rawValue, "section": section.rawValue, "loading": loading,
			"selected": selected.map { $0 as Any } ?? NSNull(),
			"playing": playing.map { ["index": $0, "title": songs[$0 - 1].title, "artist": songs[$0 - 1].artist] as Any } ?? NSNull(),
			"paused": paused,
			"comments": (page == .comments ? commentsFor : nil).map { ["for": $0, "hottest": hottestDict($0)] as Any } ?? NSNull(),
			"playlist": playlist.map { $0 as Any } ?? NSNull(),
			"focus": focused ? "search" as Any : NSNull(), "search": search, "selectAll": selectAll,
			"offsets": ["home": Double(off(.home)), "daily": Double(off(.daily)), "liked": Double(off(.liked)), "comments": Double(off(.comments))],
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
			"catalog": catalog,
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
	var failures: [String] = [], loadingMs: [Int] = []
	var steps: [(delay: Double, run: () -> Void)] = []
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
	func doubleClick(_ r: NSRect?) { click(r, 1); click(r, 2) }
	func key(_ s: String, code: UInt16 = 0, flags: NSEvent.ModifierFlags = []) { c.handleKey(s, ignoring: s, code: code, flags: flags) }
	func scroll(_ dy: CGFloat) { c.handleScroll(NSPoint(x: c.mainRect.midX, y: c.mainRect.midY + 40), dx: 0, dy: dy) }
	func lastLoadingMs() -> Int? {
		guard let end = c.events.lastIndex(where: { $0["kind"] as? String == "loading" && $0["detail"] as? String == "end" }),
			let start = c.events[..<end].lastIndex(where: { $0["kind"] as? String == "loading" && $0["detail"] as? String == "start" }),
			let t1 = c.events[end]["t"] as? Int64, let t0 = c.events[start]["t"] as? Int64 else { return nil }
		return Int(t1 - t0)
	}
	func then(_ delay: Double = 0, _ run: @escaping () -> Void) { steps.append((delay, run)) }

	func build() {
		then {
			// 数据自检:最热评论各不相同、第一条赞最多、精彩评论 20–40 字
			let hottest = songs.map { commentsOf($0.index).hot[0].text }
			self.expect(Set(hottest).count == songs.count, "hottest comments must differ per song")
			for s in songs {
				let hot = commentsOf(s.index).hot
				self.expect(hot.count == 5 && commentsOf(s.index).latest.count == 10, "comment counts for \(s.index)")
				self.expect(zip(hot, hot.dropFirst()).allSatisfy { $0.likes > $1.likes }, "hot comments sorted by likes for \(s.index)")
				for h in hot { self.expect((20...40).contains(h.text.count), "hot comment length \(h.text.count) for \(s.index): \(h.text)") }
			}
			let c = self.c
			self.expect(c.page == .home && !c.loading && c.playing == nil, "starts on home, idle")
			self.click(c.cardRect("每日推荐"))
			self.expectHit("card 每日推荐")
			self.expect(c.page == .daily && c.loading, "每日推荐 opens daily with loading")
			self.click(c.rowRect(1))
			self.expectHit("nothing")
			self.expect(c.selected == nil, "rows are not clickable while loading")
		}
		then(1.0) {
			let c = self.c
			self.expect(!c.loading, "loading ends")
			if let ms = self.lastLoadingMs() { self.loadingMs.append(ms); self.expect((650...1000).contains(ms), "loading took \(ms)ms") } else { self.expect(false, "loading events") }
			self.click(c.rowRect(3))
			self.expectHit("row 03 夜に溶ける — 青山ハル")
			self.expect(c.selected == 3 && c.playing == nil, "single click selects only")
			self.doubleClick(c.rowRect(3))
			self.expect(c.playing == 3 && c.doubleClicks == 1, "double click plays")
			self.scroll(-300)
			self.expect(c.off(.daily) == 300, "scroll daily by 300 (got \(c.off(.daily)))")
			self.scroll(5000)
			self.expect(c.off(.daily) == 0, "scroll clamps at top")
			self.scroll(-100_000)
			self.expect(c.off(.daily) == c.maxOffset(.daily) && c.rowRect(30).maxY <= c.mainRect.maxY + 0.5, "scroll clamps at bottom, row 30 visible")
			self.doubleClick(c.rowRect(30))
			self.expect(c.playing == 30 && c.selected == 30, "double click row 30")
			self.click(NSRect(x: c.mainRect.midX, y: c.mainRect.maxY - 2, width: 1, height: 1))
			self.scroll(100_000)
			self.click(c.chipRect)
			self.expectHit("chip 评论")
			self.expect(c.page == .comments && c.commentsFor == 30, "chip opens comments of the playing song")
			let hottest = (catalog["hottest"] as? [String: Any])?["30"] as? [String: Any]
			self.expect(hottest?["text"] as? String == commentsOf(30).hot[0].text, "catalog hottest == first 精彩评论")
			self.scroll(-200)
			self.expect(c.off(.comments) == min(200, c.maxOffset(.comments)) && c.maxOffset(.comments) > 0, "comments scroll")
			self.click(c.backRect)
			self.expectHit("button ‹")
			self.expect(c.page == .daily && c.commentsFor == nil, "back returns to daily")
			self.click(c.playAllRect)
			self.expectHit("button 播放全部")
			self.expect(c.playing == 1, "播放全部 plays row 1")
			self.click(c.nextRect); self.expectHit("button 下一首"); self.expect(c.playing == 2, "next")
			self.click(c.prevRect); self.expectHit("button 上一首"); self.expect(c.playing == 1, "prev")
			self.click(c.playRect); self.expectHit("button 暂停"); self.expect(c.paused, "pause")
			self.click(c.playRect); self.expectHit("button 播放"); self.expect(!c.paused, "resume")
			self.click(c.searchRect)
			self.expectHit("field 搜索")
			self.expect(c.focused, "search focus")
			self.key("夜に")
			self.expect(c.search == "夜に", "CJK in one key event")
			self.key("a")
			self.expect(c.search == "夜にa", "ascii key")
			self.key("a", flags: .command)
			self.expect(c.selectAll && c.search == "夜にa", "cmd+a selects all")
			self.key("溶")
			self.expect(c.search == "溶" && !c.selectAll, "typing replaces selection")
			self.key("\u{7F}", code: 51)
			self.expect(c.search == "", "delete")
			self.key("风停\r")
			self.expect(c.search == "风停" && c.events.last?["kind"] as? String == "search" && c.events.dropLast().last?["detail"] as? String == "Return", "newline submits")
			self.key("\u{1B}", code: 53)
			self.expect(!c.focused, "escape blurs")
			self.key("x")
			self.expect(c.search == "风停", "typing without focus does nothing")
			self.click(c.navRect(1))
			self.expectHit("sidebar 精选")
			self.expect(c.page == .featured && c.section == .featured, "sidebar 精选")
			self.click(c.navRect(0))
			self.expect(c.page == .home, "sidebar 推荐")
			self.click(c.cardRect("每日新歌速递"))
			self.expectHit("card 每日新歌速递")
			self.expect(c.page == .playlist && c.loading, "distractor card loads a playlist")
		}
		then(1.0) {
			let c = self.c
			self.expect(!c.loading && c.playlist == "每日新歌速递", "playlist loaded")
			if let ms = self.lastLoadingMs() { self.loadingMs.append(ms) }
			self.click(c.backRect)
			self.expect(c.page == .home, "back from playlist")
			self.click(c.cardRect("每日推荐"))
			self.click(c.navRect(5))
			self.expect(c.page == .liked && !c.loading, "sidebar cancels loading")
		}
		then(1.0) {
			let c = self.c
			self.expect(c.page == .liked && !c.loading, "stale loading timer does not fire")
			self.expect(likedOrder.sorted() == songs.map(\.index), "liked is a reordering of all songs")
			self.click(c.rowRect(1))
			self.expectHit("row 01 \(songs[likedOrder[0] - 1].title)")
			self.expect(c.selected == likedOrder[0], "liked row 1 selects the song at position 1")
			self.scroll(-300)
			self.expect(c.off(.liked) == 300 && c.off(.daily) == 0, "liked scrolls on its own (got \(c.off(.liked)))")
			self.scroll(-200)
			self.doubleClick(c.rowRect(18))
			self.expectHit("row 18 \(songs[likedOrder[17] - 1].title)")
			self.expect(c.playing == likedOrder[17] && likedOrder[17] != 18, "liked row 18 plays position 18, not song 18")
			self.scroll(-100_000)
			self.expect(c.off(.liked) == c.maxOffset(.liked) && c.rowRect(30).maxY <= c.mainRect.maxY + 0.5, "liked clamps at bottom")
			self.click(c.navRect(0))
			self.click(c.cardRect("每日推荐"))
		}
		then(1.0) {
			// 收尾摆成一个信息量大的画面(给 --hold 截图):第 4 首在播、第 6 首选中、搜索框聚焦有字
			let c = self.c
			if let ms = self.lastLoadingMs() { self.loadingMs.append(ms) }
			self.doubleClick(c.rowRect(4))
			self.click(c.rowRect(6))
			self.click(c.searchRect)
			self.key("a", flags: .command)
			self.key("夜に溶")
			self.expect(c.playing == 4 && c.selected == 6 && c.focused && c.search == "夜に溶", "final state")
		}
	}

	func run(_ done: @escaping ([String: Any]) -> Void) {
		build()
		func step(_ i: Int) {
			guard i < steps.count else {
				done(["pass": failures.isEmpty, "failures": failures, "loadingMs": loadingMs])
				return
			}
			DispatchQueue.main.asyncAfter(deadline: .now() + steps[i].delay) {
				self.steps[i].run()
				step(i + 1)
			}
		}
		step(0)
	}
}

// MARK: - App

final class Delegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
	let window: NSWindow
	let canvas = Canvas()
	var hide: DispatchSourceSignal?
	var activity: NSObjectProtocol?
	var selfTest: SelfTest?

	override init() {
		let f = options.frame ?? NSRect(x: 120, y: 90, width: 1000, height: 680)
		let ph = NSScreen.screens.first?.frame.height ?? (f.maxY + 100)
		window = NSWindow(contentRect: NSRect(x: f.minX, y: ph - f.minY - f.height, width: f.width, height: f.height),
			styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
		super.init()
	}

	func applicationDidFinishLaunching(_ notification: Notification) {
		// 后台 + 被挡住的窗口正是 App Nap 会节流的对象,700ms 的加载会被拖长:整个进程期间关掉
		activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: "CU fixture timers")
		window.title = "Melody"
		// 和微信 / 网易云一样不显示标题文字:无障碍树里只剩窗口和标题栏按钮(同 main.swift)
		window.titleVisibility = .hidden
		window.titlebarAppearsTransparent = true
		window.appearance = NSAppearance(named: .darkAqua)
		window.backgroundColor = C.bg
		window.isRestorable = false
		window.isReleasedWhenClosed = false
		window.contentView = canvas
		window.delegate = self
		if let f = options.frame, let ph = NSScreen.screens.first?.frame.height {
			window.setFrame(NSRect(x: f.minX, y: ph - f.minY - f.height, width: f.width, height: f.height), display: false)
		}
		window.makeFirstResponder(canvas)
		canvas.apply(page: options.page)
		canvas.apply(play: options.play)
		canvas.log("launch", canvas.page.rawValue + (canvas.playing.map { " play=\($0)" } ?? ""))
		signal(SIGUSR1, SIG_IGN)
		hide = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
		hide?.setEventHandler { [self] in window.orderOut(nil); canvas.log("window", "hidden"); canvas.save() }
		hide?.resume()
		if options.selftest {
			if options.hold { show() }
			let test = SelfTest(canvas)
			selfTest = test
			test.run { [self] result in
				canvas.extra["selftest"] = result
				canvas.save()
				if let data = try? JSONSerialization.data(withJSONObject: result), let line = String(data: data, encoding: .utf8) { print(line) }
				fflush(stdout)
				if !options.hold { exit((result["pass"] as? Bool) == true ? 0 : 1) }
			}
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
app.setActivationPolicy(options.noActivate ? .prohibited : options.selftest && !options.hold ? .accessory : .regular)
app.run()
