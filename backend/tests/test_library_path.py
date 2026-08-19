"""歌曲库路径持久化测试：POST /api/library 落盘 settings.json，重启后按用户设定恢复。

覆盖：
- 设置成功后 settings.json 的 library.path 已保存（模拟重启后仍读到）
- 启动初始化：持久化路径存在 → state.LIBRARY 用保存值
- 持久化路径目录不存在 / 未设置 → 回退默认，不崩
"""

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT))
import app.main as main_module  # noqa: E402
import app.services.library_scan as library_scan  # noqa: E402
import backend  # noqa: E402
from app import state  # noqa: E402
from app.services import settings as settings_service  # noqa: E402

client = TestClient(backend.app)


@pytest.fixture(autouse=True)
def _isolate_storage(tmp_path, monkeypatch):
    """设置存储隔离：settings.json 写临时目录，不碰真实用户数据；每测试后重置缓存"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(state, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(state, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    monkeypatch.setattr(state, "DATA_DIR", tmp_path)
    state._settings = None
    yield
    state._settings = None


@pytest.fixture(autouse=True)
def _reset_watch_state():
    """每个测试前重置扫描缓存/版本号/去抖 timer，避免全局状态串扰"""
    with backend._scan_lock:
        state._scan_cache = None
        state._scan_version = 0
        if backend._watch_timer is not None:
            backend._watch_timer.cancel()
            state._watch_timer = None
    yield
    with backend._scan_lock:
        state._scan_cache = None
        state._scan_version = 0
        if backend._watch_timer is not None:
            backend._watch_timer.cancel()
            state._watch_timer = None


@pytest.fixture()
def _stub_watcher(monkeypatch):
    """watcher 用桩避免真起 watchdog 线程"""
    monkeypatch.setattr(library_scan, "start_watcher", lambda: None)
    monkeypatch.setattr(library_scan, "stop_watcher", lambda: None)


# ============ POST /api/library 持久化 ============
def test_set_library_persists_path(tmp_path, monkeypatch, _stub_watcher):
    """设置成功 → settings.json 的 library.path 已保存；模拟重启后仍读到"""
    new_dir = tmp_path / "mylib"
    new_dir.mkdir()
    r = client.post("/api/library", json={"path": str(new_dir)})
    assert r.status_code == 200
    assert r.json()["path"] == str(new_dir)
    # 落盘校验：settings.json 里 library.path 已保存，其余字段不受影响
    raw = json.loads(state.SETTINGS_FILE.read_text(encoding="utf-8"))
    assert raw["library"]["path"] == str(new_dir)
    assert raw["library"]["audioExts"] == state.DEFAULT_AUDIO_EXTS
    # 模拟重启：重置内存缓存后，GET /api/library/settings 仍返回保存的路径
    state._settings = None
    s = client.get("/api/library/settings").json()["settings"]
    assert s["path"] == str(new_dir)
    assert client.get("/api/library").json()["path"] == str(new_dir)


def test_set_library_invalid_dir_not_persisted(tmp_path, _stub_watcher):
    """目录不存在 → 400，settings.json 不落盘路径（保持空 = 未设定）"""
    r = client.post("/api/library", json={"path": str(tmp_path / "ghost")})
    assert r.status_code == 400
    s = client.get("/api/library/settings").json()["settings"]
    assert s["path"] == ""


# ============ 启动初始化读取 ============
def test_startup_applies_persisted_library_path(tmp_path):
    """settings.json 保存过有效路径 → 启动后 state.LIBRARY 用持久化值"""
    saved = tmp_path / "mylib"
    saved.mkdir()
    settings_service.save_settings({"path": str(saved)})
    state._settings = None  # 模拟重启：缓存清空，从盘上读
    state.LIBRARY = state.DEFAULT_LIBRARY  # 回到默认再启动
    main_module._apply_persisted_library_path()
    assert saved == state.LIBRARY


def test_startup_missing_dir_falls_back(tmp_path):
    """持久化路径目录不存在（外接盘没挂/被删）→ 保持默认，不崩"""
    settings_service.save_settings({"path": str(tmp_path / "ghost")})
    state._settings = None
    state.LIBRARY = state.DEFAULT_LIBRARY
    main_module._apply_persisted_library_path()
    assert state.LIBRARY == state.DEFAULT_LIBRARY


def test_startup_empty_path_falls_back(tmp_path):
    """未设置过（path 空串）→ 保持默认，不崩"""
    settings_service.save_settings({"path": ""})
    state._settings = None
    state.LIBRARY = state.DEFAULT_LIBRARY
    main_module._apply_persisted_library_path()
    assert state.LIBRARY == state.DEFAULT_LIBRARY
