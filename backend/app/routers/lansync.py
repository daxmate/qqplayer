"""局域网同步（S2）路由：/api/lansync/*（Host 角色 · 配对管理 / 设备 / 事件轮询）。

对接 `app/lansync/service.py` 的 `SyncService` 冻结接口（见 `docs/lan-sync-web-host-plan.md` §3）。
本路由只负责 HTTP 形状与错误码，协议与会话状态机在 `app/lansync/`。

- GET    /api/lansync/status                        服务状态（永远 200，降级时 available=false）
- GET    /api/lansync/identity                      本机身份（全量 ID + 分组 + 公钥）
- POST   /api/lansync/pairing/start                 生成配对二维码（换新码 = 作废旧码）
- POST   /api/lansync/pairing/stop                  停止展示（作废当前 nonce）
- GET    /api/lansync/pairing/pending               待批准请求
- POST   /api/lansync/pairing/{request_id}/approve|reject|cancel
- GET    /api/lansync/devices                       已配对设备；DELETE 撤销配对
- GET    /api/lansync/events?cursor=N               事件轮询（UI 实时刷新批准卡/设备状态）
- POST   /api/lansync/push                          发起「推送到设备」（S3a）→ run_id
- GET    /api/lansync/push/{run_id}                 推送进度 / 账目（未知 run_id → 404）
- POST   /api/lansync/push/{run_id}/cancel          取消推送（未知 / 已终态 → cancelled=false）
- POST   /api/lansync/pull/preview                  请求对端清单一页（清单**异步**经 /events 到达）
- POST   /api/lansync/pull                          发起「从设备拉取」（S3b）→ run_id
- GET    /api/lansync/pull/{run_id}                 拉取进度 / 账目（未知 run_id → 404）
- POST   /api/lansync/pull/{run_id}/cancel          取消拉取（未知 / 已终态 → cancelled=false）

**鉴权不进白名单**（与老链路 `/api/pairing/*` 不同）：lansync 的"批准"= 授予信任关系，
未配对设备不得经免鉴权通道调用；正常调用方是本机浏览器（localhost 免鉴权）。
"""

from __future__ import annotations

import base64
import io
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.lansync.deviceid import short_comparison_parts
from app.lansync.models import PROTOCOL_VERSION
from app.lansync.pull import DEFAULT_PAGE_LIMIT, PullError
from app.lansync.push import PushError
from app.lansync.service import SyncService
from app.services import lansync_host

logger = logging.getLogger(__name__)

router = APIRouter()

#: 服务未运行 / 不可用时的统一错误文案（前端据此提示"服务未就绪"）
UNAVAILABLE_DETAIL = "局域网同步服务未运行"
#: 配对请求不存在/已过期
NO_REQUEST_DETAIL = "配对请求不存在或已过期"
#: 同步运行（推送 / 拉取）不存在
NO_RUN_DETAIL = "同步运行不存在"


def _require_service() -> SyncService:
    """取 SyncService（懒创建）；构造失败 → 503。"""
    service = lansync_host.get_service()
    if service is None:
        raise HTTPException(503, UNAVAILABLE_DETAIL)
    return service


def _require_running_service() -> SyncService:
    """取**已启动**的 SyncService（配对类端点前置：没有监听端口就没有可配对的会话）。"""
    service = _require_service()
    if not service.status["running"]:
        raise HTTPException(503, UNAVAILABLE_DETAIL)
    return service


def _qr_data_url(text: str) -> str | None:
    """QR 载荷文本 → PNG data URL；生成失败返回 None（不抛，前端降级为纯文本载荷）。

    **形态选择：data URL（PNG）**。理由：仓库既有扫码做法就是这一套
    （`quark_provider.login_qrcode()` 返回同款 data URL，前端直接 `<img :src>`），
    前端零新依赖、无 SVG 字体/渲染差异；载荷约 220 字节 → QR 版本 ~10（纠错 M），
    在设置页 220px 渲染尺寸下手机可稳定扫描。
    """
    try:
        import qrcode
    except ImportError:  # 精简环境未装 qrcode（requirements 里有，兜底不崩）
        logger.warning("qrcode 未安装，无法生成配对二维码（pip install qrcode pillow）")
        return None
    try:
        image = qrcode.make(text)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
    except Exception:  # noqa: BLE001 - pillow/编码异常一律降级为纯文本载荷
        logger.warning("配对二维码生成失败", exc_info=True)
        return None
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


