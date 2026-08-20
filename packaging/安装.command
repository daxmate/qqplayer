#!/bin/bash
# QQPlayer 安装脚本（DMG 分发版）
# 功能：安装到 /Applications + 移除 Gatekeeper 隔离标记（ad-hoc 签名未公证，macOS 会拦截）
set -e

APP_NAME="QQPlayer"
SRC="$(cd "$(dirname "$0")" && pwd)/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"

if [ ! -d "$SRC" ]; then
    echo "❌ 未找到 $SRC（请确认从 QQPlayer.dmg 内双击本脚本）"
    read -r -p "按回车退出..."
    exit 1
fi

echo "📦 QQPlayer 安装中..."

# 已安装则先移除旧版
if [ -d "$DEST" ]; then
    echo "   移除旧版: $DEST"
    rm -rf "$DEST"
fi

# 拷贝到 Applications
ditto "$SRC" "$DEST"

# 移除 Gatekeeper 隔离属性（需要管理员权限，会提示输入密码）
echo "   移除 Gatekeeper 隔离标记（需要输入密码）..."
sudo xattr -dr com.apple.quarantine "$DEST"

echo ""
echo "✅ 安装完成！"
echo "   打开方式：启动台 / 应用程序文件夹，双击 QQPlayer"
echo "   命令行：  open qqplayer://"
echo ""
read -r -p "是否立即打开 QQPlayer？(y/N) " -n 1 ans
echo ""
if [[ "$ans" =~ ^[Yy]$ ]]; then
    open "$DEST"
fi
