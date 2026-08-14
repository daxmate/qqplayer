#!/usr/bin/env python3
"""
music-player 后端 API
- 扫描本地歌曲库文件夹（mp3/flac/m4a/wav/ogg）
- 提取内嵌专辑封面（mutagen）
- 音频流播放（支持 Range 请求）
- 加载同名 .srt/.lrc 歌词
用法: ./venv/bin/python backend.py [歌曲库路径]
"""

import json
import os
import re
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from lyric_fetch import (
    delete_manual_lyric,
    fetch_online_lyric,
    load_manual_lyric,
    save_manual_lyric,
    search_lyric_candidates,
)

try:
    from mutagen import File as MutagenFile
    from mutagen.mp4 import MP4, MP4Cover
except ImportError:
    MutagenFile = None

ROOT = Path(__file__).resolve().parent
# 默认歌曲库：用户本地 iCloud 音乐文件夹（不在仓库内，仓库不存音频文件）
DEFAULT_LIBRARY = Path(
    "/Users/dax/Library/Mobile Documents/iCloud~dev~clq~Cosmos-Music-Player/Documents"
)
DEFAULT_PORT = 17627

# 用户数据目录：macOS 标准应用数据位置（收藏等，不放仓库）
DATA_DIR = Path(os.path.expanduser("~")) / "Library" / "Application Support" / "qqplayer"
FAVORITES_FILE = DATA_DIR / "favorites.json"
PLAYLISTS_FILE = DATA_DIR / "playlists.json"
PLAYBACK_FILE = DATA_DIR / "playback.json"
# 播放记录滚动保留上限（超了删最旧）
PLAYBACK_LIMIT = 5000
# 播放时长少于该秒数视为误触，不记录
PLAYBACK_MIN_SECONDS = 3
# 桌面歌词/迷你窗：主页面状态上报，悬浮窗轮询读取（内存态，不持久化）
_now_playing: dict = {
    "path": None,
    "name": None,
    "artist": None,
    "duration": 0.0,
    "currentTime": 0.0,
    "isPlaying": False,
    "volume": 1.0,
    "lineIndex": -1,
    "updatedAt": 0.0,
    "accent": None,
}
_now_playing_lock = threading.Lock()
# 迷你窗控制指令队列：迷你窗 POST 入队，主播放器页面轮询取走执行（内存态）
# 元素: {"action": str, "value": float|None}
_player_actions: list[dict] = []
_player_actions_lock = threading.Lock()
# 合法指令白名单（防止任意指令注入）
_PLAYER_ACTIONS = {"togglePlay", "play", "pause", "next", "prev", "seek", "volume"}
# 迷你窗运行状态：Swift 壳启动/退出时上报，主页面轮询点亮顶栏开关
_mini_status: dict = {"running": False}
_mini_status_lock = threading.Lock()
# 库变动监听：事件去抖窗口（秒）与扫描缓存
WATCH_DEBOUNCE_SECONDS = 2.0
_scan_cache: dict | None = None  # {"library": str, "songs": [...]}
_scan_version = 0
_scan_lock = threading.Lock()
_watch_timer: threading.Timer | None = None
_watch_observer: Observer | None = None

app = FastAPI(title="music-player")

# 运行时歌曲库路径（可通过命令行参数修改）
LIBRARY = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_LIBRARY

# 支持的音频格式（默认全选，可在设置里多选过滤）
DEFAULT_AUDIO_EXTS = [".mp3", ".flac", ".m4a", ".wav", ".ogg", ".aac", ".opus"]
AUDIO_EXTS = set(DEFAULT_AUDIO_EXTS)
LYRIC_EXTS = {".srt", ".lrc"}

# ============ 统一设置（单一 settings.json · 6 namespace）============
# 存储结构: {"library": {...}, "ui": {...}, "lyric": {...}, "playback": {...},
#            "desktopLyric": {...}, "player": {...}}
# 注意：旧 library 设置文件也叫 settings.json（与新区文件同名）！
# 迁移时旧文件先读入内存再写新结构，不能先覆盖后读（见 migrate_legacy_settings）。
SETTINGS_FILE = DATA_DIR / "settings.json"
# 遗留单文件设置（一次性迁移数据源；迁移后只读保留作备份，不再写入）
UI_SETTINGS_FILE = DATA_DIR / "ui_settings.json"
DESKTOP_LYRIC_FILE = DATA_DIR / "desktop_lyric.json"
# 内存缓存：完整 6 namespace 结构
_settings: dict | None = None

