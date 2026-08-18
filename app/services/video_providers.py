"""在线视频源 provider 抽象 + 注册表（底层统一 yt-dlp 引擎）。

- ``VideoProvider``：name + resolve/search/get_stream/get_subtitles/download；
  search 默认抛 NotImplementedError（yt-dlp 不做搜索，B站 wbi 签名等搜索入口后置）。
- ``BiliProvider``（B站）：get_stream 自动带 settings.video.bilibiliCookie（匿名拿不到
  音视频合并格式，DASH 分离流无声）resolve 后选最佳合并格式直链；
  直链防盗链需要 Referer（由代理层经 stream_headers 附加）。
- ``GenericProvider``（自定义源）：任意链接走 yt-dlp 通用解析（resolve 支持什么就返回什么）。

注册表：``register()`` / ``get_provider(name)``；内置源在模块导入时注册。
"""

from urllib.parse import urlparse

from app.services import settings as settings_service
from app.services import video_ytdlp


class VideoProvider:
    """在线视频源抽象基类：所有方法收 url（粘贴链接），底层统一 yt-dlp"""

    name = "generic"
    display_name = "通用"

    def resolve(self, url: str) -> dict:
        """解析视频元信息 {title, webpage_url, duration, thumbnail, formats}"""
        return video_ytdlp.resolve(url)

    def search(self, query: str, limit: int = 20) -> list[dict]:
        """搜索视频；yt-dlp 不支持搜索，各源搜索入口后置，默认抛 NotImplementedError"""
        raise NotImplementedError(f"{self.name} 搜索暂未实现（后置）")

    def get_stream(self, url: str, format_hint: str | None = "best") -> str:
        """播放直链（有时效，失效需重新调用；防盗链头见 stream_headers）"""
        return video_ytdlp.get_stream(url, format_hint)

    def get_subtitles(self, url: str) -> list[dict] | None:
        """可用字幕 [{lang, name, url, automatic}]；无字幕 None"""
        return video_ytdlp.get_subtitles(url)

    def download(self, url: str, dest_dir: str, filename: str) -> object:
        """下载到本地 dest_dir/filename.<ext>；返回落盘文件 Path"""
        return video_ytdlp.download(url, dest_dir, filename)

    def stream_headers(self, url: str) -> dict:
        """代理转发直链时需附加的请求头（防盗链 Referer 等）；默认无"""
        return {}


class GenericProvider(VideoProvider):
    """自定义源：任意 yt-dlp 支持的链接通用解析，能力 = yt-dlp resolve 能力"""

    name = "generic"
    display_name = "通用"


class BiliProvider(VideoProvider):
    """B站：get_stream/resolve/get_subtitles 自动带 Cookie（手动 bilibiliCookie 优先，
    否则 --cookies-from-browser 读浏览器登录态）；DASH 分离流用 get_dual_streams 双轨直链；
    防盗链 Referer 由 ffmpeg -headers / 代理层附加。"""

    name = "bilibili"
    display_name = "B站"
    _REFERER = "https://www.bilibili.com"
    # settings.video.cookiesFromBrowser 合法枚举（与 settings.py 白名单一致）
    _BROWSERS = ("vivaldi", "chrome", "safari", "edge", "firefox", "brave")

    def _cookie(self) -> str:
        """settings.video.bilibiliCookie：B站匿名拿不到音视频合并格式（DASH 分离流无声），带 Cookie 才有"""
        return (settings_service.load_all_settings().get("video") or {}).get("bilibiliCookie") or ""

    def _browser(self) -> str | None:
        """settings.video.cookiesFromBrowser：非空（且在合法枚举内）时 yt-dlp 调用带
        --cookies-from-browser <browser>；手动 cookie 非空时 _run 优先用 cookie，两者不冲突。"""
        v = (settings_service.load_all_settings().get("video") or {}).get(
            "cookiesFromBrowser"
        ) or ""
        return v if v in self._BROWSERS else None

    def resolve(self, url: str) -> dict:
        """B站解析：带 cookie/browser（匿名拿不到合并格式，DASH 分离流）"""
        return video_ytdlp.resolve(url, cookie=self._cookie(), browser=self._browser())

    def get_stream(self, url: str, format_hint: str | None = "best") -> str:
        cookie = self._cookie()
        browser = self._browser()
        info = video_ytdlp.resolve(url, cookie=cookie, browser=browser)
        best = video_ytdlp.pick_best_format(info.get("formats") or [], format_hint)
        # 直链按所选 format_id 现取（带 cookie：直链可能也需要 cookie 校验，且比 resolve 里的 url 更新鲜）
        return video_ytdlp.get_stream(
            url, format_hint=best.get("format_id") or "best", cookie=cookie, browser=browser
        )

    def get_subtitles(self, url: str) -> list[dict] | None:
        """B站字幕：带 cookie/browser（大会员 CC 字幕等可能需登录态）"""
        return video_ytdlp.get_subtitles(url, cookie=self._cookie(), browser=self._browser())

    def get_dual_streams(self, url: str) -> dict:
        """B站 DASH 双轨直链 {video, audio}：一次 resolve 拿 formats → 视频轨
        （pick_best_format，无合并格式时按清晰度取最高，acodec=none 纯视频轨可接受）
        + 音频轨（pick_best_audio_format 按 abr 取最高）。

        直接取 formats 里的 url 字段（resolve 的 formats 已含 url，实测可用），
        不再二次调用 yt-dlp（避免每次 stream 请求多花 4-6 秒）。无音频轨抛 RuntimeError。
        """
        info = video_ytdlp.resolve(url, cookie=self._cookie(), browser=self._browser())
        formats = info.get("formats") or []
        video = video_ytdlp.pick_best_format(formats)
        audio = video_ytdlp.pick_best_audio_format(formats)
        video_url = video.get("url")
        audio_url = audio.get("url")
        if not video_url or not audio_url:
            raise RuntimeError("解析结果缺少音/视频轨直链")
        return {"video": video_url, "audio": audio_url}

    def stream_headers(self, url: str) -> dict:
        return {"Referer": self._REFERER}


# ============ 注册表 ============

_REGISTRY: dict[str, VideoProvider] = {}


def register(provider: VideoProvider) -> VideoProvider:
    """注册 provider（按 name 覆盖）；返回 provider 本身便于链式"""
    _REGISTRY[provider.name] = provider
    return provider


def get_provider(name: str | None) -> VideoProvider | None:
    """按 name 取 provider；未知 name 返回 None（由路由转 400）"""
    return _REGISTRY.get((name or "").strip().lower())


def auto_provider_for_url(url: str) -> str:
    """按 url host 推断 provider name（stream/subtitles 缺 source 参数时兜底）"""
    host = urlparse(url).netloc.lower()
    if "bilibili.com" in host:
        return "bilibili"
    return "generic"


# 内置源注册（模块导入即注册）
register(GenericProvider())
register(BiliProvider())
