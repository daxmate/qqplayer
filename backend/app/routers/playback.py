"""播放记录 / 桌面歌词迷你窗状态路由。

- /api/playback(POST 上报 / GET 列表 / GET stats 统计；SQLite playback_events 表持久化)
- /api/now-playing(GET/POST)、/api/player/action、/api/player/actions
- /api/mini/status(GET/POST)
"""

import time
from datetime import datetime, timezone

from fastapi import APIRouter

from app import db, state

router = APIRouter()


def _load_playback() -> list[dict]:
    """加载全部播放记录（SQLite；空库返回空列表）"""
    return db.playback_all()


def _append_playback(record: dict):
    """追加一条播放记录；超过 PLAYBACK_LIMIT 时删最旧（db 层单事务 + 全局写锁）"""
    db.playback_append(record)


def _playback_record(body: dict) -> dict | None:
    """校验并规整一条播放记录；非法/误触（< PLAYBACK_MIN_SECONDS）返回 None"""
    path = str(body.get("path", "")).strip()
    played = float(body.get("played", 0) or 0)
    if not path or played < state.PLAYBACK_MIN_SECONDS:
        return None
    try:
        duration = float(body.get("duration", 0) or 0)
        ratio = float(body.get("ratio", 0) or 0)
    except (TypeError, ValueError):
        duration, ratio = 0.0, 0.0
    record = {
        "ts": body.get("ts") or datetime.now(timezone.utc).isoformat(),
        "path": path,
        "name": str(body.get("name", "") or ""),
        "artist": str(body.get("artist", "") or ""),
        "album": str(body.get("album", "") or ""),
        "played": round(played, 1),
        "duration": round(duration, 1),
        "ratio": round(ratio, 4),
        "completed": bool(body.get("completed", False)),
        "source": str(body.get("source", "manual") or "manual"),
        "mode": str(body.get("mode", "continuous") or "continuous"),
        "device": str(body.get("device", "") or ""),
    }
    return record


@router.post("/api/playback")
async def api_playback(body: dict):
    """上报一条播放记录（切歌/暂停/播完时前端调用）"""
    record = _playback_record(body)
    if record is None:
        return {"ok": False, "reason": "invalid"}
    _append_playback(record)
    return {"ok": True}


@router.get("/api/playback")
def api_playback_list():
    """返回全部播放记录（按时间倒序，最新在前）"""
    records = _load_playback()
    records.sort(key=lambda r: r.get("ts", ""), reverse=True)
    return {"records": records, "count": len(records), "limit": state.PLAYBACK_LIMIT}


@router.get("/api/playback/stats")
def api_playback_stats():
    """播放统计聚合：每首歌的播放次数/最近播放/总时长/完成度（喂每日三首推荐）"""
    stats: dict[str, dict] = {}
    for r in _load_playback():
        path = r.get("path", "")
        s = stats.setdefault(
            path,
            {
                "path": path,
                "name": r.get("name", ""),
                "artist": r.get("artist", ""),
                "album": r.get("album", ""),
                "plays": 0,
                "totalPlayed": 0.0,
                "lastPlayed": "",
                "completed": 0,
            },
        )
        s["plays"] += 1
        s["totalPlayed"] = round(s["totalPlayed"] + r.get("played", 0), 1)
        if r.get("completed"):
            s["completed"] += 1
        ts = r.get("ts", "")
        if ts > s["lastPlayed"]:
            s["lastPlayed"] = ts
    songs = sorted(stats.values(), key=lambda s: s["lastPlayed"], reverse=True)
    return {"count": len(songs), "songs": songs}


# ============ 桌面歌词/迷你窗：主页面状态上报 + 播放控制指令队列 ============
@router.post("/api/now-playing")
def api_now_playing_post(body: dict):
    """主页面状态上报（桌面歌词/迷你窗轮询读取；迷你窗控制靠 /api/player/action 队列）"""
    with state._now_playing_lock:
        state._now_playing["path"] = str(body.get("path") or "") or None
        state._now_playing["name"] = str(body.get("name") or "") or None
        state._now_playing["artist"] = str(body.get("artist") or "") or None
        state._now_playing["duration"] = float(body.get("duration") or 0) or 0.0
        state._now_playing["currentTime"] = float(body.get("currentTime") or 0) or 0.0
        state._now_playing["isPlaying"] = bool(body.get("isPlaying"))
        state._now_playing["volume"] = (
            float(body.get("volume") if body.get("volume") is not None else 1.0) or 0.0
        )
        state._now_playing["lineIndex"] = int(body.get("lineIndex") or -1)
        state._now_playing["accent"] = (
            str(body.get("accent") or "") or None
        )  # 强调色（跟随主题配色用）
        state._now_playing["updatedAt"] = time.time()
    return {"ok": True}


@router.get("/api/now-playing")
def api_now_playing_get():
    """返回当前播放状态（悬浮窗 500ms 轮询）"""
    with state._now_playing_lock:
        return dict(state._now_playing)


@router.post("/api/player/action")
def api_player_action_post(body: dict):
    """迷你窗控制指令入队（主播放器页面轮询 /api/player/actions 取走执行）"""
    action = str(body.get("action") or "")
    if action not in state._PLAYER_ACTIONS:
        return {"ok": False, "reason": "unknown_action"}
    value = body.get("value")
    if action in ("seek", "volume") and not isinstance(value, (int, float)):
        return {"ok": False, "reason": "value_required"}
    if action == "seek":
        value = max(0.0, float(value))
    if action == "volume":
        value = min(1.0, max(0.0, float(value)))
    with state._player_actions_lock:
        state._player_actions.append({"action": action, "value": value})
    return {"ok": True}


@router.get("/api/player/actions")
def api_player_actions_get():
    """主播放器页面轮询：取走并清空全部待执行指令"""
    with state._player_actions_lock:
        actions = list(state._player_actions)
        state._player_actions.clear()
    return {"actions": actions}


@router.post("/api/mini/status")
def api_mini_status_post(body: dict):
    """迷你窗 Swift 壳上报运行状态（启动 running=true，退出 running=false）"""
    running = body.get("running")
    if not isinstance(running, bool):
        return {"ok": False, "reason": "running_required"}
    with state._mini_status_lock:
        state._mini_status["running"] = running
    return {"ok": True}


@router.get("/api/mini/status")
def api_mini_status_get():
    """迷你窗当前是否在运行（主页面顶栏开关轮询点亮）"""
    with state._mini_status_lock:
        return dict(state._mini_status)
