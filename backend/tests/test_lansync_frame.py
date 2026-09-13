"""帧编解码 + 流式拼帧测试（协议 §1；契约见 `docs/lan-sync-protocol.md`）。

覆盖：round-trip / 帧头布局 / 加密位 / 流式（半包·粘包·多帧一次到达·逐字节）/
流损坏（magic 错·未知 type·超限·伪超大 length 头须在读到长度即拒）/ buffered_bytes / reset。
"""

from __future__ import annotations

import struct

import pytest

from app.lansync.frame import (
    FLAG_ENCRYPTED,
    FRAME_TYPE_NAMES,
    HEADER_LENGTH,
    MAGIC,
    MAX_PAYLOAD_BYTES,
    Frame,
    FrameError,
    FrameStreamDecoder,
    InvalidFrameTypeError,
    InvalidMagicError,
    PayloadTooLargeError,
    build_header,
    encode_frame,
    frame_type_name,
    is_known_frame_type,
)

HANDSHAKE = 0
PAIR_REQUEST = 1
PING = 3
FILE_CHUNK = 5
BYE = 7
CHANGE_LOG_PUSH = 9


class TestConstants:
    def test_header_and_magic(self) -> None:
        assert MAGIC == b"QQP1"
        assert HEADER_LENGTH == 10
        assert MAX_PAYLOAD_BYTES == 16 * 1024 * 1024
        assert FLAG_ENCRYPTED == 0x01

    def test_frame_type_table_matches_protocol_section_5(self) -> None:
        assert FRAME_TYPE_NAMES == {
            0: "handshake",
            1: "pair_request",
            2: "pair_response",
            3: "ping",
            4: "file_meta",
            5: "file_chunk",
            6: "file_ack",
            7: "bye",
            8: "change_log_pull",
            9: "change_log_push",
            10: "manifest_request",
            11: "manifest_response",
            12: "sync_fetch_request",
            13: "sync_fetch_result",
            14: "library_push_announce",
            15: "peer_library_request",
            16: "peer_library_response",
        }
        assert sorted(FRAME_TYPE_NAMES) == list(range(17))

    def test_type_helpers(self) -> None:
        assert is_known_frame_type(0) and is_known_frame_type(16)
        assert not is_known_frame_type(17) and not is_known_frame_type(255)
        assert frame_type_name(9) == "change_log_push"
        with pytest.raises(InvalidFrameTypeError):
            frame_type_name(17)


class TestHeaderLayout:
    def test_build_header_bytes(self) -> None:
        header = build_header(BYE, 0, 5)
        assert len(header) == HEADER_LENGTH
        assert header[:4] == b"QQP1"
        assert header[4:8] == struct.pack(">I", 5)  # 大端
        assert header[8] == BYE
        assert header[9] == 0

    def test_build_header_rejects_unknown_type(self) -> None:
        with pytest.raises(InvalidFrameTypeError):
            build_header(17, 0, 0)

    def test_build_header_rejects_negative_length(self) -> None:
        with pytest.raises(ValueError):
            build_header(PING, 0, -1)

    def test_length_field_counts_payload_only(self) -> None:
        payload = b"x" * 300
        encoded = encode_frame(PING, payload)
        assert int.from_bytes(encoded[4:8], "big") == len(payload)
        assert len(encoded) == HEADER_LENGTH + len(payload)

    def test_frame_header_property_is_aad(self) -> None:
        frame = Frame(frame_type=CHANGE_LOG_PUSH, flags=FLAG_ENCRYPTED, payload=b"z" * 12)
        assert frame.header == build_header(CHANGE_LOG_PUSH, FLAG_ENCRYPTED, 12)
        assert len(frame.header) == HEADER_LENGTH


