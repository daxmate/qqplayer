"""移动端配对 API 测试：配对流程 / 限流 / 超时 / 鉴权 / 撤销 / last_seen 刷新。

运行：cd backend && ./venv/bin/python -m pytest tests/test_pairing.py -q
"""

import asyncio
import hashlib
import json
import time

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

import backend
from app import db, state
from app.services import pairing as pairing_service

client = TestClient(backend.app)

REMOTE_HOST = "192.168.1.50"  # 模拟局域网 iOS 设备（非 localhost）


def _remote(method: str, path: str, host: str = REMOTE_HOST, **kwargs) -> tuple[int, dict]:
    """以指定来源 IP 发起请求（ASGITransport 可注入 client host；httpx 0.28 为 async-only）"""

    async def _run():
        transport = ASGITransport(app=backend.app, client=(host, 50000))
        async with AsyncClient(transport=transport, base_url="http://testserver") as c:
            r = await c.request(method, path, **kwargs)
            try:
                body = r.json()
            except ValueError:
                body = None
            return r.status_code, body

    return asyncio.run(_run())


@pytest.fixture(autouse=True)
def _isolate_pairing(tmp_path, monkeypatch):
    """配对存储隔离：pairing.json 写临时目录；内存态（已决请求/限流）每测试清空"""
    monkeypatch.setattr(state, "PAIRING_FILE", tmp_path / "pairing.json")
    monkeypatch.setattr(state, "AUTH_ENABLED", False)
    with pairing_service._RESOLVED_LOCK:
        pairing_service._RESOLVED.clear()
    pairing_service._clear_rate_limits()
    yield


def _pair_device(device_id="iphone-01", name="iPhone 15", dtype="ios") -> tuple[str, str]:
    """完整配对流程 → (request_id, token)；token 从 status 拿到（明文仅此一次）"""
    r = client.post(
        "/api/pairing/request",
        json={"device_id": device_id, "device_name": name, "device_type": dtype},
    )
    assert r.status_code == 200
    request_id = r.json()["request_id"]
    assert client.post(f"/api/pairing/request/{request_id}/approve").status_code == 200
    st = client.get(f"/api/pairing/request/{request_id}/status").json()
    assert st["status"] == "approved"
    return request_id, st["token"]


def _switch_server_id(server_id: str) -> None:
    """模拟"换了一台桌面实例"：改写 pairing.json 里的 server_id（get_server_id 返回新值）"""
    data = db.pairing_load()
    data["server_id"] = server_id
    db.pairing_save(data)


# ============ 配对流程 ============


def test_request_enters_pending():
    r = client.post(
        "/api/pairing/request",
        json={"device_id": "pad-01", "device_name": "iPad", "device_type": "ios"},
    )
    assert r.status_code == 200
    request_id = r.json()["request_id"]
    assert request_id
    pending = client.get("/api/pairing/pending").json()["requests"]
    assert any(p["request_id"] == request_id for p in pending)
    entry = next(p for p in pending if p["request_id"] == request_id)
    assert entry["device_name"] == "iPad"
    assert entry["device_type"] == "ios"
    assert entry["created_at"]


def test_request_requires_device_id():
    for body in ({}, {"device_name": "x"}, {"device_id": "  "}, {"device_id": None}):
        assert client.post("/api/pairing/request", json=body).status_code == 400, body


def test_approve_generates_token_hash_only():
    request_id, token = _pair_device()
    assert len(token) == 64  # secrets.token_urlsafe(48)
    # 落盘只存 SHA-256 哈希，绝不存明文
    data = db.pairing_load()
    device = next(d for d in data["devices"] if d["device_id"] == "iphone-01")
    assert device["token_hash"] == hashlib.sha256(token.encode("utf-8")).hexdigest()
    raw = json.dumps(data)
    assert token not in raw, "配对存储绝不能出现明文 token"
    # pending 已清理
    assert data["pending"] == []


