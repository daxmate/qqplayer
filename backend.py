#!/usr/bin/env python3
"""
music-player 后端 API
- 扫描本地歌曲库文件夹（mp3/flac/m4a/wav/ogg）
- 提取内嵌专辑封面（mutagen）
- 音频流播放（支持 Range 请求）
- 加载同名 .srt/.lrc 歌词
用法: ./venv/bin/python backend.py [歌曲库路径]
"""

import re
import sys
import threading
import webbrowser
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

try:
    from mutagen import File as MutagenFile
    from mutagen.mp4 import MP4, MP4Cover
except ImportError:
    MutagenFile = None

ROOT = Path(__file__).resolve().parent
DEFAULT_LIBRARY = ROOT / "songs"
DEFAULT_PORT = 8765

app = FastAPI(title="music-player")

# 运行时歌曲库路径（可通过命令行参数修改）
LIBRARY = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_LIBRARY

AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".wav", ".ogg", ".aac", ".opus"}
LYRIC_EXTS = {".srt", ".lrc"}


# ============ 歌曲库扫描 ============
def scan_library():
    """扫描歌曲库，返回歌曲列表（含封面/歌词路径）"""
    songs = []
    if not LIBRARY.is_dir():
        return songs
    for f in sorted(LIBRARY.rglob("*")):
        if not f.is_file():
            continue
        if f.suffix.lower() not in AUDIO_EXTS:
            continue
        # 找歌词（优先同名 srt/lrc，其次文件夹内唯一歌词文件）
        lyric = None
        for lext in (".srt", ".lrc"):
            cand = f.with_suffix(lext)
            if cand.exists():
                lyric = cand.name
                break
        if lyric is None:
            siblings = [x for x in f.parent.iterdir() if x.suffix.lower() in LYRIC_EXTS]
            if len(siblings) == 1:
                lyric = siblings[0].name
        # 找封面图片（cover.jpg / folder.jpg / 同名.jpg，其次文件夹内唯一图片）
        cover = None
        for cname in ("cover.jpg", "cover.png", "folder.jpg", "front.jpg"):
            cand = f.parent / cname
            if cand.exists():
                cover = cand.name
                break
        if cover is None:
            imgs = [
                x
                for x in f.parent.iterdir()
                if x.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
            ]
            if len(imgs) == 1:
                cover = imgs[0].name
        # id 用相对歌曲库的路径（歌曲库可能在 backend 目录之外，不能 relative_to(ROOT)）
        try:
            rel = f.relative_to(LIBRARY)
        except ValueError:
            rel = Path(f.name)
        # 提取 ID3 元数据（歌手/标题），没有就用文件名
        artist, title = extract_tags(f)
        songs.append(
            {
                "id": str(rel),
                "path": str(f),
                "name": title or f.stem,
                "artist": artist or (f.parent.name if f.parent != LIBRARY else ""),
                "folder": str(f.parent),
                "ext": f.suffix.lower().lstrip("."),
                "lyric": lyric,
                "cover": cover,
                "has_lyric": lyric is not None,
            }
        )
    return songs


@app.get("/api/songs")
def api_songs():
    return scan_library()


@app.get("/api/library")
def api_library():
    """返回当前歌曲库路径"""
    return {"path": str(LIBRARY)}


@app.post("/api/library")
async def api_set_library(body: dict):
    """设置歌曲库文件夹"""
    global LIBRARY
    p = Path(body.get("path", ""))
    if not p.is_dir():
        raise HTTPException(400, f"目录不存在: {p}")
    LIBRARY = p
    return {"path": str(LIBRARY), "count": len(scan_library())}


def extract_tags(f: Path):
    """提取音频文件的标题/歌手（ID3 / MP4 元数据）"""
    if MutagenFile is None:
        return None, None
    try:
        audio = MutagenFile(str(f))
        if audio is None:
            return None, None
        tags = getattr(audio, "tags", None)
        title = artist = None
        if tags is not None:
            for key in tags:
                k = key.lower()
                if k in ("tpe1", "©art", "aart", "artist") and artist is None:
                    artist = str(tags[key]).split("\x00")[0].strip()
                elif k in ("tit2", "©nam", "title") and title is None:
                    title = str(tags[key]).split("\x00")[0].strip()
        return artist or None, title or None
    except Exception:
        return None, None