# ---- 各 namespace 默认值 ----
# library：现有 LIBRARY_SETTINGS_DEFAULTS 4 字段
LIBRARY_SETTINGS_DEFAULTS = {
    "audioExts": DEFAULT_AUDIO_EXTS,
    "ignoreHidden": True,  # 忽略隐藏文件/文件夹
    "autoRefresh": True,  # watchdog 自动刷新（库变动自动重扫）
    "autoScanOnStart": True,  # 启动时自动扫描歌曲库
}
# ui：前端 frontend/src/composables/useSettings.js UI_SETTINGS_DEFAULTS 全部 8 字段（只读拷贝）
UI_SETTINGS_DEFAULTS = {
    "showSongInfo": False,  # 跟唱模式歌词面板顶部显示当前歌曲信息
    "karaokeShowTime": False,  # 跟唱模式每句显示起止时间戳
    "karaokeShowNum": True,  # 跟唱模式每句左侧显示行号
    "theme": "dark",  # 主题：'dark' 深色 | 'light' 浅色 | 'auto' 跟随系统
    "miniTheme": "theme",  # 迷你窗外观：'theme' 跟随主窗口 | 'dark' 深色 | 'light' 浅色
    "accent": "orange",  # 强调色预设 key
    "coverBlur": False,  # 封面模糊背景
    "compact": False,  # 紧凑模式
}
# lyric：前端 useSettings.js LYRIC_SETTINGS_DEFAULTS 全部 15 字段
LYRIC_SETTINGS_DEFAULTS = {
    "fontFamily": "system",  # 'system' | 'serif' | 'rounded'
    "fontSize": 20,  # 当前句基准字号（px）
    "align": "left",  # 'left' | 'center' | 'right'
    "engine": "amll",  # 歌词滚动引擎：'amll' | 'spring' | 'native'
    "showRoma": True,  # 显示罗马音
    "showZh": True,  # 显示中文翻译
    "showSec": True,  # 显示段落标题
    "focusPos": 0.5,  # 焦点句停靠位置（0~1）
    "fadeMask": True,  # 上下渐隐遮罩
    "autoScroll": True,  # 切句自动跟随滚动
    "offset": 0,  # 歌词延迟校准（秒，-2~2）
    "source": "local",  # 'local' 本地优先 | 'online' 在线优先
    "colorScheme": "theme",  # 配色方案 key
    "jpColor": "",  # 主行文字颜色（自定义）
    "zhColor": "",  # 翻译行文字颜色（自定义）
}
# playback：前端 frontend/src/composables/playerCore.js PLAYBACK_SETTINGS_DEFAULTS 全部 13 字段
PLAYBACK_SETTINGS_DEFAULTS = {
    "playMode": "order",  # 'order' 列表循环 | 'shuffle' 随机 | 'repeatOne' 单曲循环
    "resumeLast": True,  # 启动时恢复上次播放的歌曲与进度
    "rememberVolume": True,  # 记住音量
    "fadeSec": 0,  # 切歌淡入淡出时长（秒）；0 = 关闭
    "karaokeNextKey": "KeyN",  # 跟唱：下一句快捷键
    "karaokePrevKey": "KeyP",  # 跟唱：上一句快捷键
    "eqEnabled": False,  # 均衡器开关
    "eqPreset": "flat",  # 均衡器预设 key（'custom' = 用户自定义）
    "eqGains": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  # 自定义增益（dB，-12~12，10 段）
    "abVisual": True,  # AB 循环区间可视化
    "abLoopCountOn": True,  # AB 循环计数（防走开安全阀）
    "abLoopMaxCount": 10,  # AB 循环计数上限（1-20）
    "visualizerEnabled": True,  # 频谱可视化开关
}
# desktopLyric：现有 DESKTOP_LYRIC_DEFAULTS 11 字段（不动）
DESKTOP_LYRIC_DEFAULTS = {
    "enabled": False,
    "showZh": True,
    "fontFamily": "system",
    "fontSize": 26,
    "zhSize": 16,
    "align": "center",
    "width": 460,
    "height": 140,
    "colorScheme": "white",
    "jpColor": "#ffffff",
    "zhColor": "#ffffff",
}
# player：播放器运行时状态（volume 数字 0~1；panel/controls 布尔；lastPlayed 对象或 null）
PLAYER_SETTINGS_DEFAULTS = {
    "volume": 1.0,
    "panel": True,
    "controls": False,
    "lastPlayed": None,
}

_SETTINGS_NAMESPACES = ("library", "ui", "lyric", "playback", "desktopLyric", "player")


# ============ 字段校验器（合法值保留/规范化，非法值回落默认）============
def _norm_bool(v, default):
    """布尔：类型非法回落默认"""
    return v if isinstance(v, bool) else default


def _norm_str(v, default, allowed=None):
    """字符串：类型非法回落默认；allowed 给定时必须是其中一员"""
    if isinstance(v, str) and (allowed is None or v in allowed):
        return v
    return default