def test_status_token_delivered_once():
    request_id, token = _pair_device()
    # 第二次查询：仍 approved 但不再附 token（明文仅此一次）
    st = client.get(f"/api/pairing/request/{request_id}/status").json()
    assert st == {"status": "approved"}


def test_reject_flow():
    r = client.post("/api/pairing/request", json={"device_id": "tv-01", "device_name": "TV"})
    request_id = r.json()["request_id"]
    assert client.post(f"/api/pairing/request/{request_id}/reject").status_code == 200
    st = client.get(f"/api/pairing/request/{request_id}/status").json()
    assert st == {"status": "rejected"}
    # 从待确认队列清理；重复拒绝幂等 200
    assert client.get("/api/pairing/pending").json()["requests"] == []
    assert client.post(f"/api/pairing/request/{request_id}/reject").status_code == 200


def test_status_unknown_request_404():
    assert client.get("/api/pairing/request/no-such-id/status").status_code == 404
    assert client.post("/api/pairing/request/no-such-id/approve").status_code == 404


def test_pending_expired(monkeypatch):
    """pending 5 分钟超时 → status 返 expired，并从待确认队列清理"""
    monkeypatch.setattr(state, "PAIRING_TTL_SECONDS", -1)  # 让所有请求即刻过期
    r = client.post("/api/pairing/request", json={"device_id": "old-01", "device_name": "Old"})
    request_id = r.json()["request_id"]
    st = client.get(f"/api/pairing/request/{request_id}/status").json()
    assert st == {"status": "expired"}
    # 队列已清理；后续查询从内存态仍返 expired（不是 404）
    assert client.get("/api/pairing/pending").json()["requests"] == []
    assert client.get(f"/api/pairing/request/{request_id}/status").json() == {"status": "expired"}


def test_pending_list_prunes_expired(monkeypatch):
    """GET /api/pairing/pending 惰性清理过期项"""
    monkeypatch.setattr(state, "PAIRING_TTL_SECONDS", -1)
    r = client.post("/api/pairing/request", json={"device_id": "old-02"})
    assert r.status_code == 200
    assert client.get("/api/pairing/pending").json()["requests"] == []


# ============ 限流 ============


def test_rate_limit_exponential_backoff(monkeypatch):
    """连续 3 次内正常；第 4 次起指数退避（base 60s → 测试缩短为 0.3s）"""
    monkeypatch.setattr(state, "PAIRING_RATE_BASE_SECONDS", 0.3)
    for i in range(3):
        r = client.post("/api/pairing/request", json={"device_id": "spam-01"})
        assert r.status_code == 200, f"第 {i + 1} 次应放行"
    # 第 4 次：距上次不足 base*2^0 → 429
    r = client.post("/api/pairing/request", json={"device_id": "spam-01"})
    assert r.status_code == 429
    # 等待 base 后第 4 次放行；随后第 5 次需 base*2^1 → 立即再发仍 429
    # （base 取 0.3s：退避窗口 0.6s，慢 CI 机器上请求间隔也不易超过，防 flaky）
    time.sleep(0.35)
    assert client.post("/api/pairing/request", json={"device_id": "spam-01"}).status_code == 200
    assert client.post("/api/pairing/request", json={"device_id": "spam-01"}).status_code == 429


def test_rate_limit_other_device_unaffected(monkeypatch):
    monkeypatch.setattr(state, "PAIRING_RATE_BASE_SECONDS", 0.3)
    for _ in range(5):
        assert client.post("/api/pairing/request", json={"device_id": "spam-01"}).status_code in (
            200,
            429,
        )
    # 另一个 device_id 不受影响（计数按设备隔离）
    assert client.post("/api/pairing/request", json={"device_id": "fresh-01"}).status_code == 200


