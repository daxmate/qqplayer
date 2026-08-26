"""设备指令队列 API 测试：创建 / 广播语义 / 原子拉取 / 超时回滚 / 回执 / 历史 / 资产上报 / 设备列表。

运行：cd backend && /Users/dax/codes/qqplayer/backend/venv/bin/python -m pytest tests/test_commands.py -q
"""

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import backend
from app import db, state

client = TestClient(backend.app)


@pytest.fixture(autouse=True)
def _isolate_pairing(tmp_path, monkeypatch):
    """配对存储隔离：pairing.json 写临时目录（不碰真实配对数据）"""
    monkeypatch.setattr(state, "PAIRING_FILE", tmp_path / "pairing.json")
    yield


def _create(body) -> tuple[int, dict]:
    r = client.post("/api/sync/commands", json=body)
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, {}


def _pick(device_id: str = "") -> tuple[int, dict]:
    r = client.get("/api/sync/commands/pending", params={"device_id": device_id})
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, {}


def _ack(cmd_id, body) -> tuple[int, dict]:
    r = client.post(f"/api/sync/commands/{cmd_id}/ack", json=body)
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, {}


def _set_picked_at(cmd_id: int, dt: datetime) -> None:
    """直接改写 picked_at（模拟指定时刻的拉取，超时回滚测试用）"""
    conn = sqlite3.connect(state.DB_PATH)
    try:
        conn.execute(
            "UPDATE commands SET status='executing', picked_at=? WHERE id=?",
            (dt.isoformat(timespec="seconds"), cmd_id),
        )
        conn.commit()
    finally:
        conn.close()


def _pair_device(device_id="iphone-01", name="iPhone 15", server_id="srv-1") -> None:
    """直接落盘一个已配对设备（token 只存哈希）"""
    data = state.pairing_store.load()
    data.setdefault("devices", []).append(
        {
            "server_id": server_id,
            "device_id": device_id,
            "device_name": name,
            "device_type": "ios",
            "token_hash": "x" * 64,
            "created_at": "2026-08-26T00:00:00+00:00",
            "last_seen_at": "2026-08-26T08:00:00+00:00",
        }
    )
    state.pairing_store.save(data)


# ============ 1. 创建指令 ============
def test_create_push_download():
    """pushDownload 正常创建 201：响应含 id/type/status/created_at"""
    code, body = _create(
        {
            "type": "pushDownload",
            "payload": {"items": [{"path": "music/01.mp3", "sha256": "ab12" * 16, "size": 123456}]},
            "device_id": "iphone-01",
        }
    )
    assert code == 201
    assert body["id"] >= 1
    assert body["type"] == "pushDownload"
    assert body["status"] == "pending"
    assert body["created_at"]


def test_create_remote_delete():
    """remoteDelete 正常创建 201（device_id 省略 → 广播）"""
    code, body = _create(
        {"type": "remoteDelete", "payload": {"paths": ["audio/abc.m4a", "covers/def.jpg"]}}
    )
    assert code == 201
    assert body["type"] == "remoteDelete" and body["status"] == "pending"
    # 未传 device_id → 广播（NULL）
    row = db.commands_list()[0]
    assert row["device_id"] is None


def test_create_invalid_type_400():
    """非法 type → 400"""
    for t in ("push", "delete", "", "PUSHDOWNLOAD", 123, None):
        code, _ = _create({"type": t, "payload": {"items": [{"path": "a.mp3"}]}})
        assert code == 400, t


def test_create_payload_shape_400():
    """payload 形状错误 → 400：缺 items / 缺 paths / 缺 payload / items 元素非法"""
    cases = [
        {"type": "pushDownload", "payload": {}},  # 缺 items
        {"type": "pushDownload", "payload": {"items": "not-a-list"}},
        {"type": "pushDownload", "payload": {"items": [{"sha256": "x"}]}},  # 缺 path
        {"type": "pushDownload", "payload": {"items": [{"path": ""}]}},  # path 空
        {"type": "remoteDelete", "payload": {}},  # 缺 paths
        {"type": "remoteDelete", "payload": {"paths": "not-a-list"}},
        {"type": "remoteDelete", "payload": {"paths": [""]}},
        {"type": "pushDownload"},  # 缺 payload
    ]
    for body in cases:
        code, _ = _create(body)
        assert code == 400, (body, code)


