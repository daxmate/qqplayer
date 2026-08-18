"""POST /api/lyric/align AI 歌词对齐测试（mock subprocess.run，不真跑模型）

覆盖：成功 → LRC 格式 / 行数 / 时长；语言参数透传；参数列表传参（无 shell）；
404 path 不存在 / 400 空文本 / 缺少 path；500 非零退出（附 stderr 尾部）/ 输出异常 / 空句子 / 工具未装；
504 超时（subprocess.TimeoutExpired）。
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import backend  # noqa: E402
from app import state  # noqa: E402

client = TestClient(backend.app)


class FakeProc:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


@pytest.fixture
def song_file(tmp_path):
    """临时假 mp3（只需文件存在，对齐路由不读音频内容）"""
    p = tmp_path / "song.mp3"
    p.write_bytes(b"\xff\xfb\x90\x00" + b"\x00" * 413)
    return p


@pytest.fixture
def fake_run(monkeypatch):
    """替换 backend.subprocess.run：记录 cmd，返回 slots['proc']（测试内可改）"""
    slots = {"proc": FakeProc()}

    def _run(cmd, **kw):
        slots["cmd"] = cmd
        slots["kw"] = kw
        return slots["proc"]

    monkeypatch.setattr(backend.subprocess, "run", _run)
    return slots


def align_json(*sentences):
    return json.dumps({"words": [], "sentences": [dict(s) for s in sentences]}, ensure_ascii=False)


def test_align_success_returns_lrc(song_file, fake_run):
    fake_run["proc"] = FakeProc(
        stdout=align_json(
            {"start": 1.23, "end": 4.56, "text": "第一行歌词"},
            {"start": 65.4, "end": 68.0, "text": "第二行歌词"},
            {"start": 125.99, "end": 128.0, "text": "第三行"},
        )
    )
    res = client.post(
        "/api/lyric/align",
        json={"path": str(song_file), "text": "第一行歌词\n第二行歌词\n第三行"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["lrc"] == "[00:01.23]第一行歌词\n[01:05.40]第二行歌词\n[02:05.99]第三行"
    assert data["lines"] == 3
    assert data["duration"] is None or isinstance(data["duration"], (int, float))
    # 参数列表传参（无 shell）：项目内脚本路径/文本原样传入，不经过 shell 解析
    assert fake_run["cmd"][0].endswith("scripts/lyric-align")
    assert fake_run["cmd"][1] == str(song_file)
    assert fake_run["cmd"][2:4] == ["-t", "第一行歌词\n第二行歌词\n第三行"]
    assert fake_run["cmd"][4:] == ["-o", "json"]
    assert "shell" not in fake_run["kw"]


def test_align_passes_language_flag(song_file, fake_run):
    fake_run["proc"] = FakeProc(stdout=align_json({"start": 0.5, "end": 1.0, "text": "行"}))
    res = client.post(
        "/api/lyric/align", json={"path": str(song_file), "text": "行", "language": "ja"}
    )
    assert res.status_code == 200
    assert fake_run["cmd"][fake_run["cmd"].index("-l") + 1] == "ja"
    assert fake_run["cmd"][fake_run["cmd"].index("-o") + 1] == "json"


def test_align_text_with_quotes_not_injected(song_file, fake_run):
    """歌词含引号/分号等特殊字符时原样传入（参数列表传参的安全保障）"""
    tricky = 'he said "hi"; rm -rf /tmp/x\n第二行'
    fake_run["proc"] = FakeProc(stdout=align_json({"start": 0.1, "end": 1.0, "text": tricky}))
    res = client.post("/api/lyric/align", json={"path": str(song_file), "text": tricky})
    assert res.status_code == 200
    assert fake_run["cmd"][3] == tricky


def test_align_missing_path_400(song_file):
    res = client.post("/api/lyric/align", json={"text": "歌词"})
    assert res.status_code == 400


def test_align_empty_text_400(song_file):
    res = client.post("/api/lyric/align", json={"path": str(song_file), "text": "   "})
    assert res.status_code == 400
    assert "歌词内容为空" in res.json()["detail"]


def test_align_path_not_found_404(tmp_path):
    res = client.post("/api/lyric/align", json={"path": str(tmp_path / "nope.mp3"), "text": "歌词"})
    assert res.status_code == 404


def test_align_nonzero_exit_500_with_stderr_tail(song_file, fake_run):
    fake_run["proc"] = FakeProc(
        returncode=1,
        stderr="❌ 模型加载失败\nsome error line1\nsome error line2",
    )
    res = client.post("/api/lyric/align", json={"path": str(song_file), "text": "歌词"})
    assert res.status_code == 500
    detail = res.json()["detail"]
    assert "AI 对齐失败" in detail
    assert "some error line2" in detail  # stderr 尾部附进 detail 帮助排查


def test_align_download_failed_500_with_modelscope_guidance(song_file, fake_run):
    """模型自动下载失败：detail 带 modelscope.cn 手动下载指引 + stderr 尾部"""
    fake_run["proc"] = FakeProc(
        returncode=1,
        stderr="❌ 模型自动下载失败，请手动下载: https://modelscope.cn/models/mlx-community/Qwen3-ForcedAligner-0.6B-5bit",
    )
    res = client.post("/api/lyric/align", json={"path": str(song_file), "text": "歌词"})
    assert res.status_code == 500
    detail = res.json()["detail"]
    assert "首次使用需下载对齐模型" in detail
    assert backend.ALIGN_MODEL_URL in detail
    assert "modelscope.cn/models" in detail


def test_align_model_download_pending_500_hint(song_file, fake_run):
    """模型缺失正在下载（准备下载提示）：detail 提示首次使用需下载模型"""
    fake_run["proc"] = FakeProc(
        returncode=1,
        stderr="ℹ️ 对齐模型不存在，准备下载（约 1GB，首次使用需要几分钟）...\n❌ 下载中断",
    )
    res = client.post("/api/lyric/align", json={"path": str(song_file), "text": "歌词"})
    assert res.status_code == 500
    assert "首次使用需下载对齐模型（约 1GB）" in res.json()["detail"]


def test_align_timeout_504(song_file, monkeypatch):
    def _timeout(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=600)

    monkeypatch.setattr(backend.subprocess, "run", _timeout)
    res = client.post("/api/lyric/align", json={"path": str(song_file), "text": "歌词"})
    assert res.status_code == 504
    assert "超时" in res.json()["detail"]


def test_align_script_missing_500(song_file, monkeypatch):
    monkeypatch.setattr(state, "ALIGN_SCRIPT", "/nonexistent/bin/align")
    res = client.post("/api/lyric/align", json={"path": str(song_file), "text": "歌词"})
    assert res.status_code == 500
    assert "未安装" in res.json()["detail"]


def test_align_bad_json_output_500(song_file, fake_run):
    fake_run["proc"] = FakeProc(stdout="not json at all")
    res = client.post("/api/lyric/align", json={"path": str(song_file), "text": "歌词"})
    assert res.status_code == 500
    assert "输出异常" in res.json()["detail"]


def test_align_empty_sentences_500(song_file, fake_run):
    fake_run["proc"] = FakeProc(stdout=json.dumps({"words": [], "sentences": []}))
    res = client.post("/api/lyric/align", json={"path": str(song_file), "text": "歌词"})
    assert res.status_code == 500
    assert "未识别到歌词行" in res.json()["detail"]


def test_align_skips_sentence_without_text(song_file, fake_run):
    fake_run["proc"] = FakeProc(
        stdout=align_json(
            {"start": 1.0, "end": 2.0, "text": "有词"},
            {"start": 3.0, "end": 4.0, "text": "  "},
        )
    )
    res = client.post("/api/lyric/align", json={"path": str(song_file), "text": "有词"})
    assert res.status_code == 200
    assert res.json()["lrc"] == "[00:01.00]有词"
    assert res.json()["lines"] == 1
