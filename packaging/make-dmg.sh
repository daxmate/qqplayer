#!/usr/bin/env bash
# QQPlayer DMG 打包（arm64，自包含）：构建 app（含内置后端）→ 组装 staging → hdiutil 压 dmg
#
# 前置：packaging/dist/qqplayer-backend 存在（PyInstaller 产物，见 build-backend.sh）
# 用法：./packaging/make-dmg.sh [版本号，默认 1.0.0-rc.1]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="${1:-1.0.0-rc.1}"
# 目标架构：arm64（默认）/ x86_64，环境变量 ARCH 覆盖（DMG 命名带架构后缀）
ARCH="${ARCH:-arm64}"
case "$ARCH" in
  arm64|x86_64) : ;;
  *) echo "⚠️ 不支持的 ARCH: $ARCH（仅支持 arm64 / x86_64）" >&2; exit 1 ;;
esac
# 内置后端目录（仓库根相对路径），x86_64 打包时指向 packaging/dist-x64/qqplayer-backend
BACKEND_DIR="${BACKEND_DIR:-packaging/dist/qqplayer-backend}"
APP_SRC="desktop/macOS/build/QQPlayer.app"
STAGE="packaging/dmg-staging"
DMG="packaging/QQPlayer-${VERSION}-${ARCH}.dmg"

if [ ! -x "$BACKEND_DIR/qqplayer-backend" ]; then
    echo "✗ 未找到内置后端 $BACKEND_DIR，先跑 ./packaging/build-backend.sh" >&2
    exit 1
fi

echo "📦 1/3 构建 QQPlayer.app（含内置后端，ARCH=$ARCH）..."
(cd desktop/macOS && ARCH="$ARCH" BACKEND_SRC="$BACKEND_DIR" ./build.sh)

echo "🏗️  2/3 组装 dmg staging..."
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP_SRC" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cp packaging/安装.command "$STAGE/安装.command"
cp packaging/README.txt "$STAGE/README.txt"

echo "💿 3/3 压缩 dmg（UDZO）..."
rm -f "$DMG"
hdiutil create -volname "QQPlayer ${VERSION}" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo "✅ 完成: $DMG  （$(du -sh "$DMG" | cut -f1)）"