def _norm_num(v, default, lo=None, hi=None, integer=False):
    """数字：类型非法回落默认；越界 clamp（eqGains/volume 等明确要求 clamp 的字段用）"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    if lo is not None and v < lo:
        v = lo
    if hi is not None and v > hi:
        v = hi
    return int(v) if integer else v


def _norm_exts(v, default):
    """audioExts：字符串扩展名列表（小写、带点）；过滤后非空才采纳，否则回落默认"""
    if isinstance(v, list) and v:
        exts = [str(e).lower() for e in v if isinstance(e, str) and e.startswith(".")]
        if exts:
            return exts
    return default


def _norm_eq_gains(v):
    """eqGains：必须是长度 10 数字数组（clamp ±12）；非法回落全 0"""
    default = list(PLAYBACK_SETTINGS_DEFAULTS["eqGains"])
    if not isinstance(v, list) or len(v) != 10:
        return default
    gains = []
    for g in v:
        if isinstance(g, bool) or not isinstance(g, (int, float)):
            return default
        gains.append(min(12.0, max(-12.0, float(g))))
    return gains


def _norm_last_played(v):
    """lastPlayed：{path: str, time: number} 或 null；非法结构回落 null"""
    if isinstance(v, dict) and isinstance(v.get("path"), str):
        t = v.get("time")
        if isinstance(t, (int, float)) and not isinstance(t, bool):
            return {"path": v["path"], "time": t}
    return None


# 每 namespace 字段规范: {字段: (默认值, 校验器)}；不在白名单的字段一律忽略
_SETTINGS_SPEC = {
    "library": {
        "audioExts": (LIBRARY_SETTINGS_DEFAULTS["audioExts"], _norm_exts),
        "ignoreHidden": (LIBRARY_SETTINGS_DEFAULTS["ignoreHidden"], _norm_bool),
        "autoRefresh": (LIBRARY_SETTINGS_DEFAULTS["autoRefresh"], _norm_bool),
        "autoScanOnStart": (LIBRARY_SETTINGS_DEFAULTS["autoScanOnStart"], _norm_bool),
    },
    "ui": {
        "showSongInfo": (UI_SETTINGS_DEFAULTS["showSongInfo"], _norm_bool),
        "karaokeShowTime": (UI_SETTINGS_DEFAULTS["karaokeShowTime"], _norm_bool),
        "karaokeShowNum": (UI_SETTINGS_DEFAULTS["karaokeShowNum"], _norm_bool),
        "theme": ("dark", lambda v, d: _norm_str(v, d, allowed={"dark", "light", "auto"})),
        "miniTheme": ("theme", lambda v, d: _norm_str(v, d, allowed={"theme", "dark", "light"})),
        "accent": (
            "orange",
            lambda v, d: _norm_str(v, d, allowed={"orange", "blue", "green", "purple", "pink", "teal"}),
        ),
        "coverBlur": (UI_SETTINGS_DEFAULTS["coverBlur"], _norm_bool),
        "compact": (UI_SETTINGS_DEFAULTS["compact"], _norm_bool),
    },
    "lyric": {
        "fontFamily": ("system", lambda v, d: _norm_str(v, d, allowed={"system", "serif", "rounded"})),
        "fontSize": (20, lambda v, d: _norm_num(v, d, lo=14, hi=30)),
        "align": ("left", lambda v, d: _norm_str(v, d, allowed={"left", "center", "right"})),
        "engine": ("amll", lambda v, d: _norm_str(v, d, allowed={"amll", "spring", "native"})),
        "showRoma": (True, _norm_bool),
        "showZh": (True, _norm_bool),
        "showSec": (True, _norm_bool),
        "focusPos": (0.5, lambda v, d: _norm_num(v, d, lo=0.0, hi=1.0)),
        "fadeMask": (True, _norm_bool),
        "autoScroll": (True, _norm_bool),
        "offset": (0, lambda v, d: _norm_num(v, d, lo=-2.0, hi=2.0)),
        "source": ("local", lambda v, d: _norm_str(v, d, allowed={"local", "online"})),
        "colorScheme": ("theme", _norm_str),
        "jpColor": ("", _norm_str),
        "zhColor": ("", _norm_str),
    },
    "playback": {
        "playMode": ("order", lambda v, d: _norm_str(v, d, allowed={"order", "shuffle", "repeatOne"})),
        "resumeLast": (True, _norm_bool),
        "rememberVolume": (True, _norm_bool),
        "fadeSec": (0, lambda v, d: _norm_num(v, d, lo=0.0, hi=5.0)),
        "karaokeNextKey": ("KeyN", _norm_str),
        "karaokePrevKey": ("KeyP", _norm_str),
        "eqEnabled": (False, _norm_bool),
        "eqPreset": (
            "flat",
            lambda v, d: _norm_str(v, d, allowed={"flat", "pop", "rock", "jazz", "classical", "bass", "vocal", "custom"}),
        ),
        "eqGains": (PLAYBACK_SETTINGS_DEFAULTS["eqGains"], lambda v, d: _norm_eq_gains(v)),
        "abVisual": (True, _norm_bool),
        "abLoopCountOn": (True, _norm_bool),
        "abLoopMaxCount": (10, lambda v, d: _norm_num(v, d, lo=1, hi=20, integer=True)),
        "visualizerEnabled": (True, _norm_bool),
    },
    "desktopLyric": {
        "enabled": (False, _norm_bool),
        "showZh": (True, _norm_bool),
        "fontFamily": ("system", lambda v, d: _norm_str(v, d, allowed={"system", "serif", "rounded"})),
        "fontSize": (26, lambda v, d: _norm_num(v, d, lo=18, hi=40)),
        "zhSize": (16, lambda v, d: _norm_num(v, d, lo=12, hi=26)),
        "align": ("center", lambda v, d: _norm_str(v, d, allowed={"left", "center", "right"})),
        "width": (460, lambda v, d: _norm_num(v, d, lo=300, hi=800)),
        "height": (140, lambda v, d: _norm_num(v, d, lo=80, hi=300)),
        "colorScheme": ("white", _norm_str),
        "jpColor": ("#ffffff", _norm_str),
        "zhColor": ("#ffffff", _norm_str),
    },
    "player": {
        "volume": (1.0, lambda v, d: _norm_num(v, d, lo=0.0, hi=1.0)),
        "panel": (True, _norm_bool),
        "controls": (False, _norm_bool),
        "lastPlayed": (None, lambda v, d: _norm_last_played(v)),
    },
}


def _norm_namespace(ns: str, data: dict) -> dict:
    """按 spec 规范化单个 namespace：白名单字段 + 类型/取值校验，非法值回落默认"""
    spec = _SETTINGS_SPEC[ns]
    out = {}
    for k, (default, norm) in spec.items():
        out[k] = norm(data[k], default) if k in data else default
    return out


def load_all_settings() -> dict:
    """读取统一设置（内存缓存；文件缺失/损坏时回落各 namespace 默认值）"""
    global _settings
    if _settings is not None:
        return _settings
    data = {}
    try:
        if SETTINGS_FILE.exists():
            raw = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data = raw
    except (OSError, json.JSONDecodeError):
        data = {}
    merged = {}
    for ns in _SETTINGS_NAMESPACES:
        raw_ns = data.get(ns) if isinstance(data.get(ns), dict) else {}
        merged[ns] = _norm_namespace(ns, raw_ns)
    _settings = merged
    return merged


def save_all_settings(patch: dict) -> dict:
    """namespace→字段两级深合并保存并更新缓存（只合并传入字段，未传字段不动；未知 namespace 忽略）"""
    global _settings
    merged = dict(load_all_settings())
    for ns in _SETTINGS_NAMESPACES:
        if ns in patch and isinstance(patch[ns], dict):
            merged[ns] = _norm_namespace(ns, {**merged[ns], **patch[ns]})
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    _settings = merged
    return merged


def migrate_legacy_settings() -> None:
    """旧三文件一次性迁移 → 统一 settings.json（幂等；旧文件保留不删作备份）

    旧 library 文件就叫 settings.json（与新区文件同名）！所以必须先把旧文件读进内存，
    再写新结构（library 数据并入 library namespace），绝不能先覆盖后读。
    新文件已是新格式（顶层含 namespace 键）→ 整体跳过（幂等）。
    """
    global _settings
    # 1) 读旧 library 文件（若已是新格式则说明已迁移，跳过）
    legacy_library: dict = {}
    if SETTINGS_FILE.exists():
        try:
            existing = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = None
        if isinstance(existing, dict) and any(k in existing for k in _SETTINGS_NAMESPACES):
            return  # 已是统一格式
        if isinstance(existing, dict):
            legacy_library = existing
    # 2) 旧 ui / 桌面歌词文件先读入内存（此时还没动新文件，安全）
    legacy_ui: dict = {}
    if UI_SETTINGS_FILE.exists():
        try:
            raw = json.loads(UI_SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                legacy_ui = raw
        except (OSError, json.JSONDecodeError):
            pass
    legacy_desktop: dict = {}
    if DESKTOP_LYRIC_FILE.exists():
        try:
            raw = json.loads(DESKTOP_LYRIC_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                legacy_desktop = raw
        except (OSError, json.JSONDecodeError):
            pass
    # 3) 无任何旧数据 → 不写文件（保持默认）
    if not legacy_library and not legacy_ui and not legacy_desktop:
        return
    # 4) 组装新结构：默认值 + 旧数据（library 全量字段；ui 只迁 theme/miniTheme；desktopLyric 全量）
    merged = {ns: _norm_namespace(ns, {}) for ns in _SETTINGS_NAMESPACES}
    merged["library"] = _norm_namespace("library", legacy_library)
    merged["ui"] = _norm_namespace(
        "ui", {k: v for k, v in legacy_ui.items() if k in ("theme", "miniTheme")}
    )
    merged["desktopLyric"] = _norm_namespace("desktopLyric", legacy_desktop)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        return
    _settings = merged


# ============ 兼容层（旧函数名保留，内部操作统一存储；现有调用方零改动）============
def load_settings() -> dict:
    """读取音乐库设置（library namespace；内存缓存 + 默认值合并）"""
    return dict(load_all_settings()["library"])


def _normalize_setting(key: str, value):
    """按字段类型规范化设置值，非法值回落默认（library namespace 校验入口）"""
    spec = _SETTINGS_SPEC["library"]
    if key not in spec:
        return value
    default, norm = spec[key]
    return norm(value, default)


def save_settings(patch: dict) -> dict:
    """合并保存音乐库设置到统一存储并更新内存缓存（返回规范化后的完整 library 设置）"""
    return dict(save_all_settings({"library": patch})["library"])


def load_ui_settings() -> dict:
    """读取界面设置（ui namespace：前端 8 字段；主窗口与迷你窗跨引擎共享）"""
    return dict(load_all_settings()["ui"])


def save_ui_settings(patch: dict) -> dict:
    """合并保存界面设置到统一存储（PUT 现在可接受全部 8 个 ui 字段）"""
    return dict(save_all_settings({"ui": patch})["ui"])


def load_desktop_lyric_settings() -> dict:
    """读取桌面歌词设置（desktopLyric namespace；主播放器与悬浮窗跨引擎共享）"""
    return dict(load_all_settings()["desktopLyric"])


def save_desktop_lyric_settings(patch: dict) -> dict:
    """合并保存桌面歌词设置到统一存储"""
    return dict(save_all_settings({"desktopLyric": patch})["desktopLyric"])


# ============ 歌曲库扫描 ============
def _full_scan():
    """全量扫描歌曲库（无缓存），返回歌曲列表（含封面/歌词路径）"""
    settings = load_settings()
    exts = set(settings["audioExts"])
    ignore_hidden = settings["ignoreHidden"]
    songs = []
    if not LIBRARY.is_dir():
        return songs
    for f in sorted(LIBRARY.rglob("*")):
        if not f.is_file():
            continue
        try:
            rel = f.relative_to(LIBRARY)
        except ValueError:
            rel = Path(f.name)
        if f.suffix.lower() not in exts:
            continue
        if ignore_hidden and any(part.startswith(".") for part in rel.parts):
            continue
        # 找歌词（优先同名 srt/lrc，其次文件夹内唯一歌词文件）
        lyric = None
        for lext in (".srt", ".lrc"):
            cand = f.with_suffix(lext)
            if cand.exists():
                lyric = cand.name
                break
        if lyric is None:
            siblings = [x for x in f.parent.iterdir() if x.suffix.lower() in LYRIC_EXTS]
            if len(siblings) == 1:
                lyric = siblings[0].name
        # 找封面图片（cover.jpg / folder.jpg / 同名.jpg，其次文件夹内唯一图片）
        cover = None
        for cname in ("cover.jpg", "cover.png", "folder.jpg", "front.jpg"):
            cand = f.parent / cname
            if cand.exists():
                cover = cand.name
                break
        if cover is None:
            imgs = [
                x
                for x in f.parent.iterdir()
                if x.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
            ]
            if len(imgs) == 1:
                cover = imgs[0].name
        # id 用相对歌曲库的路径（歌曲库可能在 backend 目录之外，不能 relative_to(ROOT)）
        # 提取 ID3 元数据（歌手/标题/专辑），没有就用文件名
        artist, title, album = extract_tags(f)
        songs.append(
            {
                "id": str(rel),
                "path": str(f),
                "name": title or f.stem,
                "artist": artist or (f.parent.name if f.parent != LIBRARY else ""),
                "album": album or "",
                "folder": str(f.parent),
                "ext": f.suffix.lower().lstrip("."),
                "lyric": lyric,
                "cover": cover,
                "has_lyric": lyric is not None,
                "duration": get_duration(f),
            }
        )
    return songs


def scan_library():
    """扫描歌曲库，带缓存（库路径变化自动失效）；变动由 watchdog 重扫后刷新"""
    global _scan_cache
    with _scan_lock:
        if _scan_cache is not None and _scan_cache.get("library") == str(LIBRARY):
            return _scan_cache["songs"]
        songs = _full_scan()
        _scan_cache = {"library": str(LIBRARY), "songs": songs}
        return songs


def _rescan():
    """库变动后全量重扫 + 版本号递增（watchdog 去抖触发，带锁防并发）"""
    global _scan_cache, _scan_version
    with _scan_lock:
        songs = _full_scan()
        _scan_cache = {"library": str(LIBRARY), "songs": songs}
        _scan_version += 1


class _LibraryHandler(FileSystemEventHandler):
    """监听歌曲库变动：目录自身的 modified 事件太多（iCloud 同步），跳过；其余去抖后重扫"""

    def on_any_event(self, event):
        if event.is_directory and event.event_type == "modified":
            return
        _schedule_rescan()


def _schedule_rescan():
    """合并去抖：窗口内多次事件只触发一次重扫"""
    global _watch_timer
    with _scan_lock:
        if _watch_timer is not None:
            _watch_timer.cancel()
        _watch_timer = threading.Timer(WATCH_DEBOUNCE_SECONDS, _rescan)
        _watch_timer.daemon = True
        _watch_timer.start()


def start_watcher():
    """启动歌曲库 watchdog（幂等；设置关闭自动刷新或库目录不存在时跳过）"""
    global _watch_observer
    if _watch_observer is not None or not LIBRARY.is_dir():
        return
    if not load_settings()["autoRefresh"]:
        return
    _watch_observer = Observer()
    _watch_observer.daemon = True
    _watch_observer.schedule(_LibraryHandler(), str(LIBRARY), recursive=True)
    _watch_observer.start()


def stop_watcher():
    """停止 watchdog（切换歌曲库时调用）"""
    global _watch_observer, _watch_timer
    with _scan_lock:
        if _watch_timer is not None:
            _watch_timer.cancel()
            _watch_timer = None
    if _watch_observer is not None:
        _watch_observer.stop()
        _watch_observer.join(timeout=3)
        _watch_observer = None


def init_library():
    """启动时按设置初始化：旧三文件一次性迁移 + 预热扫描 + 按需启动 watchdog"""
    migrate_legacy_settings()
    settings = load_settings()
    if settings["autoScanOnStart"]:
        scan_library()
    if settings["autoRefresh"]:
        start_watcher()


def get_duration(f: Path):
    """读取音频时长（秒）；无法读取返回 None（mutagen 不可用/文件损坏）"""
    if MutagenFile is None:
        return None
    try:
        audio = MutagenFile(str(f))
        if audio is None or audio.info is None:
            return None
        d = getattr(audio.info, "length", None)
        return round(float(d), 1) if d else None
    except Exception:
        return None


def _load_favorites() -> list[str]:
    """加载收藏歌曲路径列表（文件不存在/损坏返回空）"""
    try:
        data = json.loads(FAVORITES_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_favorites(paths: list[str]):
    """保存收藏列表（写失败不影响播放功能）"""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        FAVORITES_FILE.write_text(json.dumps(paths, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


@app.get("/api/favorites")
def api_favorites():
    return {"paths": _load_favorites()}


@app.post("/api/favorites/toggle")
async def api_favorites_toggle(body: dict):
    """切换收藏：path 在列表中则移除，否则添加"""
    path = str(body.get("path", ""))
    if not path:
        raise HTTPException(400, "缺少 path")
    paths = _load_favorites()
    if path in paths:
        paths.remove(path)
        favorited = False
    else:
        paths.append(path)
        favorited = True
    _save_favorites(paths)
    return {"path": path, "favorited": favorited}


# ============ 歌单（持久化 ~/Library/Application Support/qqplayer/playlists.json）============


def _load_playlists() -> list[dict]:
    """加载歌单列表（文件不存在/损坏返回空）"""
    try:
        data = json.loads(PLAYLISTS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_playlists(playlists: list[dict]):
    """保存歌单列表（写失败不影响播放功能）"""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PLAYLISTS_FILE.write_text(
            json.dumps(playlists, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass


def _find_playlist(playlists: list[dict], pid: str) -> dict | None:
    for p in playlists:
        if p.get("id") == pid:
            return p
    return None


@app.get("/api/playlists")
def api_playlists():
    """全部歌单（按创建顺序）"""
    return {"playlists": _load_playlists()}


@app.post("/api/playlists")
def api_playlists_create(body: dict):
    """新建歌单"""
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "歌单名称不能为空")
    now = datetime.now(timezone.utc).isoformat()
    playlist = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "songPaths": [],
        "createdAt": now,
        "updatedAt": now,
    }
    playlists = _load_playlists()
    playlists.append(playlist)
    _save_playlists(playlists)
    return playlist


@app.patch("/api/playlists/{pid}")
def api_playlists_rename(pid: str, body: dict):
    """歌单改名"""
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "歌单名称不能为空")
    playlists = _load_playlists()
    p = _find_playlist(playlists, pid)
    if p is None:
        raise HTTPException(404, "歌单不存在")
    p["name"] = name
    p["updatedAt"] = datetime.now(timezone.utc).isoformat()
    _save_playlists(playlists)
    return p


@app.delete("/api/playlists/{pid}")
def api_playlists_delete(pid: str):
    """删除歌单"""
    playlists = _load_playlists()
    before = len(playlists)
    playlists = [p for p in playlists if p.get("id") != pid]
    if len(playlists) == before:
        raise HTTPException(404, "歌单不存在")
    _save_playlists(playlists)
    return {"ok": True}


@app.post("/api/playlists/{pid}/songs")
def api_playlists_add_song(pid: str, body: dict):
    """往歌单加一首歌（自动去重）"""
    path = str(body.get("path", "")).strip()
    if not path:
        raise HTTPException(400, "缺少 path")
    playlists = _load_playlists()
    p = _find_playlist(playlists, pid)
    if p is None:
        raise HTTPException(404, "歌单不存在")
    paths = p.setdefault("songPaths", [])
    if path not in paths:
        paths.append(path)
        p["updatedAt"] = datetime.now(timezone.utc).isoformat()
        _save_playlists(playlists)
    return p


@app.delete("/api/playlists/{pid}/songs/{path:path}")
def api_playlists_remove_song(pid: str, path: str):
    """从歌单移除一首歌"""
    playlists = _load_playlists()
    p = _find_playlist(playlists, pid)
    if p is None:
        raise HTTPException(404, "歌单不存在")
    paths = p.setdefault("songPaths", [])
    if path in paths:
        paths.remove(path)
        p["updatedAt"] = datetime.now(timezone.utc).isoformat()
        _save_playlists(playlists)
    return p


@app.put("/api/playlists/{pid}/order")
def api_playlists_order(pid: str, body: dict):
    """拖拽排序：按 paths 数组重排歌单内歌曲（只重排已存在的，防止丢歌）"""
    paths = body.get("paths")
    if not isinstance(paths, list):
        raise HTTPException(400, "缺少 paths 数组")
    playlists = _load_playlists()
    p = _find_playlist(playlists, pid)
    if p is None:
        raise HTTPException(404, "歌单不存在")
    existing = p.get("songPaths", [])
    ordered = [x for x in paths if x in existing]
    for x in existing:  # 不在新顺序里的原歌曲补在末尾，不丢失
        if x not in ordered:
            ordered.append(x)
    p["songPaths"] = ordered
    p["updatedAt"] = datetime.now(timezone.utc).isoformat()
    _save_playlists(playlists)
    return p


# ============ 播放记录（完整历史，append-only + 滚动截断）============

# 写锁：避免并发上报时读改写竞争丢数据
_playback_lock = threading.Lock()


def _load_playback() -> list[dict]:
    """加载全部播放记录（文件不存在/损坏返回空）"""
    try:
        data = json.loads(PLAYBACK_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_playback(records: list[dict]):
    """保存播放记录（写失败不影响播放功能）"""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PLAYBACK_FILE.write_text(
            json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass


def _append_playback(record: dict):
    """追加一条播放记录；超过 PLAYBACK_LIMIT 时删最旧"""
    with _playback_lock:
        records = _load_playback()
        records.append(record)
        if len(records) > PLAYBACK_LIMIT:
            records = records[-PLAYBACK_LIMIT:]
        _save_playback(records)


def _playback_record(body: dict) -> dict | None:
    """校验并规整一条播放记录；非法/误触（< PLAYBACK_MIN_SECONDS）返回 None"""
    path = str(body.get("path", "")).strip()
    played = float(body.get("played", 0) or 0)
    if not path or played < PLAYBACK_MIN_SECONDS:
        return None
    try:
        duration = float(body.get("duration", 0) or 0)
        ratio = float(body.get("ratio", 0) or 0)
    except (TypeError, ValueError):
        duration, ratio = 0.0, 0.0
    record = {
        "ts": body.get("ts") or datetime.now(timezone.utc).isoformat(),
        "path": path,
        "name": str(body.get("name", "") or ""),
        "artist": str(body.get("artist", "") or ""),
        "album": str(body.get("album", "") or ""),
        "played": round(played, 1),
        "duration": round(duration, 1),
        "ratio": round(ratio, 4),
        "completed": bool(body.get("completed", False)),
        "source": str(body.get("source", "manual") or "manual"),
        "mode": str(body.get("mode", "continuous") or "continuous"),
        "device": str(body.get("device", "") or ""),
    }
    return record


@app.post("/api/playback")
async def api_playback(body: dict):
    """上报一条播放记录（切歌/暂停/播完时前端调用）"""
    record = _playback_record(body)
    if record is None:
        return {"ok": False, "reason": "invalid"}
    _append_playback(record)
    return {"ok": True}


@app.post("/api/now-playing")
def api_now_playing_post(body: dict):
    """主页面状态上报（桌面歌词/迷你窗轮询读取；迷你窗控制靠 /api/player/action 队列）"""
    with _now_playing_lock:
        _now_playing["path"] = str(body.get("path") or "") or None
        _now_playing["name"] = str(body.get("name") or "") or None
        _now_playing["artist"] = str(body.get("artist") or "") or None
        _now_playing["duration"] = float(body.get("duration") or 0) or 0.0
        _now_playing["currentTime"] = float(body.get("currentTime") or 0) or 0.0
        _now_playing["isPlaying"] = bool(body.get("isPlaying"))
        _now_playing["volume"] = (
            float(body.get("volume") if body.get("volume") is not None else 1.0) or 0.0
        )
        _now_playing["lineIndex"] = int(body.get("lineIndex") or -1)
        _now_playing["accent"] = str(body.get("accent") or "") or None  # 强调色（跟随主题配色用）
        _now_playing["updatedAt"] = time.time()
    return {"ok": True}


@app.post("/api/player/action")
def api_player_action_post(body: dict):
    """迷你窗控制指令入队（主播放器页面轮询 /api/player/actions 取走执行）"""
    action = str(body.get("action") or "")
    if action not in _PLAYER_ACTIONS:
        return {"ok": False, "reason": "unknown_action"}
    value = body.get("value")
    if action in ("seek", "volume") and not isinstance(value, (int, float)):
        return {"ok": False, "reason": "value_required"}
    if action == "seek":
        value = max(0.0, float(value))
    if action == "volume":
        value = min(1.0, max(0.0, float(value)))
    with _player_actions_lock:
        _player_actions.append({"action": action, "value": value})
    return {"ok": True}


@app.get("/api/player/actions")
def api_player_actions_get():
    """主播放器页面轮询：取走并清空全部待执行指令"""
    with _player_actions_lock:
        actions = list(_player_actions)
        _player_actions.clear()
    return {"actions": actions}


@app.post("/api/mini/status")
def api_mini_status_post(body: dict):
    """迷你窗 Swift 壳上报运行状态（启动 running=true，退出 running=false）"""
    running = body.get("running")
    if not isinstance(running, bool):
        return {"ok": False, "reason": "running_required"}
    with _mini_status_lock:
        _mini_status["running"] = running
    return {"ok": True}


@app.get("/api/mini/status")
def api_mini_status_get():
    """迷你窗当前是否在运行（主页面顶栏开关轮询点亮）"""
    with _mini_status_lock:
        return dict(_mini_status)


@app.get("/api/now-playing")
def api_now_playing_get():
    """返回当前播放状态（悬浮窗 500ms 轮询）"""
    with _now_playing_lock:
        return dict(_now_playing)


@app.get("/api/settings")
def api_settings_get():
    """返回统一设置：6 namespace 全量（每 namespace 合并默认值后返回）"""
    return {"settings": load_all_settings()}


@app.put("/api/settings")
def api_settings_put(body: dict):
    """部分更新统一设置（namespace→字段两级深合并，只改传入字段），返回合并后全量"""
    return {"settings": save_all_settings(body or {})}


@app.get("/api/desktop-lyric/settings")
def api_desktop_lyric_settings_get():
    """返回桌面歌词设置（主播放器与悬浮窗跨引擎共享，存后端）"""
    return {"settings": load_desktop_lyric_settings()}


@app.put("/api/desktop-lyric/settings")
def api_desktop_lyric_settings_put(body: dict):
    """保存桌面歌词设置（主播放器修改时调用）"""
    return {"settings": save_desktop_lyric_settings(body or {})}


@app.get("/api/ui/settings")
def api_ui_settings_get():
    """返回主题设置（迷你窗轮询读取：主题 + 迷你窗外观）"""
    return {"settings": load_ui_settings()}


@app.put("/api/ui/settings")
def api_ui_settings_put(body: dict):
    """保存主题设置（主播放器修改时调用，防抖同步）"""
    return {"settings": save_ui_settings(body or {})}


@app.get("/api/playback")
def api_playback_list():
    """返回全部播放记录（按时间倒序，最新在前）"""
    records = _load_playback()
    records.sort(key=lambda r: r.get("ts", ""), reverse=True)
    return {"records": records, "count": len(records), "limit": PLAYBACK_LIMIT}


@app.get("/api/playback/stats")
def api_playback_stats():
    """播放统计聚合：每首歌的播放次数/最近播放/总时长/完成度（喂每日三首推荐）"""
    stats: dict[str, dict] = {}
    for r in _load_playback():
        path = r.get("path", "")
        s = stats.setdefault(
            path,
            {
                "path": path,
                "name": r.get("name", ""),
                "artist": r.get("artist", ""),
                "album": r.get("album", ""),
                "plays": 0,
                "totalPlayed": 0.0,
                "lastPlayed": "",
                "completed": 0,
            },
        )
        s["plays"] += 1
        s["totalPlayed"] = round(s["totalPlayed"] + r.get("played", 0), 1)
        if r.get("completed"):
            s["completed"] += 1
        ts = r.get("ts", "")
        if ts > s["lastPlayed"]:
            s["lastPlayed"] = ts
    songs = sorted(stats.values(), key=lambda s: s["lastPlayed"], reverse=True)
    return {"count": len(songs), "songs": songs}


@app.get("/api/songs")
def api_songs():
    return scan_library()


@app.get("/api/library")
def api_library():
    """返回当前歌曲库路径"""
    return {"path": str(LIBRARY)}


@app.get("/api/library/version")
def api_library_version():
    """返回歌曲库变动版本号（前端轮询此值判断是否需要刷新列表）"""
    return {"version": _scan_version}


@app.get("/api/library/settings")
def api_library_settings():
    """返回音乐库设置（文件类型多选 / 忽略隐藏 / 自动刷新 / 启动自动扫描）"""
    return {"settings": load_settings()}


@app.put("/api/library/settings")
def api_update_library_settings(body: dict):
    """保存音乐库设置；扫描相关项变化时清缓存重扫，自动刷新开关变化时启停 watchdog"""
    global _scan_cache, _scan_version
    old = load_settings()
    new = save_settings(body)
    if new["audioExts"] != old["audioExts"] or new["ignoreHidden"] != old["ignoreHidden"]:
        with _scan_lock:
            _scan_cache = None
            _scan_version += 1
    if new["autoRefresh"] != old["autoRefresh"]:
        if new["autoRefresh"]:
            start_watcher()
        else:
            stop_watcher()
    return {"settings": new, "count": len(scan_library())}


@app.post("/api/library")
async def api_set_library(body: dict):
    """设置歌曲库文件夹（切换后清缓存并重启监听）"""
    global LIBRARY, _scan_cache, _scan_version
    p = Path(body.get("path", ""))
    if not p.is_dir():
        raise HTTPException(400, f"目录不存在: {p}")
    stop_watcher()
    LIBRARY = p
    with _scan_lock:
        _scan_cache = None
        _scan_version += 1
    start_watcher()
    return {"path": str(LIBRARY), "count": len(scan_library())}


def extract_tags(f: Path):
    """提取音频文件的标题/歌手/专辑（ID3 / MP4 元数据）"""
    if MutagenFile is None:
        return None, None, None
    try:
        audio = MutagenFile(str(f))
        if audio is None:
            return None, None, None
        tags = getattr(audio, "tags", None)
        title = artist = album = None
        if tags is not None:
            for key in tags:
                k = key.lower()
                if k in ("tpe1", "©art", "aart", "artist") and artist is None:
                    artist = str(tags[key]).split("\x00")[0].strip()
                elif k in ("tit2", "©nam", "title") and title is None:
                    title = str(tags[key]).split("\x00")[0].strip()
                elif k in ("talb", "©alb", "album") and album is None:
                    album = str(tags[key]).split("\x00")[0].strip()
        return artist or None, title or None, album or None
    except Exception:
        return None, None, None


# ============ 封面 ============
@app.get("/api/cover")
def api_cover(path: str):
    """提取音频内嵌封面；无内嵌封面时返回文件夹 cover.jpg"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    # 1) 文件夹封面图片
    for cname in ("cover.jpg", "cover.png", "folder.jpg", "front.jpg"):
        cand = f.parent / cname
        if cand.exists():
            return FileResponse(cand)
    # 2) 内嵌封面
    if MutagenFile is not None:
        try:
            audio = MutagenFile(str(f))
            if audio is not None:
                # MP3: ID3 APIC
                tags = getattr(audio, "tags", None)
                if tags is not None:
                    for key in tags:
                        if key.startswith("APIC"):
                            apic = tags[key]
                            return Response(content=apic.data, media_type=apic.mime)
                # MP4: covr
                if isinstance(audio, MP4) and "covr" in audio:
                    cov = audio["covr"][0]
                    data = bytes(cov)
                    mime = (
                        "image/jpeg"
                        if isinstance(cov, MP4Cover) and cov.imageformat == MP4Cover.FORMAT_JPEG
                        else "image/png"
                    )
                    return Response(content=data, media_type=mime)
        except Exception:
            pass
    raise HTTPException(404, "无封面")


