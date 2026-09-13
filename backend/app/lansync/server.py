"""局域网同步（S2）host 侧传输层：asyncio TCP 监听 + mDNS 广播。

对位 Swift `QQPlayer/Sync/SyncListener.swift`（NWListener + Bonjour）。本模块只做
"接连接 → 建会话 → 喂字节"与"广播/注销服务"，协议与会话状态机在 `session.py`，
应用层单例在 `service.py`。

- **TCP**：`asyncio.start_server`，每连接一个 `HostSession`（host 角色）；`port=0`
  由系统分配（`start()` 返回实际端口）。
- **mDNS**：服务类型 `_qqplayer-sync._tcp`（**与老 companion 链路的 `_qqplayer._tcp`
  不同，两条链路互不影响**），TXT = `{"protoVer": "1", "name": <设备名>}`，
  **不广播 Device ID**（广播内容本身不可信，身份由握手指纹验证——协议 §8）。
  必须用 `zeroconf.asyncio.AsyncZeroconf`：同步版在运行中的事件循环里调用会
  `EventLoopBlocked`。zeroconf 未安装/注册失败只降级 warning，不拖垮服务。
- **生命周期幂等**：`start()` 重复调用返回同一端口；`stop()` 关闭全部会话 + 注销广播。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import socket
from collections.abc import Callable
from typing import Any

from .crypto import Identity
from .models import CloseReason, CloseReasonKind, SyncPhase, SyncSessionConfig
from .qr import NoncePool
from .session import HostSession, PendingPairRequest

logger = logging.getLogger(__name__)

#: mDNS 服务类型（协议 §8；带 `.local.` 后缀，与 zeroconf API 一致）
SERVICE_TYPE = "_qqplayer-sync._tcp.local."
#: TXT 协议版本值
TXT_PROTO_VERSION = "1"
#: mDNS 注册/注销超时（秒）：网络异常时不让 start/stop 挂死
MDNS_TIMEOUT = 5.0
#: 单次读取上限（字节）：帧头 + 超限判断足够，避免一次读入超大块
READ_CHUNK = 256 * 1024


class StreamTransport:
    """`asyncio.StreamWriter` 适配的帧字节通道（send 不阻塞：写缓冲由事件循环冲刷）。"""

    __slots__ = ("_writer", "_closed")

    def __init__(self, writer: asyncio.StreamWriter) -> None:
        self._writer = writer
        self._closed = False

    def send_frame_bytes(self, data: bytes) -> None:
        """写入整帧字节（已关闭后静默丢弃）。"""
        if self._closed:
            return
        try:
            self._writer.write(data)
        except Exception:  # noqa: BLE001 - 写失败由读循环的断连路径收尾
            logger.debug("lansync 写帧失败（连接可能已断开）", exc_info=True)

    def close_transport(self) -> None:
        """关闭连接（幂等；asyncio 会先冲刷已缓冲的字节再关，响应不会丢）。"""
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            self._writer.close()


def safe_device_name(name: str) -> str:
    """设备展示名清洗：仅保留字母数字与 `-._`（mDNS 实例名/TXT 非法字符替换为 `-`）。"""
    cleaned = "".join(char if (char.isalnum() or char in "-._") else "-" for char in name).strip(
        "-"
    )
    return cleaned or "qqplayer"


def _local_ipv4() -> str:
    """本机局域网 IPv4（复用老链路的网卡枚举：排除代理虚拟网卡 198.18/15、utun 等）。

    不能交给 zeroconf 自行选地址：代理软件（Surge/Clash）接管默认路由时它会广播
    虚拟网卡 IP（如 198.18.0.1），真机连不上（2026-08-23 真机 mDNS 解析失败根因）。
    取不到时返回空串（退回 zeroconf 自动选地址）。
    """
    try:
        from app.services.mdns import _local_ipv4 as detect
    except ImportError:  # 精简环境无老链路模块
        return ""
    try:
        return detect() or ""
    except Exception:  # noqa: BLE001 - 地址探测失败不阻断广播
        logger.debug("lansync 局域网地址探测失败", exc_info=True)
        return ""


def build_service_info(device_name: str, port: int) -> Any:
    """构造 mDNS `ServiceInfo`（纯构造，不碰网络；测试可直接断言字段）。"""
    from zeroconf import ServiceInfo

    addresses = None
    local_ip = _local_ipv4()
    if local_ip:
        addresses = [socket.inet_aton(local_ip)]
    return ServiceInfo(
        SERVICE_TYPE,
        f"{device_name}.{SERVICE_TYPE}",
        addresses=addresses,
        port=port,
        properties={"protoVer": TXT_PROTO_VERSION, "name": device_name},
        server=f"{device_name}.local.",
    )


class SyncServer:
    """host 侧监听器：TCP 接受连接 + mDNS 广播（幂等 start/stop）。"""

    def __init__(
        self,
        *,
        identity: Identity,
        trust_store: Any,
        nonces: NoncePool,
        device_name: str,
        port: int = 0,
        host: str = "0.0.0.0",
        session_config: SyncSessionConfig | None = None,
        enable_mdns: bool = True,
        on_state_change: Callable[[HostSession, SyncPhase], None] | None = None,
        on_closed: Callable[[HostSession, CloseReason], None] | None = None,
        on_pair_request: Callable[[HostSession, PendingPairRequest], None] | None = None,
        on_application_frame: Callable[[HostSession, int, bytes], None] | None = None,
    ) -> None:
        self._identity = identity
        self._trust_store = trust_store
        self._nonces = nonces
        self._device_name = device_name
        self._requested_port = port
        self._host = host
        self._session_config = session_config or SyncSessionConfig(display_name=device_name)
        self._enable_mdns = enable_mdns
        self._on_state_change = on_state_change
        self._on_closed = on_closed
        self._on_pair_request = on_pair_request
        self._on_application_frame = on_application_frame

        self._server: asyncio.AbstractServer | None = None
        self._port = 0
        self._zeroconf: Any = None
        self._service_info: Any = None
        self._sessions: dict[str, HostSession] = {}
        self._client_tasks: set[asyncio.Task[None]] = set()

    # ---------------------------------------------------------------- 查询

    @property
    def running(self) -> bool:
        """是否在监听。"""
        return self._server is not None

    @property
    def port(self) -> int:
        """实际监听端口（未启动为 0）。"""
        return self._port

    @property
    def device_name(self) -> str:
        """本机展示名（mDNS 实例名 / hello 与 QR 载荷）。"""
        return self._device_name

    @property
    def sessions(self) -> tuple[HostSession, ...]:
        """当前活动会话（只读视图；关闭的会话已移除）。"""
        return tuple(self._sessions.values())

    @property
    def mdns_running(self) -> bool:
        """mDNS 广播是否已注册。"""
        return self._zeroconf is not None

    def service_info(self) -> Any:
        """当前 mDNS 记录（未广播时 None；诊断/测试用）。"""
        return self._service_info

    # ------------------------------------------------------------ 生命周期

    async def start(self) -> int:
        """起 TCP 监听 + mDNS 广播（幂等，返回实际端口）。"""
        if self._server is not None:
            return self._port
        server = await asyncio.start_server(self._handle_client, self._host, self._requested_port)
        self._server = server
        self._port = int(server.sockets[0].getsockname()[1]) if server.sockets else 0
        await self._start_mdns()
        logger.info("lansync 监听已启动：%s:%s", self._host, self._port)
        return self._port

    async def stop(self) -> None:
        """停止监听：关闭全部会话 + 注销广播（幂等）。"""
        server, self._server = self._server, None
        for session in list(self._sessions.values()):
            session.cancel(CloseReason(CloseReasonKind.USER_CANCELLED))
        self._sessions.clear()
        for task in list(self._client_tasks):
            task.cancel()
        self._client_tasks.clear()
        if server is not None:
            server.close()
            with contextlib.suppress(Exception):
                await server.wait_closed()
        await self._stop_mdns()
        self._port = 0
        logger.info("lansync 监听已停止")

    # -------------------------------------------------------------- 连接

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """单连接主循环：建会话 → 喂字节 → 断连收尾。"""
        transport = StreamTransport(writer)
        session = HostSession(
            identity=self._identity,
            trust_store=self._trust_store,
            nonces=self._nonces,
            transport=transport,
            config=self._session_config,
            on_state_change=self._on_state_change,
            on_closed=self._on_closed,
            on_pair_request=self._on_pair_request,
            on_application_frame=self._on_application_frame,
        )
        self._sessions[session.session_id] = session
        task = asyncio.current_task()
        if task is not None:
            self._client_tasks.add(task)
        try:
            session.handle_transport_ready()
            while session.phase is not SyncPhase.CLOSED:
                data = await reader.read(READ_CHUNK)
                if not data:
                    break
                session.handle_inbound_data(data)
                with contextlib.suppress(Exception):
                    await writer.drain()
        except (ConnectionError, OSError, asyncio.IncompleteReadError):
            pass
        finally:
            session.handle_transport_closed()
            self._sessions.pop(session.session_id, None)
            with contextlib.suppress(Exception):
                writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
            if task is not None:
                self._client_tasks.discard(task)

    # ---------------------------------------------------------------- mDNS

    async def _start_mdns(self) -> None:
        """注册 `_qqplayer-sync._tcp` 广播（失败只降级，不抛给调用方）。"""
        if not self._enable_mdns or self._zeroconf is not None:
            return
        try:
            from zeroconf.asyncio import AsyncZeroconf
        except ImportError:
            logger.warning("zeroconf 未安装，lansync mDNS 广播不可用（pip install zeroconf）")
            return
        zeroconf = AsyncZeroconf()
        try:
            info = build_service_info(self._device_name, self._port)
            await asyncio.wait_for(zeroconf.async_register_service(info), timeout=MDNS_TIMEOUT)
        except Exception:  # noqa: BLE001 - 广播失败不拖垮服务（含 EventLoopBlocked）
            logger.warning("lansync mDNS 广播注册失败", exc_info=True)
            with contextlib.suppress(Exception):
                await zeroconf.async_close()
            return
        self._zeroconf = zeroconf
        self._service_info = info

    async def _stop_mdns(self) -> None:
        """注销广播并关闭 zeroconf（幂等）。"""
        zeroconf, info = self._zeroconf, self._service_info
        self._zeroconf = None
        self._service_info = None
        if zeroconf is None:
            return
        if info is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(
                    zeroconf.async_unregister_service(info), timeout=MDNS_TIMEOUT
                )
        with contextlib.suppress(Exception):
            await asyncio.wait_for(zeroconf.async_close(), timeout=MDNS_TIMEOUT)
