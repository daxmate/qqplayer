#!/usr/bin/env bash
# QQPlayer 版本号统一管理：仓库根 VERSION 文件为唯一真源。
# 用法: ./scripts/set-version.sh <新版本号>   （如 1.1.0）
#
# 同步位置（构建器只认各自文件里的版本号，必须保留副本）：
#   - desktop/Windows/src-tauri/tauri.conf.json   （Tauri 打包版本）
#   - desktop/Windows/src-tauri/Cargo.toml        （Rust crate 版本）
#   - desktop/Windows/src-tauri/Cargo.lock        （lockfile 包版本）
#   - desktop/Windows/package.json / package-lock.json（壳 npm 包版本）
#   - frontend/package.json                       （前端 npm 包版本）
# 注意：make-dmg.sh / desktop/macOS/build.sh 不在此列——它们运行时直接读 VERSION 文件。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NEW="${1:-}"
if [[ ! "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "✗ 用法: ./scripts/set-version.sh <x.y.z>（收到: '$NEW'）" >&2
  exit 1
fi

echo "$NEW" > VERSION
echo "✅ VERSION → $NEW"

# JSON 配置（保留原格式，仅替换产品版本号）
# 注意：package-lock.json 只改根包（顶层 + packages[""]），绝不碰 node_modules 依赖包的 version 字段
python3 - "$NEW" <<'PY'
import re, sys
new = sys.argv[1]

# 版本字段唯一的文件（root version）：tauri.conf.json / package.json / frontend/package.json
files = [
    "desktop/Windows/src-tauri/tauri.conf.json",
    "desktop/Windows/package.json",
    "frontend/package.json",
]
pat = re.compile(r'("version"\s*:\s*")[0-9]+\.[0-9]+\.[0-9]+(")')
for f in files:
    s = open(f, encoding="utf-8").read()
    s2, n = pat.subn(rf"\g<1>{new}\g<2>", s)
    open(f, "w", encoding="utf-8").write(s2)
    print(f"  {f}: {n} 处")

# package-lock.json：只改 name = qqplayer-desktop-windows 的两个块（顶层 + packages[""]）
f = "desktop/Windows/package-lock.json"
s = open(f, encoding="utf-8").read()
pat2 = re.compile(r'("name": "qqplayer-desktop-windows",\n(?:\s*)"version": ")[0-9]+\.[0-9]+\.[0-9]+(")')
s2, n = pat2.subn(rf"\g<1>{new}\g<2>", s)
open(f, "w", encoding="utf-8").write(s2)
print(f"  {f}: {n} 处（仅根包）")
PY

# Cargo.toml / Cargo.lock
python3 - "$NEW" <<'PY'
import re, sys
new = sys.argv[1]

f = "desktop/Windows/src-tauri/Cargo.toml"
s = open(f, encoding="utf-8").read()
s2, n = re.subn(r'^version = "[0-9]+\.[0-9]+\.[0-9]+"', f'version = "{new}"', s, count=1, flags=re.M)
open(f, "w", encoding="utf-8").write(s2)
print(f"  {f}: {n} 处")

f = "desktop/Windows/src-tauri/Cargo.lock"
s = open(f, encoding="utf-8").read()
m = re.search(r'(name = "qqplayer-desktop"\nversion = ")[0-9]+\.[0-9]+\.[0-9]+(")', s)
if m:
    s = s[:m.start()] + m.group(1) + new + m.group(2) + s[m.end():]
    open(f, "w", encoding="utf-8").write(s)
    print(f"  {f}: 1 处")
else:
    print(f"  ⚠️ {f}: 未找到 qqplayer-desktop 包")
PY

echo ""
echo "✅ 全部同步完成，运行 ./scripts/check-version.py 校验"
