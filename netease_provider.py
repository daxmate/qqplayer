"""网易云音乐 eapi provider（移植自 coco-downloader NeteaseOfficialProvider，TypeScript → Python）

能力:
- eapi 加密请求 / 解密响应（AES-128-ECB，key = e82ckenh8dichen8）
- search(query, limit): 歌曲搜索（POST /eapi/cloudsearch/pc）
- get_play_info(id, level): 获取播放直链（Meting 优先 → cenguigui 兜底）
- get_lyric(id): 获取歌词（POST /eapi/song/lyric/v1）

全部使用 httpx 同步 Client（模块级复用），失败策略与 TS 版一致：
search 失败返回 []，get_play_info/get_lyric 失败抛异常。
"""

import hashlib
import json
import re
import secrets

import httpx
from Crypto.Cipher import AES

# eapi 加密固定 key（16 字节）
EAPI_KEY = b"e82ckenh8dichen8"

API_DOMAIN = "https://interface.music.163.com"
LYRIC_API_URL = "https://interface3.music.163.com/eapi/song/lyric/v1"
CENGUIGUI_PLAY_API_URL = "https://api-v2.cenguigui.cn/api/netease/music_v1.php"
METING_API_URL = "https://api.qijieya.cn/meting/"

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 "
    "NeteasyMusicDesktop/3.1.19.204510"
)
DEFAULT_HEADER = {
    "os": "pc",
    "appver": "3.1.19.204510",
    "requestId": "0",
    "osver": "Microsoft-Windows-11-Home-China-build-22631-64bit",
}

DEFAULT_LEVEL = "exhigh"
VALID_LEVELS = ("standard", "exhigh", "lossless", "hires")
# 音质级别 → Meting br 参数（与 TS 版一致）
METING_BR_BY_LEVEL = {
    "standard": "128",
    "exhigh": "320",
    "lossless": "2000",
    "hires": "2000",
}

SEARCH_TIMEOUT = 15.0
LYRIC_TIMEOUT = 15.0
PLAY_INFO_TIMEOUT = 20.0

_HTTP_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


# ============ eapi 加密/解密（纯函数，可独立测试）============
def eapi_encrypt(uri: str, payload: dict) -> str:
    """eapi 请求加密：md5 摘要 + AES-128-ECB（PKCS7），返回大写 hex 作为 params 值

    报文格式: {uri}-36cd479b6b5-{json}-36cd479b6b5-{digest}
    digest = md5("nobody{uri}use{json}md5forencrypt")
    """
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    digest_text = f"nobody{uri}use{text}md5forencrypt"
    digest = hashlib.md5(digest_text.encode("utf-8")).hexdigest()
    message = f"{uri}-36cd479b6b5-{text}-36cd479b6b5-{digest}"
    cipher = AES.new(EAPI_KEY, AES.MODE_ECB)
    encrypted = cipher.encrypt(_pkcs7_pad(message.encode("utf-8"), 16))
    return encrypted.hex().upper()


