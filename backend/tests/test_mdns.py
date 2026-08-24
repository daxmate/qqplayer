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


class _FakeZC:
    """假 AsyncZeroconf：记录注销/注册调用"""

    def __init__(self):
        self.unregistered = []
        self.registered = []

    async def async_unregister_service(self, info):
        self.unregistered.append(info)

    async def async_register_service(self, info):
        self.registered.append(info)


def test_refresh_loop_rebroadcasts_on_ip_change(monkeypatch):
    """IP 变化后：注销旧地址广播 + 用新地址重新注册，holder 同步最新 info"""
    import asyncio

    import pytest

    # 模拟任务被取消：第二次 sleep 时抛 CancelledError 结束循环
    sleeps = []

    async def fake_sleep(_):
        sleeps.append(1)
        if len(sleeps) >= 2:
            raise asyncio.CancelledError

    monkeypatch.setattr(mdns.asyncio, "sleep", fake_sleep)
    # 广播地址 .124（旧），检测到 .230（新）。注意 _build_info() 内部会调用 _local_ipv4() 两次
    # （判空 + 构造）：前 2 次调用返回旧值（holder 构造），之后返回新值（检测/重注册）
    ip_calls = []

    def fake_ipv4():
        ip_calls.append(1)
        return "192.168.31.124" if len(ip_calls) <= 2 else "192.168.31.230"

    monkeypatch.setattr(mdns, "_local_ipv4", fake_ipv4)

    zc = _FakeZC()
    holder = {"info": mdns._build_info()}
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(mdns._refresh_loop(zc, holder))

    # 注销了旧记录，注册了新记录，且 holder 指向最新 info
    assert len(zc.unregistered) == 1
    assert len(zc.registered) == 1
    import socket

    assert socket.inet_ntoa(holder["info"].addresses[0]) == "192.168.31.230"


def test_refresh_loop_skips_when_ip_unchanged(monkeypatch):
    """IP 未变化：不触发注销/注册"""
    import asyncio

    import pytest

    sleeps = []

    async def fake_sleep(_):
        sleeps.append(1)
        raise asyncio.CancelledError  # 第一轮 sleep 即退出，循环体跑了一次

    monkeypatch.setattr(mdns.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(mdns, "_local_ipv4", lambda: "192.168.31.124")

    zc = _FakeZC()
    holder = {"info": mdns._build_info()}
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(mdns._refresh_loop(zc, holder))

    assert zc.unregistered == []
    assert zc.registered == []