def test_create_payload_400_has_detail():
    code, body = _create({"type": "pushDownload", "payload": {}})
    assert code == 400 and body["detail"]


def test_create_device_id_non_string_400():
    """device_id 存在但非字符串 → 400"""
    for bad in (123, ["x"], {"a": 1}, True):
        code, _ = _create(
            {"type": "pushDownload", "payload": {"items": [{"path": "a.mp3"}]}, "device_id": bad}
        )
        assert code == 400, bad


# ============ 2. 广播语义 ============
def test_broadcast_pickable_by_any_device():
    """广播指令：任意 device_id 拉取都能拿到（各自独立消费，互不干扰）"""
    for dev in ("iphone-01", "iphone-02", "android-9"):
        _create({"type": "pushDownload", "payload": {"items": [{"path": f"music/{dev}.mp3"}]}})
        code, body = _pick(dev)
        assert code == 200
        assert len(body["commands"]) == 1
        assert body["commands"][0]["payload"]["items"][0]["path"] == f"music/{dev}.mp3"


def test_directed_only_visible_to_target():
    """定向指令：只有对应 device_id 能拉到；其他设备拉不到"""
    _create(
        {
            "type": "pushDownload",
            "payload": {"items": [{"path": "music/x.mp3"}]},
            "device_id": "iphone-01",
        }
    )
    code, body = _pick("iphone-02")
    assert code == 200 and body["commands"] == []
    code, body = _pick("iphone-01")
    assert len(body["commands"]) == 1
    assert body["commands"][0]["payload"]["items"][0]["path"] == "music/x.mp3"


def test_pick_returns_broadcast_and_own_directed_in_id_order():
    """一次拉取：广播 + 本设备定向都返回，按 id 升序；别的设备定向不返回"""
    _create(
        {"type": "pushDownload", "payload": {"items": [{"path": "music/broadcast.mp3"}]}}
    )  # 1 广播
    _create(  # 2 定向 iphone-01
        {"type": "remoteDelete", "payload": {"paths": ["audio/own.m4a"]}, "device_id": "iphone-01"}
    )
    _create(  # 3 定向 iphone-02（不应返回）
        {
            "type": "remoteDelete",
            "payload": {"paths": ["audio/other.m4a"]},
            "device_id": "iphone-02",
        }
    )
    code, body = _pick("iphone-01")
    assert code == 200
    assert [c["id"] for c in body["commands"]] == [1, 2]
    assert body["commands"][0]["type"] == "pushDownload"
    assert body["commands"][1]["type"] == "remoteDelete"


# ============ 3. pending 原子性 ============
def test_pick_marks_executing_and_no_double_pick():
    """拉取即原子标记 executing：第二次拉取（本设备/其他设备）不再返回，不重复执行"""
    _create({"type": "pushDownload", "payload": {"items": [{"path": "music/a.mp3"}]}})
    code, body = _pick("iphone-01")
    assert code == 200 and len(body["commands"]) == 1
    # 状态已变 executing + picked_at 已打
    row = db.commands_list()[0]
    assert row["status"] == "executing" and row["picked_at"]
    # 第二次拉取：同一设备与其他设备都拿不到
    assert _pick("iphone-01")[1]["commands"] == []
    assert _pick("iphone-02")[1]["commands"] == []


def test_pick_two_devices_get_own_directed_only():
    """跨设备不重复：A 拉走自己的定向指令后，B 拉不到 A 的（也不影响 B 自己的）"""
    _create(
        {
            "type": "pushDownload",
            "payload": {"items": [{"path": "music/a.mp3"}]},
            "device_id": "iphone-01",
        }
    )
    _create(
        {"type": "remoteDelete", "payload": {"paths": ["audio/b.m4a"]}, "device_id": "iphone-02"}
    )
    first = _pick("iphone-01")[1]["commands"]
    assert [c["id"] for c in first] == [1]  # 只拿到自己的
    # iphone-01 已拉走 → 状态 executing，B 看不到；B 只拿到自己的
    second = _pick("iphone-02")[1]["commands"]
    assert [c["id"] for c in second] == [2]
    # 已消费完 → 后续拉取为空
    assert _pick("iphone-02")[1]["commands"] == []