# ============ 歌词 ============
def parse_srt(text: str):
    """解析 srt -> 段落/句子混合列表
    块内以 # 开头的行作为段落标题（type: sec），时间行后的文本作为句子（type: line）
    句子文本支持 1~3 行：原文 / 罗马音 / 中文
    """
    blocks = re.split(r"\n\s*\n", text.replace("\r", ""))
    result = []
    for block in blocks:
        lines = [x.strip() for x in block.split("\n") if x.strip()]
        if not lines:
            continue
        # 分离块内标题行和内容行（即使标题和句子粘在同一块也能拆开）
        sec_lines = [x for x in lines if x.startswith("#") and "-->" not in x]
        content = [x for x in lines if not (x.startswith("#") and "-->" not in x)]
        for sl in sec_lines:
            result.append({"type": "sec", "name": sl.lstrip("#").strip()})
        if not content:
            continue
        time_idx = -1
        for i, ln in enumerate(content):
            if "-->" in ln:
                time_idx = i
                break
        if time_idx < 0:
            continue
        m = re.match(
            r"(\d{1,2}):(\d{2}):(\d{2})[,.]?(\d{0,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.]?(\d{0,3})",
            content[time_idx],
        )
        if not m:
            continue

        def sec(h, mm, s, ms):
            return int(h) * 3600 + int(mm) * 60 + int(s) + int(ms or 0) / 1000

        result.append(
            {
                "type": "line",
                "s": sec(m[1], m[2], m[3], m[4]),
                "e": sec(m[5], m[6], m[7], m[8]),
                "text": content[time_idx + 1 :],
            }
        )
    return result


