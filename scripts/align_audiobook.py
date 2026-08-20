#!/usr/bin/env python3
"""
align_audiobook.py — 有声书与文本对齐工具（QQPlayer 阅读器 V2 配套）

输入：每章 MP3 + 已知句子文本（EPUB 提取），输出 sentences.json 时间轴。

引擎（--engine，默认 omlx）：
  omlx   —— ① silencedetect 静音切块（块首即语音，避开 forced aligner 把文本
             铺到段首静音/标题播报上的缺陷）② 每块 Qwen3-ASR 转写（HTTP，~1s/块）
             ③ difflib 全文对齐把句子分配到块（文本匹配，零时间估算误差，标题
             播报块自然无句子匹配被跳过）④ Qwen3-ForcedAligner 逐块词级强制对齐
             （MLX 0.6B，CTC 逐帧）→ 句时间戳。一章 4 分钟音频约 20s。
  whisper —— openai-whisper large-v3-turbo 分段转写 → difflib 词级对齐（旧路线，
             一章约 6 分钟，仅作 fallback）

精度（MTH ch05 实测，63 句人工基准，带背景音乐）：62/63 匹配，起点偏差
median 32ms、90% ≤0.485s、无累积漂移；仅个别跨静音块的句子偏差 3-4s
（阅读器手动校准兜底）。

为什么这比歌词对齐准：
1. 有声书是"乐垫人声"（人声主轨），ASR/CTC 锁得住；歌词是"人声混乐"
2. 文本完全已知 → 词级全文 SequenceMatcher 对齐（align_lyric 验证过的路线）
3. 章节开头常有标题播报（"Chapter 5, ..."）：ASR 转写后 difflib 全文对齐天然跳过
   （正文句子匹配不到标题词）——MTH ch05 实测自动跳过

用法：
    python3 align_audiobook.py --audio "<mp3>" --sentences "<句子文件>" \
        [--lang en|ja|zh] [--out sentences.json] [--engine omlx|whisper]
    # whisper 引擎需要 openai-whisper venv python：
    /opt/homebrew/Cellar/openai-whisper/<ver>/libexec/bin/python3 align_audiobook.py --engine whisper ...

句子文件格式（任选其一）：
    1. 纯文本：每行一句（空行忽略）
    2. JSON：list[str] 或 list[{"text": "..."}]（保留顺序）

输出：
    sentences.json → [{"index": 0, "text": "...", "s": 4.8, "e": 7.24}, ...]
    （s/e 为句内首词 start / 末词 end）
"""

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
WORKER = SCRIPT_DIR / "_omlx_align_worker.py"

AUDIO_TMP = "/tmp/ab_align_audio.wav"
WINDOW = 30.0
OVERLAP = 3.0
STEP = WINDOW - OVERLAP

LANG_FULL = {"en": "English", "ja": "Japanese", "zh": "Chinese"}
ASR_MODEL = "Qwen3-ASR-0.6B-5bit"
FA_MODEL = "Qwen3-ForcedAligner-0.6B-5bit"


# ---------- omlx 配置 ----------


def omlx_config():
    settings = json.loads(
        (Path.home() / ".omlx" / "settings.json").read_text(encoding="utf-8")
    )
    api = f"http://127.0.0.1:{settings['server']['port']}"
    key = settings["auth"]["api_key"]
    return api, key


# ---------- 归一化（英文按词；日文/中文走假名/字符流） ----------


def _en_tokens(text: str) -> list[str]:
    t = text.lower().replace("'", "").replace("’", "").replace("-", "")
    t = t.replace("—", "").replace("–", "")
    return [w for w in re.findall(r"[a-z']+", t) if w]


def _ja_tokens(text: str) -> list[str]:
    import pykakasi

    kks = pykakasi.Kakasi()
    s = unicodedata.normalize("NFKC", text).lower()
    out = "".join(item["hira"] for item in kks.convert(s))
    out = re.sub(r"[・、。！？!?.,，…\-\s\u3000]", "", out)
    return list(out)


def _zh_tokens(text: str) -> list[str]:
    return list(re.sub(r"[\s\W_]+", "", text.lower()))


