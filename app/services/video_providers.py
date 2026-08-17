"""在线视频源 provider 抽象 + 注册表（底层统一 yt-dlp 引擎）。

- ``VideoProvider``：name + resolve/search/get_stream/get_subtitles/download；
  search 默认抛 NotImplementedError（yt-dlp 不做搜索，B站 wbi 签名等搜索入口后置）。
- ``BiliProvider``（B站）：get_stream 用 yt-dlp resolve 后选最佳合并格式直链；
  直链防盗链需要 Referer（由代理层经 stream_headers 附加）。
- ``GenericProvider``（自定义源）：任意链接走 yt-dlp 通用解析（resolve 支持什么就返回什么）。

注册表：``register()`` / ``get_provider(name)``；内置源在模块导入时注册。
"""

from urllib.parse import urlparse

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
    """B站：get_stream 走 resolve 后选最佳合并格式直链（防盗链 Referer 由代理层附加）"""

    name = "bilibili"
    display_name = "B站"
    _REFERER = "https://www.bilibili.com"

    def get_stream(self, url: str, format_hint: str | None = "best") -> str:
        info = video_ytdlp.resolve(url)
        best = video_ytdlp.pick_best_format(info.get("formats") or [], format_hint)
        return best["url"]

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
