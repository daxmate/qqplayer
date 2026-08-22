"""标签服务：mutagen 元数据提取 + 改名后 SQLite 路径引用迁移。"""

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


def extract_tags(f):
    """提取音频文件的标题/歌手/专辑（ID3 / MP4 / FLAC / OGG 元数据）"""
    if MutagenFile is None:
        return None, None, None
    try:
        audio = MutagenFile(str(f))
        if audio is None:
            return None, None, None
        tags = getattr(audio, "tags", None)
        title = artist = album = None
        if tags is not None:
            for key in tags:
                # ID3/MP4 是 dict 风格（key 为 str）；FLAC/OGG 的 VComment 迭代出 (key, value) 元组
                name = key if isinstance(key, str) else key[0]
                k = str(name).lower()
                value = tags[key] if isinstance(key, str) else tags[name]
                if k in ("tpe1", "©art", "aart", "artist") and artist is None:
                    artist = _tag_value_str(value) or None
                elif k in ("tit2", "©nam", "title") and title is None:
                    title = _tag_value_str(value) or None
                elif k in ("talb", "©alb", "album") and album is None:
                    album = _tag_value_str(value) or None
        return artist, title, album
    except Exception:
        return None, None, None


def _migrate_path_refs(old: str, new: str):
    """改名后迁移数据里的旧路径引用：favorites / playlists(songPaths) / playback(path)

    SQLite 版：三个 DAO 各自先查命中再写（等价原「只在实际命中旧路径时才写文件」）。
    """
    db.favorites_replace_path(old, new)
    db.playlists_replace_path(old, new)
    db.playback_replace_path(old, new)
