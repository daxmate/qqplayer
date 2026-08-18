#!/bin/bash
# 🎵 QQPlayer 部署脚本（macOS / launchd）
# 用法: ./deploy.sh
# 功能: 拉最新代码 → 装依赖 → 构建前端 → 重启 launchd 服务 → 健康检查
set -euo pipefail
cd "$(dirname "$0")"

echo "🎵 QQPlayer 部署开始..."

# 1. 拉最新代码
echo "── 拉取最新代码"
git pull --ff-only

# 2. 后端依赖（venv 缺失自动创建，参照 plist 自愈模式）
if [ ! -x ./backend/venv/bin/python ]; then
  echo "── 检测到 backend/venv 缺失，自动创建"
  python3 -m venv backend/venv
  # python-lzo/readmdict 需要 lzo 头文件（requirements.txt 注释），新建 venv 时必须带上
  export LDFLAGS="-L$(brew --prefix lzo)/lib" CPPFLAGS="-I$(brew --prefix lzo)/include"
fi
echo "── 安装后端依赖"
./backend/venv/bin/python -m pip install -q -r backend/requirements.txt

# 3. 前端构建（失败自动回滚上一版 dist）
DIST="frontend/dist"
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
sleep 2 # 等 KeepAlive 拉起新进程

# 5. 健康检查（失败自动回滚上一版 dist 并重启）
echo "── 健康检查"
sleep 2
if curl -sf -o /dev/null http://localhost:17627/api/settings; then
    echo "✅ QQPlayer 部署完成: http://localhost:17627"
else
    echo "❌ 健康检查失败，尝试回滚上一版并重启"
    if [ -d "$BACKUP" ]; then
      rm -rf "$DIST"
      cp -R "$BACKUP" "$DIST"
      pkill -f "qqplayer/backend/backend.py" 2>/dev/null || true
      sleep 3
    fi
    if curl -sf -o /dev/null http://localhost:17627/api/settings; then
      echo "✅ 回滚成功，服务已恢复: http://localhost:17627"
    else
      echo "❌ 回滚后仍失败，日志: ~/Library/Logs/qqplayer/err.log"
      tail -20 "$HOME/Library/Logs/qqplayer/err.log" 2>/dev/null || true
      exit 1
    fi
fi
