"""夸克网盘 provider（歌曲海下载源）

能力:
- 扫码登录：login_qrcode() 生成二维码 → 前端展示，login_status(qr_id) 由前端每 2s
  轮询一次 → 扫码成功拿 service_ticket → 换会话 Cookie → 持久化到本地文件
- 分享解析：resolve_share(share_url) 匿名列文件（sharepage/token + sharepage/detail，
  目录型分享递归进入，深度 ≤3，翻页 + 去重）
- 音质挑选：pick_file(files, quality)，mp3（默认）/ flac 可选，找不到偏好格式自动降级
- 下载直链：get_download_url(...) 登录后把分享文件换成签名直链（~10min 有效）
- refresh_puus()：刷新 __puus 会话 cookie（约 2h 过期，alist#830 方案）

网络层全部用 httpx（项目已有依赖，不引入 requests）。Cookie 存独立本地文件
（与 backend.py 的 DATA_DIR 一致），不进任何前端可见的设置接口。

⚠️ get_download_url 未真实联调：没有真实登录 cookie 无法离线验证分享下载接口。
实现参照 alist quark_uc 驱动（POST /1/clouddrive/file/download 的请求约定：
pr=ucpro&fr=pc、Cookie/Referer/UA 头、data[0].download_url 响应）+
社区侦察的分享下载写法（POST /1/clouddrive/download/list，body 带
include_fids/include_fids_token/pwd_id/stoken）。真实扫码登录后的联调由 maintainer 完成。
"""

import base64
import contextlib
import io
import json
import os
import re
import threading
import uuid
from pathlib import Path

import httpx
import qrcode

# ---------------- 常量 ----------------

# 夸克客户端 UA：服务器校验，非客户端 UA 部分接口返回 404 混淆
QUARK_CLIENT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 "
    "Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch"
)
# 浏览器 UA：仅用于 uop.quark.cn 扫码登录流程（网页端 weblogin）
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

DRIVE_API_BASE = "https://drive-pc.quark.cn/1/clouddrive"
PAN_BASE = "https://pan.quark.cn"
UOP_BASE = "https://uop.quark.cn"
QR_SCAN_PAGE = "https://su.quark.cn/4_eMHBJ"
REFERER = "https://pan.quark.cn/"

# Cookie 文件：与 backend.py 的 DATA_DIR 一致（~Library/Application Support/qqplayer）
COOKIE_FILE = (
    Path(os.path.expanduser("~"))
    / "Library"
    / "Application Support"
    / "qqplayer"
    / "quark_cookies.json"
)

QR_CLIENT_ID = "532"
QR_EXPIRE_SECONDS = 170  # 二维码 TTL（服务端 ~170s）
POLL_TIMEOUT = 15.0

MAX_SHARE_DEPTH = 3  # 目录递归深度上限，防炸
SHARE_PAGE_SIZE = 50

# 可接受的音频扩展（小写，带点）
AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".wav", ".ape", ".ogg", ".aac", ".wma", ".opus"}

_SHARE_URL_RE = re.compile(r"pan\.quark\.cn/s/([0-9A-Za-z]+)", re.IGNORECASE)

# ---------------- 内部状态 ----------------

# qr_id → 二维码 token（进程内有效；进程重启后查不到 → login_status 返回 error）
_QR_TOKENS: dict[str, str] = {}

_client_lock = threading.Lock()
_drive_client: httpx.Client | None = None


# ---------------- 客户端与 Cookie 存取 ----------------


def _new_drive_client() -> httpx.Client:
    """drive.quark.cn / pan.quark.cn 客户端（夸克客户端 UA + Referer，测试可注入）"""
    return httpx.Client(
        headers={"User-Agent": QUARK_CLIENT_UA, "Referer": REFERER},
        timeout=POLL_TIMEOUT,
    )


def _new_anon_client() -> httpx.Client:
    """uop.quark.cn 扫码登录流程的匿名客户端（浏览器 UA，测试可注入）"""
    return httpx.Client(headers={"User-Agent": BROWSER_UA}, timeout=POLL_TIMEOUT)


