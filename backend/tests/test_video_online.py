"""任务 D：yt-dlp 在线源后端测试（mock subprocess / mock httpx，不依赖真实外部服务）。

- video_ytdlp：resolve 解析 / get_stream 格式选择 / get_subtitles / download / 字幕内容解析 / 失败与超时
- video_providers：注册表 / B站 provider（Referer）/ 通用 provider / url host 推断
- video-online 路由：resolve 成功与失败 / stream Range 206 / 403 自动重试一次 / url 校验 / 字幕

运行：cd /Users/dax/codes/qqplayerD && /Users/dax/codes/qqplayer/venv/bin/python -m pytest tests/test_video_online.py -q
"""

import io
import json
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import backend  # noqa: E402
from app import state  # noqa: E402
from app.routers import video_online  # noqa: E402
from app.services import video_providers as vp  # noqa: E402
from app.services import video_ytdlp  # noqa: E402

client = TestClient(backend.app)

BILI_URL = "https://www.bilibili.com/video/BV1xx411c7mD"
# 非 bilibili 域名的通用链接（走 generic provider）
GENERIC_URL = "https://example.com/watch?v=abc123"


@pytest.fixture(autouse=True)
def _ytdlp_bin(monkeypatch):
    """固定 CLI 查找结果：subprocess 全部 mock，不依赖环境是否安装 yt-dlp（CI 无 yt-dlp 也能跑）"""
    monkeypatch.setattr(video_ytdlp, "YTDLP_BIN", "/usr/bin/false")


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """设置存储隔离：BiliProvider 从 settings 读 bilibiliCookie，测试不碰真实用户 settings.json"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    state._settings = None
    yield
    state._settings = None


SAMPLE_INFO = {
    "title": "测试视频",
    "webpage_url": "https://www.bilibili.com/video/BV1xx411c7mD",
    "original_url": "https://www.bilibili.com/video/BV1xx411c7mD",
    "duration": 100.5,
    "thumbnail": "http://i0.hdslb.com/bfs/archive/xx.jpg",
    "formats": [
        {
            "format_id": "16",
            "ext": "mp4",
            "height": 360,
            "width": 640,
            "acodec": "aac",
            "vcodec": "avc1",
            "format_note": "流畅 360P",
            "url": "http://up.test/360.mp4",
        },
        {
            "format_id": "32",
            "ext": "mp4",
            "height": 480,
            "width": 854,
            "acodec": "aac",
            "vcodec": "avc1",
            "format_note": "清晰 480P",
            "url": "http://up.test/480.mp4",
        },
        {
            "format_id": "80",
            "ext": "mp4",
            "height": 1080,
            "width": 1920,
            "acodec": "aac",
            "vcodec": "avc1",
            "format_note": "高清 1080P",
            "url": "http://up.test/1080.mp4",
        },
        {
            "format_id": "30280",
            "ext": "mp4",
            "height": 1080,
            "width": 1920,
            "acodec": "none",
            "vcodec": "avc1",
            "format_note": "DASH video",
            "url": "http://up.test/video-only.mp4",
        },
        {
            "format_id": "30216",
            "ext": "mp4",
            "height": 720,
            "acodec": "none",
            "vcodec": "avc1",
            "format_note": "DASH video",
            "url": "http://up.test/video-only2.mp4",
        },
        {
            "format_id": "30080",
            "ext": "m4a",
            "height": None,
            "acodec": "mp4a.40.2",
            "vcodec": "none",
            "format_note": "DASH audio",
            "url": "http://up.test/audio.m4a",
        },
    ],
    "subtitles": {
        "zh-Hans": [
            {
                "ext": "srt",
                "data": "1\n00:00:01,000 --> 00:00:02,500\n你好\n",
                "name": "中文（简体）",
            }
        ],
        "en": [{"ext": "json", "url": "http://sub.test/en.json"}],
    },
    "automatic_captions": {
        "ai-zh": [{"ext": "json", "url": "http://sub.test/ai-zh.json"}],
    },
}


class FakeProc:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


@pytest.fixture
def fake_run(monkeypatch):
    """mock video_ytdlp._run：记录调用，返回可配置 FakeProc（state[\"proc\"] 可为 callable）"""
    state = {"calls": [], "proc": FakeProc()}

    def run_fn(args, timeout, what, cookie=None, browser=None):
        state["calls"].append((args, timeout, what, cookie, browser))
        if callable(state["proc"]):
            return state["proc"](args, timeout, what)
        return state["proc"]

    monkeypatch.setattr(video_ytdlp, "_run", run_fn)
    return state


@pytest.fixture
def fake_ytdlp_fns(monkeypatch):
    """mock 路由依赖的 video_ytdlp 三个顶层函数（resolve/get_stream/get_subtitles，含 browser 参数）"""
    monkeypatch.setattr(
        video_ytdlp, "resolve", lambda url, cookie=None, browser=None: dict(SAMPLE_INFO)
    )
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None, browser=None: "http://up.test/1080.mp4",
    )
    monkeypatch.setattr(
        video_ytdlp,
        "get_subtitles",
        lambda url, cookie=None, browser=None: [
            {
                "lang": "zh-Hans",
                "name": "中文（简体）",
                "url": "http://sub.test/zh.json",
                "automatic": False,
            },
            {
                "lang": "ai-zh",
                "name": "ai-zh",
                "url": "http://sub.test/ai-zh.json",
                "automatic": True,
            },
        ],
    )


# ============ video_ytdlp 服务层 ============


def test_ytdlp_resolve_ok(fake_run):
    """--dump-json 解析：元信息 + formats 摘要（无 url 的格式被过滤）"""
    fake_run["proc"] = FakeProc(stdout=json.dumps(SAMPLE_INFO))
    info = video_ytdlp.resolve(BILI_URL)
    assert info["title"] == "测试视频"
    assert info["webpage_url"] == BILI_URL
    assert info["duration"] == 100.5
    assert info["thumbnail"].startswith("http://")
    assert len(info["formats"]) == 6
    assert all("url" in f for f in info["formats"])
    assert info["formats"][0]["format_id"] == "16"
    args = fake_run["calls"][0][0]
    assert args[0] == "--dump-json"
    assert "--no-playlist" in args and "--no-warnings" in args
    assert args[-1] == BILI_URL


