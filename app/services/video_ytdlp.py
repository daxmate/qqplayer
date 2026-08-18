"""yt-dlp CLI 封装：在线视频统一引擎（解析 / 直链 / 字幕 / 下载）。

可执行文件选择（二选一，按顺序）：
1. 当前 Python 环境 venv 里安装的 yt-dlp CLI（``<venv>/bin/yt-dlp``，
   主仓库 venv 已 ``pip install yt-dlp==2026.07.04`` 锁版本）；
2. PATH 上的系统 yt-dlp（如 ``/opt/homebrew/bin/yt-dlp``，2026.07.04）。

所有调用统一 subprocess + timeout，失败抛 ``RuntimeError`` 带 stderr 摘要；
一律 ``--no-playlist`` 防误下整个播放列表。
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import httpx

from app.services import download as download_service

# ---- 可执行文件定位 ----
_STDERR_SUMMARY_LIMIT = 300  # 错误信息里 stderr 摘要长度上限
RESOLVE_TIMEOUT = 60.0
STREAM_TIMEOUT = 60.0
SUBS_TIMEOUT = 60.0
DOWNLOAD_TIMEOUT = 600.0
SUBTITLE_FETCH_TIMEOUT = 30.0

# 浏览器 UA（部分 CDN/字幕接口拒绝空 UA 或非浏览器 UA）
_UA = download_service.DOWNLOAD_UA


def _find_ytdlp_bin() -> str | None:
    """定位 yt-dlp 可执行文件：优先 venv 脚本，其次 PATH（macOS 常见 /opt/homebrew/bin/yt-dlp）。

    ⚠️ 不能对 sys.executable 用 .resolve()：venv/bin/python 是 symlink，resolve 后 parent
    指向 base python 的 MacOS/ 目录，会漏掉 venv/bin/yt-dlp；launchd 环境 PATH 无
    homebrew，shutil.which 兜底也找不到 → 整体误判无 CLI（2026-08-17 线上实测）。
    """
    venv_candidate = Path(sys.executable).parent / "yt-dlp"
    if venv_candidate.is_file():
        return str(venv_candidate)
    return shutil.which("yt-dlp")


YTDLP_BIN = _find_ytdlp_bin()


def _stderr_summary(stderr: str) -> str:
    """stderr 摘要：优先取 ERROR: 行原文；无则截断原文"""
    text = (stderr or "").strip()
    for line in text.splitlines():
        m = re.search(r"ERROR:\s*(.+)", line)
        if m:
            text = m.group(1)
            break
    return text[:_STDERR_SUMMARY_LIMIT]


def _run(
    args: list[str],
    timeout: float,
    what: str,
    cookie: str | None = None,
    browser: str | None = None,
) -> subprocess.CompletedProcess:
    """subprocess 边界：执行 yt-dlp CLI；非零退出/超时抛 RuntimeError（带 stderr 摘要）

    - cookie 非空时附加 ``--add-header "Cookie: <cookie>"``（list 传参，无 shell 注入；
      值只进 subprocess argv，不进日志/错误信息/返回数据）；
    - cookie 为空且 browser 非空时附加 ``--cookies-from-browser <browser>``
      （读浏览器登录态 Cookie；两者不冲突，手动 cookie 优先）。
    """
    if not YTDLP_BIN:
        raise RuntimeError("未找到 yt-dlp CLI，请先 pip install yt-dlp")
    cmd = [YTDLP_BIN, *args]
    if cookie:
        cmd += ["--add-header", f"Cookie: {cookie}"]
    elif browser:
        cmd += ["--cookies-from-browser", browser]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"yt-dlp {what}超时（>{timeout:.0f}s）") from None
    except OSError as e:
        raise RuntimeError(f"yt-dlp 执行失败: {e}") from None
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp {what}失败: {_stderr_summary(proc.stderr)}")
    return proc


def _dump_info(
    url: str,
    timeout: float,
    what: str,
    cookie: str | None = None,
    browser: str | None = None,
) -> dict:
    """--dump-json 拿单个视频完整信息（--no-playlist，最后一个非空行为 JSON）"""
    proc = _run(
        ["--dump-json", "--no-playlist", "--no-warnings", url], timeout, what, cookie, browser
    )
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError(f"yt-dlp {what}失败: 输出为空")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as e:
        raise RuntimeError(f"yt-dlp {what}失败: 输出非 JSON（{e}）") from None


# ============ 对外 API ============


def resolve(
    url: str,
    timeout: float = RESOLVE_TIMEOUT,
    cookie: str | None = None,
    browser: str | None = None,
) -> dict:
    """解析单个视频（--no-playlist），返回元信息摘要 {title, webpage_url, duration, thumbnail, formats}。

    formats 为可播放格式摘要列表（只含有 url 的格式，字段：
    format_id/ext/height/width/fps/vcodec/acodec/abr/note/filesize）。
    cookie 可选：B站等站点匿名访问拿不到音视频合并格式（DASH 分离），带 Cookie 才有。
    browser 可选：非空时读浏览器登录态 Cookie（--cookies-from-browser），与 cookie 二选一。
    """
    info = _dump_info(url, timeout, "解析", cookie, browser)
    formats = []
    for f in info.get("formats") or []:
        if not f.get("url"):
            continue
        formats.append(
            {
                "format_id": f.get("format_id"),
                "ext": f.get("ext"),
                "height": f.get("height"),
                "width": f.get("width"),
                "fps": f.get("fps"),
                "vcodec": f.get("vcodec"),
                "acodec": f.get("acodec"),
                "abr": f.get("abr"),
                "note": f.get("format_note"),
                "filesize": f.get("filesize"),
                "url": f.get("url"),
            }
        )
    return {
        "title": info.get("title"),
        "webpage_url": info.get("webpage_url") or info.get("original_url"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "formats": formats,
    }


def _select_format(format_hint: str | None) -> str:
    """format 选择器：默认 best 优先音视频合并格式（浏览器 <video> 可直接播），避免 -g 输出 DASH 分离多行"""
    hint = (format_hint or "").strip()
    if not hint or hint == "best":
        return "best[acodec!=none][vcodec!=none]/best"
    return hint


def get_stream(
    url: str,
    format_hint: str | None = "best",
    timeout: float = STREAM_TIMEOUT,
    cookie: str | None = None,
    browser: str | None = None,
) -> str:
    """yt-dlp -g -f <format> 拿播放直链（第一行）；直链有时效，失效需重新调用

    cookie 可选：直链生成带 Cookie（部分站点直链校验 cookie）。
    browser 可选：读浏览器登录态 Cookie（--cookies-from-browser）。
    """
    fmt = _select_format(format_hint)
    proc = _run(
        ["--get-url", "-f", fmt, "--no-playlist", "--no-warnings", url],
        timeout,
        "直链获取",
        cookie,
        browser,
    )
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError("yt-dlp 直链获取失败: 输出为空")
    return lines[0]


def pick_best_format(formats: list[dict], format_hint: str | None = "best") -> dict:
    """从 resolve() 的 formats 摘要里选最佳格式：

    - format_hint 指定 format_id 时优先精确匹配；
    - 默认优先音视频合并格式（acodec/vcodec 均非 none，浏览器可直接播），
      无合并格式则退回全部格式按清晰度（height 降序，同清晰度优先 mp4）取最佳。
    """
    if not formats:
        raise RuntimeError("解析结果无可用格式")
    hint = (format_hint or "").strip()
    if hint and hint != "best":
        for f in formats:
            if str(f.get("format_id")) == hint:
                return f
    combined = [
        f
        for f in formats
        if (f.get("acodec") or "none") != "none" and (f.get("vcodec") or "none") != "none"
    ]
    pool = combined or formats

    def _key(f: dict):
        return (f.get("height") or 0, 1 if f.get("ext") == "mp4" else 0)

    return max(pool, key=_key)


def pick_best_audio_format(formats: list[dict]) -> dict:
    """从 resolve() 的 formats 摘要里选最佳纯音频轨（acodec != none，DASH 分离流音频轨）：

    - 优先按 abr 降序（B站音频轨带 abr，如 30280=320k > 30232=192k > 30216=132k）；
    - 无 abr 的格式按 format_id 数字降序（如 30280 > 30232 > 30216）兜底。
    无任何音频轨抛 RuntimeError。
    """
    audio = [f for f in formats if (f.get("acodec") or "none") != "none"]
    if not audio:
        raise RuntimeError("解析结果无可用音频轨")

    def _key(f: dict):
        abr = f.get("abr")
        if isinstance(abr, (int, float)) and not isinstance(abr, bool):
            return (1, float(abr))
        digits = "".join(ch for ch in str(f.get("format_id") or "") if ch.isdigit())
        return (0, float(digits) if digits else 0.0)

    return max(audio, key=_key)


def get_subtitles(
    url: str,
    timeout: float = SUBS_TIMEOUT,
    cookie: str | None = None,
    browser: str | None = None,
) -> list[dict] | None:
    """可用字幕列表 [{lang, name, url, data, automatic}]（站点字幕 + 自动生成字幕）；无字幕返回 None

    data：部分站点（如 B站 CC）字幕内容由 yt-dlp 内嵌（SRT 文本）而非独立 url，
    有 data 时无需再拉取字幕文件。cookie 可选：部分站点字幕接口需登录态。
    browser 可选：读浏览器登录态 Cookie（--cookies-from-browser）。
    """
    info = _dump_info(url, timeout, "字幕获取", cookie, browser)
    subs: list[dict] = []
    for automatic, source in (
        (False, info.get("subtitles")),
        (True, info.get("automatic_captions")),
    ):
        for lang, entries in (source or {}).items():
            if not entries:
                continue
            entry = entries[0]  # 每语言取第一个可用条目
            subs.append(
                {
                    "lang": lang,
                    "name": entry.get("name") or lang,
                    "url": entry.get("url"),
                    "data": entry.get("data"),
                    "automatic": automatic,
                }
            )
    return subs or None


def download(
    url: str,
    dest_dir: str | Path,
    filename: str,
    format_hint: str | None = "best",
    timeout: float = DOWNLOAD_TIMEOUT,
    cookie: str | None = None,
    browser: str | None = None,
) -> Path:
    """yt-dlp 下载到本地：-f best 合并格式，-o <dest_dir>/<filename>.%(ext)s；返回实际落盘文件路径

    cookie/browser 可选：见 _run（手动 cookie 优先，否则 --cookies-from-browser）。
    """
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    safe_name = download_service._sanitize_filename(filename) or "video"
    out_tmpl = str(dest_dir / f"{safe_name}.%(ext)s")
    _run(
        [
            "-f",
            _select_format(format_hint),
            "-o",
            out_tmpl,
            "--no-playlist",
            "--no-warnings",
            "--no-progress",
            url,
        ],
        timeout,
        "下载",
        cookie,
        browser,
    )
    matches = sorted(dest_dir.glob(f"{safe_name}.*"))
    if not matches:
        raise RuntimeError("yt-dlp 下载完成但未找到输出文件")
    return matches[0]


# ============ 字幕内容 ============


def parse_subtitle_content(text: str, fmt: str = "auto") -> list[dict]:
    """字幕内容 → [{start, end, text, translation}]（translation 本轮恒 None）。

    fmt: json（B站 CC：{"body":[{from,to,content}]}）/ srt / vtt / auto（按内容探测）。
    无法识别的格式返回 []。
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    stripped = text.strip()
    if not stripped:
        return []
    if fmt == "auto":
        if stripped.startswith("{"):
            fmt = "json"
        elif stripped.startswith("WEBVTT"):
            fmt = "vtt"
        elif "-->" in stripped:
            fmt = "srt"
        else:
            return []
    if fmt == "json":
        return _parse_bili_json(text)
    if fmt == "vtt":
        return _parse_timed_text(text, vtt=True)
    if fmt == "srt":
        return _parse_timed_text(text, vtt=False)
    return []


