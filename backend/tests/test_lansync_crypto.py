"""局域网同步加密原语测试：RFC 官方向量自证 + 协议语义正反例（§2 契约）。

证据分两层：
1. **原语正确性**——RFC7748 §5.2/§6.1、RFC8032 §7.1 TEST1-3、RFC5869 A.1-A.3、
   RFC8439 §2.8.2 逐字节比对（向量 hex 抄自 RFC 原文）。
2. **协议语义**——hello 签名绑定（ephemeralPub/peerDeviceID/role）、派生档位与方向、
   12B nonce 计数、乱序/重放/篡改/AAD 不一致全部必拒。

运行：cd backend && ./venv/bin/python -m pytest tests/test_lansync_crypto.py -q
"""

import base64

import pytest
from Crypto.Cipher import ChaCha20_Poly1305
from Crypto.Hash import SHA256
from Crypto.Protocol.KDF import HKDF

from app.lansync import crypto as lc

# ---------------------------------------------------------------------------
# RFC 7748：X25519
# ---------------------------------------------------------------------------

#: §5.2 第 1 组（scalar, u-coordinate, 期望输出）
RFC7748_VECTOR_1 = (
    "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
    "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c",
    "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
)
#: §5.2 第 2 组
RFC7748_VECTOR_2 = (
    "4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d",
    "e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493",
    "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957",
)
#: §6.1 Alice / Bob 密钥对与共享密钥
RFC7748_ALICE_PRIVATE = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"
RFC7748_ALICE_PUBLIC = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"
RFC7748_BOB_PRIVATE = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb"
RFC7748_BOB_PUBLIC = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"
RFC7748_SHARED = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"

# ---------------------------------------------------------------------------
# RFC 8032：Ed25519
# ---------------------------------------------------------------------------