def tokens(text: str, lang: str) -> list[str]:
    if lang == "ja":
        return _ja_tokens(text)
    if lang == "zh":
        return _zh_tokens(text)
    return _en_tokens(text)


# ---------- 1a. omlx：ASR 分段转写（HTTP） ----------


def call_asr(api, key, wav_path, lang_full):
    boundary = "----ab" + os.urandom(8).hex()
    body = b""

    def field(n, v):
        nonlocal body
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{n}"\r\n\r\n{v}\r\n'
        ).encode()

    def upload(n, p):
        nonlocal body
        with open(p, "rb") as fh:
            data = fh.read()
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{n}"; '
            f'filename="{os.path.basename(p)}"\r\nContent-Type: application/octet-stream\r\n\r\n'
        ).encode()
        body += data + b"\r\n"

    field("model", ASR_MODEL)
    field("response_format", "json")
    field("language", lang_full)
    upload("file", wav_path)
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{api}/v1/audio/transcriptions",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        d = json.loads(resp.read().decode())
    return d.get("text", "").strip()


def asr_chunks_omlx(
    audio: str, lang: str, blocks: list[tuple[float, float]] | None = None
) -> list[dict]:
    """按语音块（或 30s 窗口）逐段 ASR → [{start, end, text}]（全局时间）。

    blocks 传入时按块转写（块首即语音，文本 difflib 分块零误差）；
    否则用 30s 窗口 + 3s 重叠（旧行为，仅 whisper 引擎兼容保留）。
    """
    api, key = omlx_config()
    lang_full = LANG_FULL[lang]
    if blocks is None:
        dur = float(
            subprocess.check_output(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    audio,
                ]
            ).strip()
        )
        blocks = []
        start = 0.0
        while start < dur - 1:
            blocks.append((start, min(start + WINDOW, dur)))
            start += STEP
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            audio,
            "-ar",
            "16000",
            "-ac",
            "1",
            AUDIO_TMP,
        ],
        check=True,
    )
    t0 = time.time()
    segs = []
    for wi, (ws, we) in enumerate(blocks):
        seg_wav = f"/tmp/ab_asr_win_{wi:02d}.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-ss",
                f"{ws:.3f}",
                "-to",
                f"{we:.3f}",
                "-i",
                AUDIO_TMP,
                "-ar",
                "16000",
                "-ac",
                "1",
                seg_wav,
            ],
            check=True,
        )
        text = call_asr(api, key, seg_wav, lang_full)
        Path(seg_wav).unlink(missing_ok=True)
        if text:
            segs.append({"start": ws, "end": we, "text": text, "bi": wi})
        else:
            print(f"  ASR 块 {wi:02d} [{ws:.0f}-{we:.0f}] 空转写（跳过）", flush=True)
    print(f"[ASR] 完成 {len(segs)} 块，耗时 {time.time() - t0:.0f}s", flush=True)
    return segs


# ---------- 1b. whisper-cli（GPU，whisper.cpp）----------


def parse_whisper_cli_json(data: dict, lang: str) -> list[dict]:
    """whisper.cpp -ojf 输出 → [{word, start, end}]（秒）

    日文 BPE 无空格边界：每个 token 直接作为词单元（_ja_tokens 会再展开）；
    英文等：前导空格 = 新词，BPE 拆词续接合并。
    """
    words: list[dict] = []
    for seg in data.get("transcription", []):
        if lang == "ja":
            for tok in seg.get("tokens", []):
                text = tok.get("text", "")
                if not text or text.startswith("[_"):
                    continue
                text = text.strip()
                if not text:
                    continue
                start = tok["offsets"]["from"] / 1000.0
                end = tok["offsets"]["to"] / 1000.0
                words.append({"word": text, "start": start, "end": end})
        else:
            cur = None
            for tok in seg.get("tokens", []):
                text = tok.get("text", "")
                if not text or text.startswith("[_"):
                    continue
                start = tok["offsets"]["from"] / 1000.0
                end = tok["offsets"]["to"] / 1000.0
                if text.startswith(" "):
                    if cur:
                        words.append({"word": cur[0], "start": cur[1], "end": cur[2]})
                    cur = [text.strip(), start, end]
                elif cur:
                    cur[0] += text
                    cur[2] = end
                else:
                    cur = [text, start, end]
            if cur:
                words.append({"word": cur[0], "start": cur[1], "end": cur[2]})
    return words


