#!/usr/bin/env python3
"""校验 QQPlayer 版本一致性：所有构建配置里的版本号必须与仓库根 VERSION 文件一致。

CI 每次 push 运行（version-check job）；不一致时退出码 1 并列出差异。
用法: python3 scripts/check-version.py
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ver = ROOT.joinpath("VERSION").read_text(encoding="utf-8").strip()
if not re.fullmatch(r"\d+\.\d+\.\d+", ver):
    print(f"✗ VERSION 文件格式非法: {ver!r}（应为 x.y.z）")
    sys.exit(1)

JSON_FILES = [
    "desktop/Windows/src-tauri/tauri.conf.json",
    "desktop/Windows/package.json",
    "desktop/Windows/package-lock.json",
    "frontend/package.json",
]

checks = []  # (文件, 实际版本/错误)

for f in JSON_FILES:
    p = ROOT / f
    if not p.exists():
        checks.append((f, "文件缺失"))
        continue
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        checks.append((f, f"JSON 解析失败: {e}"))
        continue
    if isinstance(data, dict) and isinstance(data.get("version"), str):
        checks.append((f, data["version"]))
    # package-lock.json 的根包（packages[""]）也带 version
    if f.endswith("package-lock.json"):
        root_pkg = (data.get("packages") or {}).get("", {})
        if isinstance(root_pkg, dict) and isinstance(root_pkg.get("version"), str):
            checks.append((f, root_pkg["version"]))

# Cargo.toml package 段
p = ROOT / "desktop/Windows/src-tauri/Cargo.toml"
m = re.search(
    r'^version = "([0-9]+\.[0-9]+\.[0-9]+)"',
    p.read_text(encoding="utf-8"),
    re.MULTILINE,
)
checks.append(("desktop/Windows/src-tauri/Cargo.toml", m.group(1) if m else "未找到"))

# Cargo.lock qqplayer-desktop 包
p = ROOT / "desktop/Windows/src-tauri/Cargo.lock"
m = re.search(
    r'name = "qqplayer-desktop"\nversion = "([0-9]+\.[0-9]+\.[0-9]+)"',
    p.read_text(encoding="utf-8"),
)
checks.append(("desktop/Windows/src-tauri/Cargo.lock", m.group(1) if m else "未找到"))

bad = [(f, v) for f, v in checks if v != ver]
if bad:
    print(f"✗ 版本不一致（真源 VERSION = {ver}）:")
    for f, v in bad:
        print(f"  {f}: {v}")
    sys.exit(1)

print(f"✅ 版本一致: {ver}（{len(checks)} 处）")
