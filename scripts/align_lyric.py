#!/usr/bin/env python3
"""
align_lyric.py — 用 whisper 词级时间戳对齐 QQPlayer 缓存歌词的时间戳

核心思路：歌词内容完全用现成的（缓存里已有网易云拉的原文 lrc + 翻译 tlyric），
一个字不改；whisper 只用来重新计算每行歌词的实际演唱时间（对齐到本地音频）。

为什么分段转录：整首一次转录开头会幻觉（把长前奏识别成"作詞・作曲・編曲 初音ミク"
之类）且漏掉前几句歌词；截取片段单独转录则正确。窗口大小（默认 30s+3s 重叠）
不是关键，关键是不能一次转整首。

用法（用 openai-whisper 的 venv python 跑，因为依赖 whisper + pykakasi）：
    /opt/homebrew/Cellar/openai-whisper/<ver>/libexec/bin/python3 \\
        align_lyric.py --audio "<mp3 路径>" [--cache "<缓存 json 路径>"] [--write]

参数：
    --audio   音频文件路径（必填）
    --cache   歌词缓存 json（默认按 sha1(title|artist) 从 ~/.cache/qqplayer/lyric/ 找）
    --write   对齐结果写回缓存文件（默认只输出到 /tmp 并打印对比）
    --chunks  复用已有的词级时间戳 json（跳过 whisper 转录）
    --model   whisper 模型名（默认 large-v3-turbo，来自 ~/.cache/whisper/）

输出：
    /tmp/lyric_align_<hash>.json  → {lrc, tlyric, source, fetched_at}（--write 时写回）
    /tmp/lyric_align_<hash>.lrc   → 纯 LRC 文本（方便预览/拷到别处）
"""
import argparse
import difflib
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

import pykakasi

AUDIO_TMP = "/tmp/lyric_align_audio.wav"
CHUNK_TMP = "/tmp/lyric_align_chunks.json"
OUT_TMP = "/tmp/lyric_align_{hash}.json"
OUT_LRC = "/tmp/lyric_align_{hash}.lrc"

CACHE_DIR = Path.home() / ".cache" / "qqplayer" / "lyric"
WINDOW = 30.0
OVERLAP = 3.0
STEP = WINDOW - OVERLAP

kks = pykakasi.Kakasi()


# ---------- 工具 ----------

def to_hira(s: str) -> str:
    """汉字/片假名 → 平假名，去标点空白，用于匹配"""
    s = unicodedata.normalize("NFKC", s).lower()
    parts = [item["hira"] for item in kks.convert(s)]
    out = "".join(parts)
    out = re.sub(r"[・、。！？!?.,，…\-\s\u3000]", "", out)
    return out


def cache_key(title: str, artist: str) -> str:
    return hashlib.sha1(f"{title}|{artist}".encode()).hexdigest()[:16]


def extract_tags(path: str):
    """读音频 ID3 标题/歌手；失败用文件名"""
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format_tags=title,artist",
             "-of", "default=noprint_wrappers=1", path], text=True)
        title = artist = ""
        for ln in out.splitlines():
            if ln.startswith("TAG:title="):
                title = ln.split("=", 1)[1]
            elif ln.startswith("TAG:artist="):
                artist = ln.split("=", 1)[1]
        if title:
            return title, artist
    except Exception:
        pass
    stem = Path(path).stem
    # 文件名 "歌手 - 标题" 形式
    m = re.match(r"^(.*?)\s*-\s*(.+)$", stem)
    if m:
        return m.group(2).strip(), m.group(1).strip()
    return stem, ""


def parse_lrc_lines(lrc_text: str):
    """解析 LRC → (歌词行列表, 元数据行列表)，行含 (idx, time, text, hira)"""
    lines, meta = [], []
    for ln in lrc_text.replace("\r", "").splitlines():
        m = re.match(r"\[(\d+):(\d+\.?\d*)\]\s*(.*)", ln)
        if not m:
            continue
        t = int(m.group(1)) * 60 + float(m.group(2))
        text = m.group(3).strip()
        if not text:
            continue
        if any(k in text for k in ("作词", "作曲", "编曲", "作詞")):
            meta.append((t, text))
            continue
        lines.append((len(lines), t, text, to_hira(text)))
    return lines, meta