#: §7.1 TEST1/TEST2/TEST3（seed, public, message, signature）
RFC8032_TESTS = (
    (
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "",
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
        "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    ),
    (
        "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
        "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
        "72",
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
        "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    ),
    (
        "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
        "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
        "af82",
        "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac"
        "18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
    ),
)

# ---------------------------------------------------------------------------
# RFC 8439：AEAD_CHACHA20_POLY1305（§2.8.2）
# ---------------------------------------------------------------------------

RFC8439_KEY = bytes.fromhex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
RFC8439_NONCE = bytes.fromhex("070000004041424344454647")
RFC8439_AAD = bytes.fromhex("50515253c0c1c2c3c4c5c6c7")
RFC8439_PLAINTEXT = (
    b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip "
    b"for the future, sunscreen would be it."
)
RFC8439_CIPHERTEXT = bytes.fromhex(
    "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b"
    "1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc"
    "3ff4def08e4b7a9de576d26586cec64b6116"
)
RFC8439_TAG = bytes.fromhex("1ae10b594f09e26a7e902ecbd0600691")


def _make_identity(seed_hex: str) -> lc.Identity:
    return lc.Identity.from_private_key(bytes.fromhex(seed_hex))


@pytest.fixture
def peer_session_keys() -> tuple[
    lc.SessionKeys, lc.SessionKeys, lc.EphemeralKeypair, lc.EphemeralKeypair
]:
    """两端各自派生出的相同会话密钥（A 视 B、B 视 A）。"""
    local = lc.EphemeralKeypair.generate()
    remote = lc.EphemeralKeypair.generate()
    keys_local = lc.derive_session_keys(local.private_key_raw, remote.public_key_raw)
    keys_remote = lc.derive_session_keys(remote.private_key_raw, local.public_key_raw)
    return keys_local, keys_remote, local, remote


# ---------------------------------------------------------------------------
# 1. 原语：RFC 7748 X25519
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("scalar", "u_coordinate", "expected"), [RFC7748_VECTOR_1, RFC7748_VECTOR_2]
)
def test_x25519_rfc7748_5_2(scalar: str, u_coordinate: str, expected: str) -> None:
    """RFC7748 §5.2：X25519(scalar, u) 逐字节一致。"""
    shared = lc.x25519_shared_secret(bytes.fromhex(scalar), bytes.fromhex(u_coordinate))
    assert shared.hex() == expected
    assert len(shared) == lc.KEY_BYTE_COUNT


def test_x25519_rfc7748_6_1_dh_both_sides_agree() -> None:
    """RFC7748 §6.1：Alice/Bob 两侧算出同一共享密钥，且等于 RFC 值。"""
    alice_shared = lc.x25519_shared_secret(
        bytes.fromhex(RFC7748_ALICE_PRIVATE), bytes.fromhex(RFC7748_BOB_PUBLIC)
    )
    bob_shared = lc.x25519_shared_secret(
        bytes.fromhex(RFC7748_BOB_PRIVATE), bytes.fromhex(RFC7748_ALICE_PUBLIC)
    )
    assert alice_shared == bob_shared
    assert alice_shared.hex() == RFC7748_SHARED


def test_x25519_rejects_bad_key_length() -> None:
    """裸公钥/私钥长度非 32B → CryptoError（裸 32B 以外一律拒）。"""
    with pytest.raises(lc.CryptoError):
        lc.x25519_shared_secret(b"\x01" * 31, bytes.fromhex(RFC7748_BOB_PUBLIC))
    with pytest.raises(lc.CryptoError):
        lc.x25519_shared_secret(bytes.fromhex(RFC7748_ALICE_PRIVATE), b"\x01" * 33)


def test_ephemeral_keypair_generate_is_consistent_and_unique() -> None:
    """一次性密钥对：公钥与私钥自洽（构造期校验），两次生成不重复。"""
    first = lc.EphemeralKeypair.generate()
    second = lc.EphemeralKeypair.generate()
    assert len(first.private_key_raw) == lc.KEY_BYTE_COUNT
    assert len(first.public_key_raw) == lc.KEY_BYTE_COUNT
    assert first.public_key_raw != second.public_key_raw
    # 双方互算一致（自洽性）
    assert lc.x25519_shared_secret(
        first.private_key_raw, second.public_key_raw
    ) == lc.x25519_shared_secret(second.private_key_raw, first.public_key_raw)
    # 公钥不匹配构造即拒
    with pytest.raises(lc.CryptoError):
        lc.EphemeralKeypair(
            private_key_raw=first.private_key_raw, public_key_raw=second.public_key_raw
        )


# ---------------------------------------------------------------------------
# 2. 原语：RFC 8032 Ed25519
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("seed", "public", "message", "signature"), RFC8032_TESTS)
def test_ed25519_rfc8032_7_1(seed: str, public: str, message: str, signature: str) -> None:
    """RFC8032 §7.1：seed→公钥、签名逐字节、SPKI 验签三连。"""
    identity = _make_identity(seed)
    payload = bytes.fromhex(message)
    assert identity.public_key_raw.hex() == public
    assert identity.sign(payload).hex() == signature
    # 用公钥（对端视图）SPKI 验签
    assert lc.verify_signature(bytes.fromhex(public), payload, bytes.fromhex(signature)) is True


def test_ed25519_signature_is_deterministic_and_message_bound() -> None:
    """RFC8032 确定性签名：同消息同签名；改一字节即验签失败。"""
    seed, public, message, _ = RFC8032_TESTS[2]
    identity = _make_identity(seed)
    payload = bytes.fromhex(message)
    assert identity.sign(payload) == identity.sign(payload)
    assert (
        lc.verify_signature(bytes.fromhex(public), payload + b"\x00", identity.sign(payload))
        is False
    )


def test_identity_from_public_key_view_cannot_sign() -> None:
    """对端视图（仅公钥）：device_id 可推、签名报错。"""
    seed, public, message, signature = RFC8032_TESTS[1]
    view = lc.Identity.from_public_key(bytes.fromhex(public))
    assert view.can_sign is False
    assert view.private_key_raw is None
    assert view.device_id == lc.Identity.from_private_key(bytes.fromhex(seed)).device_id
    with pytest.raises(lc.CryptoError):
        view.sign(bytes.fromhex(message))
    assert lc.verify_signature(
        view.public_key_raw, bytes.fromhex(message), bytes.fromhex(signature)
    )


