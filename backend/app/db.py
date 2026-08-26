"""SQLite 存储层（标准库 sqlite3，WAL 模式，短连接 + 全局写锁）。

为 iOS companion 同步（ops 游标查询 / 多端并发写 / last-write-wins 合并）提供数据库底座：
favorites / playlists(+playlist_songs) / playback_events / reading_progress / ops 五张表。
settings.json / pairing.json / queue_order.json / network_songs.json / 大文件 仍走原 JSON 存储，不迁。

设计约定：
- 路径延迟解析：db_path() 每次调用取 state.DB_PATH（测试 monkeypatch 注入临时路径即生效）
- 首次访问自动建表 + 旧 JSON 自动迁移（幂等；迁移失败只记 warning，不影响启动，下次再试）
- 线程安全：每操作短连接（sqlite3 连接默认 check_same_thread，短连接天然线程隔离）
  + 全局写锁串行化写事务；WAL 下读不阻塞写、写不阻塞读
- 业务读写接口保持「load / save」风格（等价原 JsonStore 语义），路由层改造最小
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import state

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS favorites (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    path   TEXT NOT NULL UNIQUE,
    name   TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    album  TEXT NOT NULL DEFAULT '',
    ts     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS playlists (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS playlist_songs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS playback_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    path      TEXT NOT NULL,
    name      TEXT NOT NULL DEFAULT '',
    artist    TEXT NOT NULL DEFAULT '',
    album     TEXT NOT NULL DEFAULT '',
    played    REAL NOT NULL DEFAULT 0,
    duration  REAL NOT NULL DEFAULT 0,
    ratio     REAL NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    source    TEXT NOT NULL DEFAULT 'manual',
    mode      TEXT NOT NULL DEFAULT 'continuous',
    device    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS reading_progress (
    book_id   TEXT PRIMARY KEY,
    cfi       TEXT NOT NULL,
    location  REAL,
    updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ops (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    entity    TEXT NOT NULL,
    entity_id TEXT NOT NULL DEFAULT '',
    op        TEXT NOT NULL,
    payload   TEXT NOT NULL DEFAULT '{}',
    ts        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commands (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,               -- JSON 字符串
    device_id  TEXT,                        -- NULL = 广播
    status     TEXT NOT NULL DEFAULT 'pending',  -- pending|executing|done|failed
    created_at TEXT NOT NULL,
    picked_at  TEXT,                        -- ISO8601，超时回滚用
    ack_at     TEXT,
    ack_by     TEXT,
    error      TEXT
);
CREATE TABLE IF NOT EXISTS device_assets (
    device_id  TEXT PRIMARY KEY,
    assets     TEXT NOT NULL,               -- JSON [{path, sha256, size}]
    total      INTEGER NOT NULL DEFAULT 0,
    by_type    TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist ON playlist_songs(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_playback_ts ON playback_events(ts);
CREATE INDEX IF NOT EXISTS idx_ops_cursor ON ops(id);
CREATE INDEX IF NOT EXISTS idx_commands_pending ON commands(status, device_id);
CREATE INDEX IF NOT EXISTS idx_commands_created ON commands(created_at);
"""

# 迁移源文件 → 目标表（阅读进度单独处理：books.json 只迁 progress 字段，文件不重命名）

_init_lock = threading.Lock()
_write_lock = threading.Lock()
_initialized_path: str | None = None


# ============ 连接 / 初始化 ============
def db_path() -> Path:
    """数据库文件路径（延迟解析：每次调用取 state.DB_PATH，测试可注入）"""
    return Path(state.DB_PATH)


def reset() -> None:
    """清初始化标志（测试切换临时 DB 后强制重建/重迁移）"""
    global _initialized_path
    _initialized_path = None