def test_resolve_failure_raises_with_stderr(monkeypatch):
    """yt-dlp 非零退出 → RuntimeError 带 stderr ERROR: 摘要（走真实 _run 的 returncode 检查）"""
    monkeypatch.setattr(
        video_ytdlp.subprocess,
        "run",
        lambda *a, **kw: FakeProc(stderr="WARNING: x\nERROR: 视频不存在或已删除", returncode=1),
    )
    with pytest.raises(RuntimeError) as ei:
        video_ytdlp.resolve(BILI_URL)
    assert "视频不存在或已删除" in str(ei.value)


def test_resolve_timeout_raises(monkeypatch):
    """subprocess 超时 → RuntimeError（信息带 timeout 秒数）"""

    def boom(*a, **kw):
        raise subprocess.TimeoutExpired(cmd=["yt-dlp"], timeout=60)

    monkeypatch.setattr(video_ytdlp.subprocess, "run", boom)
    with pytest.raises(RuntimeError) as ei:
        video_ytdlp.resolve(BILI_URL)
    assert "超时" in str(ei.value)


def test_get_stream_default_combined_format(fake_run):
    """默认 best → -f 音视频合并选择器（浏览器 <video> 直接可播）"""
    fake_run["proc"] = FakeProc(stdout="http://up.test/1080.mp4\n")
    url = video_ytdlp.get_stream(BILI_URL)
    assert url == "http://up.test/1080.mp4"
    args = fake_run["calls"][0][0]
    assert args[0] == "--get-url"
    assert args[1] == "-f"
    assert args[2] == "best[acodec!=none][vcodec!=none]/best"
    assert "--no-playlist" in args


def test_get_stream_custom_hint(fake_run):
    """显式 format_hint 透传 -f"""
    fake_run["proc"] = FakeProc(stdout="http://up.test/480.mp4")
    video_ytdlp.get_stream(BILI_URL, format_hint="32")
    args = fake_run["calls"][0][0]
    assert args[2] == "32"


# ============ video_ytdlp cookie 传参（--add-header）============


@pytest.fixture
def fake_subprocess_run(monkeypatch):
    """mock video_ytdlp.subprocess.run：记录真实 cmd（走真实 _run，验证 --add-header 拼装）"""
    state = {"calls": [], "proc": FakeProc()}

    def run_fn(cmd, **kw):
        state["calls"].append(cmd)
        return state["proc"]

    monkeypatch.setattr(video_ytdlp.subprocess, "run", run_fn)
    return state


def test_ytdlp_get_stream_with_cookie(fake_subprocess_run):
    """get_stream 带 cookie → subprocess cmd 尾部含 --add-header "Cookie: <cookie>"（list 传参无 shell 注入）"""
    fake_subprocess_run["proc"] = FakeProc(stdout="http://up.test/1080.mp4\n")
    url = video_ytdlp.get_stream(BILI_URL, cookie="SESSDATA=abc123; bili_jct=def")
    assert url == "http://up.test/1080.mp4"
    cmd = fake_subprocess_run["calls"][0]
    assert cmd[0] == "/usr/bin/false"  # YTDLP_BIN 固定假路径
    assert cmd[-2] == "--add-header"
    assert cmd[-1] == "Cookie: SESSDATA=abc123; bili_jct=def"
    # list 传参：cookie 是独立 argv 元素（无 shell 拼接），且整条命令只有这一处出现
    assert cmd.count("Cookie: SESSDATA=abc123; bili_jct=def") == 1


def test_ytdlp_get_stream_without_cookie_no_header(fake_subprocess_run):
    """不带 cookie → subprocess cmd 无 --add-header（空串/None 都不加）"""
    for cookie in (None, ""):
        fake_subprocess_run["calls"].clear()
        fake_subprocess_run["proc"] = FakeProc(stdout="http://up.test/1080.mp4\n")
        video_ytdlp.get_stream(BILI_URL, cookie=cookie)
        cmd = fake_subprocess_run["calls"][0]
        assert "--add-header" not in cmd, f"cookie={cookie!r} 不应加头"
        assert not any("Cookie:" in a for a in cmd), f"cookie={cookie!r} 不应出现 Cookie 头"


def test_ytdlp_resolve_with_cookie(fake_subprocess_run):
    """resolve 带 cookie → --dump-json 调用附加 Cookie 头"""
    fake_subprocess_run["proc"] = FakeProc(stdout=json.dumps(SAMPLE_INFO))
    info = video_ytdlp.resolve(BILI_URL, cookie="SESSDATA=abc123")
    assert info["title"] == "测试视频"
    cmd = fake_subprocess_run["calls"][0]
    assert cmd[0] == "/usr/bin/false"  # YTDLP_BIN 固定假路径
    assert cmd[1] == "--dump-json"
    assert cmd[-2] == "--add-header" and cmd[-1] == "Cookie: SESSDATA=abc123"


def test_ytdlp_get_subtitles_with_cookie(fake_subprocess_run):
    """get_subtitles 带 cookie → 附加 Cookie 头"""
    fake_subprocess_run["proc"] = FakeProc(stdout=json.dumps(SAMPLE_INFO))
    subs = video_ytdlp.get_subtitles(BILI_URL, cookie="SESSDATA=abc123")
    assert subs is not None and subs[0]["lang"] == "zh-Hans"
    cmd = fake_subprocess_run["calls"][0]
    assert cmd[-2] == "--add-header" and cmd[-1] == "Cookie: SESSDATA=abc123"


def test_ytdlp_get_stream_with_browser(fake_subprocess_run):
    """browser 非空（cookie 为空）→ subprocess cmd 尾部含 --cookies-from-browser <browser>"""
    fake_subprocess_run["proc"] = FakeProc(stdout="http://up.test/1080.mp4\n")
    url = video_ytdlp.get_stream(BILI_URL, browser="vivaldi")
    assert url == "http://up.test/1080.mp4"
    cmd = fake_subprocess_run["calls"][0]
    assert cmd[0] == "/usr/bin/false"  # YTDLP_BIN 固定假路径
    assert cmd[-2] == "--cookies-from-browser"
    assert cmd[-1] == "vivaldi"
    assert "--add-header" not in cmd


def test_ytdlp_cookie_wins_over_browser(fake_subprocess_run):
    """cookie 非空 + browser 非空 → 只用 --add-header Cookie（手动 cookie 优先，无 --cookies-from-browser）"""
    fake_subprocess_run["proc"] = FakeProc(stdout="http://up.test/1080.mp4\n")
    video_ytdlp.get_stream(BILI_URL, cookie="SESSDATA=abc123", browser="vivaldi")
    cmd = fake_subprocess_run["calls"][0]
    assert cmd[-2] == "--add-header"
    assert cmd[-1] == "Cookie: SESSDATA=abc123"
    assert "--cookies-from-browser" not in cmd


