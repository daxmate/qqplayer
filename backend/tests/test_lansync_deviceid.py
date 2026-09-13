"""Device ID 编解码测试（协议 §4；契约名见 `docs/lan-sync-protocol.md`）。

覆盖：RFC4648 §10 官方向量 / make_from_public_key / normalize 正反例（长度·非法字符·
填充位·分隔符·空白·小写）/ formatted 分组 / fingerprint_matches / short_comparison_parts。
"""

from __future__ import annotations

import base64
import hashlib

import pytest

from app.lansync.deviceid import (
    ALPHABET,
    FINGERPRINT_BYTE_COUNT,
    FULL_LENGTH,
    base32_decode,
    base32_encode,
    fingerprint_matches,
    formatted,
    is_valid,
    make_from_public_key,
    normalize,
    short_comparison_parts,
)

#: RFC4648 §10 官方 base32 向量（本实现无填充，故去掉尾部 "="）
RFC4648_VECTORS = [
    (b"", ""),
    (b"f", "MY"),
    (b"fo", "MZXQ"),
    (b"foo", "MZXW6"),
    (b"foob", "MZXW6YQ"),
    (b"fooba", "MZXW6YTB"),
    (b"foobar", "MZXW6YTBOI"),
]


def public_key(seed: bytes) -> bytes:
    """确定性 32B 假公钥（测试用；非真 Ed25519，但长度与分布符合契约）。"""
    return hashlib.sha256(seed).digest()


def device_id_for(seed: bytes) -> str:
    """由种子推出合法全量 Device ID（52 字符 base32）。"""
    result = make_from_public_key(public_key(seed))
    assert result is not None
    return result


class TestBase32Rfc4648:
    @pytest.mark.parametrize(("raw", "text"), RFC4648_VECTORS)
    def test_encode_official_vectors(self, raw: bytes, text: str) -> None:
        assert base32_encode(raw) == text

    @pytest.mark.parametrize(("raw", "text"), RFC4648_VECTORS)
    def test_decode_official_vectors_unpadded(self, raw: bytes, text: str) -> None:
        assert base32_decode(text) == raw

    @pytest.mark.parametrize(("raw", "text"), RFC4648_VECTORS)
    def test_decode_official_vectors_padded(self, raw: bytes, text: str) -> None:
        padded = base64.b32encode(raw).decode()
        assert base32_decode(padded) == raw

    def test_matches_stdlib_b32encode_for_all_lengths(self) -> None:
        for size in range(0, 40):
            raw = bytes(range(size))
            assert base32_encode(raw) == base64.b32encode(raw).decode().rstrip("=")

    def test_no_padding_ever_emitted(self) -> None:
        assert "=" not in base32_encode(b"\xff" * 32)
        assert len(base32_encode(b"\xff" * 32)) == FULL_LENGTH

    def test_empty_inputs(self) -> None:
        assert base32_encode(b"") == ""
        assert base32_decode("") == b""

    def test_decode_rejects_illegal_characters(self) -> None:
        for bad in ("!", "0", "1", "8", "9", "MZXW6-", "MZX W6"):
            assert base32_decode(bad) is None

    def test_decode_rejects_nonzero_padding_bits(self) -> None:
        # 2 字符 = 10 位数据 + 0 位尾？不：10 位只够 1 字节 + 2 位填充；"MY" 填充为 0，"MZ" 非 0 → 拒
        assert base32_decode("MY") == b"f"
        assert base32_decode("MZ") is None
        # 4 字符 = 20 位 = 2 字节 + 4 位填充；"MZXQ" 填充为 0，"MZXR" 非 0 → 拒
        assert base32_decode("MZXQ") == b"fo"
        assert base32_decode("MZXR") is None
        # 8 字符 = 正好 5 字节，无填充位：末字符任意值都合法
        assert base32_decode("MZXW6YTB") == b"fooba"
        assert base32_decode("MZXW6YTC") == b"foobb"

    def test_decode_accepts_lowercase(self) -> None:
        assert base32_decode("mzxw6ytboi") == b"foobar"


class TestMakeFromPublicKey:
    def test_matches_definition(self) -> None:
        key = public_key(b"host-key")
        expected = base32_encode(hashlib.sha256(key).digest())
        assert make_from_public_key(key) == expected

    def test_full_length_and_alphabet(self) -> None:
        result = make_from_public_key(public_key(b"x"))
        assert result is not None
        assert len(result) == FULL_LENGTH == 52
        assert set(result) <= set(ALPHABET)

    def test_deterministic(self) -> None:
        key = public_key(b"same")
        assert make_from_public_key(key) == make_from_public_key(key)

    def test_distinct_keys_give_distinct_ids(self) -> None:
        assert make_from_public_key(public_key(b"a")) != make_from_public_key(public_key(b"b"))

    @pytest.mark.parametrize("size", [0, 16, 31, 33, 64])
    def test_wrong_key_length_returns_none(self, size: int) -> None:
        assert make_from_public_key(b"\x01" * size) is None