@contextmanager
def _session() -> sqlite3.Connection:
    """短连接会话：自动 commit / rollback / close（线程安全的基础）"""
    timeout = getattr(state, "DB_BUSY_TIMEOUT", 5)
    conn = sqlite3.connect(str(db_path()), timeout=timeout)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {int(timeout * 1000)}")
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_and_migrate() -> None:
    """启动时显式建表 + 旧 JSON 迁移（幂等；与懒初始化共用同一逻辑）"""
    _ensure_ready()


def _ensure_ready() -> None:
    """首次访问（或 DB 路径变化）时建表 + 迁移；路径不变则直接放行"""
    global _initialized_path
    p = str(db_path())
    if _initialized_path == p:
        return
    with _init_lock:
        if _initialized_path == p:
            return
        _init_db()
        _migrate_from_json()
        _initialized_path = p


def _init_db() -> None:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _session() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)


# ============ 旧 JSON 迁移（首次启动自动、幂等、失败不阻断） ============
def _table_empty(name: str) -> bool:
    with _session() as conn:
        return conn.execute(f"SELECT 1 FROM {name} LIMIT 1").fetchone() is None


def _rename_to_bak(path: Path) -> None:
    """旧文件改名 <name>.migrated.bak（保守：改名不删除；失败只记 warning）"""
    bak = path.with_name(path.name + ".migrated.bak")
    try:
        if path.exists() and not bak.exists():
            path.rename(bak)
    except OSError:
        logger.warning("SQLite 迁移：重命名 %s 失败（保持原文件）", path)


def _migrate_from_json() -> None:
    """favorites/playlists/playback 三文件 + books.json 的 progress 字段 → SQLite。

    规则：旧文件存在 && 对应表为空 → 导入 + 旧文件改名 .migrated.bak；
    表非空（已迁移/已有数据）→ 跳过；解析失败 → 记 warning 不阻断，下次启动再试。
    """
    pairs = (
        ("FAVORITES_FILE", "favorites", _migrate_favorites),
        ("PLAYLISTS_FILE", "playlists", _migrate_playlists),
        ("PLAYBACK_FILE", "playback_events", _migrate_playback),
    )
    for attr, table, fn in pairs:
        src = getattr(state, attr)
        if not Path(src).exists() or not _table_empty(table):
            continue
        fn(Path(src))
    _migrate_reading_progress()


def _migrate_favorites(src: Path) -> None:
    try:
        data = json.loads(src.read_text("utf-8"))
        if not isinstance(data, list):
            return  # 结构异常：不导入也不改名，下次再试
        n = 0
        with _write_lock, _session() as conn:
            for item in data:
                if isinstance(item, str) and item:
                    conn.execute("INSERT OR IGNORE INTO favorites (path) VALUES (?)", (item,))
                    n += 1
                elif isinstance(item, dict) and item.get("path"):
                    conn.execute(
                        "INSERT OR IGNORE INTO favorites (path, name, artist, album, ts) "
                        "VALUES (?,?,?,?,?)",
                        (
                            item["path"],
                            str(item.get("name", "") or ""),
                            str(item.get("artist", "") or ""),
                            str(item.get("album", "") or ""),
                            str(item.get("ts", "") or ""),
                        ),
                    )
                    n += 1
        _rename_to_bak(src)
        logger.info("SQLite 迁移：favorites.json → favorites 表（%s 条）", n)
    except (ValueError, OSError) as e:
        logger.warning("SQLite 迁移：favorites.json 导入失败：%s（下次启动重试）", e)


def _migrate_playlists(src: Path) -> None:
    try:
        data = json.loads(src.read_text("utf-8"))
        if not isinstance(data, list):
            return
        n = 0
        with _write_lock, _session() as conn:
            for pl in data:
                if not isinstance(pl, dict) or not pl.get("id"):
                    continue
                conn.execute(
                    "INSERT OR REPLACE INTO playlists (id, name, createdAt, updatedAt) "
                    "VALUES (?,?,?,?)",
                    (
                        pl["id"],
                        str(pl.get("name", "") or ""),
                        str(pl.get("createdAt", "") or ""),
                        str(pl.get("updatedAt", "") or ""),
                    ),
                )
                for pos, path in enumerate(pl.get("songPaths") or []):
                    conn.execute(
                        "INSERT INTO playlist_songs (playlist_id, path, position) VALUES (?,?,?)",
                        (pl["id"], str(path), pos),
                    )
                    n += 1
        _rename_to_bak(src)
        logger.info("SQLite 迁移：playlists.json → playlists 表（%s 个歌单）", len(data))
    except (ValueError, OSError) as e:
        logger.warning("SQLite 迁移：playlists.json 导入失败：%s（下次启动重试）", e)


