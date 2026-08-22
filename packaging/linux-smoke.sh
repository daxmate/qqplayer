#!/usr/bin/env bash
set -euo pipefail

# QQPlayer Tauri shell smoke test (Linux CI, headless):
# 1. xvfb-run 提供 X server，dbus-run-session 提供 session bus（WebKitGTK 两者都需要）
# 2. 起壳 → 壳探测 17627 无服务 → spawn 内置后端 → 后端就绪后壳建窗加载前端页面
# 3. 轮询 http://127.0.0.1:17627/api/settings 期望 HTTP 200（端口写死 17627，冒烟不能注入 QQPLAYER_PORT）
# 轮询预算 25s：壳 READY_TIMEOUT 15s，后端就绪后壳才建窗，15s 内必现；留 25s 余量
# 退出码: 0 = 通过; 1 = 启动失败 / 接口异常 / 超时

EXE="${1:-desktop/Windows/src-tauri/target/release/qqplayer-desktop}"

if [[ ! -x "${EXE}" ]]; then
  echo "✗ 壳可执行文件不存在: ${EXE}" >&2
  exit 1
fi

# 后端启动失败时不弹错误框、直接退出（无头 CI 没人点对话框）
export QQPLAYER_NO_DIALOG=1
# WebKitGTK 无头 CI 防 GPU 崩溃
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1

DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}"
LOG_DIR="${DATA_DIR}/QQPlayer/logs"
SMOKE_URL="http://127.0.0.1:17627/api/settings"

# 整个生命周期管理在 xvfb-run 的内层 bash 里做：xvfb-run 在子命令退出时会清理 Xvfb，
# 若内层提前退出，壳会失去 X server 崩溃——所以起壳、轮询、收尾必须都留在内层。
# dbus-run-session 提供 session bus；壳由 sh -c 包装（先 echo $$ 写 pid 文件再 exec，
# exec 后 pid 不变），保证拿到的是壳的真实 pid，可精确检测"提前退出"并 kill 触发
# RunEvent::ExitRequested（壳退出时自动 terminate 后端）。
xvfb-run -a --server-args="-screen 0 1280x800x24" \
  bash -c '
    set -euo pipefail
    EXE_PATH="$1"; SMOKE_URL="$2"; LOG_DIR="$3"
    PID_FILE="$(mktemp)"
    dbus-run-session -- sh -c "echo \$\$ > \"\$1\"; exec \"\$2\"" _ "${PID_FILE}" "${EXE_PATH}" &
    # 等 pid 文件写入（dbus-run-session 起 sh 是毫秒级，5s 上限充裕）
    for _i in $(seq 1 50); do
      [ -s "${PID_FILE}" ] && break
      sleep 0.1
    done
    SHELL_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
    rm -f "${PID_FILE}"
    if [ -z "${SHELL_PID}" ]; then
      echo "✗ 无法获取壳进程 pid" >&2
      exit 1
    fi
    echo "[smoke] shell launched (pid ${SHELL_PID}, exe ${EXE_PATH})"

    print_logs() {
      # 失败诊断：打印壳启动/后端日志尾部（存在才打印）
      if [ -f "${LOG_DIR}/backend-launcher.log" ]; then
        echo "===== backend-launcher.log tail ====="
        tail -15 "${LOG_DIR}/backend-launcher.log"
      else
        echo "[smoke] backend-launcher.log 不存在（${LOG_DIR}/backend-launcher.log）"
      fi
      if [ -f "${LOG_DIR}/pkg-backend.log" ]; then
        echo "===== pkg-backend.log tail ====="
        tail -20 "${LOG_DIR}/pkg-backend.log"
      else
        echo "[smoke] pkg-backend.log 不存在"
      fi
    }

    cleanup() {
      # 杀壳 → RunEvent::ExitRequested 自动 terminate 后端；pkill 兜底清残留
      # （[q]qplayer-backend 正则技巧：避免 pkill -f 匹配到本脚本自身的命令行）
      [ -n "${SHELL_PID:-}" ] && kill "${SHELL_PID}" 2>/dev/null || true
      pkill -f "[q]qplayer-backend" 2>/dev/null || true
    }
    trap cleanup EXIT

    OK=0
    DEADLINE=$(( $(date +%s) + 25 ))
    while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
      # 进程提前退出 → 后端 spawn 失败或壳立即崩溃
      if ! kill -0 "${SHELL_PID}" 2>/dev/null; then
        echo "[smoke] 壳进程提前退出（后端 spawn 失败或立即崩溃）"
        print_logs
        exit 1
      fi
      if curl -sf -o /dev/null "${SMOKE_URL}"; then
        OK=1
        break
      fi
      sleep 0.5
    done

    if [ "${OK}" = "1" ]; then
      echo "✅ 冒烟通过: ${SMOKE_URL} → HTTP 200"
      exit 0
    fi
    echo "✗ 冒烟超时（25s 内未等到 HTTP 200）"
    print_logs
    exit 1
  ' _ "${EXE}" "${SMOKE_URL}" "${LOG_DIR}"
