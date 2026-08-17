"""任务 D：yt-dlp 在线源后端测试（mock subprocess / mock httpx，不依赖真实外部服务）。

- video_ytdlp：resolve 解析 / get_stream 格式选择 / get_subtitles / download / 字幕内容解析 / 失败与超时
- video_providers：注册表 / B站 provider（Referer）/ 通用 provider / url host 推断
- video-online 路由：resolve 成功与失败 / stream Range 206 / 403 自动重试一次 / url 校验 / 字幕

运行：cd /Users/dax/codes/qqplayerD && /Users/dax/codes/qqplayer/venv/bin/python -m pytest tests/test_video_online.py -q
"""

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

    def run_fn(args, timeout, what, cookie=None):
        state["calls"].append((args, timeout, what, cookie))
        if callable(state["proc"]):
            return state["proc"](args, timeout, what)
        return state["proc"]

    monkeypatch.setattr(video_ytdlp, "_run", run_fn)
    return state


@pytest.fixture
def fake_ytdlp_fns(monkeypatch):
    """mock 路由依赖的 video_ytdlp 三个顶层函数（resolve/get_stream/get_subtitles）"""
    monkeypatch.setattr(video_ytdlp, "resolve", lambda url, cookie=None: dict(SAMPLE_INFO))
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None: "http://up.test/1080.mp4",
    )
    monkeypatch.setattr(
        video_ytdlp,
        "get_subtitles",
        lambda url: [
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
    for i, (_args, _, _, cookie) in enumerate(fake_run["calls"]):
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
    for args, _, _, cookie in fake_run["calls"]:
        assert cookie in (None, ""), "未设置 cookie 时不应传值"
        assert "--add-header" not in args


def test_bili_provider_referer_header():
    """B站流代理附加 Referer 防盗链头"""
    headers = vp.get_provider("bilibili").stream_headers(BILI_URL)
    assert headers == {"Referer": "https://www.bilibili.com"}
    assert vp.get_provider("generic").stream_headers(BILI_URL) == {}


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
    """bilibili.com url 不带 source → 自动走 B站 provider"""
    r = client.post("/api/video-online/resolve", json={"url": BILI_URL, "source": "bilibili"})
    assert r.status_code == 200
    assert r.json()["provider"] == "bilibili"


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
    """Range 透传 + 206 + content-range/accept-ranges 透传；UA 头默认带"""
    monkeypatch.setattr(video_ytdlp, "resolve", lambda url, cookie=None: dict(SAMPLE_INFO))
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None: "http://up.test/1080.mp4",
    )
    fake_proxy_stream["resp"] = _FakeUpstream(
        chunks=[b"x" * 1024],
        status_code=206,
        headers={"content-range": "bytes 0-1023/102400", "accept-ranges": "bytes"},
    )
    r = client.get(
        "/api/video-online/stream", params={"url": GENERIC_URL}, headers={"Range": "bytes=0-1023"}
    )
    assert r.status_code == 206
    assert len(r.content) == 1024
    assert r.headers["content-range"] == "bytes 0-1023/102400"
    assert r.headers["accept-ranges"] == "bytes"
    method, url, kw = fake_proxy_stream["calls"][0]
    assert method == "GET"
    assert url == "http://up.test/1080.mp4"
    assert kw["headers"]["Range"] == "bytes=0-1023"
    assert kw["headers"]["User-Agent"]
    assert kw["timeout"] == 60.0 and kw["follow_redirects"] is True and kw["trust_env"] is False


def test_stream_403_retry_once(fake_proxy_stream, monkeypatch):
    """直链 403（过期）→ 重新 resolve 一次再试 → 200"""
    calls = {"n": 0}
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None: f"http://up.test/{calls['n']}.mp4",
    )
    monkeypatch.setattr(video_ytdlp, "resolve", lambda url, cookie=None: dict(SAMPLE_INFO))

    def resp_fn():
        calls["n"] += 1
        if calls["n"] == 1:
            return _FakeUpstream(status_code=403, error=_status_error(403))
        return _FakeUpstream(
            chunks=b"video-data", status_code=200, headers={"content-type": "video/mp4"}
        )

    fake_proxy_stream["resp"] = resp_fn
    r = client.get("/api/video-online/stream", params={"url": BILI_URL})
    assert r.status_code == 200
    assert r.content == b"video-data"
    assert calls["n"] == 2  # 第一次 403 触发重试，第二次成功


def test_stream_403_twice_502(fake_proxy_stream, monkeypatch):
    """重试后仍 403 → 502"""
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None: "http://up.test/x.mp4",
    )
    monkeypatch.setattr(video_ytdlp, "resolve", lambda url, cookie=None: dict(SAMPLE_INFO))
    fake_proxy_stream["resp"] = lambda: _FakeUpstream(status_code=403, error=_status_error(403))
    r = client.get("/api/video-online/stream", params={"url": BILI_URL})
    assert r.status_code == 502
    assert "403" in r.json()["detail"]


def test_stream_connect_error_502(fake_proxy_stream, monkeypatch):
    """上游连接失败（httpx.stream 抛错）→ 502"""
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None: "http://up.test/x.mp4",
    )
    monkeypatch.setattr(video_ytdlp, "resolve", lambda url, cookie=None: dict(SAMPLE_INFO))

    def boom(method, url, **kw):
        raise httpx.ConnectError("connection refused")

    fake_proxy_stream["resp"] = None
    monkeypatch.setattr(video_online.httpx, "stream", boom)
    r = client.get("/api/video-online/stream", params={"url": BILI_URL})
    assert r.status_code == 502


def test_stream_bad_url_400(fake_proxy_stream):
    """非 http(s) url → 400，不发起上游请求；缺 url 参数 → 422"""
    for bad in ("ftp://x/a.mp4", "/api/audio?path=/etc/passwd", ""):
        r = client.get("/api/video-online/stream", params={"url": bad})
        assert r.status_code == 400, f"url={bad!r} 应 400"
    assert fake_proxy_stream["calls"] == []
    assert client.get("/api/video-online/stream").status_code == 422


def test_stream_bilibili_referer(fake_proxy_stream, monkeypatch):
    """B站直链代理附加 Referer: https://www.bilibili.com（host 自动推断 provider）"""
    monkeypatch.setattr(video_ytdlp, "resolve", lambda url, cookie=None: dict(SAMPLE_INFO))
    monkeypatch.setattr(
        video_ytdlp,
        "get_stream",
        lambda url, format_hint="best", cookie=None: "http://up.test/bili.mp4",
    )
    fake_proxy_stream["resp"] = _FakeUpstream(chunks=b"b", headers={"content-type": "video/mp4"})
    r = client.get("/api/video-online/stream", params={"url": BILI_URL})
    assert r.status_code == 200
    kw = fake_proxy_stream["calls"][0][2]
    assert kw["headers"]["Referer"] == "https://www.bilibili.com"


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
        lambda url: [
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
        lambda url: [
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
