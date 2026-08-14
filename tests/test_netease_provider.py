"""netease_provider 网易云 eapi provider 测试（全部 mock 网络，CI 稳定）"""

import json
import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT))
import netease_provider  # noqa: E402


# ============ eapi 加密/解密 ============
def test_eapi_encrypt_fixed_vector():
    """固定输入 → 固定密文（确定值防回归）"""
    assert netease_provider.eapi_encrypt("/api/cloudsearch/pc", {"s": "test"}) == (
        "2B5D64177AA6460FBAA3DCB1285E28954BBB4F7556E09B0FB25750F12398BB505ED15D1B867F700368ED5229193B44B83C11D4560AFF15815EF154F0A8ABB9CF1E546481B2E47DFB465682FDF8903AD090B8A06B426668A758C2CADCE62C8355"
    )


def test_eapi_encrypt_decrypt_roundtrip():
    """加密 → 解密还原 payload（含非 ASCII，报文格式兼容）"""
    payload = {"a": 1, "b": "中文", "header": {"deviceId": "ab"}, "e_r": True}
    ct = netease_provider.eapi_encrypt("/api/song/lyric/v1", payload)
    assert netease_provider.eapi_decrypt(ct.encode()) == payload


def test_eapi_decrypt_json_content_type_first():
    """content-type 含 json 且内容即 JSON → 直接解析，不解密"""
    payload = {"result": {"songs": []}}
    content = json.dumps(payload).encode()
    assert netease_provider.eapi_decrypt(content, content_type="application/json") == payload


def test_eapi_decrypt_json_labeled_but_encrypted():
    """content-type 标 json 但内容是密文 → 解密后解析"""
    from Crypto.Cipher import AES

    from netease_provider import _pkcs7_pad

    text = json.dumps({"x": 1}, separators=(",", ":")).encode()
    cipher = AES.new(netease_provider.EAPI_KEY, AES.MODE_ECB)
    ct = cipher.encrypt(_pkcs7_pad(text, 16)).hex().encode()
    assert netease_provider.eapi_decrypt(ct, content_type="application/json") == {"x": 1}


def test_eapi_decrypt_raw_binary_ciphertext():
    """原始二进制密文（cloudsearch 实测格式）→ 解密后解析"""
    from Crypto.Cipher import AES

    from netease_provider import _pkcs7_pad

    text = json.dumps({"result": {"songs": []}}, separators=(",", ":")).encode()
    cipher = AES.new(netease_provider.EAPI_KEY, AES.MODE_ECB)
    ct = cipher.encrypt(_pkcs7_pad(text, 16))  # 不加 hex，直接原始字节
    assert netease_provider.eapi_decrypt(ct) == {"result": {"songs": []}}


# ============ 逐字歌词 JSON → LRC ============
def test_word_json_to_lrc():
    """新版逐字歌词（JSON-lines）→ 普通 LRC"""
    raw = (
        '{"t":0,"c":[{"tx":"作词: "},{"tx":"周杰伦"}]}\n'
        '{"t":28750,"c":[{"tx":"故事"},{"tx":"的"},{"tx":"小黄花"}]}\n'
        "[00:35.870]童年的荡秋千\n"
    )
    out = netease_provider.word_json_to_lrc(raw)
    lines = out.splitlines()
    assert lines[0] == "[00:00.00]作词: 周杰伦"
    assert lines[1] == "[00:28.75]故事的小黄花"
    assert lines[2] == "[00:35.870]童年的荡秋千"  # 普通 LRC 行原样保留


def test_word_json_to_lrc_passthrough():
    """普通 LRC / 空值 / 损坏 JSON 原样返回，不抛异常"""
    lrc = "[00:01.00]hello\n[00:02.00]world"
    assert netease_provider.word_json_to_lrc(lrc) == lrc
    assert netease_provider.word_json_to_lrc("") == ""
    assert netease_provider.word_json_to_lrc("[00:01.00]broken{json") == "[00:01.00]broken{json"
    assert netease_provider.word_json_to_lrc(None) == ""


def test_word_json_to_lrc_negative_timestamp():
    """t=-1（无时间）按 0 处理，不产生负数时间戳"""
    raw = '{"t":-1,"c":[{"tx":"作曲: "}]}'
    assert netease_provider.word_json_to_lrc(raw) == "[00:00.00]作曲: "