def _migrate_playback(src: Path) -> None:
    try:
        data = json.loads(src.read_text("utf-8"))
        if not isinstance(data, list):
            return
        with _write_lock, _session() as conn:
            for rec in data:
                if not isinstance(rec, dict) or not rec.get("path"):
                    continue
                conn.execute(
                    "INSERT INTO playback_events "
                    "(ts, path, name, artist, album, played, duration, ratio, completed, source, mode, device) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    _playback_row(rec),
                )
            _trim_playback(conn)
        _rename_to_bak(src)
        logger.info("SQLite 迁移：playback.json → playback_events 表（%s 条）", len(data))
    except (ValueError, OSError) as e:
        logger.warning("SQLite 迁移：playback.json 导入失败：%s（下次启动重试）", e)


def _migrate_reading_progress() -> None:
    """books.json 的 progress 字段 → reading_progress 表。

    注意：books.json 不重命名 —— 它仍是书架元数据（title/author/addedAt）的活数据源，
    这里只迁出 progress 字段；幂等靠「表为空才导入」保证。
    """
    src = state.BOOKS_FILE
    if not Path(src).exists() or not _table_empty("reading_progress"):
        return
    try:
        data = json.loads(Path(src).read_text("utf-8"))
        if not isinstance(data, list):
            return
        n = 0
        with _write_lock, _session() as conn:
            for b in data:
                if not isinstance(b, dict) or not b.get("id"):
                    continue
                p = b.get("progress")
                if not isinstance(p, dict) or not p.get("cfi"):
                    continue
                conn.execute(
                    "INSERT OR REPLACE INTO reading_progress (book_id, cfi, location, updatedAt) "
                    "VALUES (?,?,?,?)",
                    (b["id"], str(p["cfi"]), p.get("location"), int(p.get("updatedAt", 0) or 0)),
                )
                n += 1
        logger.info("SQLite 迁移：books.json progress → reading_progress 表（%s 条）", n)
    except (ValueError, OSError) as e:
        logger.warning("SQLite 迁移：books.json 进度导入失败：%s（下次启动重试）", e)


# ============ favorites ============
def favorites_load() -> list[str]:
    """全部收藏路径（按收藏顺序）"""
    _ensure_ready()
    with _session() as conn:
        rows = conn.execute("SELECT path FROM favorites ORDER BY id").fetchall()
    return [r["path"] for r in rows]


def favorites_save(paths: list[str]) -> None:
    """全量重写收藏（等价原 JSON save 语义；单事务原子写）"""
    _ensure_ready()
    with _write_lock, _session() as conn:
        conn.execute("DELETE FROM favorites")
        conn.executemany("INSERT INTO favorites (path) VALUES (?)", [(p,) for p in paths if p])


def favorites_toggle(path: str) -> bool:
    """在列表则移除、不在则追加；返回收藏后是否处于已收藏状态"""
    _ensure_ready()
    with _write_lock, _session() as conn:
        if conn.execute("SELECT 1 FROM favorites WHERE path = ?", (path,)).fetchone():
            conn.execute("DELETE FROM favorites WHERE path = ?", (path,))
            return False
        conn.execute("INSERT INTO favorites (path) VALUES (?)", (path,))
        return True


