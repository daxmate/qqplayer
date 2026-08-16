"""歌词路由：加载/手动指定/搜索/AI 对齐。

- GET /api/lyric、GET/PUT/DELETE /api/lyric/manual
- GET /api/lyric/search、POST /api/lyric/align

fetch_online_lyric / auto_attach_translation 等 lyric_fetch 函数在本模块 from-import
（业务代码实际持有引用的模块）——测试 patch 本模块属性即可生效。
"""

import json
import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app import state
from app.services import library_scan, tags
from app.services import lyrics as lyrics_service
from lyric_fetch import (
    auto_attach_translation,
    delete_manual_lyric,
    fetch_online_lyric,
    load_manual_lyric,
    save_manual_lyric,
    search_lyric_candidates,
)

router = APIRouter()


@router.get("/api/lyric")
def api_lyric(path: str, prefer: str = "local"):
    """加载歌曲歌词：手动指定 > 本地 srt/lrc > 在线获取（网易云→lrclib，缓存 ~/.cache）。

    prefer=online 时在线优先（在线获取失败自动回退本地）。手动指定始终最高优先级。
    """
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")

    # 0. 用户手动指定歌词（最高优先级，不受 prefer 影响）
    manual = load_manual_lyric(str(f))
    if manual is not None:
        data = (
            lyrics_service.parse_srt(manual["text"])
            if manual["format"] == "srt"
            else lyrics_service.parse_lrc(manual["text"])
        )
        if data:
            if manual.get("tlyric"):
                data = lyrics_service.merge_translation(data, manual["tlyric"])
            return {"format": manual["format"], "lines": data, "source": "manual"}
        # 手动指定内容解析不出行：当作没指定，继续走自动链路（不删除，弹窗里可改）

    def local_lyric():
        """返回 (format, lines) 或 None"""
        cand = None
        for lext in ("srt", "lrc"):
            c = f.with_suffix("." + lext)
            if c.exists():
                cand = c
                break
        if cand is None:
            # 文件夹内唯一歌词
            siblings = [x for x in f.parent.iterdir() if x.suffix.lower() in state.LYRIC_EXTS]
            if len(siblings) == 1:
                cand = siblings[0]
        if cand is None:
            return None
        text = cand.read_text(encoding="utf-8", errors="ignore")
        lext = cand.suffix.lower().lstrip(".")
        data = lyrics_service.parse_srt(text) if lext == "srt" else lyrics_service.parse_lrc(text)
        return (lext, data)

    def online_lyric():
        """返回 (format, lines, source) 或 None"""
        artist, title, _album = tags.extract_tags(f)
        title = title or f.stem
        lrc_text, tlyric_text, source = fetch_online_lyric(title, artist or "")
        if lrc_text is None:
            return None
        lines = lyrics_service.merge_translation(lyrics_service.parse_lrc(lrc_text), tlyric_text)
        return ("lrc", lines, source)

    prefer = prefer if prefer in ("local", "online") else "local"
    if prefer == "online":
        res = online_lyric()
        if res is not None:
            return {"format": res[0], "lines": res[1], "source": res[2]}
        res = local_lyric()
        if res is not None:
            return {"format": res[0], "lines": res[1], "source": "local"}
        raise HTTPException(404, "无歌词文件")
    # 默认：本地优先
    res = local_lyric()
    if res is not None:
        return {"format": res[0], "lines": res[1], "source": "local"}
    res = online_lyric()
    if res is not None:
        return {"format": res[0], "lines": res[1], "source": res[2]}
    raise HTTPException(404, "无歌词文件")


# ============ 手动指定歌词 ============
@router.get("/api/lyric/manual")
def api_lyric_manual_get(path: str):
    """查询歌曲是否有手动指定歌词"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    manual = load_manual_lyric(str(f))
    if manual is None:
        return {"specified": False}
    return {"specified": True, **manual}


@router.put("/api/lyric/manual")
def api_lyric_manual_put(body: dict):
    """保存手动指定歌词（上传文件/在线选择/粘贴文本统一走这里，覆盖旧值）

    tlyric 可选：中文翻译 LRC（JSON 歌词上传时携带），/api/lyric 返回时合并进歌词行。
    请求体未携带 tlyric（或为空）时：自动尝试网易云翻译补全（行级文本匹配，失败/无匹配/
    无歌名歌手元数据时静默跳过，不阻塞保存；请求体显式带 tlyric 则尊重用户）。
    """
    path = (body.get("path") or "").strip()
    fmt = body.get("format") or "lrc"
    text = body.get("text") or ""
    source = body.get("source") or ""
    tlyric = body.get("tlyric") or None
    if not path:
        raise HTTPException(400, "缺少歌曲路径")
    if not text.strip():
        raise HTTPException(400, "歌词内容为空")
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    fmt = fmt if fmt in ("lrc", "srt") else "lrc"
    # 内容校验：必须能解析出歌词行，避免存了不可用的内容
    lines = lyrics_service.parse_srt(text) if fmt == "srt" else lyrics_service.parse_lrc(text)
    if not lines:
        raise HTTPException(
            400, "歌词内容解析失败，请检查格式（LRC 需 [mm:ss] 时间戳，SRT 需序号+时间轴）"
        )
    if not tlyric:
        # 自动补翻译：网易云行级匹配（仅本地歌且歌名/歌手元数据至少一项非空；失败静默）
        artist, title, _album = tags.extract_tags(f)
        title = (title or "").strip()
        artist = (artist or "").strip()
        if title or artist:
            auto = auto_attach_translation(title, artist, text, fmt)
            if auto:
                tlyric = auto
    payload = save_manual_lyric(str(f), fmt, text, source, tlyric)
    return {"ok": True, **payload}


@router.delete("/api/lyric/manual")
def api_lyric_manual_delete(path: str):
    """清除手动指定歌词，恢复自动获取"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    removed = delete_manual_lyric(str(f))
    return {"ok": True, "removed": removed}