def test_identity_length_and_consistency_guards() -> None:
    """身份构造守卫：长度错、私钥/公钥不匹配、device_id 与指纹不符都拒。"""
    seed, public, _, _ = RFC8032_TESTS[0]
    with pytest.raises(lc.CryptoError):
        lc.Identity.from_private_key(b"\x11" * 31)
    with pytest.raises(lc.CryptoError):
        lc.Identity.from_public_key(b"\x11" * 33)
    with pytest.raises(lc.CryptoError):
        # 私钥换成另一组的种子，公钥却还是本组的
        lc.Identity(
            private_key_raw=bytes.fromhex(RFC8032_TESTS[1][0]),
            public_key_raw=bytes.fromhex(public),
        )
    with pytest.raises(lc.CryptoError):
        # device_id 与公钥指纹不符
        lc.Identity(private_key_raw=None, public_key_raw=bytes.fromhex(public), device_id="A" * 52)


def test_identity_generate_produces_unique_ids() -> None:
    """随机身份：device_id 由公钥指纹推导且互不相同。"""
    first = lc.Identity.generate()
    second = lc.Identity.generate()
    assert first.device_id != second.device_id
    assert len(first.device_id) == 52
    assert first.can_sign is True


def test_verify_signature_rejects_malformed_inputs() -> None:
    """通用验签：长度非法/垃圾签名 → False（不抛异常）。"""
    _, public, message, signature = RFC8032_TESTS[0]
    good_pub = bytes.fromhex(public)
    good_sig = bytes.fromhex(signature)
    payload = bytes.fromhex(message)
    assert lc.verify_signature(b"\x00" * 31, payload, good_sig) is False
    assert lc.verify_signature(good_pub, payload, good_sig[:-1]) is False
    assert lc.verify_signature(good_pub, payload, b"\x00" * lc.SIGNATURE_BYTE_COUNT) is False
    assert lc.verify_signature(good_pub, "not-bytes", good_sig) is False


def test_sign_message_rejects_bad_inputs() -> None:
    """通用签名入口：私钥长度错 / message 非 bytes → CryptoError。"""
    with pytest.raises(lc.CryptoError):
        lc.sign_message(b"\x01" * 31, b"x")
    with pytest.raises(lc.CryptoError):
        lc.sign_message(bytes.fromhex(RFC8032_TESTS[0][0]), "x")  # type: ignore[arg-type]


def test_device_public_key_from_base64() -> None:
    """base64 公钥解析：32B 通过；长度不符/非法 base64/空串 → None。"""
    seed, public, _, _ = RFC8032_TESTS[0]
    encoded = base64.b64encode(bytes.fromhex(public)).decode()
    assert lc.device_public_key_from_base64(encoded) == bytes.fromhex(public)
    assert lc.device_public_key_from_base64(base64.b64encode(b"\x01" * 31).decode()) is None
    assert lc.device_public_key_from_base64("!!!not-base64!!!") is None
    assert lc.device_public_key_from_base64("") is None
    assert lc.device_public_key_from_base64(seed) is None  # 64 字节 hex 文本不是合法 32B base64


# ---------------------------------------------------------------------------
# 3. 原语：RFC 5869 HKDF-SHA256
# ---------------------------------------------------------------------------


def test_hkdf_rfc5869_a1_case1() -> None:
    """RFC5869 A.1 case1：带 salt/info，42B OKM 逐字节一致。"""
    okm = HKDF(
        master=bytes.fromhex("0b" * 22),
        key_len=42,
        salt=bytes.fromhex("000102030405060708090a0b0c"),
        hashmod=SHA256,
        context=bytes.fromhex("f0f1f2f3f4f5f6f7f8f9"),
    )
    assert okm.hex() == (
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    )


def test_hkdf_rfc5869_a1_case2_long_inputs() -> None:
    """RFC5869 A.1 case2：80B IKM/salt/info，82B OKM 逐字节一致。"""
    okm = HKDF(
        master=bytes(range(0x00, 0x50)),
        key_len=82,
        salt=bytes(range(0x60, 0xB0)),
        hashmod=SHA256,
        context=bytes(range(0xB0, 0x100)),
    )
    assert okm.hex() == (
        "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c"
        "59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71"
        "cc30c58179ec3e87c14c01d5c1f3434f1d87"
    )