def _parse_bili_json(text: str) -> list[dict]:
    """B站 CC 字幕 JSON：{"body": [{"from": 秒, "to": 秒, "content": "..."}]}"""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    items = []
    for seg in data.get("body") or []:
        start = seg.get("from")
        end = seg.get("to")
        content = seg.get("content")
        if start is None or end is None or not content:
            continue
        items.append(
            {"start": float(start), "end": float(end), "text": str(content), "translation": None}
        )
    return items


_TIME_RE = re.compile(
    r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*"
    r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})"
)


def _ts(parts: tuple) -> float:
    """时间分组 → 秒（分组：时? 分 秒 毫秒；时分组缺失时为 None）"""
    if parts[0] is None:  # 无小时分组（mm:ss.ms）
        h, m, s, ms = 0, int(parts[1]), int(parts[2]), int(parts[3])
    else:
        h, m, s, ms = (int(p) for p in parts)
    return h * 3600 + m * 60 + s + ms / 1000


def _strip_tags(line: str) -> str:
    """去掉 SRT/VTT 常见行内标签（<i> 等），压缩空白"""
    return re.sub(r"<[^>]+>", "", line).strip()


def _parse_timed_text(text: str, vtt: bool) -> list[dict]:
    """SRT / VTT 通用解析（时间行 --> 分隔；VTT 跳过 WEBVTT 头与 NOTE 块）"""
    items = []
    blocks = re.split(r"\n\s*\n", text)
    for block in blocks:
        lines = [ln.strip() for ln in block.split("\n")]
        lines = [ln for ln in lines if ln and not (vtt and ln.upper() == "WEBVTT")]
        if not lines:
            continue
        if vtt and lines[0].upper().startswith("NOTE"):
            continue
        if vtt and " --> " not in lines[0]:
            continue
        time_idx = next((i for i, ln in enumerate(lines) if "-->" in ln), -1)
        if time_idx < 0:
            continue
        m = _TIME_RE.search(lines[time_idx])
        if not m:
            continue
        start = _ts(m.group(1, 2, 3, 4))
        end = _ts(m.group(5, 6, 7, 8))
        if end <= start:
            continue
        # VTT 序号行（纯数字）跳过；正文 = 时间行之后的非空行
        body_lines = [
            _strip_tags(ln) for ln in lines[time_idx + 1 :] if _strip_tags(ln) and not ln.isdigit()
        ]
        if not body_lines:
            continue
        items.append(
            {
                "start": start,
                "end": end,
                "text": " ".join(body_lines),
                "translation": None,
            }
        )
    return items


def fetch_subtitle(url: str, timeout: float = SUBTITLE_FETCH_TIMEOUT) -> list[dict]:
    """拉取字幕 URL 内容并解析为 items；失败抛 RuntimeError（由路由降级为空）"""
    try:
        resp = httpx.get(
            url,
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": _UA},
            trust_env=False,  # 直链/本机回环不被环境代理劫持（2026-08-16 教训）
        )
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise RuntimeError(f"字幕拉取失败: {e}") from None
    ctype = resp.headers.get("content-type", "")
    fmt = "auto"
    if "json" in ctype:
        fmt = "json"
    elif "webvtt" in ctype:
        fmt = "vtt"
    elif "srt" in ctype or "x-subrip" in ctype:
        fmt = "srt"
    return parse_subtitle_content(resp.text, fmt=fmt)
