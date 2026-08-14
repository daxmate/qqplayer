"""写标签 + 原子写 + 统一改名（mutagen）

- 支持格式：MP3（ID3v2）、M4A/MP4（MP4 tags + covr）、FLAC（VorbisComment + picture）；
  OGG/OPUS 只写文本标签（封面跳过）；其他格式抛 UnsupportedFormatError（路由转 400）
- 原子写：先 copy2 到同目录临时文件 → mutagen 改临时文件 → os.replace(tmp, 目标)，
  任何一步失败原文件保持完好
- 改名统一：{artist} - {title}.{ext}（artist 空 → {title}.{ext}；title 也空 → {artist}.{ext}；
  都空不改名）；目标已存在 → 加 (2)/(3) 序号，绝不覆盖
- cover_url 非空 → 下载写入内嵌封面；下载失败/非图片 → 忽略封面继续写文本标签（不报错）
- 引用迁移由调用方传入 migrate(old, new) 回调（backend.py 提供，避免循环依赖）
"""

import contextlib
import os
import re
import shutil
import uuid
from pathlib import Path

import httpx
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1, ID3NoHeaderError
from mutagen.mp4 import MP4, MP4Cover

TAG_WRITABLE_EXTS = {".mp3", ".m4a", ".mp4", ".flac", ".ogg", ".opus"}
# OGG/OPUS 只写文本标签，不支持封面
TEXT_ONLY_EXTS = {".ogg", ".opus"}

COVER_TIMEOUT = 10.0
DOWNLOAD_UA = "QQPlayer/1.0 (https://github.com/daxmate/qqplayer)"
_INVALID_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')


class UnsupportedFormatError(Exception):
    """文件格式不支持写标签"""


def _image_mime(data: bytes) -> str:
    if data[:4] == b"\x89PNG":
        return "image/png"
    return "image/jpeg"


def fetch_cover(cover_url: str | None) -> bytes | None:
    """下载封面；空 URL / 下载失败 / 非 jpeg/png → None（调用方忽略封面）"""
    if not cover_url:
        return None
    try:
        resp = httpx.get(
            cover_url,
            timeout=COVER_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": DOWNLOAD_UA},
        )
        resp.raise_for_status()
        data = resp.content
        if not data or (data[:3] != b"\xff\xd8\xff" and data[:4] != b"\x89PNG"):
            return None
        return data
    except Exception:
        return None


def target_filename(artist: str, title: str, ext: str) -> str | None:
    """统一改名规则（清洗后）；artist 和 title 都空 → None（不改名）"""
    artist = (artist or "").strip()
    title = (title or "").strip()
    if artist and title:
        base = f"{artist} - {title}"
    elif title:
        base = title
    elif artist:
        base = artist
    else:
        return None
    base = _INVALID_FILENAME_CHARS.sub("", base).strip()
    if not base:
        return None
    return f"{base}{ext}"


def _dedupe_target(dirpath: Path, new_name: str) -> Path:
    """目标已存在 → 加 (2)/(3) 序号，绝不覆盖"""
    stem, ext = os.path.splitext(new_name)
    candidate = dirpath / new_name
    n = 2
    while candidate.exists():
        candidate = dirpath / f"{stem} ({n}){ext}"
        n += 1
    return candidate


# ---- 各格式写标签 ----

def _write_mp3(f: Path, title: str, artist: str, album: str, cover: bytes | None):
    try:
        tags = ID3(str(f))
    except ID3NoHeaderError:
        tags = ID3()
    if title:
        tags.add(TIT2(encoding=3, text=title))
    if artist:
        tags.add(TPE1(encoding=3, text=artist))
    if album:
        tags.add(TALB(encoding=3, text=album))
    if cover is not None:
        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime=_image_mime(cover), type=3, desc="Cover", data=cover))
    tags.save(str(f), v2_version=3)