def test_hkdf_rfc5869_a3_empty_salt_and_info() -> None:
    """RFC5869 A.3：salt=b"" / info=b""（**协议约定档位**）42B OKM 逐字节一致。"""
    okm = HKDF(master=bytes.fromhex("0b" * 22), key_len=42, salt=b"", hashmod=SHA256, context=b"")
    assert okm.hex() == (
        "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
    )


# ---------------------------------------------------------------------------
# 4. 原语：RFC 8439 ChaCha20-Poly1305 AEAD
# ---------------------------------------------------------------------------


def test_chacha20_poly1305_rfc8439_2_8_2() -> None:
    """RFC8439 §2.8.2：密文 + tag 逐字节一致，combined 结构 = 114+16。"""
    cipher = ChaCha20_Poly1305.new(key=RFC8439_KEY, nonce=RFC8439_NONCE)
    cipher.update(RFC8439_AAD)
    ciphertext, tag = cipher.encrypt_and_digest(RFC8439_PLAINTEXT)
    assert ciphertext == RFC8439_CIPHERTEXT
    assert tag == RFC8439_TAG
    assert len(ciphertext) == len(RFC8439_PLAINTEXT) == 114
    assert len(ciphertext) + len(tag) == 130


def test_chacha20_poly1305_rfc8439_tamper_rejected() -> None:
    """RFC8439 向量篡改（密文/tag/AAD）→ 解密 ValueError（上游转 AuthenticationError）。"""
    for bad_ciphertext, bad_tag, bad_aad in (
        (
            RFC8439_CIPHERTEXT[:-1] + bytes([RFC8439_CIPHERTEXT[-1] ^ 0x01]),
            RFC8439_TAG,
            RFC8439_AAD,
        ),
        (RFC8439_CIPHERTEXT, bytes([RFC8439_TAG[0] ^ 0x01]) + RFC8439_TAG[1:], RFC8439_AAD),
        (RFC8439_CIPHERTEXT, RFC8439_TAG, bytes([RFC8439_AAD[0] ^ 0x01]) + RFC8439_AAD[1:]),
    ):
        decipher = ChaCha20_Poly1305.new(key=RFC8439_KEY, nonce=RFC8439_NONCE)
        decipher.update(bad_aad)
        with pytest.raises(ValueError):
            decipher.decrypt_and_verify(bad_ciphertext, bad_tag)


# ---------------------------------------------------------------------------
# 5. 协议语义：nonce 与长度口径
# ---------------------------------------------------------------------------


def test_encode_nonce_layout() -> None:
    """nonce = 4B 零前缀 ‖ 8B 大端计数器；首帧 counter = 1。"""
    assert lc.SESSION_NONCE_PREFIX == b"\x00\x00\x00\x00"
    assert lc.encode_nonce(1) == b"\x00" * 11 + b"\x01"
    assert lc.encode_nonce(2) == b"\x00" * 11 + b"\x02"
    assert lc.encode_nonce(0x0102030405060708) == b"\x00" * 4 + bytes.fromhex("0102030405060708")
    assert len(lc.encode_nonce(lc.MAX_COUNTER - 1)) == lc.NONCE_BYTE_COUNT


@pytest.mark.parametrize("counter", [0, -1, lc.MAX_COUNTER, lc.MAX_COUNTER + 1])
def test_encode_nonce_rejects_out_of_range(counter: int) -> None:
    """计数器 <1 或 ≥2**64 → CryptoError（回退/溢出不允许）。"""
    with pytest.raises(lc.CryptoError):
        lc.encode_nonce(counter)


def test_encode_nonce_rejects_non_int() -> None:
    """非 int（含 bool）→ CryptoError。"""
    with pytest.raises(lc.CryptoError):
        lc.encode_nonce("1")  # type: ignore[arg-type]
    with pytest.raises(lc.CryptoError):
        lc.encode_nonce(True)


def test_ciphertext_length_matches_aead_overhead() -> None:
    """密文长度 = 明文 + 28（nonce12 + tag16）；两处命名口径一致。"""
    assert lc.AEAD_OVERHEAD == 28
    assert lc.ciphertext_length(0) == 28
    assert lc.ciphertext_length(114) == 142
    assert lc.encrypted_payload_length(4096) == lc.ciphertext_length(4096) == 4124
    with pytest.raises(lc.CryptoError):
        lc.ciphertext_length(-1)


