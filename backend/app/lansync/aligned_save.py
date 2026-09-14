"""桌面「AI 对齐」产物落库编排（§15 随歌通道的**写入侧**：本地产物 → aligned 歌词库）。

职责单一：**对齐 sentences + 歌曲路径 → payload 字节 → `AlignedLyricsStore.save`**。
对齐本身在 `routers/lyrics.py`、落点库在 `app/lansync/lyrics.py`，本模块只做「翻译 + 编排」。

════════════════════════════════════════════════════════════════════════════
payload 形态 = Swift `Lyrics` JSON（跨端契约，写错 = 同步过去也读不出）
════════════════════════════════════════════════════════════════════════════
依据：协议 `docs/lan-sync-protocol.md` §15.1「文件形态：一歌一文件、内容 = 裸 `Lyrics` JSON
（与 manual 同构，同一解码器可读）」＋ Swift 模型 `QQPlayer/Services/LyricsModels.swift`。
对端用 `JSONDecoder().decode(Lyrics.self, from:)` 读，**字段名 / 类型 / 枚举值任一写错即解码失败**：

    {"plainLyrics": "<全部行文本按 \\n 连接>",
     "syncedLyrics": [{"timestamp": <start 秒 double>, "text": "<行文本>"}],
     "isInstrumental": false,
     "source": "none"}

- `source` 只能取 Swift `LyricsSource` 原始值之一（`embedded` / `netease` / `lrclib` / `none`）；
  AI 本地产物无外部源 → `none`（Swift 枚举里**没有** `aligned`，**不得自造值**）；
- `translation` 无数据 → **省略该键**（Swift 侧可选字段）；
- 行过滤与 `lyrics_service._align_to_lrc` **同口径**（空文本行 / start 非数字行跳过），
  保证「LRC 对齐了多少行，payload 就是多少行」，两处不会各自漂移。

本地键 = 歌曲 `content_hash`（相对路径会随改名漂移，指纹才是跨端稳定身份，见 lyrics.py 文件头）；
拿不到（文件不在曲库内 / 不存在 → `locallib` 的 None 口径）→ **跳过**，不写任何文件、不猜键。

**落库失败绝不影响对齐接口本身**：:func:`save_aligned_lyrics` 全程 try/except，失败只
`logger.warning` + 返回 `failed` 状态（路由照常返回 200 + `lrc`）。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any

from app import state

from .locallib import ensure_content_hash, relative_path_of
from .lyrics import AlignedLyricsStore

logger = logging.getLogger(__name__)

#: payload `source` 取值（Swift `LyricsSource` 原始值；AI 本地产物 = `none`，**不得自造值**）
LYRICS_SOURCE_NONE = "none"

#: 落库状态（路由返回体 `aligned_status` 的取值；跨前后端字符串契约）
STATUS_SAVED = "saved"
STATUS_SKIPPED = "skipped"
STATUS_FAILED = "failed"

#: 跳过 / 失败原因（**仅本端诊断用**，不上线、不是跨端契约）
REASON_SONG_OUT_OF_LIBRARY = "song_out_of_library"
REASON_CONTENT_HASH_UNAVAILABLE = "content_hash_unavailable"
REASON_WRITE_FAILED = "write_failed"
REASON_UNEXPECTED_ERROR = "unexpected_error"


def build_payload(sentences: Sequence[Mapping[str, Any]] | None) -> bytes:
    """对齐 sentences → Swift `Lyrics` JSON 字节（本模块**唯一**的 payload 构造入口）。

    Args:
        sentences: 对齐工具输出的句子序列（`{"start": 秒, "end": 秒, "text": 行文本}`）；
            元素非映射 / `start` 不可转 float / 文本去空白后为空 → 跳过（与
            `lyrics_service._align_to_lrc` 同口径）。

    Returns:
        `json.dumps(..., ensure_ascii=False).encode("utf-8")`（对端 JSONDecoder 直接可解）。
    """
    texts: list[str] = []
    synced: list[dict[str, Any]] = []
    for sentence in sentences or ():
        if not isinstance(sentence, Mapping):
            continue
        line_text = str(sentence.get("text") or "").strip()
        if not line_text:
            continue
        try:
            timestamp = float(sentence.get("start") or 0)
        except (TypeError, ValueError):
            continue
        texts.append(line_text)
        synced.append({"timestamp": timestamp, "text": line_text})
    payload = {
        "plainLyrics": "\n".join(texts),
        "syncedLyrics": synced,
        "isInstrumental": False,
        "source": LYRICS_SOURCE_NONE,
    }
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def save_aligned_lyrics(
    song_path: Any,
    sentences: Sequence[Mapping[str, Any]] | None,
    *,
    library_root: Any = None,
    store: AlignedLyricsStore | None = None,
) -> dict[str, Any]:
    """对齐结果落 aligned 歌词库（**唯一入口**；本函数不抛异常）。

    Args:
        song_path: 歌曲路径（路由收到的字符串；不在曲库根内 → 跳过）。
        sentences: 对齐 sentences（见 :func:`build_payload`）。
        library_root: 曲库根（缺省 `state.LIBRARY`；测试注入用）。
        store: 歌词库（缺省 `AlignedLyricsStore()` → `state.ALIGNED_LYRIC_DIR`；测试注入用）。

    Returns:
        `{"status": "saved"|"skipped"|"failed", "content_hash": str|None, "reason": str|None}`
        （可 JSON 序列化；路由只取 `status`）。
    """
    root = library_root if library_root is not None else state.LIBRARY
    content_hash: str | None = None
    try:
        relative = relative_path_of(song_path, root)
        if relative is None:
            logger.debug("AI 对齐产物跳过落库（歌不在曲库内）：%s", song_path)
            return _outcome(STATUS_SKIPPED, None, REASON_SONG_OUT_OF_LIBRARY)
        content_hash = ensure_content_hash(relative, root=root)
        if content_hash is None:
            logger.debug("AI 对齐产物跳过落库（拿不到 content_hash）：%s", relative)
            return _outcome(STATUS_SKIPPED, None, REASON_CONTENT_HASH_UNAVAILABLE)
        target = store if store is not None else AlignedLyricsStore()
        if target.save(content_hash, build_payload(sentences)) is None:
            return _outcome(STATUS_FAILED, content_hash, REASON_WRITE_FAILED)
    except Exception:  # noqa: BLE001 - 落库失败绝不影响对齐接口本身（返回失败状态即可）
        logger.warning("AI 对齐产物落 aligned 库失败（path=%s）", song_path, exc_info=True)
        return _outcome(STATUS_FAILED, content_hash, REASON_UNEXPECTED_ERROR)
    return _outcome(STATUS_SAVED, content_hash, None)


def _outcome(status: str, content_hash: str | None, reason: str | None) -> dict[str, Any]:
    """构造落库结果（字段固定，路由 / 测试共用）。"""
    return {"status": status, "content_hash": content_hash, "reason": reason}


__all__ = [
    "LYRICS_SOURCE_NONE",
    "REASON_CONTENT_HASH_UNAVAILABLE",
    "REASON_SONG_OUT_OF_LIBRARY",
    "REASON_UNEXPECTED_ERROR",
    "REASON_WRITE_FAILED",
    "STATUS_FAILED",
    "STATUS_SAVED",
    "STATUS_SKIPPED",
    "build_payload",
    "save_aligned_lyrics",
]
