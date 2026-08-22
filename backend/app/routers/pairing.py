"""移动端配对路由：/api/pairing/*（companion 配对 API，白名单免鉴权）。

- POST   /api/pairing/request              发起配对（限流）
- GET    /api/pairing/pending              待确认请求（桌面壳 1-2s 轮询）
- POST   /api/pairing/request/:id/approve  确认 → 生成 token（SHA-256 哈希落盘）
- POST   /api/pairing/request/:id/reject   拒绝
- GET    /api/pairing/request/:id/status   查询状态（approved 时附 token，仅一次）
- GET    /api/pairing/devices              已配对设备列表（含 server_id，区分"哪台桌面"）
- DELETE /api/pairing/devices/:server_id/:device_id  撤销该设备在某台桌面的配对（新增）
- DELETE /api/pairing/devices/:device_id   旧接口兼容：撤销该设备在所有桌面的配对

多桌面语义（任务 C 定案）：配对条目 (server_id, device_id) 联合唯一，同一 iPhone 可同时
配对多台桌面（各 token 独立共存）；同实例重复配对才替换旧 token。
"""

from fastapi import APIRouter, HTTPException

from app.services import pairing as pairing_service

router = APIRouter()


@router.post("/api/pairing/request")
def api_pairing_request(body: dict):
    """发起配对：device_id 必填；同一设备限流（3 次后指数退避，超限 429）。"""
    device_id = body.get("device_id")
    if not device_id or not str(device_id).strip():
        raise HTTPException(400, "缺少 device_id")
    device_id = str(device_id).strip()
    device_name = str(body.get("device_name", "")).strip() or device_id
    device_type = str(body.get("device_type", "")).strip() or "unknown"
    try:
        request_id = pairing_service.create_request(device_id, device_name, device_type)
    except pairing_service.RateLimited:
        raise HTTPException(429, "配对请求过于频繁，请稍后再试") from None
    return {"request_id": request_id}


@router.get("/api/pairing/pending")
def api_pairing_pending():
    """待确认请求列表（过期项已惰性清理）"""
    return {
        "requests": [
            {
                "request_id": p.get("request_id"),
                "device_name": p.get("device_name", ""),
                "device_type": p.get("device_type", ""),
                "created_at": p.get("created_at", ""),
            }
            for p in pairing_service.load_pending()
        ]
    }


@router.post("/api/pairing/request/{request_id}/approve")
def api_pairing_approve(request_id: str):
    """确认配对：生成 64 位 token（SHA-256 哈希存储），返回 200"""
    try:
        return pairing_service.approve(request_id)
    except KeyError:
        raise HTTPException(404, "配对请求不存在或已过期") from None


@router.post("/api/pairing/request/{request_id}/reject")
def api_pairing_reject(request_id: str):
    """拒绝配对（幂等：请求不存在/已处理也返回 200）"""
    return pairing_service.reject(request_id)


@router.get("/api/pairing/request/{request_id}/status")
def api_pairing_status(request_id: str):
    """查询配对状态：pending|approved|rejected|expired；approved 附 token（仅此一次）"""
    try:
        return pairing_service.status(request_id)
    except KeyError:
        raise HTTPException(404, "配对请求不存在或已过期") from None


@router.get("/api/pairing/devices")
def api_pairing_devices():
    """已配对设备列表（不含 token_hash）"""
    return {"devices": pairing_service.list_devices()}


@router.delete("/api/pairing/devices/{server_id}/{device_id}")
def api_pairing_revoke_on_server(server_id: str, device_id: str):
    """撤销该设备在某台桌面的配对（按 server_id + device_id 维度，token 立即失效）"""
    return pairing_service.revoke(device_id=device_id, server_id=server_id)


@router.delete("/api/pairing/devices/{device_id}")
def api_pairing_revoke(device_id: str):
    """撤销配对（旧接口兼容）：删除该设备在所有桌面实例的配对记录，token 立即失效（幂等）"""
    return pairing_service.revoke(device_id=device_id)
