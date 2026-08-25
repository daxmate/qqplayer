#!/bin/bash
# link-ios-www.sh —— 让 mobile/ios/Resources/www 成为指向 dist/ 的符号链接
#
# 背景：iOS 壳的 Resources/www 是前端 bundle（folder reference，编译时打进 app）。
# 早期方案是构建后拷贝（cp -R dist → www），每次构建都要全量复制；
# 现改为符号链接：前端构建（deploy.sh / build.sh）更新 dist/ 后，www 自动就是最新，
# 零拷贝、永不脱节（xcodegen 的 folder reference + Xcode 打包会解引用 symlink，已实测验证）。
#
# 用法：从仓库任意目录执行 scripts/link-ios-www.sh（幂等，可重复执行）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
WWW="$ROOT/mobile/ios/Resources/www"

if [ ! -d "$ROOT/mobile/ios" ]; then
  echo "⚠️ 未找到 mobile/ios（非 QQPlayer 完整仓库？），跳过 iOS 链接"
  exit 0
fi
if [ ! -d "$DIST" ]; then
  echo "❌ dist/ 不存在（先构建前端：cd frontend && pnpm build）"
  exit 1
fi

# 相对链接：从 www 所在目录（Resources/）向上三级到仓库根，再进 dist/
# （固定仓库结构 mobile/ios/Resources/www → ../../../dist；相对路径保证换机器/换用户路径不变）
REL="../../../dist"

# 幂等：已是正确链接 → no-op
if [ -L "$WWW" ] && [ "$(readlink "$WWW")" = "$REL" ]; then
  echo "    www 链接已就绪 → dist（无需处理）"
  exit 0
fi

# 旧真实目录（拷贝时代残留）→ 删除。
# ⚠️ 危险：rm -rf 绝不能带尾斜杠（rm -rf www/ 会跟随链接删掉 dist 内容）！这里只删链接或真实目录本身。
if [ -e "$WWW" ] && [ ! -L "$WWW" ]; then
  echo "── 移除旧的真实目录 $WWW"
  rm -rf "$WWW"
fi
# 残留的旧链接（指向别处）→ 先删再建
[ -L "$WWW" ] && rm "$WWW"

ln -s "$REL" "$WWW"
echo "    ✅ www → $REL（symlink，前端构建后自动最新）"