def favorites_remove(paths: list[str]) -> None:
    """批量移除收藏（无匹配则不动）"""
    _ensure_ready()
    paths = [p for p in paths if p]
    if not paths:
        return
    with _write_lock, _session() as conn:
        conn.executemany("DELETE FROM favorites WHERE path = ?", [(p,) for p in paths])


def favorites_replace_path(old: str, new: str) -> None:
    """改名后迁移收藏里的旧路径引用（仅命中才写；new 已存在时合并去重）"""
    _ensure_ready()
    if not old or old == new:
        return
    with _write_lock, _session() as conn:
        if conn.execute("SELECT 1 FROM favorites WHERE path = ?", (old,)).fetchone() is None:
            return
        conn.execute("DELETE FROM favorites WHERE path = ?", (new,))  # 防 UNIQUE 冲突
        conn.execute("UPDATE favorites SET path = ? WHERE path = ?", (new, old))


# ============ playlists（playlists + playlist_songs 关联表） ============
def playlists_load() -> list[dict]:
    """全部歌单（含 songPaths，按创建顺序；重复路径保留，兼容旧 JSON 数据）"""
    _ensure_ready()
    with _session() as conn:
        pls = conn.execute("SELECT * FROM playlists ORDER BY id").fetchall()
        songs = conn.execute(
            "SELECT playlist_id, path FROM playlist_songs ORDER BY playlist_id, position, id"
        ).fetchall()
    by_pid: dict[str, list[str]] = {}
    for s in songs:
        by_pid.setdefault(s["playlist_id"], []).append(s["path"])
    return [
        {
            "id": p["id"],
            "name": p["name"],
            "songPaths": by_pid.get(p["id"], []),
            "createdAt": p["createdAt"],
            "updatedAt": p["updatedAt"],
        }
        for p in pls
    ]


def playlists_save(playlists: list[dict]) -> None:
    """全量重写歌单（等价原 JSON save 语义；单事务原子写）"""
    _ensure_ready()
    with _write_lock, _session() as conn:
        conn.execute("DELETE FROM playlist_songs")
        conn.execute("DELETE FROM playlists")
        for pl in playlists:
            conn.execute(
                "INSERT INTO playlists (id, name, createdAt, updatedAt) VALUES (?,?,?,?)",
                (
                    str(pl.get("id", "")),
                    str(pl.get("name", "") or ""),
                    str(pl.get("createdAt", "") or ""),
                    str(pl.get("updatedAt", "") or ""),
                ),
            )
            for pos, path in enumerate(pl.get("songPaths") or []):
                conn.execute(
                    "INSERT INTO playlist_songs (playlist_id, path, position) VALUES (?,?,?)",
                    (pl["id"], str(path), pos),
                )


def playlists_remove_paths(paths: list[str]) -> None:
    """从所有歌单移除给定路径（无匹配则不动）"""
    _ensure_ready()
    paths = [p for p in paths if p]
    if not paths:
        return
    with _write_lock, _session() as conn:
        conn.executemany("DELETE FROM playlist_songs WHERE path = ?", [(p,) for p in paths])


def playlists_replace_path(old: str, new: str) -> None:
    """改名后迁移所有歌单里的旧路径引用（仅命中才写）"""
    _ensure_ready()
    if not old or old == new:
        return
    with _write_lock, _session() as conn:
        if (
            conn.execute("SELECT 1 FROM playlist_songs WHERE path = ? LIMIT 1", (old,)).fetchone()
            is None
        ):
            return
        conn.execute("UPDATE playlist_songs SET path = ? WHERE path = ?", (new, old))


# ============ playback_events（滚动截断保留 PLAYBACK_LIMIT 条） ============
def playback_append(record: dict) -> None:
    """追加一条播放记录；超 PLAYBACK_LIMIT 删最旧（单事务）"""
    _ensure_ready()
    with _write_lock, _session() as conn:
        conn.execute(
            "INSERT INTO playback_events "
            "(ts, path, name, artist, album, played, duration, ratio, completed, source, mode, device) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            _playback_row(record),
        )
        _trim_playback(conn)


