#!/bin/bash
# Build MapDrive.app from MapDrive.swift (no Xcode project needed; just the Command Line Tools).
set -euo pipefail
cd "$(dirname "$0")"
APP="MapDrive.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc MapDrive.swift -O -o "$APP/Contents/MacOS/MapDrive" -framework Cocoa

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MapDrive</string>
  <key>CFBundleDisplayName</key><string>SISP MapDrive</string>
  <key>CFBundleIdentifier</key><string>com.sisp.mapdrive</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>MapDrive</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

if [ -d assets ]; then
  find assets -maxdepth 1 -type f -name '*.png' -exec cp {} "$APP/Contents/Resources/" \;
fi

echo "Built $APP"
echo "Run it:  open $APP    (a drive icon appears in the menu bar)"