# ============ 4. 超时回滚 ============
def test_pick_timeout_rollback():
    """executing 且 picked_at 超过 10 分钟 → 下次 GET pending 自动回滚并重新拉到"""
    _create({"type": "pushDownload", "payload": {"items": [{"path": "music/a.mp3"}]}})
    _pick("iphone-01")  # 拉走 → executing
    assert _pick("iphone-01")[1]["commands"] == []
    cmd_id = db.commands_list()[0]["id"]
    _set_picked_at(cmd_id, datetime.now(timezone.utc) - timedelta(minutes=11))
    code, body = _pick("iphone-01")
    assert code == 200 and len(body["commands"]) == 1
    assert body["commands"][0]["id"] == cmd_id
    # 重新拉取后再次进入 executing → 不可再取
    assert _pick("iphone-01")[1]["commands"] == []


def test_pick_no_rollback_within_timeout():
    """未超时（9 分钟）→ 不回滚，拉不到"""
    _create({"type": "pushDownload", "payload": {"items": [{"path": "music/a.mp3"}]}})
    _pick("iphone-01")
    cmd_id = db.commands_list()[0]["id"]
    _set_picked_at(cmd_id, datetime.now(timezone.utc) - timedelta(minutes=9))
    assert _pick("iphone-01")[1]["commands"] == []


# ============ 5. ack 回执 ============
def test_ack_done():
    """ok=true → done + ack_at + ack_by 落库"""
    _create({"type": "pushDownload", "payload": {"items": [{"path": "music/a.mp3"}]}})
    cmd_id = db.commands_list()[0]["id"]
    code, body = _ack(cmd_id, {"device_id": "iphone-01", "ok": True})
    assert code == 200 and body == {"ok": True}
    row = db.commands_list()[0]
    assert row["status"] == "done"
    assert row["ack_by"] == "iphone-01" and row["ack_at"]
    assert row["error"] in (None, "")


def test_ack_failed_with_error():
    """ok=false → failed + error 落库"""
    _create({"type": "remoteDelete", "payload": {"paths": ["audio/x.m4a"]}})
    cmd_id = db.commands_list()[0]["id"]
    code, body = _ack(cmd_id, {"device_id": "iphone-01", "ok": False, "error": "下载失败"})
    assert code == 200
    row = db.commands_list()[0]
    assert row["status"] == "failed" and row["error"] == "下载失败"
    assert row["ack_by"] == "iphone-01"


def test_ack_idempotent_overwrite():
    """重复 ack 幂等：已 done 再 ack（覆盖为 failed）不报错"""
    _create({"type": "pushDownload", "payload": {"items": [{"path": "music/a.mp3"}]}})
    cmd_id = db.commands_list()[0]["id"]
    assert _ack(cmd_id, {"device_id": "iphone-01", "ok": True})[0] == 200
    code, body = _ack(cmd_id, {"device_id": "iphone-01", "ok": False, "error": "中途失败"})
    assert code == 200
    row = db.commands_list()[0]
    assert row["status"] == "failed" and row["error"] == "中途失败"


def test_ack_not_found_404():
    """指令不存在 → 404"""
    code, body = _ack(99999, {"device_id": "iphone-01", "ok": True})
    assert code == 404 and body["detail"]


def test_ack_invalid_body_400():
    """ack 请求体校验：缺 device_id / ok 非布尔 / error 非字符串 → 400"""
    _create({"type": "pushDownload", "payload": {"items": [{"path": "music/a.mp3"}]}})
    cmd_id = db.commands_list()[0]["id"]
    for bad in (
        {"ok": True},  # 缺 device_id
        {"device_id": "", "ok": True},
        {"device_id": "iphone-01", "ok": "yes"},
        {"device_id": "iphone-01", "ok": True, "error": 123},
    ):
        assert _ack(cmd_id, bad)[0] == 400, bad