# ============ mock HTTP ============
class FakeResponse:
    def __init__(
        self,
        payload=None,
        status_code=200,
        content_type="application/json",
        headers=None,
        text=None,
    ):
        self.status_code = status_code
        self.headers = dict(headers or {})
        self.headers.setdefault("content-type", content_type)
        self._text = text
        if text is not None:
            self.content = text.encode("utf-8")
        elif payload is not None:
            self.content = json.dumps(payload).encode("utf-8")
        else:
            self.content = b""

    @property
    def text(self):
        return self.content.decode("utf-8")

    def json(self):
        return json.loads(self.content.decode("utf-8"))

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPError(f"status {self.status_code}")


class FakeClient:
    """按调用顺序返回 mock 响应；元素是 Exception 时直接抛出"""

    def __init__(self):
        self.posts = []
        self.gets = []
        self.calls = []

    def post(self, url, **kw):
        self.calls.append(("post", url, kw))
        if self.posts:
            r = self.posts.pop(0)
            if isinstance(r, Exception):
                raise r
            return r
        raise AssertionError(f"未 mock 的 POST: {url}")

    def get(self, url, **kw):
        self.calls.append(("get", url, kw))
        if self.gets:
            r = self.gets.pop(0)
            if isinstance(r, Exception):
                raise r
            return r
        raise AssertionError(f"未 mock 的 GET: {url}")


def make_provider(client=None):
    return netease_provider.NeteaseProvider(client=client or FakeClient())


SONG = {
    "id": 123456,
    "name": "夜に駆ける",
    "ar": [{"name": "YOASOBI"}, {"name": "某人"}],
    "al": {"name": "THE BOOK", "picUrl": "http://p1.music.126.net/cover.jpg"},
    "dt": 261_000,
}


# ============ search ============
def test_search_parses_songs():
    """标准 JSON 响应解析：id 转 str、artist 逗号连接、duration mm:ss、album/cover/level"""
    client = FakeClient()
    client.posts.append(FakeResponse({"result": {"songs": [SONG]}}))
    provider = make_provider(client)
    items = provider.search("夜に駆ける", limit=5)
    assert len(items) == 1
    it = items[0]
    assert it["id"] == "123456"
    assert it["title"] == "夜に駆ける"
    assert it["artist"] == "YOASOBI, 某人"
    assert it["album"] == "THE BOOK"
    assert it["cover"] == "http://p1.music.126.net/cover.jpg"
    assert it["duration"] == "04:21"
    assert it["level"] == "exhigh"
    # payload 结构：header + e_r + 查询参数（解密 params 验证），limit 透传
    _, url, kw = client.calls[0]
    assert url == "https://interface.music.163.com/eapi/cloudsearch/pc"
    dec = netease_provider.eapi_decrypt(kw["data"]["params"].encode())
    assert dec["e_r"] is True
    assert dec["header"]["deviceId"]
    assert dec["s"] == "夜に駆ける" and dec["limit"] == 5 and dec["total"] is True


def test_search_encrypted_response():
    """响应为 AES 密文（content-type 非 json）→ 解密后解析"""
    from Crypto.Cipher import AES

    from netease_provider import _pkcs7_pad

    text = json.dumps({"result": {"songs": [SONG]}}, separators=(",", ":")).encode()
    cipher = AES.new(netease_provider.EAPI_KEY, AES.MODE_ECB)
    ct = cipher.encrypt(_pkcs7_pad(text, 16)).hex()
    client = FakeClient()
    client.posts.append(FakeResponse(content_type="text/plain", text=ct))
    items = make_provider(client).search("x")
    assert items and items[0]["title"] == "夜に駆ける"


def test_search_failure_returns_empty():
    """网络错误 → 返回 [] 不抛异常"""
    client = FakeClient()
    client.posts.append(httpx.TimeoutException("timeout"))
    assert make_provider(client).search("x") == []


def test_search_no_songs():
    client = FakeClient()
    client.posts.append(FakeResponse({"result": {"songs": []}}))
    assert make_provider(client).search("x") == []


def test_search_skips_invalid_song():
    """缺少 id 的歌曲条目被过滤"""
    client = FakeClient()
    client.posts.append(FakeResponse({"result": {"songs": [SONG, {"name": "无id"}]}}))
    items = make_provider(client).search("x")
    assert len(items) == 1