def eapi_decrypt(content: bytes, content_type: str = "") -> dict:
    """解密 eapi 响应：content-type 含 json 先试 json.loads；失败则 AES 解密后解析

    密文支持两种形态：hex 字符串（部分端点）或原始二进制（cloudsearch 实测）。
    兼容两种明文：纯 JSON（服务器响应格式）与
    {uri}-36cd479b6b5-{json}-36cd479b6b5-{digest} 报文（加密/解密回环测试用）。
    """
    ct = (content_type or "").lower()
    if "json" in ct:
        try:
            return json.loads(content.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            pass
    # 密文可能是 hex 字符串（部分端点）或原始二进制（cloudsearch 实测）：
    # 只有内容整体是合法 hex 时才走 hex 解码，否则按原始字节解密
    text = content.decode("ascii", errors="ignore").strip()
    if text and len(text) % 2 == 0 and re.fullmatch(r"[0-9a-fA-F]+", text):
        encrypted = bytes.fromhex(text)
    else:
        encrypted = content
    cipher = AES.new(EAPI_KEY, AES.MODE_ECB)
    decrypted = cipher.decrypt(encrypted)
    decrypted = _pkcs7_unpad(decrypted)
    decoded = decrypted.decode("utf-8")
    marker = "-36cd479b6b5-"
    if marker in decoded:
        parts = decoded.split(marker)
        if len(parts) == 3 and parts[0].startswith("/api/"):
            decoded = parts[1]
    return json.loads(decoded)


def _pkcs7_pad(data: bytes, block_size: int) -> bytes:
    pad_len = block_size - (len(data) % block_size)
    return data + bytes([pad_len]) * pad_len


def _pkcs7_unpad(data: bytes) -> bytes:
    if not data:
        return data
    pad_len = data[-1]
    if 1 <= pad_len <= 16:
        return data[:-pad_len]
    return data


# ============ 工具函数 ============
def _format_duration(milliseconds) -> str:
    """毫秒 → "mm:ss"（不足两位补零）；非法输入返回 "" """
    if not isinstance(milliseconds, (int, float)) or isinstance(milliseconds, bool):
        return ""
    seconds = int(milliseconds) // 1000
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def _join_artists(items) -> str:
    if not isinstance(items, list):
        return ""
    return ", ".join(str(a.get("name")) for a in items if isinstance(a, dict) and a.get("name"))


def _extract_ext(url: str, fallback: str = "mp3") -> str:
    """从 URL 推断扩展名（去 query，取最后一段的末位点后缀）；推断不出用 fallback"""
    pathname = url.split("?")[0]
    name = pathname.split("/")[-1]
    if "." in name:
        ext = name.rsplit(".", 1)[-1].lower()
        if ext.isalnum() and len(ext) <= 5:
            return ext
    return fallback


def _is_http_url(value: str) -> bool:
    return bool(_HTTP_URL_RE.match(value.strip()))


def word_json_to_lrc(text: str) -> str:
    """新版逐字歌词（JSON-lines：每行 {"t": 毫秒, "c": [{"tx": 文本}]}）→ 普通 LRC

    逐行转换：JSON 对象行按 t/c 拼成 [mm:ss.xx]文本；非 JSON 行原样保留
    （老歌混排/普通 LRC 行不受影响）。转换失败原样返回。
    """
    if not isinstance(text, str) or not text.strip():
        return text or ""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            out.append("")
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            out.append(line)
            continue
        if not (isinstance(obj, dict) and isinstance(obj.get("c"), list)):
            out.append(line)
            continue
        lyric_text = "".join(
            w.get("tx", "") for w in obj["c"] if isinstance(w, dict) and w.get("tx")
        )
        t = obj.get("t") or 0
        if isinstance(t, bool) or not isinstance(t, (int, float)):
            t = 0
        t = max(0, int(t))
        sec, ms = divmod(t, 1000)
        out.append(f"[{sec // 60:02d}:{sec % 60:02d}.{ms // 10:02d}]{lyric_text}")
    return "\n".join(out)


class NeteaseProvider:
    """网易云 eapi provider（每个实例独立随机 deviceId + 独立 httpx Client）"""

    def __init__(self, client: httpx.Client | None = None):
        self.device_id = secrets.token_hex(16)
        self._client = client or httpx.Client(
            timeout=httpx.Timeout(SEARCH_TIMEOUT), follow_redirects=False
        )

    # ---- 内部：请求头 / cookie ----
    def _request_header(self) -> dict:
        return {**DEFAULT_HEADER, "deviceId": self.device_id, "MUSIC_U": ""}

    def _cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self._request_header().items())

    def _eapi_post(self, url: str, uri: str, data: dict, timeout: float = SEARCH_TIMEOUT):
        """eapi POST：加密 payload → form 提交 → 解析响应（可能为密文）"""
        encrypted = eapi_encrypt(uri, {"header": self._request_header(), "e_r": True, **data})
        resp = self._client.post(
            url,
            data={"params": encrypted},
            headers={
                "User-Agent": DEFAULT_UA,
                "Cookie": self._cookie_header(),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout=timeout,
        )
        resp.raise_for_status()
        content_type = resp.headers.get("content-type", "")
        if "json" in content_type.lower():
            try:
                return resp.json()
            except ValueError:
                pass
        return eapi_decrypt(resp.content)

    # ---- search ----
    def search(self, query: str, limit: int = 20) -> list[dict]:
        """搜索歌曲；失败返回 [] 不抛异常

        返回 [{id(str), title, artist(逗号连接), album, cover, duration("mm:ss"), level}]
        """
        try:
            payload = self._eapi_post(
                f"{API_DOMAIN}/eapi/cloudsearch/pc",
                "/api/cloudsearch/pc",
                {
                    "s": (query or "").strip(),
                    "type": 1,
                    "limit": max(1, min(50, int(limit))),
                    "offset": 0,
                    "total": True,
                },
            )
            songs = payload.get("result", {}).get("songs", [])
            if not isinstance(songs, list):
                return []
            return [item for item in (self._map_item(s) for s in songs) if item is not None]
        except (httpx.HTTPError, OSError, ValueError, KeyError, TypeError):
            return []

    def _map_item(self, song) -> dict | None:
        if not isinstance(song, dict) or song.get("id") in (None, ""):
            return None
        album = song.get("al") or song.get("album") or {}
        album = album if isinstance(album, dict) else {}
        return {
            "id": str(song["id"]),
            "title": song.get("name") or "未知歌曲",
            "artist": _join_artists(song.get("ar") or song.get("artists")) or "未知歌手",
            "album": album.get("name") or None,
            "cover": album.get("picUrl") or None,
            "duration": _format_duration(song.get("dt") or song.get("duration")),
            "level": DEFAULT_LEVEL,
        }

    # ---- get_play_info ----
    def get_play_info(self, song_id, level: str | None = None) -> dict:
        """获取播放直链：Meting 优先，cenguigui 兜底；两者都失败抛异常

        返回 {url, ext(从 URL 推断 mp3/flac), bitrate}
        """
        level = self._normalize_level(level)
        br = METING_BR_BY_LEVEL.get(level, "320")
        try:
            url = self._get_by_meting(str(song_id), br)
            bitrate = br
        except Exception:
            info = self._get_by_cenguigui(str(song_id), level)
            url = info["url"]
            bitrate = info["bitrate"]
        return {"url": url, "ext": _extract_ext(url), "bitrate": bitrate}

    def _normalize_level(self, level) -> str:
        value = str(level or DEFAULT_LEVEL).strip().lower()
        return value if value in VALID_LEVELS else DEFAULT_LEVEL

    def _get_by_meting(self, song_id: str, br: str) -> str:
        """Meting 接口：302 → Location 直链；200 → 解析 body（URL / JSON 数组 / JSON 对象）"""
        resp = self._client.get(
            METING_API_URL,
            params={"server": "netease", "type": "url", "id": song_id, "br": br},
            timeout=PLAY_INFO_TIMEOUT,
        )
        if resp.status_code == 302:
            url = str(resp.headers.get("location") or "").strip()
            if not _is_http_url(url):
                raise ValueError(f"Invalid meting redirect url: {url!r}")
            return url
        url = self._extract_meting_url(resp.text)
        if not _is_http_url(url):
            raise ValueError(f"Invalid meting url: {url!r}")
        return url

    def _extract_meting_url(self, response_text: str) -> str:
        raw = response_text.strip()
        if _is_http_url(raw):
            return raw
        try:
            payload = json.loads(raw)
        except ValueError:
            return ""
        if isinstance(payload, list) and payload and isinstance(payload[0], dict):
            return str(payload[0].get("url") or "").strip()
        if isinstance(payload, dict):
            value = payload.get("url") or payload.get("data")
            if isinstance(value, dict):
                value = value.get("url")
            return str(value or "").strip()
        return ""

    def _get_by_cenguigui(self, song_id: str, level: str) -> dict:
        """cenguigui 兜底接口：data.code==200 且 data.data.url 为 http(s)"""
        resp = self._client.get(
            CENGUIGUI_PLAY_API_URL,
            params={"id": song_id, "type": "json", "level": level},
            timeout=PLAY_INFO_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, dict) or data.get("code") != 200 or not isinstance(data.get("data"), dict):
            raise ValueError("Cenguigui parse failed")
        payload = data["data"]
        url = str(payload.get("url") or "").strip()
        if not _is_http_url(url):
            raise ValueError("Invalid cenguigui url")
        return {
            "url": url,
            "bitrate": str(payload.get("format") or "") or level,
        }

    # ---- get_lyric ----
    def get_lyric(self, song_id) -> dict:
        """获取歌词；返回 {lrc, tlyric, yrc, romalrc}（各字段可为 None，lrc/tlyric 为 {"lyric": ...}）"""
        try:
            sid = int(song_id)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid id: {song_id!r}") from None
        payload = self._eapi_post(
            LYRIC_API_URL,
            "/api/song/lyric/v1",
            {
                "id": sid,
                "cp": False,
                "tv": 0,
                "lv": 0,
                "rv": 0,
                "kv": 0,
                "yv": 0,
                "ytv": 0,
                "yrv": 0,
            },
            timeout=LYRIC_TIMEOUT,
        )
        return {
            "lrc": payload.get("lrc") if isinstance(payload.get("lrc"), dict) else None,
            "tlyric": payload.get("tlyric") if isinstance(payload.get("tlyric"), dict) else None,
            "yrc": payload.get("yrc") if isinstance(payload.get("yrc"), dict) else None,
            "romalrc": payload.get("romalrc") if isinstance(payload.get("romalrc"), dict) else None,
        }


# 模块级默认实例（deviceId 随机生成一次；路由/歌词模块直接调用模块级函数）
provider = NeteaseProvider()


def search(query: str, limit: int = 20) -> list[dict]:
    return provider.search(query, limit)


def get_play_info(song_id, level: str | None = None) -> dict:
    return provider.get_play_info(song_id, level)


def get_lyric(song_id) -> dict:
    return provider.get_lyric(song_id)
