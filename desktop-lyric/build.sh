#!/bin/bash
# 构建 QQPlayer 桌面歌词悬浮窗 .app（Swift 原生壳）
# 用法: ./build.sh [--install]
#   --install: 构建后安装到 /Applications
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="QQPlayerLyric"
BUNDLE_ID="com.daxmate.qqplayer-lyric"
BUILD_DIR="build"

echo "📦 编译 Swift 壳..."
mkdir -p "$BUILD_DIR"
swiftc main.swift -o "$BUILD_DIR/$APP_NAME" -framework Cocoa -framework WebKit -O

echo "🏗️  组装 .app bundle..."
APP="$BUILD_DIR/$APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>QQPlayer 桌面歌词</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>1.0.0</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key><string>com.daxmate.qqplayer-lyric</string>
            <key>CFBundleURLSchemes</key>
            <array><string>qqplayerlyric</string></array>
        </dict>
    </array>
</dict>
</plist>
PLIST

cp "$BUILD_DIR/$APP_NAME" "$APP/Contents/MacOS/"
codesign --force --sign - "$APP" 2>/dev/null || true

echo "✅ 构建完成: $APP"

if [[ "${1:-}" == "--install" ]]; then
    echo "📥 安装到 /Applications..."
    rm -rf "/Applications/$APP_NAME.app"
    cp -R "$APP" /Applications/
    echo "✅ 已安装: /Applications/$APP_NAME.app"
    echo "   （从播放器顶栏悬浮窗按钮调起，或命令行 open qqplayerlyric://）"
fi
