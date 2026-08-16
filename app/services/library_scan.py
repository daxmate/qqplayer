"""歌曲库扫描服务：全量扫描/缓存/重扫/去抖/watchdog 监听/启动初始化/时长读取。

所有可变状态（LIBRARY/_scan_cache/_scan_version/_scan_lock/_watch_timer/_watch_observer/
WATCH_DEBOUNCE_SECONDS 等）走 app.state 模块访问，测试 patch state.XXX 后生效。
"""

import asyncio
import threading
from datetime import datetime, timedelta
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from app import state
from app.services import settings, tags
from lyric_fetch import cleanup_orphan_manual_lyrics

try:
    from mutagen import File as MutagenFile
except ImportError:
    MutagenFile = None


def _full_scan():
    """全量扫描歌曲库（无缓存），返回歌曲列表（含封面/歌词路径）"""
    s = settings.load_settings()
    exts = set(s["audioExts"])
    ignore_hidden = s["ignoreHidden"]
    songs = []
    if not state.LIBRARY.is_dir():
        return songs
    for f in sorted(state.LIBRARY.rglob("*")):
        if not f.is_file():
            continue
        try:
            rel = f.relative_to(state.LIBRARY)
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
            siblings = [x for x in f.parent.iterdir() if x.suffix.lower() in state.LYRIC_EXTS]
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
        artist, title, album = tags.extract_tags(f)
        # 最近添加排序用：添加时间（macOS birthtime；跨平台 fallback 文件 mtime），毫秒整数
        st = f.stat()
        mtime_ms = int((getattr(st, "st_birthtime", None) or st.st_mtime) * 1000)
        songs.append(
            {
                "id": str(rel),
                "path": str(f),
                "name": title or f.stem,
                "artist": artist or (f.parent.name if f.parent != state.LIBRARY else ""),
                "album": album or "",
                "folder": str(f.parent),
                "ext": f.suffix.lower().lstrip("."),
                "lyric": lyric,
                "cover": cover,
                "has_lyric": lyric is not None,
                "duration": get_duration(f),
                "mtime": mtime_ms,  # 毫秒时间戳；本地歌=birthtime/mtime，网络歌=添加时刻
            }
        )
    return songs


def scan_library():
    """扫描歌曲库，带缓存（库路径变化自动失效）；变动由 watchdog 重扫后刷新"""
    with state._scan_lock:
        if state._scan_cache is not None and state._scan_cache.get("library") == str(state.LIBRARY):
            return state._scan_cache["songs"]
        songs = _full_scan()
        state._scan_cache = {"library": str(state.LIBRARY), "songs": songs}
        return songs


def _rescan():
    """库变动后全量重扫 + 版本号递增（watchdog 去抖触发，带锁防并发）"""
    with state._scan_lock:
        songs = _full_scan()
        state._scan_cache = {"library": str(state.LIBRARY), "songs": songs}
        state._scan_version += 1


class _LibraryHandler(FileSystemEventHandler):
    """监听歌曲库变动：目录自身的 modified 事件太多（iCloud 同步），跳过；其余去抖后重扫"""

    def on_any_event(self, event):
        if event.is_directory and event.event_type == "modified":
            return
        _schedule_rescan()


def _schedule_rescan():
    """合并去抖：窗口内多次事件只触发一次重扫"""
    with state._scan_lock:
        if state._watch_timer is not None:
            state._watch_timer.cancel()
        state._watch_timer = threading.Timer(state.WATCH_DEBOUNCE_SECONDS, _rescan)
        state._watch_timer.daemon = True
        state._watch_timer.start()


def start_watcher():
    """启动歌曲库 watchdog（幂等；设置关闭自动刷新或库目录不存在时跳过）"""
    if state._watch_observer is not None or not state.LIBRARY.is_dir():
        return
    if not settings.load_settings()["autoRefresh"]:
        return
    state._watch_observer = Observer()
    state._watch_observer.daemon = True
    state._watch_observer.schedule(_LibraryHandler(), str(state.LIBRARY), recursive=True)
    state._watch_observer.start()


def stop_watcher():
    """停止 watchdog（切换歌曲库时调用）"""
    with state._scan_lock:
        if state._watch_timer is not None:
            state._watch_timer.cancel()
            state._watch_timer = None
    if state._watch_observer is not None:
        state._watch_observer.stop()
        state._watch_observer.join(timeout=3)
        state._watch_observer = None


def init_library():
    """启动时按设置初始化：旧三文件一次性迁移 + 预热扫描 + 按需启动 watchdog"""
    settings.migrate_legacy_settings()
    s = settings.load_settings()
    if s["autoScanOnStart"]:
        scan_library()
    if s["autoRefresh"]:
        start_watcher()


async def _lyric_cleanup_loop():
    """周一轮询：每周一 03:00 清理孤儿手动歌词

    valid_paths = 当前曲库全部歌曲 path（复用扫描逻辑，尊重扩展名过滤/忽略隐藏设置）。
    首次执行 = 距离下一个周一 03:00 的秒数 sleep，之后循环再排下周一。
    清理失败不中断循环，下周一重试。
    """
    while True:
        now = datetime.now()
        days = (0 - now.weekday()) % 7  # 距下个周一的天数（周一当天为 0）
        if days == 0 and now.hour >= state.LYRIC_CLEANUP_HOUR:
            days = 7  # 已过周一 03:00，等下一个周一
        target = (now + timedelta(days=days)).replace(
            hour=state.LYRIC_CLEANUP_HOUR, minute=0, second=0, microsecond=0
        )
        await asyncio.sleep((target - now).total_seconds())
        try:
            paths = [s["path"] for s in _full_scan()]
            removed = cleanup_orphan_manual_lyrics(paths)
            print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] 孤儿歌词清理完成: 删除 {removed} 个文件")
        except Exception as e:
            print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] 孤儿歌词清理失败: {e}")


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
