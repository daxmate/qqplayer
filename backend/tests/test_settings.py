"""PLAYBACK 设置归一化测试：searchKey（search anything 快捷键）

任务 A 新增字段：默认 'Meta+K'（Cmd+K 打开搜索层）；_norm_str 校验（类型非法回落默认）。
运行：cd /Users/dax/codes/qqplayerA && /Users/dax/codes/qqplayer/venv/bin/python -m pytest tests/test_settings.py -q
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import backend  # noqa: E402
from app import state  # noqa: E402

client = TestClient(backend.app)


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """设置存储隔离：写临时目录，不碰真实用户数据；每测试后重置缓存"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(state, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(state, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    state._settings = None
    yield
    state._settings = None


def test_search_key_default():
    """默认值 'Meta+K'（Cmd+K 打开 search anything），随 GET /api/settings 返回"""
    s = client.get("/api/settings").json()["settings"]["playback"]
    assert s["searchKey"] == "Meta+K"


def test_search_key_invalid_falls_back():
    """非法类型回落默认 'Meta+K'"""
    for bad in (123, None, ["Meta+K"], True):
        s = client.put("/api/settings", json={"playback": {"searchKey": bad}}).json()["settings"][
            "playback"
        ]
        assert s["searchKey"] == "Meta+K", f"searchKey={bad!r} 应回落默认"


def test_search_key_valid_preserved():
    """合法字符串保留（用户录制单键，e.code 风格），并落盘持久化"""
    s = client.put("/api/settings", json={"playback": {"searchKey": "KeyK"}}).json()["settings"][
        "playback"
    ]
    assert s["searchKey"] == "KeyK"
    s = client.put("/api/settings", json={"playback": {"searchKey": "F3"}}).json()["settings"][
        "playback"
    ]
    assert s["searchKey"] == "F3"
    # 模拟重启：重置缓存后仍读到持久化值
    state._settings = None
    s = client.get("/api/settings").json()["settings"]["playback"]
    assert s["searchKey"] == "F3"
    # 空字符串视为合法字符串保留（_norm_str 只校验类型）
    s = client.put("/api/settings", json={"playback": {"searchKey": ""}}).json()["settings"][
        "playback"
    ]
    assert s["searchKey"] == ""


def test_shortcut_fields_defaults():
    """任务 G：18 个新快捷键字段进 playback 白名单，默认值随 GET /api/settings 返回"""
    s = client.get("/api/settings").json()["settings"]["playback"]
    # 与前端 PLAYBACK_SETTINGS_DEFAULTS 一致（含新旧全部快捷键字段）
    for k in (
        "shortcutPlayPause",
        "shortcutRewind",
        "shortcutForward",
        "shortcutVolUp",
        "shortcutVolDown",
        "shortcutPrevTrack",
        "shortcutNextTrack",
        "shortcutMute",
        "shortcutFav",
        "shortcutCycleMode",
        "shortcutZhToggle",
        "shortcutKaraokeMode",
        "shortcutAbA",
        "shortcutAbB",
        "shortcutSlower",
        "shortcutFaster",
        "shortcutVolStepUp",
        "shortcutVolStepDown",
    ):
        assert k in s, f"playback 白名单缺少字段 {k}"
    assert s["shortcutPrevTrack"] == "Meta+ArrowLeft"
    assert s["shortcutNextTrack"] == "Meta+ArrowRight"
    assert s["shortcutMute"] == "KeyM"
    assert s["shortcutFav"] == "KeyF"
    assert s["shortcutFaster"] == "BracketRight"
    assert s["shortcutVolStepUp"] == "Meta+ArrowUp"
    assert s["shortcutVolStepDown"] == "Meta+ArrowDown"


def test_shortcut_fields_norm():
    """任务 G：快捷键字段 _norm_str 校验（非法类型回落默认，合法字符串保留并持久化）"""
    # 非法类型回落默认
    for bad in (123, None, ["KeyM"], True):
        s = client.put("/api/settings", json={"playback": {"shortcutMute": bad}}).json()[
            "settings"
        ]["playback"]
        assert s["shortcutMute"] == "KeyM", f"shortcutMute={bad!r} 应回落默认"
    # 合法字符串保留（用户录制的 ⌘ 组合 / 单键）
    s = client.put("/api/settings", json={"playback": {"shortcutMute": "KeyX"}}).json()["settings"][
        "playback"
    ]
    assert s["shortcutMute"] == "KeyX"
    s = client.put(
        "/api/settings", json={"playback": {"shortcutPrevTrack": "Meta+ArrowRight"}}
    ).json()["settings"]["playback"]
    assert s["shortcutPrevTrack"] == "Meta+ArrowRight"
    # 模拟重启：持久化值仍在
    state._settings = None
    s = client.get("/api/settings").json()["settings"]["playback"]
    assert s["shortcutPrevTrack"] == "Meta+ArrowRight"
    assert s["shortcutMute"] == "KeyX"
    # 未知字段不进白名单（GET 不返回）
    s = client.put("/api/settings", json={"playback": {"shortcutHack": "KeyZ"}}).json()["settings"][
        "playback"
    ]
    assert "shortcutHack" not in s


