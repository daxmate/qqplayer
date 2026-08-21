#!/usr/bin/env bash
# QQPlayer DMG 打包（arm64，自包含）：构建 app（含内置后端）→ 组装 staging → hdiutil 压 dmg
#
# 前置：packaging/dist/qqplayer-backend 存在（PyInstaller 产物，见 build-backend.sh）
# 用法：./packaging/make-dmg.sh [版本号，默认 1.0.0-rc.1]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="${1:-1.0.0-rc.1}"
APP_SRC="desktop/macOS/build/QQPlayer.app"
STAGE="packaging/dmg-staging"
DMG="packaging/QQPlayer-${VERSION}.dmg"

if [ ! -x packaging/dist/qqplayer-backend/qqplayer-backend ]; then
    echo "✗ 未找到内置后端 packaging/dist/qqplayer-backend，先跑 ./packaging/build-backend.sh" >&2
    exit 1
fi

echo "📦 1/3 构建 QQPlayer.app（含内置后端）..."
(cd desktop/macOS && ./build.sh)

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
