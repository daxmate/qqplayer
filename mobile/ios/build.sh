#!/bin/bash
# QQPlayer iOS 壳一键构建：前端构建 → 复制 dist → xcodegen → xcodebuild（模拟器）
# 用法: ./build.sh [--device]   （--device: 构建真机包 iphoneos，需签名配置）
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd ../.. && pwd)"
FRONTEND="$ROOT/frontend"
TARGET="${1:-}"
DEVICE=0
if [ "$TARGET" = "--device" ]; then DEVICE=1; fi

echo "=== 1/4 构建前端（vite build → $ROOT/dist） ==="
(cd "$FRONTEND" && pnpm build)

echo "=== 2/4 复制前端产物 → Resources/www ==="
rm -rf Resources/www
mkdir -p Resources/www
cp -R "$ROOT/dist/." Resources/www/
echo "    www: $(du -sh Resources/www | cut -f1) ($(find Resources/www -type f | wc -l | tr -d ' ') files)"

echo "=== 3/4 xcodegen generate ==="
xcodegen generate

echo "=== 4/4 xcodebuild ==="
if [ "$DEVICE" -eq 1 ]; then
  xcodebuild -project QQPlayer.xcodeproj -scheme QQPlayer -configuration Debug \
    -sdk iphoneos -derivedDataPath build/DerivedData \
    CODE_SIGNING_ALLOWED=NO build
  echo "✅ 真机产物: build/DerivedData/Build/Products/Debug-iphoneos/QQPlayer.app"
else
  xcodebuild -project QQPlayer.xcodeproj -scheme QQPlayer -configuration Debug \
    -sdk iphonesimulator -derivedDataPath build/DerivedData \
    CODE_SIGNING_ALLOWED=NO build
  echo "✅ 模拟器产物: build/DerivedData/Build/Products/Debug-iphonesimulator/QQPlayer.app"
fi
