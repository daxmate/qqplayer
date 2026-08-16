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

client = TestClient(backend.app)


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """设置存储隔离：写临时目录，不碰真实用户数据；每测试后重置缓存"""
    monkeypatch.setattr(backend, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(backend, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(backend, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    backend._settings = None
    yield
    backend._settings = None


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
    backend._settings = None
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
    s = client.put("/api/settings", json={"playback": {"shortcutMute": "KeyX"}}).json()[
        "settings"
    ]["playback"]
    assert s["shortcutMute"] == "KeyX"
    s = client.put(
        "/api/settings", json={"playback": {"shortcutPrevTrack": "Meta+ArrowRight"}}
    ).json()["settings"]["playback"]
    assert s["shortcutPrevTrack"] == "Meta+ArrowRight"
    # 模拟重启：持久化值仍在
    backend._settings = None
    s = client.get("/api/settings").json()["settings"]["playback"]
    assert s["shortcutPrevTrack"] == "Meta+ArrowRight"
    assert s["shortcutMute"] == "KeyX"
    # 未知字段不进白名单（GET 不返回）
    s = client.put("/api/settings", json={"playback": {"shortcutHack": "KeyZ"}}).json()[
        "settings"
    ]["playback"]
    assert "shortcutHack" not in s