def test_player_mode_default():
    """player.mode 默认 'continuous'（连播），随 GET /api/settings 返回"""
    s = client.get("/api/settings").json()["settings"]["player"]
    assert s["mode"] == "continuous"


def test_player_mode_invalid_falls_back():
    """非法值（类型非法/枚举非法）回落默认 'continuous'"""
    for bad in (123, None, ["books"], True):
        s = client.put("/api/settings", json={"player": {"mode": bad}}).json()["settings"]["player"]
        assert s["mode"] == "continuous", f"mode={bad!r} 应回落默认"


def test_player_mode_valid_preserved():
    """合法值（'books'/'karaoke'）保留，并落盘持久化（模拟重启后仍读到）"""
    s = client.put("/api/settings", json={"player": {"mode": "books"}}).json()["settings"]["player"]
    assert s["mode"] == "books"
    s = client.put("/api/settings", json={"player": {"mode": "karaoke"}}).json()["settings"][
        "player"
    ]
    assert s["mode"] == "karaoke"
    # 模拟重启：重置缓存后仍读到持久化值
    state._settings = None
    s = client.get("/api/settings").json()["settings"]["player"]
    assert s["mode"] == "karaoke"


def test_books_last_read_id_default():
    """books.lastReadId 默认空字符串（未读过任何书），随 GET /api/settings 返回"""
    s = client.get("/api/settings").json()["settings"]["books"]
    assert s["lastReadId"] == ""


def test_books_last_read_id_invalid_falls_back():
    """非法值（非字符串）回落默认空字符串"""
    for bad in (123, None, ["b1"], True, {"id": "b1"}):
        s = client.put("/api/settings", json={"books": {"lastReadId": bad}}).json()["settings"][
            "books"
        ]
        assert s["lastReadId"] == "", f"lastReadId={bad!r} 应回落默认"


def test_books_last_read_id_valid_preserved():
    """合法值保留，并落盘持久化（模拟重启后仍读到）"""
    s = client.put("/api/settings", json={"books": {"lastReadId": "abc123"}}).json()["settings"][
        "books"
    ]
    assert s["lastReadId"] == "abc123"
    # 模拟重启：重置缓存后仍读到持久化值
    state._settings = None
    s = client.get("/api/settings").json()["settings"]["books"]
    assert s["lastReadId"] == "abc123"
    # 清理：恢复空值，避免影响其他用例
    client.put("/api/settings", json={"books": {"lastReadId": ""}})


# ============ scraping namespace（标签刮削设置）============
def test_scraping_namespace_defaults():
    """scraping 默认值：enabled_fields 白名单 / rename_template / source_order / batch_enabled=False"""
    s = client.get("/api/settings").json()["settings"]["scraping"]
    assert s == {
        "enabled_fields": [
            "title",
            "artist",
            "album",
            "cover",
            "year",
            "genre",
            "track",
            "album_artist",
        ],
        "rename_template": "{artist} - {title}",
        "source_order": ["netease", "musicbrainz"],
        "batch_enabled": False,
    }


def test_scraping_enabled_fields_whitelist_dedupe_order():
    """enabled_fields：白名单外字段丢弃，去重保序；全非法回落默认"""
    s = client.put(
        "/api/settings",
        json={"scraping": {"enabled_fields": ["cover", "year", "hack", "year", "title", "year"]}},
    ).json()["settings"]["scraping"]
    assert s["enabled_fields"] == ["cover", "year", "title"]  # 去重保序 + 白名单过滤
    # 全非法 / 非法类型 → 回落默认
    for bad in (["hack", "nope"], 123, None, "title"):
        s = client.put("/api/settings", json={"scraping": {"enabled_fields": bad}}).json()[
            "settings"
        ]["scraping"]
        assert s["enabled_fields"] == [
            "title",
            "artist",
            "album",
            "cover",
            "year",
            "genre",
            "track",
            "album_artist",
        ], f"enabled_fields={bad!r} 应回落默认"


def test_scraping_rename_template_validated():
    """rename_template：非空字符串合法保留；空串/非字符串回落默认"""
    tpl = "{track} - {artist} - {title}"
    s = client.put("/api/settings", json={"scraping": {"rename_template": tpl}}).json()["settings"][
        "scraping"
    ]
    assert s["rename_template"] == tpl
    for bad in ("", "   ", 123, None, ["{title}"]):
        s = client.put("/api/settings", json={"scraping": {"rename_template": bad}}).json()[
            "settings"
        ]["scraping"]
        assert s["rename_template"] == "{artist} - {title}", f"rename_template={bad!r} 应回落默认"


def test_scraping_source_order_validated():
    """source_order：只含 netease/musicbrainz 且不重复保序；非法回落默认"""
    s = client.put(
        "/api/settings", json={"scraping": {"source_order": ["musicbrainz", "netease", "netease"]}}
    ).json()["settings"]["scraping"]
    assert s["source_order"] == ["musicbrainz", "netease"]  # 去重保序
    for bad in (["hack"], [], 123, None, "netease"):
        s = client.put("/api/settings", json={"scraping": {"source_order": bad}}).json()[
            "settings"
        ]["scraping"]
        assert s["source_order"] == ["netease", "musicbrainz"], f"source_order={bad!r} 应回落默认"


