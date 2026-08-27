"""跨层契约测试：设置注册表（frontend settingsIndex.ts）↔ 前端默认值 ↔ 后端白名单三方一致性。

安全网：任何一方改动漏同步 → 立即红。只读校验，不修改产品代码。
- 前端注册表：frontend/src/settingsIndex.ts（64 个 SettingEntry，id/category/subTab）
- 前端默认值：frontend/src/composables/{playerCore,useSettings}.js 的 *_SETTINGS_DEFAULTS 常量
- 后端白名单：app/services/settings.py _SETTINGS_SPEC（11 namespace）+ app/state.py LIBRARY_SETTINGS_DEFAULTS

已知缺口清单（禁止静默新增；修复后同步更新下方两个常量）：
  ambientEnabled / miniSpectrumEnabled —— playerCore.js 注释明确的「前端本地持久化」字段（白名单故意不收）
  amllBlur / amllSpring / amllScale    —— AMLL 三特效（环境差异化默认），后端无字段，仅 localStorage 写透
  coverSize / glassCover               —— useSettings.js 注释明确的「后端白名单未收录」UI 字段
  shortcutOpenSettings                 —— ⌘, 打开设置快捷键：前端默认值有、后端 playback 白名单缺（真实缺口，待补）

运行：cd backend && python -m pytest tests/test_settings_contract.py -q
"""

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]  # backend/
REPO = Path(__file__).resolve().parents[2]  # 仓库根
sys.path.insert(0, str(ROOT))

from app import state  # noqa: E402
from app.services.settings import _SETTINGS_SPEC  # noqa: E402

FRONTEND_INDEX = REPO / "frontend" / "src" / "settingsIndex.ts"
PLAYER_CORE = REPO / "frontend" / "src" / "composables" / "playerCore.js"
USE_SETTINGS = REPO / "frontend" / "src" / "composables" / "useSettings.js"

# ============ 已知缺口清单（见模块 docstring；修复后同步更新）============
FRONTEND_LOCAL_REGISTRY = {
    "ambientEnabled",
    "miniSpectrumEnabled",
    "amllBlur",
    "amllSpring",
    "amllScale",
    "glassCover",
    "coverSize",
}
FRONTEND_LOCAL_DEFAULTS = FRONTEND_LOCAL_REGISTRY | {
    "coverSize",
    "glassCover",
    "shortcutOpenSettings",
}

_DESKTOP_PREFIX = "desktop"


def _map_field(eid: str, category: str) -> str:
    """注册表 id → 后端字段名推导（与 settingsIndex.ts 的 get() 引用对象一致）：
    downloadEngine → engine；desktop* → 去前缀首字母小写（desktopShowZh → showZh）。"""
    if category == "download" and eid == "downloadEngine":
        return "engine"
    if category == "lyric" and eid.startswith(_DESKTOP_PREFIX):
        rest = eid[len(_DESKTOP_PREFIX) :]
        return rest[0].lower() + rest[1:]
    return eid


# 每个 entry：id 后跟 category，再后跟 subTab（结构固定，见 settingsIndex.ts）
_ENTRY_RE = re.compile(
    r'id:\s*"([^"]+)"\s*,\s*'
    r'category:\s*"([^"]+)"\s*,\s*'
    r".*?"
    r'subTab:\s*("app"|"desktop"|null)',
    re.S,
)


def _parse_registry() -> list[tuple[str, str, str]]:
    src = FRONTEND_INDEX.read_text(encoding="utf-8")
    entries = [(eid, cat, sub.strip('"')) for eid, cat, sub in _ENTRY_RE.findall(src)]
    assert entries, "注册表解析失败：未提取到任何 entry"
    assert len(entries) == len({e[0] for e in entries}), "注册表 id 重复"
    return entries


