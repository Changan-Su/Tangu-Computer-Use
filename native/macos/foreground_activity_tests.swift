import Foundation

@main struct ForegroundActivityTests {
    static func main() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let signal = dir.appendingPathComponent("foreground.json")
        var now = 1000.0
        let activity = ForegroundActivity(now: { now })
        activity.configure(socketPath: dir.appendingPathComponent("bridge.sock").path)
        func snapshot() throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: Data(contentsOf: signal)) as! [String: Any]
        }
        func check(_ yes: Bool, _ name: String) { precondition(yes, name); print("PASS \(name)") }
        activity.enter(); activity.leave()
        check(try snapshot()["active"] as? Bool == false, "AX/background scope does not activate")
        check(try snapshot()["expiresAt"] as? Double == 1000, "background scope does not extend lease")
        activity.enter(); activity.enter(); activity.physicalInput()
        check(try snapshot()["active"] as? Bool == true, "physical input activates before posting")
        activity.leave()
        check(try snapshot()["active"] as? Bool == true, "nested input keeps outer action active")
        now = 1200
        activity.leave()
        check(try snapshot()["active"] as? Bool == false, "completion clears active state")
        check(try snapshot()["expiresAt"] as? Double == 1550, "short click has bounded 350ms grace")
        activity.enter(); activity.leave()
        check(try snapshot()["expiresAt"] as? Double == 1550, "later background action never renews it")
        check(try snapshot()["helperPid"] as? Int == Int(ProcessInfo.processInfo.processIdentifier), "reader can detect dead helper")
    }
}
