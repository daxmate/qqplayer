"""夸克 provider 测试（全 mock 网络，不依赖真实夸克服务）。

覆盖: pick_file 音质挑选 / resolve_share 分享解析（递归、翻页、去重、失败兜底）/
get_download_url 直链（请求头与 body 断言、未登录抛错、401 清 cookie）/
登录态 cookie 存取 / login_status 轮询分支 / refresh_puus。
"""

import json

import httpx
import pytest

import quark_provider as qp


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    """每个用例独立：cookie 文件指向 tmp、客户端工厂可注入、清空内部状态"""
    monkeypatch.setattr(qp, "COOKIE_FILE", tmp_path / "quark_cookies.json")
    monkeypatch.setattr(qp, "_drive_client", None)
    qp._QR_TOKENS.clear()
    yield
    qp._QR_TOKENS.clear()


def install_transport(monkeypatch, handler):
    """把所有请求走 MockTransport（drive 客户端带 UA/Referer，anon 客户端浏览器 UA）"""

    def drive_factory():
        return httpx.Client(
            transport=httpx.MockTransport(handler),
            headers={"User-Agent": qp.QUARK_CLIENT_UA, "Referer": qp.REFERER},
            timeout=15.0,
        )

    def anon_factory():
        return httpx.Client(
            transport=httpx.MockTransport(handler),
            headers={"User-Agent": qp.BROWSER_UA},
            timeout=15.0,
        )

    monkeypatch.setattr(qp, "_new_drive_client", drive_factory)
    monkeypatch.setattr(qp, "_new_anon_client", anon_factory)


def sample_file(fid, name, size=1024, fmt="file", token="tok"):
    return {
        "fid": fid,
        "file_name": name,
        "size": size,
        "format_type": fmt,
        "share_fid_token": token,
        "ext": qp._ext_of(name),
    }


# ---------------- pick_file ----------------


def test_pick_flac_preferred():
    files = [sample_file("1", "song.mp3"), sample_file("2", "song.flac", size=999999)]
    assert qp.pick_file(files, "flac")["fid"] == "2"


def test_pick_mp3_default():
    files = [sample_file("1", "song.flac", size=999999), sample_file("2", "song.mp3")]
    assert qp.pick_file(files, "mp3")["fid"] == "2"
    assert qp.pick_file(files, "")["fid"] == "2"
    assert qp.pick_file(files, None)["fid"] == "2"


def test_pick_flac_missing_falls_back_to_mp3():
    files = [sample_file("1", "song.mp3")]
    assert qp.pick_file(files, "flac")["fid"] == "1"


def test_pick_mp3_missing_falls_back_to_flac():
    files = [sample_file("1", "song.flac")]
    assert qp.pick_file(files, "mp3")["fid"] == "1"


def test_pick_other_audio_as_last_resort():
    files = [sample_file("1", "song.wav"), sample_file("2", "cover.jpg")]
    assert qp.pick_file(files, "mp3")["fid"] == "1"
    assert qp.pick_file([sample_file("1", "song.m4a")], "flac")["fid"] == "1"


def test_pick_empty_list_returns_none():
    assert qp.pick_file([], "flac") is None
    assert qp.pick_file([], "mp3") is None


def test_pick_case_insensitive_ext():
    files = [sample_file("1", "SONG.FLAC"), sample_file("2", "song.MP3")]
    assert qp.pick_file(files, "flac")["fid"] == "1"
    assert qp.pick_file(files, "mp3")["fid"] == "2"


def test_pick_dir_items_ignored():
    files = [sample_file("1", "album", fmt="folder"), sample_file("2", "song.mp3")]
    assert qp.pick_file(files, "mp3")["fid"] == "2"


def test_pick_prefers_larger_when_same_format():
    files = [sample_file("1", "song.mp3", size=10), sample_file("2", "song.mp3", size=99)]
    assert qp.pick_file(files, "mp3")["fid"] == "2"


# ---------------- resolve_share ----------------


