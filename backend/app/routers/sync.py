"""iOS companion 同步 API：manifest 全量清单 + ops 双向增量（last-write-wins）。

- GET  /api/sync/manifest —— 全量元数据清单（songs/playlists/favorites/books/dicts + 版本号）
- POST /api/sync/ops —— 客户端 push dirty 队列（逐条应用 + 追加 ops 日志）
- GET  /api/sync/ops?since= —— 拉增量（id > since，append-only 游标）
- GET  /api/sync/dicts/file —— dicts 目录下词典文件下载（manifest dicts 按需下载用）

鉴权：/api/sync/* 不在白名单 → 由中间件自动覆盖（localhost 免鉴权，其余需 Bearer token），
这里不写鉴权逻辑。
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app import db, state
from app.services import sync as sync_service

router = APIRouter()

_DICT_EXTS = {".mdx", ".mdd"}


@router.get("/api/sync/manifest")
def api_sync_manifest():
    """全量元数据清单（客户端启动/前台恢复/手动刷新时拉取）"""
    return sync_service.build_manifest()


@router.post("/api/sync/ops")
def api_sync_ops(body: dict):
    """客户端 push dirty 队列：body {"ops": [{entity, entity_id, op, payload, ts}, ...]}

    任一 op 非法 → 400 整批拒绝（不部分应用）；合法则逐条应用并追加 ops 日志。
    返回 {"applied": n, "cursor": 最新 ops id}。
    """
    if not isinstance(body, dict) or not isinstance(body.get("ops"), list):
        raise HTTPException(400, "缺少 ops 数组")
    try:
        sync_service.validate_ops(body["ops"])
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    applied, cursor = sync_service.apply_ops(body["ops"])
    return {"applied": applied, "cursor": cursor}


@router.get("/api/sync/ops")
def api_sync_ops_pull(since: int = Query(0, ge=0, description="游标：返回 id > since 的增量")):
    """拉增量：id > since 的 ops（升序），客户端重放后记 cursor，下次 since=cursor"""
    ops = db.ops_list_since(since)
    cursor = ops[-1]["id"] if ops else since
    return {"ops": ops, "cursor": cursor}


@router.get("/api/sync/dicts/file")
def api_sync_dicts_file(path: str = ""):
    """dicts 目录下词典文件下载（path 相对 DICTS_DIR；防目录穿越；仅 .mdx/.mdd）"""
    rel = Path(path or "")
    if not rel.name or rel.is_absolute() or ".." in rel.parts:
        raise HTTPException(400, "非法路径")
    if rel.suffix.lower() not in _DICT_EXTS:
        raise HTTPException(400, "仅支持 .mdx / .mdd 文件")
    base = state.DICTS_DIR.resolve()
    target = (base / rel).resolve()
    if target.parent != base and base not in target.parents:
        raise HTTPException(400, "非法路径")
    if not target.is_file():
        raise HTTPException(404, "文件不存在")
    return FileResponse(str(target))
