"""DATA_DIR 平台默认值测试：Windows 用 %APPDATA%\\QQPlayer，其他平台保持原 macOS 路径。

运行：cd /Users/dax/codes/qqplayer/backend && ./venv/bin/python -m pytest tests/test_state_data_dir.py -q
"""

import sys
from pathlib import Path

from app import state


def test_data_dir_env_var_wins(monkeypatch):
    """QQPLAYER_DATA_DIR 环境变量优先（win32 平台也优先）"""
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("QQPLAYER_DATA_DIR", "/tmp/qqp-isolated")
    assert state._default_data_dir() == Path("/tmp/qqp-isolated")


def test_data_dir_windows_uses_appdata(monkeypatch):
    """win32 + APPDATA 存在 → %APPDATA%/QQPlayer"""
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("QQPLAYER_DATA_DIR", raising=False)
    monkeypatch.setenv("APPDATA", r"C:\Users\test\AppData\Roaming")
    assert state._default_data_dir() == Path(r"C:\Users\test\AppData\Roaming") / "QQPlayer"


def test_data_dir_windows_appdata_missing_fallback(monkeypatch):
    """win32 + APPDATA 缺失 → ~/AppData/Roaming/QQPlayer"""
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("QQPLAYER_DATA_DIR", raising=False)
    monkeypatch.delenv("APPDATA", raising=False)
    assert state._default_data_dir() == Path.home() / "AppData" / "Roaming" / "QQPlayer"


def test_data_dir_macos_unchanged(monkeypatch):
    """非 win32 平台路径完全不变：~/Library/Application Support/qqplayer"""
    for platform in ("darwin", "linux"):
        monkeypatch.setattr(sys, "platform", platform)
        monkeypatch.delenv("QQPLAYER_DATA_DIR", raising=False)
        monkeypatch.delenv("APPDATA", raising=False)
        assert state._default_data_dir() == (
            Path.home() / "Library" / "Application Support" / "qqplayer"
        )