def parse_lrc(text: str):
    """解析 lrc -> 句子列表（无段落，type 统一为 line）"""
    result = []
    pattern = re.compile(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]")
    items = []
    for line in text.replace("\r", "").split("\n"):
        matches = list(pattern.finditer(line))
        if not matches:
            continue
        lyric_text = line[matches[-1].end() :].strip()
        for m in matches:
            ms = m.group(3) or "0"
            ms = int(ms) * (10 ** (3 - len(ms)))
            t = int(m.group(1)) * 60 + int(m.group(2)) + ms / 1000
            items.append((t, lyric_text))
    items.sort(key=lambda x: x[0])
    for i, (t, txt) in enumerate(items):
        e = items[i + 1][0] if i + 1 < len(items) else t + 5
        result.append({"type": "line", "s": t, "e": e, "text": [txt]})
    return result


def merge_translation(lines: list, tlyric_text: str | None):
    """把网易云中文翻译（tlyric LRC）按时间戳合并进主歌词行
    约定 text = [原文, 罗马音(空), 中文翻译]（与前端 KaraokePanel/LyricPanel 渲染位一致）
    """
    if not tlyric_text:
        return lines
    tlines = [t for t in parse_lrc(tlyric_text) if t.get("text")]
    if not tlines:
        return lines
    result = []
    for ln in lines:
        if ln["type"] == "line":
            for t in tlines:
                if abs(t["s"] - ln["s"]) <= 0.6:
                    ln = {**ln, "text": [ln["text"][0], "", t["text"][0]]}
                    break
        result.append(ln)
    return result


