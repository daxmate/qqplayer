"""桌面「AI 对齐」产物落 aligned 歌词库测试（协议 §15 随歌通道的**写入侧**）。

覆盖：
1. 对齐成功 → aligned 库出现 `{content_hash}.json`，内容 = 对齐结果（**Swift `Lyrics` JSON 形状锁死**：
   键名 / 类型 / `source == "none"` / 无 `translation` 键），且行过滤与 `_align_to_lrc` 同口径；
2. `/api/lyric/manual` 手动指定歌词 → **不**产生 aligned 条目（只有 aligned 参与随歌同步）；
3. 落库失败（库目录被文件占位 → `mkdir` OSError）→ 接口仍 200 + `lrc`，返回体带失败标记；
4. 拿不到 `content_hash`（歌在曲库根之外 / 文件已不存在）→ 跳过、库内零新文件；
5. 幂等：同歌重复对齐 → 覆盖为最新内容，库内仍只有一个文件。

隔离：曲库根 / aligned 库 / manual 目录全部注入 tmp（真实 `~/.cache/qqplayer/lyric` 零写入），
对齐子进程 mock（不真跑模型，对齐脚本用 tmp 占位文件）。
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app.routers.lyrics as router_lyrics  # noqa: E402
import backend  # noqa: E402
import lyric_fetch  # noqa: E402
from app import state  # noqa: E402
from app.lansync.aligned_save import save_aligned_lyrics  # noqa: E402
from app.lansync.lyrics import AlignedLyricsStore  # noqa: E402

client = TestClient(backend.app)

SONG_RELATIVE = "Album/01 A.flac"
SONG_BYTES = b"\xff\xfb\x90\x00" + b"\x00" * 1024


class FakeProc:
    """伪对齐子进程结果（`subprocess.run` 返回值同形）。"""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


@pytest.fixture
def fake_run(monkeypatch):
    """替换 `subprocess.run`：记录 cmd，返回 slots['proc']（用例内可改）。"""
    slots = {"proc": FakeProc()}

    def _run(cmd, **kw):
        slots["cmd"] = cmd
        slots["kw"] = kw
        return slots["proc"]

    monkeypatch.setattr(backend.subprocess, "run", _run)
    return slots


@pytest.fixture(autouse=True)
def _no_auto_translation(monkeypatch):
    """禁用自动补翻译（真实实现会发网易云请求），本套用例都不验证翻译。"""
    monkeypatch.setattr(router_lyrics, "auto_attach_translation", lambda *a, **kw: None)


@pytest.fixture
def env(tmp_path, monkeypatch):
    """tmp 曲库 + tmp aligned 库 + tmp 对齐脚本占位；返回路径与歌曲 content_hash。"""
    library = tmp_path / "library"
    song = library / SONG_RELATIVE
    song.parent.mkdir(parents=True)
    song.write_bytes(SONG_BYTES)
    aligned = tmp_path / "lyrics-aligned"
    script = tmp_path / "lyric-align"
    script.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    monkeypatch.setattr(state, "LIBRARY", library)
    monkeypatch.setattr(state, "ALIGNED_LYRIC_DIR", aligned)
    monkeypatch.setattr(state, "ALIGN_SCRIPT", str(script))
    monkeypatch.setattr(state, "_scan_cache", None)
    monkeypatch.setattr(lyric_fetch, "MANUAL_DIR", tmp_path / "manual")
    return {
        "library": library,
        "song": song,
        "aligned": aligned,
        "content_hash": hashlib.sha256(SONG_BYTES).hexdigest(),
    }


def align_json(*sentences):
    """对齐工具 stdout 形态。"""
    return json.dumps({"words": [], "sentences": [dict(s) for s in sentences]}, ensure_ascii=False)


def _align(song_path: Path, text: str = "第一行\n第二行"):
    """走真实路由 `POST /api/lyric/align`。"""
    return client.post("/api/lyric/align", json={"path": str(song_path), "text": text})


def _read_payload(path: Path) -> dict:
    return json.loads(path.read_bytes().decode("utf-8"))


def test_align_saves_swift_shaped_payload(env, fake_run):
    """① 对齐成功 → 落库 `{content_hash}.json`；payload 形状 = Swift `Lyrics` 可解码契约。"""
    fake_run["proc"] = FakeProc(
        stdout=align_json(
            {"start": 1.23, "end": 4.56, "text": "第一行"},
            {"start": 65.4, "end": 68.0, "text": "  "},  # 空白行：与 _align_to_lrc 同口径跳过
            {"start": "abc", "end": 70.0, "text": "坏行"},  # start 非数字：同样跳过
            {"start": 125.99, "end": 128.0, "text": "第二行"},
        )
    )
    res = _align(env["song"], "第一行\n第二行")
    assert res.status_code == 200
    body = res.json()
    # 现有字段一个没动（前端仍按 lrc 用）
    assert body["lrc"] == "[00:01.23]第一行\n[02:05.99]第二行"
    assert body["lines"] == 2
    assert body["aligned_saved"] is True
    assert body["aligned_status"] == "saved"

    store = AlignedLyricsStore()
    assert store.root == env["aligned"]
    assert store.has(env["content_hash"])
    entry = store.path_for(env["content_hash"])
    assert entry.name == f"{env['content_hash']}.json"  # 文件名 = 歌曲 content_hash
    entries = store.entries()
    assert [e.content_hash for e in entries] == [env["content_hash"]]
    assert entries[0].file_hash == hashlib.sha256(entry.read_bytes()).hexdigest()  # 内容比对键
    assert entries[0].song_relative_path == SONG_RELATIVE  # 指纹表反查（「跟歌走」用）

    payload = _read_payload(entry)
    # Swift `Lyrics` 解码器硬契约：字段名 / 类型 / 枚举值任一写错 = 对端解码失败
    assert set(payload) == {"plainLyrics", "syncedLyrics", "isInstrumental", "source"}
    assert payload["plainLyrics"] == "第一行\n第二行"
    assert payload["isInstrumental"] is False
    assert payload["source"] == "none"  # Swift LyricsSource 原始值；没有 aligned 这个值
    assert payload["syncedLyrics"] == [
        {"timestamp": 1.23, "text": "第一行"},
        {"timestamp": 125.99, "text": "第二行"},
    ]


def test_manual_save_does_not_touch_aligned(env):
    """② 手动指定歌词（/api/lyric/manual）不写 aligned 库：只有 aligned 参与随歌同步。"""
    res = client.put(
        "/api/lyric/manual",
        json={
            "path": str(env["song"]),
            "format": "lrc",
            "text": "[00:01.00]手动的一句",
            "source": "粘贴",
        },
    )
    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert AlignedLyricsStore().entries() == []
    aligned_files = list(env["aligned"].glob("*.json")) if env["aligned"].exists() else []
    assert aligned_files == []


def test_save_failure_keeps_align_response(env, fake_run, tmp_path, monkeypatch):
    """③ 落库失败（库路径被文件占位）→ 接口照常 200 + lrc，只带失败标记。"""
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory", encoding="utf-8")
    # mkdir(parents=True) 撞占位文件 → OSError → AlignedLyricsStore.save 返回 None
    monkeypatch.setattr(state, "ALIGNED_LYRIC_DIR", blocker)
    fake_run["proc"] = FakeProc(stdout=align_json({"start": 2.0, "end": 3.0, "text": "一句"}))

    res = _align(env["song"], "一句")
    assert res.status_code == 200
    body = res.json()
    assert body["lrc"] == "[00:02.00]一句"
    assert body["aligned_saved"] is False
    assert body["aligned_status"] == "failed"
    assert blocker.is_file()  # 占位文件未被破坏


def test_song_outside_library_is_skipped(env, fake_run, tmp_path):
    """④-1 歌在曲库根之外 → 跳过（不猜键）、库内零新文件。"""
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(SONG_BYTES)
    fake_run["proc"] = FakeProc(stdout=align_json({"start": 1.0, "end": 2.0, "text": "一句"}))

    res = _align(outside, "一句")
    assert res.status_code == 200
    assert res.json()["aligned_saved"] is False
    assert res.json()["aligned_status"] == "skipped"
    assert list(env["aligned"].glob("*.json")) == []


def test_missing_song_file_is_skipped(env):
    """④-2 路径在曲库根内但文件已不存在（指纹取不到）→ 跳过、库内零新文件。"""
    env["song"].unlink()
    outcome = save_aligned_lyrics(str(env["song"]), [{"start": 0.1, "end": 1.0, "text": "一句"}])
    assert outcome == {
        "status": "skipped",
        "content_hash": None,
        "reason": "content_hash_unavailable",
    }
    assert list(env["aligned"].glob("*.json")) == []


def test_align_twice_keeps_single_file(env, fake_run):
    """⑤ 幂等：同歌重复对齐 → 覆盖为最新内容，库内仍只有一个文件。"""
    fake_run["proc"] = FakeProc(stdout=align_json({"start": 1.0, "end": 2.0, "text": "旧的一句"}))
    assert _align(env["song"], "旧的一句").json()["aligned_status"] == "saved"

    fake_run["proc"] = FakeProc(stdout=align_json({"start": 9.5, "end": 11.0, "text": "新的一句"}))
    res = _align(env["song"], "新的一句")
    assert res.status_code == 200
    assert res.json()["aligned_status"] == "saved"

    files = list(env["aligned"].glob("*.json"))
    assert [f.name for f in files] == [f"{env['content_hash']}.json"]
    payload = _read_payload(files[0])
    assert payload["plainLyrics"] == "新的一句"
    assert payload["syncedLyrics"] == [{"timestamp": 9.5, "text": "新的一句"}]