def _trim_playback(conn: sqlite3.Connection) -> None:
    """删除超过上限的最旧记录（上限来自 state.PLAYBACK_LIMIT，测试可缩小）"""
    limit = getattr(state, "PLAYBACK_LIMIT", 5000)
    conn.execute(
        "DELETE FROM playback_events WHERE id <= COALESCE("
        "(SELECT id FROM playback_events ORDER BY id DESC LIMIT 1 OFFSET ?), -1)",
        (limit,),
    )


def playback_all() -> list[dict]:
    """全部播放记录（按写入顺序；与旧 JSON 列表语义一致）"""
    _ensure_ready()
    with _session() as conn:
        rows = conn.execute("SELECT * FROM playback_events ORDER BY id").fetchall()
    return [_record_from_row(r) for r in rows]


def playback_replace_path(old: str, new: str) -> None:
    """改名后迁移播放记录里的旧路径引用（仅命中才写）"""
    _ensure_ready()
    if not old or old == new:
        return
    with _write_lock, _session() as conn:
        if (
            conn.execute("SELECT 1 FROM playback_events WHERE path = ? LIMIT 1", (old,)).fetchone()
            is None
        ):
            return
        conn.execute("UPDATE playback_events SET path = ? WHERE path = ?", (new, old))


def _playback_row(rec: dict) -> tuple:
    """记录 dict → 行参数（completed 布尔 ↔ INTEGER）"""
    return (
        str(rec.get("ts", "")),
        str(rec.get("path", "")),
        str(rec.get("name", "") or ""),
        str(rec.get("artist", "") or ""),
        str(rec.get("album", "") or ""),
        float(rec.get("played", 0) or 0),
        float(rec.get("duration", 0) or 0),
        float(rec.get("ratio", 0) or 0),
        1 if rec.get("completed") else 0,
        str(rec.get("source", "manual") or "manual"),
        str(rec.get("mode", "continuous") or "continuous"),
        str(rec.get("device", "") or ""),
    )


def _record_from_row(row: sqlite3.Row) -> dict:
    return {
        "ts": row["ts"],
        "path": row["path"],
        "name": row["name"],
        "artist": row["artist"],
        "album": row["album"],
        "played": row["played"],
        "duration": row["duration"],
        "ratio": row["ratio"],
        "completed": bool(row["completed"]),
        "source": row["source"],
        "mode": row["mode"],
        "device": row["device"],
    }


# ============ reading_progress ============
def progress_get(book_id: str) -> dict | None:
    """书籍阅读进度 {cfi, location?, updatedAt}；未读返回 None"""
    _ensure_ready()
    with _session() as conn:
        row = conn.execute(
            "SELECT * FROM reading_progress WHERE book_id = ?", (book_id,)
        ).fetchone()
    if row is None:
        return None
    p = {"cfi": row["cfi"], "updatedAt": row["updatedAt"]}
    if row["location"] is not None:
        p["location"] = row["location"]
    return p


def progress_set(book_id: str, progress: dict) -> dict:
    """保存阅读进度（upsert）"""
    _ensure_ready()
    with _write_lock, _session() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO reading_progress (book_id, cfi, location, updatedAt) "
            "VALUES (?,?,?,?)",
            (
                book_id,
                str(progress.get("cfi", "")),
                progress.get("location"),
                int(progress.get("updatedAt", 0) or 0),
            ),
        )
    return progress


def progress_delete(book_id: str) -> None:
    """删除书籍时清进度（幂等）"""
    _ensure_ready()
    with _write_lock, _session() as conn:
        conn.execute("DELETE FROM reading_progress WHERE book_id = ?", (book_id,))


def progress_all() -> dict[str, dict]:
    """全部书籍进度（book_id → progress），供书架列表合并"""
    _ensure_ready()
    with _session() as conn:
        rows = conn.execute("SELECT * FROM reading_progress").fetchall()
    out: dict[str, dict] = {}
    for r in rows:
        p = {"cfi": r["cfi"], "updatedAt": r["updatedAt"]}
        if r["location"] is not None:
            p["location"] = r["location"]
        out[r["book_id"]] = p
    return out


