"""mDNS 广播：注册 `_qqplayer._tcp` 服务（iOS companion 自动发现桌面端）。

TXT 记录：v=版本号（仓库根 VERSION 文件，唯一真源；缺失时回退 "1"）、name=hostname。
端口：state.DEFAULT_PORT（默认 17627）。用 AsyncZeroconf（原生异步，集成在 uvicorn 事件循环；
同步 Zeroconf 在运行中的 asyncio 循环里调用会 EventLoopBlocked）。zeroconf 延迟 import：
未安装时降级静默（仅 warning），不影响后端启动（CI/精简环境无 zeroconf 也能跑测试）。

用法（main.py lifespan）：
    mdns_handle = await mdns.start()
    yield
    await mdns.stop(mdns_handle)
"""

import asyncio
import contextlib
import logging
import socket

from app import state

logger = logging.getLogger(__name__)

_SERVICE_TYPE = "_qqplayer._tcp.local."


def _safe_hostname() -> str:
    """本机 hostname 清洗：mDNS 名称不允许空格/控制字符（替换为 '-'）"""
    hostname = socket.gethostname() or "qqplayer"
    return "".join(ch if ch.isalnum() or ch in "-._" else "-" for ch in hostname)


def _app_version() -> str:
    """应用版本号：仓库根 VERSION 文件（打包/桌面壳唯一真源）"""
    version_file = state.ROOT / "VERSION"
    try:
        return version_file.read_text("utf-8").strip() or "1"
    except OSError:
        return "1"


# 虚拟/回环接口前缀（代理虚拟网卡 utun、苹果内部 llw/awdl/bridge 等）——广播前必须排除
_VIRTUAL_IFACE_PREFIXES = ("lo", "utun", "llw", "awdl", "bridge", "gif", "stf", "anpi", "ap")


def _is_private_ipv4(ip: str) -> bool:
    """私网 IPv4：10/8、172.16/12、192.168/16。代理虚拟网卡网段 198.18/15 不算。"""
    try:
        first, second = (int(part) for part in ip.split(".")[:2])
    except (ValueError, IndexError):
        return False
    if first == 10:
        return True
    if first == 172 and 16 <= second <= 31:
        return True
    return bool(first == 192 and second == 168)


def _local_ipv4() -> str:
    """本机局域网 IPv4（getifaddrs 枚举：排除虚拟/回环网卡，取私网段首个地址）。

    失败回退空串 → 让 zeroconf 自动选地址。
    不用 UDP 探活 8.8.8.8：代理软件（Surge/Clash）接管默认路由时 getsockname() 会返回
    虚拟网卡 IP（如 198.18.0.1），广播出去真机连不上（2026-08-23 真机 mDNS 解析失败根因）；
    socket.getaddrinfo(hostname) 在代理环境同样不可靠（可能解析失败或返回虚拟地址）。
    实现：ctypes 调 libc getifaddrs，string_at 直接读 sockaddr 原始内存（ctypes 结构体
    读指针在 Python 3.14 下会拿到空数据，已实测）。
    """
    import ctypes
    import ctypes.util
    import sys

    class _Ifaddrs(ctypes.Structure):
        pass

    _Ifaddrs._fields_ = [
        ("ifa_next", ctypes.POINTER(_Ifaddrs)),
        ("ifa_name", ctypes.c_char_p),
        ("ifa_flags", ctypes.c_uint),
        ("ifa_addr", ctypes.c_void_p),  # 原始指针，后续 string_at 读内存
        ("ifa_netmask", ctypes.c_void_p),
        ("ifa_dstaddr", ctypes.c_void_p),
        ("ifa_data", ctypes.c_void_p),
    ]

    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    libc.getifaddrs.argtypes = [ctypes.POINTER(ctypes.POINTER(_Ifaddrs))]
    libc.getifaddrs.restype = ctypes.c_int
    libc.freeifaddrs.argtypes = [ctypes.POINTER(_Ifaddrs)]

    is_darwin = sys.platform == "darwin"
    head = ctypes.POINTER(_Ifaddrs)()
    if libc.getifaddrs(ctypes.byref(head)) != 0:
        return ""
    try:
        p = head
        while p:
            ifa = p.contents
            name = ifa.ifa_name.decode(errors="replace") if ifa.ifa_name else ""
            if name and not name.startswith(_VIRTUAL_IFACE_PREFIXES) and ifa.ifa_addr:
                raw = ctypes.string_at(ifa.ifa_addr, 16)
                # family 偏移：macOS sa_len(1)+sa_family(1)；Linux sa_family(2 小端)
                family = raw[1] if is_darwin else raw[0]
                if family == socket.AF_INET:
                    # sin_addr 偏移恒为 4（macOS: 1+1+2；Linux: 2+2）
                    ip = socket.inet_ntop(socket.AF_INET, raw[4:8])
                    if _is_private_ipv4(ip):
                        return ip
            p = ifa.ifa_next
    finally:
        libc.freeifaddrs(head)
    return ""


