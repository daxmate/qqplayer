"""写标签 + 原子写 + 统一改名（mutagen）

- 支持格式：MP3（ID3v2）、M4A/MP4（MP4 tags + covr）、FLAC（VorbisComment + picture）；
  OGG/OPUS 只写文本标签（封面跳过）；其他格式抛 UnsupportedFormatError（路由转 400）
- 原子写：先 copy2 到同目录临时文件 → mutagen 改临时文件 → os.replace(tmp, 目标)，
  任何一步失败原文件保持完好
- 改名规则：按重命名模板渲染（默认 {artist} - {title}；artist 空 → {title}.{ext}；
  title 也空 → {artist}.{ext}；都空不改名）。模板占位符 {artist}/{title}/{album}/{track}/{year}，
  值 None/空 → 渲染空串；模板含 '/' → 相对文件所在目录建子目录（mkdir parents）；
  目标已存在 → 加 (2)/(3) 序号，绝不覆盖
- 标签字段：title/artist/album/year(int|null)/genre(str)/track(int|null)/album_artist(str)，
  有值才写（None/空跳过）；ID3 写 TYER（v2.3，mutagen 存 v2.4 自动转 TDRC）/TCON/TRCK/TPE2，
  MP4 写 ©day/©gen/trkn/aART，FLAC/OGG 写 date/genre/tracknumber/albumartist
- cover_url 非空 → 下载写入内嵌封面；下载失败/非图片 → 忽略封面继续写文本标签（不报错）
- 引用迁移由调用方传入 migrate(old, new) 回调（backend.py 提供，避免循环依赖）；
  子目录移动场景同样生效（SQLite 按路径字符串替换）
"""

import contextlib
import os
import re
import shutil
import uuid
from pathlib import Path

import httpx
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TALB, TCON, TIT2, TPE1, TPE2, TRCK, TYER, ID3NoHeaderError
from mutagen.mp4 import MP4, MP4Cover

TAG_WRITABLE_EXTS = {".mp3", ".m4a", ".mp4", ".flac", ".ogg", ".opus"}
# OGG/OPUS 只写文本标签，不支持封面
TEXT_ONLY_EXTS = {".ogg", ".opus"}

COVER_TIMEOUT = 10.0
DOWNLOAD_UA = "QQPlayer/1.0 (https://github.com/daxmate/qqplayer)"
_INVALID_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')
# 模板清洗：保留 '/'（子目录分隔），其余非法文件名字符沿用原集合
_INVALID_FILENAME_CHARS_NO_SLASH = re.compile(r'[\\:*?"<>|]')

# 默认重命名模板（与历史行为一致：artist 空 → 只有 title，不留 ' - ' 分隔符）
DEFAULT_RENAME_TEMPLATE = "{artist} - {title}"


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


def _fmt_template_int(v) -> str:
    """模板里 track/year 数字渲染；None/非法 → 空串"""
    if v is None:
        return ""
    try:
        return str(int(v))
    except (TypeError, ValueError):
        return ""


def _render_rename_template(template: str, artist: str, title: str, album: str, track, year) -> str:
    """渲染重命名模板（占位符替换；未知占位符/非法语法回落默认模板）"""
    values = {
        "artist": (artist or "").strip(),
        "title": (title or "").strip(),
        "album": (album or "").strip(),
        "track": _fmt_template_int(track),
        "year": _fmt_template_int(year),
    }
    try:
        return template.format(**values)
    except (KeyError, IndexError, ValueError, AttributeError):
        return DEFAULT_RENAME_TEMPLATE.format(**values)