# ============ ops（同步基础表：append + list since 游标；同步 API 由任务 B 提供） ============
def ops_append(
    entity: str,
    entity_id: str = "",
    op: str = "",
    payload: dict | None = None,
    ts: str = "",
) -> int:
    """追加一条同步操作日志；返回自增 id（游标值）"""
    _ensure_ready()
    if not ts:
        ts = datetime.now(timezone.utc).isoformat()
    payload_str = json.dumps(payload if payload is not None else {}, ensure_ascii=False)
    with _write_lock, _session() as conn:
        cur = conn.execute(
            "INSERT INTO ops (entity, entity_id, op, payload, ts) VALUES (?,?,?,?,?)",
            (entity, entity_id, op, payload_str, ts),
        )
        return int(cur.lastrowid)


def ops_list_since(cursor: int = 0, limit: int | None = None) -> list[dict]:
    """拉取 id > cursor 的增量操作（append-only 游标语义，升序；limit 可选防单次过大）"""
    _ensure_ready()
    sql = "SELECT id, entity, entity_id, op, payload, ts FROM ops WHERE id > ? ORDER BY id ASC"
    params: list = [cursor]
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    with _session() as conn:
        rows = conn.execute(sql, params).fetchall()
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload"] or "{}")
        except ValueError:
            payload = {}
        out.append(
            {
                "id": r["id"],
                "entity": r["entity"],
                "entity_id": r["entity_id"],
                "op": r["op"],
                "payload": payload,
                "ts": r["ts"],
            }
        )
    return out


# ============ commands（设备指令队列：桌面端写，iOS 轮询拉取执行 + 回执） ============
def commands_create(cmd_type: str, payload: dict, device_id: str | None = None) -> dict:
    """创建一条指令（device_id=None = 广播）；返回 {id, type, status, created_at}"""
    _ensure_ready()
    payload_str = json.dumps(payload, ensure_ascii=False)
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _write_lock, _session() as conn:
        cur = conn.execute(
            "INSERT INTO commands (type, payload, device_id, status, created_at) "
            "VALUES (?,?,?,'pending',?)",
            (cmd_type, payload_str, device_id, created_at),
        )
        cmd_id = int(cur.lastrowid)
    return {"id": cmd_id, "type": cmd_type, "status": "pending", "created_at": created_at}


def commands_pending_pick(device_id: str | None = None) -> list[dict]:
    """原子拉取待执行指令：先回滚超时 executing → pending，再取 pending 并标记 executing。

    超时兜底：executing 且 picked_at 距今超过 state.COMMAND_PICK_TIMEOUT_SECONDS（默认 10 分钟）
    → 回滚为 pending（清 picked_at），客户端拉取后崩溃不卡死队列。
    整个流程在全局写锁 + 单事务内完成，多端并发拉取不会重复拿到同一条。
    """
    _ensure_ready()
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat(timespec="seconds")
    cutoff_iso = (now - timedelta(seconds=state.COMMAND_PICK_TIMEOUT_SECONDS)).isoformat(
        timespec="seconds"
    )
    with _write_lock, _session() as conn:
        conn.execute(
            "UPDATE commands SET status='pending', picked_at=NULL "
            "WHERE status='executing' AND picked_at IS NOT NULL AND picked_at < ?",
            (cutoff_iso,),
        )
        rows = conn.execute(
            "SELECT id, type, payload, created_at FROM commands "
            "WHERE status='pending' AND (device_id IS NULL OR device_id = ?) "
            "ORDER BY id ASC",
            (device_id,),
        ).fetchall()
        conn.executemany(
            "UPDATE commands SET status='executing', picked_at=? WHERE id=? AND status='pending'",
            [(now_iso, r["id"]) for r in rows],
        )
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload"] or "{}")
        except ValueError:
            payload = {}
        out.append(
            {"id": r["id"], "type": r["type"], "payload": payload, "created_at": r["created_at"]}
        )
    return out


