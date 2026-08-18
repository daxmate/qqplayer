"""P1 存储抽象：统一 JSON load/save/原子写。

SQLite 迁移口：将来 playback 统计迁 sqlite3 时，实现同接口的 SqliteStore 替换实例即可。
"""

import copy
import json
import os
import threading
from contextlib import suppress


class JsonStore:
    """JSON 文件存储：原子写 + 损坏备份 + 路径延迟解析。

    path_getter 是可调用对象，load/save 每次调用时取当前路径（支持测试注入临时路径）；
    default 是文件缺失/损坏时返回的默认值（深拷贝，避免调用方改动污染默认值）。
    """

    def __init__(self, path_getter, default):
        self._path_getter = path_getter  # 可调用，每次取当前路径
        self.default = default
        self._lock = threading.Lock()

    def load(self):
        with self._lock:
            p = self._path_getter()
            try:
                return json.loads(p.read_text("utf-8"))
            except FileNotFoundError:
                return copy.deepcopy(self.default)
            except (
                ValueError,
                OSError,
            ):  # JSONDecodeError/UnicodeDecodeError/IO 错误 → 损坏备份后回默认
                with suppress(OSError):
                    p.rename(p.with_suffix(p.suffix + ".bak"))  # 损坏备份后回默认
                return copy.deepcopy(self.default)

    def save(self, data):
        with self._lock:
            p = self._path_getter()
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(p.suffix + ".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
            os.replace(tmp, p)  # 原子替换
