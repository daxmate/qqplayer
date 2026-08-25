"""调试日志路由：/api/debuglog（开发诊断用，内存环形缓冲）。

- POST /api/debuglog {line}  追加一行（iOS 壳原生侧上报：锁屏/线控命令到达时间线）
- GET  /api/debuglog         返回全部缓冲行（排查时直接 curl 读取）

用途：锁屏/后台场景下 WKWebView 的 JS 可能被系统挂起，前端日志不可达；
原生侧（AVPlayerBridge/WebShell）不依赖 WebView，直接把关键决策 POST 到这里，
排故时从桌面端一眼看到「命令是否到达原生、何时到达」。
注意：内存缓冲，重启清空；无鉴权（内网开发端点，同 /api/pairing 白名单定位）。
"""

from collections import deque

from fastapi import APIRouter

router = APIRouter()

_MAX_LINES = 1000
_lines: deque[str] = deque(maxlen=_MAX_LINES)


@router.post("/api/debuglog")
def api_debuglog_append(body: dict):
    """追加一行调试日志（body: {line: str}）。"""
    line = body.get("line")
    if line is None:
        return {"ok": False, "error": "missing line"}
    _lines.append(str(line))
    return {"ok": True, "len": len(_lines)}


@router.get("/api/debuglog")
def api_debuglog_read():
    """返回缓冲的全部日志行（新→旧）。"""
    return {"lines": list(_lines)}