class TestRoundTrip:
    def test_plain_round_trip(self) -> None:
        raw = encode_frame(HANDSHAKE, b'{"role":"client"}')
        frames = FrameStreamDecoder().feed(raw)
        assert len(frames) == 1
        assert frames[0].frame_type == HANDSHAKE
        assert frames[0].flags == 0
        assert frames[0].payload == b'{"role":"client"}'
        assert frames[0].encrypted is False

    def test_empty_payload_round_trip(self) -> None:
        frames = FrameStreamDecoder().feed(encode_frame(PING))
        assert frames[0].payload == b""
        assert frames[0].frame_type == PING

    def test_encrypted_flag_round_trip(self) -> None:
        raw = encode_frame(CHANGE_LOG_PUSH, b"ciphertext", flags=FLAG_ENCRYPTED)
        assert raw[9] == FLAG_ENCRYPTED
        frame = FrameStreamDecoder().feed(raw)[0]
        assert frame.encrypted is True
        assert frame.flags == FLAG_ENCRYPTED
        assert frame.payload == b"ciphertext"

    def test_unknown_flag_bits_are_preserved(self) -> None:
        frame = FrameStreamDecoder().feed(encode_frame(BYE, b"a", flags=0b1001_0000))[0]
        assert frame.flags == 0b1001_0000
        assert frame.encrypted is False


class TestStreaming:
    def test_multiple_frames_in_one_chunk(self) -> None:
        raw = encode_frame(PING) + encode_frame(BYE, b"bye") + encode_frame(PAIR_REQUEST, b"req")
        frames = FrameStreamDecoder().feed(raw)
        assert [frame.frame_type for frame in frames] == [PING, BYE, PAIR_REQUEST]
        assert [frame.payload for frame in frames] == [b"", b"bye", b"req"]

    def test_split_header_across_chunks(self) -> None:
        raw = encode_frame(BYE, b"payload")
        decoder = FrameStreamDecoder()
        assert decoder.feed(raw[:4]) == []
        assert decoder.buffered_bytes == 4
        assert decoder.feed(raw[4:9]) == []
        assert decoder.buffered_bytes == 9  # 帧头未齐
        frames = decoder.feed(raw[9:12])  # 帧头齐（10B）但 payload 未齐
        assert frames == []
        assert decoder.buffered_bytes == 12
        frames = decoder.feed(raw[12:])
        assert [frame.frame_type for frame in frames] == [BYE]
        assert frames[0].payload == b"payload"
        assert decoder.buffered_bytes == 0

    def test_half_frame_then_rest(self) -> None:
        raw = encode_frame(FILE_CHUNK, b"0123456789")
        decoder = FrameStreamDecoder()
        assert decoder.feed(raw[:7]) == []  # 半个帧头
        assert decoder.buffered_bytes == 7
        assert decoder.feed(raw[7:15]) == []  # 帧头齐、payload 未齐
        assert decoder.buffered_bytes == 15
        frames = decoder.feed(raw[15:])
        assert len(frames) == 1
        assert frames[0].payload == b"0123456789"
        assert decoder.buffered_bytes == 0

    def test_byte_by_byte(self) -> None:
        payloads = [(PING, b""), (BYE, b"bye"), (PAIR_REQUEST, b"x" * 40)]
        raw = b"".join(encode_frame(frame_type, payload) for frame_type, payload in payloads)
        decoder = FrameStreamDecoder()
        seen: list[tuple[int, bytes]] = []
        for index in range(len(raw)):
            for frame in decoder.feed(raw[index : index + 1]):
                seen.append((frame.frame_type, frame.payload))
        assert seen == payloads
        assert decoder.buffered_bytes == 0

    def test_partial_tail_stays_buffered(self) -> None:
        decoder = FrameStreamDecoder()
        frames = decoder.feed(encode_frame(PING))
        assert [frame.frame_type for frame in frames] == [PING]
        assert decoder.buffered_bytes == 0
        tail = encode_frame(BYE, b"tail")
        assert decoder.feed(tail[:12]) == []  # 下一个帧的残缺尾巴
        assert decoder.buffered_bytes == 12
        frames = decoder.feed(tail[12:])
        assert [frame.frame_type for frame in frames] == [BYE]
        assert frames[0].payload == b"tail"
        assert decoder.buffered_bytes == 0


