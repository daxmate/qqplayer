"""配对服务：移动端 companion 配对核心逻辑（限流 / token 生成与哈希 / 请求生命周期）。

设计定案（PLANNING.md 2026-08-22）：
- pending 请求 5 分钟超时（state.PAIRING_TTL_SECONDS）→ status 返 expired 并清理
- approve 生成 64 位随机 token（secrets.token_urlsafe(48)），SHA-256 哈希后落盘（绝不存明文）
- token 明文仅经 status 端点返回一次给发起方（内存态，取出即焚）
- 限流按 device_id：连续 3 次内正常，第 4 次起指数退避（base 60s：60/120/240…），
  两次请求间隔 >10min 重置计数（state.PAIRING_RATE_RESET_SECONDS）

多桌面配对（任务 C 定案）：
- 每台桌面实例持有一个持久化 instance_id（server_id，UUID，首次启动生成存 pairing.json；
  不用 mDNS hostname——主机名会变）
- 配对条目以 (server_id, device_id) 联合唯一：同一 iPhone 可同时配对家里 Mac、公司 Mac，
  各 token 独立共存互不顶替；同一桌面实例内重复配对才替换旧 token（原语义缩小到同实例）
- 撤销按 (server_id, device_id) 维度（DELETE /devices/{server_id}/{device_id}）；
  旧单参 DELETE /devices/{device_id} 保留，语义 = 删除该设备在所有实例的配对
- verify_token 按 token 哈希命中即通过（token 本身已绑定 (server_id, device_id)），刷新 last_seen_at
"""

import hashlib
import secrets
import threading
import time
import uuid
from datetime import datetime, timedelta

from app import db, state

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


def get_server_id() -> str:
    """桌面实例 ID（持久化）：首次调用生成 UUID 并落盘 pairing.json，之后恒返回同一值。

    多桌面配对按 (server_id, device_id) 维度区分 token 归属。UUID 在首次启动生成后不再变，
    不用 mDNS hostname（主机名会变，同一台机器改主机名后配对关系会错乱）。
    """
    data = db.pairing_load()
    sid = data.get("server_id")
    if not sid:
        sid = uuid.uuid4().hex
        data["server_id"] = sid
        db.pairing_save(data)
    return sid


def _server_id_of(entry: dict) -> str:
    """条目的有效 server_id：老数据（多桌面功能前的配对）没有 server_id 字段，
    视为属于当前实例（数据目录归本机所有，旧配对必然是本实例配的）。"""
    return entry.get("server_id") or get_server_id()


def load_pending() -> list[dict]:
    """待确认请求列表（惰性清理过期项并落盘）。"""
    data = db.pairing_load()
    pending = data.setdefault("pending", [])
    cutoff = datetime.now() - timedelta(seconds=state.PAIRING_TTL_SECONDS)
    fresh = [p for p in pending if _parse_iso(p.get("created_at", "")) >= cutoff]
    if len(fresh) != len(pending):
        data["pending"] = fresh
        db.pairing_save(data)
    return fresh


def find_pending(request_id: str) -> dict | None:
    """按 request_id 查找未过期 pending 请求；过期项直接清理。"""
    data = db.pairing_load()
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
        db.pairing_save(data)
    return found


