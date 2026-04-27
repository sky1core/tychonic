#!/usr/bin/env bash
# Build the TychonicNotify .app helper.
# Output: tools/tychonic-notify/dist/TychonicNotify.app

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

swift build -c release

EXEC=".build/release/TychonicNotify"
if [[ ! -x "$EXEC" ]]; then
    echo "Build failed: $EXEC not found" >&2
    exit 1
fi

APP="dist/TychonicNotify.app"
rm -rf dist
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"
cp "$EXEC" "$APP/Contents/MacOS/TychonicNotify"
cp Info.plist "$APP/Contents/Info.plist"

codesign --force --deep --sign - "$APP"

echo "Built: $DIR/$APP"
