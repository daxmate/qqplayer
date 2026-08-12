#!/bin/bash
# 🎵 QQPlayer 部署脚本（macOS / launchd）
# 用法: ./deploy.sh
# 功能: 拉最新代码 → 装依赖 → 构建前端 → 重启 launchd 服务 → 健康检查
set -euo pipefail
cd "$(dirname "$0")"

LABEL="com.daxmate.qqplayer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "🎵 QQPlayer 部署开始..."

# 1. 拉最新代码
echo "── 拉取最新代码"
git pull --ff-only

# 2. 后端依赖
echo "── 安装后端依赖"
./venv/bin/python -m pip install -q -r requirements.txt

# 3. 前端构建
echo "── 构建前端"
(cd frontend && pnpm install && pnpm build)

# 4. 重启服务：停掉旧进程 → 卸载旧服务 → 加载 launchd 服务
# 注意：pkill 后立即 bootout/bootstrap 易报 "Bootstrap failed: 5: Input/output error"（launchd 域状态瞬时），
# 先等旧状态清理，bootstrap 失败自动重试
LABEL_CMD="gui/$(id -u)/$LABEL"
echo "── 重启服务"
pkill -f "backend.py" 2>/dev/null || true
launchctl bootout "$LABEL_CMD" 2>/dev/null || true
sleep 1
BOOTSTRAPPED=0
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    BOOTSTRAPPED=1
    break
  fi
  echo "  bootstrap 第 $attempt 次失败（I/O error 为瞬时状态），1s 后重试…"
  sleep 1
done
if [ "$BOOTSTRAPPED" -ne 1 ]; then
  echo "❌ launchctl bootstrap 连续 5 次失败，服务未加载"
  exit 1
fi

# 5. 健康检查
echo "── 健康检查"
sleep 2
if curl -sf -o /dev/null http://localhost:17627/; then
    echo "✅ QQPlayer 部署完成: http://localhost:17627"
else
    echo "❌ 健康检查失败，日志: ~/Library/Logs/qqplayer/err.log"
    tail -20 "$HOME/Library/Logs/qqplayer/err.log" 2>/dev/null || true
    exit 1
fi
