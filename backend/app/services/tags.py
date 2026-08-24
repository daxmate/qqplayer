"""标签服务：mutagen 元数据提取 + 改名后 SQLite 路径引用迁移。"""

import re

from app import db

try:
    from mutagen import File as MutagenFile
except ImportError:
    MutagenFile = None


def _tag_value_str(value) -> str:
    """mutagen 标签值 → 显示字符串：MP4/FLAC/OGG 是 list，ID3 是 TextFrame"""
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    return str(value).split("\x00")[0].strip()


def _parse_year(value) -> int | None:
    """从日期/年份字符串解析年份（前 4 位数字）；失败 → None"""
    m = re.search(r"\d{4}", str(value or ""))
    if not m:
        return None
    try:
        return int(m.group(0))
    except (ValueError, TypeError):
        return None


def _parse_track(value) -> int | None:
    """解析音轨号：ID3 "3/12" → 3；MP4 [(3, 12)] → 3；Vorbis "3" → 3；失败 → None"""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        first = value[0] if value else None
        if isinstance(first, (list, tuple)):
            first = first[0] if first else None
        value = first
    m = re.match(r"\s*(\d+)", str(value or ""))
    if not m:
        return None
    try:
        return int(m.group(1))
    except (ValueError, TypeError):
        return None


def extract_tags(f):
    """提取音频文件的标题/歌手/专辑/年份/流派/音轨/专辑歌手（ID3 / MP4 / FLAC / OGG 元数据）。

    返回 (artist, title, album, year, genre, track, album_artist)：
    - year(int|null)、track(int|null)：解析失败 → None
    - genre(str)、album_artist(str)：缺失 → ""
    任何解析异常都回退 None/""，绝不抛异常。
    """
    if MutagenFile is None:
        return None, None, None, None, "", None, ""
    try:
        audio = MutagenFile(str(f))
        if audio is None:
            return None, None, None, None, "", None, ""
        tags = getattr(audio, "tags", None)
        artist = title = album = None
        year = None
        genre = album_artist = ""
        track = None
        if tags is not None:
            for key in tags:
                # ID3/MP4 是 dict 风格（key 为 str）；FLAC/OGG 的 VComment 迭代出 (key, value) 元组
                name = key if isinstance(key, str) else key[0]
                k = str(name).lower()
                value = tags[key] if isinstance(key, str) else tags[name]
                if k in ("tpe1", "©art", "artist") and artist is None:
                    artist = _tag_value_str(value) or None
                elif k in ("tit2", "©nam", "title") and title is None:
                    title = _tag_value_str(value) or None
                elif k in ("talb", "©alb", "album") and album is None:
                    album = _tag_value_str(value) or None
                elif k in ("tyer", "tdrc", "©day", "date", "year") and year is None:
                    year = _parse_year(_tag_value_str(value))
                elif k in ("tcon", "©gen", "genre") and not genre:
                    genre = _tag_value_str(value)
                elif k in ("trck", "trkn", "tracknumber") and track is None:
                    track = _parse_track(value)
                elif k in ("tpe2", "aart", "albumartist") and not album_artist:
                    album_artist = _tag_value_str(value)
        return artist, title, album, year, genre, track, album_artist
    except Exception:
        return None, None, None, None, "", None, ""


def _migrate_path_refs(old: str, new: str):
    """改名后迁移数据里的旧路径引用：favorites / playlists(songPaths) / playback(path)

    SQLite 版：三个 DAO 各自先查命中再写（等价原「只在实际命中旧路径时才写文件」）。
    """
    db.favorites_replace_path(old, new)
    db.playlists_replace_path(old, new)
    db.playback_replace_path(old, new)
