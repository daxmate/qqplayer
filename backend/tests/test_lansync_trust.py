"""信任表测试（协议 §7 `PeerDevice`；Swift `DeviceStore` 语义对位）。

覆盖：round-trip / pinning 公钥字节 / 0600 权限（含改写后仍 0600）/ 原子写入（tmp+rename、
失败不破坏原文件、无临时残留）/ 损坏文件明确报错且不丢数据 / 撤销后查询为空 / 重复 save = upsert /
`touch_last_seen` 只改一列且未配对不新建 / 字段校验负例 / JSON 键名与协议 §7 逐字一致。
"""

from __future__ import annotations

import base64
import json
import os
import stat
from pathlib import Path

import pytest

from app.lansync.trust import (
    FILE_MODE,
    PUBLIC_KEY_BYTE_COUNT,
    RECORD_KEYS,
    ROLE_CLIENT,
    ROLE_HOST,
    TrustedDevice,
    TrustStore,
    TrustStoreError,
)

PEER_A = "N22FZO5VO3W2AQH7EN4EHYXYTP24HZ4M6FBS3EBSQEN6X3TMGCSQ"
PEER_B = "ESNNHTRBIUPBZNLWARKAJNPFYFUPSRVJ4FZFVZHREQTUV52TZ7PA"
KEY_A_RAW = bytes(range(32))
KEY_B_RAW = bytes(range(32, 64))
KEY_A = base64.b64encode(KEY_A_RAW).decode("ascii")
KEY_B = base64.b64encode(KEY_B_RAW).decode("ascii")


def make_device(
    peer_id: str = PEER_A,
    key: str = KEY_A,
    name: str = "dax's iPhone",
    role: str = ROLE_CLIENT,
    paired_at: int = 1_735_689_600,
    last_seen_at: int = 1_735_689_600,
    notes: str | None = None,
) -> TrustedDevice:
    return TrustedDevice(
        peer_id=peer_id,
        peer_public_key=key,
        display_name=name,
        role=role,
        paired_at=paired_at,
        last_seen_at=last_seen_at,
        notes=notes,
    )


@pytest.fixture()
def store(tmp_path: Path) -> TrustStore:
    """指向尚未创建的嵌套目录（顺带覆盖"目录不存在"的首跑场景）。"""
    return TrustStore(tmp_path / "state" / "sync-devices.json")


class TestEmptyStore:
    def test_missing_file_is_empty_store_not_error(self, store: TrustStore) -> None:
        assert store.peer_public_key(PEER_A) is None
        assert store.list_devices() == []
        assert store.remove(PEER_A) is False
        assert store.touch_last_seen(PEER_A, 1) is False
        assert not store.path.exists()  # 只读路径不落文件


class TestRoundTrip:
    def test_save_then_query(self, store: TrustStore) -> None:
        device = make_device(notes="客厅的 iPhone")
        store.save(device)
        assert store.list_devices() == [device]
        assert store.peer_public_key(PEER_A) == KEY_A_RAW

    def test_unpaired_peer_is_none(self, store: TrustStore) -> None:
        store.save(make_device())
        assert store.peer_public_key(PEER_B) is None

    def test_json_layout_uses_protocol_keys(self, store: TrustStore) -> None:
        """键名与协议 §7 表头逐字一致，顶层为 devices 数组。"""
        store.save(make_device(notes=None))
        raw = json.loads(store.path.read_text(encoding="utf-8"))
        assert list(raw) == ["devices"]
        assert list(raw["devices"][0]) == list(RECORD_KEYS)
        assert raw["devices"][0]["peer_id"] == PEER_A
        assert raw["devices"][0]["notes"] is None
        assert raw["devices"][0]["role"] == ROLE_CLIENT

    def test_extra_keys_in_record_ignored(self, store: TrustStore) -> None:
        """前向兼容：未来 Swift 端加列不破坏本端读取。"""
        store.save(make_device())
        raw = json.loads(store.path.read_text(encoding="utf-8"))
        raw["devices"][0]["future_column"] = 1
        store.path.write_text(json.dumps(raw), encoding="utf-8")
        assert store.list_devices() == [make_device()]

    def test_notes_round_trip(self, store: TrustStore) -> None:
        store.save(make_device(notes="备注"))
        assert store.list_devices()[0].notes == "备注"

    def test_public_key_raw_property(self) -> None:
        assert make_device().public_key_raw == KEY_A_RAW


class TestFilePermissions:
    def test_new_file_is_0600(self, store: TrustStore) -> None:
        store.save(make_device())
        assert stat.S_IMODE(store.path.stat().st_mode) == FILE_MODE == 0o600

    def test_rewrite_normalizes_permissions(self, store: TrustStore) -> None:
        """外部把权限放宽后，下一次写入（tmp 0600 + rename）恢复 0600。"""
        store.save(make_device())
        store.path.chmod(0o644)
        store.save(make_device(name="改了名"))
        assert stat.S_IMODE(store.path.stat().st_mode) == 0o600

    def test_parent_directory_created(self, store: TrustStore) -> None:
        store.save(make_device())
        assert store.path.parent.is_dir()