def _write_mp4(f: Path, title: str, artist: str, album: str, cover: bytes | None):
    audio = MP4(str(f))
    if title:
        audio["\xa9nam"] = [title]
    if artist:
        audio["\xa9ART"] = [artist]
    if album:
        audio["\xa9alb"] = [album]
    if cover is not None:
        imageformat = (
            MP4Cover.FORMAT_JPEG if _image_mime(cover) == "image/jpeg" else MP4Cover.FORMAT_PNG
        )
        audio["covr"] = [MP4Cover(cover, imageformat=imageformat)]
    audio.save()


def _write_flac(f: Path, title: str, artist: str, album: str, cover: bytes | None):
    audio = FLAC(str(f))
    if title:
        audio["title"] = [title]
    if artist:
        audio["artist"] = [artist]
    if album:
        audio["album"] = [album]
    if cover is not None:
        audio.clear_pictures()
        pic = Picture()
        pic.type = 3
        pic.mime = _image_mime(cover)
        pic.desc = "cover"
        pic.data = cover
        audio.add_picture(pic)
    audio.save()


def _write_ogg(f: Path, title: str, artist: str, album: str, ext: str = ""):
    from mutagen.oggopus import OggOpus
    from mutagen.oggvorbis import OggVorbis

    audio = OggVorbis(str(f)) if (ext or f.suffix).lower() == ".ogg" else OggOpus(str(f))
    if title:
        audio["title"] = [title]
    if artist:
        audio["artist"] = [artist]
    if album:
        audio["album"] = [album]
    audio.save()


def _write_tags(f: Path, title: str, artist: str, album: str, cover: bytes | None, ext: str = ""):
    """按扩展名分发写标签；cover 为 None 表示不碰封面"""
    ext = (ext or f.suffix).lower()
    if ext == ".mp3":
        _write_mp3(f, title, artist, album, cover)
    elif ext in (".m4a", ".mp4"):
        _write_mp4(f, title, artist, album, cover)
    elif ext == ".flac":
        _write_flac(f, title, artist, album, cover)
    else:  # .ogg / .opus：只写文本标签，封面跳过
        _write_ogg(f, title, artist, album, ext)


def save_tags(
    path: Path,
    *,
    title: str = "",
    artist: str = "",
    album: str = "",
    cover_url: str | None = None,
    migrate=None,
) -> dict:
    """写标签（原子写）+ 统一改名 + 引用迁移回调。

    返回 {"path", "name", "artist", "album", "renamed", "newPath"}。
    格式不支持抛 UnsupportedFormatError；写失败抛原异常（路由转 409）。
    migrate: Callable[[old_path, new_path], None]，改名成功后调用（引用迁移）。
    """
    f = Path(path)
    ext = f.suffix.lower()
    if ext not in TAG_WRITABLE_EXTS:
        raise UnsupportedFormatError(f"该格式不支持写标签: {ext or '无扩展名'}")

    target = f
    new_name = target_filename(artist, title, ext)
    if new_name:
        candidate = f.parent / new_name
        if candidate.name != f.name:
            target = _dedupe_target(f.parent, new_name)

    cover = fetch_cover(cover_url)  # 空/下载失败 → None：忽略封面，继续写文本标签

    tmp = f.parent / f".{f.stem}.tagtmp-{uuid.uuid4().hex[:8]}"
    try:
        shutil.copy2(f, tmp)
        _write_tags(tmp, title, artist, album, cover, ext)
        # 原子落位：target == 原路径 → 原地替换；target 为新名 → 原子改名（目标已去重必不存在）
        os.replace(tmp, target)
        if target != f:
            f.unlink()  # 改名完成，移除旧路径
    except Exception:
        # 任何一步失败原文件保持完好；清理临时文件后抛给路由（409）
        tmp.unlink(missing_ok=True)
        raise

    renamed = str(target) != str(f)
    if renamed and migrate is not None:
        with contextlib.suppress(Exception):  # 引用迁移失败不影响写标签结果
            migrate(str(f), str(target))
    return {
        "path": str(target),
        "name": title.strip() or target.stem,
        "artist": (artist or "").strip(),
        "album": (album or "").strip(),
        "renamed": renamed,
        "newPath": str(target),
    }