def test_ytdlp_resolve_with_browser(fake_subprocess_run):
    """resolve 带 browser（cookie 为空）→ --dump-json 调用附加 --cookies-from-browser"""
    fake_subprocess_run["proc"] = FakeProc(stdout=json.dumps(SAMPLE_INFO))
    info = video_ytdlp.resolve(BILI_URL, browser="chrome")
    assert info["title"] == "测试视频"
    cmd = fake_subprocess_run["calls"][0]
    assert cmd[0] == "/usr/bin/false"  # YTDLP_BIN 固定假路径
    assert cmd[1] == "--dump-json"
    assert cmd[-2] == "--cookies-from-browser" and cmd[-1] == "chrome"
    assert "--add-header" not in cmd


def test_get_stream_empty_output_raises(fake_run):
    """-g 输出为空 → RuntimeError"""
    fake_run["proc"] = FakeProc(stdout="  \n")
    with pytest.raises(RuntimeError) as ei:
        video_ytdlp.get_stream(BILI_URL)
    assert "输出为空" in str(ei.value)


def test_get_subtitles_ok(fake_run):
    """subtitles + automatic_captions 合并；每语言取第一个条目；无 name 回落 lang"""
    fake_run["proc"] = FakeProc(stdout=json.dumps(SAMPLE_INFO))
    subs = video_ytdlp.get_subtitles(BILI_URL)
    assert subs is not None
    langs = [s["lang"] for s in subs]
    assert langs == ["zh-Hans", "en", "ai-zh"]
    zh = subs[0]
    assert (
        zh["name"] == "中文（简体）"
        and zh["url"] is None
        and zh["data"].startswith("1\n00:00:01,000")
        and zh["automatic"] is False
    )
    assert subs[1]["name"] == "en"  # 无 name 回落 lang
    assert subs[2]["automatic"] is True
    assert fake_run["calls"][0][0][0] == "--dump-json"  # --dump-json 本身不下载


def test_get_subtitles_none(fake_run):
    """无任何字幕 → None"""
    info = dict(SAMPLE_INFO)
    info["subtitles"] = {}
    info["automatic_captions"] = {}
    fake_run["proc"] = FakeProc(stdout=json.dumps(info))
    assert video_ytdlp.get_subtitles(BILI_URL) is None


def test_download_ok(fake_run, tmp_path):
    """下载：-o 模板、--no-playlist；返回实际落盘文件"""

    def make_file(args, timeout, what):
        # 模拟 yt-dlp 写文件：从 -o 模板推导出 <name>.mp4
        out = args[args.index("-o") + 1]
        tmpl = out.replace("%(ext)s", "mp4")
        Path(tmpl).write_bytes(b"video-bytes")
        return FakeProc(stdout="")

    fake_run["proc"] = make_file
    dest = video_ytdlp.download(BILI_URL, str(tmp_path), "我的视频")
    assert dest == tmp_path / "我的视频.mp4"
    assert dest.read_bytes() == b"video-bytes"
    args = fake_run["calls"][0][0]
    assert args[0] == "-f"
    assert args[2] == "-o"
    assert str(tmp_path / "我的视频.%(ext)s") in args
    assert "--no-playlist" in args


def test_download_sanitizes_filename(fake_run, tmp_path):
    """文件名清洗：/ \\ : 等非法字符被去掉"""
    fake_run["proc"] = lambda args, t, w: (
        Path(args[args.index("-o") + 1].replace("%(ext)s", "mp4")).write_bytes(b"x"),
        FakeProc(),
    )[1]
    dest = video_ytdlp.download(BILI_URL, str(tmp_path), "a/b:c.mp4")
    assert dest == tmp_path / "abc.mp4.mp4"  # 清洗后 stem=abc.mp4，yt-dlp 再补真实扩展名


def test_pick_best_format_combined_first():
    """优先音视频合并格式（1080P 合并 > 4K DASH 分离）；format_id 精确匹配；无合并退回最高清"""
    formats = list(SAMPLE_INFO["formats"])
    best = video_ytdlp.pick_best_format(formats)
    assert best["format_id"] == "80"
    # format_id 精确匹配
    assert video_ytdlp.pick_best_format(formats, format_hint="30216")["format_id"] == "30216"
    # 无合并格式 → 全部里按 height 取最高
    only_dash = [f for f in formats if f["acodec"] == "none"]
    assert video_ytdlp.pick_best_format(only_dash)["format_id"] == "30280"
    with pytest.raises(RuntimeError):
        video_ytdlp.pick_best_format([])


def test_parse_subtitle_content_bili_json():
    """B站 CC JSON → items（translation 恒 None）"""
    items = video_ytdlp.parse_subtitle_content(
        '{"body":[{"from":1.0,"to":2.5,"content":"你好"},{"from":2.5,"to":4.0,"content":"世界"}]}'
    )
    assert items == [
        {"start": 1.0, "end": 2.5, "text": "你好", "translation": None},
        {"start": 2.5, "end": 4.0, "text": "世界", "translation": None},
    ]


def test_parse_subtitle_content_srt():
    """SRT → items；毫秒换算、多行合并、HTML 标签去除"""
    srt = (
        "1\n00:00:01,000 --> 00:00:03,500\n第一行\n<i>第二行</i>\n\n"
        "2\n00:00:03,600 --> 00:00:04,000\n第三行\n"
    )
    items = video_ytdlp.parse_subtitle_content(srt)
    assert items[0] == {"start": 1.0, "end": 3.5, "text": "第一行 第二行", "translation": None}
    assert items[1]["start"] == 3.6 and items[1]["text"] == "第三行"


def test_parse_subtitle_content_vtt():
    """VTT → items；WEBVTT 头与 NOTE 块跳过"""
    vtt = (
        "WEBVTT\n\nNOTE 说明块\n\n"
        "00:00:01.000 --> 00:00:02.500 align:start\n你好\n\n"
        "00:00:03.000 --> 00:00:04.000\n再见\n"
    )
    items = video_ytdlp.parse_subtitle_content(vtt)
    assert len(items) == 2
    assert items[0]["start"] == 1.0 and items[0]["text"] == "你好"
    assert items[1]["end"] == 4.0 and items[1]["text"] == "再见"


def test_parse_subtitle_content_garbage_empty():
    """无法识别的格式 → []"""
    assert video_ytdlp.parse_subtitle_content("随便一段文字") == []
    assert video_ytdlp.parse_subtitle_content("") == []
    assert (
        video_ytdlp.parse_subtitle_content('{"body": [{"from": 1, "to": 2}]}') == []
    )  # 无 content