def create_request(device_id: str, device_name: str, device_type: str) -> str:
    """创建配对请求：限流通过则入 pending 队列并返回 request_id。

    限流拒绝时抛 RateLimited（Router 层转 429）。
    """
    if not _rate_limit_ok(device_id):
        raise RateLimited()
    request_id = uuid.uuid4().hex
    data = db.pairing_load()
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
    db.pairing_save(data)
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

    多桌面语义：配对条目以 (server_id, device_id) 联合唯一——同一设备在另一台桌面实例上
    配对生成独立 token 互不顶替；仅同一实例内重复配对替换旧 token（原语义缩小到同实例）。
    返回 {"status": "approved"}；请求不存在/已过期抛 KeyError（Router 层转 404）。
    """
    req = find_pending(request_id)
    if req is None:
        raise KeyError(request_id)
    token = secrets.token_urlsafe(48)  # 64 字符
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    device_id = req["device_id"]
    server_id = get_server_id()
    now = _now_iso()
    data = db.pairing_load()
    devices = data.setdefault("devices", [])
    existing = next(
        (d for d in devices if d.get("device_id") == device_id and _server_id_of(d) == server_id),
        None,
    )
    if existing is None:
        # 双保险：同实例下同名同类型设备视为同一台（覆盖卸载重装后 device_id 变化的场景，
        # 如 identifierForVendor 也失效；2026-08-24 真机重复记录根因）。
        existing = next(
            (
                d
                for d in devices
                if d.get("device_name") == req.get("device_name")
                and d.get("device_type") == req.get("device_type")
                and _server_id_of(d) == server_id
            ),
            None,
        )
    if existing is None:
        devices.append(
            {
                "server_id": server_id,
                "device_id": device_id,
                "device_name": req.get("device_name", ""),
                "device_type": req.get("device_type", ""),
                "token_hash": token_hash,
                "created_at": now,
                "last_seen_at": now,
                "note": "",
            }
        )
    else:
        # 同实例重复配对（同一设备再次发起）：替换 token，旧 token 立即失效
        existing["server_id"] = server_id  # 老数据迁移：补上 server_id 字段
        existing["device_id"] = device_id  # 同步最新 device_id（fallback 按名匹配时旧 id 已过期）
        existing["device_name"] = req.get("device_name", existing.get("device_name", ""))
        existing["device_type"] = req.get("device_type", existing.get("device_type", ""))
        existing["token_hash"] = token_hash
        existing["last_seen_at"] = now
    data["pending"] = [p for p in data.get("pending", []) if p.get("request_id") != request_id]
    db.pairing_save(data)
    with _RESOLVED_LOCK:
        _RESOLVED[request_id] = {
            "status": "approved",
            "token": token,
            "expires": time.monotonic() + _RESOLVED_TTL_SECONDS,
        }
    return {"status": "approved"}


def reject(request_id: str) -> dict:
    """拒绝配对：从 pending 清理，status 记录为 rejected（幂等，重复拒绝仍 200）。"""
    data = db.pairing_load()
    before = len(data.get("pending", []))
    data["pending"] = [p for p in data.get("pending", []) if p.get("request_id") != request_id]
    if len(data["pending"]) != before:
        db.pairing_save(data)
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
    data = db.pairing_load()
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
            db.pairing_save(data)
            return {"status": "expired"}
        fresh.append(p)
    if len(fresh) != len(pending):
        data["pending"] = fresh
        db.pairing_save(data)
    raise KeyError(request_id)


def list_devices() -> list[dict]:
    """已配对设备列表（不含 token_hash）；每条含 server_id（iOS 端区分"哪台桌面"）与 note（用户备注）"""
    devices = db.pairing_load().get("devices", [])
    return [
        {
            "server_id": _server_id_of(d),
            "device_id": d.get("device_id", ""),
            "device_name": d.get("device_name", ""),
            "device_type": d.get("device_type", ""),
            "created_at": d.get("created_at", ""),
            "last_seen_at": d.get("last_seen_at", ""),
            "note": d.get("note", ""),  # 老数据无 note → 空串兜底
        }
        for d in devices
    ]


def update_note(server_id: str, device_id: str, note: str) -> dict | None:
    """更新已配对设备的用户备注（区分多台重名设备）。

    按 (server_id, device_id) 定位条目并更新 note 落盘，返回更新后的条目 dict（含 note）；
    找不到匹配条目返回 None。note 清洗：strip 去首尾空白，超 50 字符截断（前端同限）。
    """
    clean = note.strip()[:50]
    data = db.pairing_load()
    devices = data.get("devices", [])
    for d in devices:
        if d.get("device_id") == device_id and _server_id_of(d) == server_id:
            d["note"] = clean
            db.pairing_save(data)
            return {
                "server_id": _server_id_of(d),
                "device_id": d.get("device_id", ""),
                "device_name": d.get("device_name", ""),
                "device_type": d.get("device_type", ""),
                "created_at": d.get("created_at", ""),
                "last_seen_at": d.get("last_seen_at", ""),
                "note": d.get("note", ""),
            }
    return None


def revoke(device_id: str, server_id: str | None = None) -> dict:
    """撤销配对：删除设备记录，对应 token 立即失效（幂等，重复撤销仍 200）。

    server_id 指定 → 只撤销该设备在该桌面实例的配对（DELETE /devices/{server_id}/{device_id}）；
    server_id 省略 → 撤销该设备在所有实例的配对（旧单参 DELETE /devices/{device_id} 兼容）。
    """
    data = db.pairing_load()
    devices = data.get("devices", [])
    if server_id:
        kept = [
            d
            for d in devices
            if not (d.get("device_id") == device_id and _server_id_of(d) == server_id)
        ]
    else:
        kept = [d for d in devices if d.get("device_id") != device_id]
    if len(kept) != len(devices):
        data["devices"] = kept
        db.pairing_save(data)
    return {"status": "revoked", "device_id": device_id, "server_id": server_id or "*"}


def verify_token(token: str) -> bool:
    """鉴权：token SHA-256 后与已配对设备比对；命中则刷新该条目 last_seen_at。

    token 本身已绑定 (server_id, device_id)，哈希命中即通过（不额外校验 server_id——
    本实例的 pairing.json 里所有条目都是本实例发的 token）。"""
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    data = db.pairing_load()
    devices = data.get("devices", [])
    now = _now_iso()
    for d in devices:
        if d.get("token_hash") == token_hash:
            if d.get("last_seen_at") != now:
                d["last_seen_at"] = now
                db.pairing_save(data)
            return True
    return False