def _get_drive_client() -> httpx.Client:
    """返回带本地 cookie 的 drive 客户端；每次调用都从 COOKIE_FILE 重载，
    保证登录态变更（扫码登录/退出）立即可见。"""
    global _drive_client
    with _client_lock:
        if _drive_client is None or _drive_client.is_closed:
            _drive_client = _new_drive_client()
        _drive_client.cookies.clear()
        _load_cookies_into(_drive_client)
        return _drive_client


def _load_cookies_into(client: httpx.Client) -> None:
    """把 COOKIE_FILE 的 cookie 灌进 client.cookies（httpx.Cookies 是 MutableMapping）"""
    try:
        data = json.loads(COOKIE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if isinstance(data, dict):
        client.cookies.update(data)


def _persist_cookies(client: httpx.Client) -> None:
    """把 client.cookies 持久化到 COOKIE_FILE（0600 权限，原子写入）"""
    COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(dict(client.cookies), ensure_ascii=False, indent=2)
    tmp = COOKIE_FILE.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, COOKIE_FILE)
    print(
        f"[quark] persist {len(dict(client.cookies))} cookies -> {COOKIE_FILE} (exists={COOKIE_FILE.exists()})",
        flush=True,
    )


def _clear_cookie_file() -> None:
    with contextlib.suppress(OSError):
        COOKIE_FILE.unlink(missing_ok=True)


# ---------------- 扫码登录 ----------------


