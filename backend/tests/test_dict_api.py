"""dict API 测试：扫描 / 添加 / 上传 / 激活 / 启停 / 删除 / 查询 / 资源 / 词频。

设置与上传目录全部隔离到 tmp_path；词典用 fixtures 现场生成的最小 MDX/MDD。
运行：cd ~/codes/qqplayerB && ~/codes/qqplayer/venv/bin/python -m pytest tests/test_dict_api.py -q
"""

import shutil
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import backend  # noqa: E402
from app import state  # noqa: E402
from app.services import dict_reader  # noqa: E402
from app.services import settings as settings_service  # noqa: E402
from tests.fixtures.mini_mdict import build_mdd, build_mdx  # noqa: E402

client = TestClient(backend.app)

DEFINE_ENTRIES = [
    (
        "hello",
        '<link href="mini.css"><b>hello</b> 你好 <img src="img/hi.gif"> sound://sound/hello.mp3',
    ),
    ("helloed", "<b>helloed</b>"),
    ("cats", "<b>cats</b>"),
]
DEFINE_MDD = [
    (r"\mini.css", b"body{}"),
    (r"\img\hi.gif", b"GIF89a"),
    (r"\sound\hello.mp3", b"ID3"),
]
FREQ_ENTRIES = [
    ("the", '<span class="rank">1</span>'),
    ("hello", '<span class="rank">18253</span>'),
]


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """settings / 上传目录隔离 + 缓存清理（每测试后重置）"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(state, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(state, "DICTS_DIR", tmp_path / "data" / "dicts")
    state._settings = None
    dict_reader.clear_cache()
    yield
    state._settings = None
    dict_reader.clear_cache()


@pytest.fixture
def dicts_dir(tmp_path):
    """mini 释义词典（mdx+mdd）与 COCA 词频词典（仅 mdx）"""
    build_mdx(tmp_path / "mini.mdx", DEFINE_ENTRIES)
    build_mdd(tmp_path / "mini.mdd", DEFINE_MDD)
    build_mdx(tmp_path / "COCA Frequency 60000.mdx", FREQ_ENTRIES)
    return tmp_path


def _add(path: str, name: str | None = None) -> dict:
    body = {"path": path}
    if name is not None:
        body["name"] = name
    r = client.post("/api/dict", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ============ 配置 ============
def test_get_empty():
    r = client.get("/api/dict")
    assert r.status_code == 200
    assert r.json() == {"dictionaries": [], "activeDictId": ""}


def test_scan_dir_with_mdd(dicts_dir):
    r = client.post("/api/dict/scan", json={"path": str(dicts_dir)})
    assert r.status_code == 200
    cands = {c["name"]: c for c in r.json()}
    assert set(cands) == {"mini", "COCA Frequency 60000"}
    assert cands["mini"]["mddExists"] is True
    assert cands["mini"]["path"].endswith("mini.mdx")
    assert cands["mini"]["size"] > 0
    assert cands["COCA Frequency 60000"]["mddExists"] is False


def test_scan_subdir_one_level(tmp_path):
    sub = tmp_path / "dicts"
    sub.mkdir()
    build_mdx(tmp_path / "top.mdx", DEFINE_ENTRIES)
    build_mdx(sub / "nested.mdx", DEFINE_ENTRIES)
    deep = sub / "deep"
    deep.mkdir()
    build_mdx(deep / "too_deep.mdx", DEFINE_ENTRIES)
    r = client.post("/api/dict/scan", json={"path": str(tmp_path)})
    assert r.status_code == 200
    names = {c["name"] for c in r.json()}
    assert names == {"top", "nested"}  # 只递归一层，deep 不出现


def test_scan_single_file(dicts_dir):
    r = client.post("/api/dict/scan", json={"path": str(dicts_dir / "mini.mdx")})
    assert r.status_code == 200
    assert [c["name"] for c in r.json()] == ["mini"]


def test_scan_not_found():
    r = client.post("/api/dict/scan", json={"path": "/no/such/path"})
    assert r.status_code == 404
    assert r.json()["detail"] == "path not found"


def test_scan_no_mdx(tmp_path):
    r = client.post("/api/dict/scan", json={"path": str(tmp_path)})
    assert r.status_code == 200
    assert r.json() == []


def test_add_and_get(dicts_dir):
    item = _add(str(dicts_dir / "mini.mdx"))
    assert item["id"].startswith("d_")
    assert item["name"] == "mini"
    assert item["kind"] == "local"
    assert item["role"] == "define"
    assert item["enabled"] is True
    assert item["addedAt"] > 0
    r = client.get("/api/dict")
    assert r.json()["dictionaries"] == [item]


def test_add_frequency_role(dicts_dir):
    item = _add(str(dicts_dir / "COCA Frequency 60000.mdx"))
    assert item["role"] == "frequency"


def test_add_custom_name(dicts_dir):
    item = _add(str(dicts_dir / "mini.mdx"), name="迷你词典")
    assert item["name"] == "迷你词典"


def test_add_duplicate(dicts_dir):
    _add(str(dicts_dir / "mini.mdx"))
    r = client.post("/api/dict", json={"path": str(dicts_dir / "mini.mdx")})
    assert r.status_code == 409
    assert r.json()["detail"] == "already added"


def test_add_invalid_path(dicts_dir):
    assert client.post("/api/dict", json={"path": str(dicts_dir / "mini.mdd")}).status_code == 400
    assert client.post("/api/dict", json={"path": str(dicts_dir / "nope.mdx")}).status_code == 400


def test_activate(dicts_dir):
    d1 = _add(str(dicts_dir / "mini.mdx"))
    r = client.post("/api/dict/activate", json={"id": d1["id"]})
    assert r.status_code == 200
    assert r.json() == {"activeDictId": d1["id"]}
    assert client.get("/api/dict").json()["activeDictId"] == d1["id"]


def test_activate_not_found(dicts_dir):
    r = client.post("/api/dict/activate", json={"id": "d_nope"})
    assert r.status_code == 404


def test_patch_enabled(dicts_dir):
    d = _add(str(dicts_dir / "mini.mdx"))
    r = client.patch(f"/api/dict/{d['id']}", json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    r = client.patch(f"/api/dict/{d['id']}", json={"enabled": True})
    assert r.json()["enabled"] is True
    assert client.patch(f"/api/dict/{d['id']}", json={"enabled": "yes"}).status_code == 400
    assert client.patch("/api/dict/d_nope", json={"enabled": False}).status_code == 404


def test_delete_local(dicts_dir):
    d = _add(str(dicts_dir / "mini.mdx"))
    client.post("/api/dict/activate", json={"id": d["id"]})
    r = client.delete(f"/api/dict/{d['id']}")
    assert r.status_code == 204
    s = client.get("/api/dict").json()
    assert s["dictionaries"] == []
    assert s["activeDictId"] == ""  # 激活的词典被删 → 清空
    assert client.delete(f"/api/dict/{d['id']}").status_code == 404


# ============ 上传 ============
def _upload(tmp_path, filename: str, data: bytes):
    p = tmp_path / filename
    p.write_bytes(data)
    with p.open("rb") as f:
        return client.post("/api/dict/upload", files={"file": (filename, f)})


def test_upload_mdx(dicts_dir, tmp_path):
    r = _upload(tmp_path, "my dict.mdx", (dicts_dir / "mini.mdx").read_bytes())
    assert r.status_code == 200
    item = r.json()
    assert item["kind"] == "uploaded"
    assert item["name"] == "my dict"
    assert item["role"] == "define"
    assert item["path"].startswith(str(state.DICTS_DIR))
    assert (state.DICTS_DIR / f"{item['id'][2:]}.mdx").exists()
    assert client.get("/api/dict").json()["dictionaries"] == [item]


def test_upload_mdd_matches_mdx(dicts_dir, tmp_path):
    mdx_item = _upload(tmp_path, "my dict.mdx", (dicts_dir / "mini.mdx").read_bytes()).json()
    r = _upload(tmp_path, "my dict.mdd", (dicts_dir / "mini.mdd").read_bytes())
    assert r.status_code == 200
    assert r.json() == mdx_item  # 返回补挂后的配置项
    assert (state.DICTS_DIR / f"{mdx_item['id'][2:]}.mdd").exists()


def test_upload_mdd_no_match(tmp_path):
    r = _upload(tmp_path, "lonely.mdd", b"MDD-DATA")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_upload_bad_ext(tmp_path):
    r = _upload(tmp_path, "readme.txt", b"hi")
    assert r.status_code == 400


def test_upload_frequency_role(dicts_dir, tmp_path):
    r = _upload(
        tmp_path, "COCA Frequency 60000.mdx", (dicts_dir / "COCA Frequency 60000.mdx").read_bytes()
    )
    assert r.status_code == 200
    assert r.json()["role"] == "frequency"


def test_delete_uploaded_removes_files(dicts_dir, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr("app.routers.dict.send2trash", _FakeSend2Trash(calls))
    item = _upload(tmp_path, "my dict.mdx", (dicts_dir / "mini.mdx").read_bytes()).json()
    cid = item["id"][2:]
    assert (state.DICTS_DIR / f"{cid}.mdx").exists()
    r = client.delete(f"/api/dict/{item['id']}")
    assert r.status_code == 204
    assert (state.DICTS_DIR / f"{cid}.mdx").exists() is False  # 已移废纸篓
    assert any(str(state.DICTS_DIR / f"{cid}.mdx") in c for c in calls)


class _FakeSend2Trash:
    def __init__(self, calls):
        self.calls = calls

    def send2trash(self, path):
        self.calls.append(path)
        p = Path(path)
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()


# ============ 查询 ============
def test_query_found_with_audio_and_frequency(dicts_dir):
    d = _add(str(dicts_dir / "mini.mdx"))
    _add(str(dicts_dir / "COCA Frequency 60000.mdx"))
    client.post("/api/dict/activate", json={"id": d["id"]})
    r = client.get("/api/dict/query", params={"word": "hello"})
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is True
    assert "<b>hello</b>" in body["html"]
    assert body["source"] == "mini"
    assert body["audio"] == [
        {"label": "英", "url": f"/api/dict/resource/{d['id']}/sound/hello.mp3"}
    ]
    assert body["frequency"] == {"rank": 18253, "total": 2}


def test_query_uses_active_dict(dicts_dir):
    d = _add(str(dicts_dir / "mini.mdx"))
    client.post("/api/dict/activate", json={"id": d["id"]})
    r = client.get("/api/dict/query", params={"word": "hello"})
    assert r.json()["found"] is True


def test_query_explicit_dict_id(dicts_dir):
    d = _add(str(dicts_dir / "mini.mdx"))
    client.post("/api/dict/activate", json={"id": "d_wrong"})  # 非法激活不生效
    r = client.get("/api/dict/query", params={"word": "hello", "dictId": d["id"]})
    assert r.status_code == 200
    assert r.json()["found"] is True


def test_query_variants(dicts_dir):
    _add(str(dicts_dir / "mini.mdx"))
    r = client.get("/api/dict/query", params={"word": "cat"})
    assert r.json()["found"] is True
    assert "<b>cats</b>" in r.json()["html"]


def test_query_miss(dicts_dir):
    _add(str(dicts_dir / "mini.mdx"))
    r = client.get("/api/dict/query", params={"word": "zzz"})
    body = r.json()
    assert body["found"] is False
    assert body["html"] == ""
    assert body["source"] == ""
    assert body["audio"] == []
    assert body["frequency"] is None


def test_query_no_dictionary():
    r = client.get("/api/dict/query", params={"word": "hello"})
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is False
    assert body["error"] == "no dictionary configured"


def test_query_dict_not_found(dicts_dir):
    r = client.get("/api/dict/query", params={"word": "hello", "dictId": "d_nope"})
    assert r.status_code == 404


def test_query_word_required():
    assert client.get("/api/dict/query", params={"word": "  "}).status_code == 400


def test_query_load_failed(tmp_path, dicts_dir):
    """词典文件损坏 → 200 + error（不 500），且 evict 后可重试"""
    bad = tmp_path / "bad.mdx"
    bad.write_bytes(b"garbage not mdx")
    _add(str(bad))
    r = client.get("/api/dict/query", params={"word": "hello"})
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is False
    assert body["error"].startswith("dict load failed: ")


def test_query_frequency_only(dicts_dir):
    """只有词频词典、没有释义词典 → define 兜底找不到 → no dictionary configured"""
    _add(str(dicts_dir / "COCA Frequency 60000.mdx"))
    r = client.get("/api/dict/query", params={"word": "hello"})
    assert r.status_code == 200
    assert r.json()["error"] == "no dictionary configured"


# ============ 资源 ============
def test_resource_content_type(dicts_dir):
    d = _add(str(dicts_dir / "mini.mdx"))
    r = client.get(f"/api/dict/resource/{d['id']}/mini.css")
    assert r.status_code == 200
    assert r.content == b"body{}"
    assert r.headers["content-type"].startswith("text/css")
    r = client.get(f"/api/dict/resource/{d['id']}/img/hi.gif")
    assert r.headers["content-type"].startswith("image/gif")
    r = client.get(f"/api/dict/resource/{d['id']}/sound/hello.mp3")
    assert r.headers["content-type"].startswith("audio/mpeg")


def test_resource_missing(dicts_dir):
    d = _add(str(dicts_dir / "mini.mdx"))
    r = client.get(f"/api/dict/resource/{d['id']}/nope.png")
    assert r.status_code == 404


def test_resource_dict_not_found(dicts_dir):
    r = client.get("/api/dict/resource/d_nope/mini.css")
    assert r.status_code == 404


# ============ 词频独立接口 ============
def test_frequency_hit(dicts_dir):
    _add(str(dicts_dir / "COCA Frequency 60000.mdx"))
    r = client.get("/api/dict/frequency", params={"word": "hello"})
    assert r.json() == {"rank": 18253, "total": 2}


def test_frequency_miss(dicts_dir):
    _add(str(dicts_dir / "COCA Frequency 60000.mdx"))
    r = client.get("/api/dict/frequency", params={"word": "zzz"})
    assert r.json() == {"rank": None, "total": None}


def test_frequency_no_dict(dicts_dir):
    r = client.get("/api/dict/frequency", params={"word": "hello"})
    assert r.json() == {"rank": None, "total": None}


def test_frequency_disabled_dict_ignored(dicts_dir):
    d = _add(str(dicts_dir / "COCA Frequency 60000.mdx"))
    client.patch(f"/api/dict/{d['id']}", json={"enabled": False})
    r = client.get("/api/dict/frequency", params={"word": "hello"})
    assert r.json() == {"rank": None, "total": None}


# ============ settings 校验器 ============
def test_norm_dict_list_drops_invalid():
    spec = settings_service._SETTINGS_SPEC["dict"]
    norm = spec["dictionaries"][1]
    good = {
        "id": "d_1",
        "name": "LDOCE6",
        "path": "/a/b.mdx",
        "kind": "local",
        "role": "define",
        "enabled": True,
    }
    bad = [
        {"id": "", "name": "no-id", "path": "/x.mdx"},
        {"name": "no-id-no-path", "path": "/x.mdx"},
        {"id": "d_2", "path": "/x.mdx"},  # 缺 name
        "not-a-dict",
        None,
        42,
    ]
    out = norm([good, *bad], [])
    assert out == [good]


def test_norm_dict_list_preserves_order_and_empty():
    spec = settings_service._SETTINGS_SPEC["dict"]
    norm = spec["dictionaries"][1]
    items = [
        {"id": "d_1", "name": "a", "path": "/a.mdx"},
        {"id": "d_2", "name": "b", "path": "/b.mdx"},
    ]
    assert norm(items, []) == items
    assert norm([], []) == []
    assert norm("oops", []) == []
    # 副本：修改返回列表不影响原输入
    out = norm(items, [])
    out[0]["name"] = "changed"
    assert items[0]["name"] == "a"


def test_dict_settings_via_api(dicts_dir):
    """dict namespace 随统一设置 GET/PUT 读写（深合并不动其他 namespace）"""
    r = client.put("/api/settings", json={"dict": {"activeDictId": "d_abc"}})
    assert r.status_code == 200
    s = r.json()["settings"]["dict"]
    assert s["activeDictId"] == "d_abc"
    assert s["dictionaries"] == []
    # 其他 namespace 不受影响
    assert client.get("/api/settings").json()["settings"]["playback"]["playMode"] == "order"


# ============ 批量上传（upload-batch）============
def _upload_batch(*items):
    """items: (filename, bytes) → multipart 批量上传（字段名 files）"""
    return client.post(
        "/api/dict/upload-batch",
        files=[("files", (name, data)) for name, data in items],
    )


def test_upload_batch_group_with_attachments(dicts_dir, tmp_path):
    """Oxford.mdx + Oxford.mdd + Oxford.css 一组 → 1 本配置 + 3 文件落盘子目录（保留原文件名）"""
    r = _upload_batch(
        ("Oxford.mdx", (dicts_dir / "mini.mdx").read_bytes()),
        ("Oxford.mdd", b"MDD-DATA"),
        ("Oxford.css", b"body{}"),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ignored"] == []
    assert len(body["added"]) == 1
    item = body["added"][0]
    assert item["name"] == "Oxford"
    assert item["kind"] == "uploaded"
    assert item["role"] == "define"
    assert item["enabled"] is True
    assert item["addedAt"] > 0
    cid = item["id"][2:]
    ddir = state.DICTS_DIR / cid
    assert item["path"] == str(ddir / "Oxford.mdx")
    assert sorted(p.name for p in ddir.iterdir()) == ["Oxford.css", "Oxford.mdd", "Oxford.mdx"]
    assert (ddir / "Oxford.mdd").read_bytes() == b"MDD-DATA"
    assert (ddir / "Oxford.css").read_bytes() == b"body{}"
    assert client.get("/api/dict").json()["dictionaries"] == body["added"]


def test_upload_batch_two_groups(dicts_dir, tmp_path):
    """两个不同 mdx 组 → 2 本配置，role 各自检测（按 mdx 文件名）"""
    r = _upload_batch(
        ("Alpha.mdx", (dicts_dir / "mini.mdx").read_bytes()),
        ("COCA Frequency.mdx", (dicts_dir / "COCA Frequency 60000.mdx").read_bytes()),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ignored"] == []
    assert {d["name"] for d in body["added"]} == {"Alpha", "COCA Frequency"}
    assert {d["name"]: d["role"] for d in body["added"]} == {
        "Alpha": "define",
        "COCA Frequency": "frequency",
    }
    assert len(client.get("/api/dict").json()["dictionaries"]) == 2


def test_upload_batch_orphan_attachments(dicts_dir, tmp_path):
    """孤立 mdd/css（组内无 mdx）→ ignored 且不落盘"""
    r = _upload_batch(("Lonely.mdd", b"MDD-DATA"), ("Lonely.css", b"body{}"))
    assert r.status_code == 200
    body = r.json()
    assert body["added"] == []
    assert body["ignored"] == [{"name": "Lonely", "reason": "缺少对应的 .mdx 主文件"}]
    assert client.get("/api/dict").json()["dictionaries"] == []
    assert list(state.DICTS_DIR.iterdir()) == []  # 未落盘


def test_upload_batch_all_invalid_ext():
    """全非法扩展名 → 400"""
    r = _upload_batch(("readme.txt", b"hi"), ("photo.png.txt", b"x"))
    assert r.status_code == 400
    assert r.json()["detail"] == "未选择有效的词典文件"


def test_upload_batch_duplicate_mdx_in_group(dicts_dir, tmp_path):
    """同组两个 mdx（Oxford.mdx + Oxford.MDX）→ 400，且未写盘"""
    r = _upload_batch(
        ("Oxford.mdx", (dicts_dir / "mini.mdx").read_bytes()),
        ("Oxford.MDX", (dicts_dir / "mini.mdx").read_bytes()),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "重复的词典文件: Oxford.MDX"
    assert client.get("/api/dict").json()["dictionaries"] == []
    assert list(state.DICTS_DIR.iterdir()) == []


def test_upload_batch_external_css_served(tmp_path):
    """外置 css 保留原文件名落盘子目录：查询可用 + 资源接口按名可取（同目录回退）"""
    build_mdx(tmp_path / "Oxford.mdx", [("hello", '<link href="Oxford.css"><b>hello</b>')])
    r = _upload_batch(
        ("Oxford.mdx", (tmp_path / "Oxford.mdx").read_bytes()),
        ("Oxford.css", b"body{}"),
    )
    assert r.status_code == 200
    item = r.json()["added"][0]
    # 词典可查（mdx 在子目录可加载）
    q = client.get("/api/dict/query", params={"word": "hello", "dictId": item["id"]})
    assert q.status_code == 200
    assert q.json()["found"] is True
    # 外置 css 按原文件名从同目录取到
    res = client.get(f"/api/dict/resource/{item['id']}/Oxford.css")
    assert res.status_code == 200
    assert res.content == b"body{}"
    assert res.headers["content-type"].startswith("text/css")


# ============ 批量添加（add-batch）============
def test_add_batch_mixed(dicts_dir):
    """正常 / 不存在 / 非 mdx / 重复 四态 → added/skipped 正确"""
    mini = str(dicts_dir / "mini.mdx")
    coca = str(dicts_dir / "COCA Frequency 60000.mdx")
    r = client.post(
        "/api/dict/add-batch",
        json={
            "paths": [
                mini,
                coca,
                str(dicts_dir / "nope.mdx"),  # 不存在
                str(dicts_dir / "mini.mdd"),  # 非 mdx
                mini,  # 同批重复（前面已 added）
            ]
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert {d["path"] for d in body["added"]} == {mini, coca}
    assert {d["name"]: d["role"] for d in body["added"]} == {
        "mini": "define",
        "COCA Frequency 60000": "frequency",
    }
    assert all(d["kind"] == "local" for d in body["added"])
    assert body["skipped"] == [
        {"path": str(dicts_dir / "nope.mdx"), "reason": "path not found"},
        {"path": str(dicts_dir / "mini.mdd"), "reason": "仅支持 .mdx 文件"},
        {"path": mini, "reason": "already added"},
    ]
    assert len(client.get("/api/dict").json()["dictionaries"]) == 2


def test_add_batch_cross_request_duplicate(dicts_dir):
    """已入库的 path 跨请求再批量添加 → skipped already added"""
    mini = str(dicts_dir / "mini.mdx")
    _add(mini)
    r = client.post("/api/dict/add-batch", json={"paths": [mini]})
    assert r.status_code == 200
    assert r.json() == {"added": [], "skipped": [{"path": mini, "reason": "already added"}]}


def test_add_batch_missing_paths():
    assert client.post("/api/dict/add-batch", json={}).status_code == 400
    assert client.post("/api/dict/add-batch", json={"paths": "mini.mdx"}).status_code == 400


# ============ 删除（子目录格式 + 旧散装兼容）============
def test_delete_uploaded_batch_subdir(dicts_dir, tmp_path, monkeypatch):
    """子目录格式上传的词典：删除后目录没了、配置没了"""
    calls = []
    monkeypatch.setattr("app.routers.dict.send2trash", _FakeSend2Trash(calls))
    r = _upload_batch(
        ("Oxford.mdx", (dicts_dir / "mini.mdx").read_bytes()),
        ("Oxford.mdd", b"MDD-DATA"),
    )
    item = r.json()["added"][0]
    cid = item["id"][2:]
    ddir = state.DICTS_DIR / cid
    assert ddir.is_dir()
    assert client.delete(f"/api/dict/{item['id']}").status_code == 204
    assert ddir.exists() is False  # 整目录已移废纸篓
    assert client.get("/api/dict").json()["dictionaries"] == []
    assert any(str(ddir) == c for c in calls)


def test_delete_uploaded_legacy_scattered(dicts_dir, tmp_path, monkeypatch):
    """旧散装格式（<uuid>.mdx + <uuid>.mdd）删除兼容"""
    calls = []
    monkeypatch.setattr("app.routers.dict.send2trash", _FakeSend2Trash(calls))
    item = _upload(tmp_path, "legacy.mdx", (dicts_dir / "mini.mdx").read_bytes()).json()
    _upload(tmp_path, "legacy.mdd", (dicts_dir / "mini.mdd").read_bytes())
    cid = item["id"][2:]
    assert (state.DICTS_DIR / f"{cid}.mdx").exists()
    assert (state.DICTS_DIR / f"{cid}.mdd").exists()
    assert client.delete(f"/api/dict/{item['id']}").status_code == 204
    assert (state.DICTS_DIR / f"{cid}.mdx").exists() is False
    assert (state.DICTS_DIR / f"{cid}.mdd").exists() is False
    assert client.get("/api/dict").json()["dictionaries"] == []
    assert len(calls) == 2