class TestUpsertAndOrdering:
    def test_duplicate_save_replaces_whole_record(self, store: TrustStore) -> None:
        store.save(make_device(name="旧名", last_seen_at=100))
        updated = make_device(name="新名", last_seen_at=200, notes="重新配对")
        store.save(updated)
        assert store.list_devices() == [updated]
        raw = json.loads(store.path.read_text(encoding="utf-8"))
        assert len(raw["devices"]) == 1
        assert raw["devices"][0]["last_seen_at"] == 200

    def test_upsert_can_change_public_key(self, store: TrustStore) -> None:
        """重新配对 = 同 peerID 替换确认路径（公钥随之更新）。"""
        store.save(make_device())
        store.save(make_device(key=KEY_B))
        assert store.peer_public_key(PEER_A) == KEY_B_RAW

    def test_list_sorted_by_display_name_then_peer_id(self, store: TrustStore) -> None:
        store.save(make_device(peer_id=PEER_B, key=KEY_B, name="苹果手机"))
        store.save(make_device(peer_id=PEER_A, key=KEY_A, name="Ben's iPad"))
        store.save(make_device(peer_id="M" * 52, key=KEY_B, name="Ben's iPad"))
        names = [(device.display_name, device.peer_id) for device in store.list_devices()]
        assert names == [
            ("Ben's iPad", "M" * 52),
            ("Ben's iPad", PEER_A),
            ("苹果手机", PEER_B),
        ]

    def test_role_host_accepted(self, store: TrustStore) -> None:
        store.save(make_device(role=ROLE_HOST))
        assert store.list_devices()[0].role == "host"


class TestRemove:
    def test_remove_revokes_pairing(self, store: TrustStore) -> None:
        store.save(make_device())
        assert store.remove(PEER_A) is True
        assert store.peer_public_key(PEER_A) is None
        assert store.list_devices() == []

    def test_remove_is_idempotent(self, store: TrustStore) -> None:
        store.save(make_device())
        assert store.remove(PEER_A) is True
        assert store.remove(PEER_A) is False  # 幂等：不存在不算失败

    def test_remove_keeps_other_devices(self, store: TrustStore) -> None:
        store.save(make_device(peer_id=PEER_A, key=KEY_A))
        store.save(make_device(peer_id=PEER_B, key=KEY_B, name="b"))
        assert store.remove(PEER_A) is True
        assert [device.peer_id for device in store.list_devices()] == [PEER_B]


class TestTouchLastSeen:
    def test_touch_updates_only_last_seen(self, store: TrustStore) -> None:
        store.save(make_device(notes="备注"))
        assert store.touch_last_seen(PEER_A, 1_800_000_000) is True
        device = store.list_devices()[0]
        assert device.last_seen_at == 1_800_000_000
        assert device.paired_at == 1_735_689_600
        assert device.display_name == "dax's iPhone"
        assert device.notes == "备注"
        assert store.peer_public_key(PEER_A) == KEY_A_RAW  # pinning 不动

    def test_touch_same_value_does_not_rewrite(self, store: TrustStore) -> None:
        store.save(make_device(last_seen_at=100))
        before = store.path.stat().st_mtime_ns
        assert store.touch_last_seen(PEER_A, 100) is False
        assert store.path.stat().st_mtime_ns == before

    def test_touch_unknown_peer_creates_nothing(self, store: TrustStore) -> None:
        store.save(make_device())
        assert store.touch_last_seen(PEER_B, 999) is False
        assert [device.peer_id for device in store.list_devices()] == [PEER_A]

    def test_touch_without_file_creates_nothing(self, store: TrustStore) -> None:
        assert store.touch_last_seen(PEER_A, 999) is False
        assert not store.path.exists()