def target_filename(
    artist: str,
    title: str,
    ext: str,
    album: str = "",
    track: int | None = None,
    year: int | None = None,
    template: str | None = None,
) -> str | None:
    """按重命名模板渲染目标文件名（清洗后；模板含 '/' 时返回含子目录的相对路径）。

    - template 缺省或为默认模板 → 旧版分支逻辑，保证默认 {artist} - {title}
      渲染结果与历史行为完全一致（回归测试）
    - 占位符 {artist}/{title}/{album}/{track}/{year}；值为 None/空 → 渲染空串
    - 清洗非法文件名字符（保留 '/' 作为目录分隔）；过滤空/./.. 路径段（防穿越）
    - 渲染结果为空（所有占位符都空）→ None（不改名）
    """
    ext = str(ext)
    if not template or template == DEFAULT_RENAME_TEMPLATE:
        # 默认模板：保留旧版分支（artist 空 → 只有 title，不留 ' - '），行为逐字节一致
        artist_s = (artist or "").strip()
        title_s = (title or "").strip()
        if artist_s and title_s:
            base = f"{artist_s} - {title_s}"
        elif title_s:
            base = title_s
        elif artist_s:
            base = artist_s
        else:
            return None
        base = _INVALID_FILENAME_CHARS.sub("", base).strip()
        if not base:
            return None
        return f"{base}{ext}"
    base = _render_rename_template(template, artist, title, album, track, year).strip()
    parts = [p.strip() for p in base.split("/")]
    parts = [_INVALID_FILENAME_CHARS_NO_SLASH.sub("", p).strip() for p in parts]
    parts = [p for p in parts if p and p not in (".", "..")]
    if not parts:
        return None
    # 空占位符残留的前后分隔符（- _ . 空白）一并清理；只剩分隔符 → 不改名
    joined = "/".join(parts).strip("-_. ")
    if not joined:
        return None
    return joined + ext


def _dedupe_target(dirpath: Path, new_name: str) -> Path:
    """目标已存在 → 加 (2)/(3) 序号，绝不覆盖（基于目标所在目录去重）"""
    stem, ext = os.path.splitext(new_name)
    candidate = dirpath / new_name
    n = 2
    while candidate.exists():
        candidate = dirpath / f"{stem} ({n}){ext}"
        n += 1
    return candidate


# ---- 各格式写标签 ----


def _write_mp3(
    f: Path,
    title: str,
    artist: str,
    album: str,
    cover: bytes | None,
    year: int | None = None,
    genre: str = "",
    track: int | None = None,
    album_artist: str = "",
):
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
    if year:
        tags.add(TYER(encoding=3, text=str(int(year))))
    if genre:
        tags.add(TCON(encoding=3, text=genre))
    if track:
        tags.add(TRCK(encoding=3, text=str(int(track))))
    if album_artist:
        tags.add(TPE2(encoding=3, text=album_artist))
    if cover is not None:
        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime=_image_mime(cover), type=3, desc="Cover", data=cover))
    tags.save(str(f), v2_version=3)


def _write_mp4(
    f: Path,
    title: str,
    artist: str,
    album: str,
    cover: bytes | None,
    year: int | None = None,
    genre: str = "",
    track: int | None = None,
    album_artist: str = "",
):
    audio = MP4(str(f))
    if title:
        audio["\xa9nam"] = [title]
    if artist:
        audio["\xa9ART"] = [artist]
    if album:
        audio["\xa9alb"] = [album]
    if year:
        audio["\xa9day"] = [str(int(year))]
    if genre:
        audio["\xa9gen"] = [genre]
    if track:
        audio["trkn"] = [(int(track), 0)]
    if album_artist:
        audio["aART"] = [album_artist]
    if cover is not None:
        imageformat = (
            MP4Cover.FORMAT_JPEG if _image_mime(cover) == "image/jpeg" else MP4Cover.FORMAT_PNG
        )
        audio["covr"] = [MP4Cover(cover, imageformat=imageformat)]
    audio.save()


def _write_flac(
    f: Path,
    title: str,
    artist: str,
    album: str,
    cover: bytes | None,
    year: int | None = None,
    genre: str = "",
    track: int | None = None,
    album_artist: str = "",
):
    audio = FLAC(str(f))
    if title:
        audio["title"] = [title]
    if artist:
        audio["artist"] = [artist]
    if album:
        audio["album"] = [album]
    if year:
        audio["date"] = [str(int(year))]
    if genre:
        audio["genre"] = [genre]
    if track:
        audio["tracknumber"] = [str(int(track))]
    if album_artist:
        audio["albumartist"] = [album_artist]
    if cover is not None:
        audio.clear_pictures()
        pic = Picture()
        pic.type = 3
        pic.mime = _image_mime(cover)
        pic.desc = "cover"
        pic.data = cover
        audio.add_picture(pic)
    audio.save()