# ============ 6. 历史列表 ============
def test_list_desc_order_and_filters():
    """历史：id 降序；status / device_id 可选过滤；payload 为反序列化对象"""
    _create({"type": "pushDownload", "payload": {"items": [{"path": "music/a.mp3"}]}})  # 1 广播
    _create(  # 2 定向 iphone-01
        {"type": "remoteDelete", "payload": {"paths": ["audio/b.m4a"]}, "device_id": "iphone-01"}
    )
    _create(  # 3 定向 iphone-02
        {
            "type": "pushDownload",
            "payload": {"items": [{"path": "music/c.mp3"}]},
            "device_id": "iphone-02",
        }
    )
    all_cmds = client.get("/api/sync/commands").json()["commands"]
    assert [c["id"] for c in all_cmds] == [3, 2, 1]  # 降序
    assert all_cmds[1]["payload"] == {"paths": ["audio/b.m4a"]}  # payload 反序列化
    assert all_cmds[0]["device_id"] == "iphone-02" and all_cmds[2]["device_id"] is None
    # status 过滤
    assert (
        client.get("/api/sync/commands", params={"status": "pending"}).json()["commands"]
        == all_cmds
    )
    _ack(1, {"device_id": "iphone-01", "ok": True})
    done = client.get("/api/sync/commands", params={"status": "done"}).json()["commands"]
    assert [c["id"] for c in done] == [1]
    # device_id 过滤
    only_2 = client.get("/api/sync/commands", params={"device_id": "iphone-02"}).json()["commands"]
    assert [c["id"] for c in only_2] == [3]


def test_history_fields_complete():
    """历史条目字段齐全：id/type/payload/status/device_id/created_at/picked_at/ack_at/ack_by/error"""
    _create({"type": "pushDownload", "payload": {"items": [{"path": "music/a.mp3"}]}})
    _pick("iphone-01")
    cmd_id = db.commands_list()[0]["id"]
    _ack(cmd_id, {"device_id": "iphone-01", "ok": True})
    c = client.get("/api/sync/commands").json()["commands"][0]
    for key in (
        "id",
        "type",
        "payload",
        "status",
        "device_id",
        "created_at",
        "picked_at",
        "ack_at",
        "ack_by",
        "error",
    ):
        assert key in c, key
    assert c["status"] == "done" and c["picked_at"] and c["ack_at"]


# ============ 7. 资产上报 / 设备列表 ============
def test_assets_upsert_overwrite():
    """同 device_id 两次上报覆盖更新；GET /api/sync/devices 合并出资产占用"""
    _pair_device("iphone-01")
    first = {
        "device_id": "iphone-01",
        "assets": [{"path": "audio/a.m4a", "sha256": "aa", "size": 100}],
        "total": 100,
        "byType": {"audio": 100},
    }
    r = client.post("/api/sync/device/assets", json=first)
    assert r.status_code == 200 and r.json() == {"ok": True}
    second = {
        "device_id": "iphone-01",
        "assets": [
            {"path": "audio/a.m4a", "sha256": "aa", "size": 100},
            {"path": "covers/b.jpg", "sha256": "bb", "size": 200},
        ],
        "total": 300,
        "byType": {"audio": 100, "covers": 200},
    }
    assert client.post("/api/sync/device/assets", json=second).status_code == 200
    devs = client.get("/api/sync/devices").json()["devices"]
    assert len(devs) == 1
    d = devs[0]
    assert d["device_id"] == "iphone-01" and d["device_name"] == "iPhone 15"
    assert d["assets_count"] == 2 and d["total"] == 300
    assert d["byType"] == {"audio": 100, "covers": 200}
    assert d["assets_updated_at"]
    assert d["server_id"] == "srv-1" and d["last_seen"] == "2026-08-26T08:00:00+00:00"


def test_devices_defaults_without_report():
    """无资产上报的设备：assets 空数组 / count 0 / total 0 / byType {} / updated_at null"""
    _pair_device("iphone-01")
    _pair_device("iphone-02", name="iPhone SE")
    devs = client.get("/api/sync/devices").json()["devices"]
    assert len(devs) == 2
    for d in devs:
        assert d["assets"] == [] and d["assets_count"] == 0 and d["total"] == 0
        assert d["byType"] == {} and d["assets_updated_at"] is None


def test_assets_validation_400():
    """资产上报校验：缺 device_id / assets 非数组 / total 非整数 / byType 非对象 → 400"""
    cases = [
        {},
        {"device_id": "", "assets": []},
        {"device_id": "x", "assets": "nope"},
        {"device_id": "x", "assets": [1]},
        {"device_id": "x", "assets": [], "total": "1e5"},
        {"device_id": "x", "assets": [], "byType": [1]},
    ]
    for body in cases:
        r = client.post("/api/sync/device/assets", json=body)
        assert r.status_code == 400, (body, r.status_code)
