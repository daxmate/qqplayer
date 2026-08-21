#!/usr/bin/env python3
"""music-player 后端 API（薄兼容层：符号来自 app 包，测试 import backend 依赖）

用法: ./venv/bin/python backend.py [歌曲库路径]
"""

import contextlib
import subprocess  # 保留：测试 patch backend.subprocess
import sys
import threading
import webbrowser

# Windows 控制台默认 GBK/cp1252，emoji/非 ASCII 输出直接 UnicodeEncodeError
# （启动横幅 🎵 在 win 打包版实测崩溃，开发环境 GBK 控制台同样会炸）。
# 统一切 UTF-8 + errors=replace 兜底；macOS/Linux 不受影响。
if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            _stream.reconfigure(encoding="utf-8", errors="replace")

import httpx  # 保留：测试 patch backend.httpx（全局模块对象）

import tag_scraper  # 保留：测试 patch backend.tag_scraper
from app import state as _state
from app.main import app
from app.services.download import _sanitize_filename
from app.services.library_scan import (
    _full_scan,
    _LibraryHandler,
    _rescan,
    _schedule_rescan,
    get_duration,
    init_library,
    scan_library,
    start_watcher,
    stop_watcher,
)
from app.services.lyrics import _align_to_lrc, merge_translation, parse_lrc, parse_srt
from app.services.settings import (
    _SETTINGS_SPEC,
    load_all_settings,
    load_desktop_lyric_settings,
    load_settings,
    load_ui_settings,
    migrate_legacy_settings,
    save_all_settings,
    save_desktop_lyric_settings,
    save_settings,
    save_ui_settings,
)
from app.services.tags import extract_tags
from lyric_fetch import (
    auto_attach_translation,
    cleanup_orphan_manual_lyrics,
    delete_manual_lyric,
    fetch_online_lyric,
    load_manual_lyric,
    save_manual_lyric,
    search_lyric_candidates,
)

__all__ = [  # noqa: F822  （可变状态/常量经模块 __getattr__ 委托 app.state 提供）
    "app",
    "scan_library",
    "_settings",
    "LIBRARY",
    "_watch_timer",
    "SETTINGS_FILE",
    "save_settings",
    "extract_tags",
    "save_all_settings",
    "migrate_legacy_settings",
    "_scan_cache",
    "merge_translation",
    "load_all_settings",
    "_scan_lock",
    "_sanitize_filename",
    "_full_scan",
    "DEFAULT_AUDIO_EXTS",
    "start_watcher",
    "stop_watcher",
    "parse_srt",
    "load_settings",
    "init_library",
    "_watch_observer",
    "_rescan",
    "_now_playing_lock",
    "_now_playing",
    "UI_SETTINGS_FILE",
    "PLAYBACK_SETTINGS_DEFAULTS",
    "NETWORK_SONGS_FILE",
    "DESKTOP_LYRIC_FILE",
    "parse_lrc",
    "get_duration",
    "_schedule_rescan",
    "_SETTINGS_SPEC",
    "_LibraryHandler",
    "WATCH_DEBOUNCE_SECONDS",
    "LYRIC_SETTINGS_DEFAULTS",
    "DESKTOP_LYRIC_DEFAULTS",
    "ALIGN_MODEL_URL",
    "httpx",
    "subprocess",
    "tag_scraper",
    "sys",
    "threading",
    "webbrowser",
    # 兼容层额外 re-export（与旧 backend.py 一致）
    "auto_attach_translation",
    "cleanup_orphan_manual_lyrics",
    "delete_manual_lyric",
    "fetch_online_lyric",
    "load_manual_lyric",
    "save_manual_lyric",
    "search_lyric_candidates",
    "load_ui_settings",
    "save_ui_settings",
    "load_desktop_lyric_settings",
    "save_desktop_lyric_settings",
    "_align_to_lrc",
]


def __getattr__(name):
    """可变状态/路径常量读取委托 app.state 模块。

    测试 patch `app.state.XXX` 后 `backend.XXX` 读到的是当前值（不是 import 时固化值）。
    可变状态（LIBRARY/_settings/_scan_cache/_scan_version/_watch_timer/各 *_FILE 等）
    一律走这里，避免 from-import 绑定导致读到过期值。
    """
    try:
        return getattr(_state, name)
    except AttributeError:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from None


if __name__ == "__main__":
    from app.main import main

    main()