def test_rate_limit_resets_after_10min(monkeypatch):
    """两次请求间隔 >10min 重置计数（测试缩短重置窗口）"""
    monkeypatch.setattr(state, "PAIRING_RATE_BASE_SECONDS", 60)
    monkeypatch.setattr(state, "PAIRING_RATE_RESET_SECONDS", 0.05)
    for _ in range(3):
        assert client.post("/api/pairing/request", json={"device_id": "spam-02"}).status_code == 200
    assert client.post("/api/pairing/request", json={"device_id": "spam-02"}).status_code == 429
    time.sleep(0.06)  # 超过重置窗口 → 计数清零，重新从 1 计
    assert client.post("/api/pairing/request", json={"device_id": "spam-02"}).status_code == 200


# ============ 设备管理 ============


def test_devices_list_no_token_hash():
    _pair_device()
    devices = client.get("/api/pairing/devices").json()["devices"]
    assert len(devices) == 1
    d = devices[0]
    assert set(d) == {
        "server_id",
        "device_id",
        "device_name",
        "device_type",
        "created_at",
        "last_seen_at",
        "note",
    }
    assert "token_hash" not in d


def test_revoke_invalidates_token(monkeypatch):
    """撤销配对 → 该 token 立即失效（鉴权 401）"""
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    _, token = _pair_device()
    # token 有效：远端带 token 访问受保护端点成功
    code, body = _remote("GET", "/api/library", headers={"Authorization": f"Bearer {token}"})
    assert code == 200 and body["path"]
    # 撤销
    assert client.delete("/api/pairing/devices/iphone-01").status_code == 200
    assert client.get("/api/pairing/devices").json()["devices"] == []
    # token 立即失效
    code, _ = _remote("GET", "/api/library", headers={"Authorization": f"Bearer {token}"})
    assert code == 401
    # 幂等：重复撤销仍 200
    assert client.delete("/api/pairing/devices/iphone-01").status_code == 200


def test_repair_replaces_token():
    """同一设备重复配对：替换 token，旧 token 失效"""
    _, token1 = _pair_device()
    _, token2 = _pair_device()
    assert token1 != token2
    data = db.pairing_load()
    assert len(data["devices"]) == 1  # 不重复建设备
    assert data["devices"][0]["token_hash"] == hashlib.sha256(token2.encode()).hexdigest()


def test_last_seen_refreshed_on_auth(monkeypatch):
    """已配对设备每次成功鉴权刷新 last_seen_at"""
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    _, token = _pair_device()
    # 手动把 last_seen_at 拨回过去
    data = db.pairing_load()
    data["devices"][0]["last_seen_at"] = "2020-01-01T00:00:00"
    db.pairing_save(data)
    # 远端带 token 访问一次受保护端点
    code, _ = _remote("GET", "/api/library", headers={"Authorization": f"Bearer {token}"})
    assert code == 200
    devices = client.get("/api/pairing/devices").json()["devices"]
    assert devices[0]["last_seen_at"] != "2020-01-01T00:00:00"


# ============ 鉴权中间件 ============


def test_auth_401_without_token(monkeypatch):
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    code, body = _remote("GET", "/api/library")
    assert code == 401
    assert body["detail"]


def test_auth_401_invalid_token(monkeypatch):
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    code, _ = _remote("GET", "/api/library", headers={"Authorization": "Bearer not-a-real-token"})
    assert code == 401


def test_auth_200_with_valid_token(monkeypatch):
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    _, token = _pair_device()
    code, body = _remote("GET", "/api/library", headers={"Authorization": f"Bearer {token}"})
    assert code == 200
    assert body["path"] == str(state.LIBRARY)
    # /api/songs 同样受保护且放行（LIBRARY 指向不存在的临时目录 → 空列表，安全）
    code, body = _remote("GET", "/api/songs", headers={"Authorization": f"Bearer {token}"})
    assert code == 200 and body == []


def test_auth_query_token(monkeypatch):
    """?token= query 与 Bearer header 等效（浏览器/原生资源带不了 header；真机 401 修复）"""
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    _, token = _pair_device()
    code, body = _remote("GET", f"/api/library?token={token}")
    assert code == 200 and body["path"] == str(state.LIBRARY)
    # 带 query 的端点（封面/音频）同样支持
    code, _ = _remote("GET", f"/api/songs?token={token}")
    assert code == 200
    # 无效 query token → 401
    code, _ = _remote("GET", "/api/library?token=bad-token")
    assert code == 401


