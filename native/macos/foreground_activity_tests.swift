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
        now = 3000
        activity.tookForeground()
        check(try snapshot()["active"] as? Bool == true && snapshot()["expiresAt"] as? Double == 4000 && snapshot()["updatedAt"] as? Double == 3000, "raising an app without input leaves a one-second lease")
        activity.enter(); activity.leave()
        check(try snapshot()["expiresAt"] as? Double == 4000, "a later background action neither renews nor cuts it")
        now = 3500
        activity.enter(); activity.physicalInput()
        now = 3600
        activity.tookForeground()
        check(try snapshot()["active"] as? Bool == true && snapshot()["expiresAt"] as? Double == 6000, "a raise during input does not shorten the input lease")
        activity.leave()
        check(try snapshot()["active"] as? Bool == false && snapshot()["expiresAt"] as? Double == 3950, "input after a raise ends the usual way")
    }
}
