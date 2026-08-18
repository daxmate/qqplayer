"""词典域路由：MDX/MDD 词典配置 / 扫描 / 上传 / 激活 / 启停 / 删除 / 查询 / 资源 / 词频。

配置存 settings.json 的 dict namespace（dictionaries 数组 + activeDictId），
词典文件本身不动（local = 用户指定路径；uploaded = DATA_DIR/dicts/ 下 <uuid>.mdx/.mdd）。
词条查询失败（词典打开失败，含 iCloud dataless 占位）返回 200 + error 字段，不 500。
"""

import contextlib
import re
import time
import uuid
from pathlib import Path
from typing import Annotated

import send2trash
from fastapi import APIRouter, File, HTTPException, Response, UploadFile

from app import state
from app.services import dict_reader
from app.services import settings as settings_service

router = APIRouter()

_UPLOAD_CHUNK = 1024 * 1024  # 上传流式写入块大小（牛津 mdd 可达 1GB+，禁止整文件进内存）
_UPLOAD_EXTS = {".mdx", ".mdd"}

# 资源 Content-Type（契约指定；未列出的扩展名一律 octet-stream）
_CONTENT_TYPES = {
    ".css": "text/css",
    ".js": "application/javascript",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".mp3": "audio/mpeg",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

# 发音 label 启发式：路径含 us/amer → 美音，uk/brit → 英音，其余默认 英（契约示例默认）
_AUDIO_LABEL_RE = re.compile(r"(?:^|/)(us|amer|uk|brit)")


def _load_dict_settings() -> dict:
    return dict(settings_service.load_all_settings()["dict"])


def _save_dict_settings(dictionaries: list, active_dict_id: str) -> None:
    settings_service.save_all_settings(
        {"dict": {"dictionaries": dictionaries, "activeDictId": active_dict_id}}
    )


def _find_dict(dictionaries: list[dict], did: str) -> dict | None:
    return next((d for d in dictionaries if d.get("id") == did), None)


def _detect_role(filename: str) -> str:
    """role 自动检测：文件名（不含扩展名）含 coca/frequency → frequency，否则 define"""
    stem = Path(filename).stem.lower()
    return "frequency" if ("coca" in stem or "frequency" in stem) else "define"


def _content_type(relpath: str) -> str:
    return _CONTENT_TYPES.get(Path(relpath).suffix.lower(), "application/octet-stream")


def _audio_label(relpath: str) -> str:
    m = _AUDIO_LABEL_RE.search(relpath.lower())
    return "美" if m and m.group(1) in ("us", "amer") else "英"


# ============ 配置 ============
@router.get("/api/dict")
def api_dict_get():
    """词典配置全量（settings dict namespace 原样返回）"""
    s = _load_dict_settings()
    return {"dictionaries": s["dictionaries"], "activeDictId": s["activeDictId"]}


@router.post("/api/dict/scan")
def api_dict_scan(body: dict):
    """扫描路径（文件或目录，目录递归一层）中的 .mdx 文件，返回候选列表"""
    raw = (body.get("path") or "").strip()
    if not raw:
        raise HTTPException(400, "path 必填")
    p = Path(raw)
    if not p.exists():
        raise HTTPException(404, "path not found")
    files: list[Path] = []
    if p.is_file():
        files = [p] if p.suffix.lower() == ".mdx" else []
    else:
        try:
            files = [f for f in p.iterdir() if f.is_file() and f.suffix.lower() == ".mdx"]
            for d in p.iterdir():  # 目录递归一层
                if d.is_dir():
                    with contextlib.suppress(OSError):
                        files.extend(
                            f for f in d.iterdir() if f.is_file() and f.suffix.lower() == ".mdx"
                        )
        except OSError:
            pass
    out = []
    for f in sorted(files, key=lambda x: x.name.lower()):
        try:
            size = f.stat().st_size
        except OSError:
            size = 0
        out.append(
            {
                "path": str(f),
                "name": f.stem,
                "size": size,
                "mddExists": f.with_suffix(".mdd").exists(),
            }
        )
    return out


@router.post("/api/dict")
def api_dict_add(body: dict):
    """添加本地路径词典（kind=local，role 自动检测）；重复 path 409，非法 path 400"""
    raw = (body.get("path") or "").strip()
    if not raw.lower().endswith(".mdx"):
        raise HTTPException(400, "path 必须是 .mdx 文件")
    p = Path(raw)
    if not p.exists():
        raise HTTPException(400, "path not found")
    s = _load_dict_settings()
    dictionaries = s["dictionaries"]
    norm = str(p)
    if any(d.get("path") == norm for d in dictionaries):
        raise HTTPException(409, "already added")
    name = (body.get("name") or "").strip() or p.stem
    item = {
        "id": "d_" + uuid.uuid4().hex,
        "name": name,
        "path": norm,
        "kind": "local",
        "role": _detect_role(p.name),
        "enabled": True,
        "addedAt": int(time.time() * 1000),
    }
    _save_dict_settings([*dictionaries, item], s["activeDictId"])
    return item


@router.post("/api/dict/upload")
async def api_dict_upload(file: Annotated[UploadFile, File()]):
    """上传 mdx/mdd（流式 1MB 分块写 DATA_DIR/dicts/）；mdd 按上传文件名匹配补挂已有配置"""
    filename = (file.filename or "").strip()
    ext = Path(filename).suffix.lower()
    if ext not in _UPLOAD_EXTS:
        raise HTTPException(400, "仅支持 .mdx / .mdd 文件")
    state.DICTS_DIR.mkdir(parents=True, exist_ok=True)
    fname = uuid.uuid4().hex + ext
    dest = state.DICTS_DIR / fname
    try:
        with dest.open("wb") as out:
            while True:  # 大文件流式写入，不一次性进内存
                chunk = await file.read(_UPLOAD_CHUNK)
                if not chunk:
                    break
                out.write(chunk)
    except OSError as e:
        raise HTTPException(500, f"写入失败: {e}") from None
    s = _load_dict_settings()
    dictionaries = s["dictionaries"]
    if ext == ".mdx":
        item = {
            "id": "d_" + fname[:-4],  # 文件 uuid 与配置 id 一致：mdd 上传后按 uuid 补挂
            "name": Path(filename).stem,
            "path": str(dest),
            "kind": "uploaded",
            "role": _detect_role(filename),
            "enabled": True,
            "addedAt": int(time.time() * 1000),
        }
        _save_dict_settings([*dictionaries, item], s["activeDictId"])
        return item
    # .mdd：匹配 kind=uploaded 且 name 相同的配置（xxx.mdd → name=xxx），存成同 uuid 文件名
    stem = Path(filename).stem
    for d in dictionaries:
        if d.get("kind") == "uploaded" and d.get("name") == stem:
            target = state.DICTS_DIR / f"{d['id'][2:]}.mdd"
            try:
                dest.replace(target)
            except OSError as e:
                raise HTTPException(500, f"写入失败: {e}") from None
            return d
    return {"ok": True}


@router.post("/api/dict/activate")
def api_dict_activate(body: dict):
    """设置激活词典（查词缺省目标）"""
    did = body.get("id")
    if not isinstance(did, str) or not did:
        raise HTTPException(400, "id 必填")
    s = _load_dict_settings()
    if _find_dict(s["dictionaries"], did) is None:
        raise HTTPException(404, "词典不存在")
    _save_dict_settings(s["dictionaries"], did)
    return {"activeDictId": did}


@router.patch("/api/dict/{dict_id}")
def api_dict_patch(dict_id: str, body: dict):
    """启停切换：body {"enabled": bool}"""
    enabled = body.get("enabled")
    if not isinstance(enabled, bool):
        raise HTTPException(400, "enabled 必须是布尔值")
    s = _load_dict_settings()
    d = _find_dict(s["dictionaries"], dict_id)
    if d is None:
        raise HTTPException(404, "词典不存在")
    d["enabled"] = enabled
    _save_dict_settings(s["dictionaries"], s["activeDictId"])
    return d


@router.delete("/api/dict/{dict_id}")
def api_dict_delete(dict_id: str):
    """删除词典配置；kind=uploaded 同时删 DATA_DIR/dicts/ 下对应文件；activeDictId 被删则清空"""
    s = _load_dict_settings()
    dictionaries = s["dictionaries"]
    d = _find_dict(dictionaries, dict_id)
    if d is None:
        raise HTTPException(404, "词典不存在")
    active = s["activeDictId"]
    if active == dict_id:
        active = ""
    if d.get("kind") == "uploaded":
        cid = d["id"][2:]
        for ext in (".mdx", ".mdd"):
            f = state.DICTS_DIR / f"{cid}{ext}"
            try:
                if f.exists():
                    send2trash.send2trash(str(f))
            except Exception:
                pass  # 移废纸篓失败不阻断（文件留原地）
    _save_dict_settings([x for x in dictionaries if x.get("id") != dict_id], active)
    return Response(status_code=204)


# ============ 查询 ============
@router.get("/api/dict/query")
def api_dict_query(word: str = "", dictId: str = ""):
    """查词：word 必填，dictId 缺省用 activeDictId，再缺省用第一个 enabled 的 define 词典

    词典打开失败（文件不存在/权限/iCloud dataless 占位）→ 200 + error 字段，不 500。
    """
    word = word.strip()
    if not word:
        raise HTTPException(400, "word 必填")
    s = _load_dict_settings()
    dictionaries = s["dictionaries"]
    target = None
    if dictId:
        target = _find_dict(dictionaries, dictId)
        if target is None:
            raise HTTPException(404, "词典不存在")
    else:
        if s["activeDictId"]:
            target = _find_dict(dictionaries, s["activeDictId"])
        if target is None:
            target = next(
                (d for d in dictionaries if d.get("enabled") and d.get("role") == "define"),
                None,
            )
    if target is None:
        return {
            "word": word,
            "found": False,
            "html": "",
            "source": "",
            "audio": [],
            "frequency": None,
            "error": "no dictionary configured",
        }
    try:
        mdx = dict_reader.get_dict(target["path"])
        html = mdx.lookup(word)
        if html is None:
            html = mdx.lookup_variants(word)
        found = html is not None
        return {
            "word": word,
            "found": found,
            "html": html or "",
            "source": target["name"] if found else "",
            "audio": _extract_audio(html or "", target, mdx) if found else [],
            "frequency": _frequency_of(dictionaries, word),
        }
    except dict_reader.MdxLoadError as e:
        dict_reader.evict(target["path"])  # iCloud 下载完成后下次查询可重试
        return {
            "word": word,
            "found": False,
            "html": "",
            "source": "",
            "audio": [],
            "frequency": None,
            "error": f"dict load failed: {e}",
        }


def _extract_audio(html: str, cfg: dict, mdx: dict_reader.MdxDict) -> list[dict]:
    """词条 HTML 中的音频引用（mdd 内存在资源才暴露 URL，最多 2 个）"""
    out = []
    for ref in dict_reader.extract_audio_refs(html)[:2]:
        try:
            if mdx.resource(ref) is None:
                continue
        except dict_reader.MdxLoadError:
            continue
        out.append(
            {
                "label": _audio_label(ref),
                "url": f"/api/dict/resource/{cfg['id']}/{ref}",
            }
        )
    return out


def _frequency_of(dictionaries: list[dict], word: str) -> dict | None:
    """词频：第一个 enabled 且 role=frequency 的词典，未命中/无词典返回 None"""
    fdict = next(
        (d for d in dictionaries if d.get("enabled") and d.get("role") == "frequency"),
        None,
    )
    if fdict is None:
        return None
    try:
        mdx = dict_reader.get_dict(fdict["path"])
        html = mdx.lookup(word)
        if html is None:
            html = mdx.lookup_variants(word)
        if html is None:
            return None
        rank = dict_reader.parse_rank(html)
        if rank is None:
            return None
        return {"rank": rank, "total": mdx.keys_count}
    except dict_reader.MdxLoadError:
        return None


@router.get("/api/dict/frequency")
def api_dict_frequency(word: str = ""):
    """词频查询（独立接口）：无 frequency 词典/未命中 → rank/total 均为 null"""
    word = word.strip()
    s = _load_dict_settings()
    fdict = next(
        (d for d in s["dictionaries"] if d.get("enabled") and d.get("role") == "frequency"),
        None,
    )
    if fdict is None or not word:
        return {"rank": None, "total": None}
    try:
        mdx = dict_reader.get_dict(fdict["path"])
        html = mdx.lookup(word)
        if html is None:
            html = mdx.lookup_variants(word)
        if html is None:
            return {"rank": None, "total": None}
        rank = dict_reader.parse_rank(html)
        if rank is None:
            return {"rank": None, "total": None}
        return {"rank": rank, "total": mdx.keys_count}
    except dict_reader.MdxLoadError:
        return {"rank": None, "total": None}


@router.get("/api/dict/resource/{dict_id}/{path:path}")
def api_dict_resource(dict_id: str, path: str):
    """mdd 资源字节（css/js/img/音频），按扩展名给 Content-Type"""
    s = _load_dict_settings()
    d = _find_dict(s["dictionaries"], dict_id)
    if d is None:
        raise HTTPException(404, "词典不存在")
    try:
        mdx = dict_reader.get_dict(d["path"])
        data = mdx.resource(path)
    except dict_reader.MdxLoadError as e:
        raise HTTPException(404, f"词典加载失败: {e}") from None
    if data is None:
        raise HTTPException(404, "资源不存在")
    return Response(content=data, media_type=_content_type(path))
