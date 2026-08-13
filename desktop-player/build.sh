#!/bin/bash
# 构建 QQPlayer 桌面版 .app（Swift 原生壳三合一：主窗口 + 迷你窗 + 桌面歌词）
# 用法: ./build.sh [--install]
#   --install: 构建后安装到 /Applications（自动清理旧的独立迷你窗/歌词壳，避免 scheme 冲突）
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="QQPlayer"
BUNDLE_ID="com.daxmate.qqplayer"
BUILD_DIR="build"

echo "📦 编译 Swift 壳..."
mkdir -p "$BUILD_DIR"
swiftc main.swift -o "$BUILD_DIR/$APP_NAME" \
    -framework Cocoa -framework WebKit -framework MediaPlayer -O

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
    <key>CFBundleDisplayName</key><string>QQPlayer</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>1.0.0</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key><string>com.daxmate.qqplayer</string>
            <key>CFBundleURLSchemes</key>
            <array><string>qqplayer</string></array>
        </dict>
        <dict>
            <key>CFBundleURLName</key><string>com.daxmate.qqplayer-mini</string>
            <key>CFBundleURLSchemes</key>
            <array><string>qqplayermini</string></array>
        </dict>
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
# 应用图标：优先复用桌面歌词/迷你窗同款 icns（双 Q 泡泡主 logo）
ICON_SRC=""
for cand in assets/icon.icns ../desktop-mini/assets/icon.icns ../desktop-lyric/assets/icon.icns; do
    if [ -f "$cand" ]; then ICON_SRC="$cand"; break; fi
done
if [ -n "$ICON_SRC" ]; then
    cp "$ICON_SRC" "$APP/Contents/Resources/icon.icns"
    echo "🎨 使用图标: $ICON_SRC"
else
    echo "⚠️ 未找到图标，跳过"
fi

codesign --force --sign - "$APP" 2>/dev/null || true

echo "✅ 构建完成: $APP"

if [[ "${1:-}" == "--install" ]]; then
    echo "📥 安装到 /Applications..."
    # 清理旧的独立壳（迷你窗/歌词），避免 scheme 注册冲突（qqplayermini/qqplayerlyric 已由本 app 接管）
    rm -rf "/Applications/QQPlayerMini.app" "/Applications/QQPlayerLyric.app"
    rm -rf "/Applications/$APP_NAME.app"
    cp -R "$APP" /Applications/
    echo "✅ 已安装: /Applications/$APP_NAME.app"
    echo "   （双击打开，或命令行 open qqplayer://）"
fi
