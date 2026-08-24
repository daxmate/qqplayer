#!/bin/bash
# 构建 QQPlayer 桌面版 .app（Swift 原生壳三合一：主窗口 + 迷你窗 + 桌面歌词）
# 用法: ./build.sh [--install]  （兼容 install / --install 两种写法）
#   --install: 构建后安装到 /Applications（自动清理旧的独立迷你窗/歌词壳，避免 scheme 冲突）
set -euo pipefail
# 脚本目录绝对路径（cd 前解析，防止 cd 后 dirname $0 相对路径失效）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

INSTALL=0
case "${1:-}" in
  --install|install) INSTALL=1 ;;
  "") : ;;
  *) echo "⚠️ 未知参数: $1（仅支持 install / --install）" >&2 ;;
esac

# 目标架构：arm64（默认）/ x86_64（Intel），环境变量 ARCH 覆盖
ARCH="${ARCH:-arm64}"
case "$ARCH" in
  arm64|x86_64) : ;;
  *) echo "⚠️ 不支持的 ARCH: ${ARCH}（仅支持 arm64 / x86_64）" >&2; exit 1 ;;
esac

APP_NAME="QQPlayer"
BUNDLE_ID="com.daxmate.qqplayer"
BUILD_DIR="build"
# 版本号唯一真源：仓库根 VERSION 文件（desktop/macOS/../../VERSION）
VERSION="$(cat "$SCRIPT_DIR/../../VERSION")"

echo "📦 编译 Swift 壳..."
mkdir -p "$BUILD_DIR"
swiftc main.swift dict_events.swift -o "$BUILD_DIR/$APP_NAME" \
    -target ${ARCH}-apple-macos13.0 \
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
    <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
    <key>CFBundleLocalizations</key>
    <array>
        <string>zh_CN</string>
        <string>en</string>
    </array>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
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
# 应用图标：使用本目录 assets/icon.icns（双 Q 泡泡主 logo，已入库）
ICON_SRC=""
for cand in assets/icon.icns; do
    if [ -f "$cand" ]; then ICON_SRC="$cand"; break; fi
done
if [ -n "$ICON_SRC" ]; then
    cp "$ICON_SRC" "$APP/Contents/Resources/icon.icns"
    echo "🎨 使用图标: $ICON_SRC"
else
    echo "⚠️ 未找到图标，跳过"
fi

# 内置后端子进程（DMG 打包版自包含）：packaging/dist/qqplayer-backend 存在（PyInstaller onedir）
# → 整体拷入 Resources/backend/（含 _internal/）；不存在 → 跳过（开发模式直连 launchd 服务）
# 注意：本脚本在 desktop/macOS/ 下，packaging/ 在仓库根（../../packaging）
# BACKEND_SRC 环境变量可覆盖（x86_64 打包时指向 dist-x64/qqplayer-backend）
BACKEND_SRC="${BACKEND_SRC:-packaging/dist/qqplayer-backend}"
case "$BACKEND_SRC" in
  /*) : ;;                                # 绝对路径直接用
  *)  BACKEND_SRC="../../$BACKEND_SRC" ;; # 相对仓库根路径 → 转成相对本目录（desktop/macOS/）
esac
if [ -d "$BACKEND_SRC" ]; then
    echo "📦 拷贝内置后端子进程..."
    cp -R "$BACKEND_SRC" "$APP/Contents/Resources/backend"
    echo "✅ 内置后端已就位: $APP/Contents/Resources/backend"
else
    echo "ℹ️  未找到内置后端（${BACKEND_SRC}），跳过（开发模式直连 launchd 服务）"
fi

codesign --force --sign - "$APP" 2>/dev/null || true

echo "✅ 构建完成: $APP"

if [ "$INSTALL" -eq 1 ]; then
    echo "📥 安装到 /Applications..."
    # 清理旧的独立壳（迷你窗/歌词），避免 scheme 注册冲突（qqplayermini/qqplayerlyric 已由本 app 接管）
    rm -rf "/Applications/QQPlayerMini.app" "/Applications/QQPlayerLyric.app"
    rm -rf "/Applications/$APP_NAME.app"
    cp -R "$APP" /Applications/
    echo "✅ 已安装: /Applications/$APP_NAME.app"
    echo "   （双击打开，或命令行 open qqplayer://）"
fi