def parse_tlyric_lines(tlyric_text: str):
    """解析翻译 LRC → (翻译行列表, 头部注释行如 [by:xxx])"""
    lines, heads = [], []
    for ln in tlyric_text.replace("\r", "").splitlines():
        m = re.match(r"\[(\d+):(\d+\.?\d*)\]\s*(.*)", ln)
        if not m:
            if ln.strip():
                heads.append(ln.strip())
            continue
        t = int(m.group(1)) * 60 + float(m.group(2))
        text = m.group(3).strip()
        if text:
            lines.append((t, text))
    return lines, heads


# ---------- 1. whisper 分段转录 ----------

def transcribe_chunks(audio: str, model_name: str):
    """分段转录：转 wav 后切窗口逐段识别，返回词级时间戳列表。

    不能整首一次转：实测整首转录开头会幻觉（长前奏被识别成"作詞・作曲・編曲
    初音ミク"）且漏掉前几句歌词；窗口大小（默认 30s+3s 重叠）只是实现选择。
    """
    import whisper

    dur = float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", audio]).strip())
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", audio,
                    "-ar", "16000", "-ac", "1", AUDIO_TMP], check=True)

    t0 = time.time()
    model = whisper.load_model(model_name)
    print(f"[1/3] whisper {model_name} 加载 {time.time()-t0:.0f}s，时长 {dur:.0f}s，分段转录中…",
          flush=True)

    windows = []
    start = 0.0
    while start < dur - 1:
        windows.append((start, min(start + WINDOW, dur)))
        start += STEP

    all_words = []
    for wi, (ws, we) in enumerate(windows):
        seg = f"/tmp/lyric_align_win_{wi:02d}.wav"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{ws:.3f}",
                        "-to", f"{we:.3f}", "-i", AUDIO_TMP,
                        "-ar", "16000", "-ac", "1", seg], check=True)
        r = model.transcribe(seg, language="ja", word_timestamps=True,
                             fp16=False, verbose=False,
                             no_speech_threshold=0.6,
                             condition_on_previous_text=False)
        for s in r["segments"]:
            for w in (s.get("words") or []):
                all_words.append({"word": w["word"].strip(),
                                  "start": w["start"] + ws,
                                  "end": w["end"] + ws})
        Path(seg).unlink(missing_ok=True)
        print(f"  win {wi:02d} [{ws:.0f}-{we:.0f}] words+{len(all_words)}", flush=True)

    all_words.sort(key=lambda x: x["start"])
    # 去重叠：保留时间最早的词
    dedup = []
    for w in all_words:
        if dedup and w["start"] < dedup[-1]["end"] - 0.15:
            continue
        dedup.append(w)
    print(f"[1/3] 完成，词级时间戳 {len(dedup)} 个，耗时 {time.time()-t0:.0f}s", flush=True)
    Path(AUDIO_TMP).unlink(missing_ok=True)
    return dedup


# ---------- 2. 全文序列对齐 ----------

def align_lrc(lines, words):
    """LRC 全文 vs whisper 词流全文，SequenceMatcher 对齐，返回每行 (start,end)"""
    lrc_text = "".join(l[3] for l in lines)
    ranges = []
    cs = 0
    for idx, t, text, h in lines:
        ranges.append((cs, cs + len(h)))
        cs += len(h)

    wstream, wtime = "", []
    for w in words:
        h = to_hira(w["word"])
        if not h or h in ("ー",):
            continue
        for _ in h:
            wtime.append((w["start"], w["end"]))
        wstream += h

    sm = difflib.SequenceMatcher(None, lrc_text, wstream, autojunk=False)
    lrc_to_w = {}
    for li, wi, size in sm.get_matching_blocks():
        for k in range(size):
            lrc_to_w[li + k] = wi + k

    results, misses = [], []
    for idx, t, text, h in lines:
        c0, c1 = ranges[idx]
        times = [wtime[lrc_to_w[c]] for c in range(c0, c1) if c in lrc_to_w]
        if not times:
            misses.append(text)
            continue
        results.append({"idx": idx, "text": text,
                        "start": min(x[0] for x in times),
                        "end": max(x[1] for x in times), "old": t})
    return results, misses