def _share_handler(dirs):
    """构造 sharepage token/detail 的 mock handler。

    dirs: {pdir_fid: [item, ...]}，item 为 detail list 里的原始字段。
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/share/sharepage/token"):
            body = json.loads(request.content)
            assert body["pwd_id"] == "abc123"
            assert body["passcode"] == ""
            assert request.headers.get("origin") == "https://pan.quark.cn"
            return httpx.Response(
                200,
                json={"status": 200, "code": 0, "message": "ok", "data": {"stoken": "stk-1"}},
            )
        if request.method == "GET" and request.url.path.endswith("/share/sharepage/detail"):
            assert request.url.params["stoken"] == "stk-1"
            lst = dirs.get(request.url.params["pdir_fid"], [])
            return httpx.Response(
                200,
                json={
                    "status": 200,
                    "code": 0,
                    "message": "ok",
                    "data": {"list": lst, "count": len(lst)},
                    "metadata": {"_total": len(lst)},
                },
            )
        return httpx.Response(404, json={"code": -1, "message": "no mock"})

    return handler


def test_resolve_share_flat_and_recursive(monkeypatch):
    dirs = {
        "0": [
            {
                "fid": "f1",
                "file_name": "song.mp3",
                "size": 100,
                "format_type": "mp3",
                "share_fid_token": "t1",
            },
            {
                "fid": "d1",
                "file_name": "专辑",
                "size": 0,
                "format_type": "folder",
                "share_fid_token": "td1",
            },
        ],
        "d1": [
            {
                "fid": "f2",
                "file_name": "song.flac",
                "size": 200,
                "format_type": "flac",
                "share_fid_token": "t2",
            },
        ],
    }
    install_transport(monkeypatch, _share_handler(dirs))
    files = qp.resolve_share("https://pan.quark.cn/s/abc123")
    fids = [f["fid"] for f in files]
    assert "f1" in fids and "f2" in fids  # 目录递归取到深层文件
    assert "d1" in fids  # 目录项也返回（ext 为空）
    by_fid = {f["fid"]: f for f in files}
    assert by_fid["f1"]["ext"] == ".mp3"
    assert by_fid["f2"]["ext"] == ".flac"
    assert by_fid["f2"]["share_fid_token"] == "t2"
    assert by_fid["f1"]["size"] == 100
    assert by_fid["f2"]["format_type"] == "flac"


def test_resolve_share_real_shape_int_file_type(monkeypatch):
    """真实夸克接口形状：file_type 是数字（0=文件，1=目录），必须正确识别并递归"""
    dirs = {
        "0": [
            {
                "fid": "f1",
                "file_name": "晴天-周杰伦.mp3",
                "size": 10792943,
                "format_type": "mp3",
                "file_type": 0,
                "share_fid_token": "t1",
            },
            {
                "fid": "d1",
                "file_name": "专辑",
                "size": 0,
                "format_type": "folder",
                "file_type": 1,
                "share_fid_token": "td1",
            },
        ],
        "d1": [
            {
                "fid": "f2",
                "file_name": "晴天-周杰伦.flac",
                "size": 30000000,
                "format_type": "flac",
                "file_type": 0,
                "share_fid_token": "t2",
            },
        ],
    }
    install_transport(monkeypatch, _share_handler(dirs))
    files = qp.resolve_share("https://pan.quark.cn/s/abc123")
    fids = [f["fid"] for f in files]
    # file_type=1 的目录项被识别并递归进去取到 f2；不因 int 报错
    assert "f1" in fids and "f2" in fids


def test_resolve_share_pagination(monkeypatch):
    detail_calls = {"n": 0}

    def handler(request):
        if request.method == "POST" and request.url.path.endswith("/share/sharepage/token"):
            return httpx.Response(200, json={"code": 0, "data": {"stoken": "s"}})
        if request.method == "GET" and request.url.path.endswith("/share/sharepage/detail"):
            detail_calls["n"] += 1
            page = int(request.url.params["_page"])
            if page == 1:
                lst = [
                    {
                        "fid": f"f{i}",
                        "file_name": f"a{i}.mp3",
                        "size": i,
                        "format_type": "mp3",
                        "share_fid_token": "t",
                    }
                    for i in range(50)
                ]
            else:
                lst = [
                    {
                        "fid": f"f{50 + i}",
                        "file_name": f"a{50 + i}.mp3",
                        "size": i,
                        "format_type": "mp3",
                        "share_fid_token": "t",
                    }
                    for i in range(10)
                ]
            return httpx.Response(
                200,
                json={"code": 0, "data": {"list": lst}, "metadata": {"_total": 60}},
            )
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    files = qp.resolve_share("https://pan.quark.cn/s/abc123")
    assert len(files) == 60
    assert detail_calls["n"] == 2


def test_resolve_share_dedup(monkeypatch):
    dirs = {
        "0": [
            {
                "fid": "f1",
                "file_name": "a.mp3",
                "size": 1,
                "format_type": "mp3",
                "share_fid_token": "t1",
            },
            {
                "fid": "f1",
                "file_name": "a.mp3",
                "size": 1,
                "format_type": "mp3",
                "share_fid_token": "t1",
            },
        ]
    }
    install_transport(monkeypatch, _share_handler(dirs))
    files = qp.resolve_share("https://pan.quark.cn/s/abc123")
    assert len(files) == 1


def test_resolve_share_depth_limit(monkeypatch):
    def handler(request):
        if request.method == "POST" and request.url.path.endswith("/share/sharepage/token"):
            return httpx.Response(200, json={"code": 0, "data": {"stoken": "s"}})
        if request.method == "GET" and request.url.path.endswith("/share/sharepage/detail"):
            pdir = request.url.params["pdir_fid"]
            nxt = {"0": "d1", "d1": "d2", "d2": "d3", "d3": "d4"}.get(pdir)
            lst = (
                [{"fid": nxt, "file_name": nxt, "format_type": "folder", "share_fid_token": "x"}]
                if nxt
                else []
            )
            return httpx.Response(
                200, json={"code": 0, "data": {"list": lst}, "metadata": {"_total": len(lst)}}
            )
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    files = qp.resolve_share("https://pan.quark.cn/s/abc123")
    fids = {f["fid"] for f in files}
    assert {"d1", "d2", "d3"} <= fids
    assert "d4" not in fids  # 深度 > 3 不再进入


def test_resolve_share_failure_returns_empty(monkeypatch):
    def handler(request):
        return httpx.Response(500, json={"code": 1, "message": "boom"})

    install_transport(monkeypatch, handler)
    assert qp.resolve_share("https://pan.quark.cn/s/bad123") == []


def test_resolve_share_invalid_url_returns_empty(monkeypatch):
    install_transport(monkeypatch, lambda r: httpx.Response(200, json={}))
    assert qp.resolve_share("https://example.com/not-quark") == []


def test_resolve_share_token_failure_returns_empty(monkeypatch):
    def handler(request):
        if request.method == "POST" and request.url.path.endswith("/share/sharepage/token"):
            return httpx.Response(200, json={"status": 200, "code": 31002, "message": "分享已失效"})
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    assert qp.resolve_share("https://pan.quark.cn/s/abc123") == []


# ---------------- get_download_url ----------------


def _login_cookie_file(tmp_path):
    f = tmp_path / "quark_cookies.json"
    f.write_text(json.dumps({"kps": "abc"}), encoding="utf-8")
    return f


def test_get_download_url_requires_login(monkeypatch, tmp_path):
    install_transport(monkeypatch, lambda r: httpx.Response(200, json={}))
    with pytest.raises(RuntimeError, match="quark login required"):
        qp.get_download_url("https://pan.quark.cn/s/abc123", "fid1", "tok1", "stk-1")


def test_get_download_url_ok(monkeypatch, tmp_path):
    _login_cookie_file(tmp_path)
    captured = {}

    def handler(request):
        if request.method == "POST" and request.url.path.endswith("/file/download"):
            captured["url"] = str(request.url)
            captured["body"] = json.loads(request.content)
            captured["ua"] = request.headers.get("user-agent")
            captured["referer"] = request.headers.get("referer")
            captured["cookie"] = request.headers.get("cookie")
            return httpx.Response(
                200,
                json={
                    "status": 200,
                    "code": 0,
                    "message": "ok",
                    "data": [
                        {"fid": "fid1", "download_url": "https://down.example/x.mp3?sign=abc"}
                    ],
                },
            )
        if request.method == "POST" and request.url.path.endswith("/share/sharepage/token"):
            return httpx.Response(200, json={"code": 0, "data": {"stoken": "stk-9"}})
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    url, headers = qp.get_download_url("https://pan.quark.cn/s/abc123", "fid1", "tok1", "stk-1")
    assert url == "https://down.example/x.mp3?sign=abc"
    # 下载头快照：签名绑定获取直链时的 UA/Cookie/Referer（下载必须一致，否则 412）
    assert headers["User-Agent"] == qp.QUARK_CLIENT_UA
    assert headers["Referer"] == qp.REFERER
    assert headers["Origin"] == "https://pan.quark.cn"
    assert "kps=abc" in headers["Cookie"]
    # 请求头
    assert captured["ua"] == qp.QUARK_CLIENT_UA
    assert captured["referer"] == qp.REFERER
    assert captured["cookie"] == "kps=abc"
    # 请求参数与 body：stoken 必须与 share_fid_token 同源（外部传入，非重新获取）
    assert "pr=ucpro" in captured["url"] and "fr=pc" in captured["url"]
    assert captured["body"] == {
        "fids": ["fid1"],
        "fids_token": ["tok1"],
        "pwd_id": "abc123",
        "stoken": "stk-1",
    }


def test_get_download_url_401_keeps_cookie(monkeypatch, tmp_path):
    """401/403 不删 cookie 文件（保留现场诊断；登录失效由 login_state 冒烟判定）"""
    cookie_file = _login_cookie_file(tmp_path)

    def handler(request):
        if request.method == "POST" and request.url.path.endswith("/file/download"):
            return httpx.Response(401, json={"code": 40100, "message": "unauthenticated"})
        if request.method == "POST" and request.url.path.endswith("/share/sharepage/token"):
            return httpx.Response(200, json={"code": 0, "data": {"stoken": "s"}})
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="quark login required"):
        qp.get_download_url("https://pan.quark.cn/s/abc123", "fid1", "t", "stk-1")
    assert cookie_file.exists()  # 不删文件，避免扫码-下载-重扫死循环


# ---------------- 扫码登录 ----------------


def test_login_qrcode_returns_data_uri(monkeypatch):
    def handler(request):
        if "getTokenForQrcodeLogin" in str(request.url):
            assert request.url.params["client_id"] == "532"
            return httpx.Response(
                200,
                json={"status": 200, "code": 0, "data": {"members": {"token": "sta-token-1"}}},
            )
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    result = qp.login_qrcode()
    assert result["expires_in"] == 170
    assert result["qr_image"].startswith("data:image/png;base64,")
    assert result["qr_id"] in qp._QR_TOKENS
    assert qp._QR_TOKENS[result["qr_id"]] == "sta-token-1"


def test_login_qrcode_fails_without_token(monkeypatch):
    install_transport(
        monkeypatch,
        lambda r: httpx.Response(200, json={"status": 200, "code": 0, "data": {"members": {}}}),
    )
    with pytest.raises(RuntimeError):
        qp.login_qrcode()


def test_login_status_waiting(monkeypatch):
    qp._QR_TOKENS["qr1"] = "tok-abc"

    def handler(request):
        if "getServiceTicketByQrcodeToken" in str(request.url):
            assert request.url.params["token"] == "tok-abc"
            return httpx.Response(200, json={"status": 50004001, "code": 0, "message": "waiting"})
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    assert qp.login_status("qr1") == {"status": "waiting"}


def test_login_status_expired(monkeypatch):
    qp._QR_TOKENS["qr1"] = "tok-abc"

    def handler(request):
        return httpx.Response(200, json={"status": 50004002, "code": 0, "message": "expired"})

    install_transport(monkeypatch, handler)
    st = qp.login_status("qr1")
    assert st["status"] == "expired"
    assert "qr1" not in qp._QR_TOKENS  # 过期后清理映射


def test_login_status_unknown_qr_id(monkeypatch):
    install_transport(monkeypatch, lambda r: httpx.Response(200, json={}))
    st = qp.login_status("nonexistent")
    assert st["status"] == "error"
    assert "登录会话已失效" in st["message"]


def test_login_status_error_status(monkeypatch):
    qp._QR_TOKENS["qr1"] = "tok-abc"

    def handler(request):
        return httpx.Response(200, json={"status": 999999, "code": 0, "message": "some error"})

    install_transport(monkeypatch, handler)
    assert qp.login_status("qr1")["status"] == "error"


def test_login_status_ok_persists_cookie(monkeypatch, tmp_path):
    qp._QR_TOKENS["qr1"] = "tok-abc"

    def handler(request):
        url = str(request.url)
        if "getServiceTicketByQrcodeToken" in url:
            return httpx.Response(
                200,
                json={
                    "status": 2000000,
                    "code": 0,
                    "data": {"members": {"service_ticket": "st-ticket-1"}},
                },
            )
        if "account/info" in url:
            assert request.url.params.get("st") == "st-ticket-1"
            assert request.url.params.get("lw") == "scan"
            return httpx.Response(
                200,
                json={"success": True, "code": 0, "data": {"nickname": "小夸", "id": 1}},
                headers={"set-cookie": "kps=xyz; Path=/; Domain=.quark.cn"},
            )
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    st = qp.login_status("qr1")
    assert st["status"] == "ok"
    assert st["nickname"] == "小夸"
    # cookie 已持久化
    saved = json.loads(qp.COOKIE_FILE.read_text(encoding="utf-8"))
    assert saved["kps"] == "xyz"


# ---------------- 登录态检查 / 登出 / cookie 存取 ----------------


def test_login_state_not_logged_in(monkeypatch, tmp_path):
    install_transport(monkeypatch, lambda r: httpx.Response(200, json={}))
    assert qp.login_state() == {"logged_in": False, "nickname": None}


def test_login_state_logged_in(monkeypatch, tmp_path):
    _login_cookie_file(tmp_path)

    def handler(request):
        if "account/info" in str(request.url):
            return httpx.Response(
                200, json={"success": True, "code": 0, "data": {"nickname": "小夸"}}
            )
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    assert qp.login_state() == {"logged_in": True, "nickname": "小夸"}


def test_login_state_401_clears_cookie(monkeypatch, tmp_path):
    cookie_file = _login_cookie_file(tmp_path)

    def handler(request):
        if "account/info" in str(request.url):
            return httpx.Response(401, json={"code": 40100, "message": "unauthenticated"})
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    assert qp.login_state() == {"logged_in": False, "nickname": None}
    assert not cookie_file.exists()


def test_logout_deletes_cookie_file(monkeypatch, tmp_path):
    cookie_file = _login_cookie_file(tmp_path)
    install_transport(monkeypatch, lambda r: httpx.Response(200, json={}))
    qp.logout()
    assert not cookie_file.exists()


# ---------------- refresh_puus ----------------


def test_refresh_puus_persists_new_cookie(monkeypatch, tmp_path):
    cookie_file = _login_cookie_file(tmp_path)
    cookie_file.write_text(json.dumps({"kps": "abc", "__puus": "old"}), encoding="utf-8")

    def handler(request):
        if request.url.path.endswith("/clouddrive/config"):
            return httpx.Response(
                200,
                json={"status": 200, "code": 0},
                headers={"set-cookie": "__puus=new-puus; Path=/; Domain=.quark.cn"},
            )
        return httpx.Response(404, json={})

    install_transport(monkeypatch, handler)
    qp.refresh_puus()
    saved = json.loads(cookie_file.read_text(encoding="utf-8"))
    assert saved.get("__puus") == "new-puus"
    assert saved.get("kps") == "abc"


def test_refresh_puus_keeps_old_when_not_reissued(monkeypatch, tmp_path):
    cookie_file = _login_cookie_file(tmp_path)
    cookie_file.write_text(json.dumps({"kps": "abc", "__puus": "old"}), encoding="utf-8")

    def handler(request):
        # 服务端未重新下发 __puus
        return httpx.Response(200, json={"status": 200, "code": 0})

    install_transport(monkeypatch, handler)
    qp.refresh_puus()
    saved = json.loads(cookie_file.read_text(encoding="utf-8"))
    assert saved.get("__puus") == "old"


def test_refresh_puus_silent_on_failure(monkeypatch, tmp_path):
    _login_cookie_file(tmp_path)
    install_transport(monkeypatch, lambda r: httpx.Response(500, json={}))
    qp.refresh_puus()  # 不抛异常