def transcribe_whisper_cli(audio: str, lang: str) -> list[dict]:
    """whisper-cli（Metal GPU）整段转写 → 词级时间戳。

    whisper.cpp 内部自动滑窗，无需手动分段；比 Python whisper CPU 快 ~12-25 倍
    （MTH 项目实战验证，模型 ~/models/ggml-large-v3-turbo-q5_0.bin）。
    -mc 0 禁用上下文：减少间奏区"前文脑补"幻觉（歌词重复被听进纯音乐段）。
    """
    cli = shutil.which("whisper-cli")
    if not cli:
        raise FileNotFoundError("未找到 whisper-cli（brew install whisper-cpp）")
    model = Path.home() / "models" / "ggml-large-v3-turbo-q5_0.bin"
    if not model.exists():
        raise FileNotFoundError(f"模型不存在: {model}")
    out_prefix = "/tmp/ab_whisper_cli"
    for f in Path("/tmp").glob("ab_whisper_cli*"):
        f.unlink(missing_ok=True)
    t0 = time.time()
    subprocess.run(
        [
            cli,
            "-m",
            str(model),
            "-f",
            audio,
            "-l",
            lang,
            "-ojf",
            "-of",
            out_prefix,
            "-np",
            "-mc",
            "0",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    data = json.loads(Path(out_prefix + ".json").read_text(encoding="utf-8"))
    words = parse_whisper_cli_json(data, lang)
    print(
        f"[whisper-cli] 完成：词级时间戳 {len(words)} 个，耗时 {time.time() - t0:.0f}s",
        flush=True,
    )
    return words


# ---------- 1c. whisper（Python CPU，fallback）----------


def transcribe_chunks_whisper(audio: str, lang: str, model_name: str) -> list[dict]:
    import whisper

    dur = float(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                audio,
            ]
        ).strip()
    )
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            audio,
            "-ar",
            "16000",
            "-ac",
            "1",
            AUDIO_TMP,
        ],
        check=True,
    )
    t0 = time.time()
    model = whisper.load_model(model_name)
    windows = []
    start = 0.0
    while start < dur - 1:
        windows.append((start, min(start + WINDOW, dur)))
        start += STEP
    all_words = []
    for wi, (ws, we) in enumerate(windows):
        seg = f"/tmp/ab_align_win_{wi:02d}.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-ss",
                f"{ws:.3f}",
                "-to",
                f"{we:.3f}",
                "-i",
                AUDIO_TMP,
                "-ar",
                "16000",
                "-ac",
                "1",
                seg,
            ],
            check=True,
        )
        r = model.transcribe(
            seg,
            language=lang,
            word_timestamps=True,
            fp16=False,
            verbose=False,
            no_speech_threshold=0.6,
            condition_on_previous_text=False,
        )
        for s in r["segments"]:
            for w in s.get("words") or []:
                txt = w["word"].strip()
                if txt:
                    all_words.append(
                        {"word": txt, "start": w["start"] + ws, "end": w["end"] + ws}
                    )
        Path(seg).unlink(missing_ok=True)
        print(
            f"  win {wi:02d} [{ws:.0f}-{we:.0f}] 累计 {len(all_words)} 词", flush=True
        )
    all_words.sort(key=lambda x: x["start"])
    dedup = []
    for w in all_words:
        if dedup and w["start"] < dedup[-1]["end"] - 0.15:
            continue
        dedup.append(w)
    print(
        f"[whisper] 完成：词级时间戳 {len(dedup)} 个，耗时 {time.time() - t0:.0f}s",
        flush=True,
    )
    Path(AUDIO_TMP).unlink(missing_ok=True)
    return dedup


# ---------- 2a. 静音切块 + 句子 → 语音块分配 ----------


