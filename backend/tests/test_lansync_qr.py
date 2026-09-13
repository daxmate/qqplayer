"""配对 QR 载荷 + 一次性 nonce 池测试（协议 §3.1；Swift `SyncQRCodec` / `SyncPairingNonceRegistry`）。

覆盖：载荷 JSON 逐字（字段名/键序/紧凑格式）、standard base64、round-trip、前向兼容（多余键忽略）、
坏输入负例（非法 JSON / 非对象 / 缺字段 / 类型不符 / bool 冒充 int）、工厂（protoVersion=1、
nonce 16B 强制）、nonce 池（登记/重复登记/空 nonce 忽略/命中消耗/未命中不消耗/作废/清空/
多次 match 幂等/不同 nonce 不误配）以及与真实 Ed25519 验签的联调（协议 §3.3 步骤 3）。
"""

from __future__ import annotations

import base64
import json

import pytest

from app.lansync import crypto as lc
from app.lansync.deviceid import FULL_LENGTH, fingerprint_matches, make_from_public_key
from app.lansync.qr import (
    PROTOCOL_VERSION,
    SESSION_NONCE_BYTE_COUNT,
    NoncePool,
    PairQRPayload,
    QRPayloadError,
    decode_qr_payload,
    encode_qr_payload,
    make_qr_payload,
    new_session_nonce,
)

#: 固定载荷（键序与 Swift `PairQRPayload` 声明顺序一致）
HOST_NAME = "dax's MacBook Pro"
DEVICE_ID = "N22FZO5VO3W2AQH7EN4EHYXYTP24HZ4M6FBS3EBSQEN6X3TMGCSQ"
PUBLIC_KEY_B64 = base64.b64encode(bytes(range(32))).decode("ascii")
NONCE_BYTES = bytes(range(16))
NONCE_B64 = base64.b64encode(NONCE_BYTES).decode("ascii")
PAYLOAD = PairQRPayload(
    protoVersion=PROTOCOL_VERSION,
    hostName=HOST_NAME,
    deviceID=DEVICE_ID,
    publicKey=PUBLIC_KEY_B64,
    sessionNonce=NONCE_B64,
)

FIELD_TYPES = {
    "protoVersion": 1,
    "hostName": HOST_NAME,
    "deviceID": DEVICE_ID,
    "publicKey": PUBLIC_KEY_B64,
    "sessionNonce": NONCE_B64,
}


class TestPayloadConstants:
    def test_protocol_version_and_nonce_size(self) -> None:
        """协议 §3.1：protoVersion = 1，sessionNonce = 16B。"""
        assert PROTOCOL_VERSION == 1
        assert SESSION_NONCE_BYTE_COUNT == 16
        assert lc.KEY_BYTE_COUNT == 32  # 公钥 raw 32B（载荷里以 base64 承载）

    def test_new_session_nonce_is_random_16_bytes(self) -> None:
        first = new_session_nonce()
        second = new_session_nonce()
        assert len(first) == len(second) == SESSION_NONCE_BYTE_COUNT
        assert first != second  # 密码学随机，连续两次不应相同


class TestPayloadCodec:
    def test_exact_json_text(self) -> None:
        """QR 文本 = 紧凑 JSON（无空格）、字段名逐字、键序 = Swift 声明顺序。"""
        text = encode_qr_payload(PAYLOAD)
        expected = (
            '{"protoVersion":1,"hostName":"dax\'s MacBook Pro",'
            f'"deviceID":"{DEVICE_ID}","publicKey":"{PUBLIC_KEY_B64}","sessionNonce":"{NONCE_B64}"}}'
        )
        assert text == expected
        assert list(json.loads(text)) == list(FIELD_TYPES)
        assert text.isascii()  # ensure_ascii=True 时非 ASCII 名会被转义，须逐字保留

    def test_non_ascii_host_name_not_escaped(self) -> None:
        """中文展示名保持原样（ensure_ascii=False，与 Swift 的 UTF-8 输出一致）。"""
        payload = make_qr_payload(
            host_name="大象的 MacBook", device_id=DEVICE_ID, public_key_b64=PUBLIC_KEY_B64
        )
        text = encode_qr_payload(payload)
        assert "大象的 MacBook" in text
        assert decode_qr_payload(text) == payload

    def test_round_trip(self) -> None:
        assert decode_qr_payload(encode_qr_payload(PAYLOAD)) == PAYLOAD

    def test_base64_is_standard_not_urlsafe(self) -> None:
        """base64 一律 standard（`+`/`/`），不是 url-safe（`-`/`_`）。"""
        raw = b"\xfb\xff\xfe" + bytes(13)  # standard base64 前缀 "+//+"
        payload = make_qr_payload(
            host_name="mac", device_id=DEVICE_ID, public_key_b64=PUBLIC_KEY_B64, session_nonce=raw
        )
        assert payload.sessionNonce == base64.b64encode(raw).decode("ascii")
        assert "+//+" in payload.sessionNonce
        assert "-" not in payload.sessionNonce and "_" not in payload.sessionNonce

    def test_extra_keys_ignored_for_forward_compatibility(self) -> None:
        """新版 Swift 加字段不破坏本端解析（多余键忽略）。"""
        text = json.dumps({**FIELD_TYPES, "futureField": "x"})
        assert decode_qr_payload(text) == PAYLOAD

    def test_device_id_is_full_value_and_fingerprint_consistent(self) -> None:
        """载荷里 deviceID 是全量值（无分组符），且与公钥指纹一致（配对校验前提）。"""
        identity = lc.Identity.generate()
        payload = make_qr_payload(
            host_name="mac",
            device_id=identity.device_id,
            public_key_b64=base64.b64encode(identity.public_key_raw).decode("ascii"),
        )
        assert "-" not in payload.deviceID
        assert len(payload.deviceID) == FULL_LENGTH
        assert payload.deviceID == make_from_public_key(identity.public_key_raw)
        assert fingerprint_matches(payload.deviceID, identity.public_key_raw) is True


