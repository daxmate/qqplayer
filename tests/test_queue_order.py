"""播放队列顺序 API 测试（拖拽排序持久化，任务 A 第三项）

队列顺序 = 全部歌曲视图的 state.songs 顺序；前端拖拽排序后 PUT /api/queue/order 保存，
启动/刷新时 GET 恢复。顺序键：本地歌 = 文件路径，网络歌 = 'stream:<streamId>'。
运行：cd /Users/dax/codes/qqplayerA && /Users/dax/codes/qqplayer/venv/bin/python -m pytest tests/test_queue_order.py -q
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import backend  # noqa: E402

client = TestClient(backend.app)


@pytest.fixture(autouse=True)
def _isolate_queue_order(tmp_path, monkeypatch):
    """存储隔离：写临时目录，不碰真实用户数据"""
    monkeypatch.setattr(backend, "QUEUE_ORDER_FILE", tmp_path / "queue_order.json")
    yield


def test_queue_order_default_empty():
    """未保存过 → 空列表（前端按曲库默认顺序）"""
    r = client.get("/api/queue/order")
    assert r.status_code == 200
    assert r.json() == {"paths": []}


def test_queue_order_round_trip():
    """PUT 保存 → GET 返回一致（本地歌路径 + 网络歌 stream: 键混排）"""
    paths = ["/a.mp3", "stream:123", "/b.mp3"]
    r = client.put("/api/queue/order", json={"paths": paths})
    assert r.status_code == 200
    assert r.json() == {"paths": paths}
    r = client.get("/api/queue/order")
    assert r.json() == {"paths": paths}


def test_queue_order_persist_across_restart():
    """持久化：落盘后重新读取仍在（模拟重启，后端无内存缓存）"""
    paths = ["/x.flac", "/y.mp3", "/z.m4a"]
    client.put("/api/queue/order", json={"paths": paths})
    assert client.get("/api/queue/order").json() == {"paths": paths}


def test_queue_order_invalid_body_rejected():
    """非法 body → 400：缺 paths / 非数组 / 含非字符串元素"""
    for bad in ({}, {"paths": "abc"}, {"paths": [1, 2]}, {"paths": ["/a", None]}):
        r = client.put("/api/queue/order", json=bad)
        assert r.status_code == 400, f"bad={bad!r} 应 400"
    # 非法请求不落盘：仍返回空
    assert client.get("/api/queue/order").json() == {"paths": []}


def test_queue_order_empty_array_clears():
    """空数组 = 清空自定义顺序（回默认）"""
    client.put("/api/queue/order", json={"paths": ["/a.mp3"]})
    r = client.put("/api/queue/order", json={"paths": []})
    assert r.status_code == 200
    assert client.get("/api/queue/order").json() == {"paths": []}
