"""下载限速测试：_stream_download 时间窗节流 / _download_with_engine 双引擎限速接线 / settings.maxSpeed 归一化。

运行：cd /Users/dax/codes/qqplayer && /Users/dax/codes/qqplayer/venv/bin/python -m pytest tests/test_download.py -q
"""

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import backend  # noqa: E402
from app import state  # noqa: E402
from app.services import download  # noqa: E402

client = TestClient(backend.app)


class _FakeStreamResp:
    """mock httpx.stream 的响应：chunk 迭代 + raise_for_status"""

    def __init__(self, chunks):
        self._chunks = chunks

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        return None

    def iter_bytes(self):
        yield from self._chunks


# ============ _stream_download 限速 ============
def test_stream_download_throttles(tmp_path, monkeypatch):
    """max_speed_mbps=1、3×1MB：累计耗时 >= 理论下限的宽松阈值（3s 理论，断言 >= 1.5s）"""
    chunk = b"x" * (1024 * 1024)
    monkeypatch.setattr(download.httpx, "stream", lambda *a, **kw: _FakeStreamResp([chunk] * 3))
    dest = tmp_path / "song.flac"
    t0 = time.monotonic()
    download._stream_download("http://example.com/song.flac", dest, max_speed_mbps=1)
    elapsed = time.monotonic() - t0
    assert dest.read_bytes() == chunk * 3  # 内容完整
    assert elapsed >= 1.5, f"限速 1MB/s 下载 3MB 应 >= 1.5s，实际 {elapsed:.2f}s"


def test_stream_download_unlimited_no_sleep(tmp_path, monkeypatch):
    """max_speed_mbps=0（默认不限速）：不节流，毫秒级完成"""
    chunk = b"x" * (1024 * 1024)
    monkeypatch.setattr(download.httpx, "stream", lambda *a, **kw: _FakeStreamResp([chunk] * 3))
    dest = tmp_path / "song.flac"
    t0 = time.monotonic()
    download._stream_download("http://example.com/song.flac", dest)
    elapsed = time.monotonic() - t0
    assert dest.read_bytes() == chunk * 3
    assert elapsed < 1.0, f"不限速应快速完成，实际 {elapsed:.2f}s"


# ============ _download_with_engine 双引擎限速接线 ============
def test_aria2_adds_max_download_limit(monkeypatch, tmp_path):
    """engine=aria2 + maxSpeed=4：aria2.addUri opts 含 max-download-limit=4M"""
    calls = []

    def fake_rpc(rpc, secret, method, params):
        calls.append((method, params))
        if method == "aria2.addUri":
            return "gid1"
        return {"status": "complete"}

    monkeypatch.setattr(download, "_aria2_rpc_call", fake_rpc)
    dest = tmp_path / "song.flac"
    ret = download._download_with_engine(
        "http://example.com/song.flac",
        dest,
        {"download": {"engine": "aria2", "maxSpeed": 4}},
        headers={"Cookie": "abc"},
    )
    assert ret == dest
    add_method, (urls, opts) = calls[0]
    assert add_method == "aria2.addUri"
    assert urls == ["http://example.com/song.flac"]
    assert opts["max-download-limit"] == "4M"
    assert opts["header"] == ["Cookie: abc"]


def test_aria2_no_limit_when_zero(monkeypatch, tmp_path):
    """engine=aria2 + maxSpeed=0 / 缺省：opts 不含 max-download-limit（保持现状）"""
    calls = []

    def fake_rpc(rpc, secret, method, params):
        calls.append((method, params))
        if method == "aria2.addUri":
            return "gid1"
        return {"status": "complete"}

    monkeypatch.setattr(download, "_aria2_rpc_call", fake_rpc)
    for settings in (
        {"download": {"engine": "aria2", "maxSpeed": 0}},
        {"download": {"engine": "aria2"}},
        {"download": {"engine": "aria2", "maxSpeed": "abc"}},  # 非数字防御
    ):
        calls.clear()
        download._download_with_engine(
            "http://example.com/song.flac", tmp_path / "song.flac", settings
        )
        opts = calls[0][1][1]
        assert "max-download-limit" not in opts


def test_httpx_passes_max_speed(monkeypatch, tmp_path):
    """engine=httpx：max_speed_mbps 透传给 _stream_download；非法值按 0（不限速）"""
    seen = {}

    def fake_stream(url, dest, timeout=download.DOWNLOAD_TIMEOUT, headers=None, max_speed_mbps=0):
        seen["max_speed_mbps"] = max_speed_mbps
        return dest

    monkeypatch.setattr(download, "_stream_download", fake_stream)
    download._download_with_engine(
        "http://example.com/song.flac",
        tmp_path / "song.flac",
        {"download": {"engine": "httpx", "maxSpeed": 2.5}},
    )
    assert seen["max_speed_mbps"] == 2.5
    seen.clear()
    download._download_with_engine(
        "http://example.com/song.flac",
        tmp_path / "song.flac",
        {"download": {"engine": "httpx", "maxSpeed": None}},
    )
    assert seen["max_speed_mbps"] == 0


# ============ settings.maxSpeed 归一化 ============
@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """设置存储隔离：写临时目录，不碰真实用户数据；每测试后重置缓存"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(state, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(state, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    state._settings = None
    yield
    state._settings = None


def test_max_speed_default():
    """默认 4（MB/s），随 GET /api/settings 返回"""
    s = client.get("/api/settings").json()["settings"]["download"]
    assert s["maxSpeed"] == 4


def test_max_speed_valid_preserved():
    """合法值保留：小数（2.5）/ 边界（0 = 不限速 / 100）"""
    for v in (2.5, 0, 100):
        s = client.put("/api/settings", json={"download": {"maxSpeed": v}}).json()["settings"][
            "download"
        ]
        assert s["maxSpeed"] == v, f"maxSpeed={v!r} 应保留"
    # 落盘持久化（模拟重启）
    state._settings = None
    s = client.get("/api/settings").json()["settings"]["download"]
    assert s["maxSpeed"] == 100


def test_max_speed_invalid_falls_back():
    """非法值回落默认 4：负数 / 超 100 / 非数字 / bool"""
    for bad in (-1, 999, "abc", None, True):
        s = client.put("/api/settings", json={"download": {"maxSpeed": bad}}).json()["settings"][
            "download"
        ]
        assert s["maxSpeed"] == 4, f"maxSpeed={bad!r} 应回落默认 4"