def commands_ack(cmd_id: int, device_id: str, ok: bool, error: str = "") -> dict | None:
    """执行回执：ok → done（清 error）；否则 failed + error。

    重复 ack 幂等覆盖（已 done/failed 再 ack 直接覆盖）；指令不存在返回 None。
    """
    _ensure_ready()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    status = "done" if ok else "failed"
    with _write_lock, _session() as conn:
        cur = conn.execute(
            "UPDATE commands SET status=?, ack_at=?, ack_by=?, error=? WHERE id=?",
            (status, now, device_id, "" if ok else error, cmd_id),
        )
        if cur.rowcount == 0:
            return None
    return {"ok": True}


def commands_list(status: str | None = None, device_id: str | None = None) -> list[dict]:
    """指令历史：id 降序；可选 status / device_id 过滤；payload 反序列化为对象。"""
    _ensure_ready()
    sql = "SELECT * FROM commands"
    conds: list[str] = []
    params: list = []
    if status:
        conds.append("status = ?")
        params.append(status)
    if device_id is not None:
        conds.append("device_id = ?")
        params.append(device_id)
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    sql += " ORDER BY id DESC"
    with _session() as conn:
        rows = conn.execute(sql, params).fetchall()
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload"] or "{}")
        except ValueError:
            payload = {}
        out.append(
            {
                "id": r["id"],
                "type": r["type"],
                "payload": payload,
                "status": r["status"],
                "device_id": r["device_id"],
                "created_at": r["created_at"],
                "picked_at": r["picked_at"],
                "ack_at": r["ack_at"],
                "ack_by": r["ack_by"],
                "error": r["error"],
            }
        )
    return out


# ============ device_assets（iOS 资产清单上报，按设备 upsert） ============
def device_assets_upsert(
    device_id: str, assets: list[dict], total: int = 0, by_type: dict | None = None
) -> None:
    """按 device_id 一行 upsert（assets JSON + total + byType + updated_at 全量覆盖）"""
    _ensure_ready()
    assets_str = json.dumps(assets, ensure_ascii=False)
    by_type_str = json.dumps(by_type or {}, ensure_ascii=False)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _write_lock, _session() as conn:
        conn.execute(
            "INSERT INTO device_assets (device_id, assets, total, by_type, updated_at) "
            "VALUES (?,?,?,?,?) "
            "ON CONFLICT(device_id) DO UPDATE SET "
            "assets=excluded.assets, total=excluded.total, "
            "by_type=excluded.by_type, updated_at=excluded.updated_at",
            (device_id, assets_str, int(total), by_type_str, now),
        )


def device_assets_get(device_id: str) -> dict | None:
    """单设备最近资产上报；无上报返回 None。"""
    _ensure_ready()
    with _session() as conn:
        row = conn.execute(
            "SELECT * FROM device_assets WHERE device_id = ?", (device_id,)
        ).fetchone()
    if row is None:
        return None
    return {
        "device_id": row["device_id"],
        "assets": json.loads(row["assets"] or "[]"),
        "total": row["total"],
        "byType": json.loads(row["by_type"] or "{}"),
        "assets_updated_at": row["updated_at"],
    }


def device_assets_all() -> dict[str, dict]:
    """全部设备最近资产上报（device_id → {assets, total, byType, assets_updated_at}）"""
    _ensure_ready()
    with _session() as conn:
        rows = conn.execute("SELECT * FROM device_assets").fetchall()
    out = {}
    for r in rows:
        try:
            assets = json.loads(r["assets"] or "[]")
            by_type = json.loads(r["by_type"] or "{}")
        except ValueError:
            assets, by_type = [], {}
        out[r["device_id"]] = {
            "assets": assets,
            "total": r["total"],
            "byType": by_type,
            "assets_updated_at": r["updated_at"],
        }
    return out
