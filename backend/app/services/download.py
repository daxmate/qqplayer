"""下载服务：文件名清洗/重名加序号/httpx 流式下载/aria2 RPC/按设置选引擎。

httpx 保持模块引用（不 from-import 函数）：测试 patch backend.httpx.stream 即
patch 全局 httpx 模块属性，本模块调用时读到新值。
"""

import re
import time
from pathlib import Path

import httpx

# 下载文件名中不允许出现的字符（跨平台安全）：/ \ : * ? " < > |
_INVALID_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')
# 流式下载时用的浏览器 UA（部分 CDN 拒绝空 UA/非浏览器 UA）
DOWNLOAD_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
DOWNLOAD_TIMEOUT = 90.0
# 夸克网盘下载超时（非会员限速 + 大文件 FLAC）：放宽到 10 分钟
QUARK_DOWNLOAD_TIMEOUT = 600.0


def _sanitize_filename(name: str) -> str:
    """文件名清洗：去掉 / \\ : * ? " < > | 与首尾空白"""
    return _INVALID_FILENAME_CHARS.sub("", str(name or "")).strip()


def _stream_download(
    url: str, dest: Path, timeout: float = DOWNLOAD_TIMEOUT, headers: dict | None = None
) -> None:
    """流式下载 url 到 dest（同名覆盖）；失败抛异常（由路由转 404）"""
    dl_headers = dict(headers or {})
    dl_headers.setdefault("User-Agent", DOWNLOAD_UA)
    with httpx.stream(
        "GET",
        url,
        timeout=timeout,
        follow_redirects=True,
        headers=dl_headers,
    ) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in resp.iter_bytes():
                f.write(chunk)


def _unique_path(p: Path) -> Path:
    """重名文件加序号：name.ext → name (1).ext"""
    if not p.exists():
        return p
    stem, ext = p.stem, p.suffix
    for i in range(1, 1000):
        cand = p.with_name(f"{stem} ({i}){ext}")
        if not cand.exists():
            return cand
    return p


def _aria2_rpc_call(rpc: str, secret: str, method: str, params: list) -> dict:
    """调本机 aria2 JSON-RPC；返回 result，错误抛 RuntimeError"""
    # trust_env=False：aria2 RPC 是本机回环地址，绝不能被环境代理（HTTP(S)_PROXY）劫持
    # （2026-08-16 实测：走代理时 localhost:6800 返回 503 → aria2 引擎静默降级 httpx）
    resp = httpx.post(
        rpc,
        json={
            "jsonrpc": "2.0",
            "id": "qqplayer",
            "method": method,
            "params": [f"token:{secret}", *params],
        },
        timeout=10.0,
        trust_env=False,
    )
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(data["error"].get("message", "aria2 error"))
    return data.get("result")


def _download_with_engine(
    url: str, dest: Path, settings: dict, headers: dict | None = None
) -> Path:
    """按设置下载引擎下载：engine=aria2 且 RPC 可用走 aria2（多线程+断点续传），
    否则（未配置/连不上/超时）自动降级内置 httpx 流式下载。
    headers：直链签名绑定的请求头（夸克 Cookie/UA/Referer），下载必须一致。"""
    dl = settings.get("download") or {}
    if (dl.get("engine") or "httpx") == "aria2":
        rpc = (dl.get("aria2Rpc") or "").strip() or "http://localhost:6800/jsonrpc"
        secret = (dl.get("aria2Secret") or "").strip()
        try:
            opts = {"dir": str(dest.parent), "out": dest.name}
            if headers:
                opts["header"] = [f"{k}: {v}" for k, v in headers.items()]
            gid = _aria2_rpc_call(rpc, secret, "aria2.addUri", [[url], opts])
            deadline = time.time() + QUARK_DOWNLOAD_TIMEOUT
            while time.time() < deadline:
                st = _aria2_rpc_call(rpc, secret, "aria2.tellStatus", [gid]) or {}
                status = st.get("status") if isinstance(st, dict) else ""
                if status == "complete":
                    return dest
                if status == "error":
                    raise RuntimeError(
                        f"aria2 下载失败: {st.get('errorMessage') or st.get('errorCode') or status}"
                    )
                time.sleep(1.0)
            raise RuntimeError("aria2 下载超时")
        except Exception:
            pass  # aria2 不可用 → 降级内置 httpx
    _stream_download(url, dest, timeout=QUARK_DOWNLOAD_TIMEOUT, headers=headers)
    return dest
