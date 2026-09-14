"""局域网同步 API 测试（HTTP 薄路由 · 内容同步 push / pull）。

覆盖 `app/routers/lansync.py` 中「内容同步」段的 7 条端点（**只测 HTTP 形状与错误码**，
对账 / 传输 / 事件产出在各自模块的测试里）：

- 成功路径：POST /push、GET /push/{run_id}、POST /push/{run_id}/cancel、
  POST /pull/preview、POST /pull、GET /pull/{run_id}、POST /pull/{run_id}/cancel
- 参数透传：`selection: null` = 全库、`relative_paths: null` = 对端全库、`limit` 缺省取
  `pull.DEFAULT_PAGE_LIMIT`
- 错误映射：`PushError` / `PullError` → 400；未知 `run_id` → 404；取消端点幂等（恒 200）
- 降级：服务未运行 / 不可用 → 503；缺 `peer_id` → 422

假 service（monkeypatch `lansync_host.get_service`）——**不起真 TCP、不建真 SyncService**，
因此也无须隔离 `state.DATA_DIR`。
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

import backend
from app.lansync.pull import DEFAULT_PAGE_LIMIT, PullError
from app.lansync.push import PushError
from app.services import lansync_host

PEER = "peer-abc123"

#: 假 `LibraryPushRun.status()` 形状（键以 push.py 为准，**原样透传**）
PUSH_STATUS = {
    "run_id": "run-push-1",
    "peer_id": PEER,
    "session_id": "sess-1",
    "state": "sending",
    "selection": {"kind": "all", "ids": []},
    "sentBytes": 1024,
    "totalBytes": 4096,
    "planned": 2,
    "skipped": 0,
    "completed": 1,
    "failed": 0,
}

#: 假 `LibraryPullRun.status()` 形状
PULL_STATUS = {
    "run_id": "run-pull-1",
    "peer_id": PEER,
    "session_id": "sess-1",
    "state": "fetching",
    "selection": {"kind": "tracks", "ids": []},
    "requested": 3,
    "unchanged": 1,
    "completed": 1,
    "failed": 0,
    "receivedBytes": 2048,
    "totalBytes": 8192,
}


class _StubService:
    """SyncService 桩：记录调用参数，按需抛协议异常（路由层只做映射）。"""

    def __init__(self, *, running: bool = True) -> None:
        self.status: dict[str, Any] = {
            "running": running,
            "port": 55000,
            "device_name": "Stub",
            "protocol_version": 1,
        }
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.push_result: Any = "run-push-1"
        self.pull_result: Any = "run-pull-1"
        self.preview_result: dict[str, Any] = {
            "request_id": 7,
            "scope": "tracks",
            "offset": 0,
            "limit": DEFAULT_PAGE_LIMIT,
        }
        self.push_status_result: dict[str, Any] = dict(PUSH_STATUS)
        self.pull_status_result: dict[str, Any] = dict(PULL_STATUS)
        self.push_error: Exception | None = None
        self.pull_error: Exception | None = None
        self.cancel_push_result = True
        self.cancel_pull_result = True

    # ------------------------------------------------------------- 记录

    def _record(self, name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> None:
        self.calls.append((name, args, kwargs))

    def called(self, name: str) -> tuple[tuple[Any, ...], dict[str, Any]]:
        """取最近一次该方法的调用参数（未调用 → AssertionError）。"""
        for call_name, args, kwargs in reversed(self.calls):
            if call_name == name:
                return args, kwargs
        raise AssertionError(f"桩未被调用：{name}（已调用 {[c[0] for c in self.calls]}）")

    # ------------------------------------------------------------- 推送

    def push_selection(self, peer_id: str, selection: Any = None) -> str:
        self._record("push_selection", (peer_id,), {"selection": selection})
        if self.push_error is not None:
            raise self.push_error
        return self.push_result

    def push_status(self, run_id: str) -> dict[str, Any]:
        self._record("push_status", (run_id,), {})
        return self.push_status_result if run_id == "run-push-1" else {}

    def cancel_push(self, run_id: str) -> bool:
        self._record("cancel_push", (run_id,), {})
        return self.cancel_push_result if run_id == "run-push-1" else False

    # ------------------------------------------------------------- 拉取

    def pull_preview(
        self,
        peer_id: str,
        scope: str | None = None,
        query: str | None = None,
        offset: int = 0,
        limit: int | None = None,
    ) -> dict[str, Any]:
        self._record(
            "pull_preview",
            (peer_id,),
            {"scope": scope, "query": query, "offset": offset, "limit": limit},
        )
        if self.pull_error is not None:
            raise self.pull_error
        return dict(self.preview_result)

    def pull_selection(self, peer_id: str, relative_paths: Any = None) -> str:
        self._record("pull_selection", (peer_id,), {"relative_paths": relative_paths})
        if self.pull_error is not None:
            raise self.pull_error
        return self.pull_result

    def pull_status(self, run_id: str) -> dict[str, Any]:
        self._record("pull_status", (run_id,), {})
        return self.pull_status_result if run_id == "run-pull-1" else {}

    def cancel_pull(self, run_id: str) -> bool:
        self._record("cancel_pull", (run_id,), {})
        return self.cancel_pull_result if run_id == "run-pull-1" else False


@pytest.fixture
def stub(monkeypatch) -> _StubService:
    """运行中 + 已配对的假服务（单例被替换，绝不落真实数据目录）。"""
    service = _StubService()
    monkeypatch.setattr(lansync_host, "get_service", lambda: service)
    return service


@pytest.fixture
def client(stub: _StubService) -> TestClient:
    return TestClient(backend.app)


# ---------------------------------------------------------------- 推送


def test_push_success_returns_run_id(client, stub):
    """POST /push：200 + run_id；selection 原样透传（含 kind/ids）。"""
    response = client.post(
        "/api/lansync/push",
        json={"peer_id": PEER, "selection": {"kind": "playlists", "ids": ["@favorites"]}},
    )
    assert response.status_code == 200
    assert response.json() == {"run_id": "run-push-1"}
    args, kwargs = stub.called("push_selection")
    assert args == (PEER,)
    assert kwargs == {"selection": {"kind": "playlists", "ids": ["@favorites"]}}


def test_push_null_selection_means_whole_library(client, stub):
    """selection 缺省 / 显式 null → 传给 service 的是 None（service 语义 = 全库）。"""
    assert client.post("/api/lansync/push", json={"peer_id": PEER}).status_code == 200
    assert stub.called("push_selection")[1] == {"selection": None}

    client.post("/api/lansync/push", json={"peer_id": PEER, "selection": None})
    assert stub.called("push_selection")[1] == {"selection": None}


def test_push_error_maps_400(client, stub):
    """无就绪会话 / 选择集非法（PushError）→ 400 + detail 原文。"""
    stub.push_error = PushError(f"该设备无就绪会话，无法推送：{PEER}")
    response = client.post("/api/lansync/push", json={"peer_id": PEER})
    assert response.status_code == 400
    assert response.json() == {"detail": f"该设备无就绪会话，无法推送：{PEER}"}


def test_push_missing_peer_id_422(client):
    """缺 peer_id → 422（Pydantic 校验，不进 service）。"""
    assert client.post("/api/lansync/push", json={}).status_code == 422
    assert client.post("/api/lansync/push", json={"selection": None}).status_code == 422


def test_push_status_and_unknown_run_404(client):
    """GET /push/{run_id}：命中 → status 原样；未知 → 404。"""
    hit = client.get("/api/lansync/push/run-push-1")
    assert hit.status_code == 200
    assert hit.json() == PUSH_STATUS

    assert client.get("/api/lansync/push/deadbeef").status_code == 404


def test_push_cancel_is_idempotent(client, stub):
    """取消推送：已终态 / 未知 → cancelled=false（仍 200，不报 404）。"""
    assert client.post("/api/lansync/push/run-push-1/cancel").json() == {"cancelled": True}
    stub.cancel_push_result = False
    assert client.post("/api/lansync/push/run-push-1/cancel").json() == {"cancelled": False}
    assert client.post("/api/lansync/push/deadbeef/cancel").json() == {"cancelled": False}


# ---------------------------------------------------------------- 浏览


def test_pull_preview_success_and_default_limit(client, stub):
    """POST /pull/preview：limit 缺省 → DEFAULT_PAGE_LIMIT；返回描述原样透传。"""
    response = client.post("/api/lansync/pull/preview", json={"peer_id": PEER})
    assert response.status_code == 200
    assert response.json() == stub.preview_result
    _, kwargs = stub.called("pull_preview")
    assert kwargs == {"scope": None, "query": None, "offset": 0, "limit": DEFAULT_PAGE_LIMIT}


def test_pull_preview_passes_scope_query_offset_limit(client, stub):
    """scope / query / offset / limit 逐字透传（scope 不在路由层做白名单）。"""
    response = client.post(
        "/api/lansync/pull/preview",
        json={"peer_id": PEER, "scope": "playlists", "query": "周杰伦", "offset": 50, "limit": 10},
    )
    assert response.status_code == 200
    _, kwargs = stub.called("pull_preview")
    assert kwargs == {"scope": "playlists", "query": "周杰伦", "offset": 50, "limit": 10}


def test_pull_preview_error_maps_400(client, stub):
    """无就绪会话（PullError）→ 400 + detail 原文。"""
    stub.pull_error = PullError(f"该设备无就绪会话，无法浏览：{PEER}")
    response = client.post("/api/lansync/pull/preview", json={"peer_id": PEER})
    assert response.status_code == 400
    assert response.json() == {"detail": f"该设备无就绪会话，无法浏览：{PEER}"}


def test_pull_preview_missing_peer_id_422(client):
    """缺 peer_id → 422。"""
    assert client.post("/api/lansync/pull/preview", json={"scope": "tracks"}).status_code == 422


# ---------------------------------------------------------------- 拉取


def test_pull_success_returns_run_id(client, stub):
    """POST /pull：200 + run_id；relative_paths 原样透传。"""
    response = client.post(
        "/api/lansync/pull",
        json={"peer_id": PEER, "relative_paths": ["a/b.mp3", "c/d.flac"]},
    )
    assert response.status_code == 200
    assert response.json() == {"run_id": "run-pull-1"}
    args, kwargs = stub.called("pull_selection")
    assert args == (PEER,)
    assert kwargs == {"relative_paths": ["a/b.mp3", "c/d.flac"]}


def test_pull_null_paths_means_peer_whole_library(client, stub):
    """relative_paths 缺省 / 显式 null → None（service 语义 = 对端全库）。"""
    assert client.post("/api/lansync/pull", json={"peer_id": PEER}).status_code == 200
    assert stub.called("pull_selection")[1] == {"relative_paths": None}


def test_pull_error_maps_400(client, stub):
    """发送失败 / 无就绪会话（PullError）→ 400 + detail 原文。"""
    stub.pull_error = PullError("发送对端清单请求失败：连接已关闭")
    response = client.post("/api/lansync/pull", json={"peer_id": PEER})
    assert response.status_code == 400
    assert response.json() == {"detail": "发送对端清单请求失败：连接已关闭"}


def test_pull_status_and_unknown_run_404(client):
    """GET /pull/{run_id}：命中 → status 原样；未知 → 404。"""
    hit = client.get("/api/lansync/pull/run-pull-1")
    assert hit.status_code == 200
    assert hit.json() == PULL_STATUS

    assert client.get("/api/lansync/pull/deadbeef").status_code == 404


def test_pull_cancel_is_idempotent(client, stub):
    """取消拉取：已终态 / 未知 → cancelled=false（仍 200）。"""
    assert client.post("/api/lansync/pull/run-pull-1/cancel").json() == {"cancelled": True}
    stub.cancel_pull_result = False
    assert client.post("/api/lansync/pull/run-pull-1/cancel").json() == {"cancelled": False}
    assert client.post("/api/lansync/pull/deadbeef/cancel").json() == {"cancelled": False}


# ---------------------------------------------------------------- 降级


def test_service_unavailable_503(monkeypatch):
    """服务不可用（构造失败）→ 七条端点全 503（统一文案）。"""
    monkeypatch.setattr(lansync_host, "get_service", lambda: None)
    client = TestClient(backend.app)
    detail = {"detail": "局域网同步服务未运行"}

    assert client.post("/api/lansync/push", json={"peer_id": PEER}).json() == detail
    assert client.get("/api/lansync/push/run-push-1").json() == detail
    assert client.post("/api/lansync/push/run-push-1/cancel").json() == detail
    assert client.post("/api/lansync/pull/preview", json={"peer_id": PEER}).json() == detail
    assert client.post("/api/lansync/pull", json={"peer_id": PEER}).json() == detail
    assert client.get("/api/lansync/pull/run-pull-1").json() == detail
    assert client.post("/api/lansync/pull/run-pull-1/cancel").json() == detail
    for response in (
        client.post("/api/lansync/push", json={"peer_id": PEER}),
        client.get("/api/lansync/push/run-push-1"),
        client.post("/api/lansync/push/run-push-1/cancel"),
        client.post("/api/lansync/pull/preview", json={"peer_id": PEER}),
        client.post("/api/lansync/pull", json={"peer_id": PEER}),
        client.get("/api/lansync/pull/run-pull-1"),
        client.post("/api/lansync/pull/run-pull-1/cancel"),
    ):
        assert response.status_code == 503


def test_not_running_503(monkeypatch):
    """服务可用但未启动（status.running=false）→ 七条端点全 503。"""
    service = _StubService(running=False)
    monkeypatch.setattr(lansync_host, "get_service", lambda: service)
    client = TestClient(backend.app)

    assert client.post("/api/lansync/push", json={"peer_id": PEER}).status_code == 503
    assert client.get("/api/lansync/push/run-push-1").status_code == 503
    assert client.post("/api/lansync/push/run-push-1/cancel").status_code == 503
    assert client.post("/api/lansync/pull/preview", json={"peer_id": PEER}).status_code == 503
    assert client.post("/api/lansync/pull", json={"peer_id": PEER}).status_code == 503
    assert client.get("/api/lansync/pull/run-pull-1").status_code == 503
    assert client.post("/api/lansync/pull/run-pull-1/cancel").status_code == 503
    assert service.calls == []