def test_fetch_subtitle_ok(monkeypatch):
    """拉取字幕 URL → 解析 items；请求头带浏览器 UA、trust_env=False"""
    captured = {}

    class FakeResp:
        headers = {"content-type": "application/json"}
        text = '{"body":[{"from":0.5,"to":1.5,"content":"hi"}]}'

        def raise_for_status(self):
            pass

    def fake_get(url, **kw):
        captured["url"] = url
        captured["kw"] = kw
        return FakeResp()

    monkeypatch.setattr(video_ytdlp.httpx, "get", fake_get)
    items = video_ytdlp.fetch_subtitle("http://sub.test/zh.json")
    assert items == [{"start": 0.5, "end": 1.5, "text": "hi", "translation": None}]
    assert captured["url"] == "http://sub.test/zh.json"
    assert captured["kw"]["trust_env"] is False
    assert "User-Agent" in captured["kw"]["headers"]


def test_fetch_subtitle_http_error_raises(monkeypatch):
    """上游失败 → RuntimeError（路由降级为空）"""

    def fake_get(url, **kw):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(video_ytdlp.httpx, "get", fake_get)
    with pytest.raises(RuntimeError):
        video_ytdlp.fetch_subtitle("http://sub.test/zh.json")


# ============ video_providers 注册表 ============


def test_provider_registry():
    """内置注册：generic + bilibili；未知 name → None；url host 推断"""
    assert vp.get_provider("generic").name == "generic"
    assert vp.get_provider("bilibili").name == "bilibili"
    assert vp.get_provider("BILIBILI").name == "bilibili"  # 大小写不敏感
    assert vp.get_provider("youtube") is None
    assert vp.get_provider(None) is None
    assert vp.auto_provider_for_url("https://www.bilibili.com/video/BV1xx411c7mD") == "bilibili"
    assert vp.auto_provider_for_url("https://www.youtube.com/watch?v=x") == "generic"


def test_provider_search_not_implemented():
    """search 默认抛 NotImplementedError（B站搜索后置）"""
    for name in ("generic", "bilibili"):
        with pytest.raises(NotImplementedError):
            vp.get_provider(name).search("关键词")


def test_bili_provider_stream_uses_resolve_pick(monkeypatch, fake_run):
    """B站 get_stream：resolve 拿格式信息（--dump-json）→ pick 最佳合并格式 → get_stream -f <id> 现取直链"""

    def proc(args, timeout, what):
        if args[0] == "--dump-json":
            return FakeProc(stdout=json.dumps(SAMPLE_INFO))
        return FakeProc(stdout="http://up.test/1080.mp4\n")

    fake_run["proc"] = proc
    url = vp.get_provider("bilibili").get_stream(BILI_URL)
    assert url == "http://up.test/1080.mp4"
    assert fake_run["calls"][0][0][0] == "--dump-json"
    # 第二次调用：--get-url -f <最佳合并 format_id>
    args2 = fake_run["calls"][1][0]
    assert args2[0] == "--get-url"
    assert args2[args2.index("-f") + 1] == "80"


def test_bili_provider_stream_with_settings_cookie(fake_run):
    """settings.video.bilibiliCookie 已设置 → resolve 与 get_stream 两次调用都自动把 cookie 传给 _run"""
    state._settings = {"video": {"bilibiliCookie": "SESSDATA=abc; bili_jct=def"}}

    def proc(args, timeout, what):
        if args[0] == "--dump-json":
            return FakeProc(stdout=json.dumps(SAMPLE_INFO))
        return FakeProc(stdout="http://up.test/1080.mp4\n")

    fake_run["proc"] = proc
    url = vp.get_provider("bilibili").get_stream(BILI_URL)
    assert url == "http://up.test/1080.mp4"
    assert len(fake_run["calls"]) == 2  # resolve(--dump-json) + get_stream(--get-url)
    for i, (_args, _, _, cookie, _browser) in enumerate(fake_run["calls"]):
        assert cookie == "SESSDATA=abc; bili_jct=def", f"第 {i} 次调用应带 cookie"
    # resolve 调用不带 --add-header（那是 _run 内部拼装的，由 fake_subprocess_run 用例覆盖）
    assert "--add-header" not in fake_run["calls"][0][0]


def test_bili_provider_stream_no_cookie_when_unset(fake_run):
    """settings 未设置 cookie（空串）→ 传给 _run 的 cookie 为空，不加头"""
    state._settings = {"video": {"bilibiliCookie": ""}}

    def proc(args, timeout, what):
        if args[0] == "--dump-json":
            return FakeProc(stdout=json.dumps(SAMPLE_INFO))
        return FakeProc(stdout="http://up.test/1080.mp4\n")

    fake_run["proc"] = proc
    vp.get_provider("bilibili").get_stream(BILI_URL)
    for args, _, _, cookie, _browser in fake_run["calls"]:
        assert cookie in (None, ""), "未设置 cookie 时不应传值"
        assert "--add-header" not in args


def test_bili_provider_referer_header():
    """B站流代理附加 Referer 防盗链头"""
    headers = vp.get_provider("bilibili").stream_headers(BILI_URL)
    assert headers == {"Referer": "https://www.bilibili.com"}
    assert vp.get_provider("generic").stream_headers(BILI_URL) == {}


# ============ BiliProvider：browser 传参与 get_dual_streams ============

# DASH 分离流样本：纯视频轨（acodec=none）+ 纯音频轨（vcodec=none，带 abr）
DASH_FORMATS = [
    {
        "format_id": "30080",
        "ext": "mp4",
        "height": 1080,
        "width": 1920,
        "acodec": "none",
        "vcodec": "avc1",
        "format_note": "DASH video",
        "url": "http://up.test/v1080.m4s",
    },
    {
        "format_id": "30032",
        "ext": "mp4",
        "height": 720,
        "acodec": "none",
        "vcodec": "avc1",
        "format_note": "DASH video",
        "url": "http://up.test/v720.m4s",
    },
    {
        "format_id": "30280",
        "ext": "m4a",
        "height": None,
        "acodec": "mp4a.40.2",
        "vcodec": "none",
        "abr": 320,
        "format_note": "DASH audio 320k",
        "url": "http://up.test/a320.m4s",
    },
    {
        "format_id": "30232",
        "ext": "m4a",
        "height": None,
        "acodec": "mp4a.40.2",
        "vcodec": "none",
        "abr": 192,
        "format_note": "DASH audio 192k",
        "url": "http://up.test/a192.m4s",
    },
    {
        "format_id": "30216",
        "ext": "m4a",
        "height": None,
        "acodec": "mp4a.40.2",
        "vcodec": "none",
        "abr": 132,
        "format_note": "DASH audio 132k",
        "url": "http://up.test/a132.m4s",
    },
]


