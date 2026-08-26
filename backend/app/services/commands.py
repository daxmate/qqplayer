"""设备指令队列服务：创建校验 / 原子拉取 / 回执 / 设备资产合并。

桌面端写指令（pushDownload / remoteDelete）→ iOS 轮询 GET pending 原子拉取执行 →
POST ack 回执。device_id 为 null 的指令广播给所有已配对设备。

薄领域层：大部分逻辑在 db 层（commands_* / device_assets_*），这里做契约校验
（非法输入抛 ValueError，Router 层转 400）与设备列表合并。
"""

from __future__ import annotations

from app import db
from app.services import pairing as pairing_service

COMMAND_TYPES = {"pushDownload", "remoteDelete"}


def create_command(body: dict) -> dict:
    """创建指令：校验 type / payload 形状 / device_id；返回 {id, type, status, created_at}"""
    if not isinstance(body, dict):
        raise ValueError("请求体必须是 JSON 对象")
    cmd_type = body.get("type")
    if cmd_type not in COMMAND_TYPES:
        raise ValueError("type 必须是 pushDownload 或 remoteDelete")
    payload = body.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("缺少 payload")
    if cmd_type == "pushDownload":
        items = payload.get("items")
        if not isinstance(items, list):
            raise ValueError("pushDownload payload 缺少 items 数组")
        for item in items:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("path"), str)
                or not item["path"]
            ):
                raise ValueError("items[].path 必须是非空字符串")
    else:  # remoteDelete
        paths = payload.get("paths")
        if not isinstance(paths, list):
            raise ValueError("remoteDelete payload 缺少 paths 数组")
        for p in paths:
            if not isinstance(p, str) or not p:
                raise ValueError("paths 元素必须是非空字符串")
    device_id = body.get("device_id")
    if device_id is not None and not isinstance(device_id, str):
        raise ValueError("device_id 必须是字符串或 null")
    return db.commands_create(cmd_type, payload, device_id)


def pending_pick(device_id: str | None = None) -> list[dict]:
    """拉取待执行指令（原子标记 executing + 超时回滚），逻辑在 db 层事务内完成"""
    return db.commands_pending_pick(device_id)


def ack_command(cmd_id: int, body: dict) -> dict:
    """执行回执：ok 必填布尔；error 可选字符串；指令不存在抛 KeyError（Router 转 404）"""
    if not isinstance(body, dict):
        raise ValueError("请求体必须是 JSON 对象")
    device_id = body.get("device_id")
    if not isinstance(device_id, str) or not device_id:
        raise ValueError("device_id 必填且须为字符串")
    ok = body.get("ok")
    if not isinstance(ok, bool):
        raise ValueError("ok 必填且须为布尔值")
    error = body.get("error")
    if error is not None and not isinstance(error, str):
        raise ValueError("error 必须是字符串")
    result = db.commands_ack(cmd_id, device_id, ok, error or "")
    if result is None:
        raise KeyError(cmd_id)
    return result


def list_commands(status: str | None = None, device_id: str | None = None) -> list[dict]:
    """指令历史：id 降序；可选 status / device_id 过滤"""
    return db.commands_list(status, device_id)


def upsert_device_assets(body: dict) -> None:
    """iOS 资产清单上报（按 device_id upsert 覆盖）"""
    if not isinstance(body, dict):
        raise ValueError("请求体必须是 JSON 对象")
    device_id = body.get("device_id")
    if not isinstance(device_id, str) or not device_id:
        raise ValueError("device_id 必填且须为字符串")
    assets = body.get("assets")
    if not isinstance(assets, list):
        raise ValueError("缺少 assets 数组")
    for item in assets:
        if not isinstance(item, dict):
            raise ValueError("assets 元素必须是对象")
    total = body.get("total", 0)
    if not isinstance(total, int) or isinstance(total, bool):
        raise ValueError("total 必须是整数")
    by_type = body.get("byType", {})
    if not isinstance(by_type, dict):
        raise ValueError("byType 必须是对象")
    db.device_assets_upsert(device_id, assets, total, by_type)


def devices_with_assets() -> list[dict]:
    """设备列表 = 已配对设备（pairing.list_devices）+ 最近资产上报合并。

    无上报的设备资产字段为默认值：assets: [], assets_count: 0, total: 0,
    byType: {}, assets_updated_at: null。
    """
    assets_by_device = db.device_assets_all()
    out = []
    for d in pairing_service.list_devices():
        device_id = d.get("device_id", "")
        a = assets_by_device.get(device_id)
        out.append(
            {
                "device_id": device_id,
                "device_name": d.get("device_name", ""),
                "server_id": d.get("server_id", ""),
                "last_seen": d.get("last_seen_at", ""),
                "assets": a["assets"] if a else [],
                "assets_count": len(a["assets"]) if a else 0,
                "total": a["total"] if a else 0,
                "byType": a["byType"] if a else {},
                "assets_updated_at": a["assets_updated_at"] if a else None,
            }
        )
    return out
