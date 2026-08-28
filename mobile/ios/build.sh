#!/bin/bash
# QQPlayer iOS 壳一键构建：前端构建 → 复制 dist → xcodegen → xcodebuild
# 用法:
#   ./build.sh             模拟器构建（免签名）
#   ./build.sh --device    真机包构建（不签名，产物不可直接安装）
#   ./build.sh --install   真机签名构建 + devicectl 安装 + 启动（一条龙，需连接 iPhone）
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd ../.. && pwd)"
FRONTEND="$ROOT/frontend"
TARGET="${1:-}"
DEVICE=0
INSTALL=0
case "$TARGET" in
  --device) DEVICE=1 ;;
  --install) DEVICE=1; INSTALL=1 ;;
esac

echo "=== 1/4 构建前端（vite build → $ROOT/dist） ==="
(cd "$FRONTEND" && pnpm build)

echo "=== 2/4 链接前端产物 → Resources/www（符号链接，零拷贝） ==="
if ! "$ROOT/scripts/link-ios-www.sh"; then
  echo "❌ iOS 壳资源链接失败，中止构建"
  exit 1
fi
ls -l Resources/www

echo "=== 3/4 xcodegen generate ==="
xcodegen generate

DERIVED="build/DerivedData"

# --install：自动探测已连接的真机（设备名可含空格导致列错位，遍历找 UUID+connected 组合）
UDID=""
if [ "$INSTALL" -eq 1 ]; then
  UDID=$(xcrun devicectl list devices 2>/dev/null | awk '{
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/ && $(i+1) == "connected") { print $i; exit }
    }
  }')
  if [ -z "$UDID" ]; then
    echo "❌ 未找到已连接的 iPhone（xcrun devicectl list devices 检查）"
    exit 1
  fi
  echo "📱 目标设备: $UDID"
fi

echo "=== 4/4 xcodebuild ==="
if [ "$INSTALL" -eq 1 ]; then
  # 签名构建（DEVELOPMENT_TEAM 已写死 project.yml；正式开发者账号自动注册设备）
  # -allowProvisioningUpdates: 允许 xcodebuild 自动创建/更新 provisioning profile
  xcodebuild -project QQPlayer.xcodeproj -scheme QQPlayer -configuration Debug \
    -destination "platform=iOS,id=$UDID" -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
  APP_PATH="$DERIVED/Build/Products/Debug-iphoneos/QQPlayer.app"
  echo "✅ 构建完成，安装到 iPhone..."
  xcrun devicectl device install app --device "$UDID" "$APP_PATH"
  echo "✅ 已安装，启动 QQPlayer..."
  if xcrun devicectl device process launch --device "$UDID" com.daxmate.qqplayer.ios; then
    echo "✅ 完成: 已安装并启动（正式开发者签名，profile 一年有效期自动续）"
  else
    echo "⚠️ 已安装但启动失败：iPhone 可能锁屏——解锁后手动点开 QQPlayer 即可"
  fi
elif [ "$DEVICE" -eq 1 ]; then
  xcodebuild -project QQPlayer.xcodeproj -scheme QQPlayer -configuration Debug \
    -sdk iphoneos -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO build
  echo "✅ 真机产物: $DERIVED/Build/Products/Debug-iphoneos/QQPlayer.app"
else
  xcodebuild -project QQPlayer.xcodeproj -scheme QQPlayer -configuration Debug \
    -sdk iphonesimulator -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO build
  echo "✅ 模拟器产物: $DERIVED/Build/Products/Debug-iphonesimulator/QQPlayer.app"
fi