def test_auth_pairing_whitelist(monkeypatch):
    """白名单：/api/pairing/* 全程免鉴权（远端无 token 也能发起配对）"""
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    code, body = _remote(
        "POST", "/api/pairing/request", json={"device_id": "whitelist-01", "device_name": "X"}
    )
    assert code == 200 and body["request_id"]
    code, _ = _remote("GET", "/api/pairing/pending")
    assert code == 200
    assert _remote("GET", "/api/pairing/devices")[0] == 200


def test_auth_localhost_exempt(monkeypatch):
    """来源 127.0.0.1 → 免鉴权（本机即管理员）"""
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    code, body = _remote("GET", "/api/library", host="127.0.0.1")
    assert code == 200
    assert body["path"] == str(state.LIBRARY)


def test_auth_disabled_passes_through():
    """AUTH_ENABLED=False（测试默认）→ 全部放行"""
    assert client.get("/api/library").status_code == 200


# ============ 多桌面配对（server_id 维度，任务 C）============


def test_same_device_two_servers_two_tokens(monkeypatch):
    """同一 device 配对两台桌面（两个 server_id）→ 两个独立 token 共存，互不顶替"""
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    _, token1 = _pair_device()  # 桌面实例 A（默认 server_id）
    server_a = pairing_service.get_server_id()
    _switch_server_id("server-B")  # 模拟另一台桌面实例（各自 pairing.json 的 server_id 不同）
    _, token2 = _pair_device()
    assert server_a != pairing_service.get_server_id()
    assert token1 != token2
    # 两个 token 都有效（各自绑定 (server_id, device_id)，经鉴权中间件通过）
    assert pairing_service.verify_token(token1)
    assert pairing_service.verify_token(token2)
    code, _ = _remote("GET", "/api/library", headers={"Authorization": f"Bearer {token1}"})
    assert code == 200
    code, _ = _remote("GET", "/api/library", headers={"Authorization": f"Bearer {token2}"})
    assert code == 200
    # 落盘两个独立条目，server_id + device_id 联合唯一，token 哈希各不相同
    data = db.pairing_load()
    assert len(data["devices"]) == 2
    assert {d["server_id"] for d in data["devices"]} == {server_a, "server-B"}
    hashes = {d["token_hash"] for d in data["devices"]}
    assert hashes == {
        hashlib.sha256(token1.encode()).hexdigest(),
        hashlib.sha256(token2.encode()).hexdigest(),
    }
    # 列表接口带 server_id（iOS 端区分"哪台桌面"）
    listed = client.get("/api/pairing/devices").json()["devices"]
    assert {d["server_id"] for d in listed} == {server_a, "server-B"}


def test_same_server_repair_replaces_token_only_that_instance():
    """同一桌面实例重复配对 → 替换该实例的旧 token；另一台桌面的 token 不受影响"""
    _, token1 = _pair_device()
    server_a = pairing_service.get_server_id()
    _switch_server_id("server-B")
    _, token_b = _pair_device()
    assert pairing_service.verify_token(token1)
    assert pairing_service.verify_token(token_b)
    # 回到桌面 A 再配对同一设备 → 只替换 A 的 token
    _switch_server_id(server_a)
    _, token2 = _pair_device()
    assert token2 != token1
    assert not pairing_service.verify_token(token1)  # A 的旧 token 立即失效
    assert pairing_service.verify_token(token2)
    assert pairing_service.verify_token(token_b)  # B 桌面的 token 仍有效
    data = db.pairing_load()
    assert len(data["devices"]) == 2  # 两台桌面各一条，不合并
    by_server = {d["server_id"]: d for d in data["devices"]}
    assert by_server[server_a]["token_hash"] == hashlib.sha256(token2.encode()).hexdigest()
    assert by_server["server-B"]["token_hash"] == hashlib.sha256(token_b.encode()).hexdigest()


