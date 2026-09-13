"""文件传输层测试（帧 4/5/6，协议 §10；契约见 `docs/lan-sync-protocol.md`）。

覆盖：载荷编解码（线上键名/base64/超限 guard）· 多块往返（含末块小、1 MiB 整块）·
断点续传（链路中断 → startOffset 续传 → 字节一致）· 空文件 · 幂等命中 ·
`.part` 半块残留截断 · 残留 `.part` 丢弃 · SHA-256 不符删 `.part` · 参数校验 6 条 ·
块序/对齐/超长/空块拒绝 · 交叠传输与无 meta 先到块 · sender ack 判定（越界/未前进/
done 不符/超时/取消/断连/发送失败）· 接收端忽略 ack 与未知帧。

回环 = 内存队列（`Link` / `ReceiverHarness`），磁盘 IO 真读写 `tmp_path`，不 mock 文件 IO。
"""

from __future__ import annotations

import hashlib
import json
from collections import deque
from pathlib import Path

import pytest

from app.lansync.filetransfer import (
    CHUNK_SIZE,
    DEFAULT_ACK_TIMEOUT,
    EMPTY_SHA256_HEX,
    MAX_PAYLOAD_BYTES,
    PART_SUFFIX,
    FileAckError,
    FileAckPayload,
    FileChunkPayload,
    FileMetaPayload,
    FileReceiver,
    FileSender,
    FileTransferError,
    FileTransferErrorKind,
    align_down,
    decode_file_ack,
    decode_file_chunk,
    decode_file_meta,
    encode_file_ack,
    encode_file_chunk,
    encode_file_meta,
    sha256_file,
    sha256_hex,
    validate_meta,
)
from app.lansync.frame import FrameType

FILE_META = FrameType.FILE_META
FILE_CHUNK = FrameType.FILE_CHUNK
FILE_ACK = FrameType.FILE_ACK

#: 确定性测试数据（不用 random：往返/续传断言需要可复现）
PATTERN = bytes(range(256))


