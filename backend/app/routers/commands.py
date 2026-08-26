"""设备指令队列 API：/api/sync/commands* 与 /api/sync/devices（桌面端写指令，iOS 轮询拉取执行）。

- POST /api/sync/commands           创建指令（pushDownload / remoteDelete；device_id null = 广播）
- GET  /api/sync/commands/pending   iOS 拉取待执行（原子标记 executing + 超时回滚，防重复执行）
- POST /api/sync/commands/{id}/ack  执行回执（ok → done；ok=false → failed + error；幂等）
- GET  /api/sync/commands           桌面端指令历史（id 降序，status/device_id 可选过滤）
- POST /api/sync/device/assets      iOS 资产清单上报（按 device_id upsert）
- GET  /api/sync/devices            桌面端设备列表（已配对设备 + 最近资产合并）

鉴权：/api/sync/* 不在白名单 → 由中间件自动覆盖（localhost 免鉴权，其余需 Bearer token），
这里不写鉴权逻辑。
"""

from fastapi import APIRouter, HTTPException, Query

from app.services import commands as commands_service

router = APIRouter()


@router.post("/api/sync/commands", status_code=201)
def api_sync_commands_create(body: dict):
    """创建设备指令；device_id 省略/null → 广播（所有已配对设备可拉取）"""
    try:
        return commands_service.create_command(body)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@router.get("/api/sync/commands/pending")
def api_sync_commands_pending(device_id: str = Query("", description="拉取方设备 id")):
    """拉取待执行指令（广播 + 本设备定向，按 id 升序）；原子标记 executing + 超时回滚。

    device_id 省略时只返回广播指令（device_id IS NULL）。
    """
    return {"commands": commands_service.pending_pick(device_id or None)}


@router.post("/api/sync/commands/{cmd_id}/ack")
def api_sync_commands_ack(cmd_id: int, body: dict):
    """执行回执：ok=true → done；ok=false → failed + error；重复 ack 幂等覆盖"""
    try:
        return commands_service.ack_command(cmd_id, body)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    except KeyError:
        raise HTTPException(404, "指令不存在") from None


@router.get("/api/sync/commands")
def api_sync_commands_list(
    status: str | None = Query(None, description="按状态过滤：pending/executing/done/failed"),
    device_id: str | None = Query(None, description="按目标设备过滤（精确匹配）"),
):
    """桌面端指令历史：id 降序；可选 status / device_id 过滤"""
    return {"commands": commands_service.list_commands(status, device_id)}


@router.post("/api/sync/device/assets")
def api_sync_device_assets_upsert(body: dict):
    """iOS 上报资产清单：按 device_id 一行 upsert（assets JSON + total + byType + updated_at）"""
    try:
        commands_service.upsert_device_assets(body)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return {"ok": True}


@router.get("/api/sync/devices")
def api_sync_devices():
    """桌面端设备列表：已配对设备 + 最近资产上报合并（无上报设备为默认空值）"""
    return {"devices": commands_service.devices_with_assets()}