def _build_info():
    """构造 ServiceInfo（纯构造，不碰网络；测试可直接调用）"""
    from zeroconf import ServiceInfo  # 延迟 import

    hostname = _safe_hostname()
    return ServiceInfo(
        _SERVICE_TYPE,
        f"{hostname}.{_SERVICE_TYPE}",
        addresses=[socket.inet_aton(_local_ipv4())] if _local_ipv4() else None,
        port=state.DEFAULT_PORT,
        properties={"v": _app_version(), "name": hostname},
        server=f"{hostname}.local.",
    )


# IP 变化检测间隔（秒）：DHCP 重新分配后旧 IP 不可达，iOS 解析到旧地址会一直"解析中"
_REFRESH_INTERVAL = 30


async def _refresh_loop(zc, holder: dict) -> None:
    """后台刷新：本机局域网 IP 变化时重新注册 mDNS 广播。

    zeroconf 的 ServiceInfo 注册后地址固定，不会随本机 IP 变化自动更新；
    若 DHCP 换 IP（如 .124 -> .230），旧广播指向不可达地址，手机浏览得到服务名
    但连接失败（2026-08-24 真机"解析中"根因）。每 30s 对比一次，变了就
    注销旧记录并用新地址重新注册；holder["info"] 同步更新，保证 stop() 注销的是最新记录。
    """
    while True:
        await asyncio.sleep(_REFRESH_INTERVAL)
        current = _local_ipv4()
        info = holder["info"]
        advertised = socket.inet_ntoa(info.addresses[0]) if info.addresses else ""
        if current and current != advertised:
            logger.info("mDNS 本机 IP 变化 %s -> %s，重新广播", advertised, current)
            try:
                await asyncio.wait_for(zc.async_unregister_service(info), timeout=5)
            except Exception:  # noqa: BLE001
                logger.warning("mDNS 注销旧地址广播失败", exc_info=True)
            try:
                new_info = _build_info()
                await asyncio.wait_for(zc.async_register_service(new_info), timeout=5)
                holder["info"] = new_info
            except Exception:  # noqa: BLE001
                logger.warning("mDNS 重新广播失败（下轮再试）", exc_info=True)


async def start():
    """启动 mDNS 广播（AsyncZeroconf；zeroconf 未安装/注册失败时降级静默）。

    返回 handle（含 zc/info/refresh_task），供 stop() 注销；失败返回 None。
    """
    try:
        from zeroconf.asyncio import AsyncZeroconf
    except ImportError:
        logger.warning("zeroconf 未安装，mDNS 广播不可用（pip install zeroconf）")
        return None
    zc = AsyncZeroconf()
    try:
        info = _build_info()
        await zc.async_register_service(info)
    except Exception:  # noqa: BLE001 — 广播失败不拖垮后端（含注册超时 EventLoopBlocked）
        logger.warning("mDNS 广播注册失败", exc_info=True)
        await zc.async_close()
        return None
    holder = {"info": info}
    refresh_task = asyncio.create_task(_refresh_loop(zc, holder))
    return {"zc": zc, "info": info, "holder": holder, "refresh_task": refresh_task}


async def stop(handle) -> None:
    """退出时注销 mDNS 服务（handle 为空/异常时静默）"""
    if not handle:
        return
    task = handle.get("refresh_task")
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    zc, info = handle["zc"], handle.get("holder", {}).get("info") or handle["info"]
    try:
        await asyncio.wait_for(zc.async_unregister_service(info), timeout=5)
    except Exception:  # noqa: BLE001
        logger.warning("mDNS 注销失败", exc_info=True)
    try:
        await asyncio.wait_for(zc.async_close(), timeout=5)
    except Exception:  # noqa: BLE001
        logger.warning("mDNS 关闭失败", exc_info=True)