# ---------------------------------------------------------------------------
# 6. 协议语义：密钥派生与方向
# ---------------------------------------------------------------------------


def test_derive_session_keys_both_sides_agree(peer_session_keys) -> None:
    """双方各自派生：master/c2h/h2c 完全相同（对称性）。"""
    keys_local, keys_remote, _, _ = peer_session_keys
    assert keys_local.master == keys_remote.master
    assert keys_local.c2h == keys_remote.c2h
    assert keys_local.h2c == keys_remote.h2c
    assert len(keys_local.master) == lc.KEY_BYTE_COUNT


def test_derive_session_keys_matches_protocol_ladder(peer_session_keys) -> None:
    """派生档位逐字节锁定：shared → master/c2h/h2c（info 字面量，salt=b""）。"""
    keys_local, _, local, remote = peer_session_keys
    shared = lc.x25519_shared_secret(local.private_key_raw, remote.public_key_raw)
    expected_master = HKDF(
        master=shared, key_len=32, salt=b"", hashmod=SHA256, context=b"qqplayer-sync/v1/master"
    )
    assert keys_local.master == expected_master
    assert keys_local.c2h == HKDF(
        master=expected_master,
        key_len=32,
        salt=b"",
        hashmod=SHA256,
        context=b"qqplayer-sync/v1/dir/c2h",
    )
    assert keys_local.h2c == HKDF(
        master=expected_master,
        key_len=32,
        salt=b"",
        hashmod=SHA256,
        context=b"qqplayer-sync/v1/dir/h2c",
    )
    assert lc.MASTER_INFO == b"qqplayer-sync/v1/master"
    assert lc.C2H_INFO == b"qqplayer-sync/v1/dir/c2h"
    assert lc.H2C_INFO == b"qqplayer-sync/v1/dir/h2c"


def test_for_role_does_not_mix_directions(peer_session_keys) -> None:
    """方向密钥不可混用：host.send == client.recv 且 host.send != host.recv。"""
    keys, _, _, _ = peer_session_keys
    host = keys.for_role("host")
    client = keys.for_role("client")
    assert host.send == keys.h2c
    assert host.recv == keys.c2h
    assert client.send == keys.c2h
    assert client.recv == keys.h2c
    assert host.send == client.recv
    assert host.recv == client.send
    assert host.send != host.recv
    assert host.send != keys.master  # master 不直接当会话密钥


def test_for_role_rejects_unknown_role(peer_session_keys) -> None:
    """未知角色 → CryptoError。"""
    keys, _, _, _ = peer_session_keys
    for role in ("", "Client", "HOST", "server"):
        with pytest.raises(lc.CryptoError):
            keys.for_role(role)


# ---------------------------------------------------------------------------
# 7. 协议语义：hello 签名
# ---------------------------------------------------------------------------


def test_hello_signature_input_layout() -> None:
    """签名输入 = ephemeralPub(32B) ‖ peerDeviceID(utf8) ‖ role(utf8)。"""
    ephemeral = bytes(range(32))
    message = lc.hello_signature_input(ephemeral, "ABCD-1234", "client")
    assert message == ephemeral + b"ABCD-1234" + b"client"
    assert lc.hello_signature_input(ephemeral, "", "host") == ephemeral + b"host"


def test_hello_round_trip_ok() -> None:
    """正确组合：本端签名 → 对端用公钥验签通过（host / client 两侧）。"""
    identity = lc.Identity.generate()
    ephemeral = lc.EphemeralKeypair.generate()
    for role, peer_device_id in (("client", "HOSTID"), ("host", "CLIENTID"), ("client", "")):
        signature = lc.sign_hello(identity, ephemeral.public_key_raw, peer_device_id, role)
        assert len(signature) == lc.SIGNATURE_BYTE_COUNT
        assert (
            lc.verify_hello(
                identity.public_key_raw, signature, ephemeral.public_key_raw, peer_device_id, role
            )
            is True
        )