def test_bili_provider_browser_from_settings(fake_run):
    """settings.video.cookiesFromBrowser 已设置 → resolve 调用把 browser 传给 _run（cookie 空时）"""
    state._settings = {"video": {"bilibiliCookie": "", "cookiesFromBrowser": "vivaldi"}}
    fake_run["proc"] = FakeProc(stdout=json.dumps(SAMPLE_INFO))
    vp.get_provider("bilibili").resolve(BILI_URL)
    args, timeout, what, cookie, browser = fake_run["calls"][0]
    assert cookie in (None, "")  # 手动 cookie 未设置
    assert browser == "vivaldi"


def test_bili_provider_browser_ignored_when_cookie_set(fake_run):
    """手动 cookie 非空 + browser 已设置 → 两者都传给 _run（_run 内部 cookie 优先拼 --add-header）"""
    state._settings = {"video": {"bilibiliCookie": "SESSDATA=abc", "cookiesFromBrowser": "vivaldi"}}
    fake_run["proc"] = FakeProc(stdout=json.dumps(SAMPLE_INFO))
    vp.get_provider("bilibili").get_dual_streams(BILI_URL)
    args, timeout, what, cookie, browser = fake_run["calls"][0]
    assert cookie == "SESSDATA=abc"
    assert browser == "vivaldi"


def test_bili_provider_browser_unset_is_none(fake_run):
    """settings 未设置 cookiesFromBrowser（空串/未配置）→ browser 为 None，不加 --cookies-from-browser"""
    for settings_video in (
        {"bilibiliCookie": ""},
        {"bilibiliCookie": "", "cookiesFromBrowser": ""},
    ):
        state._settings = {"video": settings_video}
        fake_run["calls"].clear()
        fake_run["proc"] = FakeProc(stdout=json.dumps(SAMPLE_INFO))
        vp.get_provider("bilibili").resolve(BILI_URL)
        args, timeout, what, cookie, browser = fake_run["calls"][0]
        assert browser is None


def test_bili_provider_get_dual_streams(fake_run):
    """get_dual_streams：一次 resolve → 视频轨（最高清晰度）+ 音频轨（最高 abr）直链，不再二次调用 yt-dlp"""
    fake_run["proc"] = FakeProc(stdout=json.dumps({"formats": DASH_FORMATS}))
    dual = vp.get_provider("bilibili").get_dual_streams(BILI_URL)
    assert dual == {"video": "http://up.test/v1080.m4s", "audio": "http://up.test/a320.m4s"}
    assert len(fake_run["calls"]) == 1  # 只一次 resolve（--dump-json），不二次调用
    assert fake_run["calls"][0][0][0] == "--dump-json"


def test_bili_provider_get_dual_streams_no_abr_by_format_id(fake_run):
    """音频轨无 abr → 按 format_id 数字降序取最高（30280 > 30232 > 30216）"""
    formats = []
    for f in DASH_FORMATS:
        if f.get("acodec") != "none":
            f = {**f, "abr": None}
        formats.append(f)
    fake_run["proc"] = FakeProc(stdout=json.dumps({"formats": formats}))
    dual = vp.get_provider("bilibili").get_dual_streams(BILI_URL)
    assert dual["audio"] == "http://up.test/a320.m4s"


def test_bili_provider_get_dual_streams_no_audio_raises(fake_run):
    """无音频轨（只有纯视频轨）→ RuntimeError"""
    only_video = [f for f in DASH_FORMATS if f.get("acodec") == "none"]
    fake_run["proc"] = FakeProc(stdout=json.dumps({"formats": only_video}))
    with pytest.raises(RuntimeError) as ei:
        vp.get_provider("bilibili").get_dual_streams(BILI_URL)
    assert "音频轨" in str(ei.value)


def test_pick_best_audio_format():
    """pick_best_audio_format：abr 降序优先；无 abr 按 format_id 数字降序；无音频轨抛 RuntimeError"""
    assert video_ytdlp.pick_best_audio_format(DASH_FORMATS)["format_id"] == "30280"
    # 混合：有 abr 的永远排在无 abr 之前（abr 是主键）
    no_abr = [dict(f, abr=None) for f in DASH_FORMATS if f.get("acodec") != "none"]
    mixed = DASH_FORMATS[:2] + no_abr
    assert video_ytdlp.pick_best_audio_format(mixed)["format_id"] == "30280"
    with pytest.raises(RuntimeError):
        video_ytdlp.pick_best_audio_format([])
    with pytest.raises(RuntimeError):
        video_ytdlp.pick_best_audio_format([f for f in DASH_FORMATS if f["acodec"] == "none"])


def test_resolve_formats_include_abr(fake_run):
    """resolve 的 formats 摘要新增 abr 字段（音频轨选路需要）"""
    fake_run["proc"] = FakeProc(stdout=json.dumps(SAMPLE_INFO))
    info = video_ytdlp.resolve(BILI_URL)
    assert "abr" in info["formats"][0]
    assert all("abr" in f for f in info["formats"])


# ============ 路由：resolve ============


def test_resolve_ok(fake_ytdlp_fns):
    """粘贴链接解析 → 契约 {title, url, provider, duration, subtitles}（通用源）"""
    r = client.post("/api/video-online/resolve", json={"url": GENERIC_URL})
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "测试视频"
    assert body["url"] == "http://up.test/1080.mp4"
    assert body["provider"] == "generic"
    assert body["duration"] == 100.5
    assert body["subtitles"] == [
        {"lang": "zh-Hans", "name": "中文（简体）"},
        {"lang": "ai-zh", "name": "ai-zh"},
    ]


def test_resolve_bilibili_auto_provider(fake_ytdlp_fns):
    """bilibili.com url 不带 source → 自动走 B站 provider（双轨可用时响应带 audioUrl）"""
    r = client.post("/api/video-online/resolve", json={"url": BILI_URL, "source": "bilibili"})
    assert r.status_code == 200
    body = r.json()
    assert body["provider"] == "bilibili"
    # SAMPLE_INFO 含 DASH 音频轨（30080）→ get_dual_streams 能选出音频轨直链
    assert body["audioUrl"] == "http://up.test/audio.m4a"


