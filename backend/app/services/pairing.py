"""配对服务：移动端 companion 配对核心逻辑（限流 / token 生成与哈希 / 请求生命周期）。

设计定案（PLANNING.md 2026-08-22）：
- pending 请求 5 分钟超时（state.PAIRING_TTL_SECONDS）→ status 返 expired 并清理
- approve 生成 64 位随机 token（secrets.token_urlsafe(48)），SHA-256 哈希后落盘（绝不存明文）
- token 明文仅经 status 端点返回一次给发起方（内存态，取出即焚）
- 限流按 device_id：连续 3 次内正常，第 4 次起指数退避（base 60s：60/120/240…），
  两次请求间隔 >10min 重置计数（state.PAIRING_RATE_RESET_SECONDS）
"""

import hashlib
import secrets
import threading
import time
import uuid
from datetime import datetime, timedelta

from app import state

# 已决请求内存态：request_id -> {"status": "approved"|"rejected"|"expired", "token": str|None}
# 只存内存不落盘（token 明文仅此一次返回给发起方；重启后丢失 → 客户端重配对即可）
_RESOLVED: dict[str, dict] = {}
_RESOLVED_LOCK = threading.Lock()
# resolved 记录保留时长（超过后 status 查不到返 404，客户端按未配对处理）
_RESOLVED_TTL_SECONDS = 3600

# 限流内存态：device_id -> [请求时间戳...]（只保留重置窗口内的记录）
_RATE_LIMITS: dict[str, list[float]] = {}
_RATE_LOCK = threading.Lock()


def _now_iso() -> str:
    """ISO 时间戳（秒级，与 favorites/playback 等存储同风格）"""
    return datetime.now().isoformat(timespec="seconds")


def _parse_iso(value: str) -> datetime:
    """解析存储里的 ISO 时间戳；非法时回退 epoch（视为早已过期）"""
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return datetime.fromtimestamp(0)


def load_pending() -> list[dict]:
    """待确认请求列表（惰性清理过期项并落盘）。"""
    data = state.pairing_store.load()
    pending = data.setdefault("pending", [])
    cutoff = datetime.now() - timedelta(seconds=state.PAIRING_TTL_SECONDS)
    fresh = [p for p in pending if _parse_iso(p.get("created_at", "")) >= cutoff]
    if len(fresh) != len(pending):
        data["pending"] = fresh
        state.pairing_store.save(data)
    return fresh


def find_pending(request_id: str) -> dict | None:
    """按 request_id 查找未过期 pending 请求；过期项直接清理。"""
    data = state.pairing_store.load()
    pending = data.setdefault("pending", [])
    cutoff = datetime.now() - timedelta(seconds=state.PAIRING_TTL_SECONDS)
    fresh = []
    found = None
    for p in pending:
        if _parse_iso(p.get("created_at", "")) >= cutoff:
            fresh.append(p)
            if p.get("request_id") == request_id:
                found = p
        elif p.get("request_id") == request_id:
            found = None  # 已过期：等价于不存在，且从队列清掉
    if len(fresh) != len(pending):
        data["pending"] = fresh
        state.pairing_store.save(data)
    return found


def create_request(device_id: str, device_name: str, device_type: str) -> str:
    """创建配对请求：限流通过则入 pending 队列并返回 request_id。

    限流拒绝时抛 RateLimited（Router 层转 429）。
    """
    if not _rate_limit_ok(device_id):
        raise RateLimited()
    request_id = uuid.uuid4().hex
    data = state.pairing_store.load()
    pending = data.setdefault("pending", [])
    pending.append(
        {
            "request_id": request_id,
            "device_id": device_id,
            "device_name": device_name,
            "device_type": device_type,
            "created_at": _now_iso(),
        }
    )
    state.pairing_store.save(data)
    return request_id


class RateLimited(Exception):
    """配对请求限流：第 4 次起指数退避期间被拒绝（Router 层转 429）"""


def _rate_limit_ok(device_id: str) -> bool:
    """限流判定（按 device_id）：连续 3 次内放行；第 n 次（n>=4）需距上次
    base * 2^(n-4) 秒；与上次间隔 > 重置窗口时计数清零重新计。"""
    now = time.monotonic()
    base = state.PAIRING_RATE_BASE_SECONDS
    reset = state.PAIRING_RATE_RESET_SECONDS
    with _RATE_LOCK:
        times = [t for t in _RATE_LIMITS.get(device_id, []) if now - t < reset]
        if not times or now - times[-1] > reset:
            times = []  # 与上次间隔超重置窗口 → 重新计数
        n = len(times) + 1  # 本次请求将是第 n 次
        if n <= 3:
            times.append(now)
            _RATE_LIMITS[device_id] = times
            return True
        required = base * (2 ** (n - 4))
        if now - times[-1] >= required:
            times.append(now)
            _RATE_LIMITS[device_id] = times
            return True
        return False


def _clear_rate_limits() -> None:
    """清空限流状态（测试隔离用）"""
    with _RATE_LOCK:
        _RATE_LIMITS.clear()


