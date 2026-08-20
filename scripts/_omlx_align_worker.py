#!/usr/bin/env python3
"""
_omlx_align_worker.py — forced aligner 批量对齐 worker（由 align_audiobook.py 用 omlx python 调起）

输入 JSON（stdin 或 --input 文件）：
    {
      "audio_wav": "/tmp/ab_full.wav",          # 全量 16k wav（已转好）
      "segments": [
        {"start": 0.0, "end": 30.0, "text": "已知文本（该段应包含的句子）"},
        ...
      ],
      "language": "English"
    }

输出 JSON（stdout 或 --output 文件）：
    {"words": [{"word": "...", "start": <全局秒>, "end": <全局秒>}, ...]}

用法（omlx python）：
    /Applications/oMLX.app/Contents/Resources/Python/framework-mlx-base/bin/python_ \
        _omlx_align_worker.py --input /tmp/x.json --output /tmp/y.json
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

LANG_MAP = {
    "en": "English",
    "ja": "Japanese",
    "zh": "Chinese",
}


def cut_window(wav, start, end, out):
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            f"{start:.3f}",
            "-to",
            f"{end:.3f}",
            "-i",
            wav,
            "-ar",
            "16000",
            "-ac",
            "1",
            out,
        ],
        check=True,
    )


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    cfg = json.loads(Path(args.input).read_text(encoding="utf-8"))
    wav = cfg["audio_wav"]
    segments = cfg["segments"]
    lang = cfg.get("language", "English")

    print(f"加载 ForcedAligner 模型（{lang}）...", file=sys.stderr, flush=True)
    from mlx_audio.stt.utils import load_model

    model = load_model(
        os.path.expanduser("~/.omlx/mlx-community/Qwen3-ForcedAligner-0.6B-5bit")
    )

    all_words = []
    tmp = tempfile.mkdtemp(prefix="ab_align_")
    for i, seg in enumerate(segments):
        txt = " ".join(seg["text"].split())
        if not txt:
            continue
        seg_wav = os.path.join(tmp, f"seg_{i:02d}.wav")
        cut_window(wav, seg["start"], seg["end"], seg_wav)
        try:
            result = model.generate(seg_wav, text=txt, language=lang)
            items = list(result)
        except Exception as exc:  # noqa: BLE001 — 单段对齐失败跳过（工具需容忍）
            print(f"⚠️ 段 {i} 对齐失败: {exc}", file=sys.stderr, flush=True)
            continue
        n = len(items)
        print(
            f"  段 {i:02d} [{seg['start']:.0f}-{seg['end']:.0f}] {n} 词",
            file=sys.stderr,
            flush=True,
        )
        for it in items:
            w = it.text.strip()
            if not w:
                continue
            all_words.append(
                {
                    "word": w,
                    "start": round(it.start_time + seg["start"], 3),
                    "end": round(it.end_time + seg["start"], 3),
                }
            )
        os.unlink(seg_wav)

    all_words.sort(key=lambda x: x["start"])
    # 去重叠（窗口重叠区词保留最早）
    dedup = []
    for w in all_words:
        if dedup and w["start"] < dedup[-1]["end"] - 0.15:
            continue
        dedup.append(w)
    Path(args.output).write_text(
        json.dumps({"words": dedup}, ensure_ascii=False), encoding="utf-8"
    )
    print(f"完成：词级时间戳 {len(dedup)} 个", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
