"""**测试专用**设备侧参考实现（S3b「Host 从设备拉取」的被测对端；不进生产包）。

设备（被动端）职责与线契约（`docs/lan-sync-protocol.md`）：

- 帧 15 → 帧 16：对端内容清单（复用生产 `peer_library.peer_library_response`；
  事实行由本模块注入 —— 设备曲库在 tmp 目录，不能走 `state.LIBRARY` 全局扫描。
  分页 / 归一 / `trackCount` 自洽 / 摘要全部由生产代码产出，测试断言的就是它）；
- 帧 10 → 帧 11：manifest 快照（复用 `manifest.manifest_response`）；
- 帧 12 → 帧 13 + 4/5/6：按路径取文件（复用生产
  `fetch_responder.SyncFetchResponder`：越界拒读 / 串行停等 / 结果帧必发）。

可注入面（造「对端不老实」的用例）：

- `extra_manifest_entries`：manifest 里多出来的条目（清单说有、实际取不到 / 目录 /
  恶意路径）——模拟设备清单与磁盘事实不一致；
- `drop_after_manifest`：应答 manifest 后立刻删掉的文件（对端文件在取文件前消失）。

用法与 `tests/test_lansync_push.py` 的 `DevicePeer` 同形：配对后 `serve()` 驱动，
`timeout=0` 类的「本来就没有下一帧」用例用 `allow_timeout=True`，中途退出用 `stop` 谓词。
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from app.lansync import fetch_responder as FR
from app.lansync import manifest as MF
from app.lansync import peer_library as PL
from app.lansync.frame import FrameType
from app.lansync.manifest import Collection

#: 认可的音频扩展名（决定设备曲库里有几个「曲目」；与 `DEFAULT_AUDIO_EXTS` 同源口径）
AUDIO_EXTENSIONS = (".flac", ".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus")


class DevicePeer:
    """设备侧参考实现（被动端；一个会话一个实例）。"""

    def __init__(
        self,
        client: Any,
        *,
        root: Path,
        collection: Collection | None = None,
        extra_manifest_entries: Sequence[dict[str, Any]] = (),
        drop_after_manifest: Sequence[str] = (),
    ) -> None:
        self.client = client
        self.root = Path(root)
        self.collection = collection if collection is not None else Collection.all()
        self.extra_manifest_entries = [dict(entry) for entry in extra_manifest_entries]
        self.drop_after_manifest = tuple(drop_after_manifest)
        #: 收到的帧 15 载荷（断言请求侧字段是否严格按 §13.2 发出）
        self.peer_library_requests: list[dict[str, Any]] = []
        #: 回出的帧 16 载荷（断言设备事实）
        self.peer_library_responses: list[dict[str, Any]] = []
        self.manifest_requests: list[bytes] = []
        self.manifest_payloads: list[bytes] = []
        #: 收到的帧 12 载荷（断言「点名了哪些路径」）
        self.fetch_requests: list[FR.FetchRequest] = []
        #: 发出的全部帧（诊断 / 断言）
        self.sent_frames: list[tuple[int, bytes]] = []
        #: 帧 13 载荷（对端视角的送达 / 失败账目）
        self.result: FR.FetchResult | None = None
        #: 交付 N 块后**扣住 ack**（取消类用例：让传输可控地停在块边界「在途」）
        self.pause_after_chunks: int | None = None
        self._chunks_sent = 0
        self._held_acks: list[bytes] = []
        self._released = False
        self._responder = FR.SyncFetchResponder(
            _ResponderSession(self), root=self.root, on_result=self._on_result
        )

    # ---- 帧发送 ----
    def _send(self, frame_type: int, payload: bytes = b"") -> None:
        if frame_type == FrameType.FILE_CHUNK:
            self._chunks_sent += 1
        self.sent_frames.append((frame_type, payload))
        self.client.send_application_frame(frame_type, payload)

    def release(self) -> None:
        """放开被 `pause_after_chunks` 扣住的 ack（传输继续）。"""
        self._released = True
        held, self._held_acks = self._held_acks, []
        for payload in held:
            self._responder.handle_application_frame(FrameType.FILE_ACK, payload)

    def _holds_acks(self) -> bool:
        """当前是否处于「扣住 ack」的暂停态。"""
        if self.pause_after_chunks is None or self._released:
            return False
        return self._chunks_sent >= self.pause_after_chunks

    def _on_result(self, result: FR.FetchResult) -> None:
        self.result = result

    def meta_file_ids(self) -> list[str]:
        """发出过的 `file_meta` 帧里的 fileID（断言设备拿什么身份推文件）。"""
        ids: list[str] = []
        for frame_type, payload in self.sent_frames:
            if frame_type != FrameType.FILE_META:
                continue
            try:
                raw = json.loads(payload.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):  # pragma: no cover - 生产编码不会坏
                continue
            ids.append(str(raw.get("fileID", "")))
        return ids

    # ---- 设备曲库事实 ----
    def tracks(self) -> list[str]:
        """设备曲库内的音频相对路径（升序）。"""
        return [row["id"] for row in self._songs()]

    def _songs(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for path in sorted(self.root.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            if path.suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            rows.append(
                {
                    "id": path.relative_to(self.root).as_posix(),
                    "path": str(path),
                    "name": path.stem,
                }
            )
        return rows

    def _manifest_bytes(self) -> bytes:
        payload = MF.manifest_response(self.collection, root=self.root, songs=self._songs())
        entries = list(payload["entries"]) + self.extra_manifest_entries
        return json.dumps(
            {"entries": entries, "rootName": self.root.name},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")

    # ---- 主循环 ----
    async def serve(
        self,
        *,
        timeout: float = 8.0,
        allow_timeout: bool = False,
        stop: Callable[[], bool] | None = None,
    ) -> FR.FetchResult | None:
        """驱动设备侧直到发出帧 13（返回其结果）；`allow_timeout` = 等不到帧时返回 None。

        `stop` 谓词为真 → 立即收工返回（取消类用例：对端不再有帧可等）。
        """
        from lansync_ref_client import RefClientError  # 测试目录裸名 import（同目录）

        deadline = time.monotonic() + timeout
        while True:
            if self.result is not None:
                return self.result
            remaining = deadline - time.monotonic()
            if remaining <= 0 or (stop is not None and stop()):
                return None
            try:
                frame_type, payload = await self.client.recv_application_frame(timeout=remaining)
            except RefClientError as error:
                if self.result is not None:
                    return self.result
                if allow_timeout:
                    return None
                raise AssertionError(f"设备侧等待帧失败：{error}") from error
            self._dispatch(frame_type, payload)

    def _dispatch(self, frame_type: int, payload: bytes) -> None:
        """按帧类型分派（15/16 清单、10/11 manifest、12/13 + 4/5/6 取文件）。"""
        if frame_type == FrameType.PEER_LIBRARY_REQUEST:
            request = json.loads(payload.decode("utf-8")) if payload else {}
            self.peer_library_requests.append(request)
            response = PL.peer_library_response(request, root=self.root, songs=self._songs())
            self.peer_library_responses.append(response)
            self._send(FrameType.PEER_LIBRARY_RESPONSE, _json_bytes(response))
            return
        if frame_type == FrameType.MANIFEST_REQUEST:
            self.manifest_requests.append(payload)
            blob = self._manifest_bytes()
            self.manifest_payloads.append(blob)
            self._send(FrameType.MANIFEST_RESPONSE, blob)
            for relative in self.drop_after_manifest:
                (self.root / relative).unlink(missing_ok=True)
            return
        if frame_type == FrameType.SYNC_FETCH_REQUEST:
            self.fetch_requests.append(FR.decode_fetch_request(payload))
            self._responder.handle_application_frame(frame_type, payload)
            return
        if frame_type == FrameType.FILE_ACK:
            if self._holds_acks():
                self._held_acks.append(payload)
                return
            self._responder.handle_application_frame(frame_type, payload)
            return
        raise AssertionError(f"设备侧收到意外帧：{frame_type}")


def _json_bytes(payload: dict[str, Any]) -> bytes:
    """载荷字典 → JSON 字节（与生产编码同形）。"""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class _ResponderSession:
    """`SyncFetchResponder` 需要的会话接口适配（生产 = `HostSession`；此处转发设备帧通道）。"""

    is_ready = True

    def __init__(self, peer: DevicePeer) -> None:
        self._peer = peer

    def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
        self._peer._send(frame_type, payload)  # noqa: SLF001 - 同模块内的测试桩转发


def run(coro: Any) -> Any:
    """跑一个异步场景（本仓库未装 pytest-asyncio；与其它 lansync 测试同形）。"""
    return asyncio.run(coro)