def approve(request_id: str) -> dict:
    """确认配对：生成 64 位 token（SHA-256 哈希落盘），返回结果描述。

    返回 {"status": "approved"}；请求不存在/已过期抛 KeyError（Router 层转 404）。
    """
    req = find_pending(request_id)
    if req is None:
        raise KeyError(request_id)
    token = secrets.token_urlsafe(48)  # 64 字符
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    device_id = req["device_id"]
    now = _now_iso()
    data = state.pairing_store.load()
    devices = data.setdefault("devices", [])
    existing = next((d for d in devices if d.get("device_id") == device_id), None)
    if existing is None:
        devices.append(
            {
                "device_id": device_id,
                "device_name": req.get("device_name", ""),
                "device_type": req.get("device_type", ""),
                "token_hash": token_hash,
                "created_at": now,
                "last_seen_at": now,
            }
        )
    else:
        # 重复配对（同一设备再次发起）：替换 token，旧 token 立即失效
        existing["device_name"] = req.get("device_name", existing.get("device_name", ""))
        existing["device_type"] = req.get("device_type", existing.get("device_type", ""))
        existing["token_hash"] = token_hash
        existing["last_seen_at"] = now
    data["pending"] = [p for p in data.get("pending", []) if p.get("request_id") != request_id]
    state.pairing_store.save(data)
    with _RESOLVED_LOCK:
        _RESOLVED[request_id] = {
            "status": "approved",
            "token": token,
            "expires": time.monotonic() + _RESOLVED_TTL_SECONDS,
        }
    return {"status": "approved"}


def reject(request_id: str) -> dict:
    """拒绝配对：从 pending 清理，status 记录为 rejected（幂等，重复拒绝仍 200）。"""
    data = state.pairing_store.load()
    before = len(data.get("pending", []))
    data["pending"] = [p for p in data.get("pending", []) if p.get("request_id") != request_id]
    if len(data["pending"]) != before:
        state.pairing_store.save(data)
    with _RESOLVED_LOCK:
        _RESOLVED[request_id] = {
            "status": "rejected",
            "token": None,
            "expires": time.monotonic() + _RESOLVED_TTL_SECONDS,
        }
    return {"status": "rejected"}


def status(request_id: str) -> dict:
    """查询配对请求状态：pending|approved|rejected|expired。

    approved 时附明文 token（仅此一次：取出即焚，之后只返 approved 不带 token）。
    未知 request_id 抛 KeyError（Router 层转 404）。
    """
    # 1) 已决请求（approved/rejected/expired）走内存态
    with _RESOLVED_LOCK:
        entry = _RESOLVED.get(request_id)
        if entry is not None and entry["expires"] >= time.monotonic():
            if entry["status"] == "approved":
                token = entry["token"]
                entry["token"] = None  # 明文仅此一次
                result = {"status": "approved", "token": token} if token else {"status": "approved"}
                return result
            return {"status": entry["status"]}
    # 2) pending 队列（含超时判定）
    data = state.pairing_store.load()
    pending = data.setdefault("pending", [])
    cutoff = datetime.now() - timedelta(seconds=state.PAIRING_TTL_SECONDS)
    fresh = []
    for p in pending:
        if p.get("request_id") == request_id:
            if _parse_iso(p.get("created_at", "")) >= cutoff:
                return {"status": "pending"}
            # 过期：清理 + 记录 expired
            with _RESOLVED_LOCK:
                _RESOLVED[request_id] = {
                    "status": "expired",
                    "token": None,
                    "expires": time.monotonic() + _RESOLVED_TTL_SECONDS,
                }
            data["pending"] = [q for q in pending if q.get("request_id") != request_id]
            state.pairing_store.save(data)
            return {"status": "expired"}
        fresh.append(p)
    if len(fresh) != len(pending):
        data["pending"] = fresh
        state.pairing_store.save(data)
    raise KeyError(request_id)


def list_devices() -> list[dict]:
    """已配对设备列表（不含 token_hash）"""
    devices = state.pairing_store.load().get("devices", [])
    return [
        {
            "device_id": d.get("device_id", ""),
            "device_name": d.get("device_name", ""),
            "device_type": d.get("device_type", ""),
            "created_at": d.get("created_at", ""),
            "last_seen_at": d.get("last_seen_at", ""),
        }
        for d in devices
    ]


def revoke(device_id: str) -> dict:
    """撤销配对：删除设备记录，该 token 立即失效（幂等，重复撤销仍 200）。"""
    data = state.pairing_store.load()
    devices = data.get("devices", [])
    kept = [d for d in devices if d.get("device_id") != device_id]
    if len(kept) != len(devices):
        data["devices"] = kept
        state.pairing_store.save(data)
    return {"status": "revoked", "device_id": device_id}


def verify_token(token: str) -> bool:
    """鉴权：token SHA-256 后与已配对设备比对；命中则刷新该设备 last_seen_at。"""
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    data = state.pairing_store.load()
    devices = data.get("devices", [])
    now = _now_iso()
    for d in devices:
        if d.get("token_hash") == token_hash:
            if d.get("last_seen_at") != now:
                d["last_seen_at"] = now
                state.pairing_store.save(data)
            return True
    return False