def login_qrcode() -> dict:
    """生成扫码登录二维码。

    返回 {"qr_image": "data:image/png;base64,xxx", "qr_id": str, "expires_in": 170}
    qr_id 是 request_id（uuid4 字符串），用于后续 login_status() 轮询。
    """
    request_id = uuid.uuid4().hex
    with _new_anon_client() as client:
        resp = client.get(
            f"{UOP_BASE}/cas/ajax/getTokenForQrcodeLogin",
            params={"client_id": QR_CLIENT_ID, "v": "1.2", "request_id": request_id},
        )
        resp.raise_for_status()
        payload = resp.json()
    token = ((payload.get("data") or {}).get("members") or {}).get("token")
    if not token:
        raise RuntimeError(f"获取扫码 token 失败: {payload.get('message') or payload}")

    qr_id = str(uuid.uuid4())
    _QR_TOKENS[qr_id] = token

    # 二维码内容 URL（与网页端 weblogin 一致，uc_biz_str 已按服务端要求编码）
    qr_url = (
        f"{QR_SCAN_PAGE}?token={token}&client_id={QR_CLIENT_ID}&ssb=weblogin"
        "&uc_param_str=&uc_biz_str=S%3Acustom%7COPT%3ASAREA%400%7COPT%3AIMMERSIVE%401%7COPT%3ABACK_BTN_STYLE%400"
    )
    img = qrcode.make(qr_url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    qr_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return {
        "qr_image": f"data:image/png;base64,{qr_b64}",
        "qr_id": qr_id,
        "expires_in": QR_EXPIRE_SECONDS,
    }


def login_status(qr_id: str) -> dict:
    """轮询扫码状态（内部最多轮询一次，前端每 2s 调一次本函数）。

    返回 {"status": "waiting"|"ok"|"expired"|"error", "nickname": str|None}
    ok 时已把登录 Cookie 持久化到 COOKIE_FILE。
    """
    token = _QR_TOKENS.get(qr_id)
    if not token:
        return {"status": "error", "message": "登录会话已失效，请重新扫码"}
    request_id = uuid.uuid4().hex
    try:
        with _new_anon_client() as client:
            resp = client.get(
                f"{UOP_BASE}/cas/ajax/getServiceTicketByQrcodeToken",
                params={
                    "client_id": QR_CLIENT_ID,
                    "v": "1.2",
                    "request_id": request_id,
                    "token": token,
                },
            )
            resp.raise_for_status()
            payload = resp.json()
    except httpx.HTTPError as exc:
        return {"status": "error", "message": f"轮询扫码状态失败: {exc}"}

    status = payload.get("status")
    if status == 2000000:
        ticket = ((payload.get("data") or {}).get("members") or {}).get("service_ticket")
        if not ticket:
            return {"status": "error", "message": "登录响应缺少 service_ticket"}
        return _exchange_ticket(ticket)
    if status == 50004001:
        return {"status": "waiting"}
    if status == 50004002:
        _QR_TOKENS.pop(qr_id, None)
        return {"status": "expired", "message": "二维码已过期，请重新扫码"}
    return {"status": "error", "message": payload.get("message") or f"未知状态: {status}"}


def _exchange_ticket(service_ticket: str) -> dict:
    """用 service_ticket 换会话 Cookie（GET pan.quark.cn/account/info，自动收 Set-Cookie），
    成功后持久化到本地。"""
    with _new_anon_client() as client:
        resp = client.get(
            f"{PAN_BASE}/account/info",
            params={"st": service_ticket, "lw": "scan"},
        )
        resp.raise_for_status()
        payload = resp.json()
    print(
        f"[quark] exchange_ticket success={payload.get('success')} "
        f"resp_cookies={list(resp.cookies.keys())} client_cookies={list(client.cookies.keys())}",
        flush=True,
    )
    if not payload.get("success"):
        return {"status": "error", "message": payload.get("message") or "扫码登录失败"}
    _persist_cookies(client)
    nickname = (payload.get("data") or {}).get("nickname")
    return {"status": "ok", "nickname": nickname}


def login_state() -> dict:
    """检查是否已登录。

    cookie 文件存在且冒烟通过（account/info 200 且 success）才算 logged_in；
    401/失败时清掉失效 cookie 返回 False。
    """
    if not COOKIE_FILE.exists():
        return {"logged_in": False, "nickname": None}
    try:
        client = _get_drive_client()
        resp = client.get(f"{PAN_BASE}/account/info")
        if resp.status_code == 200:
            payload = resp.json()
            if payload.get("success"):
                return {
                    "logged_in": True,
                    "nickname": ((payload.get("data") or {}).get("nickname")),
                }
        # 401 / success=false → cookie 已失效
        _clear_cookie_file()
    except (httpx.HTTPError, ValueError):
        # 网络抖动等瞬时错误：不删 cookie，下次再试
        pass
    return {"logged_in": False, "nickname": None}


def logout() -> None:
    """删除本地 cookie 文件"""
    _clear_cookie_file()
    with _client_lock:
        if _drive_client is not None:
            _drive_client.cookies.clear()


# ---------------- 分享解析（匿名） ----------------


def _pwd_id_from_url(share_url: str) -> str:
    m = _SHARE_URL_RE.search(share_url or "")
    if not m:
        raise ValueError(f"无效的夸克分享链接: {share_url}")
    return m.group(1)


def _get_share_stoken(pwd_id: str) -> str:
    """匿名取分享 stoken（POST share/sharepage/token）"""
    client = _get_drive_client()
    resp = client.post(
        f"{DRIVE_API_BASE}/share/sharepage/token",
        params={"pr": "ucpro", "fr": "pc"},
        json={
            "pwd_id": pwd_id,
            "passcode": "",
            "support_visit_limit_private_share": True,
        },
        headers={"Origin": "https://pan.quark.cn", "Content-Type": "application/json"},
    )
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("code") != 0:
        raise RuntimeError(f"获取分享 token 失败: {payload.get('message')}")
    stoken = ((payload.get("data") or {}).get("stoken")) or ""
    if not stoken:
        raise RuntimeError("分享 token 响应缺少 stoken")
    return stoken


def _list_share_dir(pwd_id: str, stoken: str, pdir_fid: str) -> tuple[list[dict], int]:
    """列分享目录单层（翻页），返回 (items, total)；失败抛异常由调用方兜底"""
    client = _get_drive_client()
    items: list[dict] = []
    total = 0
    page = 1
    while True:
        resp = client.get(
            f"{DRIVE_API_BASE}/share/sharepage/detail",
            params={
                "ver": "2",
                "pwd_id": pwd_id,
                "stoken": stoken,
                "pdir_fid": pdir_fid,
                "force": "0",
                "_page": page,
                "_size": SHARE_PAGE_SIZE,
                "_fetch_total": "1",
                "_sort": "file_type:asc,updated_at:desc",
                "pr": "ucpro",
                "fr": "pc",
            },
        )
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("code") != 0:
            raise RuntimeError(f"分享目录列表失败: {payload.get('message')}")
        data = payload.get("data") or {}
        batch = data.get("list") or []
        items.extend(batch)
        total = (payload.get("metadata") or {}).get("_total") or len(items)
        if not batch or len(items) >= total or len(batch) < SHARE_PAGE_SIZE:
            break
        page += 1
    return items, total


def _is_dir_item(item: dict) -> bool:
    """判断分享列表项是否为目录。

    真实夸克接口有 dir 布尔字段（社区 quark-share-downloader 只认它）；
    旧 mock/其他来源可能只有 format_type 字符串（"folder"/"dir"），兜底兼容。
    file_type 数字语义不稳定（实测文件=1），不作为判据。
    """
    if not isinstance(item, dict):
        return False
    d = item.get("dir")
    if isinstance(d, bool):
        return d
    fmt = item.get("format_type")
    if isinstance(fmt, str) and fmt.strip().lower() in ("folder", "dir"):
        return True
    ft = item.get("file_type")
    return isinstance(ft, str) and ft.strip().lower() in ("dir", "folder")


def _ext_of(file_name: str) -> str:
    """从文件名取小写扩展名（带点，如 .mp3；无扩展名返回 ''）"""
    return Path(file_name or "").suffix.lower()


def _walk_share(
    pwd_id: str,
    stoken: str,
    pdir_fid: str,
    depth: int,
    files: list[dict],
    seen: set[str],
) -> None:
    """递归列分享目录；深度 > MAX_SHARE_DEPTH 不再进入，fid 去重"""
    if depth > MAX_SHARE_DEPTH:
        return
    items, _total = _list_share_dir(pwd_id, stoken, pdir_fid)
    for item in items:
        fid = item.get("fid")
        if not fid or fid in seen:
            continue
        seen.add(fid)
        files.append(
            {
                "fid": fid,
                "file_name": item.get("file_name", ""),
                "size": item.get("size", 0),
                "format_type": (item.get("format_type") or "").lower(),
                "share_fid_token": item.get("share_fid_token") or item.get("fid_token") or "",
                "ext": _ext_of(item.get("file_name", "")),
            }
        )
        if _is_dir_item(item):
            _walk_share(pwd_id, stoken, fid, depth + 1, files, seen)


def resolve_share(share_url: str) -> list[dict]:
    """匿名解析夸克分享链接（不需要登录）。

    返回文件列表 [{fid, file_name, size, format_type, share_fid_token, ext}]，
    目录型分享递归进入（深度 ≤3）；无文件/失败返回 []。
    """
    files, _stoken = resolve_share_verbose(share_url)
    return files


def resolve_share_verbose(share_url: str) -> tuple[list[dict], str]:
    """resolve_share + 返回本次解析使用的 stoken。

    ⚠️ share_fid_token 绑定本次 stoken：下载直链必须用同一个 stoken
    （新 stoken + 旧 fid_token → 41020 转存文件token校验异常）。
    """
    try:
        pwd_id = _pwd_id_from_url(share_url)
        stoken = _get_share_stoken(pwd_id)
        files: list[dict] = []
        _walk_share(pwd_id, stoken, "0", 1, files, set())
        return files, stoken
    except (ValueError, httpx.HTTPError, RuntimeError, KeyError):
        return [], ""


# ---------------- 音质挑选 ----------------


def pick_file(files: list[dict], quality: str) -> dict | None:
    """按音质偏好挑文件。

    quality="flac" → 优先 .flac；否则优先 .mp3（也可接受 .m4a/.wav 等音频扩展）。
    找不到偏好格式 → 降级另一格式；全无 → None。同格式多个时取 size 最大的。
    """
    if not files:
        return None
    prefer_flac = (quality or "").strip().lower() == "flac"
    primary, fallback = (".flac", ".mp3") if prefer_flac else (".mp3", ".flac")

    def _ext(f: dict) -> str:
        return f.get("ext") or Path(f.get("file_name") or "").suffix.lower()

    candidates = [f for f in files if _ext(f) == primary]
    if not candidates:
        candidates = [f for f in files if _ext(f) == fallback]
    if not candidates:
        # 最后兜底：任何音频扩展
        candidates = [f for f in files if _ext(f) in AUDIO_EXTS]
    if not candidates:
        return None
    return max(candidates, key=lambda f: f.get("size", 0))


# ---------------- 下载直链（登录后） ----------------


def get_download_url(
    share_url: str, fid: str, share_fid_token: str, stoken: str
) -> tuple[str, dict]:
    """登录后把分享文件换成下载直链。

    返回 (download_url, download_headers)——直链签名绑定获取时的 cookie/UA，
    下载请求头必须与之一致（否则 412 Precondition Failed）。
    stoken 必须与 share_fid_token 同源（来自同一次 resolve_share_verbose），
    否则 41020 转存文件token校验异常。
    实现对齐社区 quark-share-downloader（POST /file/download，fids/fids_token）。
    未登录（cookie 文件不存在/已失效）抛 RuntimeError("quark login required")。
    """
    if not COOKIE_FILE.exists():
        raise RuntimeError("quark login required")
    pwd_id = _pwd_id_from_url(share_url)
    client = _get_drive_client()
    resp = client.post(
        f"{DRIVE_API_BASE}/file/download",
        params={"entry": "ft", "fr": "pc", "pr": "ucpro"},
        json={
            "fids": [fid],
            "fids_token": [share_fid_token],
            "pwd_id": pwd_id,
            "stoken": stoken,
        },
    )
    if resp.status_code in (401, 403):
        # ⚠️ 不删 cookie 文件（保留现场便于诊断）：401/403 可能是凭证不全或参数问题，
        # 未必是登录失效；删文件会导致扫码-下载-重扫死循环。
        print(
            f"[quark] download/list HTTP {resp.status_code} body={resp.text[:300]} cookies={list(client.cookies.keys())}",
            flush=True,
        )
        raise RuntimeError("quark login required")
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("status") != 200 and payload.get("code") != 0:
        raise RuntimeError(f"获取下载直链失败: {payload.get('message')}")
    data = payload.get("data") or []
    if not data or not data[0].get("download_url"):
        raise RuntimeError("下载直链响应缺少 download_url")
    # 下载头快照：与获取直链的请求一致（UA/Cookie/Referer），直链签名绑定它们
    cookie_str = "; ".join(f"{k}={v}" for k, v in client.cookies.items())
    headers = {
        "User-Agent": QUARK_CLIENT_UA,
        "Referer": REFERER,
        "Origin": "https://pan.quark.cn",
        "Cookie": cookie_str,
    }
    return data[0]["download_url"], headers


# ---------------- 会话 cookie 刷新 ----------------


def refresh_puus() -> None:
    """刷新 __puus 会话 cookie（约 2h 过期）。

    发一次不带 __puus 的 GET /1/clouddrive/config（alist#830 方案），服务端会
    重新下发 __puus；只有确认重新下发才持久化，避免误删旧值。失败静默。
    """
    try:
        if not COOKIE_FILE.exists():
            return
        client = _new_drive_client()
        try:
            _load_cookies_into(client)
            client.cookies.pop("__puus", None)  # 不带 __puus 请求，触发服务端重发
            resp = client.get(
                f"{DRIVE_API_BASE}/config",
                params={"pr": "ucpro", "fr": "pc"},
            )
            if resp.status_code == 200 and "__puus" in resp.cookies:
                _persist_cookies(client)
        finally:
            client.close()
    except Exception:
        # 刷新失败：忽略，下次调用自然恢复
        pass