def test_resolve_bilibili_audio_url_explicit(monkeypatch, fake_ytdlp_fns):
    """B站 resolve：mock get_dual_streams → audioUrl 返回音频轨直链"""
    monkeypatch.setattr(
        vp.BiliProvider,
        "get_dual_streams",
        lambda self, url: {"video": "http://up.test/v.m4s", "audio": "http://up.test/a.m4s"},
    )
    r = client.post("/api/video-online/resolve", json={"url": BILI_URL, "source": "bilibili"})
    assert r.status_code == 200
    assert r.json()["audioUrl"] == "http://up.test/a.m4s"


def test_resolve_bilibili_audio_url_fail_omitted(monkeypatch, fake_ytdlp_fns):
    """B站音频轨直链获取失败 → audioUrl 省略（不阻塞解析主链路）"""

    def boom(self, url):
        raise RuntimeError("解析结果无可用音频轨")

    monkeypatch.setattr(vp.BiliProvider, "get_dual_streams", boom)
    r = client.post("/api/video-online/resolve", json={"url": BILI_URL, "source": "bilibili"})
    assert r.status_code == 200
    assert "audioUrl" not in r.json()


def test_resolve_generic_no_audio_url(fake_ytdlp_fns):
    """非 B站（generic）→ 响应无 audioUrl 字段"""
    r = client.post("/api/video-online/resolve", json={"url": GENERIC_URL})
    assert r.status_code == 200
    assert "audioUrl" not in r.json()


def test_resolve_failure_400(fake_ytdlp_fns, monkeypatch):
    """解析失败 → 400 带 yt-dlp 错误摘要（通用源走 -g 直链路径）"""

    def boom(url, format_hint="best"):
        raise RuntimeError("yt-dlp 直链获取失败: 视频不存在或已删除")

    monkeypatch.setattr(video_ytdlp, "get_stream", boom)
    r = client.post("/api/video-online/resolve", json={"url": GENERIC_URL})
    assert r.status_code == 400
    assert "视频不存在或已删除" in r.json()["detail"]


def test_resolve_bad_url_400(fake_ytdlp_fns):
    """非 http(s) url → 400，不触发 yt-dlp"""
    for bad in ("ftp://x/v.mp4", "/api/audio?path=/etc/passwd", "", "javascript:alert(1)"):
        r = client.post("/api/video-online/resolve", json={"url": bad})
        assert r.status_code == 400, f"url={bad!r} 应 400"
    assert client.post("/api/video-online/resolve", json={}).status_code == 400


def test_resolve_unknown_source_400(fake_ytdlp_fns):
    """未知 source → 400"""
    r = client.post("/api/video-online/resolve", json={"url": BILI_URL, "source": "youtube"})
    assert r.status_code == 400
    assert "youtube" in r.json()["detail"]


# ============ 路由：stream 代理 ============


class _FakeUpstream:
    """mock httpx.stream 返回的上游对象：可配状态/头/chunks/错误"""

    def __init__(self, chunks=b"", status_code=200, headers=None, error=None):
        self._chunks = chunks if isinstance(chunks, (list, tuple)) else [chunks]
        self.status_code = status_code
        self.headers = headers or {}
        self._error = error

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        if self._error:
            raise self._error

    def iter_bytes(self):
        yield from self._chunks


def _status_error(status):
    req = httpx.Request("GET", "http://up.test/x")
    return httpx.HTTPStatusError(
        f"upstream {status}", request=req, response=httpx.Response(status, request=req)
    )


@pytest.fixture
def fake_proxy_stream(monkeypatch):
    """mock video_online.httpx.stream：记录调用，返回可配置上游（state[\"resp\"] 可为 callable）"""
    state = {"calls": [], "resp": None}

    def stream_fn(method, url, **kw):
        state["calls"].append((method, url, kw))
        return state["resp"]() if callable(state["resp"]) else state["resp"]

    monkeypatch.setattr(video_online.httpx, "stream", stream_fn)
    return state


def test_stream_ok_range_206(fake_proxy_stream, monkeypatch):
    """Range 透传 + 206 + content-range/accept-ranges 透传；UA 头默认带；上游已给明确 MIME 原样透传"""
    monkeypatch.setattr(
        video_ytdlp, "resolve", lambda url, cookie=None, browser=None: dict(SAMPLE_INFO)
    )
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None, browser=None: "http://up.test/1080.mp4",
    )
    fake_proxy_stream["resp"] = _FakeUpstream(
        chunks=[b"x" * 1024],
        status_code=206,
        headers={
            "content-range": "bytes 0-1023/102400",
            "accept-ranges": "bytes",
            "content-type": "video/mp4",
        },
    )
    r = client.get(
        "/api/video-online/stream", params={"url": GENERIC_URL}, headers={"Range": "bytes=0-1023"}
    )
    assert r.status_code == 206
    assert len(r.content) == 1024
    assert r.headers["content-range"] == "bytes 0-1023/102400"
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"] == "video/mp4"  # 上游已明确 → 不重写
    method, url, kw = fake_proxy_stream["calls"][0]
    assert method == "GET"
    assert url == "http://up.test/1080.mp4"
    assert kw["headers"]["Range"] == "bytes=0-1023"
    assert kw["headers"]["User-Agent"]
    assert kw["timeout"] == 60.0 and kw["follow_redirects"] is True and kw["trust_env"] is False


def test_stream_m4s_octet_stream_fixed_to_video_mp4(fake_proxy_stream, monkeypatch):
    """直链 .m4s 分片：上游 CDN 返回 application/octet-stream → 按扩展名修正为 video/mp4（浏览器 <video> 才能播）"""
    monkeypatch.setattr(
        video_ytdlp, "resolve", lambda url, cookie=None, browser=None: dict(SAMPLE_INFO)
    )
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None, browser=None: (
            "https://up.test/xxx_da2-1-30080.m4s?deadline=1"
        ),
    )
    fake_proxy_stream["resp"] = _FakeUpstream(
        chunks=[b"fmp4-data"],
        status_code=200,
        headers={"content-type": "application/octet-stream"},
    )
    r = client.get("/api/video-online/stream", params={"url": GENERIC_URL})
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"
    assert r.content == b"fmp4-data"


def test_stream_octet_stream_no_ext_passthrough(fake_proxy_stream, monkeypatch):
    """octet-stream 且直链无已知扩展名 → 保持上游类型原样（不猜错）"""
    monkeypatch.setattr(
        video_ytdlp, "resolve", lambda url, cookie=None, browser=None: dict(SAMPLE_INFO)
    )
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None, browser=None: "https://up.test/blob?id=1",
    )
    fake_proxy_stream["resp"] = _FakeUpstream(
        chunks=[b"data"], status_code=200, headers={"content-type": "application/octet-stream"}
    )
    r = client.get("/api/video-online/stream", params={"url": GENERIC_URL})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"