def split_voice_blocks(
    wav: str, noise_db: int = -35, min_silence: float = 0.5, merge_gap: float = 1.0
) -> list[tuple[float, float]]:
    """silencedetect 切语音块：静音（≥min_silence）之间的连续语音区。

    块边界落在静音处 → forced aligner 从语音起点开始铺文本（避开段首静音错位）。
    """
    out = subprocess.run(
        [
            "ffmpeg",
            "-i",
            wav,
            "-af",
            f"silencedetect=noise={noise_db}dB:d={min_silence}",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", out)]
    ends = [float(m) for m in re.findall(r"silence_end: ([\d.]+)", out)]
    dur = float(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                wav,
            ]
        ).strip()
    )
    blocks: list[list[float]] = []
    cur = 0.0
    for i in range(min(len(starts), len(ends))):
        s, e = starts[i], ends[i]
        if s > cur:
            blocks.append([cur, s])
        cur = e
    if cur < dur - 0.3:
        blocks.append([cur, dur])
    # 合并碎块：块间静音 < merge_gap 且任一侧块 < 2s
    merged: list[list[float]] = []
    for b in blocks:
        if (
            merged
            and b[0] - merged[-1][1] < merge_gap
            and (b[1] - b[0] < 2.0 or merged[-1][1] - merged[-1][0] < 2.0)
        ):
            merged[-1][1] = b[1]
        else:
            merged.append(b)
    return [(b[0], b[1]) for b in merged]


def locate_sentences(sentences: list[str], asr_segs: list[dict], lang: str):
    """difflib 全文对齐 → 句子 → ASR 块（文本匹配，无时间估算）。

    返回 (assign, misses)：
      assign: {block_idx: [句子 index, ...]}
      misses: 完全没匹配上的句子
    """
    known_toks, known_owner = [], []
    for i, st in enumerate(sentences):
        ts = tokens(st, lang)
        known_toks.extend(ts)
        known_owner.extend([i] * len(ts))

    asr_toks, asr_owner = [], []
    for seg in asr_segs:
        ts = tokens(seg["text"], lang)
        asr_toks.extend(ts)
        asr_owner.extend([seg["bi"]] * len(ts))

    sm = difflib.SequenceMatcher(None, known_toks, asr_toks, autojunk=False)
    known_to_asr = {}
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for ki, aj in zip(range(i1, i2), range(j1, j2)):
                known_to_asr[ki] = aj

    assign: dict[int, list[int]] = {}
    misses: list[str] = []
    for i, st in enumerate(sentences):
        idxs = [k for k in range(len(known_toks)) if known_owner[k] == i]
        segs_hit = {asr_owner[known_to_asr[k]] for k in idxs if k in known_to_asr}
        if not segs_hit:
            misses.append(st)
            continue
        # 句子起点所在的 ASR 块为主块
        k0 = next(k for k in idxs if k in known_to_asr)
        assign.setdefault(asr_owner[known_to_asr[k0]], []).append(i)
    return assign, misses


def assign_to_blocks(
    est_map: dict[int, float], blocks: list[tuple[float, float]]
) -> dict[int, list[int]]:
    """（已弃用：omlx 流程用文本 difflib 分配，此函数保留仅供旧路径引用）"""
    assign: dict[int, list[int]] = {}
    for i, est in est_map.items():
        best, best_d = None, None
        for bi, (bs, be) in enumerate(blocks):
            if bs <= est <= be:
                best = bi
                break
            d = min(abs(est - bs), abs(est - be))
            if best_d is None or d < best_d:
                best, best_d = bi, d
        assign.setdefault(best, []).append(i)
    return assign


