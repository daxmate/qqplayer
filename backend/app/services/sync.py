"""iOS companion 同步服务：manifest 全量清单构建 + ops 双向应用（last-write-wins）。

- build_manifest()：全量元数据清单（songs/playlists/favorites/books/dicts + 版本号）
- validate_ops() + apply_ops()：客户端 dirty 队列按实体应用，全部合法才应用
  （任一非法 → ValueError，router 转 400，整批不落盘）
- 增量拉取直接用 db.ops_list_since（append-only 游标），无需包装

LWW 约定：payload 内 ts（或实体自带 updatedAt）与现有行 ts 比较，大者胜；
无 ts 的桌面端旧数据视为 0（客户端任何带 ts 的写入都生效）。
新增文件自包含：不改 db.py / pairing.py / middleware.py / mdns.py ——
LWW 需要的行级 ts 比较用 db._session() 短连接直查现有表（保持 WAL / 写锁语义），
行级写入也走 db._write_lock + _session()（与 DAO 同一把锁，线程安全一致）。
"""

from __future__ import annotations

import contextlib
import hashlib
import threading
from datetime import datetime, timezone
from pathlib import Path

from app import db, state
from app.services import library_scan

try:
    from mutagen import File as MutagenFile
    from mutagen.mp4 import MP4
except ImportError:
    MutagenFile = None
    MP4 = None

# 合法实体（与 ops 表 entity 列对应；未知实体整批拒绝）
_ENTITIES = {"favorites", "playlists", "reading_progress", "playback_events"}

# manifest 中 dicts 下载用扩展名（DICTS_DIR 下按需下载的目标）
_DICT_EXTS = {".mdx", ".mdd"}

# 文件内容 SHA-256 增量缓存：path -> (mtime_ms, size, sha256)。
# mtime+size 未变 → 直接复用，避免每次 manifest 都重读文件内容（大库/大文件关键）。
_HASH_CACHE: dict[str, tuple[int, int, str]] = {}
_HASH_CACHE_LOCK = threading.Lock()

# 封面判定增量缓存：song path -> (audio_mtime_ms, audio_size, cover_info)。
# 内嵌封面判定要 mutagen 打开文件（贵）；audio mtime+size 未变 → 复用。
# 文件夹封面（file 来源）每轮 stat 现取（便宜、不读内容），封面文件自身变动即时可见。
_COVER_CACHE: dict[str, tuple[int, int, dict]] = {}
_COVER_CACHE_LOCK = threading.Lock()

# 文件夹封面候选名（对齐 /api/cover 判定顺序，取第一个存在者）
_COVER_NAMES = ("cover.jpg", "cover.png", "folder.jpg", "front.jpg")

# 无封面时的统一空值（cover_source 用字符串 "null"，前端判断与 file/embedded 一致）
_NO_COVER = {"cover_source": "null", "cover_path": None, "cover_size": 0, "cover_mtime": 0}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts_ms(value) -> float:
    """任意 ts 表示 → 可比对毫秒数（int=ms；ISO 字符串解析；空/无法解析=0）"""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return 0.0
        try:
            return float(s)  # 数字字符串（毫秒）
        except ValueError:
            pass
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
        except ValueError:
            return 0.0
    return 0.0


# ============ manifest ============
def _file_sha256(path: str, mtime: int, size: int) -> str:
    """文件内容 SHA-256（增量缓存）：mtime+size 与缓存一致 → 复用；否则 1MB 流式重算。

    读取失败（文件缺失/被删）→ ""，不写入缓存。锁只保护 dict 读写，哈希计算在锁外。
    """
    with _HASH_CACHE_LOCK:
        hit = _HASH_CACHE.get(path)
        if hit is not None and hit[0] == mtime and hit[1] == size:
            return hit[2]
    h = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
    except OSError:
        return ""
    digest = h.hexdigest()
    with _HASH_CACHE_LOCK:
        _HASH_CACHE[path] = (mtime, size, digest)
    return digest


