"""阅读器 V2 阅读设置测试：books namespace 7 个新字段（默认值/合法值/非法回落/越界 clamp）

契约：docs/reader-v2/01-contract-backend-core.md 第一节；默认值单一来源
state.READER_SETTINGS_DEFAULTS。运行：cd ~/codes/qqplayerA && \
~/codes/qqplayer/venv/bin/python -m pytest tests/test_reader_settings.py -q
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


def _books() -> dict:
    return client.get("/api/settings").json()["settings"]["books"]


def _put(**fields) -> dict:
    """PUT 指定 books 字段（深合并），返回规范化后的 books namespace"""
    return client.put("/api/settings", json={"books": fields}).json()["settings"]["books"]


def test_reader_settings_defaults():
    """7 个新字段默认值与契约一致，随 GET /api/settings 返回（lastReadId 语义不动）"""
    b = _books()
    assert b["lastReadId"] == ""
    assert b["fontFamily"] == "default"
    assert b["fontSize"] == 100
    assert b["lineHeight"] == 1.6
    assert b["margin"] == 4
    assert b["theme"] == "light"
    assert b["textColor"] == ""
    assert b["bgColor"] == ""


@pytest.mark.parametrize("value, expected", [(71, 71), (70, 70), (200, 200), (201, 200)])
def test_font_size_clamp(value, expected):
    """fontSize 越界 clamp 到 [70, 200]（integer=True）：71 在界内保留，201 回落 200"""
    assert _put(fontSize=value)["fontSize"] == expected


@pytest.mark.parametrize("bad", ("100", None, True, [100]))
def test_font_size_non_int_falls_back(bad):
    """fontSize 非数字回落默认 100"""
    assert _put(fontSize=bad)["fontSize"] == 100


def test_font_size_float_coerced_to_int():
    """fontSize 小数（integer=True）取整：70.5 → 70"""
    assert _put(fontSize=70.5)["fontSize"] == 70


@pytest.mark.parametrize("value, expected", [(1.0, 1.0), (0.5, 1.0), (1.6, 1.6), (2.5, 2.0)])
def test_line_height_clamp(value, expected):
    """lineHeight 越界 clamp 到 [1.0, 2.0]（允许小数）"""
    assert _put(lineHeight=value)["lineHeight"] == expected


def test_margin_clamp():
    """margin 越界 clamp 到 [0, 15]（integer=True）"""
    assert _put(margin=-1)["margin"] == 0
    assert _put(margin=0)["margin"] == 0
    assert _put(margin=15)["margin"] == 15
    assert _put(margin=16)["margin"] == 15


@pytest.mark.parametrize("theme", ("light", "sepia", "dark", "auto"))
def test_theme_valid_preserved(theme):
    """theme 合法枚举值保留"""
    assert _put(theme=theme)["theme"] == theme


@pytest.mark.parametrize("bad", ("ocean", 123, None, ["sepia"], True))
def test_theme_invalid_falls_back(bad):
    """theme 非法值（枚举外/类型非法）回落 'light'"""
    assert _put(theme=bad)["theme"] == "light"


@pytest.mark.parametrize("fam", ("default", "serif", "sans", "rounded"))
def test_font_family_valid_preserved(fam):
    """fontFamily 合法枚举值保留"""
    assert _put(fontFamily=fam)["fontFamily"] == fam


@pytest.mark.parametrize("bad", ("comic", 42, None, ["serif"], True))
def test_font_family_invalid_falls_back(bad):
    """fontFamily 非法值回落 'default'"""
    assert _put(fontFamily=bad)["fontFamily"] == "default"


@pytest.mark.parametrize("bad", (123, None, ["#fff"], True, 0))
def test_text_bg_color_non_string_falls_back(bad):
    """textColor/bgColor 非字符串回落默认空串"""
    assert _put(textColor=bad)["textColor"] == ""
    assert _put(bgColor=bad)["bgColor"] == ""


def test_color_overrides_preserved():
    """textColor/bgColor 合法字符串保留（自定义颜色覆盖主题，前端颜色选择器写入）"""
    b = _put(textColor="#123456", bgColor="#abcdef")
    assert b["textColor"] == "#123456"
    assert b["bgColor"] == "#abcdef"


def test_reader_settings_persist_across_restart():
    """模拟重启：合法值落盘持久化，重置缓存后仍读到"""
    _put(fontSize=150, lineHeight=1.8, theme="sepia", margin=8, fontFamily="serif")
    state._settings = None
    b = _books()
    assert b["fontSize"] == 150
    assert b["lineHeight"] == 1.8
    assert b["theme"] == "sepia"
    assert b["margin"] == 8
    assert b["fontFamily"] == "serif"


def test_reader_settings_ignore_unknown_fields():
    """books namespace 未知字段不进白名单（GET 不返回）"""
    s = client.put("/api/settings", json={"books": {"hackField": 1}}).json()["settings"]["books"]
    assert "hackField" not in s