class TestNormalize:
    def test_valid_round_trip(self) -> None:
        raw = bytes(range(FINGERPRINT_BYTE_COUNT))
        canonical = base32_encode(raw)
        assert normalize(canonical) == canonical

    def test_accepts_lowercase(self) -> None:
        canonical = device_id_for(b"lower")
        assert normalize(canonical.lower()) == canonical

    def test_accepts_grouped_form(self) -> None:
        canonical = device_id_for(b"grouped")
        assert normalize(formatted(canonical)) == canonical

    def test_accepts_whitespace(self) -> None:
        canonical = device_id_for(b"space")
        messy = "  " + formatted(canonical).replace("-", " \n") + "\t "
        assert normalize(messy) == canonical

    @pytest.mark.parametrize("length", [0, 1, 51, 53, 60])
    def test_wrong_length_rejected(self, length: int) -> None:
        assert normalize("A" * length) is None

    @pytest.mark.parametrize("bad", ["!", "0", "1", "8", "9", "_"])
    def test_illegal_character_rejected(self, bad: str) -> None:
        canonical = device_id_for(b"illegal")
        mutated = bad + canonical[1:]
        assert normalize(mutated) is None

    def test_nonzero_padding_bits_rejected(self) -> None:
        canonical = device_id_for(b"padding")
        last_index = ALPHABET.index(canonical[-1])
        # 末字符只用到高 1 位，低 4 位是填充；置位即非规范编码
        assert last_index & 0x0F == 0
        mutated = canonical[:-1] + ALPHABET[(last_index & 0x10) | 0x01]
        assert mutated != canonical
        assert normalize(mutated) is None

    def test_is_valid_matches_normalize(self) -> None:
        canonical = device_id_for(b"valid")
        assert is_valid(canonical) is True
        assert is_valid(canonical[:10]) is False
        assert is_valid("!" + canonical[1:]) is False
        assert is_valid(formatted(canonical)) is True


class TestFormatted:
    def test_group_layout_seven_seven_three(self) -> None:
        canonical = device_id_for(b"format")
        text = formatted(canonical)
        groups = text.split("-")
        assert len(groups) == 8
        assert [len(group) for group in groups] == [7, 7, 7, 7, 7, 7, 7, 3]
        assert text.replace("-", "") == canonical
        assert len(text) == FULL_LENGTH + 7

    def test_wrong_length_returned_unchanged(self) -> None:
        assert formatted("SHORT") == "SHORT"
        assert formatted("") == ""

    def test_format_normalize_round_trip(self) -> None:
        for seed in (b"a", b"b", b"c"):
            canonical = device_id_for(seed)
            assert normalize(formatted(canonical)) == canonical


class TestFingerprintMatches:
    def test_matching_key(self) -> None:
        key = public_key(b"pinned")
        assert fingerprint_matches(device_id_for(b"pinned"), key) is True

    def test_wrong_key(self) -> None:
        assert fingerprint_matches(device_id_for(b"pinned"), public_key(b"other")) is False

    def test_accepts_grouped_and_lowercase(self) -> None:
        key = public_key(b"pinned")
        canonical = device_id_for(b"pinned")
        assert fingerprint_matches(formatted(canonical), key) is True
        assert fingerprint_matches(canonical.lower(), key) is True

    @pytest.mark.parametrize("size", [0, 31, 33])
    def test_wrong_key_length_is_false(self, size: int) -> None:
        assert fingerprint_matches(device_id_for(b"pinned"), b"\x00" * size) is False

    def test_invalid_device_id_is_false(self) -> None:
        assert fingerprint_matches("not-a-device-id", public_key(b"x")) is False


class TestShortComparisonParts:
    def test_first_and_last_group(self) -> None:
        canonical = device_id_for(b"compare")
        assert short_comparison_parts(canonical) == (
            canonical[:7],
            canonical[-3:],
        )

    def test_accepts_grouped_input(self) -> None:
        canonical = device_id_for(b"compare")
        assert short_comparison_parts(formatted(canonical)) == (canonical[:7], canonical[-3:])

    def test_invalid_input_returns_none(self) -> None:
        assert short_comparison_parts("") is None
        assert short_comparison_parts("TOO-SHORT") is None