def _write_ogg(
    f: Path,
    title: str,
    artist: str,
    album: str,
    ext: str = "",
    year: int | None = None,
    genre: str = "",
    track: int | None = None,
    album_artist: str = "",
):
    from mutagen.oggopus import OggOpus
    from mutagen.oggvorbis import OggVorbis

    audio = OggVorbis(str(f)) if (ext or f.suffix).lower() == ".ogg" else OggOpus(str(f))
    if title:
        audio["title"] = [title]
    if artist:
        audio["artist"] = [artist]
    if album:
        audio["album"] = [album]
    if year:
        audio["date"] = [str(int(year))]
    if genre:
        audio["genre"] = [genre]
    if track:
        audio["tracknumber"] = [str(int(track))]
    if album_artist:
        audio["albumartist"] = [album_artist]
    audio.save()


def _write_tags(
    f: Path,
    title: str,
    artist: str,
    album: str,
    cover: bytes | None,
    ext: str = "",
    year: int | None = None,
    genre: str = "",
    track: int | None = None,
    album_artist: str = "",
):
    """按扩展名分发写标签；cover 为 None 表示不碰封面"""
    ext = (ext or f.suffix).lower()
    if ext == ".mp3":
        _write_mp3(f, title, artist, album, cover, year, genre, track, album_artist)
    elif ext in (".m4a", ".mp4"):
        _write_mp4(f, title, artist, album, cover, year, genre, track, album_artist)
    elif ext == ".flac":
        _write_flac(f, title, artist, album, cover, year, genre, track, album_artist)
    else:  # .ogg / .opus：只写文本标签，封面跳过
        _write_ogg(f, title, artist, album, ext, year, genre, track, album_artist)


def save_tags(
    path: Path,
    *,
    title: str = "",
    artist: str = "",
    album: str = "",
    cover_url: str | None = None,
    year: int | None = None,
    genre: str = "",
    track: int | None = None,
    album_artist: str = "",
    rename_template: str | None = None,
    migrate=None,
) -> dict:
    """写标签（原子写）+ 按模板改名 + 引用迁移回调。

    返回 {"path", "name", "artist", "album", "renamed", "newPath"}。
    格式不支持抛 UnsupportedFormatError；写失败抛原异常（路由转 409）。
    year(int|null)/track(int|null)/genre(str)/album_artist(str) 有值才写（None/空跳过）；
    rename_template 缺省 → 默认模板 {artist} - {title}（历史行为不变）；
    模板含 '/' → 相对文件所在目录建子目录（mkdir parents）；
    migrate: Callable[[old_path, new_path], None]，改名成功后调用（引用迁移，子目录移动同样生效）。
    """
    f = Path(path)
    ext = f.suffix.lower()
    if ext not in TAG_WRITABLE_EXTS:
        raise UnsupportedFormatError(f"该格式不支持写标签: {ext or '无扩展名'}")

    target = f
    new_name = target_filename(
        artist, title, ext, album=album, track=track, year=year, template=rename_template
    )
    if new_name:
        new_path = f.parent / new_name  # new_name 可含子目录
        if new_path != f:
            target = _dedupe_target(new_path.parent, new_path.name)

    cover = fetch_cover(cover_url)  # 空/下载失败 → None：忽略封面，继续写文本标签

    tmp = f.parent / f".{f.stem}.tagtmp-{uuid.uuid4().hex[:8]}"
    try:
        shutil.copy2(f, tmp)
        _write_tags(
            tmp,
            title,
            artist,
            album,
            cover,
            ext,
            year=year,
            genre=genre,
            track=track,
            album_artist=album_artist,
        )
        if target != f:
            target.parent.mkdir(parents=True, exist_ok=True)  # 模板子目录
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