@router.get("/api/lansync/status")
def api_lansync_status():
    """服务状态：running / port / device_name / protocol_version（+ available / error 降级信息）。"""
    service = lansync_host.get_service()
    if service is None:
        return {
            "available": False,
            "running": False,
            "port": 0,
            "device_name": None,
            "protocol_version": PROTOCOL_VERSION,
            "error": lansync_host.last_error(),
        }
    status = dict(service.status)
    status["available"] = True
    status["error"] = lansync_host.last_error()
    return status


@router.get("/api/lansync/identity")
def api_lansync_identity():
    """本机身份：全量 Device ID / 分组展示（每 7 字符一组）/ 首末组核对 / Ed25519 公钥。"""
    info = dict(_require_service().identity_info)
    groups = [part for part in str(info.get("device_id_formatted") or "").split("-") if part]
    pairs = short_comparison_parts(str(info.get("device_id") or "")) or ("", "")
    info["device_id_groups"] = groups
    info["short_parts"] = list(pairs)
    return info


@router.post("/api/lansync/pairing/start")
def api_lansync_pairing_start():
    """生成并展示配对二维码（**重复调用 = 换新码并作废旧码**，由 service.start_pairing 保证）。"""
    payload = _require_running_service().start_pairing()
    text = str(payload.get("qr_payload") or "")
    return {
        "qr_payload": text,
        "nonce": payload.get("nonce", ""),
        "qr_image": _qr_data_url(text) if text else None,
    }


@router.post("/api/lansync/pairing/stop")
def api_lansync_pairing_stop():
    """停止展示二维码（作废当前 nonce；已配对设备的重连不受影响）。"""
    _require_running_service().stop_pairing()
    return {"ok": True}


@router.get("/api/lansync/pairing/pending")
def api_lansync_pairing_pending():
    """待批准配对请求列表（UI 1s 轮询；配合 /events 实时刷新）。"""
    return {"requests": _require_running_service().pending_pairs}


@router.post("/api/lansync/pairing/{request_id}/approve")
def api_lansync_pairing_approve(request_id: str, body: dict | None = None):
    """批准配对：落信任记录 + 回 approved + 进 ready（display_name 可选，缺省用建议名）。"""
    service = _require_running_service()
    display_name = None
    if isinstance(body, dict):
        raw = body.get("display_name")
        display_name = str(raw).strip() if isinstance(raw, str) and raw.strip() else None
    if not service.approve_pair(request_id, display_name):
        raise HTTPException(404, NO_REQUEST_DETAIL)
    return {"ok": True, "approved": True}


@router.post("/api/lansync/pairing/{request_id}/reject")
def api_lansync_pairing_reject(request_id: str, body: dict | None = None):
    """拒绝配对：回 approved=false（可带 reason）后断连。"""
    service = _require_running_service()
    reason = None
    if isinstance(body, dict):
        raw = body.get("reason")
        reason = str(raw).strip() if isinstance(raw, str) and raw.strip() else None
    if not service.reject_pair(request_id, reason):
        raise HTTPException(404, NO_REQUEST_DETAIL)
    return {"ok": True, "approved": False}


@router.post("/api/lansync/pairing/{request_id}/cancel")
def api_lansync_pairing_cancel(request_id: str):
    """取消发起中的配对会话（直接断连，会话侧不视为"拒绝"）。"""
    if not _require_running_service().cancel_pair(request_id):
        raise HTTPException(404, NO_REQUEST_DETAIL)
    return {"ok": True}


@router.get("/api/lansync/devices")
def api_lansync_devices():
    """已配对设备列表（在线状态 / 会话阶段 / 最近连接；服务未启动时返回本地信任表）。"""
    return {"devices": _require_service().devices()}


@router.delete("/api/lansync/devices/{peer_id}")
def api_lansync_device_remove(peer_id: str):
    """撤销配对：断开该设备会话 + 删信任记录（幂等接口，未记录 → 404）。"""
    if not _require_service().remove_device(peer_id):
        raise HTTPException(404, "该设备未配对")
    return {"ok": True}


@router.get("/api/lansync/events")
def api_lansync_events(cursor: int = 0):
    """事件轮询：返回 `seq > cursor` 的事件与新游标（UI 据此刷新批准卡/设备状态）。"""
    service = _require_service()
    new_cursor, events = service.events_since(cursor)
    return {"cursor": new_cursor, "events": events}