# ============ 封面 ============
@app.get("/api/cover")
def api_cover(path: str):
    """提取音频内嵌封面；无内嵌封面时返回文件夹 cover.jpg"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    # 1) 文件夹封面图片
    for cname in ("cover.jpg", "cover.png", "folder.jpg", "front.jpg"):
        cand = f.parent / cname
        if cand.exists():
            return FileResponse(cand)
    # 2) 内嵌封面
    if MutagenFile is not None:
        try:
            audio = MutagenFile(str(f))
            if audio is not None:
                # MP3: ID3 APIC
                tags = getattr(audio, "tags", None)
                if tags is not None:
                    for key in tags:
                        if key.startswith("APIC"):
                            apic = tags[key]
                            return Response(content=apic.data, media_type=apic.mime)
                # MP4: covr
                if isinstance(audio, MP4) and "covr" in audio:
                    cov = audio["covr"][0]
                    data = bytes(cov)
                    mime = (
                        "image/jpeg"
                        if isinstance(cov, MP4Cover) and cov.imageformat == MP4Cover.FORMAT_JPEG
                        else "image/png"
                    )
                    return Response(content=data, media_type=mime)
        except Exception:
            pass
    raise HTTPException(404, "无封面")


# ============ 歌词 ============
def parse_srt(text: str):
    """解析 srt -> 段落/句子混合列表
    块内以 # 开头的行作为段落标题（type: sec），时间行后的文本作为句子（type: line）
    句子文本支持 1~3 行：原文 / 罗马音 / 中文
    """
    blocks = re.split(r"\n\s*\n", text.replace("\r", ""))
    result = []
    for block in blocks:
        lines = [x.strip() for x in block.split("\n") if x.strip()]
        if not lines:
            continue
        # 分离块内标题行和内容行（即使标题和句子粘在同一块也能拆开）
        sec_lines = [x for x in lines if x.startswith("#") and "-->" not in x]
        content = [x for x in lines if not (x.startswith("#") and "-->" not in x)]
        for sl in sec_lines:
            result.append({"type": "sec", "name": sl.lstrip("#").strip()})
        if not content:
            continue
        time_idx = -1
        for i, ln in enumerate(content):
            if "-->" in ln:
                time_idx = i
                break
        if time_idx < 0:
            continue
        m = re.match(
            r"(\d{1,2}):(\d{2}):(\d{2})[,.]?(\d{0,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.]?(\d{0,3})",
            content[time_idx],
        )
        if not m:
            continue

        def sec(h, mm, s, ms):
            return int(h) * 3600 + int(mm) * 60 + int(s) + int(ms or 0) / 1000

        result.append(
            {
                "type": "line",
                "s": sec(m[1], m[2], m[3], m[4]),
                "e": sec(m[5], m[6], m[7], m[8]),
                "text": content[time_idx + 1 :],
            }
        )
    return result


def parse_lrc(text: str):
    """解析 lrc -> 句子列表（无段落，type 统一为 line）"""
    result = []
    pattern = re.compile(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]")
    items = []
    for line in text.replace("\r", "").split("\n"):
        matches = list(pattern.finditer(line))
        if not matches:
            continue
        lyric_text = line[matches[-1].end() :].strip()
        for m in matches:
            ms = m.group(3) or "0"
            ms = int(ms) * (10 ** (3 - len(ms)))
            t = int(m.group(1)) * 60 + int(m.group(2)) + ms / 1000
            items.append((t, lyric_text))
    items.sort(key=lambda x: x[0])
    for i, (t, txt) in enumerate(items):
        e = items[i + 1][0] if i + 1 < len(items) else t + 5
        result.append({"type": "line", "s": t, "e": e, "text": [txt]})
    return result


@app.get("/api/lyric")
def api_lyric(path: str):
    """加载歌曲歌词文件（同名 srt/lrc，或文件夹内唯一歌词），返回解析后的逐句数据"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    cand = None
    for lext in ("srt", "lrc"):
        c = f.with_suffix("." + lext)
        if c.exists():
            cand = c
            break
    if cand is None:
        # 文件夹内唯一歌词
        siblings = [x for x in f.parent.iterdir() if x.suffix.lower() in LYRIC_EXTS]
        if len(siblings) == 1:
            cand = siblings[0]
    if cand is None:
        raise HTTPException(404, "无歌词文件")
    text = cand.read_text(encoding="utf-8", errors="ignore")
    lext = cand.suffix.lower().lstrip(".")
    data = parse_srt(text) if lext == "srt" else parse_lrc(text)
    return {"format": lext, "lines": data}


# ============ 音频流（支持 Range） ============
@app.get("/api/audio")
def api_audio(path: str):
    """音频流播放（FileResponse 原生支持 Range/206）"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    return FileResponse(str(f), media_type="audio/mpeg")


# ============ 静态前端 ============
if (ROOT / "dist").is_dir():
    app.mount("/", StaticFiles(directory=str(ROOT / "dist"), html=True), name="frontend")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        LIBRARY = Path(sys.argv[1])
    url = f"http://localhost:{DEFAULT_PORT}"
    print(f"🎵 music-player 已启动: {url}")
    print(f"   歌曲库: {LIBRARY}")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=DEFAULT_PORT, log_level="warning")