class TestPayloadDecodeFailures:
    @pytest.mark.parametrize("text", ["", "not json", "{", "[1,2]", '"str"', "123", "null"])
    def test_non_object_or_bad_json_rejected(self, text: str) -> None:
        with pytest.raises(QRPayloadError):
            decode_qr_payload(text)

    @pytest.mark.parametrize("name", list(FIELD_TYPES))
    def test_missing_field_rejected(self, name: str) -> None:
        raw = {key: value for key, value in FIELD_TYPES.items() if key != name}
        with pytest.raises(QRPayloadError):
            decode_qr_payload(json.dumps(raw))

    @pytest.mark.parametrize(
        ("name", "bad"),
        [
            ("protoVersion", "1"),
            ("protoVersion", 1.0),
            ("protoVersion", None),
            ("hostName", 1),
            ("hostName", None),
            ("deviceID", 1),
            ("publicKey", None),
            ("sessionNonce", 1),
            ("sessionNonce", ["x"]),
        ],
    )
    def test_type_mismatch_rejected(self, name: str, bad: object) -> None:
        raw = dict(FIELD_TYPES)
        raw[name] = bad
        with pytest.raises(QRPayloadError):
            decode_qr_payload(json.dumps(raw))

    def test_bool_not_accepted_as_int(self) -> None:
        """bool 是 int 子类，必须显式拒绝（`true` 不是协议版本）。"""
        raw = dict(FIELD_TYPES)
        raw["protoVersion"] = True
        with pytest.raises(QRPayloadError):
            decode_qr_payload(json.dumps(raw))


class TestPayloadFactory:
    def test_defaults_and_nonce_auto_generated(self) -> None:
        payload = make_qr_payload(
            host_name=HOST_NAME, device_id=DEVICE_ID, public_key_b64=PUBLIC_KEY_B64
        )
        assert payload.protoVersion == PROTOCOL_VERSION
        assert len(base64.b64decode(payload.sessionNonce)) == SESSION_NONCE_BYTE_COUNT
        assert payload.publicKey == PUBLIC_KEY_B64

    def test_nonce_length_enforced(self) -> None:
        for bad in (bytes(SESSION_NONCE_BYTE_COUNT - 1), bytes(SESSION_NONCE_BYTE_COUNT + 1), b""):
            with pytest.raises(QRPayloadError):
                make_qr_payload(
                    host_name=HOST_NAME,
                    device_id=DEVICE_ID,
                    public_key_b64=PUBLIC_KEY_B64,
                    session_nonce=bad,
                )

    def test_to_dict_key_order_matches_protocol(self) -> None:
        assert list(PAYLOAD.to_dict()) == list(FIELD_TYPES)


