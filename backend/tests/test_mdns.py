"""mDNS 广播测试：服务信息格式（名称/类型以 .local. 结尾、端口、TXT 属性）。

运行：cd backend && ./venv/bin/python -m pytest tests/test_mdns.py -q
"""

from app import state
from app.services import mdns


def test_service_info_format(monkeypatch):
    """_qqplayer._tcp 服务：类型/名称以 .local. 结尾，端口与 TXT 属性正确"""
    monkeypatch.setattr(mdns, "_app_version", lambda: "9.9.9")
    info = mdns._build_info()
    assert info.type == "_qqplayer._tcp.local."
    assert info.name.endswith("._qqplayer._tcp.local.")
    assert info.port == state.DEFAULT_PORT
    props = info.properties
    assert props[b"v"] == b"9.9.9"
    assert props[b"name"] == mdns._safe_hostname().encode()
    assert info.server.endswith(".local.")


def test_safe_hostname_sanitizes_spaces(monkeypatch):
    """hostname 清洗：空格/非法字符替换为 '-'，mDNS 名称合法"""
    monkeypatch.setattr(mdns.socket, "gethostname", lambda: "Zhang De Mac")
    assert mdns._safe_hostname() == "Zhang-De-Mac"
