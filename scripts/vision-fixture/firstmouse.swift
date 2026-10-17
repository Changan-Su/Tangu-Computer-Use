// first-click 检查的替身(scripts/first-click.check.mjs):一块点一下就换颜色的板,acceptsFirstMouse 用 AppKit 缺省(NO)——
// 大多数原生 App 的视图就是这样:App 不在前台时收到的那一下点击只用来激活,不交给视图。Chatter / Melody 都返回 YES,测不到这个。
// 状态文件记:每次视图收到 mouseDown 时 App 在不在前台,队列里看到的鼠标按下(派发前),App 激活 / 失活。
// 命令行:<exe> <statePath> --frame x,y,w,h(整个窗口,全局屏幕点、左上角原点)
import AppKit

var statePath = "/dev/null"
var frame = NSRect(x: 200, y: 200, width: 600, height: 400)
var argv = Array(CommandLine.arguments.dropFirst())
if let first = argv.first, !first.hasPrefix("--") { statePath = first; argv.removeFirst() }
if let i = argv.firstIndex(of: "--frame"), i + 1 < argv.count {
	let n = argv[i + 1].split(separator: ",").compactMap { Double($0) }
	if n.count == 4 { frame = NSRect(x: n[0], y: n[1], width: n[2], height: n[3]) }
}

var events: [[String: Any]] = []
var clicks = 0
func log(_ kind: String) {
	events.append(["t": Int(Date().timeIntervalSince1970 * 1000), "kind": kind, "active": NSApp.isActive])
	save()
}

final class Pad: NSView {
	override var isFlipped: Bool { true }
	// 无障碍里露成一个没有按压动作的分组:检查按 ref 点它的中心(没有录屏授权的 dev helper 截不到图,只能按 ref)
	override func isAccessibilityElement() -> Bool { true }
	override func accessibilityRole() -> NSAccessibility.Role? { .group }
	override func accessibilityLabel() -> String? { "first-click pad" }
	override func draw(_ dirtyRect: NSRect) {
		(clicks % 2 == 0 ? NSColor.systemTeal : NSColor.systemOrange).setFill()
		bounds.fill()
		("first-click check: clicks=\(clicks)" as NSString).draw(at: NSPoint(x: 24, y: 24), withAttributes: [.font: NSFont.systemFont(ofSize: 22), .foregroundColor: NSColor.black])
	}
	override func mouseDown(with event: NSEvent) {
		clicks += 1
		needsDisplay = true
		log("mouseDown")
	}
}

let window = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)

func save() {
	let state: [String: Any] = ["pid": Int(getpid()), "windowNumber": window.windowNumber, "ready": window.isVisible, "active": NSApp.isActive, "clicks": clicks, "events": events]
	try? JSONSerialization.data(withJSONObject: state).write(to: URL(fileURLWithPath: statePath), options: .atomic)
}

final class Delegate: NSObject, NSApplicationDelegate {
	var monitor: Any?
	func applicationDidFinishLaunching(_ notification: Notification) {
		monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown]) { event in log("seen"); return event }
		NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in log("appActive") }
		NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in log("appInactive") }
		let screenHeight = NSScreen.screens.first?.frame.height ?? frame.maxY
		window.title = "FirstClickFixture"
		window.contentView = Pad()
		window.setFrame(NSRect(x: frame.minX, y: screenHeight - frame.maxY, width: frame.width, height: frame.height), display: true)
		window.orderFrontRegardless()
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { save() }
	}
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
signal(SIGTERM) { _ in exit(0) }
app.run()
