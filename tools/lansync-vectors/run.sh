#!/usr/bin/env bash
#
# run.sh —— 一键：编译生成器（产物落临时目录）→ 生成 vectors.json → 自证
#
# 用法：
#   bash tools/lansync-vectors/run.sh              # 生成 tools/lansync-vectors/vectors.json
#   bash tools/lansync-vectors/run.sh /tmp/v.json  # 生成到指定路径（幂等性对比用）
#
# 环境变量（可选）：
#   QQPLAYER_SWIFT_REPO  —— 只读的 Swift 仓库根（默认 /Users/dax/codes/qqplayer-swift）
#
set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="$(cd "$TOOLS_DIR/../.." && pwd)"
SWIFT_REPO="${QQPLAYER_SWIFT_REPO:-/Users/dax/codes/qqplayer-swift}"
OUT_PATH="${1:-$TOOLS_DIR/vectors.json}"
BUILD_DIR="${LSV_BUILD_DIR:-${TMPDIR:-/tmp}/lsv-build}"

SYNC_DIR="$SWIFT_REPO/QQPlayer/Sync"
for f in DeviceID.swift SyncFrame.swift SyncCrypto.swift SyncIdentity.swift; do
  if [ ! -f "$SYNC_DIR/$f" ]; then
    echo "缺少只读 Swift 源码: $SYNC_DIR/$f" >&2
    exit 2
  fi
done

SWIFT_COMMIT="$(git -C "$SWIFT_REPO" rev-parse HEAD)"

mkdir -p "$BUILD_DIR"

echo "[1/3] swiftc 编译生成器（源码绝对路径引用，产物 $BUILD_DIR/lsv-gen）"
swiftc -O -o "$BUILD_DIR/lsv-gen" \
  "$TOOLS_DIR/generate.swift" \
  "$TOOLS_DIR/SupportShim.swift" \
  "$SYNC_DIR/DeviceID.swift" \
  "$SYNC_DIR/SyncFrame.swift" \
  "$SYNC_DIR/SyncCrypto.swift" \
  "$SYNC_DIR/SyncIdentity.swift"

echo "[2/3] 生成向量 → $OUT_PATH"
LSV_SWIFT_REPO="$SWIFT_REPO" LSV_SWIFT_COMMIT="$SWIFT_COMMIT" "$BUILD_DIR/lsv-gen" "$OUT_PATH"

echo "[3/3] 读回自证（SyncFrame.decode / SyncCipher.open / Ed25519 验签）"
echo "     SQL/JSON 校验请跑: $WORKTREE_ROOT/venv/bin/python3 $TOOLS_DIR/verify.py"
