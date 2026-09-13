"""局域网同步（S2）加密原语：Ed25519 身份 / X25519 会话 / HKDF 派生 / ChaCha20-Poly1305 AEAD。

与 Swift 端 `QQPlayer/Sync/` 加密实现对位，线协议契约见 `docs/lan-sync-protocol.md` §2
（握手签名输入 / 密钥派生档位 / nonce 规则 / AAD 约定）。

分层职责（本模块只做密码学，不碰帧与 IO）：

- **AAD 由会话层传入**：`= 完整 10B 帧头（"QQP1" + 4B 大端长度 + 1B type + 1B flags）`，
  其中长度为**加密后**的 payload 长度、flags 含 encrypted 位——加密器不拼帧头，
  保持"帧编码"与"加密"职责单一。
- **nonce 计数由本模块按方向维护**：12B = 4B 零前缀 ‖ 8B 大端计数器，首帧 counter = 1，
  收发各自独立；收方先比内嵌 nonce 再验 AEAD（防乱序 / 重放 / 回退）。

依赖：pycryptodome（backend 既有依赖）。原语正确性由 RFC 官方向量锁定
（RFC7748 §5.2/§6.1、RFC8032 §7.1、RFC5869 A.1-A.3、RFC8439 §2.8.2），
见 `backend/tests/test_lansync_crypto.py`。
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass

from Crypto.Cipher import ChaCha20_Poly1305
from Crypto.Hash import SHA256
from Crypto.Protocol import DH
from Crypto.Protocol.KDF import HKDF
from Crypto.PublicKey import ECC
from Crypto.Random import get_random_bytes
from Crypto.Signature import eddsa

from .deviceid import make_from_public_key

#: 密钥长度（Ed25519 种子 / X25519 私钥 / 共享密钥 / 会话密钥同为 32B）
KEY_BYTE_COUNT = 32
#: Ed25519 签名长度
SIGNATURE_BYTE_COUNT = 64
#: ChaCha20-Poly1305 nonce 长度
NONCE_BYTE_COUNT = 12
#: Poly1305 认证标签长度
TAG_BYTE_COUNT = 16
#: nonce 尾部计数器长度（大端）
COUNTER_BYTE_COUNT = 8
#: 会话 nonce 零前缀（`nonce = prefix(4) ‖ counter(8)`）
SESSION_NONCE_PREFIX = b"\x00\x00\x00\x00"
#: 加密载荷相对明文的固定膨胀（nonce + tag）
AEAD_OVERHEAD = NONCE_BYTE_COUNT + TAG_BYTE_COUNT

#: 计数器上界（不含）：8B 大端
MAX_COUNTER = 1 << (COUNTER_BYTE_COUNT * 8)
#: 首帧计数器
FIRST_COUNTER = 1

#: 角色名（线上字符串，与 Swift `SyncRole` 一致）
ROLE_HOST = "host"
ROLE_CLIENT = "client"
_ROLES = (ROLE_HOST, ROLE_CLIENT)

#: HKDF 派生档位（§2：master → 两个方向密钥）
MASTER_INFO = b"qqplayer-sync/v1/master"
C2H_INFO = b"qqplayer-sync/v1/dir/c2h"
H2C_INFO = b"qqplayer-sync/v1/dir/h2c"

#: X25519 SubjectPublicKeyInfo 前缀（RFC8410，OID 1.3.101.110）
_X25519_SPKI_PREFIX = bytes.fromhex("302a300506032b656e032100")
#: Ed25519 SubjectPublicKeyInfo 前缀（RFC8410，OID 1.3.101.112）
_ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")


class CryptoError(Exception):
    """加密原语层错误基类（参数非法 / 密钥不可用）。"""


class SignatureError(CryptoError):
    """签名验签失败。"""


class NonceMismatchError(CryptoError):
    """密文内嵌 nonce ≠ 期望接收计数（乱序 / 重放 / 回退）。"""


class AuthenticationError(CryptoError):
    """AEAD 校验失败（密文或 tag 被篡改 / AAD 不一致 / 载荷结构非法）。"""


def _require_bytes(value: object, expected: int, what: str) -> bytes:
    """校验"必须是恰好 expected 字节的 bytes"，返回不可变副本。"""
    if not isinstance(value, (bytes, bytearray)):
        raise CryptoError(f"{what} 必须是 bytes，实际 {type(value).__name__}")
    data = bytes(value)
    if len(data) != expected:
        raise CryptoError(f"{what} 长度必须是 {expected}B，实际 {len(data)}B")
    return data


def _raw_kdf(value: bytes) -> bytes:
    """DH 的 KDF 占位：直接返回原始共享密钥（派生交给 HKDF）。"""
    return value


def _ed25519_key(seed: bytes) -> ECC.EccKey:
    """由 32B 种子构造 Ed25519 密钥（RFC8032 风格）。"""
    return ECC.construct(curve="Ed25519", seed=seed)


def _x25519_key(seed: bytes) -> ECC.EccKey:
    """由 32B 私钥构造 X25519 密钥。

    注意：X25519 私钥**无法以 raw 格式导出**，原始字节由调用方自行持有。
    """
    return ECC.construct(curve="X25519", seed=seed)


def _ed25519_public_key(seed: bytes) -> bytes:
    """种子 → Ed25519 公钥 raw 32B。"""
    return _ed25519_key(seed).public_key().export_key(format="raw")


def _x25519_public_key(seed: bytes) -> bytes:
    """私钥 → X25519 公钥 raw 32B（与 RFC7748 X25519(a, 9) 一致）。"""
    return _x25519_key(seed).public_key().export_key(format="raw")


@dataclass(frozen=True, slots=True)
class Identity:
    """长期身份（Ed25519）：本机视角含私钥，对端视角仅公钥。

    - `private_key_raw`：32B 种子；`from_public_key` 构造的对端视图为 None，
      此时 `sign` / `sign_hello` 抛 `CryptoError`。
    - `device_id`：由公钥指纹推导（`SHA256(pub) → base32`），构造时校验一致性。
    """

    private_key_raw: bytes | None
    public_key_raw: bytes
    device_id: str = ""

    def __post_init__(self) -> None:
        public = _require_bytes(self.public_key_raw, KEY_BYTE_COUNT, "Ed25519 公钥")
        object.__setattr__(self, "public_key_raw", public)
        if self.private_key_raw is not None:
            private = _require_bytes(self.private_key_raw, KEY_BYTE_COUNT, "Ed25519 私钥")
            object.__setattr__(self, "private_key_raw", private)
            if _ed25519_public_key(private) != public:
                raise CryptoError("Ed25519 私钥与公钥不匹配")
        derived = make_from_public_key(public)
        if derived is None:  # pragma: no cover - 长度已校验，理论不可达
            raise CryptoError("Ed25519 公钥无法推导 Device ID")
        if self.device_id and self.device_id != derived:
            raise CryptoError("device_id 与公钥指纹不一致")
        object.__setattr__(self, "device_id", derived)

    @classmethod
    def generate(cls) -> Identity:
        """生成随机长期身份。"""
        return cls.from_private_key(get_random_bytes(KEY_BYTE_COUNT))

    @classmethod
    def from_private_key(cls, raw32: bytes) -> Identity:
        """由 32B 私钥种子构造；长度非 32B → `CryptoError`。"""
        seed = _require_bytes(raw32, KEY_BYTE_COUNT, "Ed25519 私钥")
        return cls(
            private_key_raw=seed,
            public_key_raw=_ed25519_public_key(seed),
        )

    @classmethod
    def from_public_key(cls, raw32: bytes) -> Identity:
        """仅由公钥构造（对端视图，无私钥，签名方法报错）；长度非 32B → `CryptoError`。"""
        public = _require_bytes(raw32, KEY_BYTE_COUNT, "Ed25519 公钥")
        return cls(private_key_raw=None, public_key_raw=public)

    @property
    def can_sign(self) -> bool:
        """本视图是否持有私钥。"""
        return self.private_key_raw is not None

    def sign(self, message: bytes) -> bytes:
        """Ed25519 签名（64B）；无签名能力时抛 `CryptoError`。"""
        if self.private_key_raw is None:
            raise CryptoError("对端视图（仅公钥）无法签名")
        return sign_message(self.private_key_raw, message)


@dataclass(frozen=True, slots=True)
class EphemeralKeypair:
    """一次性 X25519 密钥对（每次连接新生成，连接结束即弃）。"""

    private_key_raw: bytes
    public_key_raw: bytes

    def __post_init__(self) -> None:
        private = _require_bytes(self.private_key_raw, KEY_BYTE_COUNT, "X25519 私钥")
        public = _require_bytes(self.public_key_raw, KEY_BYTE_COUNT, "X25519 公钥")
        object.__setattr__(self, "private_key_raw", private)
        object.__setattr__(self, "public_key_raw", public)
        if _x25519_public_key(private) != public:
            raise CryptoError("X25519 私钥与公钥不匹配")

    @classmethod
    def generate(cls) -> EphemeralKeypair:
        """生成随机一次性密钥对。"""
        seed = get_random_bytes(KEY_BYTE_COUNT)
        return cls(private_key_raw=seed, public_key_raw=_x25519_public_key(seed))


def x25519_shared_secret(private_key_raw: bytes, peer_public_key_raw: bytes) -> bytes:
    """X25519 共享密钥（32B raw，**未哈希**；派生交给 HKDF）。

    对端公钥是裸 32B，需套 SPKI 前缀后才能 `import_key`（pycryptodome 不接受裸字节）。
    """
    private = _require_bytes(private_key_raw, KEY_BYTE_COUNT, "X25519 私钥")
    peer_raw = _require_bytes(peer_public_key_raw, KEY_BYTE_COUNT, "X25519 对端公钥")
    shared = DH.key_agreement(
        static_priv=_x25519_key(private),
        static_pub=ECC.import_key(_X25519_SPKI_PREFIX + peer_raw),
        kdf=_raw_kdf,
        ed25519=False,
        use_static=False,
    )
    return bytes(shared)


@dataclass(frozen=True, slots=True)
class DirectionalKeys:
    """某个角色的单向密钥对：`send` 用于本端加密，`recv` 用于解密对端。"""

    send: bytes
    recv: bytes


@dataclass(frozen=True, slots=True)
class SessionKeys:
    """会话密钥三档：`master` 与两个方向密钥（c2h = client→host，h2c = host→client）。"""

    master: bytes
    c2h: bytes
    h2c: bytes

    def for_role(self, role: str) -> DirectionalKeys:
        """按角色取方向密钥：host 发 h2c / 收 c2h，client 相反；未知角色 → `CryptoError`。"""
        if role == ROLE_HOST:
            return DirectionalKeys(send=self.h2c, recv=self.c2h)
        if role == ROLE_CLIENT:
            return DirectionalKeys(send=self.c2h, recv=self.h2c)
        raise CryptoError(f"未知角色：{role!r}")


def derive_session_keys(private_key_raw: bytes, peer_public_key_raw: bytes) -> SessionKeys:
    """由本端 ephemeral 私钥 + 对端 ephemeral 公钥派生会话密钥（§2 档位）。

    `shared → master = HKDF(shared, salt=b"", info=MASTER_INFO, 32)`
    `c2h/h2c = HKDF(master, salt=b"", info=.../dir/c2h|h2c, 32)`

    注意 salt 显式传 `b""`（协议约定），与 `salt=None` 语义不同。
    """
    shared = x25519_shared_secret(private_key_raw, peer_public_key_raw)
    master = HKDF(
        master=shared, key_len=KEY_BYTE_COUNT, salt=b"", hashmod=SHA256, context=MASTER_INFO
    )
    return SessionKeys(
        master=bytes(master),
        c2h=bytes(
            HKDF(master=master, key_len=KEY_BYTE_COUNT, salt=b"", hashmod=SHA256, context=C2H_INFO)
        ),
        h2c=bytes(
            HKDF(master=master, key_len=KEY_BYTE_COUNT, salt=b"", hashmod=SHA256, context=H2C_INFO)
        ),
    )


def hello_signature_input(ephemeral_public_key: bytes, peer_device_id: str, role: str) -> bytes:
    """握手签名输入 = `ephemeralPub(32B raw) ‖ peerDeviceID(utf8) ‖ role(utf8)`（§2）。"""
    ephemeral = _require_bytes(ephemeral_public_key, KEY_BYTE_COUNT, "ephemeralPublicKey")
    return ephemeral + peer_device_id.encode("utf-8") + role.encode("utf-8")


def sign_hello(
    identity: Identity,
    ephemeral_public_key: bytes,
    peer_device_id: str,
    role: str,
) -> bytes:
    """签本端 hello（64B）；角色非法或无签名能力 → `CryptoError`。"""
    if role not in _ROLES:
        raise CryptoError(f"角色非法：{role!r}")
    return identity.sign(hello_signature_input(ephemeral_public_key, peer_device_id, role))


def verify_hello(
    public_key_raw: bytes,
    signature: bytes,
    ephemeral_public_key: bytes,
    peer_device_id: str,
    role: str,
) -> bool:
    """验对端 hello 签名；任何不匹配（含长度非法 / 角色非法）一律 False，不抛异常。"""
    if role not in _ROLES:
        return False
    try:
        message = hello_signature_input(ephemeral_public_key, peer_device_id, role)
    except CryptoError:
        return False
    return verify_signature(public_key_raw, message, signature)


def verify_signature(public_key_raw: bytes, message: bytes, signature: bytes) -> bool:
    """通用 Ed25519 验签（`qr.NoncePool` 注入使用）。

    任何失败路径（公钥/签名长度非法、签名不通过）返回 False；不抛异常。
    """
    if len(public_key_raw) != KEY_BYTE_COUNT or len(signature) != SIGNATURE_BYTE_COUNT:
        return False
    if not isinstance(message, (bytes, bytearray)):
        return False
    try:
        verifier = eddsa.new(
            ECC.import_key(_ED25519_SPKI_PREFIX + bytes(public_key_raw)), "rfc8032"
        )
        verifier.verify(bytes(message), bytes(signature))
    except (ValueError, TypeError):
        return False
    return True


def sign_message(private_key_raw: bytes, message: bytes) -> bytes:
    """Ed25519 签名（64B）通用入口。"""
    private = _require_bytes(private_key_raw, KEY_BYTE_COUNT, "Ed25519 私钥")
    if not isinstance(message, (bytes, bytearray)):
        raise CryptoError(f"message 必须是 bytes，实际 {type(message).__name__}")
    return eddsa.new(_ed25519_key(private), "rfc8032").sign(bytes(message))


def device_public_key_from_base64(text: str) -> bytes | None:
    """standard base64 → Ed25519 公钥 raw 32B；非 base64 或长度不符 → None。"""
    if not isinstance(text, str) or not text:
        return None
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return None
    return raw if len(raw) == KEY_BYTE_COUNT else None


def encode_nonce(counter: int) -> bytes:
    """计数器 → 12B nonce（4B 零前缀 ‖ 8B 大端）；`counter` 从 1 起，越界 → `CryptoError`。"""
    if isinstance(counter, bool) or not isinstance(counter, int):
        raise CryptoError(f"计数器必须是 int，实际 {type(counter).__name__}")
    if counter < FIRST_COUNTER or counter >= MAX_COUNTER:
        raise CryptoError(f"计数器越界：{counter}（允许 1 ≤ n < 2**64）")
    return SESSION_NONCE_PREFIX + counter.to_bytes(COUNTER_BYTE_COUNT, "big")


def ciphertext_length(plaintext_length: int) -> int:
    """明文长度 → 密文（含 nonce/tag）长度 = 明文 + 28。"""
    if isinstance(plaintext_length, bool) or not isinstance(plaintext_length, int):
        raise CryptoError(f"明文长度必须是 int，实际 {type(plaintext_length).__name__}")
    if plaintext_length < 0:
        raise CryptoError(f"明文长度不能为负：{plaintext_length}")
    return plaintext_length + AEAD_OVERHEAD


def encrypted_payload_length(plaintext_length: int) -> int:
    """`ciphertext_length` 的别名（下游帧层两处命名口径一致）。"""
    return ciphertext_length(plaintext_length)


class SessionCipher:
    """单向会话加密器：发送 / 接收各自独立计数，首帧 counter = 1。

    - `seal` 返回 `nonce(12) ‖ ciphertext ‖ tag(16)`，成功后 `send_counter += 1`；
    - `open` **先**校验内嵌 nonce == 期望 `recv_counter`（不等 → `NonceMismatchError`），
      **再**做 AEAD 校验（失败 → `AuthenticationError`），成功后 `recv_counter += 1`。
    """

    __slots__ = ("_keys", "_recv_counter", "_send_counter")

    def __init__(self, keys: DirectionalKeys) -> None:
        _require_bytes(keys.send, KEY_BYTE_COUNT, "发送会话密钥")
        _require_bytes(keys.recv, KEY_BYTE_COUNT, "接收会话密钥")
        self._keys = keys
        self._send_counter = FIRST_COUNTER
        self._recv_counter = FIRST_COUNTER

    @property
    def send_counter(self) -> int:
        """下一个待用的发送计数器。"""
        return self._send_counter

    @property
    def recv_counter(self) -> int:
        """下一个期望的接收计数器。"""
        return self._recv_counter

    def seal(self, plaintext: bytes, *, aad: bytes) -> bytes:
        """加密并认证（AAD = 调用方传入的完整帧头）。"""
        if not isinstance(plaintext, (bytes, bytearray)):
            raise CryptoError(f"plaintext 必须是 bytes，实际 {type(plaintext).__name__}")
        aad_bytes = _require_aad(aad)
        nonce = encode_nonce(self._send_counter)
        cipher = ChaCha20_Poly1305.new(key=self._keys.send, nonce=nonce)
        cipher.update(aad_bytes)
        ciphertext, tag = cipher.encrypt_and_digest(bytes(plaintext))
        self._send_counter += 1
        return nonce + ciphertext + tag

    def open(self, payload: bytes, *, aad: bytes) -> bytes:
        """校验并解密（先 nonce 计数，后 AEAD）。"""
        aad_bytes = _require_aad(aad)
        if not isinstance(payload, (bytes, bytearray)):
            raise AuthenticationError(f"payload 必须是 bytes，实际 {type(payload).__name__}")
        data = bytes(payload)
        if len(data) < AEAD_OVERHEAD:
            raise AuthenticationError(f"加密载荷长度不足：{len(data)}B < {AEAD_OVERHEAD}B")
        nonce = data[:NONCE_BYTE_COUNT]
        ciphertext = data[NONCE_BYTE_COUNT:-TAG_BYTE_COUNT]
        tag = data[-TAG_BYTE_COUNT:]
        expected = encode_nonce(self._recv_counter)
        if nonce != expected:
            raise NonceMismatchError(
                f"密文内嵌 nonce 与期望计数不符：期望 counter={self._recv_counter}"
            )
        decipher = ChaCha20_Poly1305.new(key=self._keys.recv, nonce=nonce)
        decipher.update(aad_bytes)
        try:
            plaintext = decipher.decrypt_and_verify(ciphertext, tag)
        except ValueError as exc:
            raise AuthenticationError("AEAD 校验失败（密文/tag 被篡改或 AAD 不一致）") from exc
        self._recv_counter += 1
        return plaintext


def _require_aad(aad: object) -> bytes:
    """AAD 必须是 bytes（允许空 bytes，表示无关联数据）。"""
    if not isinstance(aad, (bytes, bytearray)):
        raise CryptoError(f"aad 必须是 bytes，实际 {type(aad).__name__}")
    return bytes(aad)
