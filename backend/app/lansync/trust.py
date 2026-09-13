"""信任表（配对记录持久化 + pinning 查询，协议 §7 `PeerDevice`）。

存储形态：单个 JSON 文件（**键名与协议 §7 表 / Swift `sync_device` 列名逐字一致**）：

    {"devices": [{"peer_id": "...", "peer_public_key": "<b64>", "display_name": "...",
                  "role": "client", "paired_at": 1735689600, "last_seen_at": 1735689600,
                  "notes": null}, ...]}

- **文件权限 0600**（`peer_public_key` 是 pinning 依据，属敏感材料；同机其他用户不可读）；
- **原子写入**：同目录 `mkstemp` → 写满 → `fsync` → `os.replace`，进程中途崩溃只会留下
  临时文件（`.tmp` 后缀，不在读取路径内），不会出现半截 JSON 覆盖掉完整信任表；
- **损坏即报错**（`TrustStoreError`）：JSON 非法 / 结构非法 / 字段缺失或类型不符一律抛出，
  **绝不把损坏文件当成"空信任表"**（那样等于静默丢弃 pinning，把已配对设备降级成未配对）。

与 Swift `DeviceStore`（GRDB `sync_device` 表）语义对位：

| 本模块 | Swift | 语义 |
| --- | --- | --- |
| `save` | `upsert` | 同 `peer_id` **整体替换**，不存在则新增 |
| `remove` | `remove(peerID:)` | 幂等删除（无此记录不算失败） |
| `touch_last_seen` | 会话层刷新 `lastSeenAt` | 只改 `last_seen_at`，其余列不动；未配对设备不新建记录 |
| `list_devices` | `all()` | 按 `(display_name, peer_id)` 排序，展示顺序稳定 |
| `peer_public_key` | `peerPublicKey(deviceID:)` | 未配对返回 `None`（存储故障抛 `TrustStoreError`） |

差异（有意为之，见 `backend/tests/test_lansync_trust.py`）：Swift `peerPublicKey` 对
非法 base64 返回 `nil`（调用方视为"未配对"），本模块对损坏记录的 base64 抛
`TrustStoreError` —— 静默降级等于把损坏伪装成未配对，与"损坏即报错"冲突。
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import json
import os
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

#: 角色值（与 Swift `PeerRole` rawValue 一致）
ROLE_HOST = "host"
ROLE_CLIENT = "client"
_ROLES = (ROLE_HOST, ROLE_CLIENT)

#: 信任文件权限（属主可读写，其他用户无权限）
FILE_MODE = 0o600
#: 公钥 raw 字节数（Ed25519）
PUBLIC_KEY_BYTE_COUNT = 32
#: 记录键名（协议 §7 表头顺序，写入 JSON 时保持该顺序）
RECORD_KEYS = (
    "peer_id",
    "peer_public_key",
    "display_name",
    "role",
    "paired_at",
    "last_seen_at",
    "notes",
)


class TrustStoreError(Exception):
    """信任表错误：文件损坏 / 结构非法 / 字段类型不符 / 读写失败。"""


def _require_str(value: object, what: str) -> str:
    """校验非空字符串字段。"""
    if not isinstance(value, str) or not value:
        raise TrustStoreError(f"{what} 必须是非空字符串，实际 {value!r}")
    return value


def _require_epoch(value: object, what: str) -> int:
    """校验 epoch 秒字段（int，且非 bool）。"""
    if isinstance(value, bool) or not isinstance(value, int):
        raise TrustStoreError(f"{what} 必须是 int（epoch 秒），实际 {value!r}")
    return value


def _require_role(value: object) -> str:
    """校验角色值（host / client）。"""
    if value not in _ROLES:
        raise TrustStoreError(f"role 必须是 {_ROLES}，实际 {value!r}")
    return str(value)


def _require_public_key_base64(value: object) -> str:
    """校验 pinning 公钥 = standard base64 且解码后 32B。"""
    text = _require_str(value, "peer_public_key")
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as error:
        raise TrustStoreError(f"peer_public_key 不是合法 base64：{text!r}") from error
    if len(raw) != PUBLIC_KEY_BYTE_COUNT:
        raise TrustStoreError(
            f"peer_public_key 解码后必须是 {PUBLIC_KEY_BYTE_COUNT}B，实际 {len(raw)}B"
        )
    return text


@dataclass(frozen=True, slots=True)
class TrustedDevice:
    """一条配对记录（协议 §7；字段名与 JSON 键逐字相同）。

    构造即校验：任何存在的 `TrustedDevice` 都是合法记录（同 `crypto.Identity` 惯例），
    因此 `save` 不再重复校验。
    """

    peer_id: str
    peer_public_key: str
    display_name: str
    role: str
    paired_at: int
    last_seen_at: int
    notes: str | None = None

    def __post_init__(self) -> None:
        _require_str(self.peer_id, "peer_id")
        _require_public_key_base64(self.peer_public_key)
        _require_str(self.display_name, "display_name")
        _require_role(self.role)
        _require_epoch(self.paired_at, "paired_at")
        _require_epoch(self.last_seen_at, "last_seen_at")
        if self.notes is not None and not isinstance(self.notes, str):
            raise TrustStoreError(f"notes 必须是 str 或 None，实际 {self.notes!r}")

    def to_dict(self) -> dict[str, Any]:
        """JSON 字典（键序 = 协议 §7 表头顺序）。"""
        return {
            "peer_id": self.peer_id,
            "peer_public_key": self.peer_public_key,
            "display_name": self.display_name,
            "role": self.role,
            "paired_at": self.paired_at,
            "last_seen_at": self.last_seen_at,
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> TrustedDevice:
        """JSON 字典 → 记录；缺字段 / 类型不符 → :class:`TrustStoreError`。

        额外键忽略（前向兼容：未来 Swift 端加列不破坏本端读取）。
        """
        values: dict[str, Any] = {}
        for name in RECORD_KEYS:
            if name not in raw:
                raise TrustStoreError(f"信任记录缺字段：{name}")
            values[name] = raw[name]
        return cls(**values)

    def with_last_seen(self, ts: int) -> TrustedDevice:
        """返回 `last_seen_at = ts` 的副本（其余字段不动）。"""
        return replace(self, last_seen_at=_require_epoch(ts, "last_seen_at"))

    @property
    def public_key_raw(self) -> bytes:
        """pinning 公钥 raw 32B（已校验，解码不会失败）。"""
        return base64.b64decode(self.peer_public_key, validate=True)


class TrustStore:
    """JSON 文件信任表（读写均为短临界区同步 IO；单进程内不加锁）。

    用法（下游会话层）：`TrustStore(path)` 构造一次；握手验签前 `peer_public_key(peer_id)`
    取 pinning 公钥（`None` = 未配对）；配对批准后 `save(device)`；解配对 `remove(peer_id)`；
    成功连接后 `touch_last_seen(peer_id, ts)`。
    """

    __slots__ = ("_path",)

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self._path = Path(path)

    @property
    def path(self) -> Path:
        """信任表文件路径（诊断用）。"""
        return self._path

    # ------------------------------------------------------------------ 读

    def peer_public_key(self, peer_id: str) -> bytes | None:
        """按 Device ID 查对端 Ed25519 公钥 raw 32B；未配对返回 ``None``。

        文件损坏 / 记录非法 → :class:`TrustStoreError`（存储故障 ≠ 未配对）。
        """
        target = _require_str(peer_id, "peer_id")
        for device in self._load():
            if device.peer_id == target:
                return device.public_key_raw
        return None

    def list_devices(self) -> list[TrustedDevice]:
        """全部配对记录，按 `(display_name, peer_id)` 排序（展示顺序稳定）。"""
        return sorted(self._load(), key=lambda device: (device.display_name, device.peer_id))

    # ------------------------------------------------------------------ 写

    def save(self, device: TrustedDevice) -> None:
        """落一条配对记录（同 `peer_id` 整体替换 = upsert；不存在则新增）。"""
        if not isinstance(device, TrustedDevice):
            raise TrustStoreError(f"save 只接受 TrustedDevice，实际 {type(device).__name__}")
        devices = self._load()
        for index, existing in enumerate(devices):
            if existing.peer_id == device.peer_id:
                devices[index] = device
                break
        else:
            devices.append(device)
        self._write(devices)

    def remove(self, peer_id: str) -> bool:
        """撤销配对（删记录）；命中返回 True，本来就没有返回 False（幂等）。

        未命中时不重写文件（保持 mtime 与内容不变）。
        """
        target = _require_str(peer_id, "peer_id")
        devices = self._load()
        remaining = [device for device in devices if device.peer_id != target]
        if len(remaining) == len(devices):
            return False
        self._write(remaining)
        return True

    def touch_last_seen(self, peer_id: str, ts: int) -> bool:
        """刷新 `last_seen_at`（成功连接后调用）；只改该列，其余字段不动。

        未配对设备返回 False 且**不新建记录**；值未变返回 False 也不重写文件
        （对齐 Swift `DeviceStore.updateDisplayName` 的"无谓 updated_at 刷新"规避）。
        """
        target = _require_str(peer_id, "peer_id")
        stamp = _require_epoch(ts, "last_seen_at")
        devices = self._load()
        for index, existing in enumerate(devices):
            if existing.peer_id == target:
                if existing.last_seen_at == stamp:
                    return False
                devices[index] = existing.with_last_seen(stamp)
                self._write(devices)
                return True
        return False

    # ------------------------------------------------------------ 文件读写

    def _load(self) -> list[TrustedDevice]:
        """读全部记录；文件不存在 = 空表（首次运行），损坏 = 抛错。"""
        try:
            text = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        except OSError as error:
            raise TrustStoreError(f"信任表读取失败：{self._path}（{error}）") from error
        try:
            raw = json.loads(text)
        except ValueError as error:
            raise TrustStoreError(f"信任表不是合法 JSON：{self._path}（{error}）") from error
        if not isinstance(raw, dict) or not isinstance(raw.get("devices"), list):
            raise TrustStoreError(f"信任表结构非法（缺 devices 数组）：{self._path}")
        devices: list[TrustedDevice] = []
        seen: set[str] = set()
        for index, item in enumerate(raw["devices"]):
            if not isinstance(item, dict):
                raise TrustStoreError(f"信任表第 {index} 条不是对象：{self._path}")
            device = TrustedDevice.from_dict(item)
            if device.peer_id in seen:
                raise TrustStoreError(f"信任表存在重复 peer_id：{device.peer_id}")
            seen.add(device.peer_id)
            devices.append(device)
        return devices

    def _write(self, devices: list[TrustedDevice]) -> None:
        """原子写入（tmp + fsync + rename），权限恒 0600。"""
        payload = json.dumps(
            {"devices": [device.to_dict() for device in devices]}, ensure_ascii=False, indent=2
        )
        directory = self._path.parent
        try:
            directory.mkdir(parents=True, exist_ok=True)
            handle_fd, tmp_name = tempfile.mkstemp(
                dir=str(directory), prefix=f".{self._path.name}.", suffix=".tmp"
            )
        except OSError as error:
            raise TrustStoreError(f"信任表临时文件创建失败：{directory}（{error}）") from error
        try:
            with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp_name, FILE_MODE)
            os.replace(tmp_name, self._path)
        except OSError as error:
            with contextlib.suppress(OSError):  # 清理失败不掩盖原始错误
                os.unlink(tmp_name)
            raise TrustStoreError(f"信任表写入失败：{self._path}（{error}）") from error