# ---------- 3. 输出 ----------

def fmt(t: float) -> str:
    m = int(t // 60)
    s = t - m * 60
    return f"[{m:02d}:{s:05.2f}]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--cache", default=None, help="歌词缓存 json；缺省按 title|artist 自动找")
    ap.add_argument("--write", action="store_true", help="写回缓存文件")
    ap.add_argument("--chunks", default=None,
                    help="复用已有的词级时间戳 json（跳过 whisper 转录）")
    ap.add_argument("--model", default="large-v3-turbo")
    args = ap.parse_args()

    # 找缓存文件
    title, artist = extract_tags(args.audio)
    if args.cache:
        cache_f = Path(args.cache)
    else:
        cache_f = CACHE_DIR / f"{cache_key(title, artist)}.json"
        print(f"缓存文件：{cache_f}（title={title!r}, artist={artist!r}）")
    if not cache_f.exists():
        sys.exit(f"找不到缓存歌词：{cache_f}")
    orig = json.loads(cache_f.read_text(encoding="utf-8"))
    lrc_text = orig.get("lrc", "")
    tlyric_text = orig.get("tlyric")
    if not lrc_text:
        sys.exit("缓存里没有 lrc 字段")

    lines, meta = parse_lrc_lines(lrc_text)
    print(f"[0/3] 歌词 {len(lines)} 行，元数据 {len(meta)} 行")

    if args.chunks:
        words = json.loads(Path(args.chunks).read_text(encoding="utf-8"))
        if isinstance(words, dict):
            words = words["words"]
        words = [w for w in words if w.get("word")]
        dedup = []
        for w in words:
            if dedup and w["start"] < dedup[-1]["end"] - 0.15:
                continue
            dedup.append(w)
        words = dedup
        print(f"[1/3] 复用词级时间戳 {len(words)} 个（{args.chunks}）")
    else:
        words = transcribe_chunks(args.audio, args.model)
    results, misses = align_lrc(lines, words)
    print(f"[2/3] 对齐 {len(results)}/{len(lines)}")
    if misses:
        print("  未对齐：", misses)

    # 生成新 LRC
    new_lines = [f"{fmt(t)}{text}" for t, text in meta]
    for r in sorted(results, key=lambda x: x["idx"]):
        new_lines.append(f"{fmt(r['start'])}{r['text']}")
    new_lrc = "\n".join(new_lines)

    # 翻译同步对齐：翻译行数与歌词行数一致时按序替换时间戳
    new_tlyric = None
    if tlyric_text:
        tlines, heads = parse_tlyric_lines(tlyric_text)
        song_lines = sorted(results, key=lambda x: x["idx"])
        if len(tlines) == len(song_lines):
            new_tlyric = "\n".join(heads + [
                f"{fmt(song_lines[i]['start'])}{tlines[i][1]}"
                for i in range(len(tlines))])
            print(f"[3/3] 翻译 {len(tlines)} 行已同步对齐")
        else:
            print(f"[3/3] 跳过翻译（行数 {len(tlines)} != 歌词 {len(song_lines)}）")

    # 输出
    h = cache_f.stem
    out_json = Path(OUT_TMP.format(hash=h))
    payload = {"lrc": new_lrc, "tlyric": new_tlyric,
               "source": orig.get("source", "local"),
               "fetched_at": int(time.time())}
    out_json.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    Path(OUT_LRC.format(hash=h)).write_text(new_lrc, encoding="utf-8")
    print(f"\n输出：{out_json}")

    if args.write:
        shutil.copy(cache_f, str(cache_f) + ".bak")
        cache_f.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        print(f"已写回：{cache_f}（原文件备份 .bak）")

    print("\n---- 旧 -> 新 ----")
    for r in sorted(results, key=lambda x: x["idx"]):
        print(f"old {fmt(r['old'])} -> new {fmt(r['start'])}  {r['text'][:26]}")


if __name__ == "__main__":
    main()
