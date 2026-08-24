#!/bin/bash
# 🎵 QQPlayer 部署脚本（macOS / launchd）
# 用法: ./deploy.sh [--start]
# 功能: 拉最新代码 → 装依赖 → 构建前端 → 重启 launchd 服务 → 健康检查
#   --start: 快速重启模式——只重启服务（跳过拉代码/装依赖/构建/桌面壳）
set -euo pipefail
cd "$(dirname "$0")"

# 参数解析
RESTART_ONLY=0
case "${1:-}" in
  --start) RESTART_ONLY=1 ;;
  "") ;;
  *)
    echo "❌ 未知参数: ${1:-}（用法: ./deploy.sh [--start]）"
    exit 1
    ;;
esac

if [ "$RESTART_ONLY" = "1" ]; then
  echo "🎵 QQPlayer 快速重启（--start）：仅重启服务，不更新代码/依赖/前端"
else
  echo "🎵 QQPlayer 部署开始..."
fi

# 公共变量（--start 模式无备份，回滚分支自动跳过）
DIST="dist"
BACKUP=""

# 1. 拉最新代码
if [ "$RESTART_ONLY" = "0" ]; then
  echo "── 拉取最新代码"
  # 显式禁用 rebase：仓库配了 pull.rebase=true 时 --ff-only 会走 rebase，要求工作区干净（deploy.sh 自身未提交也会挂）
  git -c pull.rebase=false pull --ff-only
fi

# 2. 后端依赖（venv 缺失自动创建，参照 plist 自愈模式）
if [ "$RESTART_ONLY" = "0" ]; then
  if [ ! -x ./backend/venv/bin/python ]; then
    echo "── 检测到 backend/venv 缺失，自动创建"
    python3 -m venv backend/venv
  fi
  # python-lzo/readmdict 需要 lzo 头文件（requirements.txt 注释）。
  # 无条件导出：venv 已存在但缺 python-lzo 时同样需要（曾因只在新建时导出导致编译失败）
  if brew --prefix lzo >/dev/null 2>&1; then
    export LDFLAGS="-L$(brew --prefix lzo)/lib" CPPFLAGS="-I$(brew --prefix lzo)/include"
  else
    echo "⚠️ 未检测到 brew lzo，python-lzo 编译可能失败（先 brew install lzo）"
  fi
  echo "── 安装后端依赖"
  if ! ./backend/venv/bin/python -m pip install -r backend/requirements.txt; then
    echo "❌ 后端依赖安装失败，完整错误见上方输出"
    exit 1
  fi
fi

# 3. 前端构建（失败自动回滚上一版 dist）
# vite outDir 为 "../dist"（相对 frontend/），产物落在项目根 dist/（已 gitignore）
if [ "$RESTART_ONLY" = "0" ]; then
  BACKUP="${TMPDIR:-/tmp}/qqplayer-dist-backup"
  if [ -d "$DIST" ]; then
    echo "── 备份当前前端构建产物"
    rm -rf "$BACKUP"
    cp -R "$DIST" "$BACKUP"
  fi
  echo "── 构建前端"
  if ! (cd frontend && pnpm install && pnpm build); then
    echo "❌ 前端构建失败"
    if [ -d "$BACKUP" ]; then
      echo "── 回滚到上一版 dist"
      rm -rf "$DIST"
      cp -R "$BACKUP" "$DIST"
    fi
    exit 1
  fi
fi

# 4. 确保 launchd 托管（plist 缺失时自动创建并加载）
# 之前出现过 plist 丢失导致 pkill 后服务无人拉起的故障，这里做自愈：
# 检测 ~/Library/LaunchAgents/com.daxmate.qqplayer.plist，不存在则创建，再确保已加载
PLIST="$HOME/Library/LaunchAgents/com.daxmate.qqplayer.plist"
LOG_DIR="$HOME/Library/Logs/qqplayer"
if [ ! -f "$PLIST" ]; then
  echo "── 检测到 launchd plist 缺失，自动创建: $PLIST"
  mkdir -p "$LOG_DIR"
  cat > "$PLIST" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.daxmate.qqplayer</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/dax/codes/qqplayer/backend/venv/bin/python</string>
        <string>/Users/dax/codes/qqplayer/backend/backend.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/dax/codes/qqplayer/backend</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/dax/Library/Logs/qqplayer/out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/dax/Library/Logs/qqplayer/err.log</string>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
EOF
  chmod 644 "$PLIST"
fi

# 已创建/已有 plist：确认已加载（launchctl list 无该服务时加载）
if ! launchctl list 2>/dev/null | grep -q "com.daxmate.qqplayer"; then
  echo "── 加载 launchd 服务: $PLIST"
  launchctl load -w "$PLIST" 2>&1 || true
fi

# 5. 重启服务：kill 掉进程，launchd KeepAlive 会自动拉起新进程（加载新代码）
# 不要 bootout/bootstrap：pkill 后 KeepAlive 已重启，再卸载/加载会和 launchd 域状态打架（I/O error）
echo "── 重启服务（KeepAlive 自动拉起）"
pkill -f "qqplayer/backend/backend.py" 2>/dev/null || true

# 6. 健康检查（重试循环，最多 15 秒）
# 实测：pkill 后 KeepAlive 拉起 + Python/uvicorn 就绪约需 5 秒，
# 旧版固定等 2-3 秒单次探测会误判失败并误回滚 dist（2026-08-24 修复）
health_check() {
  for i in $(seq 1 15); do
    if curl -sf -o /dev/null http://localhost:17627/api/settings; then
      return 0
    fi
    echo "── 第 ${i}/15 次探测未就绪，1s 后重试"
    sleep 1
  done
  return 1
}

echo "── 健康检查"
if health_check; then
    echo "✅ QQPlayer 部署完成: http://localhost:17627"
else
    echo "❌ 健康检查失败（15s 内服务未就绪），尝试回滚上一版并重启"
    if [ -d "$BACKUP" ]; then
      rm -rf "$DIST"
      cp -R "$BACKUP" "$DIST"
      pkill -f "qqplayer/backend/backend.py" 2>/dev/null || true
      echo "── 已回滚 dist 并重启，等待服务恢复"
    fi
    if health_check; then
      echo "✅ 回滚成功，服务已恢复: http://localhost:17627"
    else
      echo "❌ 回滚后仍失败，日志: ~/Library/Logs/qqplayer/err.log"
      tail -20 "$HOME/Library/Logs/qqplayer/err.log" 2>/dev/null || true
      exit 1
    fi
fi

# 7. 编译安装桌面壳（代码有更新时一并部署；运行中的 app 下次启动才用新壳）
if [ "$RESTART_ONLY" = "1" ]; then
  echo "── 跳过桌面壳编译（--start 快速重启模式）"
else
  echo "── 编译安装桌面壳"
  if [ -f desktop/macOS/build.sh ]; then
    if ./desktop/macOS/build.sh --install >/dev/null 2>&1; then
      echo "✅ 桌面壳已更新（/Applications/QQPlayer.app），重启 QQPlayer.app 生效"
    else
      echo "⚠️ 桌面壳编译安装失败（不影响后端服务），手动排查: cd desktop/macOS && ./build.sh --install"
    fi
  else
    echo "── 跳过：desktop/macOS/build.sh 不存在"
  fi
fi
