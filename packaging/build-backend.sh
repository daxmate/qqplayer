#!/usr/bin/env bash
# QQPlayer 后端 PyInstaller 一键打包：前端构建（可选跳过）→ PyInstaller onedir → 产物信息
#
# 用法：
#   ./packaging/build-backend.sh                      # 前端构建 + 打包
#   ./packaging/build-backend.sh --skip-frontend      # 跳过前端构建（复用现有 dist/）
#
# 环境变量：
#   PYTHON_BIN  打包用 python 解释器（默认主仓库 venv，含 pyinstaller 6.22.2 与全部依赖）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-/Users/dax/codes/qqplayer/backend/venv/bin/python}"

cd "$ROOT"

if [[ "${1:-}" == "--skip-frontend" ]]; then
    echo "==> 跳过前端构建（复用现有 dist/）"
else
    echo "==> 前端构建：pnpm install --frozen-lockfile && pnpm build"
    (cd frontend && pnpm install --frozen-lockfile && pnpm build)
fi

if [[ ! -f dist/index.html ]]; then
    echo "✗ 仓库根 dist/ 缺失（无 index.html），请先构建前端（或去掉 --skip-frontend）" >&2
    exit 1
fi

echo "==> PyInstaller 打包（onedir，spec: packaging/qqplayer-backend.spec）"
"$PYTHON_BIN" -m PyInstaller --noconfirm --clean \
    --distpath packaging/dist --workpath packaging/build \
    packaging/qqplayer-backend.spec

OUT="$ROOT/packaging/dist/qqplayer-backend"
echo "==> ✅ 产物目录: $OUT"
du -sh "$OUT"
echo "==> 可执行文件: $OUT/qqplayer-backend"
echo "==> 冒烟运行示例:"
echo "    QQPLAYER_PORT=17629 QQPLAYER_DATA_DIR=/tmp/qqp-pkg-test $OUT/qqplayer-backend"