def forced_align_omlx(
    blocks: list[tuple[float, float]],
    assign: dict[int, list[int]],
    sentences: list[str],
    lang: str,
) -> list[dict]:
    """组装 worker 输入：每块已知文本 = 块内句子拼接 → omlx python 跑 forced aligner。

    块边界在静音处 → 文本从语音起点铺起，避开段首静音错位。
    """
    payload = {
        "audio_wav": AUDIO_TMP,
        "language": LANG_FULL[lang],
        "segments": [],
    }
    for bi, (bs, be) in enumerate(blocks):
        idxs = sorted(assign.get(bi, []))
        if not idxs:
            continue
        text = " ".join(sentences[i] for i in idxs)
        payload["segments"].append({"start": bs, "end": be, "text": text})

    in_f = "/tmp/ab_worker_in.json"
    out_f = "/tmp/ab_worker_out.json"
    Path(in_f).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    ompx_py = "/Applications/oMLX.app/Contents/Resources/Python/framework-mlx-base/bin/python_"
    sp = "/Applications/oMLX.app/Contents/Resources/Python/framework-mlx-base/lib/python3.11/site-packages"
    env = dict(os.environ, PYTHONPATH=sp)
    subprocess.run(
        [ompx_py, str(WORKER), "--input", in_f, "--output", out_f], check=True, env=env
    )
    words = json.loads(Path(out_f).read_text(encoding="utf-8"))["words"]
    Path(in_f).unlink(missing_ok=True)
    Path(out_f).unlink(missing_ok=True)
    Path(AUDIO_TMP).unlink(missing_ok=True)
    return words


# ---------- 2b. 句子全文 vs 词流 全文对齐（共用） ----------


def align_sentences(sentences: list[str], words: list[dict], lang: str):
    """词流（whisper 或 forced aligner 产物）→ 每句时间 = 句内 token 对应的词时间范围。"""
    full_toks: list[str] = []
    owner: list[int] = []
    for i, st in enumerate(sentences):
        ts = tokens(st, lang)
        full_toks.extend(ts)
        owner.extend([i] * len(ts))
    if not full_toks:
        sys.exit("句子文本为空（tokenize 后无内容）")

    w_toks: list[str] = []
    w_span: list[tuple[float, float]] = []
    for w in words:
        ts = tokens(w["word"], lang)
        if not ts:
            continue
        w_toks.extend(ts)
        for _ in ts:
            w_span.append((w["start"], w["end"]))

    sm = difflib.SequenceMatcher(None, full_toks, w_toks, autojunk=False)
    known_to_w = {}
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for ki, wj in zip(range(i1, i2), range(j1, j2)):
                known_to_w[ki] = wj

    results, misses = [], []
    for i, st in enumerate(sentences):
        idxs = [k for k in range(len(full_toks)) if owner[k] == i]
        ws_idx = [known_to_w[k] for k in idxs if k in known_to_w]
        if not ws_idx:
            misses.append(st)
            continue
        starts = [w_span[j][0] for j in ws_idx]
        ends = [w_span[j][1] for j in ws_idx]
        results.append({"index": i, "text": st, "s": min(starts), "e": max(ends)})
    return results, misses


# ---------- 3. 输入解析 + 输出 ----------


def split_voice_blocks_ensure(audio: str) -> list[tuple[float, float]]:
    """转 16k wav（供 ASR/worker 复用）并切语音块。"""
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            audio,
            "-ar",
            "16000",
            "-ac",
            "1",
            AUDIO_TMP,
        ],
        check=True,
    )
    return split_voice_blocks(AUDIO_TMP)


def load_sentences(path: str) -> list[str]:
    p = Path(path)
    raw = p.read_text(encoding="utf-8").strip()
    if not raw:
        sys.exit(f"句子文件为空：{path}")
    if p.suffix.lower() == ".json":
        data = json.loads(raw)
        if isinstance(data, list):
            out = []
            for x in data:
                if isinstance(x, str):
                    out.append(x)
                elif isinstance(x, dict) and "text" in x:
                    out.append(x["text"])
                elif isinstance(x, dict) and "t" in x:
                    out.append(x["t"])
            return [s for s in out if s.strip()]
        sys.exit("JSON 句子文件必须是 list[str] 或 list[{text}]")
    return [ln.strip() for ln in raw.splitlines() if ln.strip()]


