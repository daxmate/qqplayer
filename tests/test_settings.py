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