@router.get("/api/lyric/search")
def api_lyric_search(title: str = "", artist: str = ""):
    """多源搜索歌词候选（网易云 + lrclib），供用户手动挑选"""
    title = (title or "").strip()
    if not title:
        raise HTTPException(400, "缺少搜索关键词")
    return {"results": search_lyric_candidates(title, artist or "")}


# ============ AI 歌词对齐 ============
@router.post("/api/lyric/align")
def api_lyric_align(body: dict):
    """AI 歌词对齐：纯歌词文本（无时间戳）→ 本地 ForcedAligner 生成时间戳 → LRC 字符串

    请求体: {"path": "<歌曲绝对路径>", "text": "<纯歌词文本>", "language": "ja|zh|en|...(可选)"}
    返回: {"lrc": "<LRC 字符串>", "lines": <行数>, "duration": <音频秒数>}
    """
    path = (body.get("path") or "").strip()
    text = body.get("text") or ""
    language = (body.get("language") or "").strip() or None
    if not path:
        raise HTTPException(400, "缺少歌曲路径")
    if not text.strip():
        raise HTTPException(400, "歌词内容为空")
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    align = Path(state.ALIGN_SCRIPT)
    if not align.exists():
        raise HTTPException(500, "对齐工具未安装")
    # subprocess 参数列表传参（禁止 shell 拼接）：歌词含引号/换行/特殊字符也不会注入
    cmd = [str(align), str(f), "-t", text, "-o", "json"]
    if language:
        cmd += ["-l", language]
    # launchd 托管服务的 PATH 没有 /opt/homebrew/bin，脚本内 ffprobe/ffmpeg 会找不到；
    # 这里显式把 brew bin 追加进子进程 PATH 作兜底（与 scripts/lyric-align 内兜底双保险）
    env = dict(os.environ)
    if os.path.isdir("/opt/homebrew/bin"):
        env["PATH"] = "/opt/homebrew/bin:" + env.get("PATH", "")
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=state.ALIGN_TIMEOUT, env=env
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "AI 对齐超时，请稍后重试或缩短歌词") from None
    if proc.returncode != 0:
        # stderr 尾部附进 detail 帮助排查（截断 ~500 字符）；模型下载场景给出明确指引
        stderr_text = proc.stderr or ""
        stderr_tail = " | ".join(stderr_text.strip().splitlines()[-6:])[-500:]
        detail = "AI 对齐失败，请检查音频文件与歌词内容"
        if "下载" in stderr_text or "模型" in stderr_text:
            if "请手动下载" in stderr_text or "下载失败" in stderr_text:
                detail = (
                    "AI 对齐失败：首次使用需下载对齐模型（约 1GB），自动下载未成功，"
                    f"请手动下载 {state.ALIGN_MODEL_URL} 后重试"
                )
            elif "准备下载" in stderr_text:
                detail = "AI 对齐失败：首次使用需下载对齐模型（约 1GB），请稍后重试"
            elif "未找到 API Key" in stderr_text:
                detail = "AI 对齐失败：oMLX API Key 未配置，请先在 oMLX 中登录后重试"
        if stderr_tail:
            detail += f"（{stderr_tail}）"
        raise HTTPException(500, detail)
    try:
        data = json.loads(proc.stdout or "")
        sentences = data.get("sentences") or []
    except (json.JSONDecodeError, AttributeError):
        raise HTTPException(500, "AI 对齐输出异常，请重试") from None
    lrc = lyrics_service._align_to_lrc(sentences)
    if not lrc:
        raise HTTPException(500, "AI 对齐失败，未识别到歌词行，请检查音频文件与歌词内容")
    return {"lrc": lrc, "lines": lrc.count("\n") + 1, "duration": library_scan.get_duration(f)}