def test_revoke_one_server_keeps_other():
    """按 (server_id, device_id) 撤销：只删该实例的配对，另一台桌面配对与 token 不受影响"""
    _, token1 = _pair_device()
    server_a = pairing_service.get_server_id()
    _switch_server_id("server-B")
    _, token2 = _pair_device()
    # 新接口：DELETE /api/pairing/devices/{server_id}/{device_id}
    assert client.delete(f"/api/pairing/devices/{server_a}/iphone-01").status_code == 200
    assert not pairing_service.verify_token(token1)
    assert pairing_service.verify_token(token2)  # B 桌面 token 仍有效
    devices = client.get("/api/pairing/devices").json()["devices"]
    assert len(devices) == 1
    assert devices[0]["server_id"] == "server-B"
    # 幂等：重复撤销仍 200
    assert client.delete(f"/api/pairing/devices/{server_a}/iphone-01").status_code == 200


def test_revoke_all_servers_legacy_endpoint():
    """旧单参 DELETE /devices/{device_id} 兼容：删除该设备在所有桌面实例的配对"""
    _, token1 = _pair_device()
    _switch_server_id("server-B")
    _, token2 = _pair_device()
    assert client.delete("/api/pairing/devices/iphone-01").status_code == 200
    assert client.get("/api/pairing/devices").json()["devices"] == []
    assert not pairing_service.verify_token(token1)
    assert not pairing_service.verify_token(token2)
    # 幂等：重复撤销仍 200
    assert client.delete("/api/pairing/devices/iphone-01").status_code == 200


# ============ 设备备注 note ============


def test_list_devices_includes_note_default_empty():
    """新配对条目 note 为空串；老数据无 note 字段 → 列表兜底空串"""
    _pair_device()
    devices = client.get("/api/pairing/devices").json()["devices"]
    assert devices[0]["note"] == ""
    # 老数据兼容：手工去掉 note 字段后列表仍返回空串
    data = db.pairing_load()
    data["devices"][0].pop("note")
    db.pairing_save(data)
    devices = client.get("/api/pairing/devices").json()["devices"]
    assert devices[0]["note"] == ""


