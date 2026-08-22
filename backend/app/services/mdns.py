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


def _local_ipv4() -> str:
    """本机局域网 IPv4（UDP 探活技巧，不发包）；失败回退空串 → 让 zeroconf 自动选地址"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
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


async def start():
    """启动 mDNS 广播（AsyncZeroconf；zeroconf 未安装/注册失败时降级静默）。

    返回 handle（含 zc/info），供 stop() 注销；失败返回 None。
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
    return {"zc": zc, "info": info}


async def stop(handle) -> None:
    """退出时注销 mDNS 服务（handle 为空/异常时静默）"""
    if not handle:
        return
    zc, info = handle["zc"], handle["info"]
    try:
        await asyncio.wait_for(zc.async_unregister_service(info), timeout=5)
    except Exception:  # noqa: BLE001
        logger.warning("mDNS 注销失败", exc_info=True)
    try:
        await asyncio.wait_for(zc.async_close(), timeout=5)
    except Exception:  # noqa: BLE001
        logger.warning("mDNS 关闭失败", exc_info=True)