@app.get("/api/lyric")
def api_lyric(path: str, prefer: str = "local"):
    """加载歌曲歌词：手动指定 > 本地 srt/lrc > 在线获取（网易云→lrclib，缓存 ~/.cache）。

    prefer=online 时在线优先（在线获取失败自动回退本地）。手动指定始终最高优先级。
    """
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")

    # 0. 用户手动指定歌词（最高优先级，不受 prefer 影响）
    manual = load_manual_lyric(str(f))
    if manual is not None:
        data = parse_srt(manual["text"]) if manual["format"] == "srt" else parse_lrc(manual["text"])
        if data:
            if manual.get("tlyric"):
                data = merge_translation(data, manual["tlyric"])
            return {"format": manual["format"], "lines": data, "source": "manual"}
        # 手动指定内容解析不出行：当作没指定，继续走自动链路（不删除，弹窗里可改）

    def local_lyric():
        """返回 (format, lines) 或 None"""
        cand = None
        for lext in ("srt", "lrc"):
            c = f.with_suffix("." + lext)
            if c.exists():
                cand = c
                break
        if cand is None:
            # 文件夹内唯一歌词
            siblings = [x for x in f.parent.iterdir() if x.suffix.lower() in LYRIC_EXTS]
            if len(siblings) == 1:
                cand = siblings[0]
        if cand is None:
            return None
        text = cand.read_text(encoding="utf-8", errors="ignore")
        lext = cand.suffix.lower().lstrip(".")
        data = parse_srt(text) if lext == "srt" else parse_lrc(text)
        return (lext, data)

    def online_lyric():
        """返回 (format, lines, source) 或 None"""
        artist, title, _album = extract_tags(f)
        title = title or f.stem
        lrc_text, tlyric_text, source = fetch_online_lyric(title, artist or "")
        if lrc_text is None:
            return None
        lines = merge_translation(parse_lrc(lrc_text), tlyric_text)
        return ("lrc", lines, source)

    prefer = prefer if prefer in ("local", "online") else "local"
    if prefer == "online":
        res = online_lyric()
        if res is not None:
            return {"format": res[0], "lines": res[1], "source": res[2]}
        res = local_lyric()
        if res is not None:
            return {"format": res[0], "lines": res[1], "source": "local"}
        raise HTTPException(404, "无歌词文件")
    # 默认：本地优先
    res = local_lyric()
    if res is not None:
        return {"format": res[0], "lines": res[1], "source": "local"}
    res = online_lyric()
    if res is not None:
        return {"format": res[0], "lines": res[1], "source": res[2]}
    raise HTTPException(404, "无歌词文件")