def test_stream_403_retry_once(fake_proxy_stream, monkeypatch):
    """直链 403（过期）→ 重新 resolve 一次再试 → 200（单流代理路径）"""
    calls = {"n": 0}
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None, browser=None: (
            f"http://up.test/{calls['n']}.mp4"
        ),
    )
    monkeypatch.setattr(
        video_ytdlp, "resolve", lambda url, cookie=None, browser=None: dict(SAMPLE_INFO)
    )

    def resp_fn():
        calls["n"] += 1
        if calls["n"] == 1:
            return _FakeUpstream(status_code=403, error=_status_error(403))
        return _FakeUpstream(
            chunks=b"video-data", status_code=200, headers={"content-type": "video/mp4"}
        )

    fake_proxy_stream["resp"] = resp_fn
    r = client.get("/api/video-online/stream", params={"url": GENERIC_URL})
    assert r.status_code == 200
    assert r.content == b"video-data"
    assert calls["n"] == 2  # 第一次 403 触发重试，第二次成功


def test_stream_403_twice_502(fake_proxy_stream, monkeypatch):
    """重试后仍 403 → 502（单流代理路径）"""
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None, browser=None: "http://up.test/x.mp4",
    )
    monkeypatch.setattr(
        video_ytdlp, "resolve", lambda url, cookie=None, browser=None: dict(SAMPLE_INFO)
    )
    fake_proxy_stream["resp"] = lambda: _FakeUpstream(status_code=403, error=_status_error(403))
    r = client.get("/api/video-online/stream", params={"url": GENERIC_URL})
    assert r.status_code == 502
    assert "403" in r.json()["detail"]


def test_stream_connect_error_502(fake_proxy_stream, monkeypatch):
    """上游连接失败（httpx.stream 抛错）→ 502（单流代理路径）"""
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None, browser=None: "http://up.test/x.mp4",
    )
    monkeypatch.setattr(
        video_ytdlp, "resolve", lambda url, cookie=None, browser=None: dict(SAMPLE_INFO)
    )

    def boom(method, url, **kw):
        raise httpx.ConnectError("connection refused")

    fake_proxy_stream["resp"] = None
    monkeypatch.setattr(video_online.httpx, "stream", boom)
    r = client.get("/api/video-online/stream", params={"url": GENERIC_URL})
    assert r.status_code == 502


def test_stream_bad_url_400(fake_proxy_stream):
    """非 http(s) url → 400，不发起上游请求；缺 url 参数 → 422"""
    for bad in ("ftp://x/a.mp4", "/api/audio?path=/etc/passwd", ""):
        r = client.get("/api/video-online/stream", params={"url": bad})
        assert r.status_code == 400, f"url={bad!r} 应 400"
    assert fake_proxy_stream["calls"] == []
    assert client.get("/api/video-online/stream").status_code == 422


# ============ 路由：B站双轨合成（ffmpeg）============


class FakeFFmpegProc:
    """mock subprocess.Popen：stdout 可迭代、poll 立即返回 0（模拟 ffmpeg 正常启动）"""

    def __init__(self, cmd, **kw):
        self.cmd = cmd
        self.returncode = 0
        self.stdout = io.BytesIO(b"fmp4-stream-data")
        self.stderr = io.BytesIO(b"")

    def poll(self):
        return 0

    def wait(self, *a, **kw):
        return 0

    def terminate(self):
        pass


@pytest.fixture
def fake_ffmpeg(monkeypatch):
    """mock ffmpeg 定位 + subprocess.Popen：记录 cmd，返回 FakeFFmpegProc（state["proc"] 可为 callable）"""
    state = {"cmd": None, "proc": None}

    def which(name):
        return "/usr/bin/ffmpeg" if name == "ffmpeg" else None

    def popen(cmd, **kw):
        state["cmd"] = cmd
        return state["proc"](cmd, **kw) if callable(state["proc"]) else state["proc"]

    monkeypatch.setattr(video_online.shutil, "which", which)
    monkeypatch.setattr(video_online.subprocess, "Popen", popen)
    state["proc"] = FakeFFmpegProc
    return state


@pytest.fixture
def fake_dual_streams(monkeypatch):
    """mock BiliProvider.get_dual_streams → 双轨直链"""
    monkeypatch.setattr(
        vp.BiliProvider,
        "get_dual_streams",
        lambda self, url: {"video": "http://up.test/v.m4s", "audio": "http://up.test/a.m4s"},
    )


def test_stream_bilibili_dual_ffmpeg(fake_dual_streams, fake_ffmpeg):
    """B站 → 双轨 ffmpeg 合成：200 video/mp4；t 传 30 → -ss 30 每个输入前各一次；-i 出现两次"""
    r = client.get("/api/video-online/stream", params={"url": BILI_URL, "t": 30})
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"
    assert r.content == b"fmp4-stream-data"
    cmd = fake_ffmpeg["cmd"]
    assert cmd[0] == "/usr/bin/ffmpeg"
    assert "-y" in cmd
    assert (
        cmd.count("-ss") == 2 and cmd.count("30.0") == 2
    )  # 输入 seek：每个 -i 前一个（FastAPI 解析为 float）
    assert cmd.count("-i") == 2
    assert cmd.count("-headers") == 2  # 每个输入各带防盗链头
    headers_val = cmd[cmd.index("-headers") + 1]
    assert "Referer: https://www.bilibili.com" in headers_val
    assert "User-Agent:" in headers_val
    assert cmd[cmd.index("-c") + 1] == "copy"  # -c copy 零重编码
    assert "frag_keyframe+empty_moov+default_base_moof" in cmd
    assert cmd[-3:] == ["-f", "mp4", "pipe:1"]  # -f mp4 pipe:1 输出到 stdout


def test_stream_bilibili_dual_no_t_no_ss(fake_dual_streams, fake_ffmpeg):
    """t 缺省 → 不传 -ss（从头合成）"""
    r = client.get("/api/video-online/stream", params={"url": BILI_URL})
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"
    assert "-ss" not in fake_ffmpeg["cmd"]


def test_stream_bilibili_no_ffmpeg_502(monkeypatch):
    """ffmpeg 未安装（which 找不到）→ 502 清晰错误，不触发 yt-dlp"""
    monkeypatch.setattr(video_online.shutil, "which", lambda name: None)
    r = client.get("/api/video-online/stream", params={"url": BILI_URL})
    assert r.status_code == 502
    assert "ffmpeg" in r.json()["detail"]