def _parse_defaults(path: Path, const_name: str) -> set[str]:
    """解析 `export const XXX = { ... };` 的顶层 key 集合（花括号配对，忽略 // 注释行）"""
    src = path.read_text(encoding="utf-8")
    m = re.search(rf"export const {const_name}\s*=\s*\{{", src)
    assert m, f"{const_name} 未在 {path.name} 找到"
    start = m.end() - 1
    depth = 0
    end = len(src)
    for i in range(start, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    keys = set()
    for line in src[start + 1 : end].splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        km = re.match(r"([A-Za-z_][A-Za-z0-9_]*):", line)
        if km:
            keys.add(km.group(1))
    assert keys, f"{const_name} 未解析出任何 key"
    return keys


def _backend_whitelist() -> set[str]:
    """后端白名单字段并集：_SETTINGS_SPEC 全部 namespace + LIBRARY_SETTINGS_DEFAULTS"""
    keys = set()
    for ns_spec in _SETTINGS_SPEC.values():
        keys.update(ns_spec.keys())
    keys.update(state.LIBRARY_SETTINGS_DEFAULTS.keys())
    return keys


REGISTRY = _parse_registry()  # [(id, category, subTab), ...]
BACKEND_WHITELIST = _backend_whitelist()
DEFAULTS_UNION = set().union(
    _parse_defaults(PLAYER_CORE, "PLAYBACK_SETTINGS_DEFAULTS"),
    _parse_defaults(USE_SETTINGS, "LYRIC_SETTINGS_DEFAULTS"),
    _parse_defaults(USE_SETTINGS, "UI_SETTINGS_DEFAULTS"),
    _parse_defaults(USE_SETTINGS, "DESKTOP_LYRIC_DEFAULTS"),
    _parse_defaults(USE_SETTINGS, "DOWNLOAD_SETTINGS_DEFAULTS"),
    _parse_defaults(USE_SETTINGS, "VIDEO_SETTINGS_DEFAULTS"),
)


def test_registry_count():
    """注册表项数快照：新增设置项需同步更新（并检查三方白名单）"""
    assert len(REGISTRY) == 70


def test_registry_mapped_ids_subset_of_backend_whitelist():
    """注册表字段（含别名推导）⊆ 后端白名单并集；差额必须恰为已知缺口清单"""
    mapped = {_map_field(eid, cat) for eid, cat, _ in REGISTRY}
    missing = mapped - BACKEND_WHITELIST
    assert missing == FRONTEND_LOCAL_REGISTRY, (
        f"契约缺口：注册表字段不在后端白名单 {sorted(missing - FRONTEND_LOCAL_REGISTRY)}；"
        f"或缺口清单过期（已入白名单仍列着）{sorted(FRONTEND_LOCAL_REGISTRY - missing)}"
    )


def test_registry_category_namespace_consistency():
    """category 归属：playback→playback/player、lyric+desktop→desktopLyric、library→LIBRARY 字段……"""
    for eid, cat, sub in REGISTRY:
        field = _map_field(eid, cat)
        if cat == "playback":
            allowed = set(_SETTINGS_SPEC["playback"]) | set(_SETTINGS_SPEC["player"])
        elif cat == "library":
            allowed = set(state.LIBRARY_SETTINGS_DEFAULTS)
        elif cat == "video":
            allowed = set(_SETTINGS_SPEC["video"])
        elif cat == "download":
            allowed = set(_SETTINGS_SPEC["download"])
        elif cat == "lyric":
            allowed = set(
                _SETTINGS_SPEC["desktopLyric"] if sub == "desktop" else _SETTINGS_SPEC["lyric"]
            )
        elif cat == "ui":
            allowed = set(_SETTINGS_SPEC["ui"])
        else:
            pytest.fail(f"{eid} 分类 {cat} 无后端 namespace 归属")
        assert field in allowed or field in FRONTEND_LOCAL_REGISTRY, (
            f"{eid}（{cat}/{sub}）字段 {field} 不在后端 {cat} 归属 namespace（也非已知前端本地字段）"
        )


def test_registry_fields_present_in_frontend_defaults():
    """注册表每个字段必须存在于前端默认值命名空间（library 特判走后端 LIBRARY_SETTINGS_DEFAULTS）"""
    lib_fields = set(state.LIBRARY_SETTINGS_DEFAULTS)
    for eid, cat, _ in REGISTRY:
        field = _map_field(eid, cat)
        if cat == "library":
            assert field in lib_fields, f"{eid} 不在后端 LIBRARY_SETTINGS_DEFAULTS"
        else:
            assert field in DEFAULTS_UNION, f"{eid} 字段 {field} 不在任何前端默认值命名空间"


def test_frontend_defaults_subset_of_backend_whitelist():
    """前端默认值字段 ⊆ 后端白名单并集；差额必须恰为已知缺口清单"""
    missing = DEFAULTS_UNION - BACKEND_WHITELIST
    assert missing == FRONTEND_LOCAL_DEFAULTS, (
        f"契约缺口：前端默认值字段不在后端白名单 {sorted(missing - FRONTEND_LOCAL_DEFAULTS)}；"
        f"或缺口清单过期（已入白名单仍列着）{sorted(FRONTEND_LOCAL_DEFAULTS - missing)}"
    )
