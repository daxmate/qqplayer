"""SQLite 存储层（标准库 sqlite3，WAL 模式，短连接 + 全局写锁）。

为 iOS companion 同步（ops 游标查询 / 多端并发写 / last-write-wins 合并）提供数据库底座：
favorites / playlists(+playlist_songs) / playback_events / reading_progress / ops / commands /
device_assets 表 + track_fingerprints 指纹缓存表（局域网同步 S2：相对路径 → 音频字节
SHA-256，惰性计算 + 落库，见 app/lansync/locallib.py）+ kv_store 统一 KV 表
（queue_order / network_songs / books / annotations / vocab / pairing 六个 JSON 域，
各一个 key，value 整份 JSON）。
settings.json（P0 设置真源） / quark_cookies.json / 大文件 仍走原 JSON 存储，不迁。

设计约定：
- 路径延迟解析：db_path() 每次调用取 state.DB_PATH（测试 monkeypatch 注入临时路径即生效）
- 首次访问自动建表 + 旧 JSON 自动迁移（幂等；迁移失败只记 warning，不影响启动，下次再试）
- 线程安全：每操作短连接（sqlite3 连接默认 check_same_thread，短连接天然线程隔离）
  + 全局写锁串行化写事务；WAL 下读不阻塞写、写不阻塞读
- 业务读写接口保持「load / save」风格（等价原 JsonStore 语义），路由层改造最小
"""

from __future__ import annotations

import copy
import json
import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import state

logger = logging.getLogger(__name__)


class _LazyChanges:
    """惰性代理：本模块 → `app.lansync.changelog` 的**纯构造函数**（避免模块级循环 import）。

    changelog 依赖 db 的存储 API；db 只在**业务写入点**取它的纯构造器
    （`for_favorite` / `for_play_history` / `for_playlists` / `for_playlist_item`）。
    """

    def __getattr__(self, name: str):
        from app.lansync import changelog

        return getattr(changelog, name)