def test_scraping_batch_enabled_bool():
    """batch_enabled：bool 保留；非 bool 回落默认 False"""
    s = client.put("/api/settings", json={"scraping": {"batch_enabled": True}}).json()["settings"][
        "scraping"
    ]
    assert s["batch_enabled"] is True
    for bad in ("yes", 1, None, [True]):
        s = client.put("/api/settings", json={"scraping": {"batch_enabled": bad}}).json()[
            "settings"
        ]["scraping"]
        assert s["batch_enabled"] is False, f"batch_enabled={bad!r} 应回落默认"
    # 恢复默认（避免影响其他用例）
    client.put("/api/settings", json={"scraping": {"batch_enabled": False}})


def test_scraping_persisted_across_restart():
    """scraping 设置落盘持久化（模拟重启后仍读到）"""
    client.put(
        "/api/settings",
        json={"scraping": {"rename_template": "{year} - {title}", "batch_enabled": True}},
    )
    state._settings = None
    s = client.get("/api/settings").json()["settings"]["scraping"]
    assert s["rename_template"] == "{year} - {title}"
    assert s["batch_enabled"] is True
    # 清理
    client.put(
        "/api/settings",
        json={"scraping": {"rename_template": "{artist} - {title}", "batch_enabled": False}},
    )


# ============ video.bilibiliCookie（B站 Cookie）============
def test_video_bilibili_cookie_default():
    """video.bilibiliCookie 默认空串（未设置），随 GET /api/settings 返回"""
    s = client.get("/api/settings").json()["settings"]["video"]
    assert s["bilibiliCookie"] == ""


def test_video_bilibili_cookie_invalid_falls_back():
    """非字符串值回落默认空串（cookie 只接受字符串；空串 = 未设置）"""
    for bad in (123, None, ["SESSDATA=x"], True, {"c": "x"}):
        s = client.put("/api/settings", json={"video": {"bilibiliCookie": bad}}).json()["settings"][
            "video"
        ]
        assert s["bilibiliCookie"] == "", f"bilibiliCookie={bad!r} 应回落默认"


def test_video_bilibili_cookie_valid_preserved():
    """合法字符串保留并落盘持久化（模拟重启后仍读到）"""
    cookie = "SESSDATA=abc123; bili_jct=def456; DedeUserID=10000"
    s = client.put("/api/settings", json={"video": {"bilibiliCookie": cookie}}).json()["settings"][
        "video"
    ]
    assert s["bilibiliCookie"] == cookie
    # 模拟重启：重置缓存后仍读到持久化值
    state._settings = None
    s = client.get("/api/settings").json()["settings"]["video"]
    assert s["bilibiliCookie"] == cookie
    # 清理：恢复空值，避免影响其他用例
    client.put("/api/settings", json={"video": {"bilibiliCookie": ""}})


# ============ video.cookiesFromBrowser（B站浏览器 Cookie 来源）============
def test_video_cookies_from_browser_default():
    """video.cookiesFromBrowser 默认空串（=不使用浏览器 Cookie），随 GET /api/settings 返回"""
    s = client.get("/api/settings").json()["settings"]["video"]
    assert s["cookiesFromBrowser"] == ""


def test_video_cookies_from_browser_invalid_falls_back():
    """非字符串 / 枚举外字符串回落默认空串（只接受 vivaldi/chrome/safari/edge/firefox/brave）"""
    for bad in (123, None, ["vivaldi"], True, {"b": "vivaldi"}, "unknown-browser", "Opera"):
        s = client.put("/api/settings", json={"video": {"cookiesFromBrowser": bad}}).json()[
            "settings"
        ]["video"]
        assert s["cookiesFromBrowser"] == "", f"cookiesFromBrowser={bad!r} 应回落默认"


def test_video_cookies_from_browser_valid_preserved():
    """合法枚举值保留并落盘持久化（模拟重启后仍读到）；空串合法（=不使用）"""
    for browser in ("vivaldi", "chrome", "safari", "edge", "firefox", "brave"):
        s = client.put("/api/settings", json={"video": {"cookiesFromBrowser": browser}}).json()[
            "settings"
        ]["video"]
        assert s["cookiesFromBrowser"] == browser, f"cookiesFromBrowser={browser!r} 应保留"
    # 模拟重启：持久化值仍在
    state._settings = None
    s = client.get("/api/settings").json()["settings"]["video"]
    assert s["cookiesFromBrowser"] == "brave"
    # 空串合法（不使用浏览器 Cookie）
    s = client.put("/api/settings", json={"video": {"cookiesFromBrowser": ""}}).json()["settings"][
        "video"
    ]
    assert s["cookiesFromBrowser"] == ""
    # 清理：恢复空值，避免影响其他用例
    client.put("/api/settings", json={"video": {"cookiesFromBrowser": ""}})
