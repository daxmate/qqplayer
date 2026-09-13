"""局域网同步（S2）Host 服务持有层：应用级单例 + lifespan 生命周期（**容错**）。

与 `app/lansync/service.py` 的分工（协议实现 vs 进程生命周期）：

- **单例持有**：`SyncService` 构造要读/生成身份文件（磁盘 IO），全进程只需一个实例；
  本模块懒创建 + 缓存，路由层统一走 `get_service()`，测试用 `reset_service()` 隔离。
- **生命周期**：`start_service()/stop_service()` 供 `main.py` lifespan 调用。
  **容错口径与老链路 `services/mdns.py` 一致**：zeroconf 缺失 / 端口被占 / 监听失败
  一律只记 warning，绝不抛给 lifespan（否则拖垮整个后端启动）。
- **降级可见**：失败原因记在 `last_error()`，`GET /api/lansync/status` 原样返回给 UI，
  设置页能显示"未运行 + 原因"，而不是静默失效。
"""

from __future__ import annotations

import logging
import socket
from pathlib import Path

from app import state
from app.lansync.service import SyncService

logger = logging.getLogger(__name__)

#: 应用级单例（None = 尚未创建或创建失败）
_service: SyncService | None = None
#: 最近一次初始化/启动失败原因（成功时清空）
_last_error: str | None = None


def _new_service() -> SyncService:
    """构造 SyncService：store_dir = `state.DATA_DIR`（与 web 后端数据目录同级），设备名取 hostname。"""
    return SyncService(
        store_dir=Path(state.DATA_DIR),
        device_name=socket.gethostname() or "qqplayer",
    )


def get_service() -> SyncService | None:
    """取应用级单例（懒创建）。

    身份文件损坏 / 目录不可写等构造失败 → 返回 None（原因见 `last_error()`），
    调用方按降级处理（路由返回 503 / status 返回 available=false），不抛异常。
    """
    global _service, _last_error
    if _service is not None:
        return _service
    try:
        _service = _new_service()
    except Exception as error:  # noqa: BLE001 - 身份文件损坏/磁盘不可写都要降级而非崩后端
        _last_error = f"{type(error).__name__}: {error}"
        logger.warning("lansync 服务初始化失败：%s", _last_error)
        return None
    _last_error = None
    return _service


async def start_service() -> None:
    """lifespan 启动：起 TCP 监听 + mDNS 广播（幂等）；任何失败只记 warning。"""
    global _last_error
    service = get_service()
    if service is None:
        return
    try:
        await service.start()
    except Exception as error:  # noqa: BLE001 - 端口被占/权限不足等一律降级
        _last_error = f"{type(error).__name__}: {error}"
        logger.warning("lansync 监听启动失败（设置页显示为未运行）：%s", _last_error, exc_info=True)
        return
    _last_error = None


async def stop_service() -> None:
    """lifespan 关闭：停监听 + 注销广播；失败只记 warning（退出路径绝不抛）。"""
    service = _service
    if service is None:
        return
    try:
        await service.stop()
    except Exception:  # noqa: BLE001 - 收尾失败不影响进程退出
        logger.warning("lansync 监听停止失败", exc_info=True)


def reset_service() -> None:
    """丢弃单例与错误状态（测试隔离用；调用方负责先 `stop_service()`）。"""
    global _service, _last_error
    _service = None
    _last_error = None


def last_error() -> str | None:
    """最近一次初始化/启动失败原因（无失败为 None）。"""
    return _last_error