_changes = _LazyChanges()

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
CREATE TABLE IF NOT EXISTS kv_store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,                    -- 整份 JSON 字符串
    ts    TEXT NOT NULL DEFAULT ''          -- 最近写入时间（ISO，调试/同步版本依据用）
);
-- 局域网同步（S2）内容指纹缓存：相对曲库根路径 → 音频文件字节 SHA-256（小写 hex）。
-- 为什么单独一张表：web 端曲库是**文件系统扫描**结果（没有 songs 表），跨端身份键
-- 需要落库缓存以免每次同步全库重算；size/mtime_ms 是缓存失效依据（任一变化 → 重算）。
CREATE TABLE IF NOT EXISTS track_fingerprints (
    relative_path TEXT PRIMARY KEY,         -- POSIX 分隔，相对曲库根（对账键同口径）
    content_hash  TEXT NOT NULL,            -- SHA-256 小写 hex
    size          INTEGER NOT NULL DEFAULT 0,
    mtime_ms      INTEGER NOT NULL DEFAULT 0,  -- 文件 mtime（毫秒 since 1970）
    updated_at    TEXT NOT NULL DEFAULT ''
);
-- 局域网同步（S2, S4）播放数据变更日志（outbox）：本端**业务写入点**的变更记录，
-- 与 Swift `sync_outbox` 同构（列名 row_key / updated_at / payload_json）。追加与业务
-- 行写入**同一事务**（绝不先改业务行后补 outbox）；delete 本地留痕但**永不上线**（§14.9）。
CREATE TABLE IF NOT EXISTS sync_outbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    entity       TEXT NOT NULL,               -- favorite|play_history|playlist|playlist_item
    row_key      TEXT NOT NULL,               -- 本地形态行键（相对路径 / 复合键，§14.5）
    op           TEXT NOT NULL,               -- upsert|delete
    updated_at   INTEGER NOT NULL,            -- 变更时刻（毫秒 since 1970）= LWW 判据
    payload_json TEXT                         -- 行快照 JSON（delete 行为 NULL）
);
-- 拉取游标：本端**已消费的对端** outbox 位置（谁写/谁读见 §14.6）
CREATE TABLE IF NOT EXISTS sync_cursor (
    peer_id        TEXT PRIMARY KEY,
    last_outbox_id INTEGER NOT NULL DEFAULT 0
);
-- 推送游标：本端**已推给对端**的本端 outbox 位置（与上面那张表**方向相反**，合表必错）
CREATE TABLE IF NOT EXISTS sync_push_cursor (
    peer_id        TEXT PRIMARY KEY,
    last_outbox_id INTEGER NOT NULL DEFAULT 0
);
-- 本地缺歌挂起：content_hash 映射不到本端曲目时暂存远端行，歌到位后重放（数据不丢，§14.8）
CREATE TABLE IF NOT EXISTS sync_pending_change (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    entity         TEXT NOT NULL,
    content_hash   TEXT NOT NULL,
    remote_row_key TEXT NOT NULL,             -- 远端原始行键（重放时重新本地化）
    op             TEXT NOT NULL,
    updated_at     INTEGER NOT NULL,
    payload_json   TEXT,
    created_at     TEXT NOT NULL DEFAULT '',
    UNIQUE(entity, content_hash, remote_row_key)
);
CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist ON playlist_songs(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_key ON sync_outbox(entity, row_key);
CREATE INDEX IF NOT EXISTS idx_sync_pending_hash ON sync_pending_change(content_hash);
CREATE INDEX IF NOT EXISTS idx_playback_ts ON playback_events(ts);
CREATE INDEX IF NOT EXISTS idx_track_fingerprints_hash ON track_fingerprints(content_hash);
CREATE INDEX IF NOT EXISTS idx_ops_cursor ON ops(id);
CREATE INDEX IF NOT EXISTS idx_commands_pending ON commands(status, device_id);
CREATE INDEX IF NOT EXISTS idx_commands_created ON commands(created_at);
"""

# 迁移源文件 → 目标表（阅读进度单独处理：books.json 只迁 progress 字段，文件不重命名）
# KV 域迁移：旧 JSON 文件 → kv_store 单 key（books.json 整份迁移，含元数据）

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


# 统一 KV 域的迁移源（attr 为 state 上的文件路径常量 → kv_store key → 展示名）
_KV_MIGRATIONS = (
    ("QUEUE_ORDER_FILE", "queue_order", "queue_order.json"),
    ("NETWORK_SONGS_FILE", "network_songs", "network_songs.json"),
    ("BOOKS_FILE", "books", "books.json"),
    ("ANNOTATIONS_FILE", "annotations", "annotations.json"),
    ("VOCAB_FILE", "vocab", "vocab.json"),
    ("PAIRING_FILE", "pairing", "pairing.json"),
)


def _migrate_from_json() -> None:
    """favorites/playlists/playback 三文件 + books.json 的 progress 字段 + 6 个 KV 域 → SQLite。

    规则：旧文件存在 && 目标（表/KV key）为空 → 导入 + 旧文件改名 .migrated.bak；
    目标非空（已迁移/已有数据）→ 跳过；解析失败 → 记 warning 不阻断，下次启动再试。
    注意：books.json 的 reading_progress 迁移必须先于 books KV 迁移执行——
    books.json 迁入 kv_store 后会被改名 .migrated.bak，进度迁移就找不到源文件了。
    """
    _migrate_reading_progress()  # 优先：趁 books.json 还没改名时提取 progress 字段
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
    for attr, key, label in _KV_MIGRATIONS:
        _migrate_kv(attr, key, label)


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


def _kv_key_exists(key: str) -> bool:
    """kv_store 是否已有该 key（幂等迁移依据）"""
    with _session() as conn:
        return (
            conn.execute("SELECT 1 FROM kv_store WHERE key = ? LIMIT 1", (key,)).fetchone()
            is not None
        )


def _migrate_kv(attr: str, key: str, label: str) -> None:
    """单个 KV 域迁移：旧 JSON 存在 && key 空 → 整份导入 + 旧文件改名 .migrated.bak。

    结构异常（JSON 合法但与默认值类型不符）→ 记 warning 不导入不改名，下次再试。
    """
    src = getattr(state, attr)
    if not Path(src).exists() or _kv_key_exists(key):
        return
    try:
        data = json.loads(Path(src).read_text("utf-8"))
        if not isinstance(data, type(_KV_DEFAULTS[key])):
            logger.warning("SQLite 迁移：%s 结构异常，跳过导入（下次启动重试）", label)
            return
        _kv_write(key, json.dumps(data, ensure_ascii=False))
        _rename_to_bak(Path(src))
        logger.info("SQLite 迁移：%s → kv_store[%s]", label, key)
    except (ValueError, OSError) as e:
        logger.warning("SQLite 迁移：%s 导入失败：%s（下次启动重试）", label, e)


def _migrate_reading_progress() -> None:
    """books.json 的 progress 字段 → reading_progress 表。

    注意：books.json 的 KV 迁移（整份迁走并改名）由 _migrate_from_json 在本函数之后
    执行——本函数只迁出 progress 字段；幂等靠「表为空才导入」保证。
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


# ============ 统一 KV 存储（queue_order/network_songs/books/annotations/vocab/pairing） ============
# 6 个原 JsonStore 域全部归一进 SQLite：每域一个 key，value 整份 JSON。
# 读写接口保持原「load / save」风格（路由层改造最小，语义等价 JsonStore）。
# 默认值照 state.py 旧 store 定义：annotations {}、pairing {"devices":[],"pending":[]}、其余 []。

_KV_DEFAULTS: dict[str, object] = {
    "queue_order": [],
    "network_songs": [],
    "books": [],
    "annotations": {},
    "vocab": [],
    "pairing": {"devices": [], "pending": []},
}


def _kv_get(key: str) -> str | None:
    """读原始 JSON 字符串；key 不存在返回 None"""
    _ensure_ready()
    with _session() as conn:
        row = conn.execute("SELECT value FROM kv_store WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _kv_write(key: str, value: str) -> None:
    """原始写入（upsert）+ 刷新 ts；不触发 _ensure_ready（迁移内部复用，防锁重入）"""
    now = datetime.now(timezone.utc).isoformat()
    with _write_lock, _session() as conn:
        conn.execute(
            "INSERT INTO kv_store (key, value, ts) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts",
            (key, value, now),
        )


def _kv_set(key: str, value: str) -> None:
    """写入（upsert）+ 刷新 ts"""
    _ensure_ready()
    _kv_write(key, value)


def _kv_load(key: str) -> object:
    """读并反序列化；缺失/损坏 → 默认值深拷贝（等价 JsonStore.load 语义）。

    深拷贝防调用方直接改默认值污染后续读取；损坏值不删除（保守，可人工恢复）。
    """
    raw = _kv_get(key)
    if raw is None:
        return copy.deepcopy(_KV_DEFAULTS[key])
    try:
        data = json.loads(raw)
    except ValueError:
        logger.warning("SQLite KV：%s 解析失败，回默认值（原值保留）", key)
        return copy.deepcopy(_KV_DEFAULTS[key])
    if not isinstance(data, type(_KV_DEFAULTS[key])):
        logger.warning("SQLite KV：%s 结构异常，回默认值（原值保留）", key)
        return copy.deepcopy(_KV_DEFAULTS[key])
    return data


def _kv_ts(key: str) -> str:
    """该 key 最近写入时间（ISO；从未写入返回空串）"""
    _ensure_ready()
    with _session() as conn:
        row = conn.execute("SELECT ts FROM kv_store WHERE key = ?", (key,)).fetchone()
    return row["ts"] if row else ""


# ---- 播放队列顺序（前端拖拽排序后保存，启动/刷新时恢复） ----
def queue_order_load() -> list:
    return _kv_load("queue_order")


def queue_order_save(paths: list) -> None:
    _kv_set("queue_order", json.dumps(paths, ensure_ascii=False))


# ---- 网络曲库条目（网易云等在线源登记，播放时实时取直链） ----
def network_songs_load() -> list:
    return _kv_load("network_songs")


def network_songs_save(entries: list) -> None:
    _kv_set("network_songs", json.dumps(entries, ensure_ascii=False))


# ---- 书架元数据（books/<id>/ 目录下的 book.epub + cover + index.json 不动） ----
def books_load() -> list:
    return _kv_load("books")


def books_save(books: list) -> None:
    _kv_set("books", json.dumps(books, ensure_ascii=False))


# ---- 阅读器 V2 标注：{bookId: {highlights[], bookmarks[], notes[]}} ----
def annotations_load() -> dict:
    return _kv_load("annotations")


def annotations_save(data: dict) -> None:
    _kv_set("annotations", json.dumps(data, ensure_ascii=False))


# ---- 阅读器 V2 生词本：[{id, word, context, bookId, bookTitle, cfi, addedAt}] ----
def vocab_load() -> list:
    return _kv_load("vocab")


def vocab_save(items: list) -> None:
    _kv_set("vocab", json.dumps(items, ensure_ascii=False))


# ---- 移动端配对：{devices[], pending[], server_id?}（token 只存 SHA-256 哈希） ----
def pairing_load() -> dict:
    return _kv_load("pairing")


def pairing_save(data: dict) -> None:
    _kv_set("pairing", json.dumps(data, ensure_ascii=False))


# ============ favorites ============
def favorites_load() -> list[str]:
    """全部收藏路径（按收藏顺序）"""
    _ensure_ready()
    with _session() as conn:
        rows = conn.execute("SELECT path FROM favorites ORDER BY id").fetchall()
    return [r["path"] for r in rows]


def favorites_save(paths: list[str]) -> None:
    """全量重写收藏（等价原 JSON save 语义；单事务原子写）

    与 outbox 同一事务：按前后集合差异补记 upsert/delete（S4），不产生无谓变更。
    """
    _ensure_ready()
    before = set(favorites_load())
    after = [p for p in paths if p]
    after_set = set(after)
    with _write_lock, _session() as conn:
        conn.execute("DELETE FROM favorites")
        conn.executemany("INSERT INTO favorites (path) VALUES (?)", [(p,) for p in after])
        changes = [
            row
            for path in after_set - before
            for row in _changes.for_favorite(path, _changes.OP_UPSERT)
        ]
        changes += [
            row
            for path in before - after_set
            for row in _changes.for_favorite(path, _changes.OP_DELETE)
        ]
        _outbox_add(conn, changes)


def favorites_toggle(path: str) -> bool:
    """在列表则移除、不在则追加；返回收藏后是否处于已收藏状态

    业务行与 outbox 变更（favorite upsert/delete）**同一事务**提交（S4）。
    """
    _ensure_ready()
    with _write_lock, _session() as conn:
        if conn.execute("SELECT 1 FROM favorites WHERE path = ?", (path,)).fetchone():
            conn.execute("DELETE FROM favorites WHERE path = ?", (path,))
            _outbox_add(conn, _changes.for_favorite(path, _changes.OP_DELETE))
            return False
        conn.execute("INSERT INTO favorites (path) VALUES (?)", (path,))
        _outbox_add(conn, _changes.for_favorite(path, _changes.OP_UPSERT))
        return True


def favorites_remove(paths: list[str]) -> None:
    """批量移除收藏（无匹配则不动）"""
    _ensure_ready()
    paths = [p for p in paths if p]
    if not paths:
        return
    with _write_lock, _session() as conn:
        for p in paths:
            if conn.execute("SELECT 1 FROM favorites WHERE path = ?", (p,)).fetchone() is None:
                continue  # 无匹配不动：不产生无对象的 outbox 行
            conn.execute("DELETE FROM favorites WHERE path = ?", (p,))
            _outbox_add(conn, _changes.for_favorite(p, _changes.OP_DELETE))


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
    """全量重写歌单（等价原 JSON save 语义；单事务原子写）

    与 outbox 同一事务：按前后差异补记歌单结构 / 歌单项的 upsert/delete（S4）。
    """
    _ensure_ready()
    before = playlists_load()
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
        _outbox_add(conn, _changes.for_playlists(before, playlists))


def playlists_remove_paths(paths: list[str]) -> None:
    """从所有歌单移除给定路径（无匹配则不动）"""
    _ensure_ready()
    paths = [p for p in paths if p]
    if not paths:
        return
    with _write_lock, _session() as conn:
        for p in paths:
            rows = conn.execute(
                "SELECT playlist_id FROM playlist_songs WHERE path = ?", (p,)
            ).fetchall()
            if not rows:
                continue
            conn.execute("DELETE FROM playlist_songs WHERE path = ?", (p,))
            _outbox_add(
                conn,
                [
                    change
                    for item in rows
                    for change in _changes.for_playlist_item(
                        item["playlist_id"], p, _changes.OP_DELETE, 0
                    )
                ],
            )


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
    """追加一条播放记录；超 PLAYBACK_LIMIT 删最旧（单事务）

    与 outbox 同一事务：补记 play_history upsert（跨端行键 = 相对路径 + 播放时刻毫秒）。
    """
    _ensure_ready()
    with _write_lock, _session() as conn:
        conn.execute(
            "INSERT INTO playback_events "
            "(ts, path, name, artist, album, played, duration, ratio, completed, source, mode, device) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            _playback_row(record),
        )
        _outbox_add(conn, _changes.for_play_history(record))
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


# ============ track_fingerprints（局域网同步 S2：内容指纹缓存） ============
# 相对曲库根路径 → 音频文件字节 SHA-256（小写 hex）。惰性计算 + 落库，size/mtime_ms
# 为缓存失效依据。web 端曲库是文件系统扫描结果（无 songs 表），故独立成表。
def track_fingerprints_load() -> dict[str, dict]:
    """全部指纹缓存：相对路径 → {content_hash, size, mtime_ms}（惰性指纹链路读侧）"""
    _ensure_ready()
    with _session() as conn:
        rows = conn.execute(
            "SELECT relative_path, content_hash, size, mtime_ms FROM track_fingerprints"
        ).fetchall()
    return {
        r["relative_path"]: {
            "content_hash": r["content_hash"],
            "size": int(r["size"]),
            "mtime_ms": int(r["mtime_ms"]),
        }
        for r in rows
    }


def track_fingerprint_get(relative_path: str) -> dict | None:
    """单条指纹缓存；未指纹返回 None（单文件惰性路径用）"""
    _ensure_ready()
    with _session() as conn:
        row = conn.execute(
            "SELECT content_hash, size, mtime_ms FROM track_fingerprints WHERE relative_path = ?",
            (relative_path,),
        ).fetchone()
    if row is None:
        return None
    return {
        "content_hash": row["content_hash"],
        "size": int(row["size"]),
        "mtime_ms": int(row["mtime_ms"]),
    }


def track_fingerprints_upsert(rows: list[dict]) -> int:
    """批量写入/更新指纹（单事务原子写；返回写入条数）。

    每条 = {relative_path, content_hash, size, mtime_ms}；relative_path / content_hash
    为空串的条目跳过（缓存里不存在「空指纹」态——尚未指纹就是没有行）。
    与其它写路径共用 _write_lock，避免与重扫 / 迁移并发写冲突。
    """
    _ensure_ready()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    items = [
        (
            str(r.get("relative_path", "")),
            str(r.get("content_hash", "")),
            int(r.get("size", 0) or 0),
            int(r.get("mtime_ms", 0) or 0),
            now,
        )
        for r in rows
        if str(r.get("relative_path", "")) and str(r.get("content_hash", ""))
    ]
    if not items:
        return 0
    with _write_lock, _session() as conn:
        conn.executemany(
            "INSERT INTO track_fingerprints "
            "(relative_path, content_hash, size, mtime_ms, updated_at) VALUES (?,?,?,?,?) "
            "ON CONFLICT(relative_path) DO UPDATE SET "
            "content_hash=excluded.content_hash, size=excluded.size, "
            "mtime_ms=excluded.mtime_ms, updated_at=excluded.updated_at",
            items,
        )
    return len(items)


# ============ 局域网同步（S2, S4）播放数据变更日志 ============
# 表：sync_outbox（本端变更留痕）/ sync_cursor（拉取游标）/ sync_push_cursor（推送游标）
#     / sync_pending_change（本地缺歌挂起）。语义契约见 docs/lan-sync-protocol.md §14。
#
# 纪律（与 Swift `SyncChangeLogStore` 同口径）：
# - **业务写入点在同一事务内追加 outbox**（本模块的 favorites/playlists/playback 写函数
#   自己调 `_outbox_add`），业务行回滚则 outbox 一并回滚 —— 绝不先改业务行后补 outbox
#   （丢变更）或先记 outbox 后业务失败（假变更）。
# - 两张游标表**方向相反，绝不可复用**：`sync_cursor` = 本端已消费的**对端**位置（拉取），
#   `sync_push_cursor` = 本端**已推给对端**的本端位置（推送）。
# - 取页返回 `last_outbox_id` = **本批实际末行 id**（与取批同一读事务内取值）：分页下
#   不会把本批没发出的行永久越过；空批不推进（§14.6 S1 口径）。
# - delete 行本地照常留痕，但**不上线**（过滤在同步层，见 app/lansync/changelog.py）。
#
# 纯存储层：不做删除传播判定、不做 LWW、不做 content_hash 映射（都在 lansync 层）。


def _now_ms() -> int:
    """当前时刻（毫秒 since 1970，UTC 无关）。"""
    return int(time.time() * 1000)


def iso_to_ms(text: str) -> int:
    """ISO8601 文本 → 毫秒（解析失败/为空 → 0）。

    播放记录 `ts` 列存的是 ISO 文本；跨端 LWW 与行键需要毫秒整数（§14.7）。
    支持带时区与不带时区两种形态（不带时区按本地时区解释，与写入侧一致）。
    """
    raw = str(text or "").strip()
    if not raw:
        return 0
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return 0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def _outbox_add(conn: sqlite3.Connection, rows: list[dict]) -> None:
    """**在调用方事务内**追加 outbox 行（业务写点专用；rows 由 lansync 层构造）。

    行字段：entity / row_key / op / updated_at / payload_json（后两项可缺省）。
    """
    if not rows:
        return
    conn.executemany(
        "INSERT INTO sync_outbox (entity, row_key, op, updated_at, payload_json) VALUES (?,?,?,?,?)",
        [
            (
                str(r["entity"]),
                str(r["row_key"]),
                str(r["op"]),
                int(r.get("updated_at") or _now_ms()),
                r.get("payload_json"),
            )
            for r in rows
        ],
    )


def sync_outbox_append(rows: list[dict]) -> int:
    """追加 outbox 行（独立事务；仅同步层补记用，业务写点走 `_outbox_add`）。返回条数。"""
    _ensure_ready()
    if not rows:
        return 0
    with _write_lock, _session() as conn:
        _outbox_add(conn, rows)
    return len(rows)


def sync_outbox_page(after: int = 0, limit: int = 500) -> dict:
    """取一页增量 + 本批实际末行 id（**同一读事务**内取值，§14.6）。

    返回 `{"rows": [行字典…], "last_outbox_id": int}`；空批 `last_outbox_id` = 传入游标。
    """
    _ensure_ready()
    start = max(0, int(after or 0))
    size = max(1, int(limit or 1))
    with _session() as conn:
        conn.execute("BEGIN")  # 两段读同一快照：批外新行不被「末尾值」越过
        rows = conn.execute(
            "SELECT id, entity, row_key, op, updated_at, payload_json FROM sync_outbox "
            "WHERE id > ? ORDER BY id LIMIT ?",
            (start, size),
        ).fetchall()
    return {
        "rows": [_outbox_row(r) for r in rows],
        "last_outbox_id": rows[-1]["id"] if rows else start,
    }


def sync_outbox_latest(refs: list[tuple[str, str]]) -> dict[tuple[str, str], dict]:
    """批量取这些 `(entity, row_key)` 的本端最新行（对账代表本端事实，避免 N+1）。

    同键多行时取 `updated_at` 最大、平局取 `id` 最大（= 最新落库）；本端没有的键不出现。
    """
    _ensure_ready()
    wanted = {(str(e), str(k)) for e, k in refs}
    if not wanted:
        return {}
    by_entity: dict[str, list[str]] = {}
    for entity, row_key in wanted:
        by_entity.setdefault(entity, []).append(row_key)
    result: dict[tuple[str, str], dict] = {}
    with _session() as conn:
        for entity, keys in by_entity.items():
            placeholders = ",".join("?" for _ in keys)
            rows = conn.execute(
                "SELECT id, entity, row_key, op, updated_at, payload_json FROM sync_outbox "
                f"WHERE entity = ? AND row_key IN ({placeholders}) "
                "ORDER BY updated_at DESC, id DESC",
                (entity, *keys),
            ).fetchall()
            for row in rows:
                key = (row["entity"], row["row_key"])
                if key not in result:  # 降序 → 首次出现即最新行
                    result[key] = _outbox_row(row)
    return result


def sync_outbox_load(entities: list[str] | None = None) -> list[dict]:
    """按实体取全部 outbox 行（outbox id 升序；「跟歌走」按行内歌曲引用过滤用）。

    与 Swift `SyncPlaybackCarryDatabaseFacts.playbackRows` 同口径：取全量再按歌曲引用
    过滤（web 侧 outbox 规模 = 本地变更数，不做复杂索引；需要时后续加列）。
    """
    _ensure_ready()
    sql = "SELECT id, entity, row_key, op, updated_at, payload_json FROM sync_outbox"
    params: tuple = ()
    if entities:
        placeholders = ",".join("?" for _ in entities)
        sql += f" WHERE entity IN ({placeholders})"
        params = tuple(str(e) for e in entities)
    sql += " ORDER BY id"
    with _session() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_outbox_row(r) for r in rows]


def sync_outbox_max_id() -> int:
    """本端 outbox 当前最大 id（无行 = 0）。"""
    _ensure_ready()
    with _session() as conn:
        return int(conn.execute("SELECT COALESCE(MAX(id), 0) FROM sync_outbox").fetchone()[0])


def _outbox_row(row: sqlite3.Row) -> dict:
    """outbox 行 → 字典（键名与线上列表一致，供同步层直接消费）。"""
    return {
        "id": int(row["id"]),
        "entity": row["entity"],
        "row_key": row["row_key"],
        "op": row["op"],
        "updated_at": int(row["updated_at"]),
        "payload_json": row["payload_json"],
    }


# ---- 游标（两张表，方向相反，绝不可合表） ----
def sync_cursor_get(peer_id: str) -> int:
    """本端已消费的**对端** outbox 位置（无记录 = 0 = 全量）。"""
    _ensure_ready()
    with _session() as conn:
        row = conn.execute(
            "SELECT last_outbox_id FROM sync_cursor WHERE peer_id = ?", (str(peer_id),)
        ).fetchone()
    return int(row["last_outbox_id"]) if row else 0


def sync_cursor_set(peer_id: str, last_outbox_id: int) -> None:
    """记录本端已消费到对端的 outbox 位置（幂等 upsert）。"""
    _ensure_ready()
    with _write_lock, _session() as conn:
        conn.execute(
            "INSERT INTO sync_cursor (peer_id, last_outbox_id) VALUES (?,?) "
            "ON CONFLICT(peer_id) DO UPDATE SET last_outbox_id = excluded.last_outbox_id",
            (str(peer_id), int(last_outbox_id)),
        )


def sync_push_cursor_get(peer_id: str) -> int:
    """本端**已推给该 peer** 的本端 outbox 位置（无记录 = 0）。"""
    _ensure_ready()
    with _session() as conn:
        row = conn.execute(
            "SELECT last_outbox_id FROM sync_push_cursor WHERE peer_id = ?", (str(peer_id),)
        ).fetchone()
    return int(row["last_outbox_id"]) if row else 0


def sync_push_cursor_set(peer_id: str, last_outbox_id: int) -> None:
    """记录本端已推给该 peer 的本端 outbox 位置（**全部批次成功**后才推进）。"""
    _ensure_ready()
    with _write_lock, _session() as conn:
        conn.execute(
            "INSERT INTO sync_push_cursor (peer_id, last_outbox_id) VALUES (?,?) "
            "ON CONFLICT(peer_id) DO UPDATE SET last_outbox_id = excluded.last_outbox_id",
            (str(peer_id), int(last_outbox_id)),
        )


# ---- 本地缺歌挂起（content_hash 映射不到本端曲目） ----
def sync_pending_add(rows: list[dict]) -> int:
    """挂起远端行（键 `(entity, content_hash, remote_row_key)`，重复挂起 = 覆盖）。"""
    _ensure_ready()
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    items = [
        (
            str(r["entity"]),
            str(r["content_hash"]),
            str(r["remote_row_key"]),
            str(r["op"]),
            int(r.get("updated_at") or 0),
            r.get("payload_json"),
            now,
        )
        for r in rows
        if str(r.get("content_hash", ""))
    ]
    if not items:
        return 0
    with _write_lock, _session() as conn:
        conn.executemany(
            "INSERT INTO sync_pending_change "
            "(entity, content_hash, remote_row_key, op, updated_at, payload_json, created_at) "
            "VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT(entity, content_hash, remote_row_key) DO UPDATE SET "
            "op = excluded.op, updated_at = excluded.updated_at, "
            "payload_json = excluded.payload_json",
            items,
        )
    return len(items)


def sync_pending_load() -> list[dict]:
    """全部挂起行（id 升序；歌到位后重放）。"""
    _ensure_ready()
    with _session() as conn:
        rows = conn.execute(
            "SELECT id, entity, content_hash, remote_row_key, op, updated_at, payload_json "
            "FROM sync_pending_change ORDER BY id"
        ).fetchall()
    return [
        {
            "id": int(r["id"]),
            "entity": r["entity"],
            "content_hash": r["content_hash"],
            "remote_row_key": r["remote_row_key"],
            "op": r["op"],
            "updated_at": int(r["updated_at"]),
            "payload_json": r["payload_json"],
        }
        for r in rows
    ]


def sync_pending_delete(ids: list[int]) -> int:
    """删除已重放/已作废的挂起行，返回删除条数。"""
    _ensure_ready()
    targets = [int(i) for i in ids or []]
    if not targets:
        return 0
    with _write_lock, _session() as conn:
        conn.executemany("DELETE FROM sync_pending_change WHERE id = ?", [(i,) for i in targets])
    return len(targets)


# ---- 远端胜出行的本地应用（只落 upsert 快照；绝不删本地行，§14.9） ----
def sync_apply_favorite(path: str) -> None:
    """应用远端收藏（幂等：已存在则不动；web 收藏行无时间戳列）。"""
    _ensure_ready()
    if not path:
        return
    with _write_lock, _session() as conn:
        conn.execute("INSERT OR IGNORE INTO favorites (path) VALUES (?)", (str(path),))


def sync_apply_play_history(path: str, played_at_ms: int, play_duration_ms: int) -> None:
    """应用远端播放历史：按 `(path, ts)` 匹配本地行，存在则更新时长，不存在则插入。

    web 侧 `ts` 是 ISO 文本，跨端行键用毫秒 —— 这里由毫秒回写 ISO（同一时刻的唯一表示）。
    """
    _ensure_ready()
    if not path:
        return
    ts = datetime.fromtimestamp(max(0, int(played_at_ms)) / 1000, tz=timezone.utc).isoformat(
        timespec="seconds"
    )
    duration = max(0.0, int(play_duration_ms) / 1000)
    with _write_lock, _session() as conn:
        existing = conn.execute(
            "SELECT id FROM playback_events WHERE path = ? AND ts = ? LIMIT 1", (str(path), ts)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE playback_events SET duration = ? WHERE id = ?", (duration, existing["id"])
            )
            return
        conn.execute(
            "INSERT INTO playback_events "
            "(ts, path, name, artist, album, played, duration, ratio, completed, source, mode, device) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (ts, str(path), "", "", "", 0.0, duration, 0.0, 0, "sync", "continuous", ""),
        )


def sync_apply_playlist(playlist_id: str, name: str, created_at: str, updated_at: str) -> None:
    """应用远端歌单结构（幂等 upsert；本地已有的项不动，项级由 playlist_item 收敛）。"""
    _ensure_ready()
    if not playlist_id:
        return
    with _write_lock, _session() as conn:
        conn.execute(
            "INSERT INTO playlists (id, name, createdAt, updatedAt) VALUES (?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt",
            (str(playlist_id), str(name), str(created_at), str(updated_at)),
        )


def sync_apply_playlist_item(playlist_id: str, path: str, position: int) -> None:
    """应用远端歌单项：本地无该歌单则**跳过**（结构收敛由 playlist upsert 先行保证）。"""
    _ensure_ready()
    if not playlist_id or not path:
        return
    with _write_lock, _session() as conn:
        if (
            conn.execute("SELECT 1 FROM playlists WHERE id = ?", (str(playlist_id),)).fetchone()
            is None
        ):
            return
        existing = conn.execute(
            "SELECT id FROM playlist_songs WHERE playlist_id = ? AND path = ? LIMIT 1",
            (str(playlist_id), str(path)),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE playlist_songs SET position = ? WHERE id = ?",
                (int(position), existing["id"]),
            )
            return
        conn.execute(
            "INSERT INTO playlist_songs (playlist_id, path, position) VALUES (?,?,?)",
            (str(playlist_id), str(path), int(position)),
        )


def track_fingerprint_by_hash(content_hash: str) -> dict | None:
    """`content_hash` → 首个入库的本地指纹行（同 hash 多行取 rowid 最小 = 最早入库）。

    跨端身份 → 本端身份的反向映射（协议 §14.8 接收侧）：两端对同一 hash 得到**确定性**
    的同一条本地曲目（与 Swift `SyncContentHashResolver.trackStableId` 的 `ORDER BY id LIMIT 1`
    同口径，差在 web 用 rowid 而非主键 id）。
    """
    _ensure_ready()
    if not content_hash:
        return None
    with _session() as conn:
        row = conn.execute(
            "SELECT relative_path, content_hash, size, mtime_ms, updated_at "
            "FROM track_fingerprints WHERE content_hash = ? ORDER BY rowid LIMIT 1",
            (str(content_hash),),
        ).fetchone()
    if row is None:
        return None
    return {
        "relative_path": row["relative_path"],
        "content_hash": row["content_hash"],
        "size": int(row["size"]),
        "mtime_ms": int(row["mtime_ms"]),
        "updated_at": row["updated_at"],
    }