def test_hello_signature_binding_negative_cases() -> None:
    """签名绑定：改 ephemeralPub / 改 peerDeviceID / 改 role 必须验签失败。"""
    identity = lc.Identity.generate()
    ephemeral = lc.EphemeralKeypair.generate()
    signature = lc.sign_hello(identity, ephemeral.public_key_raw, ascii_device_id(), "client")
    other_ephemeral = lc.EphemeralKeypair.generate()

    # 换 ephemeral 公钥
    assert (
        lc.verify_hello(
            identity.public_key_raw,
            signature,
            other_ephemeral.public_key_raw,
            ascii_device_id(),
            "client",
        )
        is False
    )
    # 换 peerDeviceID
    assert (
        lc.verify_hello(
            identity.public_key_raw, signature, ephemeral.public_key_raw, "OTHER", "client"
        )
        is False
    )
    # 换 role（跨角色重放）
    assert (
        lc.verify_hello(
            identity.public_key_raw, signature, ephemeral.public_key_raw, ascii_device_id(), "host"
        )
        is False
    )
    # 换对端公钥（别人冒充）
    impostor = lc.Identity.generate()
    assert (
        lc.verify_hello(
            impostor.public_key_raw,
            signature,
            ephemeral.public_key_raw,
            ascii_device_id(),
            "client",
        )
        is False
    )


def test_verify_hello_never_raises_on_malformed_input() -> None:
    """非法输入（长度错 / 角色非法 / 签名垃圾）→ False，不抛异常。"""
    identity = lc.Identity.generate()
    ephemeral = lc.EphemeralKeypair.generate()
    signature = lc.sign_hello(identity, ephemeral.public_key_raw, "PEER", "client")
    assert (
        lc.verify_hello(identity.public_key_raw, signature, b"\x00" * 31, "PEER", "client") is False
    )
    assert (
        lc.verify_hello(
            identity.public_key_raw, signature, ephemeral.public_key_raw, "PEER", "bogus"
        )
        is False
    )
    assert (
        lc.verify_hello(
            identity.public_key_raw, b"\x00" * 64, ephemeral.public_key_raw, "PEER", "client"
        )
        is False
    )


def test_sign_hello_rejects_bad_role_and_public_only_identity() -> None:
    """签名侧守卫：角色非法 / 对端视图无私钥 → CryptoError。"""
    identity = lc.Identity.generate()
    ephemeral = lc.EphemeralKeypair.generate()
    with pytest.raises(lc.CryptoError):
        lc.sign_hello(identity, ephemeral.public_key_raw, "PEER", "server")
    view = lc.Identity.from_public_key(identity.public_key_raw)
    with pytest.raises(lc.CryptoError):
        lc.sign_hello(view, ephemeral.public_key_raw, "PEER", "client")


def ascii_device_id() -> str:
    """测试用对端 Device ID（签名输入按 utf8 拼接，取值本身不重要）。"""
    return "A" * 52


# ---------------------------------------------------------------------------
# 8. 协议语义：SessionCipher
# ---------------------------------------------------------------------------


def _frame_head(payload_length: int) -> bytes:
    """测试用 10B 帧头（AAD）：magic + 4B 大端长度 + type + flags（encrypted=1）。"""
    return b"QQP1" + payload_length.to_bytes(4, "big") + bytes([6, 0x01])


def test_session_cipher_first_frame_counter_is_one(peer_session_keys) -> None:
    """首帧 counter = 1，收发独立计数。"""
    keys, _, _, _ = peer_session_keys
    cipher = lc.SessionCipher(keys.for_role("host"))
    assert cipher.send_counter == 1
    assert cipher.recv_counter == 1
    payload = cipher.seal(b"hello", aad=_frame_head(5))
    assert payload[: lc.NONCE_BYTE_COUNT] == lc.encode_nonce(1)
    assert cipher.send_counter == 2
    assert cipher.recv_counter == 1  # seal 不影响接收计数


def test_session_cipher_seal_matches_manual_aead(peer_session_keys) -> None:
    """seal 输出 = nonce ‖ ct ‖ tag（与手工 AEAD 逐字节一致，AAD 原样透传）。"""
    keys, _, _, _ = peer_session_keys
    directional = keys.for_role("host")
    cipher = lc.SessionCipher(directional)
    plaintext = b"frame body"
    aad = _frame_head(lc.ciphertext_length(len(plaintext)))
    payload = cipher.seal(plaintext, aad=aad)

    manual = ChaCha20_Poly1305.new(key=directional.send, nonce=lc.encode_nonce(1))
    manual.update(aad)
    ciphertext, tag = manual.encrypt_and_digest(plaintext)
    assert payload == lc.encode_nonce(1) + ciphertext + tag
    assert len(payload) == lc.ciphertext_length(len(plaintext))


