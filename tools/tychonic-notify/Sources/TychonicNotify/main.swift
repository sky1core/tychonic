import Foundation
import UserNotifications

// tychonic.notification.v1 helper.
//
// Reads a single line of JSON from stdin describing one of:
//   {"action":"check"}
//   {"action":"request"}
//   {"action":"send","title":"...","message":"...","subtitle":"..."}
// Emits one JSON line on stdout describing the result, then exits.

func emit(_ obj: [String: Any]) {
    let data = try? JSONSerialization.data(withJSONObject: obj)
    if let data, let s = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    }
}

func authString(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "not_determined"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    @unknown default: return "unknown"
    }
}

func settingString(_ setting: UNNotificationSetting) -> String {
    switch setting {
    case .notSupported: return "not_supported"
    case .disabled: return "disabled"
    case .enabled: return "enabled"
    @unknown default: return "unknown"
    }
}

func alertStyleString(_ style: UNAlertStyle) -> String {
    switch style {
    case .none: return "none"
    case .banner: return "banner"
    case .alert: return "alert"
    @unknown default: return "unknown"
    }
}

guard let line = readLine() else {
    emit(["ok": false, "error": "no_stdin"])
    exit(2)
}

let bytes = line.data(using: .utf8) ?? Data()
let parsed = try? JSONSerialization.jsonObject(with: bytes)
guard let payload = parsed as? [String: Any] else {
    emit(["ok": false, "error": "invalid_json"])
    exit(2)
}

let action = (payload["action"] as? String) ?? "send"
let center = UNUserNotificationCenter.current()
let group = DispatchGroup()
group.enter()
var exitCode: Int32 = 0

switch action {
case "check":
    center.getNotificationSettings { settings in
        emit([
            "ok": true,
            "action": "check",
            "authorization": authString(settings.authorizationStatus),
            "alert": settingString(settings.alertSetting),
            "sound": settingString(settings.soundSetting),
            "notificationCenter": settingString(settings.notificationCenterSetting),
            "lockScreen": settingString(settings.lockScreenSetting),
            "alertStyle": alertStyleString(settings.alertStyle)
        ])
        group.leave()
    }

case "request":
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        if let error = error {
            emit([
                "ok": false,
                "action": "request",
                "error": error.localizedDescription
            ])
            exitCode = 1
        } else {
            emit([
                "ok": true,
                "action": "request",
                "granted": granted
            ])
        }
        group.leave()
    }

case "send":
    let title = (payload["title"] as? String) ?? "Tychonic"
    let body = (payload["message"] as? String) ?? ""
    let subtitle = payload["subtitle"] as? String

    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    if let s = subtitle { content.subtitle = s }

    let request = UNNotificationRequest(
        identifier: UUID().uuidString,
        content: content,
        trigger: nil
    )
    center.add(request) { error in
        if let error = error {
            emit([
                "ok": false,
                "action": "send",
                "error": error.localizedDescription
            ])
            exitCode = 1
        } else {
            emit(["ok": true, "action": "send"])
        }
        group.leave()
    }

default:
    emit(["ok": false, "error": "unknown_action: \(action)"])
    group.leave()
    exitCode = 2
}

if group.wait(timeout: .now() + 60) == .timedOut {
    emit(["ok": false, "error": "callback_timeout"])
    exit(3)
}

exit(exitCode)
