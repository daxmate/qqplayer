#!/bin/bash
# 构建 QQPlayer 迷你窗 .app（Swift 原生壳）
# 用法: ./build.sh [--install]
#   --install: 构建后安装到 /Applications
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="QQPlayerMini"
BUNDLE_ID="com.daxmate.qqplayer-mini"
BUILD_DIR="build"

echo "📦 编译 Swift 壳..."
mkdir -p "$BUILD_DIR"
swiftc main.swift -o "$BUILD_DIR/$APP_NAME" -framework Cocoa -framework WebKit -O

echo "🏗️  组装 .app bundle..."
APP="$BUILD_DIR/$APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>QQPlayer 迷你窗</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>1.0.0</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key><string>com.daxmate.qqplayer-mini</string>
            <key>CFBundleURLSchemes</key>
            <array><string>qqplayermini</string></array>
        </dict>
    </array>
</dict>
</plist>
PLIST

cp "$BUILD_DIR/$APP_NAME" "$APP/Contents/MacOS/"
# 应用图标（assets/icon.icns，缺失时用 svg 现场生成）
if [ ! -f assets/icon.icns ]; then
    echo "🎨 生成图标 icns..."
    if [ -f assets/icon.svg ]; then
        rsvg-convert -w 1024 -h 1024 assets/icon.svg -o /tmp/qqplayer-mini-icon.png 2>/dev/null \
            || qlmanage -t -s 1024 -o /tmp assets/icon.svg >/dev/null 2>&1
        mkdir -p assets/icon.iconset
        for size in 16 32 128 256 512; do
            sips -z $size $size /tmp/qqplayer-mini-icon.png --out assets/icon.iconset/icon_${size}x${size}.png >/dev/null 2>&1
            sips -z $((size*2)) $((size*2)) /tmp/qqplayer-mini-icon.png --out assets/icon.iconset/icon_${size}x${size}@2x.png >/dev/null 2>&1
        done
        iconutil -c icns assets/icon.iconset -o assets/icon.icns
    fi
fi
if [ -f assets/icon.icns ]; then
    cp assets/icon.icns "$APP/Contents/Resources/icon.icns"
fi

codesign --force --sign - "$APP" 2>/dev/null || true

echo "✅ 构建完成: $APP"

if [[ "${1:-}" == "--install" ]]; then
    echo "📥 安装到 /Applications..."
    rm -rf "/Applications/$APP_NAME.app"
    cp -R "$APP" /Applications/
    echo "✅ 已安装: /Applications/$APP_NAME.app"
    echo "   （从播放器顶栏迷你窗按钮调起，或命令行 open qqplayermini://）"
fi