class TestNoncePool:
    def test_register_and_pending_order(self) -> None:
        pool = NoncePool()
        assert pool.pending_count == 0 and pool.pending() == ()
        first, second = b"a" * 16, b"b" * 16
        pool.register(first)
        pool.register(second)
        assert pool.pending_count == 2
        assert pool.pending() == (first, second)  # 登记顺序

    def test_duplicate_register_keeps_single_entry_and_position(self) -> None:
        pool = NoncePool()
        first, second = b"a" * 16, b"b" * 16
        pool.register(first)
        pool.register(second)
        pool.register(first)
        assert pool.pending() == (first, second)
        assert pool.pending_count == 2

    def test_empty_nonce_ignored(self) -> None:
        """Swift `guard !nonce.isEmpty`：空 nonce 不登记。"""
        pool = NoncePool()
        pool.register(b"")
        assert pool.pending_count == 0
        assert pool.consume(b"") is False

    def test_consume_hit_and_miss(self) -> None:
        pool = NoncePool()
        nonce = b"n" * 16
        pool.register(nonce)
        assert pool.consume(nonce) is True
        assert pool.pending_count == 0
        assert pool.consume(nonce) is False

    def test_revoke_is_idempotent(self) -> None:
        pool = NoncePool()
        nonce = b"n" * 16
        pool.register(nonce)
        pool.revoke(nonce)
        pool.revoke(nonce)
        assert pool.pending_count == 0

    def test_clear(self) -> None:
        pool = NoncePool()
        pool.register(b"a" * 16)
        pool.register(b"b" * 16)
        pool.clear()
        assert pool.pending_count == 0 and pool.pending() == ()

    def test_match_calls_injected_verify_with_pool_nonce(self) -> None:
        """match 以 (publicKey, nonce, signature) 顺序调用注入的 verify。"""
        pool = NoncePool()
        nonce = b"n" * 16
        pool.register(nonce)
        seen: list[tuple[bytes, bytes, bytes]] = []

        def verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
            seen.append((public_key, message, signature))
            return message == nonce

        assert pool.match(b"pub", b"sig", verify) == nonce
        assert seen == [(b"pub", nonce, b"sig")]

    def test_match_consumes_hit(self) -> None:
        pool = NoncePool()
        nonce = b"n" * 16
        pool.register(nonce)
        assert pool.match(b"pub", b"sig", lambda *_: True) == nonce
        assert pool.pending_count == 0

    def test_match_misses_return_none_without_consuming(self) -> None:
        """全部不中 → None（明确失败，不静默成功），池内 nonce 原样保留。"""
        pool = NoncePool()
        nonce = b"n" * 16
        pool.register(nonce)
        assert pool.match(b"pub", b"sig", lambda *_: False) is None
        assert pool.pending() == (nonce,)

    def test_match_on_empty_pool_returns_none(self) -> None:
        assert NoncePool().match(b"pub", b"sig", lambda *_: True) is None

    def test_match_is_not_reusable_after_hit(self) -> None:
        """重放同一签名：第二次不再命中（一次性）。"""
        pool = NoncePool()
        pool.register(b"n" * 16)
        verify = lambda *_: True  # noqa: E731 - 测试内联回调
        assert pool.match(b"pub", b"sig", verify) is not None
        assert pool.match(b"pub", b"sig", verify) is None

    def test_match_does_not_misalign_other_nonce(self) -> None:
        """签名只对 B 有效时，池内的 A 不得被误配。"""
        pool = NoncePool()
        registered, signed_for = b"a" * 16, b"b" * 16
        pool.register(registered)
        assert pool.match(b"pub", b"sig", lambda _pk, message, _sig: message == signed_for) is None
        assert pool.pending() == (registered,)

    def test_match_skips_revoked_nonce(self) -> None:
        pool = NoncePool()
        revoked, kept = b"a" * 16, b"b" * 16
        pool.register(revoked)
        pool.register(kept)
        pool.revoke(revoked)
        assert pool.match(b"pub", b"sig", lambda _pk, message, _sig: message == revoked) is None
        assert pool.match(b"pub", b"sig", lambda _pk, message, _sig: message == kept) == kept

    def test_pending_is_snapshot(self) -> None:
        pool = NoncePool()
        pool.register(b"a" * 16)
        snapshot = pool.pending()
        pool.register(b"b" * 16)
        assert snapshot == (b"a" * 16,)


class TestNoncePoolWithRealSignature:
    """协议 §3.3 步骤 3 的真实路径：PairRequest 自带公钥对池内 nonce 验签（Ed25519）。"""

    @staticmethod
    def _request_signature(identity: lc.Identity, nonce: bytes) -> bytes:
        """客户端对 sessionNonce 原始字节签名（`SyncPairingMessages.makePairRequest`）。"""
        assert identity.private_key_raw is not None
        return lc.sign_message(identity.private_key_raw, nonce)

    def test_hit_then_replay_rejected(self) -> None:
        identity = lc.Identity.generate()
        nonce = new_session_nonce()
        pool = NoncePool()
        pool.register(nonce)
        signature = self._request_signature(identity, nonce)
        assert pool.match(identity.public_key_raw, signature, lc.verify_signature) == nonce
        assert pool.match(identity.public_key_raw, signature, lc.verify_signature) is None
        assert pool.pending_count == 0

    def test_signature_from_other_key_rejected(self) -> None:
        attacker = lc.Identity.generate()
        honest = lc.Identity.generate()
        nonce = new_session_nonce()
        pool = NoncePool()
        pool.register(nonce)
        signature = self._request_signature(attacker, nonce)
        assert pool.match(honest.public_key_raw, signature, lc.verify_signature) is None
        assert pool.pending() == (nonce,)

    def test_signature_over_other_nonce_rejected(self) -> None:
        identity = lc.Identity.generate()
        pool = NoncePool()
        pool.register(new_session_nonce())
        signature = self._request_signature(identity, new_session_nonce())
        assert pool.match(identity.public_key_raw, signature, lc.verify_signature) is None

    def test_tampered_signature_rejected(self) -> None:
        identity = lc.Identity.generate()
        nonce = new_session_nonce()
        pool = NoncePool()
        pool.register(nonce)
        signature = bytearray(self._request_signature(identity, nonce))
        signature[0] ^= 0xFF
        assert pool.match(identity.public_key_raw, bytes(signature), lc.verify_signature) is None
        assert pool.pending() == (nonce,)
