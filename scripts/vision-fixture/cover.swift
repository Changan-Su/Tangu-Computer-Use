// pid-window 探针的「盖窗」:一个普通窗口,起来就把自己激活、盖在 --frame 指定的位置上(就是被测窗口的位置)。
// 它收到的鼠标 / 滚轮事件、自己被激活 / 失活、真鼠标挪没挪都记进状态文件:投给别的进程的事件如果误落到最前面的窗口上,这里会看到。
// 命令行:<exe> <statePath> --frame x,y,w,h(整个窗口,全局屏幕点、左上角原点,与 CGWindowList bounds 同一约定)
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
func log(_ kind: String, _ detail: String = "") {
	events.append(["t": Int(Date().timeIntervalSince1970 * 1000), "kind": kind, "detail": detail])
	save()
}

final class Pad: NSView {
	override var isFlipped: Bool { true }
	override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
	override func draw(_ dirtyRect: NSRect) {
		NSColor(calibratedRed: 0.93, green: 0.90, blue: 0.84, alpha: 1).setFill()
		bounds.fill()
		("pid-window probe cover" as NSString).draw(at: NSPoint(x: 24, y: 24), withAttributes: [.font: NSFont.systemFont(ofSize: 18), .foregroundColor: NSColor.darkGray])
	}
	func at(_ event: NSEvent) -> String {
		let p = convert(event.locationInWindow, from: nil)
		return "\(Int(p.x)),\(Int(p.y))"
	}
	override func mouseDown(with event: NSEvent) { log("mouseDown", at(event)) }
	override func rightMouseDown(with event: NSEvent) { log("rightMouseDown", at(event)) }
	override func scrollWheel(with event: NSEvent) { log("scroll", at(event)) }
}

let window = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)

func save() {
	let state: [String: Any] = [
		"pid": Int(getpid()), "windowNumber": window.windowNumber, "ready": window.isVisible,
		"active": NSApp.isActive, "events": events,
	]
	try? JSONSerialization.data(withJSONObject: state).write(to: URL(fileURLWithPath: statePath), options: .atomic)
}

final class Delegate: NSObject, NSApplicationDelegate {
	var monitor: Any?
	func applicationDidFinishLaunching(_ notification: Notification) {
		// --trace:App 事件队列里取出来的每个鼠标 / 滚轮 / 按键事件都记下来(在派发给窗口之前),带上它认的窗口号。
		// 用来分清「事件根本没进这个进程」和「进来了但没找到窗口 / 被丢了」。
		if argv.contains("--trace") {
			let mask: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .mouseMoved, .scrollWheel, .keyDown, .keyUp]
			monitor = NSEvent.addLocalMonitorForEvents(matching: mask) { event in
				log("seen:\(event.type.rawValue)", "win=\(event.windowNumber) window=\(event.window != nil) loc=\(Int(event.locationInWindow.x)),\(Int(event.locationInWindow.y))")
				return event
			}
		}
		let screenHeight = NSScreen.screens.first?.frame.height ?? frame.maxY
		// 真鼠标动没动:每 250ms 看一眼光标(不要授权),变了就记一条 cursorMoved(全局点、左上角原点)。
		// 后台投递不该动它;升到前台的物理点击会把它挪到目标上。
		var cursor = NSEvent.mouseLocation
		Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
			let now = NSEvent.mouseLocation
			guard now != cursor else { return }
			cursor = now
			log("cursorMoved", "\(Int(now.x)),\(Int(screenHeight - now.y))")
		}
		window.setFrame(NSRect(x: frame.minX, y: screenHeight - frame.maxY, width: frame.width, height: frame.height), display: false)
		window.title = "Probe cover"
		window.contentView = Pad()
		window.isReleasedWhenClosed = false
		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
		save()
	}
	func applicationDidBecomeActive(_ notification: Notification) { log("becomeActive") }
	func applicationDidResignActive(_ notification: Notification) { log("resignActive") }
	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

// 被 SIGKILL 过的 App 下次启动可能弹「要重新打开窗口吗」:不存也不读窗口状态
UserDefaults.standard.register(defaults: ["ApplePersistenceIgnoreState": true])
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