def test_stream_bilibili_dual_fail_502(monkeypatch, fake_ffmpeg):
    """双轨直链获取失败 → 重新 resolve 一次再试，仍失败 502"""
    calls = {"n": 0}

    def boom(self, url):
        calls["n"] += 1
        raise RuntimeError("解析结果无可用音频轨")

    monkeypatch.setattr(vp.BiliProvider, "get_dual_streams", boom)
    r = client.get("/api/video-online/stream", params={"url": BILI_URL})
    assert r.status_code == 502
    assert calls["n"] == 2  # 沿用 attempt 模式：重新 resolve 一次再试
    assert "音频轨" in r.json()["detail"]


def test_stream_bilibili_ffmpeg_startup_fail_502(monkeypatch):
    """ffmpeg 启动失败（立即非零退出，如直链 403）→ 重新 resolve + 重启一次，仍失败 502（带 stderr 摘要）"""
    calls = {"n": 0}

    class FailingFFmpegProc:
        def __init__(self, cmd, **kw):
            self.cmd = cmd
            self.returncode = 1
            self.stdout = io.BytesIO(b"")
            self.stderr = io.BytesIO(b"ffmpeg: HTTP error 403 Forbidden")

        def poll(self):
            return 1

        def wait(self, *a, **kw):
            return 1

        def terminate(self):
            pass

    def popen(cmd, **kw):
        calls["n"] += 1
        return FailingFFmpegProc(cmd, **kw)

    monkeypatch.setattr(video_online.shutil, "which", lambda name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(video_online.subprocess, "Popen", popen)
    monkeypatch.setattr(
        vp.BiliProvider,
        "get_dual_streams",
        lambda self, url: {"video": "http://up.test/v.m4s", "audio": "http://up.test/a.m4s"},
    )
    r = client.get("/api/video-online/stream", params={"url": BILI_URL})
    assert r.status_code == 502
    assert calls["n"] == 2  # 启动失败 → 重启一次
    assert "403" in r.json()["detail"]


def test_stream_non_bilibili_t_ignored(fake_proxy_stream, monkeypatch):
    """非 B站 + t 参数 → 忽略 t，走单流代理（回归：非 B站逻辑完全不变）"""
    monkeypatch.setattr(
        video_ytdlp, "resolve", lambda url, cookie=None, browser=None: dict(SAMPLE_INFO)
    )
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None, browser=None: "http://up.test/1080.mp4",
    )
    fake_proxy_stream["resp"] = _FakeUpstream(
        chunks=b"proxy-data", status_code=200, headers={"content-type": "video/mp4"}
    )
    r = client.get("/api/video-online/stream", params={"url": GENERIC_URL, "t": 30})
    assert r.status_code == 200
    assert r.content == b"proxy-data"
    assert fake_proxy_stream["calls"][0][1] == "http://up.test/1080.mp4"  # 走 httpx 代理


# ============ 路由：subtitles ============


@pytest.fixture
def fake_subtitle_fetch(monkeypatch):
    """mock video_ytdlp.fetch_subtitle"""
    monkeypatch.setattr(
        video_ytdlp,
        "fetch_subtitle",
        lambda url: [{"start": 1.0, "end": 2.0, "text": "你好", "translation": None}],
    )


def test_subtitles_ok(fake_ytdlp_fns, fake_subtitle_fetch):
    """指定 lang → 字幕 items（translation 恒 None）"""
    r = client.get("/api/video-online/subtitles", params={"url": BILI_URL, "lang": "zh-Hans"})
    assert r.status_code == 200
    assert r.json() == {"items": [{"start": 1.0, "end": 2.0, "text": "你好", "translation": None}]}


def test_subtitles_unknown_lang_empty(fake_ytdlp_fns):
    """lang 无匹配 → {items: []}"""
    r = client.get("/api/video-online/subtitles", params={"url": BILI_URL, "lang": "ja"})
    assert r.status_code == 200
    assert r.json() == {"items": []}


def test_subtitles_no_url_empty(fake_ytdlp_fns, monkeypatch):
    """字幕条目无 url 也无 data → {items: []}，不报错"""
    monkeypatch.setattr(
        video_ytdlp,
        "get_subtitles",
        lambda url, cookie=None, browser=None: [
            {"lang": "zh-Hans", "name": "中文", "url": None, "data": None, "automatic": False}
        ],
    )
    r = client.get("/api/video-online/subtitles", params={"url": BILI_URL, "lang": "zh-Hans"})
    assert r.status_code == 200
    assert r.json() == {"items": []}


def test_subtitles_inline_data_ok(fake_ytdlp_fns, monkeypatch):
    """字幕内容由 yt-dlp 内嵌为 data（B站 CC 无独立 url）→ 直接解析返回 items"""
    monkeypatch.setattr(
        video_ytdlp,
        "get_subtitles",
        lambda url, cookie=None, browser=None: [
            {
                "lang": "zh-Hans",
                "name": "中文（简体）",
                "url": None,
                "data": "1\n00:00:01,000 --> 00:00:02,500\n你好\n",
                "automatic": False,
            }
        ],
    )
    r = client.get("/api/video-online/subtitles", params={"url": BILI_URL, "lang": "zh-Hans"})
    assert r.status_code == 200
    assert r.json() == {"items": [{"start": 1.0, "end": 2.5, "text": "你好", "translation": None}]}


def test_subtitles_fetch_fail_empty(fake_ytdlp_fns, monkeypatch):
    """字幕拉取失败 → {items: []}（降级不阻塞主链路）"""

    def boom(url):
        raise RuntimeError("字幕拉取失败: 上游 403")

    monkeypatch.setattr(video_ytdlp, "fetch_subtitle", boom)
    r = client.get("/api/video-online/subtitles", params={"url": BILI_URL, "lang": "zh-Hans"})
    assert r.status_code == 200
    assert r.json() == {"items": []}


def test_subtitles_missing_lang_400(fake_ytdlp_fns):
    """缺 lang → 400"""
    r = client.get("/api/video-online/subtitles", params={"url": BILI_URL})
    assert r.status_code == 400


def test_subtitles_bad_url_400(fake_ytdlp_fns):
    """非 http(s) url → 400"""
    r = client.get(
        "/api/video-online/subtitles", params={"url": "file:///etc/passwd", "lang": "zh"}
    )
    assert r.status_code == 400