def _embedded_cover_info(p: Path) -> dict:
    """mutagen 判定内嵌封面：MP3 ID3 有 APIC key / MP4 有 covr → embedded；否则 null。

    只查 key 存在性，不读图片数据。任何异常回退 null（与 /api/cover 容错一致）。
    """
    if MutagenFile is None:
        return dict(_NO_COVER)
    try:
        audio = MutagenFile(str(p))
        if audio is not None:
            tags = getattr(audio, "tags", None)
            if tags is not None:
                for key in tags:
                    if str(key).startswith("APIC"):
                        return {
                            "cover_source": "embedded",
                            "cover_path": None,
                            "cover_size": 0,
                            "cover_mtime": 0,
                        }
            if isinstance(audio, MP4) and "covr" in audio:
                return {
                    "cover_source": "embedded",
                    "cover_path": None,
                    "cover_size": 0,
                    "cover_mtime": 0,
                }
    except Exception:
        pass
    return dict(_NO_COVER)


def _cover_info(song_path: str, audio_mtime: int, audio_size: int) -> dict:
    """封面判定（对齐 /api/cover）：文件夹 cover.jpg/png/folder.jpg/front.jpg → file；
    否则内嵌 APIC/covr → embedded；都没有 → null。

    - 文件夹封面每轮 stat 现取（不读内容）：封面文件自身变动即时可见（失效检测目标）
    - 内嵌判定走增量缓存：audio mtime+size 未变 → 复用，避免 mutagen 重复打开文件
    """
    p = Path(song_path)
    for cname in _COVER_NAMES:
        cand = p.parent / cname
        try:
            st = cand.stat()
        except OSError:
            continue
        return {
            "cover_source": "file",
            "cover_path": cname,
            "cover_size": st.st_size,
            "cover_mtime": int(st.st_mtime * 1000),
        }
    with _COVER_CACHE_LOCK:
        hit = _COVER_CACHE.get(song_path)
        if hit is not None and hit[0] == audio_mtime and hit[1] == audio_size:
            return hit[2]
    info = _embedded_cover_info(p)
    with _COVER_CACHE_LOCK:
        _COVER_CACHE[song_path] = (audio_mtime, audio_size, info)
    return info


def _lyric_info(song: dict) -> tuple[str | None, int]:
    """歌词信息：复用曲库扫描的 lyric 发现逻辑（同名 .srt/.lrc → 目录内唯一歌词文件）。

    返回 (lyric_path 文件名, lyric_mtime ms)；歌词文件缺失 → (None, 0)。
    """
    name = song.get("lyric") or None
    if not name:
        return None, 0
    try:
        st = (Path(song["path"]).parent / name).stat()
    except OSError:
        return None, 0
    return name, int(st.st_mtime * 1000)


def _manifest_songs() -> list[dict]:
    """本地歌曲清单：复用曲库扫描结果，size/mtime 从文件系统现取（差量下载依据）。

    增强字段（iOS 同步中心用，增量计算不拖慢扫描）：
    - sha256：文件内容哈希（_HASH_CACHE 增量缓存，mtime+size 未变直接复用）
    - cover_source/cover_path/cover_size/cover_mtime：对齐 /api/cover 判定
    - lyric_path/lyric_mtime：复用曲库扫描的歌词发现逻辑
    """
    out: list[dict] = []
    for s in library_scan.scan_library():
        if not s.get("path"):
            continue  # 网络歌（path=None）无法离线下载，不进 manifest
        try:
            st = Path(s["path"]).stat()
            size, mtime = st.st_size, int(st.st_mtime * 1000)
            ok = True
        except OSError:
            size, mtime = 0, 0
            ok = False
        digest = _file_sha256(s["path"], mtime, size) if ok else ""
        lyric_path, lyric_mtime = _lyric_info(s)
        item = {
            "path": s["path"],
            "name": s.get("name", "") or "",
            "artist": s.get("artist", "") or "",
            "album": s.get("album", "") or "",
            "duration": s.get("duration"),
            "size": size,
            "mtime": mtime,
            "sha256": digest,
            "lyric_path": lyric_path,
            "lyric_mtime": lyric_mtime,
        }
        item.update(_cover_info(s["path"], mtime, size))
        out.append(item)
    return out


def _manifest_playlists() -> list[dict]:
    return [
        {"id": p["id"], "name": p["name"], "songs": list(p.get("songPaths") or [])}
        for p in db.playlists_load()
    ]