class TestCorruptFile:
    def test_invalid_json_raises_and_preserves_bytes(self, store: TrustStore) -> None:
        store.path.parent.mkdir(parents=True, exist_ok=True)
        broken = '{"devices": ['
        store.path.write_text(broken, encoding="utf-8")
        with pytest.raises(TrustStoreError):
            store.peer_public_key(PEER_A)
        with pytest.raises(TrustStoreError):
            store.list_devices()
        with pytest.raises(TrustStoreError):
            store.save(make_device())
        assert store.path.read_text(encoding="utf-8") == broken  # 未静默丢数据

    @pytest.mark.parametrize(
        "payload",
        [
            "[]",
            "null",
            '{"devices": "x"}',
            '{"devices": {}}',
            '{"devices": [1]}',
            '{"devices": [{"peer_id": "x"}]}',
            '{"devices": [{"peer_id": "x", "peer_public_key": "' + KEY_A + '",'
            ' "display_name": "n", "role": "nobody", "paired_at": 1, "last_seen_at": 1,'
            ' "notes": null}]}',
            '{"devices": [{"peer_id": "x", "peer_public_key": "not-base64!!",'
            ' "display_name": "n", "role": "host", "paired_at": 1, "last_seen_at": 1,'
            ' "notes": null}]}',
            '{"devices": [{"peer_id": "x", "peer_public_key": "' + KEY_A + '",'
            ' "display_name": "n", "role": "host", "paired_at": true, "last_seen_at": 1,'
            ' "notes": null}]}',
            '{"devices": [{"peer_id": "x", "peer_public_key": "' + KEY_A + '",'
            ' "display_name": "n", "role": "host", "paired_at": 1, "last_seen_at": 1,'
            ' "notes": 5}]}',
        ],
    )
    def test_invalid_structure_raises(self, store: TrustStore, payload: str) -> None:
        store.path.parent.mkdir(parents=True, exist_ok=True)
        store.path.write_text(payload, encoding="utf-8")
        with pytest.raises(TrustStoreError):
            store.list_devices()

    def test_duplicate_peer_id_raises(self, store: TrustStore) -> None:
        store.path.parent.mkdir(parents=True, exist_ok=True)
        record = make_device().to_dict()
        store.path.write_text(json.dumps({"devices": [record, record]}), encoding="utf-8")
        with pytest.raises(TrustStoreError):
            store.list_devices()

    def test_corrupt_key_base64_in_record_raises_not_none(self, store: TrustStore) -> None:
        """差异声明：Swift 对非法 base64 返回 nil（视为未配对），本端明确报错。"""
        store.path.parent.mkdir(parents=True, exist_ok=True)
        record = make_device().to_dict()
        record["peer_public_key"] = "AAAA!"  # 非法 base64
        store.path.write_text(json.dumps({"devices": [record]}), encoding="utf-8")
        with pytest.raises(TrustStoreError):
            store.peer_public_key(PEER_A)


class TestAtomicWrite:
    def test_no_temp_files_left_behind(self, store: TrustStore) -> None:
        store.save(make_device())
        store.save(make_device(peer_id=PEER_B, key=KEY_B))
        store.touch_last_seen(PEER_A, 42)
        store.remove(PEER_B)
        leftovers = [
            path.name for path in store.path.parent.iterdir() if path.name != store.path.name
        ]
        assert leftovers == []

    def test_failed_replace_keeps_previous_file_intact(
        self, store: TrustStore, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """rename 前崩溃：旧文件内容与权限不变，临时文件被清掉。"""
        store.save(make_device(name="原始"))
        before = store.path.read_bytes()

        def boom(*_args: object, **_kwargs: object) -> None:
            raise OSError("模拟 rename 失败")

        monkeypatch.setattr(os, "replace", boom)
        with pytest.raises(TrustStoreError):
            store.save(make_device(name="新内容"))
        monkeypatch.undo()
        assert store.path.read_bytes() == before
        assert stat.S_IMODE(store.path.stat().st_mode) == FILE_MODE
        assert store.list_devices() == [make_device(name="原始")]


class TestValidation:
    def test_save_rejects_non_device(self, store: TrustStore) -> None:
        with pytest.raises(TrustStoreError):
            store.save({"peer_id": PEER_A})  # type: ignore[arg-type]

    @pytest.mark.parametrize("peer_id", ["", 5, None, b"x"])
    def test_query_rejects_bad_peer_id(self, store: TrustStore, peer_id: object) -> None:
        with pytest.raises(TrustStoreError):
            store.peer_public_key(peer_id)  # type: ignore[arg-type]
        with pytest.raises(TrustStoreError):
            store.remove(peer_id)  # type: ignore[arg-type]
        with pytest.raises(TrustStoreError):
            store.touch_last_seen(peer_id, 1)  # type: ignore[arg-type]

    @pytest.mark.parametrize(
        ("field", "bad"),
        [
            ("peer_id", ""),
            ("peer_id", 5),
            ("peer_public_key", "not base64!!"),
            ("peer_public_key", base64.b64encode(bytes(16)).decode()),
            ("display_name", ""),
            ("display_name", None),
            ("role", "peer"),
            ("role", "HOST"),
            ("paired_at", True),
            ("paired_at", "1"),
            ("last_seen_at", 1.5),
            ("notes", 5),
        ],
    )
    def test_device_field_validation(self, field: str, bad: object) -> None:
        values: dict[str, object] = {
            "peer_id": PEER_A,
            "peer_public_key": KEY_A,
            "display_name": "n",
            "role": ROLE_HOST,
            "paired_at": 1,
            "last_seen_at": 1,
            "notes": None,
        }
        values[field] = bad
        with pytest.raises(TrustStoreError):
            TrustedDevice(**values)  # type: ignore[arg-type]

    def test_public_key_byte_count_matches_protocol(self) -> None:
        assert PUBLIC_KEY_BYTE_COUNT == len(KEY_A_RAW) == 32

    def test_record_keys_are_stable(self) -> None:
        """下游会话层依赖这批键名（协议 §7），改动需同步协议文档。"""
        assert RECORD_KEYS == (
            "peer_id",
            "peer_public_key",
            "display_name",
            "role",
            "paired_at",
            "last_seen_at",
            "notes",
        )
