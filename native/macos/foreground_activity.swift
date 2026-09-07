import Foundation

/// A data-only signal beside the helper socket. Desktop can read it while a long input
/// command is running; no screenshots, focus changes or helper startup are involved.
final class ForegroundActivity {
    static let shared = ForegroundActivity()
    private let lock = NSLock()
    private var depth = 0
    private var active = false
    private var file: URL?
    private var timer: DispatchSourceTimer?
    private let now: () -> Double

    init(now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) { self.now = now }

    func configure(socketPath: String) {
        lock.lock(); defer { lock.unlock() }
        file = URL(fileURLWithPath: socketPath).deletingLastPathComponent().appendingPathComponent("foreground.json")
        publish(active: false, until: now())
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "forsion.foreground-signal"))
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.heartbeat() }
        timer.resume()
        self.timer = timer
    }

    // Called inside the recursive physical-input lock. A permitted foreground policy
    // alone does not activate the signal: successful AX/background paths stay silent.
    func enter() { lock.lock(); depth += 1; lock.unlock() }
    func physicalInput() {
        lock.lock(); defer { lock.unlock() }
        guard !active else { return } // HID movement can emit 120 events/s; the heartbeat renews the lease.
        active = true
        publish(active: true, until: now() + 2500)
    }
    func leave() {
        lock.lock(); defer { lock.unlock() }
        depth = max(0, depth - 1)
        if depth == 0 && active {
            active = false
            // Preserve a short click between desktop polls, then expire deterministically.
            publish(active: false, until: now() + 350)
        }
    }
    private func heartbeat() {
        lock.lock(); defer { lock.unlock() }
        if active { publish(active: true, until: now() + 2500) }
    }
    private func publish(active: Bool, until: Double) {
        guard let file else { return }
        let payload: [String: Any] = ["v": 1, "active": active, "expiresAt": until,
                                     "updatedAt": now(), "helperPid": ProcessInfo.processInfo.processIdentifier]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: file, options: .atomic)
    }
    deinit { timer?.cancel() }
}
