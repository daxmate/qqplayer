"""测试路径引导：迁移后 backend/ 为后端根目录，tests 依赖顶层模块
（backend.py 薄兼容层 / 各 provider）在任意收集顺序下都可解析。

配对鉴权默认关闭：TestClient 来源 host=testclient（非 localhost），现有测试
大多不带 token；由本 autouse fixture 统一关闭，配对/鉴权测试在自己文件里
显式开启（monkeypatch state.AUTH_ENABLED = True）。
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import state  # noqa: E402


@pytest.fixture(autouse=True)
def _disable_auth(monkeypatch):
    """鉴权中间件默认放行（测试默认关闭）；配对鉴权测试自行开启"""
    monkeypatch.setattr(state, "AUTH_ENABLED", False)
    yield
