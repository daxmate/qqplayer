"""测试路径引导：迁移后 backend/ 为后端根目录，tests 依赖顶层模块
（backend.py 薄兼容层 / 各 provider）在任意收集顺序下都可解析。

配对鉴权默认关闭：TestClient 来源 host=testclient（非 localhost），现有测试
大多不带 token；由本文件 autouse fixture 统一关闭，配对/鉴权测试在自己文件里
显式开启（monkeypatch state.AUTH_ENABLED = True）。

SQLite 隔离（autouse）：每个测试独立临时 DB（DB_PATH → tmp_path）+ 全部迁移源
JSON 路径（favorites/playlists/playback/books/queue_order/network_songs/
annotations/vocab/pairing）一并指向临时目录 —— 既保证绝不触碰真实用户数据
（真实目录的旧 JSON 不会被自动迁移改名），也让按需写入 JSON 的测试走真实迁移流程。
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import (
    db,  # noqa: E402
    state,  # noqa: E402
)


@pytest.fixture(autouse=True)
def _disable_auth(monkeypatch):
    """鉴权中间件默认放行（测试默认关闭）；配对鉴权测试自行开启"""
    monkeypatch.setattr(state, "AUTH_ENABLED", False)
    yield


@pytest.fixture(autouse=True)
def _sqlite_isolate(tmp_path, monkeypatch):
    """SQLite 存储隔离：DB 与迁移源 JSON 全部指向本测试的临时目录。

    - DB_PATH → tmp_path/qqplayer_test.db（首次访问自动建表，测试各自独立）
    - FAVORITES/PLAYLISTS/PLAYBACK/BOOKS_FILE → tmp_path（防自动迁移碰到真实
      用户目录里的旧 JSON 并把它改名 .migrated.bak）
    个别测试在自己的 fixture 里重新 patch 这些路径（如 tmp_path/"data" 子目录），
    按 pytest fixture 顺序后者生效，仍全部落在临时目录内。
    """
    monkeypatch.setattr(state, "DB_PATH", tmp_path / "qqplayer_test.db")
    monkeypatch.setattr(state, "FAVORITES_FILE", tmp_path / "favorites.json")
    monkeypatch.setattr(state, "PLAYLISTS_FILE", tmp_path / "playlists.json")
    monkeypatch.setattr(state, "PLAYBACK_FILE", tmp_path / "playback.json")
    monkeypatch.setattr(state, "BOOKS_FILE", tmp_path / "books.json")
    monkeypatch.setattr(state, "QUEUE_ORDER_FILE", tmp_path / "queue_order.json")
    monkeypatch.setattr(state, "NETWORK_SONGS_FILE", tmp_path / "network_songs.json")
    monkeypatch.setattr(state, "ANNOTATIONS_FILE", tmp_path / "annotations.json")
    monkeypatch.setattr(state, "VOCAB_FILE", tmp_path / "vocab.json")
    monkeypatch.setattr(state, "PAIRING_FILE", tmp_path / "pairing.json")
    db.reset()  # 清初始化标志：本测试的 DB 首次访问时重建/重迁移
    yield
    db.reset()
