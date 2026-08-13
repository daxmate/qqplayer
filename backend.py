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
DESKTOP_LYRIC_FILE = DATA_DIR / "desktop_lyric.json"
# 播放记录滚动保留上限（超了删最旧）
PLAYBACK_LIMIT = 5000
# 播放时长少于该秒数视为误触，不记录
PLAYBACK_MIN_SECONDS = 3
# 桌面歌词悬浮窗：主页面句切换时上报，悬浮窗轮询读取（内存态，不持久化）
_now_playing: dict = {"path": None, "lineIndex": -1, "updatedAt": 0.0}
_now_playing_lock = threading.Lock()
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

# 音乐库设置（持久化到用户数据目录 settings.json）
LIBRARY_SETTINGS_DEFAULTS = {
    "audioExts": DEFAULT_AUDIO_EXTS,
    "ignoreHidden": True,  # 忽略隐藏文件/文件夹
    "autoRefresh": True,  # watchdog 自动刷新（库变动自动重扫）
    "autoScanOnStart": True,  # 启动时自动扫描歌曲库
}
SETTINGS_FILE = DATA_DIR / "settings.json"
_settings: dict | None = None


# ============ 音乐库设置 ============
def load_settings() -> dict:
    """读取音乐库设置（内存缓存；文件缺失/损坏时回落默认值）"""
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
    _settings = dict(LIBRARY_SETTINGS_DEFAULTS)
    for k in LIBRARY_SETTINGS_DEFAULTS:
        if k in data:
            _settings[k] = _normalize_setting(k, data[k])
    return _settings


def _normalize_setting(key: str, value):
    """按字段类型规范化设置值，非法值回落默认"""
    default = LIBRARY_SETTINGS_DEFAULTS[key]
    if key == "audioExts":
        if isinstance(value, list) and value:
            exts = [str(e).lower() for e in value if isinstance(e, str) and e.startswith(".")]
            if exts:
                return exts
        return default
    if isinstance(value, bool):
        return value
    return default


def save_settings(patch: dict) -> dict:
    """合并保存设置到磁盘并更新内存缓存（返回规范化后的完整设置）"""
    global _settings
    merged = dict(load_settings())
    for k in LIBRARY_SETTINGS_DEFAULTS:
        if k in patch:
            merged[k] = _normalize_setting(k, patch[k])
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    _settings = merged
    return merged


# ============ 桌面歌词设置（后端存储：主播放器 Vivaldi 与悬浮窗 WKWebView 跨引擎共享）============
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

_desktop_lyric: dict | None = None


def load_desktop_lyric_settings() -> dict:
    """读取桌面歌词设置（内存缓存；文件缺失/损坏时回落默认值）"""
    global _desktop_lyric
    if _desktop_lyric is not None:
        return _desktop_lyric
    data = {}
    try:
        if DESKTOP_LYRIC_FILE.exists():
            raw = json.loads(DESKTOP_LYRIC_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data = raw
    except (OSError, json.JSONDecodeError):
        data = {}
    merged = dict(DESKTOP_LYRIC_DEFAULTS)
    for k in DESKTOP_LYRIC_DEFAULTS:
        if k in data:
            v = data[k]
            if isinstance(v, (bool, str, int, float)):
                merged[k] = v
    _desktop_lyric = merged
    return merged


def save_desktop_lyric_settings(patch: dict) -> dict:
    """合并保存桌面歌词设置到磁盘并更新内存缓存"""
    global _desktop_lyric
    merged = dict(load_desktop_lyric_settings())
    for k in DESKTOP_LYRIC_DEFAULTS:
        if k in patch:
            merged[k] = patch[k]
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        DESKTOP_LYRIC_FILE.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    _desktop_lyric = merged
    return merged


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
    """启动时按设置初始化：预热扫描（autoScanOnStart）+ 按需启动 watchdog（autoRefresh）"""
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
    """主页面句切换时上报当前播放状态（供桌面歌词悬浮窗读取）"""
    with _now_playing_lock:
        _now_playing["path"] = str(body.get("path") or "") or None
        _now_playing["lineIndex"] = int(body.get("lineIndex") or -1)
        _now_playing["updatedAt"] = time.time()
    return {"ok": True}


@app.get("/api/now-playing")
def api_now_playing_get():
    """返回当前播放状态（悬浮窗 500ms 轮询）"""
    with _now_playing_lock:
        return dict(_now_playing)


@app.get("/api/desktop-lyric/settings")
def api_desktop_lyric_settings_get():
    """返回桌面歌词设置（主播放器与悬浮窗跨引擎共享，存后端）"""
    return {"settings": load_desktop_lyric_settings()}


@app.put("/api/desktop-lyric/settings")
def api_desktop_lyric_settings_put(body: dict):
    """保存桌面歌词设置（主播放器修改时调用）"""
    return {"settings": save_desktop_lyric_settings(body or {})}


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
        raise HTTPException(400, "歌词内容解析失败，请检查格式（LRC 需 [mm:ss] 时间戳，SRT 需序号+时间轴）")
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
    uvicorn.run(app, host="127.0.0.1", port=DEFAULT_PORT, log_level="warning")