def test_patch_note_updates_list():
    """PATCH 更新 note → 返回条目带新值，列表反映"""
    _pair_device()
    server_id = pairing_service.get_server_id()
    r = client.patch(
        f"/api/pairing/devices/{server_id}/iphone-01",
        json={"note": "客厅的 iPhone"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["device"]["note"] == "客厅的 iPhone"
    assert body["device"]["device_id"] == "iphone-01"
    listed = client.get("/api/pairing/devices").json()["devices"]
    assert listed[0]["note"] == "客厅的 iPhone"


def test_patch_note_unknown_device_404():
    """不存在的 device_id 或 server_id → 404"""
    _pair_device()
    server_id = pairing_service.get_server_id()
    assert (
        client.patch(
            f"/api/pairing/devices/{server_id}/no-such-device", json={"note": "x"}
        ).status_code
        == 404
    )
    assert (
        client.patch(
            "/api/pairing/devices/no-such-server/iphone-01", json={"note": "x"}
        ).status_code
        == 404
    )
    # note 缺失/非字符串 → 400
    assert client.patch(f"/api/pairing/devices/{server_id}/iphone-01", json={}).status_code == 400
    assert (
        client.patch(f"/api/pairing/devices/{server_id}/iphone-01", json={"note": 123}).status_code
        == 400
    )


def test_patch_note_clean_empty_truncate_idempotent():
    """note 清洗：strip、空串允许、超 50 字符截断（含多字节）、重复 PATCH 幂等"""
    _pair_device()
    server_id = pairing_service.get_server_id()
    url = f"/api/pairing/devices/{server_id}/iphone-01"
    # 纯空白 → 空串
    r = client.patch(url, json={"note": "   "})
    assert r.status_code == 200 and r.json()["device"]["note"] == ""
    # 首尾空白 strip
    r = client.patch(url, json={"note": "  主卧  iPad  "})
    assert r.status_code == 200 and r.json()["device"]["note"] == "主卧  iPad"
    # 超长截断（ASCII 与多字节均按 [:50] 截断）
    r = client.patch(url, json={"note": "a" * 60})
    assert r.status_code == 200 and r.json()["device"]["note"] == "a" * 50
    r = client.patch(url, json={"note": "你" * 60})
    assert r.status_code == 200 and r.json()["device"]["note"] == "你" * 50
    # 幂等：重复 PATCH 同值 → 200 且值不变
    r2 = client.patch(url, json={"note": "你" * 60})
    assert r2.status_code == 200 and r2.json()["device"]["note"] == "你" * 50
    assert client.get("/api/pairing/devices").json()["devices"][0]["note"] == "你" * 50


def test_patch_note_persisted():
    """note 落盘：PATCH 后重新 load 存储文件仍有新值"""
    _pair_device()
    server_id = pairing_service.get_server_id()
    assert (
        client.patch(
            f"/api/pairing/devices/{server_id}/iphone-01",
            json={"note": "公司工位"},
        ).status_code
        == 200
    )
    data = db.pairing_load()
    assert data["devices"][0]["note"] == "公司工位"
    # 再次 load（模拟重启后从文件读）仍有
    assert db.pairing_load()["devices"][0]["note"] == "公司工位"


def test_patch_note_scoped_by_server_id():
    """note 按 (server_id, device_id) 定位：只改目标桌面的条目，另一台桌面不受影响"""
    _pair_device()
    server_a = pairing_service.get_server_id()
    _switch_server_id("server-B")
    _pair_device()
    assert (
        client.patch(
            f"/api/pairing/devices/{server_a}/iphone-01", json={"note": "家里"}
        ).status_code
        == 200
    )
    data = db.pairing_load()
    by_server = {d["server_id"]: d for d in data["devices"]}
    assert by_server[server_a]["note"] == "家里"
    assert by_server["server-B"]["note"] == ""


def test_approve_fallback_same_name_replaces_device():
    """同实例同名同类型设备（device_id 不同）→ 替换旧记录而不是新增（2026-08-24 重装累积根因）"""
    _pair_device(device_id="uuid-old", name="iPhone 15", dtype="ios")
    devices = client.get("/api/pairing/devices").json()["devices"]
    assert len(devices) == 1

    # 重装后 device_id 变化，但设备名相同 → 应替换（仍只有 1 条）
    _pair_device(device_id="uuid-new", name="iPhone 15", dtype="ios")
    devices = client.get("/api/pairing/devices").json()["devices"]
    assert len(devices) == 1
    assert devices[0]["device_id"] == "uuid-new"  # 记录跟随最新 device_id


def test_approve_fallback_preserves_note():
    """fallback 替换（同名）时保留用户备注，不丢"""
    _pair_device(device_id="uuid-old", name="iPhone 15", dtype="ios")
    server_id = pairing_service.get_server_id()
    client.patch(f"/api/pairing/devices/{server_id}/uuid-old", json={"note": "老婆的手机"})
    _pair_device(device_id="uuid-new", name="iPhone 15", dtype="ios")
    devices = client.get("/api/pairing/devices").json()["devices"]
    assert len(devices) == 1
    assert devices[0]["note"] == "老婆的手机"


def test_approve_same_name_different_type_keeps_both():
    """同名但不同类型 → 不合并（iPad 与 iPhone 同名设备各自保留）"""
    _pair_device(device_id="uuid-a", name="我的设备", dtype="ios")
    _pair_device(device_id="uuid-b", name="我的设备", dtype="ipad")
    devices = client.get("/api/pairing/devices").json()["devices"]
    assert len(devices) == 2


def test_approve_different_name_same_type_keeps_both():
    """不同名同类型 → 不合并"""
    _pair_device(device_id="uuid-a", name="iPhone 15", dtype="ios")
    _pair_device(device_id="uuid-b", name="iPhone 15 Pro", dtype="ios")
    devices = client.get("/api/pairing/devices").json()["devices"]
    assert len(devices) == 2
