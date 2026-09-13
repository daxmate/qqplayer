"""帧编解码 / 流式拼帧单测（对位 Swift `SyncFrameTests`）。

运行：cd backend && ../venv/bin/python3 -m pytest tests/test_lansync_frame.py -q
"""

import struct

import pytest

from app.lansync.frame import (
    FLAG_ENCRYPTED,
    HEADER_LENGTH,
    MAGIC,
    MAX_PAYLOAD_SIZE,
    EncodePayloadTooLargeError,
    Frame,
    FrameStreamDecoder,
    FrameType,
    InvalidMagicError,
    InvalidTypeError,
    PayloadTooLargeError,
    TruncatedHeaderError,
    TruncatedPayloadError,
    build_header,
    encode_frame,
)


class TestEncodeDecode:
    def test_round_trip_plain(self):
        raw = Frame(type=FrameType.HANDSHAKE, payload=b'{"role":"client"}').encode()
        assert raw[:4] == MAGIC
        assert raw[4:8] == struct.pack(">I", 17)
        assert raw[8] == 0
        assert raw[9] == 0
        frame, consumed = Frame.decode(raw)
        assert consumed == len(raw)
        assert frame.type is FrameType.HANDSHAKE
        assert frame.payload == b'{"role":"client"}'
        assert frame.is_encrypted is False

    def test_round_trip_encrypted_flag(self):
        raw = encode_frame(FrameType.CHANGE_LOG_PUSH, b"ciphertext", encrypted=True)
        assert raw[9] == FLAG_ENCRYPTED
        frame, _ = Frame.decode(raw)
        assert frame.is_encrypted is True
        assert frame.type is FrameType.CHANGE_LOG_PUSH

    def test_empty_payload(self):
        raw = Frame(type=FrameType.PING).encode()
        assert len(raw) == HEADER_LENGTH
        frame, consumed = Frame.decode(raw)
        assert frame.payload == b""
        assert consumed == HEADER_LENGTH

    def test_all_frame_types_round_trip(self):
        for frame_type in FrameType:
            raw = Frame(type=frame_type, payload=b"x").encode()
            frame, _ = Frame.decode(raw)
            assert frame.type is frame_type

    def test_type_values_match_swift_wire_table(self):
        """线上 1B 值锁死（改动即破坏跨语言兼容）。"""
        assert {t.name: t.value for t in FrameType} == {
            "HANDSHAKE": 0,
            "PAIR_REQUEST": 1,
            "PAIR_RESPONSE": 2,
            "PING": 3,
            "FILE_META": 4,
            "FILE_CHUNK": 5,
            "FILE_ACK": 6,
            "BYE": 7,
            "CHANGE_LOG_PULL": 8,
            "CHANGE_LOG_PUSH": 9,
            "MANIFEST_REQUEST": 10,
            "MANIFEST_RESPONSE": 11,
            "SYNC_FETCH_REQUEST": 12,
            "SYNC_FETCH_RESULT": 13,
            "LIBRARY_PUSH_ANNOUNCE": 14,
            "PEER_LIBRARY_REQUEST": 15,
            "PEER_LIBRARY_RESPONSE": 16,
        }

    def test_decode_ignores_trailing_bytes(self):
        raw = Frame(type=FrameType.BYE).encode() + b"tail"
        frame, consumed = Frame.decode(raw)
        assert frame.type is FrameType.BYE
        assert consumed == HEADER_LENGTH


class TestDecodeErrors:
    def test_truncated_header(self):
        with pytest.raises(TruncatedHeaderError):
            Frame.decode(MAGIC + b"\x00\x00")

    def test_invalid_magic(self):
        with pytest.raises(InvalidMagicError):
            Frame.decode(b"QQP2" + struct.pack(">I", 0) + b"\x00\x00")

    def test_truncated_payload(self):
        raw = MAGIC + struct.pack(">I", 10) + bytes((FrameType.BYE, 0)) + b"abc"
        with pytest.raises(TruncatedPayloadError) as excinfo:
            Frame.decode(raw)
        assert excinfo.value.declared == 10
        assert excinfo.value.available == 3

    def test_declared_length_over_limit(self):
        raw = MAGIC + struct.pack(">I", MAX_PAYLOAD_SIZE + 1) + bytes((FrameType.BYE, 0))
        with pytest.raises(PayloadTooLargeError) as excinfo:
            Frame.decode(raw)
        assert excinfo.value.declared == MAX_PAYLOAD_SIZE + 1

    def test_declared_length_exactly_at_limit_is_accepted(self):
        """上限是包含关系（16 MiB 本身合法）——只校验头部，不要求真的收满。"""
        raw = MAGIC + struct.pack(">I", MAX_PAYLOAD_SIZE) + bytes((FrameType.BYE, 0))
        with pytest.raises(TruncatedPayloadError):
            Frame.decode(raw)

    def test_unknown_type(self):
        raw = MAGIC + struct.pack(">I", 0) + bytes((17, 0))
        with pytest.raises(InvalidTypeError) as excinfo:
            Frame.decode(raw)
        assert excinfo.value.value == 17

    def test_encode_over_limit(self):
        with pytest.raises(EncodePayloadTooLargeError):
            Frame(type=FrameType.FILE_CHUNK, payload=b"\x00" * (MAX_PAYLOAD_SIZE + 1)).encode()