# ============ 手动指定歌词 ============
@app.get("/api/lyric/manual")
def api_lyric_manual_get(path: str):
    """查询歌曲是否有手动指定歌词"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    manual = load_manual_lyric(str(f))
    if manual is None:
        return {"specified": False}
    return {"specified": True, **manual}


@app.put("/api/lyric/manual")
def api_lyric_manual_put(body: dict):
    """保存手动指定歌词（上传文件/在线选择/粘贴文本统一走这里，覆盖旧值）

    tlyric 可选：中文翻译 LRC（JSON 歌词上传时携带），/api/lyric 返回时合并进歌词行。
    """
    path = (body.get("path") or "").strip()
    fmt = body.get("format") or "lrc"
    text = body.get("text") or ""
    source = body.get("source") or ""
    tlyric = body.get("tlyric") or None
    if not path:
        raise HTTPException(400, "缺少歌曲路径")
    if not text.strip():
        raise HTTPException(400, "歌词内容为空")
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    fmt = fmt if fmt in ("lrc", "srt") else "lrc"
    # 内容校验：必须能解析出歌词行，避免存了不可用的内容
    lines = parse_srt(text) if fmt == "srt" else parse_lrc(text)
    if not lines:
        raise HTTPException(
            400, "歌词内容解析失败，请检查格式（LRC 需 [mm:ss] 时间戳，SRT 需序号+时间轴）"
        )
    payload = save_manual_lyric(str(f), fmt, text, source, tlyric)
    return {"ok": True, **payload}


@app.delete("/api/lyric/manual")
def api_lyric_manual_delete(path: str):
    """清除手动指定歌词，恢复自动获取"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    removed = delete_manual_lyric(str(f))
    return {"ok": True, "removed": removed}