@pytest.mark.parametrize("size", [0, 1, 15, 4096, 65536])
def test_session_cipher_round_trip(peer_session_keys, size: int) -> None:
    """seal + open 往返（含空载荷与 64KiB 大载荷），帧头按加密后长度构造。"""
    keys, _, _, _ = peer_session_keys
    sender = lc.SessionCipher(keys.for_role("host"))
    receiver = lc.SessionCipher(keys.for_role("client"))
    plaintext = bytes((index * 7 + 3) % 256 for index in range(size))
    aad = _frame_head(lc.ciphertext_length(size))
    payload = sender.seal(plaintext, aad=aad)
    assert receiver.open(payload, aad=aad) == plaintext
    assert (sender.send_counter, receiver.recv_counter) == (2, 2)


def test_session_cipher_cross_direction_flow(peer_session_keys) -> None:
    """双向会话：host 与 client 各持自己的收发密钥，互不干扰。"""
    keys, _, _, _ = peer_session_keys
    host = lc.SessionCipher(keys.for_role("host"))
    client = lc.SessionCipher(keys.for_role("client"))
    for index in range(3):
        host_aad = _frame_head(lc.ciphertext_length(len(b"host")))
        client_aad = _frame_head(lc.ciphertext_length(len(b"client")))
        assert client.open(host.seal(b"host", aad=host_aad), aad=host_aad) == b"host"
        assert host.open(client.seal(b"client", aad=client_aad), aad=client_aad) == b"client"
        assert host.recv_counter == client.send_counter == index + 2
        assert host.send_counter == client.recv_counter == index + 2


def test_session_cipher_rejects_out_of_order(peer_session_keys) -> None:
    """乱序必拒：期望 counter=1 时收到 counter=2 的密文 → NonceMismatchError。"""
    keys, _, _, _ = peer_session_keys
    sender = lc.SessionCipher(keys.for_role("host"))
    receiver = lc.SessionCipher(keys.for_role("client"))
    aad_first = _frame_head(lc.ciphertext_length(4))
    aad_second = _frame_head(lc.ciphertext_length(4))
    first = sender.seal(b"one!", aad=aad_first)
    second = sender.seal(b"two!", aad=aad_second)
    with pytest.raises(lc.NonceMismatchError):
        receiver.open(second, aad=aad_second)
    assert receiver.recv_counter == 1  # 拒绝后计数不前移
    assert receiver.open(first, aad=aad_first) == b"one!"
    assert receiver.open(second, aad=aad_second) == b"two!"


def test_session_cipher_rejects_replay(peer_session_keys) -> None:
    """重放必拒：同一密文第二次 open → NonceMismatchError。"""
    keys, _, _, _ = peer_session_keys
    sender = lc.SessionCipher(keys.for_role("host"))
    receiver = lc.SessionCipher(keys.for_role("client"))
    aad = _frame_head(lc.ciphertext_length(5))
    payload = sender.seal(b"replay", aad=aad)
    assert receiver.open(payload, aad=aad) == b"replay"
    with pytest.raises(lc.NonceMismatchError):
        receiver.open(payload, aad=aad)


def test_session_cipher_rejects_rollback_ciphertext(peer_session_keys) -> None:
    """回退必拒：收满 2 帧后再喂第 1 帧的密文 → NonceMismatchError。"""
    keys, _, _, _ = peer_session_keys
    sender = lc.SessionCipher(keys.for_role("host"))
    receiver = lc.SessionCipher(keys.for_role("client"))
    aad = _frame_head(lc.ciphertext_length(2))
    first = sender.seal(b"a1", aad=aad)
    second = sender.seal(b"a2", aad=aad)
    assert receiver.open(first, aad=aad) == b"a1"
    assert receiver.open(second, aad=aad) == b"a2"
    with pytest.raises(lc.NonceMismatchError):
        receiver.open(first, aad=aad)


