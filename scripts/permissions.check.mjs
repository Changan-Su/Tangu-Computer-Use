#!/usr/bin/env node
// Compile the actual permission methods against fake OS APIs. Never launch the
// installed helper, query TCC, request capture, or open System Settings in tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'native/macos/bridge.swift'), 'utf8');
function method(name) {
  const start = source.indexOf(`\tprivate func ${name}(`);
  assert.ok(start >= 0, `missing native method: ${name}`);
  const end = source.indexOf('\n\t}', start);
  assert.ok(end > start, `missing method end: ${name}`);
  return source.slice(start, end + 4).replace('private func', 'func');
}
const dispatchStart = source.indexOf('\t\tcase "permissionStatus":');
const dispatchEnd = source.indexOf('\t\tcase "openPermissionPane":', dispatchStart);
assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart, 'permission command dispatch must exist');
const dispatch = source.slice(dispatchStart, dispatchEnd);
const methods = ['permissionStatus', 'systemSettingsWindowBounds', 'checkPermissions', 'registerPermissions', 'boolArg', 'stringArg'].map(method).join('\n');

if (process.platform !== 'darwin') {
  console.log('native permission checks skipped (not macOS)');
  process.exit(0);
}

const harness = String.raw`
import Foundation
import CoreGraphics

struct BridgeFailure: Error { let message: String; let code: String }
struct App { let bundleIdentifier: String; let processIdentifier: Int32 }
final class NSWorkspace {
  static let shared = NSWorkspace()
  var frontmostApplication: App?
  var runningApplications: [App] = []
}
enum Fake {
  static var ax = false
  static var preflight = false
  static var capturable = false
  static var axReads = 0
  static var preflightReads = 0
  static var axRequests = 0
  static var screenRequests = 0
  static var probes = 0
  static var windowReads = 0
  static var windows: [[String: Any]] = []
  static func reset() {
    ax = false; preflight = false; capturable = false
    axReads = 0; preflightReads = 0; axRequests = 0; screenRequests = 0; probes = 0; windowReads = 0
    windows = []
    NSWorkspace.shared.frontmostApplication = nil
    NSWorkspace.shared.runningApplications = []
  }
}
let kAXTrustedCheckOptionPrompt = Unmanaged.passRetained("prompt" as CFString)
func AXIsProcessTrusted() -> Bool { Fake.axReads += 1; return Fake.ax }
func CGPreflightScreenCaptureAccess() -> Bool { Fake.preflightReads += 1; return Fake.preflight }
func AXIsProcessTrustedWithOptions(_ options: CFDictionary) -> Bool {
  precondition((options as NSDictionary)["prompt"] as? Bool == true)
  Fake.axRequests += 1; return Fake.ax
}
func CGRequestScreenCaptureAccess() -> Bool { Fake.screenRequests += 1; return Fake.preflight }
func CGWindowListCopyWindowInfo(_ options: CGWindowListOption, _ window: CGWindowID) -> CFArray? {
  precondition(options.contains(.optionOnScreenOnly) && window == kCGNullWindowID)
  Fake.windowReads += 1; return Fake.windows as CFArray
}
final class Bridge {
  let permissionCacheLock = NSLock()
  var grantedPermissionStatus: [String: Any]?
  func permissionSource() -> [String: Any] { ["attribution": "helper-app", "pid": 123] }
  func screenRecordingCapturable() -> Bool { Fake.probes += 1; return Fake.capturable }
  func command(_ request: [String: Any]) throws -> [String: Any] {
    let cmd = try stringArg(request, "cmd")
    switch cmd {
${dispatch}
    default: throw BridgeFailure(message: "Unexpected command", code: "unknown_command")
    }
  }
${methods}
}
func window(_ pid: Int32, _ rect: CGRect, layer: Int = 0, visible: Bool = true) -> [String: Any] {
  // No title: this is also the metadata shape before Screen Recording is granted.
  [kCGWindowOwnerPID as String: pid, kCGWindowLayer as String: layer,
   kCGWindowIsOnscreen as String: visible, kCGWindowBounds as String: rect.dictionaryRepresentation]
}
var passed = 0
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
  guard condition() else { fatalError(label) }
  passed += 1
}

// Passive status ignores a previous positive capture cache and never prompts.
Fake.reset()
let passive = Bridge()
passive.grantedPermissionStatus = ["accessibility": true, "screenRecording": true]
Fake.preflight = true
let status1 = try passive.command(["cmd": "permissionStatus"])
Fake.preflight = false
let status2 = try passive.command(["cmd": "permissionStatus"])
check(status1["accessibility"] as? Bool == false, "status must not use capture cache")
check(status1["screenRecordingPreflight"] as? Bool == true && status2["screenRecordingPreflight"] as? Bool == false, "status must reread preflight")
check(Fake.axReads == 2 && Fake.preflightReads == 2, "both preflights run on every status")
check(Fake.probes == 0 && Fake.axRequests == 0 && Fake.screenRequests == 0, "passive status has no capture or request side effects")
check(status1["screenRecording"] == nil && status1["screenRecordingCapturable"] == nil, "preflight must not be presented as verified capture")
check((status1["source"] as? [String: Any])?["attribution"] as? String == "helper-app", "status preserves permission identity")
check(status1["settingsWindow"] == nil && status1["settingsFrontmost"] as? Bool == false, "absent Settings has no invented bounds")

// Only the largest visible layer-zero window of System Settings is selected.
let settings = App(bundleIdentifier: "com.apple.systempreferences", processIdentifier: 42)
NSWorkspace.shared.runningApplications = [App(bundleIdentifier: "other.app", processIdentifier: 8), settings]
NSWorkspace.shared.frontmostApplication = settings
let wanted = CGRect(x: -1000, y: -200, width: 850, height: 700)
Fake.windows = [
  window(8, CGRect(x: 0, y: 0, width: 5000, height: 5000)),
  window(42, CGRect(x: 0, y: 0, width: 5000, height: 5000), layer: 1),
  window(42, CGRect(x: 0, y: 0, width: 5000, height: 5000), visible: false),
  window(42, CGRect(x: 0, y: 0, width: 0, height: 5000)),
  window(42, CGRect(x: CGFloat.infinity, y: 0, width: 5000, height: 5000)),
  window(42, CGRect(x: 10, y: 20, width: 300, height: 200)),
  window(42, wanted),
]
let windowStatus = try passive.command(["cmd": "permissionStatus"])
let bounds = windowStatus["settingsWindow"] as? [String: CGFloat]
check(bounds == ["x": -1000, "y": -200, "width": 850, "height": 700], "Settings bounds must use PID/layer/visibility and preserve CG coordinates")
check(windowStatus["settingsFrontmost"] as? Bool == true, "frontmost uses bundle identity")
check(Fake.probes == 0 && Fake.axRequests == 0 && Fake.screenRequests == 0, "window metadata requires no grants")
NSWorkspace.shared.frontmostApplication = App(bundleIdentifier: "other.app", processIdentifier: 8)
let behind = try passive.command(["cmd": "permissionStatus"])
check(behind["settingsWindow"] != nil && behind["settingsFrontmost"] as? Bool == false, "visibility and frontmost are separate")
Fake.windows = []
let closed = try passive.command(["cmd": "permissionStatus"])
check(closed["settingsWindow"] == nil, "closed Settings window is omitted")

// Single-kind request isolation; malformed kinds fail before any OS operation.
Fake.reset()
let requests = Bridge()
let axRequest = try requests.command(["cmd": "registerPermissions", "kind": "accessibility"])
check(Fake.axRequests == 1 && Fake.screenRequests == 0 && Fake.probes == 0, "AX-only request must not request/probe screen capture")
check(Set(axRequest.keys) == ["accessibility"], "AX-only response cannot claim screen permission")
Fake.reset()
let screenRequest = try requests.command(["cmd": "registerPermissions", "kind": "screenRecording"])
check(Fake.screenRequests == 1 && Fake.axRequests == 0 && Fake.axReads == 0 && Fake.probes == 0, "screen-only request must not touch AX or capture probe")
check(Set(screenRequest.keys) == ["screenRecording"], "screen request returns request result only")
for kind: Any in ["invalid", "", 42, NSNull()] {
  Fake.reset()
  do {
    _ = try requests.command(["cmd": "registerPermissions", "kind": kind])
    fatalError("invalid permission kind was accepted")
  } catch let error as BridgeFailure {
    check(error.code == "invalid_args", "invalid kind error code")
  }
  check(Fake.axRequests == 0 && Fake.screenRequests == 0 && Fake.probes == 0, "invalid kind must have no side effects")
}
Fake.reset()
Fake.ax = true; Fake.preflight = true; Fake.capturable = true
let legacy = try requests.command(["cmd": "registerPermissions"])
check(Fake.axRequests == 1 && Fake.screenRequests == 1 && Fake.probes == 1, "omitted kind retains both legacy requests and probe")
check(legacy["accessibility"] as? Bool == true && legacy["screenRecordingCapturable"] as? Bool == true, "legacy response preserved")

// Fresh validation must invalidate an old success even when the new check fails.
Fake.reset()
Fake.ax = true; Fake.preflight = true; Fake.capturable = true
let validator = Bridge()
_ = try validator.command(["cmd": "checkPermissions"])
Fake.capturable = false
let cached = try validator.command(["cmd": "checkPermissions", "fresh": false])
check(cached["screenRecording"] as? Bool == true && Fake.probes == 1, "legacy successful checks remain cached")
let revoked = try validator.command(["cmd": "checkPermissions", "fresh": true])
check(revoked["screenRecordingPreflight"] as? Bool == true && revoked["screenRecordingCapturable"] as? Bool == false, "fresh bypasses success despite stale preflight")
check(validator.grantedPermissionStatus == nil && Fake.probes == 2, "failed fresh check removes stale success")
_ = try validator.command(["cmd": "checkPermissions"])
check(Fake.probes == 3, "failure is not cached")
Fake.capturable = true
_ = try validator.command(["cmd": "checkPermissions", "fresh": true])
_ = try validator.command(["cmd": "checkPermissions"])
check(Fake.probes == 4 && validator.grantedPermissionStatus != nil, "successful fresh check refreshes cache")
Fake.ax = false
_ = try validator.command(["cmd": "checkPermissions", "fresh": true])
check(validator.grantedPermissionStatus == nil, "AX revocation also invalidates success")
print("permission checks passed: \(passed) assertions (fake OS APIs; no installed helper launched)")
`;

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-cu-permission-tests-'));
try {
  const swift = path.join(temporary, 'main.swift');
  const binary = path.join(temporary, 'permissions-tests');
  fs.writeFileSync(swift, harness);
  const triple = process.arch === 'x64' ? 'x86_64-apple-macosx14.0' : 'arm64-apple-macosx14.0';
  execFileSync('xcrun', ['swiftc', '-target', triple, '-module-cache-path', path.join(os.tmpdir(), `tangu-cu-permission-test-cache-${process.arch}`), swift, '-o', binary], { cwd: root, stdio: 'inherit' });
  execFileSync(binary, [], { cwd: root, stdio: 'inherit' });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