def blob(size: int) -> bytes:
    """构造 size 字节的确定性数据。"""
    if size == 0:
        return b""
    return (PATTERN * (size // len(PATTERN) + 1))[:size]


def write_source(path: Path, size: int) -> Path:
    """在磁盘上造一个 size 字节的源文件。"""
    path.write_bytes(blob(size))
    return path


# --------------------------------------------------------------------------- 回环


class Link:
    """发送端 ↔ 接收端内存回环（按帧类型路由；`pump()` 推进到收敛）。"""

    def __init__(
        self,
        source: Path,
        target_dir: Path,
        *,
        file_id: str = "f1",
        chunk_size: int = CHUNK_SIZE,
        start_offset: int = 0,
        name: str | None = None,
    ) -> None:
        self.queue: deque[tuple[str, int, bytes]] = deque()
        self.sender_frames: list[tuple[int, bytes]] = []
        self.receiver_frames: list[tuple[int, bytes]] = []
        self.sender_results: list = []
        self.receiver_results: list = []
        self.receiver = FileReceiver(
            target_dir, send=self._from_receiver, on_completion=self.receiver_results.append
        )
        self.sender = FileSender(
            source,
            file_id=file_id,
            send=self._from_sender,
            on_completion=self.sender_results.append,
            chunk_size=chunk_size,
            start_offset=start_offset,
            display_name=name,
        )

    def _from_sender(self, frame_type: int, payload: bytes) -> None:
        self.sender_frames.append((frame_type, payload))
        self.queue.append(("s", frame_type, payload))

    def _from_receiver(self, frame_type: int, payload: bytes) -> None:
        self.receiver_frames.append((frame_type, payload))
        self.queue.append(("r", frame_type, payload))

    def pump(self, *, max_chunks: int | None = None, limit: int = 100_000) -> int:
        """推进回环到收敛；`max_chunks` 送达 N 块后**丢弃后续帧**（模拟链路中断）。"""
        delivered = 0
        steps = 0
        while self.queue:
            steps += 1
            assert steps <= limit, "pump 未收敛（疑似死循环重发）"
            side, frame_type, payload = self.queue.popleft()
            if side == "s":
                self.receiver.handle_frame(frame_type, payload)
                if frame_type == FILE_CHUNK:
                    delivered += 1
                    if max_chunks is not None and delivered >= max_chunks:
                        self.queue.clear()
                        break
            else:
                self.sender.handle_frame(frame_type, payload)
        return delivered

    @property
    def chunk_payloads(self) -> list[bytes]:
        return [payload for frame_type, payload in self.sender_frames if frame_type == FILE_CHUNK]

    @property
    def ack_payloads(self) -> list[bytes]:
        return [payload for frame_type, payload in self.receiver_frames if frame_type == FILE_ACK]


class ReceiverHarness:
    """只驱动接收端：手工造帧投喂 `FileReceiver`，收集它回的 ack / 终态。"""

    def __init__(self, target_dir: Path) -> None:
        self.acks: list[FileAckPayload] = []
        self.raw_acks: list[bytes] = []
        self.results: list = []
        self.receiver = FileReceiver(
            target_dir, send=self._send_ack, on_completion=self.results.append
        )
        self.target_dir = target_dir

    def _send_ack(self, frame_type: int, payload: bytes) -> None:
        assert frame_type == FILE_ACK, "接收端只应回 file_ack"
        self.raw_acks.append(payload)
        self.acks.append(decode_file_ack(payload))

    @property
    def last_ack(self) -> FileAckPayload | None:
        return self.acks[-1] if self.acks else None

    def push_meta(self, meta: FileMetaPayload) -> FileAckPayload | None:
        return self.receiver.handle_frame(FILE_META, encode_file_meta(meta))

    def push_meta_raw(self, payload: bytes) -> FileAckPayload | None:
        return self.receiver.handle_frame(FILE_META, payload)

    def push_chunk_raw(self, payload: bytes) -> FileAckPayload | None:
        return self.receiver.handle_frame(FILE_CHUNK, payload)

    def push_chunk(self, chunk: FileChunkPayload) -> FileAckPayload | None:
        return self.receiver.handle_frame(FILE_CHUNK, encode_file_chunk(chunk))

    def push_file(
        self,
        data: bytes,
        *,
        file_id: str = "f1",
        chunk_size: int = CHUNK_SIZE,
        sha: str | None = None,
    ) -> FileAckPayload | None:
        """按块推送整个文件（meta + 顺序块），返回最后一条 ack。"""
        meta = make_meta(
            file_id=file_id,
            total_size=len(data),
            chunk_size=chunk_size,
            sha256_hex=sha if sha is not None else sha256_hex(data),
        )
        ack = self.push_meta(meta)
        offset = 0
        while offset < len(data):
            piece = data[offset : offset + chunk_size]
            ack = self.push_chunk(FileChunkPayload(file_id, offset, piece))
            offset += len(piece)
        return ack


def make_meta(
    *,
    file_id: str = "f1",
    name: str = "song.mp3",
    total_size: int = 0,
    chunk_size: int = CHUNK_SIZE,
    start_offset: int = 0,
    sha256_hex: str | None = None,
) -> FileMetaPayload:
    """构造 `file_meta`（默认自洽；`sha256_hex` 显式给值即可造违例）。"""
    if sha256_hex is None:
        sha256_hex = EMPTY_SHA256_HEX if total_size == 0 else hashlib.sha256(b"x" * 0).hexdigest()
    return FileMetaPayload(
        file_id=file_id,
        name=name,
        total_size=total_size,
        chunk_size=chunk_size,
        sha256_hex=sha256_hex,
        start_offset=start_offset,
    )


# --------------------------------------------------------------------------- 载荷/常量


class TestPayloadModels:
    def test_meta_wire_keys(self) -> None:
        meta = FileMetaPayload("f1", "a.mp3", 10, CHUNK_SIZE, "a" * 64, 2)
        raw = json.loads(encode_file_meta(meta))
        assert sorted(raw) == [
            "chunkSize",
            "fileID",
            "name",
            "sha256Hex",
            "startOffset",
            "totalSize",
        ]
        assert raw == {
            "fileID": "f1",
            "name": "a.mp3",
            "totalSize": 10,
            "chunkSize": CHUNK_SIZE,
            "sha256Hex": "a" * 64,
            "startOffset": 2,
        }
        assert decode_file_meta(encode_file_meta(meta)) == meta

    def test_meta_start_offset_defaults_to_zero(self) -> None:
        payload = (
            b'{"fileID":"f","name":"a","totalSize":0,"chunkSize":1,"sha256Hex":"'
            + b"0" * 64
            + b'"}'
        )
        assert decode_file_meta(payload).start_offset == 0

    def test_meta_extra_keys_tolerated(self) -> None:
        payload = json.dumps(
            {
                "fileID": "f",
                "name": "a",
                "totalSize": 0,
                "chunkSize": 1,
                "sha256Hex": "0" * 64,
                "startOffset": 0,
                "futureField": {"nested": True},
            }
        ).encode()
        assert decode_file_meta(payload).file_id == "f"

    def test_chunk_wire_data_is_base64(self) -> None:
        chunk = FileChunkPayload("f1", 262144, b"\x00\x01\xff")
        raw = json.loads(encode_file_chunk(chunk))
        assert raw == {"fileID": "f1", "offset": 262144, "data": "AAH/"}
        assert decode_file_chunk(encode_file_chunk(chunk)) == chunk

    def test_chunk_empty_data_allowed_by_codec(self) -> None:
        chunk = FileChunkPayload("f1", 0, b"")
        assert decode_file_chunk(encode_file_chunk(chunk)).data == b""

    def test_ack_wire_keys_and_defaults(self) -> None:
        ack = FileAckPayload("f1", 262144, done=False)
        raw = json.loads(encode_file_ack(ack))
        assert raw == {
            "fileID": "f1",
            "receivedBytes": 262144,
            "done": False,
            "error": "none",
        }
        assert decode_file_ack(encode_file_ack(ack)) == ack

    def test_ack_all_error_values_roundtrip(self) -> None:
        for error in FileAckError:
            ack = FileAckPayload("f", 0, False, error)
            assert decode_file_ack(encode_file_ack(ack)).error is error
        assert [error.value for error in FileAckError] == [
            "none",
            "ioError",
            "diskFull",
            "checksumMismatch",
            "resumeMismatch",
            "cancelled",
            "protocolError",
        ]

    @pytest.mark.parametrize(
        ("payload", "decoder"),
        [
            (b"not json", decode_file_meta),
            (b"[1,2]", decode_file_meta),
            (b"{}", decode_file_meta),
            (
                b'{"fileID":"f","name":1,"totalSize":1,"chunkSize":1,"sha256Hex":"a"}',
                decode_file_meta,
            ),
            (
                b'{"fileID":"f","name":"a","totalSize":true,"chunkSize":1,"sha256Hex":"a"}',
                decode_file_meta,
            ),
            (
                b'{"fileID":"f","name":"a","totalSize":1,"chunkSize":1,"sha256Hex":"a","startOffset":"0"}',
                decode_file_meta,
            ),
            (b'{"fileID":"f","offset":"0","data":""}', decode_file_chunk),
            (b'{"fileID":"f","offset":0,"data":"!!!not base64!!!"}', decode_file_chunk),
            (b'{"fileID":"f","receivedBytes":0,"done":"yes","error":"none"}', decode_file_ack),
            (b'{"fileID":"f","receivedBytes":0,"done":false}', decode_file_ack),
            (b'{"fileID":"f","receivedBytes":0,"done":false,"error":"whatever"}', decode_file_ack),
        ],
    )
    def test_decode_rejects_malformed(self, payload: bytes, decoder) -> None:
        with pytest.raises(FileTransferError) as info:
            decoder(payload)
        assert info.value.kind is FileTransferErrorKind.PROTOCOL_ERROR

    def test_encode_guards_16mib(self) -> None:
        oversize = FileChunkPayload("f", 0, b"\x00" * MAX_PAYLOAD_BYTES)
        with pytest.raises(FileTransferError) as info:
            encode_file_chunk(oversize)
        assert info.value.kind is FileTransferErrorKind.INVALID_ARGUMENT

    def test_decode_guards_16mib(self) -> None:
        with pytest.raises(FileTransferError) as info:
            decode_file_meta(b"x" * (MAX_PAYLOAD_BYTES + 1))
        assert info.value.kind is FileTransferErrorKind.PROTOCOL_ERROR


class TestConstantsAndHelpers:
    def test_constants_match_protocol_section_10_4(self) -> None:
        assert CHUNK_SIZE == 262144
        assert DEFAULT_ACK_TIMEOUT == 30.0
        assert PART_SUFFIX == ".part"
        assert hashlib.sha256(b"").hexdigest() == EMPTY_SHA256_HEX
        assert MAX_PAYLOAD_BYTES == 16 * 1024 * 1024

    def test_align_down(self) -> None:
        assert align_down(0, CHUNK_SIZE) == 0
        assert align_down(CHUNK_SIZE, CHUNK_SIZE) == CHUNK_SIZE
        assert align_down(CHUNK_SIZE + 5, CHUNK_SIZE) == CHUNK_SIZE
        with pytest.raises(FileTransferError):
            align_down(10, 0)

    def test_sha256_file_streams_multiple_windows(self, tmp_path: Path) -> None:
        size = 2_621_440  # 2.5 MiB：跨 3 个 1 MiB 读窗口
        source = write_source(tmp_path / "big.bin", size)
        assert sha256_file(source) == hashlib.sha256(blob(size)).hexdigest()

    def test_error_message_includes_kind(self) -> None:
        error = FileTransferError(FileTransferErrorKind.PROTOCOL_ERROR, "块序错")
        assert error.kind is FileTransferErrorKind.PROTOCOL_ERROR
        assert "protocolError" in str(error) and "块序错" in str(error)
        assert str(FileTransferError(FileTransferErrorKind.CANCELLED)) == "cancelled"


# --------------------------------------------------------------------------- 端到端往返


class TestRoundTrip:
    def test_multichunk_with_short_tail(self, tmp_path: Path) -> None:
        size = 600_000  # 2 整块 + 144544 末块
        source = write_source(tmp_path / "src.bin", size)
        target = tmp_path / "inbox"
        target.mkdir()
        link = Link(source, target)
        link.sender.begin()
        assert link.pump() == 3

        final = target / "src.bin"
        assert final.read_bytes() == source.read_bytes()
        assert not (target / ("src.bin" + PART_SUFFIX)).exists()
        assert [ack.received_bytes for ack in _acks(link)] == [0, 262144, 524288, size]
        assert _acks(link)[-1].done is True
        assert _acks(link)[-1].error is FileAckError.NONE
        assert link.sender_results[-1].ok
        assert link.sender_results[-1].sha256_hex == sha256_file(source)
        assert link.receiver_results[-1].ok
        assert link.receiver_results[-1].target_path == final
        assert not link.sender.is_active and not link.receiver.is_active

    def test_one_mib_file_four_blocks(self, tmp_path: Path) -> None:
        size = 1_048_576  # 恰好 4 × 256 KiB
        source = write_source(tmp_path / "one-mib.mp3", size)
        target = tmp_path / "inbox"
        target.mkdir()
        link = Link(source, target, file_id="sync-1")
        link.sender.begin()
        link.pump()
        assert len(link.chunk_payloads) == 4
        assert (target / "one-mib.mp3").read_bytes() == source.read_bytes()
        assert link.receiver_results[-1].ok

    def test_chunk_offsets_and_sizes(self, tmp_path: Path) -> None:
        size = 600_000
        source = write_source(tmp_path / "src.bin", size)
        link = Link(source, tmp_path / "inbox")
        (tmp_path / "inbox").mkdir()
        link.sender.begin()
        link.pump()
        offsets = [decode_file_chunk(payload).offset for payload in link.chunk_payloads]
        sizes = [len(decode_file_chunk(payload).data) for payload in link.chunk_payloads]
        assert offsets == [0, 262144, 524288]
        assert sizes == [262144, 262144, size - 524288]

    def test_empty_file_needs_no_chunks(self, tmp_path: Path) -> None:
        source = write_source(tmp_path / "empty.bin", 0)
        target = tmp_path / "inbox"
        target.mkdir()
        link = Link(source, target)
        link.sender.begin()
        link.pump()
        assert link.chunk_payloads == []
        assert (target / "empty.bin").exists()
        assert (target / "empty.bin").stat().st_size == 0
        assert _acks(link) == [FileAckPayload("f1", 0, True, FileAckError.NONE)]
        assert link.sender_results[-1].ok and link.receiver_results[-1].ok

    def test_display_name_overrides_source_name(self, tmp_path: Path) -> None:
        source = write_source(tmp_path / "tmp-download.bin", 1000)
        target = tmp_path / "inbox"
        target.mkdir()
        link = Link(source, target, name="song-final.mp3")
        link.sender.begin()
        link.pump()
        assert (target / "song-final.mp3").read_bytes() == source.read_bytes()

    def test_sender_frame_types_are_meta_then_chunks(self, tmp_path: Path) -> None:
        source = write_source(tmp_path / "src.bin", 300_000)
        target = tmp_path / "inbox"
        target.mkdir()
        link = Link(source, target)
        link.sender.begin()
        link.pump()
        assert [frame_type for frame_type, _ in link.sender_frames] == [
            FILE_META,
            FILE_CHUNK,
            FILE_CHUNK,
        ]
        assert {frame_type for frame_type, _ in link.receiver_frames} == {FILE_ACK}


def _acks(link: Link) -> list[FileAckPayload]:
    return [decode_file_ack(payload) for payload in link.ack_payloads]


# --------------------------------------------------------------------------- 断点续传


class TestResume:
    def test_resume_after_link_cut(self, tmp_path: Path) -> None:
        size = 600_000
        source = write_source(tmp_path / "src.bin", size)
        target = tmp_path / "inbox"
        target.mkdir()
        part = target / ("src.bin" + PART_SUFFIX)

        first = Link(source, target)
        first.sender.begin()
        assert first.pump(max_chunks=2) == 2
        assert part.stat().st_size == 2 * CHUNK_SIZE
        assert first.sender_results == [] and first.receiver_results == []
        first.sender.handle_session_closed()
        first.receiver.handle_session_closed()
        assert first.sender_results[-1].error is FileTransferErrorKind.SESSION_CLOSED
        assert part.stat().st_size == 2 * CHUNK_SIZE  # 断连保留 .part

        resumed = Link(source, target, file_id="f1", start_offset=2 * CHUNK_SIZE)
        resumed.sender.begin()
        resumed.pump()
        assert (target / "src.bin").read_bytes() == blob(size)
        assert not part.exists()
        acks = _acks(resumed)
        assert acks[0] == FileAckPayload("f1", 2 * CHUNK_SIZE, False, FileAckError.NONE)
        assert acks[-1].done is True
        assert len(resumed.chunk_payloads) == 1  # 只剩末块
        assert decode_file_chunk(resumed.chunk_payloads[0]).offset == 2 * CHUNK_SIZE

    def test_resume_when_part_missing(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        meta = make_meta(total_size=600_000, sha256_hex="0" * 64, start_offset=CHUNK_SIZE)
        ack = harness.push_meta(meta)
        assert ack is not None
        assert ack.error is FileAckError.RESUME_MISMATCH
        assert ack.received_bytes == 0
        assert not harness.receiver.is_active

    def test_resume_when_part_size_mismatched(self, tmp_path: Path) -> None:
        (tmp_path / ("song.mp3" + PART_SUFFIX)).write_bytes(b"\x00" * 100)
        harness = ReceiverHarness(tmp_path)
        ack = harness.push_meta(
            make_meta(total_size=600_000, sha256_hex="0" * 64, start_offset=CHUNK_SIZE)
        )
        assert ack is not None
        assert ack.error is FileAckError.RESUME_MISMATCH
        assert ack.received_bytes == 0  # 100 字节向下对齐块边界 = 0
        assert (tmp_path / ("song.mp3" + PART_SUFFIX)).stat().st_size == 100  # 不删残留

    def test_partial_tail_is_truncated_to_block_boundary(self, tmp_path: Path) -> None:
        data = blob(600_000)
        part = tmp_path / ("song.mp3" + PART_SUFFIX)
        part.write_bytes(data[: 2 * CHUNK_SIZE] + b"\xde\xad\xbe\xef" * 25)  # 尾部半块残留
        harness = ReceiverHarness(tmp_path)
        meta = make_meta(
            total_size=len(data), sha256_hex=sha256_hex(data), start_offset=2 * CHUNK_SIZE
        )
        ack = harness.push_meta(meta)
        assert ack is not None and ack.error is FileAckError.NONE
        assert ack.received_bytes == 2 * CHUNK_SIZE
        assert part.stat().st_size == 2 * CHUNK_SIZE  # 已截到块边界
        offset = 2 * CHUNK_SIZE
        while offset < len(data):
            piece = data[offset : offset + CHUNK_SIZE]
            ack = harness.push_chunk(FileChunkPayload("f1", offset, piece))
            offset += len(piece)
        assert ack is not None and ack.done is True
        assert (tmp_path / "song.mp3").read_bytes() == data

    def test_start_zero_discards_stale_part(self, tmp_path: Path) -> None:
        data = blob(300_000)
        part = tmp_path / ("song.mp3" + PART_SUFFIX)
        part.write_bytes(b"\xff" * 999)
        harness = ReceiverHarness(tmp_path)
        ack = harness.push_meta(make_meta(total_size=len(data), sha256_hex=sha256_hex(data)))
        assert ack is not None and ack.received_bytes == 0
        assert part.stat().st_size == 0  # 残留被丢弃，从头收
        assert harness.push_file(data, sha=sha256_hex(data)) is not None
        assert (tmp_path / "song.mp3").read_bytes() == data

    def test_resume_with_all_bytes_present_goes_straight_to_finalize(self, tmp_path: Path) -> None:
        data = blob(2 * CHUNK_SIZE)  # 续传起点必须对齐块边界 → 用整块大小的文件
        (tmp_path / ("song.mp3" + PART_SUFFIX)).write_bytes(data)
        harness = ReceiverHarness(tmp_path)
        ack = harness.push_meta(
            make_meta(total_size=len(data), sha256_hex=sha256_hex(data), start_offset=len(data))
        )
        assert ack == FileAckPayload("f1", len(data), True, FileAckError.NONE)
        assert (tmp_path / "song.mp3").read_bytes() == data
        assert not (tmp_path / ("song.mp3" + PART_SUFFIX)).exists()

    def test_resume_with_corrupt_part_fails_checksum(self, tmp_path: Path) -> None:
        data = blob(2 * CHUNK_SIZE)
        corrupt = bytearray(data)
        corrupt[10] ^= 0xFF
        (tmp_path / ("song.mp3" + PART_SUFFIX)).write_bytes(bytes(corrupt))
        harness = ReceiverHarness(tmp_path)
        ack = harness.push_meta(
            make_meta(total_size=len(data), sha256_hex=sha256_hex(data), start_offset=len(data))
        )
        assert ack is not None
        assert ack.error is FileAckError.CHECKSUM_MISMATCH
        assert not (tmp_path / ("song.mp3" + PART_SUFFIX)).exists()
        assert not (tmp_path / "song.mp3").exists()

    def test_sender_start_offset_must_be_aligned(self, tmp_path: Path) -> None:
        source = write_source(tmp_path / "src.bin", 600_000)
        sender = FileSender(source, file_id="f1", send=lambda *_: None, start_offset=1000)
        with pytest.raises(FileTransferError) as info:
            sender.begin()
        assert info.value.kind is FileTransferErrorKind.INVALID_ARGUMENT


# --------------------------------------------------------------------------- 收尾/错误


class TestChecksumAndPart:
    def test_checksum_mismatch_deletes_part_and_fails(self, tmp_path: Path) -> None:
        data = blob(400_000)
        harness = ReceiverHarness(tmp_path)
        ack = harness.push_file(data, sha=sha256_hex(b"something else"))
        assert ack is not None
        assert ack.error is FileAckError.CHECKSUM_MISMATCH
        assert ack.received_bytes == 0
        assert ack.done is False
        assert not (tmp_path / ("song.mp3" + PART_SUFFIX)).exists()
        assert not (tmp_path / "song.mp3").exists()
        assert harness.results[-1].error is FileTransferErrorKind.CHECKSUM_MISMATCH
        assert not harness.receiver.is_active

    def test_idempotent_when_target_matches(self, tmp_path: Path) -> None:
        data = blob(400_000)
        (tmp_path / "song.mp3").write_bytes(data)
        harness = ReceiverHarness(tmp_path)
        ack = harness.push_meta(make_meta(total_size=len(data), sha256_hex=sha256_hex(data)))
        assert ack == FileAckPayload("f1", len(data), True, FileAckError.NONE)
        assert len(harness.acks) == 1  # 不发任何块
        assert not (tmp_path / ("song.mp3" + PART_SUFFIX)).exists()
        assert harness.results[-1].ok
        assert harness.results[-1].target_path == tmp_path / "song.mp3"

    def test_existing_target_with_different_content_is_overwritten(self, tmp_path: Path) -> None:
        data = blob(300_000)
        (tmp_path / "song.mp3").write_bytes(b"old")
        harness = ReceiverHarness(tmp_path)
        assert harness.push_file(data, sha=sha256_hex(data)) is not None
        assert (tmp_path / "song.mp3").read_bytes() == data
        assert harness.results[-1].ok

    def test_empty_file_requires_empty_sha(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        ack = harness.push_meta(make_meta(total_size=0, sha256_hex="0" * 64))
        assert ack is not None
        assert ack.error is FileAckError.PROTOCOL_ERROR
        assert not (tmp_path / "song.mp3").exists()


class TestReceiverRejections:
    @pytest.mark.parametrize(
        "meta",
        [
            make_meta(file_id="", total_size=0),
            make_meta(name=""),
            make_meta(name="."),
            make_meta(name=".."),
            make_meta(name="../evil.bin"),
            make_meta(name="sub/song.mp3"),
            make_meta(name="sub\\song.mp3"),
            make_meta(total_size=-1),
            make_meta(total_size=10, start_offset=-1),
            make_meta(total_size=10, start_offset=CHUNK_SIZE * 2),
            make_meta(total_size=10, chunk_size=0),
            make_meta(total_size=10, chunk_size=MAX_PAYLOAD_BYTES + 1),
            make_meta(total_size=10, start_offset=1),
            make_meta(total_size=10, sha256_hex="not-a-sha"),
            make_meta(total_size=10, sha256_hex="a" * 63),
        ],
    )
    def test_meta_validation_rules(self, tmp_path: Path, meta: FileMetaPayload) -> None:
        detail = validate_meta(meta)
        assert detail is not None
        harness = ReceiverHarness(tmp_path)
        ack = harness.push_meta(meta)
        assert ack is not None
        assert ack.error is FileAckError.PROTOCOL_ERROR
        assert ack.file_id == meta.file_id
        assert not harness.receiver.is_active
        assert list(tmp_path.iterdir()) == []  # 违例 meta 不留任何文件

    def test_traversal_name_never_writes_outside_target_dir(self, tmp_path: Path) -> None:
        target = tmp_path / "inbox"
        target.mkdir()
        harness = ReceiverHarness(target)
        ack = harness.push_meta(make_meta(name="../evil.bin", total_size=0))
        assert ack is not None and ack.error is FileAckError.PROTOCOL_ERROR
        assert not (tmp_path / "evil.bin").exists()
        assert list(target.iterdir()) == []

    def test_meta_decode_failure_with_file_id_replies_protocol_error(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        ack = harness.push_meta_raw(b'{"fileID":"f9","totalSize":"oops"}')
        assert ack is not None
        assert ack.file_id == "f9" and ack.error is FileAckError.PROTOCOL_ERROR

    def test_meta_decode_failure_without_file_id_is_silent(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        assert harness.push_meta_raw(b"garbage") is None
        assert harness.acks == []

    def test_chunk_without_meta_is_protocol_error(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        ack = harness.push_chunk(FileChunkPayload("f1", 0, b"data"))
        assert ack is not None
        assert ack.error is FileAckError.PROTOCOL_ERROR and ack.received_bytes == 0
        assert not harness.receiver.is_active

    def test_overlapping_transfer_rejected(self, tmp_path: Path) -> None:
        data = blob(600_000)
        harness = ReceiverHarness(tmp_path)
        assert harness.push_meta(
            make_meta(file_id="f1", total_size=len(data), sha256_hex=sha256_hex(data))
        )
        harness.push_chunk(FileChunkPayload("f1", 0, data[:CHUNK_SIZE]))
        ack = harness.push_meta(make_meta(file_id="f2", total_size=10))
        assert ack is not None
        assert ack.file_id == "f2" and ack.error is FileAckError.PROTOCOL_ERROR
        assert harness.receiver.file_id == "f1"  # 在跑的那轮不受影响
        assert harness.receiver.received_bytes == CHUNK_SIZE

    def test_chunk_wrong_file_id_rejected(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        assert harness.push_meta(make_meta(file_id="f1", total_size=100, sha256_hex="0" * 64))
        ack = harness.push_chunk(FileChunkPayload("f2", 0, b"x" * 100))
        assert ack is not None and ack.error is FileAckError.PROTOCOL_ERROR

    def test_chunk_out_of_order_rejected(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        assert harness.push_meta(make_meta(total_size=600_000, sha256_hex="0" * 64))
        ack = harness.push_chunk(FileChunkPayload("f1", CHUNK_SIZE, b"x" * CHUNK_SIZE))
        assert ack is not None
        assert ack.error is FileAckError.PROTOCOL_ERROR and ack.received_bytes == 0

    def test_chunk_larger_than_chunk_size_rejected(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        assert harness.push_meta(make_meta(total_size=4096, chunk_size=1024, sha256_hex="0" * 64))
        ack = harness.push_chunk(FileChunkPayload("f1", 0, b"x" * 2048))
        assert ack is not None and ack.error is FileAckError.PROTOCOL_ERROR

    def test_chunk_longer_than_remaining_rejected(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        assert harness.push_meta(make_meta(total_size=100, sha256_hex="0" * 64))
        ack = harness.push_chunk(FileChunkPayload("f1", 0, b"x" * 200))
        assert ack is not None and ack.error is FileAckError.PROTOCOL_ERROR

    def test_zero_length_chunk_rejected(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        assert harness.push_meta(make_meta(total_size=100, sha256_hex="0" * 64))
        ack = harness.push_chunk(FileChunkPayload("f1", 0, b""))
        assert ack is not None and ack.error is FileAckError.PROTOCOL_ERROR

    def test_chunk_decode_failure_replies_protocol_error(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        assert harness.push_meta(make_meta(total_size=100, sha256_hex="0" * 64))
        ack = harness.push_chunk_raw(b'{"fileID":"f1","offset":0,"data":123}')
        assert ack is not None
        assert ack.error is FileAckError.PROTOCOL_ERROR and ack.file_id == "f1"

    def test_receiver_ignores_ack_and_unknown_frames(self, tmp_path: Path) -> None:
        harness = ReceiverHarness(tmp_path)
        assert (
            harness.receiver.handle_frame(FILE_ACK, encode_file_ack(FileAckPayload("f1", 0)))
            is None
        )
        assert harness.receiver.handle_frame(FrameType.PING, b"") is None
        assert harness.acks == []

    def test_receiver_cancel_keeps_part(self, tmp_path: Path) -> None:
        data = blob(600_000)
        harness = ReceiverHarness(tmp_path)
        harness.push_meta(make_meta(total_size=len(data), sha256_hex=sha256_hex(data)))
        harness.push_chunk(FileChunkPayload("f1", 0, data[:CHUNK_SIZE]))
        harness.receiver.cancel()
        assert not harness.receiver.is_active
        assert (tmp_path / ("song.mp3" + PART_SUFFIX)).stat().st_size == CHUNK_SIZE


# --------------------------------------------------------------------------- 发送端契约


class TestSenderContract:
    def _sender(self, tmp_path: Path, **kwargs) -> tuple[FileSender, list, list[tuple[int, bytes]]]:
        source = write_source(tmp_path / "src.bin", 600_000)
        results: list = []
        frames: list[tuple[int, bytes]] = []
        kwargs.setdefault("file_id", "f1")
        sender = FileSender(
            source,
            send=lambda frame_type, payload: frames.append((frame_type, payload)),
            on_completion=results.append,
            **kwargs,
        )
        return sender, results, frames

    def test_begin_sends_meta_and_awaits_ack(self, tmp_path: Path) -> None:
        sender, results, frames = self._sender(tmp_path)
        meta = sender.begin()
        assert meta == FileMetaPayload(
            "f1", "src.bin", 600_000, CHUNK_SIZE, sha256_file(tmp_path / "src.bin"), 0
        )
        assert [frame_type for frame_type, _ in frames] == [FILE_META]
        assert sender.is_active and sender.is_awaiting_ack
        assert results == []

    def test_transfer_in_progress(self, tmp_path: Path) -> None:
        sender, _, _ = self._sender(tmp_path)
        sender.begin()
        with pytest.raises(FileTransferError) as info:
            sender.begin()
        assert info.value.kind is FileTransferErrorKind.TRANSFER_IN_PROGRESS

    def test_file_unavailable(self, tmp_path: Path) -> None:
        sender = FileSender(tmp_path / "missing.bin", file_id="f1", send=lambda *_: None)
        with pytest.raises(FileTransferError) as info:
            sender.begin()
        assert info.value.kind is FileTransferErrorKind.FILE_UNAVAILABLE

    @pytest.mark.parametrize(
        ("kwargs", "kind"),
        [
            ({"file_id": ""}, FileTransferErrorKind.INVALID_ARGUMENT),
            ({"chunk_size": 0}, FileTransferErrorKind.INVALID_ARGUMENT),
            ({"chunk_size": MAX_PAYLOAD_BYTES + 1}, FileTransferErrorKind.INVALID_ARGUMENT),
            ({"start_offset": -1}, FileTransferErrorKind.INVALID_ARGUMENT),
            ({"start_offset": 600_001}, FileTransferErrorKind.INVALID_ARGUMENT),
        ],
    )
    def test_invalid_arguments(
        self, tmp_path: Path, kwargs: dict, kind: FileTransferErrorKind
    ) -> None:
        source = write_source(tmp_path / "src.bin", 600_000)
        options = {"file_id": "f1", **kwargs}
        sender = FileSender(source, send=lambda *_: None, **options)
        with pytest.raises(FileTransferError) as info:
            sender.begin()
        assert info.value.kind is kind

    def test_successful_round_sends_chunks_on_each_ack(self, tmp_path: Path) -> None:
        sender, results, frames = self._sender(tmp_path)
        sender.begin()
        assert sender.handle_ack(FileAckPayload("f1", 0, False)) is False
        assert sender.handle_ack(FileAckPayload("f1", CHUNK_SIZE, False)) is False
        assert sender.handle_ack(FileAckPayload("f1", 2 * CHUNK_SIZE, False)) is False
        assert sender.handle_ack(FileAckPayload("f1", 600_000, True)) is True
        assert [frame_type for frame_type, _ in frames] == [
            FILE_META,
            FILE_CHUNK,
            FILE_CHUNK,
            FILE_CHUNK,
        ]
        assert results[-1].ok and results[-1].received_bytes == 600_000
        assert not sender.is_active and not sender.is_awaiting_ack
        assert len(results) == 1  # 终态恰一次

    def test_done_ack_with_wrong_size_is_protocol_error(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        sender.begin()
        assert sender.handle_ack(FileAckPayload("f1", 123, True)) is True
        assert results[-1].error is FileTransferErrorKind.PROTOCOL_ERROR

    def test_not_done_ack_with_all_bytes_is_protocol_error(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        sender.begin()
        assert sender.handle_ack(FileAckPayload("f1", 600_000, False)) is True
        assert results[-1].error is FileTransferErrorKind.PROTOCOL_ERROR

    def test_regressive_ack_is_protocol_error(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        sender.begin()
        assert sender.handle_ack(FileAckPayload("f1", CHUNK_SIZE, False)) is False
        assert sender.handle_ack(FileAckPayload("f1", CHUNK_SIZE, False)) is True
        assert results[-1].error is FileTransferErrorKind.PROTOCOL_ERROR

    def test_ack_beyond_total_size_is_protocol_error(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        sender.begin()
        assert sender.handle_ack(FileAckPayload("f1", 700_000, False)) is True
        assert results[-1].error is FileTransferErrorKind.PROTOCOL_ERROR

    def test_stray_ack_for_other_file_is_ignored(self, tmp_path: Path) -> None:
        sender, results, frames = self._sender(tmp_path)
        sender.begin()
        assert sender.handle_ack(FileAckPayload("other", 0, True)) is False
        assert results == [] and len(frames) == 1  # 未推进
        assert sender.handle_ack(FileAckPayload("f1", 0, False)) is False
        assert len(frames) == 2

    def test_ack_with_error_maps_to_local_kind(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        sender.begin()
        assert sender.handle_ack(
            FileAckPayload("f1", CHUNK_SIZE, False, FileAckError.RESUME_MISMATCH)
        )
        assert results[-1].error is FileTransferErrorKind.RESUME_MISMATCH
        assert results[-1].received_bytes == CHUNK_SIZE

    def test_bad_ack_payload_is_protocol_error(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        sender.begin()
        assert sender.handle_frame(FILE_ACK, b"not-json") is True
        assert results[-1].error is FileTransferErrorKind.PROTOCOL_ERROR

    def test_non_ack_frames_ignored_and_idle_acks_ignored(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        assert (
            sender.handle_frame(FILE_ACK, encode_file_ack(FileAckPayload("f1", 1, True))) is False
        )
        sender.begin()
        assert sender.handle_frame(FILE_CHUNK, b"") is False
        assert results == []

    def test_ack_timeout_terminates_round(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        sender.begin()
        assert sender.handle_ack_timeout() is True
        assert results[-1].error is FileTransferErrorKind.PROTOCOL_ERROR
        assert "超时" in (results[-1].detail or "")
        assert not sender.is_active
        assert sender.handle_ack_timeout() is False  # 已终结：无操作

    def test_cancel_and_session_closed(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        sender.begin()
        sender.cancel()
        assert results[-1].error is FileTransferErrorKind.CANCELLED
        assert sender.cancel() is None  # 空闲取消无操作

        other, other_results, _ = self._sender(tmp_path, file_id="f2")
        other.begin()
        other.handle_session_closed()
        assert other_results[-1].error is FileTransferErrorKind.SESSION_CLOSED

    def test_resume_round_restarts_from_ack_position(self, tmp_path: Path) -> None:
        sender, results, frames = self._sender(tmp_path, start_offset=2 * CHUNK_SIZE)
        meta = sender.begin()
        assert meta.start_offset == 2 * CHUNK_SIZE
        assert sender.handle_ack(FileAckPayload("f1", 2 * CHUNK_SIZE, False)) is False
        assert decode_file_chunk(frames[-1][1]).offset == 2 * CHUNK_SIZE
        assert sender.handle_ack(FileAckPayload("f1", 600_000, True)) is True
        assert results[-1].ok

    def test_can_begin_again_after_terminal_state(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        sender.begin()
        sender.cancel()
        assert sender.begin().file_id == "f1"
        assert sender.handle_ack(FileAckPayload("f1", 600_000, True)) is True
        assert [result.error for result in results] == [FileTransferErrorKind.CANCELLED, None]

    def test_send_callback_failure_becomes_send_failed(self, tmp_path: Path) -> None:
        source = write_source(tmp_path / "src.bin", 100)

        def explode(frame_type: int, payload: bytes) -> None:
            raise RuntimeError("transport gone")

        results: list = []
        sender = FileSender(source, file_id="f1", send=explode, on_completion=results.append)
        sender.begin()
        assert results[-1].error is FileTransferErrorKind.SEND_FAILED
        assert not sender.is_active

    def test_result_to_dict(self, tmp_path: Path) -> None:
        sender, results, _ = self._sender(tmp_path)
        sender.begin()
        sender.handle_ack(FileAckPayload("f1", 600_000, True))
        payload = results[-1].to_dict()
        assert payload["fileID"] == "f1" and payload["ok"] is True
        assert payload["receivedBytes"] == 600_000 and payload["totalSize"] == 600_000

        failing, fail_results, _ = self._sender(tmp_path, file_id="f9")
        failing.begin()
        failing.handle_ack(FileAckPayload("f9", 0, False, FileAckError.DISK_FULL))
        failure = fail_results[-1].to_dict()
        assert failure["ok"] is False and failure["error"] == "diskFull"