class TestStreamCorruption:
    def test_bad_magic_rejected_before_frame_complete(self) -> None:
        decoder = FrameStreamDecoder()
        with pytest.raises(InvalidMagicError):
            decoder.feed(b"XXXX")  # 仅 4B：magic 在整帧收齐前先校验
        assert isinstance(InvalidMagicError("x"), FrameError)

    def test_bad_magic_after_partial_header(self) -> None:
        decoder = FrameStreamDecoder()
        with pytest.raises(InvalidMagicError):
            decoder.feed(b"QQXX" + b"\x00" * 6)

    def test_unknown_type_rejected(self) -> None:
        for bad_type in (17, 255):
            raw = MAGIC + struct.pack(">I", 3) + bytes((bad_type, 0)) + b"abc"
            with pytest.raises(InvalidFrameTypeError):
                FrameStreamDecoder().feed(raw)

    def test_oversize_length_rejected_at_length_read(self) -> None:
        # 只给 10B 伪造帧头，声明 > 16MiB：必须在读到长度时就拒，不去吃 payload
        raw = build_header(0, 0, MAX_PAYLOAD_BYTES + 1)
        assert len(raw) == HEADER_LENGTH
        decoder = FrameStreamDecoder()
        with pytest.raises(PayloadTooLargeError) as excinfo:
            decoder.feed(raw)
        assert excinfo.value.declared == MAX_PAYLOAD_BYTES + 1
        assert isinstance(excinfo.value, FrameError)

    def test_oversize_length_rejected_when_payload_size_unknown(self) -> None:
        raw = MAGIC + struct.pack(">I", 0xFFFFFFFF) + bytes((PING, 0)) + b"\x00" * 4
        with pytest.raises(PayloadTooLargeError):
            FrameStreamDecoder().feed(raw)

    def test_encode_rejects_oversize_payload(self) -> None:
        with pytest.raises(PayloadTooLargeError):
            encode_frame(FILE_CHUNK, b"\x00" * (MAX_PAYLOAD_BYTES + 1))

    def test_boundary_length_is_accepted(self) -> None:
        # 上限本身合法（16MiB 边界）——用伪头验证不被拒（不真造 16MiB payload）
        header = build_header(FILE_CHUNK, 0, MAX_PAYLOAD_BYTES)
        decoder = FrameStreamDecoder()
        assert decoder.feed(header) == []
        assert decoder.buffered_bytes == HEADER_LENGTH

    def test_partial_header_is_not_emitted_and_not_an_error(self) -> None:
        raw = encode_frame(FILE_CHUNK, b"chunk-data")
        decoder = FrameStreamDecoder()
        assert decoder.feed(raw[:8]) == []  # 半个帧头：既不吐帧也不报错
        assert decoder.buffered_bytes == 8
        frames = decoder.feed(raw[8:14])  # 帧头齐、payload 未齐
        assert frames == []
        assert decoder.buffered_bytes == 14
        frames = decoder.feed(raw[14:])
        assert [frame.frame_type for frame in frames] == [FILE_CHUNK]
        assert frames[0].payload == b"chunk-data"
        assert decoder.buffered_bytes == 0


class TestResetAndState:
    def test_reset_clears_buffer(self) -> None:
        decoder = FrameStreamDecoder()
        decoder.feed(encode_frame(BYE, b"payload")[:6])
        assert decoder.buffered_bytes == 6
        decoder.reset()
        assert decoder.buffered_bytes == 0
        assert decoder.feed(encode_frame(PING))[0].frame_type == PING

    def test_feed_empty_chunk_is_noop(self) -> None:
        decoder = FrameStreamDecoder()
        assert decoder.feed(b"") == []
        assert decoder.buffered_bytes == 0

    def test_decoder_instance_state_is_independent(self) -> None:
        first = FrameStreamDecoder()
        second = FrameStreamDecoder()
        first.feed(encode_frame(BYE, b"half")[:6])
        assert second.buffered_bytes == 0
        assert first.buffered_bytes == 6