def main():
    ap = argparse.ArgumentParser(
        description="有声书与文本对齐：EPUB 句子 + MP3 → sentences.json"
    )
    ap.add_argument("--audio", required=True, help="章节音频（mp3/m4a/flac/wav）")
    ap.add_argument(
        "--sentences", required=True, help="句子文件（每行一句 或 JSON list）"
    )
    ap.add_argument(
        "--lang", default="en", choices=["en", "ja", "zh"], help="语言（默认 en）"
    )
    ap.add_argument(
        "--out", default=None, help="输出路径（默认 <audio 同名>.sentences.json）"
    )
    ap.add_argument(
        "--engine",
        default="omlx",
        choices=["omlx", "whisper"],
        help="对齐引擎（默认 omlx）",
    )
    ap.add_argument(
        "--chunks", default=None, help="复用已有词级时间戳 json（跳过转写+对齐）"
    )
    ap.add_argument("--model", default="large-v3-turbo", help="whisper 引擎模型名")
    args = ap.parse_args()

    sentences = load_sentences(args.sentences)
    print(f"[0/3] 句子 {len(sentences)} 句（lang={args.lang}, engine={args.engine}）")

    if args.chunks:
        raw = json.loads(Path(args.chunks).read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            if "words" in raw:
                words = raw["words"]
            elif "transcription" in raw:
                words = parse_whisper_cli_json(raw, args.lang)
            else:
                words = raw.get("chunks", [])
        else:
            words = raw
        words = [w for w in words if isinstance(w, dict) and w.get("word")]
        print(f"[1/3] 复用词级时间戳 {len(words)} 个（{args.chunks}）")
    elif args.engine == "omlx":
        blocks = split_voice_blocks_ensure(args.audio)
        if len(blocks) <= 1 or max(b[1] - b[0] for b in blocks) > 120:
            # 歌曲等无静音场景：静音切块失效（BGM 持续），回退固定 30s 窗口
            dur = float(
                subprocess.check_output(
                    [
                        "ffprobe",
                        "-v",
                        "error",
                        "-show_entries",
                        "format=duration",
                        "-of",
                        "default=noprint_wrappers=1:nokey=1",
                        args.audio,
                    ]
                ).strip()
            )
            blocks = [
                (i * WINDOW, min((i + 1) * WINDOW, dur))
                for i in range(int(dur // WINDOW) + 1)
            ]
            print(f"[1/3] 无静音切块（歌曲场景），回退固定 {WINDOW:.0f}s 窗口")
        else:
            print(f"[1/3] 语音块 {len(blocks)} 个（静音切分）…")
        asr_segs = asr_chunks_omlx(args.audio, args.lang, blocks)
        print("[1/3] ASR 完成，difflib 分配句子到块…")
        assign, misses = locate_sentences(sentences, asr_segs, args.lang)
        if misses:
            print(f"  定位未匹配 {len(misses)} 句：{[m[:40] for m in misses[:6]]}")
        words = forced_align_omlx(blocks, assign, sentences, args.lang)
        print(f"[1/3] forced aligner 词级时间戳 {len(words)} 个")
    else:
        try:
            words = transcribe_whisper_cli(args.audio, args.lang)
        except (FileNotFoundError, subprocess.CalledProcessError) as exc:
            print(
                f"  whisper-cli 不可用（{exc}），回退 Python whisper CPU…", flush=True
            )
            words = transcribe_chunks_whisper(args.audio, args.lang, args.model)
        print(f"[1/3] whisper 词级时间戳 {len(words)} 个")

    results, misses = align_sentences(sentences, words, args.lang)
    if os.environ.get("AB_DUMP_WORDS"):
        Path(os.environ["AB_DUMP_WORDS"]).write_text(
            json.dumps(words, ensure_ascii=False), encoding="utf-8"
        )
        print(f"[dump] 词流已存 {os.environ['AB_DUMP_WORDS']}")
    print(f"[2/3] 对齐 {len(results)}/{len(sentences)} 句")
    if misses:
        print("  未对齐：")
        for m in misses[:10]:
            print(f"    - {m[:60]}")

    out = args.out or (str(Path(args.audio).with_suffix("")) + ".sentences.json")
    Path(out).write_text(
        json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"[3/3] 输出：{out}")

    if results:
        import statistics as st

        durs = [r["e"] - r["s"] for r in results]
        print(
            f"\n质量报告：句时长 median={st.median(durs):.2f}s mean={st.mean(durs):.2f}s "
            f"max={max(durs):.2f}s（异常长句可能是合并/标题播报区）"
        )


if __name__ == "__main__":
    main()
