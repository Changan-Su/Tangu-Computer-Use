// 无障碍树是空的自绘 App —— 微信那一类(只能看截图、按坐标操作)的替身,给 vision-only.check.mjs 用。
// 左边一列 4 个色块(点了切页),右边一列 60 行靠滚轮滚动;全是自己画的,没有控件,所以无障碍树里只有窗口和标题栏按钮。
// 每次状态变化写到 argv[1](JSON)。SIGUSR1 = 把窗口收起来,模拟「窗口不在当前桌面」:列不出、点不到。
// 只有 App 被激活时窗口才回来 —— 窗口在别的桌面的 App 就是这样:后台打开没用,激活了系统才切过去。
import AppKit

let statePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/dev/null"
let railWidth: CGFloat = 64, rowHeight: CGFloat = 44, rowCount = 60

final class Canvas: NSView {
	var page = 0, offset: CGFloat = 0, clicks = 0, scrolls = 0, drags = 0
	override var isFlipped: Bool { true }
	override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
	var maxOffset: CGFloat { max(0, CGFloat(rowCount) * rowHeight - bounds.height) }

	override func draw(_ dirtyRect: NSRect) {
		NSColor(white: 0.96, alpha: 1).setFill()
		bounds.fill()
		let colors: [NSColor] = [.systemGreen, .systemBlue, .systemOrange, .systemPurple]
		for (index, color) in colors.enumerated() {
			(index == page ? color : color.withAlphaComponent(0.35)).setFill()
			NSBezierPath(roundedRect: NSRect(x: 12, y: 12 + CGFloat(index) * railWidth, width: 40, height: 40), xRadius: 8, yRadius: 8).fill()
		}
		let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15), .foregroundColor: NSColor.black]
		for row in 0..<rowCount {
			let y = CGFloat(row) * rowHeight - offset
			guard y > -rowHeight, y < bounds.height else { continue }
			NSColor(white: row % 2 == 0 ? 1 : 0.93, alpha: 1).setFill()
			NSRect(x: railWidth, y: y, width: bounds.width - railWidth, height: rowHeight).fill()
			("Page \(page + 1) · row \(row + 1)" as NSString).draw(at: NSPoint(x: railWidth + 16, y: y + 12), withAttributes: attrs)
		}
	}

	override func mouseDown(with event: NSEvent) {
		let point = convert(event.locationInWindow, from: nil)
		if point.x < railWidth, point.y < 4 * railWidth { page = Int(point.y / railWidth); offset = 0 }
		clicks += 1
		changed()
	}
	override func mouseDragged(with event: NSEvent) { drags += 1; changed() }
	override func scrollWheel(with event: NSEvent) {
		offset = min(maxOffset, max(0, offset - event.scrollingDeltaY))
		scrolls += 1
		changed()
	}

	func changed() { needsDisplay = true; save() }
	func save() {
		let state: [String: Any] = [
			"pid": Int(getpid()), "page": page, "offset": Double(offset), "clicks": clicks, "scrolls": scrolls, "drags": drags,
			"visible": window?.isVisible ?? false,
			"window": ["w": Double(window?.frame.width ?? 0), "h": Double(window?.frame.height ?? 0)],
			"content": ["w": Double(bounds.width), "h": Double(bounds.height)],
			"railWidth": Double(railWidth),
		]
		try? JSONSerialization.data(withJSONObject: state).write(to: URL(fileURLWithPath: statePath), options: .atomic)
	}
}

final class Delegate: NSObject, NSApplicationDelegate {
	let window = NSWindow(contentRect: NSRect(x: 140, y: 160, width: 760, height: 540), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
	let canvas = Canvas()
	var hide: DispatchSourceSignal?

	func applicationDidFinishLaunching(_ notification: Notification) {
		window.title = "CU Fixture"
		// 和微信一样不显示标题文字:否则无障碍树里多一个带字的 AXStaticText,6 个节点里 2 个有标签,
		// 刚好够不上 vendor「大多数节点没标签 → 自动附截图」那条线(有标签的 ×3 < 节点数),结果里就不带截图了。
		window.titleVisibility = .hidden
		window.contentView = canvas
		window.isReleasedWhenClosed = false
		window.orderFrontRegardless()
		canvas.save()
		signal(SIGUSR1, SIG_IGN)
		hide = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
		hide?.setEventHandler { [self] in window.orderOut(nil); canvas.save() }
		hide?.resume()
	}
	func applicationDidBecomeActive(_ notification: Notification) {
		if !window.isVisible { window.makeKeyAndOrderFront(nil); canvas.save() }
	}
	func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { false }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