def test_session_cipher_rejects_tampered_ciphertext_and_tag(peer_session_keys) -> None:
    """篡改密文 / tag → AuthenticationError（且不改动接收计数）。"""
    keys, _, _, _ = peer_session_keys
    sender = lc.SessionCipher(keys.for_role("host"))
    receiver = lc.SessionCipher(keys.for_role("client"))
    aad = _frame_head(lc.ciphertext_length(6))
    payload = sender.seal(b"secret", aad=aad)

    tampered_body = bytearray(payload)
    tampered_body[lc.NONCE_BYTE_COUNT] ^= 0x01  # 动密文首字节
    with pytest.raises(lc.AuthenticationError):
        receiver.open(bytes(tampered_body), aad=aad)

    tampered_tag = bytearray(payload)
    tampered_tag[-1] ^= 0x01  # 动 tag 末字节
    with pytest.raises(lc.AuthenticationError):
        receiver.open(bytes(tampered_tag), aad=aad)

    assert receiver.recv_counter == 1
    assert receiver.open(payload, aad=aad) == b"secret"  # 原密文仍可解


def test_session_cipher_rejects_aad_mismatch(peer_session_keys) -> None:
    """AAD 不一致必拒（长度字段/encrypted 位不同即 AuthenticationError）。"""
    keys, _, _, _ = peer_session_keys
    sender = lc.SessionCipher(keys.for_role("host"))
    receiver = lc.SessionCipher(keys.for_role("client"))
    plaintext = b"aad-bound"
    aad = _frame_head(lc.ciphertext_length(len(plaintext)))
    payload = sender.seal(plaintext, aad=aad)

    wrong_length_aad = _frame_head(lc.ciphertext_length(len(plaintext)) + 1)
    with pytest.raises(lc.AuthenticationError):
        receiver.open(payload, aad=wrong_length_aad)

    wrong_flag_aad = aad[:9] + bytes([0x00])  # 去掉 encrypted 位
    with pytest.raises(lc.AuthenticationError):
        receiver.open(payload, aad=wrong_flag_aad)

    with pytest.raises(lc.AuthenticationError):
        receiver.open(payload, aad=b"")  # 完全不一致

    assert receiver.open(payload, aad=aad) == plaintext


def test_session_cipher_cross_key_and_short_payload_rejected(peer_session_keys) -> None:
    """用错方向密钥 → AuthenticationError；载荷短于 28B → AuthenticationError。"""
    keys, _, _, _ = peer_session_keys
    directional = keys.for_role("host")
    sender = lc.SessionCipher(directional)
    aad = _frame_head(lc.ciphertext_length(4))
    payload = sender.seal(b"body", aad=aad)

    crossed = lc.SessionCipher(lc.DirectionalKeys(send=directional.recv, recv=directional.recv))
    with pytest.raises(lc.AuthenticationError):
        crossed.open(payload, aad=aad)

    receiver = lc.SessionCipher(keys.for_role("client"))
    with pytest.raises(lc.AuthenticationError):
        receiver.open(payload[: lc.AEAD_OVERHEAD - 1], aad=aad)


def test_session_cipher_rejects_bad_arguments(peer_session_keys) -> None:
    """参数守卫：密钥长度错、AAD/明文/载荷非 bytes → CryptoError。"""
    keys, _, _, _ = peer_session_keys
    with pytest.raises(lc.CryptoError):
        lc.SessionCipher(lc.DirectionalKeys(send=b"\x01" * 31, recv=b"\x02" * 32))
    cipher = lc.SessionCipher(keys.for_role("host"))
    with pytest.raises(lc.CryptoError):
        cipher.seal("not-bytes", aad=b"")  # type: ignore[arg-type]
    with pytest.raises(lc.CryptoError):
        cipher.seal(b"ok", aad="not-bytes")  # type: ignore[arg-type]
    with pytest.raises(lc.AuthenticationError):
        cipher.open(b"short", aad=b"")


def test_error_hierarchy_matches_contract() -> None:
    """异常层次：Signature/NonceMismatch/Authentication 均为 CryptoError 子类。"""
    assert issubclass(lc.SignatureError, lc.CryptoError)
    assert issubclass(lc.NonceMismatchError, lc.CryptoError)
    assert issubclass(lc.AuthenticationError, lc.CryptoError)
    assert issubclass(lc.CryptoError, Exception)
