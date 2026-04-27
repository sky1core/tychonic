# Notifications Troubleshooting

When a Tychonic notification doesn't appear, follow this sequence. The
`TychonicNotify` Swift helper at `tools/tychonic-notify/` is the only
supported diagnostic surface — do **not** read TCC databases, parse
`com.apple.ncprefs.plist`, or run `tccutil` to investigate.

## Build the helper

```sh
./tools/tychonic-notify/build.sh
```

Produces `tools/tychonic-notify/dist/TychonicNotify.app`. The bundled
binary at `dist/TychonicNotify.app/Contents/MacOS/TychonicNotify` is
the only invocation entry point — running the SwiftPM executable
directly skips bundle identity and macOS rejects the notification.

## Run a state check

```sh
APP="tools/tychonic-notify/dist/TychonicNotify.app/Contents/MacOS/TychonicNotify"
echo '{"action":"check"}' | "$APP"
```

Sample response:

```json
{
  "ok": true,
  "action": "check",
  "authorization": "authorized",
  "alert": "enabled",
  "sound": "enabled",
  "notificationCenter": "enabled",
  "lockScreen": "enabled",
  "alertStyle": "alert"
}
```

Field domains:

- `authorization`: `not_determined` | `denied` | `authorized` | `provisional` | `ephemeral`
- `alert` / `sound` / `notificationCenter` / `lockScreen`: `not_supported` | `disabled` | `enabled`
- `alertStyle`: `none` | `banner` | `alert`

## Decision matrix

Go through these in order. Stop at the first row whose condition
matches the helper response or the user's environment.

| Condition | Cause | What to do |
|---|---|---|
| `authorization: not_determined` | Permission has never been requested | Run `echo '{"action":"request"}' \| "$APP"`. macOS shows a one-shot system dialog. The user clicks Allow; re-run `check`. |
| `authorization: denied` | User denied earlier (or a previous request timed out and macOS recorded a denial) | **Do not retry permission** — macOS suppresses the dialog. Open the system panel for the user: `open "x-apple.systempreferences:com.apple.preference.notifications"`. Once the user toggles "Allow Notifications" on, `check` returns `authorized`. |
| `authorization: authorized` and `alert: disabled` | User kept Notification Center delivery but turned off banners — the "must press to see it" state | Same panel; user turns "Allow Notifications" / banner display back on. |
| `alertStyle: none` | App is registered but display is fully suppressed | Same panel; user changes notification style to Banner or Alert. |
| `alertStyle: banner` and the user wants persistent display | Banners auto-dismiss after a few seconds. Notification still lands in Notification Center | Same panel; user changes style to "Alerts" (Korean: "지속적 표시"). The next `check` reports `alertStyle: alert`. |
| `send` returns `ok: true` but no banner appears, all settings look enabled | OS-level display gating — not a helper bug | Walk the user through the section below. |

## When everything looks enabled but the banner still doesn't appear

`UNUserNotificationCenter.add` returning success means macOS accepted
delivery, not that the banner was drawn. Macos suppresses the visible
banner (while still placing the notification in Notification Center) in
several cases the helper cannot read:

1. **Focus / Do Not Disturb is on** and Tychonic is not in the active
   Focus's allowed-app list. Ask the user to check the Control Center
   icon (top-right menu bar). Either turn Focus off, or add Tychonic
   to the Focus's allowed apps.
2. **Screen sharing or screen recording is active.** macOS deliberately
   hides banners during screen capture to keep them out of the recorded
   surface. The notification still reaches Notification Center. Ask
   the user to stop sharing/recording, then re-trigger.
3. **External display / display mirroring.** The banner may be drawn
   on a different display than the user is currently looking at.
4. **The notification was already delivered and dismissed.** Have the
   user open Notification Center (click the date/time in the menu bar)
   to confirm it landed there.

These are OS-side behaviors. The product does not work around them and
does not read OS state directly to diagnose them — the helper's `check`
output plus a question to the user is the supported diagnostic loop.

## What this skill refuses to do

Per AGENTS principle 17 (OS permission systems are not the product's
business), do **not**:

- read or parse `~/Library/Preferences/com.apple.ncprefs.plist`,
  `/Library/Application Support/com.apple.TCC/TCC.db`, or any other
  permission store
- run `tccutil reset` / `insert` / `delete`
- drive the permission dialog with AppleScript / `osascript`
- rotate `CFBundleIdentifier` to bypass a `denied` decision
- use `osascript`, `terminal-notifier`, `node-notifier`, or any other
  out-of-process bypass to reach `UNUserNotificationCenter`

The supported answer to every "the dialog won't come back" / "the user
already denied" problem is: open the system Notifications panel and let
the user decide.