# ============ get_play_info ============
def test_play_info_meting_302():
    """Meting 302 → Location 头为直链"""
    client = FakeClient()
    client.gets.append(
        FakeResponse(status_code=302, headers={"location": "http://cdn.example.com/a.mp3"})
    )
    info = make_provider(client).get_play_info("123", "exhigh")
    assert info == {"url": "http://cdn.example.com/a.mp3", "ext": "mp3", "bitrate": "320"}
    _, url, kw = client.calls[0]
    assert url.startswith("https://api.qijieya.cn/meting/")
    assert kw["params"]["br"] == "320"


def test_play_info_meting_json_array():
    """Meting 200 → body 为 JSON 数组，取首元素 url"""
    client = FakeClient()
    client.gets.append(FakeResponse(content_type="text/plain", text='[{"url": "http://x/y.flac"}]'))
    info = make_provider(client).get_play_info("123")
    assert info["url"] == "http://x/y.flac"
    assert info["ext"] == "flac"


def test_play_info_meting_json_object():
    """Meting 200 → body 为 JSON 对象 {data: url}"""
    client = FakeClient()
    client.gets.append(FakeResponse(text='{"data": "http://x/y.mp3"}'))
    info = make_provider(client).get_play_info("123")
    assert info["url"] == "http://x/y.mp3"
    assert info["ext"] == "mp3"


def test_play_info_fallback_cenguigui():
    """Meting 失败（无直链）→ cenguigui 兜底"""
    client = FakeClient()
    client.gets.append(FakeResponse(content_type="text/plain", text="not a url"))
    client.gets.append(
        FakeResponse({"code": 200, "data": {"url": "https://cdn.x/z.flac", "format": "flac"}})
    )
    info = make_provider(client).get_play_info("123", "lossless")
    assert info["url"] == "https://cdn.x/z.flac"
    assert info["ext"] == "flac"
    assert info["bitrate"] == "flac"
    _, _, kw = client.calls[1]
    assert kw["params"]["level"] == "lossless"


def test_play_info_both_fail_raises():
    """两个源都失败 → 抛异常"""
    client = FakeClient()
    client.gets.append(FakeResponse(status_code=500))
    client.gets.append(FakeResponse({"code": 400}))
    with pytest.raises(ValueError):
        make_provider(client).get_play_info("123")


def test_play_info_invalid_level_defaults():
    """非法 level → 回落默认 exhigh（br=320）"""
    client = FakeClient()
    client.gets.append(FakeResponse(status_code=302, headers={"location": "http://x/y.mp3"}))
    info = make_provider(client).get_play_info("123", "jymaster")
    assert info["bitrate"] == "320"


# ============ get_lyric ============
def test_get_lyric_parses():
    """歌词响应 → {lrc, tlyric, yrc, romalrc}（lrc/tlyric 为 {"lyric": ...} 结构）"""
    client = FakeClient()
    client.posts.append(
        FakeResponse(
            {
                "lrc": {"lyric": "[00:01.00]沈むように"},
                "tlyric": {"lyric": "[00:01.00]像是沉溺"},
                "yrc": None,
                "romalrc": None,
            }
        )
    )
    data = make_provider(client).get_lyric("123")
    assert data["lrc"]["lyric"] == "[00:01.00]沈むように"
    assert data["tlyric"]["lyric"] == "[00:01.00]像是沉溺"
    assert data["yrc"] is None and data["romalrc"] is None
    # payload 中 id 转 int
    _, _, kw = client.calls[0]
    assert "params" in kw["data"]


def test_get_lyric_missing_fields():
    """响应缺字段 → 对应值为 None，不抛异常"""
    client = FakeClient()
    client.posts.append(FakeResponse({}))
    data = make_provider(client).get_lyric("1")
    assert data == {"lrc": None, "tlyric": None, "yrc": None, "romalrc": None}


def test_get_lyric_invalid_id_raises():
    with pytest.raises(ValueError):
        make_provider(FakeClient()).get_lyric("abc")


def test_get_lyric_network_error_raises():
    client = FakeClient()
    client.posts.append(httpx.TimeoutException("timeout"))
    with pytest.raises(httpx.HTTPError):
        make_provider(client).get_lyric("1")


def test_module_level_functions_delegate():
    """模块级 search/get_play_info/get_lyric 委托给默认实例"""
    assert callable(netease_provider.search)
    assert callable(netease_provider.get_play_info)
    assert callable(netease_provider.get_lyric)