class TestStreamDecoder:
    def test_single_complete_frame(self):
        decoder = FrameStreamDecoder()
        frames = decoder.feed(Frame(type=FrameType.PING).encode())
        assert [f.type for f in frames] == [FrameType.PING]
        assert decoder.buffered_count == 0

    def test_half_frame_buffered_then_completed(self):
        """半包：先到帧头后到帧体，不得提前产出。"""
        raw = Frame(type=FrameType.BYE, payload=b"payload").encode()
        decoder = FrameStreamDecoder()
        assert decoder.feed(raw[:5]) == []
        assert decoder.buffered_count == 5
        frames = decoder.feed(raw[5:])
        assert [f.type for f in frames] == [FrameType.BYE]
        assert frames[0].payload == b"payload"
        assert decoder.buffered_count == 0

    def test_sticky_multiple_frames_in_one_chunk(self):
        """粘包：一次到达多帧，全部解出且顺序正确。"""
        payload_raw = (
            Frame(type=FrameType.HANDSHAKE, payload=b"a").encode()
            + Frame(type=FrameType.PAIR_REQUEST, payload=b"bb").encode()
            + Frame(type=FrameType.BYE).encode()
        )
        frames = FrameStreamDecoder().feed(payload_raw)
        assert [(f.type, f.payload) for f in frames] == [
            (FrameType.HANDSHAKE, b"a"),
            (FrameType.PAIR_REQUEST, b"bb"),
            (FrameType.BYE, b""),
        ]

    def test_byte_by_byte_feeding(self):
        raw = Frame(type=FrameType.FILE_CHUNK, payload=b"0123456789").encode()
        decoder = FrameStreamDecoder()
        frames = []
        for index in range(len(raw)):
            frames.extend(decoder.feed(raw[index : index + 1]))
        assert len(frames) == 1
        assert frames[0].payload == b"0123456789"
        assert decoder.buffered_count == 0

    def test_invalid_magic_detected_before_full_frame(self):
        decoder = FrameStreamDecoder()
        with pytest.raises(InvalidMagicError):
            decoder.feed(b"XXXX" + b"\x00" * 20)

    def test_unknown_type_raises(self):
        decoder = FrameStreamDecoder()
        with pytest.raises(InvalidTypeError):
            decoder.feed(MAGIC + struct.pack(">I", 0) + bytes((99, 0)))


class TestHeaderAsAad:
    def test_build_header_layout(self):
        header = build_header(FrameType.HANDSHAKE, 0, 17)
        assert len(header) == HEADER_LENGTH
        assert header[:4] == b"QQP1"
        assert header[4:8] == b"\x00\x00\x00\x11"
        assert header[8] == 0
        assert header[9] == 0

    def test_frame_header_matches_build_header_with_ciphertext_length(self):
        """AAD 用``密文``长度（明文 + 28）——加密帧的帧头必须这样算。"""
        ciphertext = b"\x00" * (12 + 10 + 16)
        frame = Frame(type=FrameType.PING, flags=FLAG_ENCRYPTED, payload=ciphertext)
        assert frame.header() == build_header(FrameType.PING, FLAG_ENCRYPTED, len(ciphertext))
        assert frame.header()[4:8] == struct.pack(">I", 38)

    def test_header_is_prefix_of_encoded_frame(self):
        frame = Frame(type=FrameType.BYE, flags=FLAG_ENCRYPTED, payload=b"z" * 8)
        assert frame.encode()[:HEADER_LENGTH] == frame.header()
