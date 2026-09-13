"""跨语言测试向量比对：Swift 端生成 → Python 端逐字节复算（协议互操作证据）。

向量文件 `tools/lansync-vectors/vectors.json` 由真实 Swift 仓库（`QQPlayer/Sync/*.swift`，
commit 见文件内 `generated_by`）生成，本测试用 `app/lansync` 公开 API 复算并对每个字节断言相等：

| 向量组 | 复算路径（本模块公开 API） |
| --- | --- |
| `device_ids` | `make_from_public_key` / `formatted` / `normalize` / `fingerprint_matches` |
| `base32` | `base32_encode` / `base32_decode` |
| `nonces` | `SESSION_NONCE_PREFIX + counter.to_bytes(8, "big")`（经 `encode_nonce` 可达范围） |
| `hello_signature` | `hello_signature_input` / `verify_signature` / `verify_hello` / `Identity`（签名输入逐字节；签名字节不可对齐，见类内注释） |
| `key_derivation` | `derive_session_keys`（含 DH 对称性）/ `SessionKeys.for_role` |
| `aead` | `SessionCipher.seal`（结果须等于 Swift `ChaChaPoly.SealedBox.combined`） |
| `frames` | `Frame.encode` / `encode_frame` / `build_header` / `FrameStreamDecoder` |

文件存在即必须真跑（**只有文件缺失才 skip**，并打印原因）。
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import pytest
from Crypto.Cipher import ChaCha20_Poly1305
from Crypto.PublicKey import ECC

from app.lansync import crypto as lc
from app.lansync.deviceid import (
    FULL_LENGTH,
    GROUP_WIDTH,
    base32_decode,
    base32_encode,
    fingerprint_matches,
    formatted,
    make_from_public_key,
    normalize,
)
from app.lansync.frame import (
    FLAG_ENCRYPTED,
    FRAME_TYPE_NAMES,
    HEADER_LENGTH,
    MAGIC,
    Frame,
    FrameStreamDecoder,
    build_header,
    encode_frame,
    frame_type_name,
)

#: 向量文件（仓库根 tools/lansync-vectors/；`__file__` = backend/tests/test_lansync_vectors.py）
VECTORS_PATH = Path(__file__).parents[2] / "tools" / "lansync-vectors" / "vectors.json"


def b64(text: str) -> bytes:
    """standard base64 → bytes（Swift `Data(base64Encoded:)` 默认口径）。"""
    return base64.b64decode(text)


@pytest.fixture(scope="module")
def vectors() -> dict:
    """加载向量；不存在时 skip 并打印原因（存在即必须真跑，不得 skip）。"""
    if not VECTORS_PATH.exists():
        pytest.skip(
            f"跨语言向量缺失：{VECTORS_PATH}"
            "（生成：bash tools/lansync-vectors/run.sh，见 tools/lansync-vectors/README.md）"
        )
    data = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    assert str(data["generated_by"]).strip(), "向量文件缺 generated_by（无法溯源 Swift 侧 commit）"
    return data


def _entry(entries: list[dict], **match: object) -> dict:
    """按字段精确匹配取一条向量（找不到即失败，避免静默漏测）。"""
    for entry in entries:
        if all(entry[key] == value for key, value in match.items()):
            return entry
    raise AssertionError(f"向量文件缺少 {match} 对应的条目")


class TestVectorFileIntegrity:
    def test_every_group_present_and_non_empty(self, vectors: dict) -> None:
        for group in (
            "device_ids",
            "base32",
            "nonces",
            "hello_signature",
            "key_derivation",
            "aead",
            "frames",
        ):
            assert vectors[group], f"向量组 {group} 为空"

    def test_generated_from_swift_repo(self, vectors: dict) -> None:
        assert "qqplayer-swift" in str(vectors["generated_by"])


class TestDeviceIDVectors:
    def test_device_ids_and_formatted(self, vectors: dict) -> None:
        for entry in vectors["device_ids"]:
            public_key = b64(entry["public_key_b64"])
            assert len(public_key) == 32
            assert make_from_public_key(public_key) == entry["device_id"]
            assert (
                base32_encode(hashlib.sha256(public_key).digest()) == entry["device_id"]
            )  # 指纹定义：SHA256 → base32 无填充大写
            assert formatted(entry["device_id"]) == entry["formatted"]
            assert normalize(entry["formatted"]) == entry["device_id"]
            assert fingerprint_matches(entry["formatted"], public_key) is True
            assert len(entry["device_id"]) == FULL_LENGTH == 52
            assert "-" not in entry["device_id"]
            assert entry["formatted"].count("-") == (FULL_LENGTH // GROUP_WIDTH)
            assert entry["formatted"].replace("-", "") == entry["device_id"]

    def test_fingerprint_rejects_other_key(self, vectors: dict) -> None:
        """向量非空洞：用另一条的公钥核对必须失败。"""
        first, second = vectors["device_ids"][0], vectors["device_ids"][1]
        assert fingerprint_matches(first["device_id"], b64(second["public_key_b64"])) is False


class TestBase32Vectors:
    def test_encode_and_decode(self, vectors: dict) -> None:
        for entry in vectors["base32"]:
            raw = bytes.fromhex(entry["bytes_hex"])
            assert base32_encode(raw) == entry["encoded"]
            assert base32_decode(entry["encoded"]) == raw
            assert base32_encode(raw).isupper()
            assert "=" not in entry["encoded"]  # 无填充
            assert len(entry["encoded"]) == -(-len(raw) * 8 // 5)  # 5bit/字符、向上取整

    def test_rfc4648_padding_bits_rejected(self, vectors: dict) -> None:
        """非整齐长度：尾组未用足的比特必须为 0（末字符 +1 即被拒）；多余的 `=` 容忍。"""
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        for entry in vectors["base32"]:
            raw = bytes.fromhex(entry["bytes_hex"])
            assert base32_decode(entry["encoded"] + "=") == raw  # `=` 填充容忍
            if len(raw) % 5 == 0:
                continue  # 无填充位，末字符 +1 是另一条合法编码
            bumped = entry["encoded"][:-1] + alphabet[alphabet.index(entry["encoded"][-1]) + 1]
            assert base32_decode(bumped) is None
            assert base32_decode(entry["encoded"].lower()) == raw  # 小写容忍


class TestNonceVectors:
    @pytest.mark.parametrize("index", [0, 1, 2, 3])
    def test_nonce_layout(self, vectors: dict, index: int) -> None:
        """nonce = 4B 零前缀 ‖ 8B 大端计数器（Swift `SyncCipher.nonceData(forCounter:)`）。"""
        entry = vectors["nonces"][index]
        counter = int(entry["counter"])
        layout = lc.SESSION_NONCE_PREFIX + counter.to_bytes(lc.COUNTER_BYTE_COUNT, "big")
        assert layout.hex() == entry["nonce_hex"]
        assert len(layout) == lc.NONCE_BYTE_COUNT == 12
        if lc.FIRST_COUNTER <= counter < lc.MAX_COUNTER:
            assert lc.encode_nonce(counter) == layout

    def test_counter_zero_layout_and_guard_divergence(self, vectors: dict) -> None:
        """差异声明（非放宽断言）：Swift `nonceData(forCounter:)` 接受任意 `UInt64`
        （向量据此含 counter=0），Python `encode_nonce` 带 1 ≤ n < 2**64 守卫
        （线上首帧 counter=1、不回绕，故该守卫在协议内不可达）。
        字节布局两边一致，差异只在守卫本身：这里同时断言布局相等与守卫行为。
        """
        entry = _entry(vectors["nonces"], counter=0)
        layout = lc.SESSION_NONCE_PREFIX + (0).to_bytes(lc.COUNTER_BYTE_COUNT, "big")
        assert layout == bytes(lc.NONCE_BYTE_COUNT)  # 4B 零前缀 + 8B 零计数
        assert layout.hex() == entry["nonce_hex"]
        with pytest.raises(lc.CryptoError):
            lc.encode_nonce(0)


class TestHelloSignatureVectors:
    def test_signing_input_signature_and_verification(self, vectors: dict) -> None:
        for entry in vectors["hello_signature"]:
            seed = b64(entry["seed_b64"])
            public_key = b64(entry["public_key_b64"])
            ephemeral = b64(entry["ephemeral_public_key_b64"])
            signature = b64(entry["signature_b64"])
            role, peer_device_id = entry["role"], entry["peer_device_id"]

            signing_input = lc.hello_signature_input(ephemeral, peer_device_id, role)
            assert signing_input.hex() == entry["signing_input_hex"]
            assert len(signing_input) == 32 + len(peer_device_id.encode()) + len(role.encode())

            # 签名字节**不可逐字节对齐**：Apple CryptoKit 的 Ed25519 用随机 r
            # （实测同 seed + 同消息两次签名得到不同字节，两者都验签通过），
            # pycryptodome 则是 RFC8032 确定性 r。跨语言保证因此是「双向验签」而非
            # 「字节相等」：向量签名必须被本模块验签通过，本模块签名也必须可被验签。
            assert lc.verify_signature(public_key, signing_input, signature) is True
            assert lc.verify_hello(public_key, signature, ephemeral, peer_device_id, role) is True

            ours = lc.sign_message(seed, signing_input)
            assert len(ours) == lc.SIGNATURE_BYTE_COUNT == 64
            assert ours == lc.sign_message(seed, signing_input)  # pycryptodome 确定性
            assert lc.verify_signature(public_key, signing_input, ours) is True

            identity = lc.Identity.from_private_key(seed)
            assert identity.public_key_raw == public_key
            assert identity.device_id == make_from_public_key(public_key)
            assert identity.device_id == lc.Identity.from_public_key(public_key).device_id

    def test_verify_hello_rejects_wrong_role_or_tampered_input(self, vectors: dict) -> None:
        """向量非空洞：换角色 / 换绑定 ID / 改公钥长度 / 改签名任一即失败。"""
        entry = vectors["hello_signature"][1]
        public_key = b64(entry["public_key_b64"])
        ephemeral = b64(entry["ephemeral_public_key_b64"])
        signature = b64(entry["signature_b64"])
        role, peer_device_id = entry["role"], entry["peer_device_id"]
        assert lc.verify_hello(public_key, signature, ephemeral, peer_device_id, role) is True
        other_role = "host" if role == "client" else "client"
        assert (
            lc.verify_hello(public_key, signature, ephemeral, peer_device_id, other_role) is False
        )
        assert lc.verify_hello(public_key, signature, ephemeral, "", role) is False
        assert (
            lc.verify_hello(public_key, signature, ephemeral + b"\x00", peer_device_id, role)
            is False
        )
        tampered = signature[:-1] + bytes([signature[-1] ^ 0xFF])
        assert lc.verify_hello(public_key, tampered, ephemeral, peer_device_id, role) is False

    def test_peer_view_cannot_sign(self, vectors: dict) -> None:
        public_key = b64(vectors["hello_signature"][0]["public_key_b64"])
        peer_view = lc.Identity.from_public_key(public_key)
        with pytest.raises(lc.CryptoError):
            peer_view.sign(b"x")


class TestKeyDerivationVectors:
    def test_direction_keys(self, vectors: dict) -> None:
        for entry in vectors["key_derivation"]:
            private_key = b64(entry["my_ephemeral_private_b64"])
            peer_public_key = b64(entry["peer_ephemeral_public_b64"])
            keys = lc.derive_session_keys(private_key, peer_public_key)
            assert keys.c2h.hex() == entry["client_to_host_hex"]
            assert keys.h2c.hex() == entry["host_to_client_hex"]
            assert len(keys.master) == len(keys.c2h) == len(keys.h2c) == lc.KEY_BYTE_COUNT
            assert keys.c2h != keys.h2c and keys.master not in (keys.c2h, keys.h2c)

    def test_dh_symmetry_and_role_mapping(self, vectors: dict) -> None:
        """DH 对称性：两端各自 (私钥, 对端公钥) 派生结果必须一致（成对条目互证）。"""
        entries = vectors["key_derivation"]
        pairs = 0
        for entry in entries:
            private_key = b64(entry["my_ephemeral_private_b64"])
            my_public_key = (
                ECC.construct(curve="X25519", seed=private_key)
                .public_key()
                .export_key(format="raw")
            )
            peer_public_key = b64(entry["peer_ephemeral_public_b64"])
            shared = lc.x25519_shared_secret(private_key, peer_public_key)
            for other in entries:
                if b64(other["peer_ephemeral_public_b64"]) != my_public_key:
                    continue
                pairs += 1
                assert (
                    lc.x25519_shared_secret(
                        b64(other["my_ephemeral_private_b64"]),
                        b64(other["peer_ephemeral_public_b64"]),
                    )
                    == shared
                )
                assert other["client_to_host_hex"] == entry["client_to_host_hex"]
                assert other["host_to_client_hex"] == entry["host_to_client_hex"]
        assert pairs == len(entries) == 4  # 4 条 = 2 组互证对

    def test_role_direction_mapping(self, vectors: dict) -> None:
        """host：send=h2c / recv=c2h；client 相反（方向密钥不可混用）。"""
        entry = vectors["key_derivation"][0]
        keys = lc.derive_session_keys(
            b64(entry["my_ephemeral_private_b64"]), b64(entry["peer_ephemeral_public_b64"])
        )
        host = keys.for_role(lc.ROLE_HOST)
        client = keys.for_role(lc.ROLE_CLIENT)
        assert (host.send, host.recv) == (keys.h2c, keys.c2h)
        assert (client.send, client.recv) == (keys.c2h, keys.h2c)
        with pytest.raises(lc.CryptoError):
            keys.for_role("peer")


class TestAEADVectors:
    """线上密文 = `nonce(12) ‖ ciphertext ‖ tag(16)`（Swift `SealedBox.combined`）。

    计数可达的向量（counter=1 / 7）走 `SessionCipher.seal` 全链路；
    counter=2**32 / 2**64-1 无法在测试里推进计数器，改用同一布局公式 + ChaCha20-Poly1305
    复算（见 `TestNonceVectors`）。
    """

    @staticmethod
    def _cipher(key: bytes) -> lc.SessionCipher:
        return lc.SessionCipher(lc.DirectionalKeys(send=key, recv=key))

    def test_counter_one_through_session_cipher(self, vectors: dict) -> None:
        entry = vectors["aead"][0]
        assert entry["counter"] == 1
        key = bytes.fromhex(entry["key_hex"])
        payload = self._cipher(key).seal(
            bytes.fromhex(entry["plaintext_hex"]), aad=bytes.fromhex(entry["aad_hex"])
        )
        assert payload.hex() == entry["combined_hex"]
        assert len(payload) == len(bytes.fromhex(entry["plaintext_hex"])) + lc.AEAD_OVERHEAD

    def test_counter_seven_through_session_cipher(self, vectors: dict) -> None:
        """推进到第 7 帧：前 6 帧占位，第 7 帧（空明文）须与向量逐字节一致。"""
        entry = _entry(vectors["aead"], counter=7)
        key = bytes.fromhex(entry["key_hex"])
        aad = bytes.fromhex(entry["aad_hex"])
        cipher = self._cipher(key)
        for _ in range(6):
            cipher.seal(b"warmup", aad=bytes.fromhex(vectors["aead"][0]["aad_hex"]))
        assert cipher.send_counter == 7
        assert (
            cipher.seal(bytes.fromhex(entry["plaintext_hex"]), aad=aad).hex()
            == entry["combined_hex"]
        )

    @pytest.mark.parametrize("counter", [4294967296, (1 << 64) - 1])
    def test_high_counter_vectors_use_documented_nonce_layout(
        self, vectors: dict, counter: int
    ) -> None:
        entry = _entry(vectors["aead"], counter=counter)
        key = bytes.fromhex(entry["key_hex"])
        aad = bytes.fromhex(entry["aad_hex"])
        plaintext = bytes.fromhex(entry["plaintext_hex"])
        nonce = lc.SESSION_NONCE_PREFIX + counter.to_bytes(lc.COUNTER_BYTE_COUNT, "big")
        cipher = ChaCha20_Poly1305.new(key=key, nonce=nonce)
        cipher.update(aad)
        ciphertext, tag = cipher.encrypt_and_digest(plaintext)
        assert (nonce + ciphertext + tag).hex() == entry["combined_hex"]

    def test_expected_authentication_failure_vector(self, vectors: dict) -> None:
        """末条向量 = AAD 加密位不符 → 必须认证失败（不是"随便解出明文"）。"""
        entry = _entry(vectors["aead"], counter=1, combined_hex="")
        key = bytes.fromhex(entry["key_hex"])
        plaintext = bytes.fromhex(entry["plaintext_hex"])
        good_aad = bytes.fromhex(vectors["aead"][0]["aad_hex"])  # flags=0x01（encrypted）
        bad_aad = bytes.fromhex(entry["aad_hex"])  # flags=0x00
        assert good_aad != bad_aad and good_aad[9] == FLAG_ENCRYPTED == 0x01

        sealed = self._cipher(key).seal(plaintext, aad=good_aad)
        receiver = self._cipher(key)
        with pytest.raises(lc.AuthenticationError):
            receiver.open(sealed, aad=bad_aad)
        assert receiver.recv_counter == 1  # 失败不推进计数
        assert receiver.open(sealed, aad=good_aad) == plaintext

    def test_two_way_session_round_trip_matches_vector(self, vectors: dict) -> None:
        """完整会话语义：c2h/h2c 两端各自 seal/open，密文与向量一致、明文回还原样。"""
        entry = vectors["key_derivation"][0]
        keys = lc.derive_session_keys(
            b64(entry["my_ephemeral_private_b64"]), b64(entry["peer_ephemeral_public_b64"])
        )
        aead_entry = vectors["aead"][0]
        aad = bytes.fromhex(aead_entry["aad_hex"])
        plaintext = bytes.fromhex(aead_entry["plaintext_hex"])
        client = lc.SessionCipher(lc.DirectionalKeys(send=keys.c2h, recv=keys.h2c))
        host = lc.SessionCipher(lc.DirectionalKeys(send=keys.h2c, recv=keys.c2h))
        sealed = client.seal(plaintext, aad=aad)
        assert sealed.hex() == aead_entry["combined_hex"]
        assert host.open(sealed, aad=aad) == plaintext
        assert host.send_counter == client.recv_counter == 1


class TestFrameVectors:
    def test_frame_encoding_bytes(self, vectors: dict) -> None:
        for entry in vectors["frames"]:
            payload = bytes.fromhex(entry["payload_hex"])
            frame_type, flags = int(entry["type"]), int(entry["flags"])
            encoded = encode_frame(frame_type, payload, flags=flags)
            assert encoded.hex() == entry["encoded_hex"]
            assert encoded[:4] == MAGIC == b"QQP1"
            assert int.from_bytes(encoded[4:8], "big") == len(payload)
            assert encoded[8] == frame_type and encoded[9] == flags
            assert len(encoded) == len(payload) + HEADER_LENGTH
            assert frame_type_name(frame_type) == FRAME_TYPE_NAMES[frame_type]

            frame = Frame(frame_type=frame_type, flags=flags, payload=payload)
            assert frame.encode() == encoded
            assert (
                frame.header
                == encoded[:HEADER_LENGTH]
                == build_header(frame_type, flags, len(payload))
            )
            assert frame.encrypted == bool(flags & FLAG_ENCRYPTED)

    def test_frame_stream_decoder_reassembles(self, vectors: dict) -> None:
        """流式拼帧：帧头跨块 + 任意切分 + 多帧一次到达都要还原出向量字节。"""
        for entry in vectors["frames"]:
            payload = bytes.fromhex(entry["payload_hex"])
            encoded = bytes.fromhex(entry["encoded_hex"])
            frame_type, flags = int(entry["type"]), int(entry["flags"])
            expected = Frame(frame_type=frame_type, flags=flags, payload=payload)

            decoder = FrameStreamDecoder()
            chunks = [encoded[:3], encoded[3:11]] + [
                encoded[offset : offset + 4096] for offset in range(11, len(encoded), 4096)
            ]
            assert sum(len(chunk) for chunk in chunks) == len(encoded)
            frames: list[Frame] = []
            for chunk in chunks:
                frames.extend(decoder.feed(chunk))
            assert frames == [expected]
            assert decoder.buffered_bytes == 0

    def test_byte_by_byte_feed(self, vectors: dict) -> None:
        """小帧逐字节喂入（覆盖最碎的边界切分）：末字节前不吐帧，之后恰好一帧。"""
        for entry in vectors["frames"]:
            if len(entry["encoded_hex"]) > 600:
                continue
            encoded = bytes.fromhex(entry["encoded_hex"])
            decoder = FrameStreamDecoder()
            frames: list[Frame] = []
            for index, byte in enumerate(encoded):
                frames.extend(decoder.feed(bytes([byte])))
                if index < len(encoded) - 1:
                    assert frames == [] and decoder.buffered_bytes == index + 1
            assert [frame.encode() for frame in frames] == [encoded]
            assert decoder.buffered_bytes == 0

    def test_multiple_frames_in_one_chunk(self, vectors: dict) -> None:
        encodings = [bytes.fromhex(entry["encoded_hex"]) for entry in vectors["frames"]]
        blob = b"".join(encodings)
        decoder = FrameStreamDecoder()
        frames = decoder.feed(blob)
        assert len(frames) == len(encodings)
        assert b"".join(frame.encode() for frame in frames) == blob
        assert decoder.buffered_bytes == 0