def _favorites_rows() -> list[dict]:
    """favorites 表全行（含 ts，供 manifest / LWW 比较）"""
    db._ensure_ready()
    with db._session() as conn:
        rows = conn.execute(
            "SELECT path, name, artist, album, ts FROM favorites ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]


def _manifest_favorites(songs_by_path: dict) -> list[dict]:
    """收藏清单：表内元数据为空时用曲库扫描结果补齐 name/artist/album"""
    out: list[dict] = []
    for r in _favorites_rows():
        meta = songs_by_path.get(r["path"], {}) or {}
        out.append(
            {
                "path": r["path"],
                "name": r["name"] or meta.get("name", "") or "",
                "artist": r["artist"] or meta.get("artist", "") or "",
                "album": r["album"] or meta.get("album", "") or "",
                "ts": r["ts"] or "",
            }
        )
    return out


def _manifest_books() -> list[dict]:
    """书架清单：books.json 元数据 + reading_progress 表进度合并"""
    progs = db.progress_all()
    out: list[dict] = []
    for b in state.books_store.load():
        bid = b.get("id")
        if not bid:
            continue
        out.append(
            {
                "id": bid,
                "title": b.get("title", "") or "",
                "progress": progs.get(bid, b.get("progress")),
            }
        )
    return out


def _manifest_dicts() -> list[dict]:
    """dicts 目录下 MDX/MDD 文件（含新格式 <uuid>/ 子目录，按需下载用）"""
    out: list[dict] = []
    d = state.DICTS_DIR
    if not d.is_dir():
        return out
    for f in sorted(d.rglob("*")):
        if not f.is_file() or f.suffix.lower() not in _DICT_EXTS:
            continue
        try:
            st = f.stat()
            size, mtime = st.st_size, int(st.st_mtime * 1000)
        except OSError:
            size, mtime = 0, 0
        out.append(
            {
                "name": f.name,
                "path": str(f.relative_to(d)),
                "size": size,
                "mtime": mtime,
            }
        )
    return out


def _ops_max_id() -> int:
    """ops 表最新游标（manifest 版本号变化依据：同步写入会推进它）"""
    db._ensure_ready()
    with db._session() as conn:
        row = conn.execute("SELECT COALESCE(MAX(id), 0) AS m FROM ops").fetchone()
    return int(row["m"])


def _manifest_version(songs: list[dict], dicts: list[dict]) -> str:
    """版本串：日期 + 各变更依据拼接（歌曲/词典 mtime、books.json mtime、ops 游标、重扫版本）。

    简单实现：任一数据源有变 → 版本串变化 → 客户端据此刷新 manifest。
    """
    max_mtime = 0
    for s in songs:
        max_mtime = max(max_mtime, int(s.get("mtime") or 0))
    for x in dicts:
        max_mtime = max(max_mtime, int(x.get("mtime") or 0))
    with contextlib.suppress(OSError):
        max_mtime = max(max_mtime, int(Path(state.BOOKS_FILE).stat().st_mtime * 1000))
    ops_id = _ops_max_id()
    scan_ver = int(getattr(state, "_scan_version", 0))
    return f"{datetime.now():%Y%m%d}-{max_mtime}-ops{ops_id}-scan{scan_ver}"


def build_manifest() -> dict:
    """全量元数据清单（GET /api/sync/manifest 响应体）"""
    songs = _manifest_songs()
    dicts = _manifest_dicts()
    return {
        "version": _manifest_version(songs, dicts),
        "generated_at": _now_iso(),
        "songs": songs,
        "playlists": _manifest_playlists(),
        "favorites": _manifest_favorites({s["path"]: s for s in songs}),
        "books": _manifest_books(),
        "dicts": dicts,
        # 客户端拼 URL 下载：音频/封面走现有接口；词典文件走本路由的下载端点
        "media_url_template": "/api/audio?path={path}",
        "cover_url_template": "/api/cover?path={path}",
        "books_url_template": "/api/books/{id}/file",
        "book_cover_url_template": "/api/books/{id}/cover",
        "dicts_url_template": "/api/sync/dicts/file?path={path}",
    }


# ============ ops 校验 ============
def validate_ops(ops) -> None:
    """逐条校验 ops 数组；任一非法 → ValueError（整批拒绝，400）"""
    if not isinstance(ops, list):
        raise ValueError("ops 必须是数组")
    for i, op in enumerate(ops):
        if not isinstance(op, dict):
            raise ValueError(f"ops[{i}] 必须是对象")
        entity = op.get("entity")
        if entity not in _ENTITIES:
            raise ValueError(f"ops[{i}].entity 不合法: {entity!r}")
        payload = op.get("payload")
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise ValueError(f"ops[{i}].payload 必须是对象")
        op_name = str(op.get("op") or "")
        if entity == "favorites":
            if op_name not in ("toggle", "add", "remove"):
                raise ValueError(
                    f"ops[{i}].op 不合法: {op_name!r}（favorites 支持 toggle/add/remove）"
                )
            path = str(payload.get("path") or op.get("entity_id") or "")
            if not path.strip():
                raise ValueError(f"ops[{i}]: favorites 缺少 path")
        elif entity == "playlists":
            if op_name not in ("save", "delete"):
                raise ValueError(f"ops[{i}].op 不合法: {op_name!r}（playlists 支持 save/delete）")
            pid = str(payload.get("id") or op.get("entity_id") or "")
            if not pid.strip():
                raise ValueError(f"ops[{i}]: playlists 缺少 id")
            if op_name == "save":
                songs = payload.get("songs")
                if songs is not None and (
                    not isinstance(songs, list) or not all(isinstance(x, str) for x in songs)
                ):
                    raise ValueError(f"ops[{i}]: playlists save 的 songs 必须是字符串数组")
        elif entity == "reading_progress":
            if op_name != "save":
                raise ValueError(f"ops[{i}].op 不合法: {op_name!r}（reading_progress 支持 save）")
            bid = str(payload.get("book_id") or op.get("entity_id") or "")
            if not bid.strip():
                raise ValueError(f"ops[{i}]: reading_progress 缺少 book_id")
            if not isinstance(payload.get("cfi"), str) or not payload.get("cfi").strip():
                raise ValueError(f"ops[{i}]: reading_progress 缺少 cfi")
            upd = payload.get("updatedAt")
            if not isinstance(upd, (int, float)) or isinstance(upd, bool):
                raise ValueError(f"ops[{i}]: reading_progress updatedAt 必须是数字时间戳")
            loc = payload.get("location")
            if loc is not None and (not isinstance(loc, (int, float)) or isinstance(loc, bool)):
                raise ValueError(f"ops[{i}]: reading_progress location 必须是数字")
        elif entity == "playback_events":
            if op_name != "append":
                raise ValueError(f"ops[{i}].op 不合法: {op_name!r}（playback_events 支持 append）")
            if not str(payload.get("path") or "").strip():
                raise ValueError(f"ops[{i}]: playback_events 缺少 path")


# ============ ops 应用（last-write-wins） ============
def _favorite_apply(op: dict) -> None:
    """favorites：toggle 翻转；add/remove 按 ts 大者胜（表 ts 空视为 0）"""
    payload = op.get("payload") or {}
    path = str(payload.get("path") or op.get("entity_id") or "").strip()
    if not path:
        return
    name = str(payload.get("name") or "")
    artist = str(payload.get("artist") or "")
    album = str(payload.get("album") or "")
    ts = str(op.get("ts") or _now_iso())
    op_name = str(op.get("op") or "")
    db._ensure_ready()
    with db._write_lock, db._session() as conn:
        row = conn.execute("SELECT ts FROM favorites WHERE path = ?", (path,)).fetchone()
        if op_name == "toggle":
            if row:  # 翻转：在收藏中 → 移除
                conn.execute("DELETE FROM favorites WHERE path = ?", (path,))
            else:  # 翻转：不在收藏中 → 添加（带 ts）
                conn.execute(
                    "INSERT INTO favorites (path, name, artist, album, ts) VALUES (?,?,?,?,?)",
                    (path, name, artist, album, ts),
                )
            return
        if op_name == "add":
            if row is not None and _ts_ms(row["ts"]) >= _ts_ms(ts):
                return  # 现有收藏比本次 add 更新 → 跳过
            if row is not None:
                conn.execute(
                    "UPDATE favorites SET name=?, artist=?, album=?, ts=? WHERE path=?",
                    (name, artist, album, ts, path),
                )
            else:
                conn.execute(
                    "INSERT INTO favorites (path, name, artist, album, ts) VALUES (?,?,?,?,?)",
                    (path, name, artist, album, ts),
                )
            return
        if op_name == "remove":
            if row is None:
                return
            if _ts_ms(row["ts"]) > _ts_ms(ts):
                return  # 现有收藏比本次 remove 更新 → 保留
            conn.execute("DELETE FROM favorites WHERE path = ?", (path,))


def _playlist_apply(op: dict) -> bool:
    """playlists：save 整单 upsert / delete，按 updatedAt（或 op ts）大者胜"""
    payload = op.get("payload") or {}
    pid = str(payload.get("id") or op.get("entity_id") or "").strip()
    if not pid:
        return False
    op_name = str(op.get("op") or "")
    # 比较时间：payload 自带 updatedAt 优先，否则用 op.ts
    cmp_ts = payload.get("updatedAt")
    if cmp_ts is None:
        cmp_ts = op.get("ts")
    op_ts = _ts_ms(cmp_ts)
    playlists = db.playlists_load()
    p = next((x for x in playlists if x.get("id") == pid), None)
    if op_name == "save":
        name = str(payload.get("name") or "").strip()
        songs = payload.get("songs")
        if songs is not None and not isinstance(songs, list):
            return False
        if not name and songs is None:
            return False  # 无内容可写
        if p is not None and _ts_ms(p.get("updatedAt", "")) > op_ts:
            return False  # 桌面端歌单更新 → 跳过（LWW）
        if p is None:
            p = {
                "id": pid,
                "name": name,
                "songPaths": [],
                "createdAt": _now_iso(),
                "updatedAt": _now_iso(),
            }
            playlists.append(p)
        if name:
            p["name"] = name
        if songs is not None:
            p["songPaths"] = [str(x) for x in songs]
        p["updatedAt"] = str(cmp_ts or _now_iso())
        db.playlists_save(playlists)
        return True
    if op_name == "delete":
        if p is None:
            return False
        if _ts_ms(p.get("updatedAt", "")) > op_ts:
            return False  # 删除比现有更新 → 保留（LWW）
        db.playlists_save([x for x in playlists if x.get("id") != pid])
        return True
    return False


def _progress_apply(op: dict) -> bool:
    """reading_progress：save upsert，updatedAt 大者胜"""
    payload = op.get("payload") or {}
    book_id = str(payload.get("book_id") or op.get("entity_id") or "").strip()
    if not book_id:
        return False
    updated_at = int(payload.get("updatedAt") or 0)
    cfi = str(payload.get("cfi") or "")
    if not cfi:
        return False
    existing = db.progress_get(book_id)
    if existing is not None and int(existing.get("updatedAt", 0) or 0) > updated_at:
        return False  # 现有进度更新 → 跳过（LWW）
    progress = {"cfi": cfi, "updatedAt": updated_at}
    loc = payload.get("location")
    if loc is not None:
        progress["location"] = loc
    db.progress_set(book_id, progress)
    return True


def _playback_apply(op: dict) -> None:
    """playback_events：append（不合并；滚动截断 5000 由 DAO 保证）"""
    payload = op.get("payload") or {}
    db.playback_append(
        {
            "ts": str(payload.get("ts") or _now_iso()),
            "path": str(payload.get("path") or ""),
            "name": str(payload.get("name") or ""),
            "artist": str(payload.get("artist") or ""),
            "album": str(payload.get("album") or ""),
            "played": float(payload.get("played", 0) or 0),
            "duration": float(payload.get("duration", 0) or 0),
            "ratio": float(payload.get("ratio", 0) or 0),
            "completed": bool(payload.get("completed", False)),
            "source": str(payload.get("source", "manual") or "manual"),
            "mode": str(payload.get("mode", "continuous") or "continuous"),
            "device": str(payload.get("device", "") or ""),
        }
    )


def apply_ops(ops: list[dict]) -> tuple[int, int]:
    """应用一批 ops（调用前须 validate_ops 通过）：逐条应用 + 追加 ops 日志。

    返回 (applied, cursor)：applied = 本次批内合法 op 数；cursor = 最后一条
    追加后的 ops id（= 客户端下次拉取 since 的游标）。
    """
    applied = 0
    cursor = 0
    for op in ops:
        entity = str(op.get("entity") or "")
        entity_id = str(op.get("entity_id") or "")
        op_name = str(op.get("op") or "")
        payload = op.get("payload") or {}
        if entity == "favorites":
            _favorite_apply(op)
        elif entity == "playlists":
            _playlist_apply(op)
        elif entity == "reading_progress":
            _progress_apply(op)
        elif entity == "playback_events":
            _playback_apply(op)
        cursor = db.ops_append(entity, entity_id, op_name, payload, str(op.get("ts") or ""))
        applied += 1
    return applied, cursor