@app.get("/api/lyric/search")
def api_lyric_search(title: str = "", artist: str = ""):
    """多源搜索歌词候选（网易云 + lrclib），供用户手动挑选"""
    title = (title or "").strip()
    if not title:
        raise HTTPException(400, "缺少搜索关键词")
    return {"results": search_lyric_candidates(title, artist or "")}


# ============ 音频流（支持 Range） ============
@app.get("/api/audio")
def api_audio(path: str):
    """音频流播放（FileResponse 原生支持 Range/206）"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    return FileResponse(str(f), media_type="audio/mpeg")


# ============ 静态前端 ============
if (ROOT / "dist").is_dir():
    app.mount("/", StaticFiles(directory=str(ROOT / "dist"), html=True), name="frontend")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        LIBRARY = Path(sys.argv[1])
    init_library()
    url = f"http://localhost:{DEFAULT_PORT}"
    print(f"🎵 music-player 已启动: {url}")
    print(f"   歌曲库: {LIBRARY}")
    if load_settings()["autoRefresh"]:
        print(f"   📁 监听歌曲库变动（去抖 {WATCH_DEBOUNCE_SECONDS}s，自动刷新列表）")
    else:
        print("   📁 自动刷新已关闭（设置里可开启）")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="0.0.0.0", port=DEFAULT_PORT, log_level="warning")
