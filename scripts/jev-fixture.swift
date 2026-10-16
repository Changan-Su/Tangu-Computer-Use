import AppKit

let file = CommandLine.arguments[1]
final class App: NSObject, NSApplicationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 200, y: 180, width: 460, height: 200), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let field = NSTextField(frame: NSRect(x: 30, y: 100, width: 300, height: 28))
    var clicks = 0
    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Jev Native Fields"
        field.setAccessibilityLabel("Name")
        let button = NSButton(title: "Apply", target: self, action: #selector(apply))
        button.frame = NSRect(x: 30, y: 40, width: 100, height: 32)
        window.contentView?.addSubview(field)
        window.contentView?.addSubview(button)
        window.orderFrontRegardless()
        save()
    }
    @objc func apply() { clicks += 1; save() }
    func save() {
        let state: [String: Any] = ["pid": Int(getpid()), "clicks": clicks, "value": field.stringValue]
        try? JSONSerialization.data(withJSONObject: state).write(to: URL(fileURLWithPath: file), options: .atomic)
    }
}
let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
