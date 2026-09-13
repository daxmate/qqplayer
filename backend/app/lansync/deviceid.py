"""Device ID 编解码（S2 局域网同步，与 Swift `DeviceID.swift` 逐行为对位）。

- 全量 ID = `SHA256(Ed25519 公钥 raw 32B)` → RFC4648 base32 大写、无填充（52 字符）
- 展示格式 = 每 7 字符一组、`-` 分隔（52 = 7×7 + 3，共 8 组）
- 手输规范化 = 去 `-`/空白 → 大写 → 长度 52 → base32 解码（32B、尾部填充位为 0）→ 回写

base32 为本地最小 RFC4648 实现（标准库无 base32 的"无填充大写"变体语义），
编解码均以 RFC 4648 §10 测试向量锁定（见 `backend/tests/test_lansync_deviceid.py`）。
"""

from __future__ import annotations

import hashlib

#: 指纹摘要长度（SHA-256 = 32 字节）
FINGERPRINT_BYTE_COUNT = 32
#: 全量 ID 长度（32 字节 → base32 无填充 = 52 字符）
FULL_LENGTH = 52
#: 展示分组宽度
GROUP_WIDTH = 7
#: RFC4648 base32 字母表（大写 A-Z + 2-7）
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
#: 字母表反查
_CHAR_VALUE = {char: index for index, char in enumerate(ALPHABET)}


def base32_encode(data: bytes) -> str:
    """RFC4648 base32 编码（大写、无填充）。空输入 → 空串。"""
    if not data:
        return ""
    out: list[str] = []
    buffer = 0
    bits = 0
    for byte in data:
        buffer = (buffer << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append(ALPHABET[(buffer >> bits) & 0x1F])
    if bits > 0:
        out.append(ALPHABET[(buffer << (5 - bits)) & 0x1F])
    return "".join(out)


def base32_decode(text: str) -> bytes | None:
    """RFC4648 base32 解码（容忍 `=` 填充、容忍小写）。

    非法字符返回 None；**尾部未用足的比特位必须为 0**，否则返回 None
    （拒绝非规范编码，与 Swift `base32Decode` 同语义）。
    """
    out = bytearray()
    buffer = 0
    bits = 0
    for char in text.upper():
        if char == "=":
            continue
        value = _CHAR_VALUE.get(char)
        if value is None:
            return None
        buffer = (buffer << 5) | value
        bits += 5
        if bits >= 8:
            bits -= 8
            out.append((buffer >> bits) & 0xFF)
    if bits > 0 and buffer & ((1 << bits) - 1) != 0:
        return None
    return bytes(out)


def make_from_public_key(public_key_raw: bytes) -> str | None:
    """由 Ed25519 公钥 raw（32B）生成全量 Device ID；长度非 32B 返回 None。"""
    if len(public_key_raw) != FINGERPRINT_BYTE_COUNT:
        return None
    return base32_encode(hashlib.sha256(public_key_raw).digest())


def fingerprint_matches(device_id: str, public_key_raw: bytes) -> bool:
    """deviceID 与公钥指纹一致性校验（配对握手核心校验）。

    device_id 可带分隔符/空白（内部先规范化）；公钥非 32B 恒 False。
    """
    if len(public_key_raw) != FINGERPRINT_BYTE_COUNT:
        return False
    canonical = normalize(device_id)
    if canonical is None:
        return False
    return canonical == make_from_public_key(public_key_raw)


def normalize(text: str) -> str | None:
    """手输输入 → 规范化全量 ID：去 `-`/空白、统一大写、长度 52、base32 往返。

    失败返回 None；规范化回写保证全量值唯一形态（填充位非 0 的"怪"输入被拒）。
    """
    stripped = "".join(char for char in text.upper() if not char.isspace() and char != "-")
    if len(stripped) != FULL_LENGTH:
        return None
    decoded = base32_decode(stripped)
    if decoded is None or len(decoded) != FINGERPRINT_BYTE_COUNT:
        return None
    return base32_encode(decoded)


def is_valid(text: str) -> bool:
    """输入是否为合法 Device ID（等价于 `normalize(text) is not None`）。"""
    return normalize(text) is not None


def formatted(full_id: str) -> str:
    """全量 → 分组展示（每 7 字符一组、`-` 分隔）。长度不符时原样返回。"""
    if len(full_id) != FULL_LENGTH:
        return full_id
    groups = [full_id[index : index + GROUP_WIDTH] for index in range(0, len(full_id), GROUP_WIDTH)]
    return "-".join(groups)


def short_comparison_parts(full_id: str) -> tuple[str, str] | None:
    """首组 + 末组（手输后二次核对用）。非法输入返回 None。"""
    canonical = normalize(full_id)
    if canonical is None:
        return None
    groups = formatted(canonical).split("-")
    if not groups:
        return None
    return groups[0], groups[-1]