# -------------------------------------------- 内容同步（S3a 推送 / S3b 拉取）
#
# 本段**只有 HTTP 形状**：取服务 → 调 `SyncService` → 错误映射。
# 选择集语义、对账、逐文件传输、事件产出全在 `app/lansync/`（push / pull / service）。


class PushBody(BaseModel):
    """`POST /api/lansync/push` 请求体（`selection: null` = 本端全库）。"""

    peer_id: str
    selection: dict[str, Any] | None = None


class PullPreviewBody(BaseModel):
    """`POST /api/lansync/pull/preview` 请求体（`scope` 缺省 = 对端曲目清单）。"""

    peer_id: str
    scope: str | None = None
    query: str | None = None
    offset: int = 0
    limit: int | None = None


class PullBody(BaseModel):
    """`POST /api/lansync/pull` 请求体（`relative_paths: null` = 对端全库）。"""

    peer_id: str
    relative_paths: list[str] | None = None


@router.post("/api/lansync/push")
def api_lansync_push(body: PushBody):
    """发起「推送到设备」：建推送运行并返回 `run_id`。

    进度 / 账目走 `GET /api/lansync/push/{run_id}` 与 `/events`（`type: "push"`）。
    该设备无就绪会话 / 选择集非法 → 400（`PushError`）。
    """
    service = _require_running_service()
    try:
        run_id = service.push_selection(body.peer_id, selection=body.selection)
    except PushError as error:
        raise HTTPException(400, str(error)) from error
    return {"run_id": run_id}


@router.get("/api/lansync/push/{run_id}")
def api_lansync_push_status(run_id: str):
    """推送进度 / 账目（`LibraryPushRun.status` 原样返回）；未知 `run_id` → 404。"""
    status = _require_running_service().push_status(run_id)
    if not status:
        raise HTTPException(404, NO_RUN_DETAIL)
    return status


@router.post("/api/lansync/push/{run_id}/cancel")
def api_lansync_push_cancel(run_id: str):
    """取消推送：已终态 / 未知 `run_id` → `cancelled: false`（幂等，不报 404）。"""
    return {"cancelled": _require_running_service().cancel_push(run_id)}


@router.post("/api/lansync/pull/preview")
def api_lansync_pull_preview(body: PullPreviewBody):
    """请求对端内容清单的**一页**（帧 15），返回本端请求描述（帧 16 异步到达）。

    返回 `{"request_id", "scope", "offset", "limit"}`：`request_id` 用于与 `/events` 的
    `type: "pull"` / `action: "preview"` 事件配对；`limit` 缺省取
    :data:`~app.lansync.pull.DEFAULT_PAGE_LIMIT`（越界由对端钳制，§13.2）。
    该设备无就绪会话 → 400（`PullError`）。
    """
    service = _require_running_service()
    limit = DEFAULT_PAGE_LIMIT if body.limit is None else body.limit
    try:
        return service.pull_preview(
            body.peer_id,
            scope=body.scope,
            query=body.query,
            offset=body.offset,
            limit=limit,
        )
    except PullError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/api/lansync/pull")
def api_lansync_pull(body: PullBody):
    """发起「从设备拉取」：建拉取运行并返回 `run_id`。

    进度 / 账目走 `GET /api/lansync/pull/{run_id}` 与 `/events`（`type: "pull"`）。
    该设备无就绪会话 / 发送失败 → 400（`PullError`）。
    """
    service = _require_running_service()
    try:
        run_id = service.pull_selection(body.peer_id, relative_paths=body.relative_paths)
    except PullError as error:
        raise HTTPException(400, str(error)) from error
    return {"run_id": run_id}


@router.get("/api/lansync/pull/{run_id}")
def api_lansync_pull_status(run_id: str):
    """拉取进度 / 账目（`LibraryPullRun.status` 原样返回）；未知 `run_id` → 404。"""
    status = _require_running_service().pull_status(run_id)
    if not status:
        raise HTTPException(404, NO_RUN_DETAIL)
    return status


@router.post("/api/lansync/pull/{run_id}/cancel")
def api_lansync_pull_cancel(run_id: str):
    """取消拉取：已终态 / 未知 `run_id` → `cancelled: false`（幂等，不报 404）。"""
    return {"cancelled": _require_running_service().cancel_pull(run_id)}
