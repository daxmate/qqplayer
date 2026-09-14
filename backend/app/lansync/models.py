"""局域网同步（S2）会话层模型：协议版本、会话阶段、关闭原因、事件、会话配置。

与 Swift 端 `QQPlayer/Sync/SyncSessionModels.swift` 对位（阶段枚举 / 关闭原因 /
配置），线协议契约见 `docs/lan-sync-protocol.md` §6。

纯声明模块：无 IO、无第三方依赖，供上游 session/server/service（阶段 B）与
加密/帧/配对层共用。
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

#: 线协议版本（QR / 请求校验用；Swift `SyncProtocolVersion.current`）
PROTOCOL_VERSION = 1

#: 握手超时缺省（秒）：waitingForPeerHello / waitingForPairRequest 阶段生效；
#: waitingForPairApproval / waitingForPairResponse 不挂超时（等人工决定）。
DEFAULT_HANDSHAKE_TIMEOUT = 10.0


class SyncPhase(str, Enum):
    """会话阶段（公开状态机视图，线上字符串与 Swift `SyncSessionPhase` 同名）。"""

    IDLE = "idle"
    WAITING_FOR_PEER_HELLO = "waitingForPeerHello"
    WAITING_FOR_PAIR_REQUEST = "waitingForPairRequest"
    WAITING_FOR_PAIR_APPROVAL = "waitingForPairApproval"
    WAITING_FOR_PAIR_RESPONSE = "waitingForPairResponse"
    READY = "ready"
    CLOSED = "closed"


class CloseReasonKind(str, Enum):
    """会话关闭原因种类（Swift `SyncSessionCloseReason` 的 case 名）。"""

    USER_CANCELLED = "userCancelled"
    REMOTE_CLOSED = "remoteClosed"
    RECEIVED_BYE = "receivedBye"
    HANDSHAKE_TIMEOUT = "handshakeTimeout"
    HANDSHAKE_FAILED = "handshakeFailed"
    PEER_UNTRUSTED = "peerUntrusted"
    PAIRING_REJECTED = "pairingRejected"
    STORAGE_ERROR = "storageError"
    PROTOCOL_VIOLATION = "protocolViolation"
    TRANSPORT_ERROR = "transportError"


@dataclass(frozen=True, slots=True)
class CloseReason:
    """关闭原因（kind + 可选细节：错误描述 / 拒绝理由 / 对端 ID）。

    Swift 的关联值（`handshakeFailed(err)` / `pairingRejected(reason)` /
    `peerUntrusted(String)` / `storageError` / `protocolViolation`）统一收敛为
    `detail` 字段，便于跨语言事件载荷序列化。
    """

    kind: CloseReasonKind
    detail: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"kind": self.kind.value}
        if self.detail is not None:
            payload["detail"] = self.detail
        return payload


class EventType(str, Enum):
    """应用级事件类型（`SyncService.events_since` 载荷的 `type` 字段）。"""

    SESSION = "session"
    PAIR_REQUEST = "pair_request"
    PAIR_RESULT = "pair_result"
    DEVICE = "device"
    ERROR = "error"
    #: 推送（S3a）编排事件：状态迁移 + 逐条发送进度（载荷见 `push.LibraryPushRun.status`）
    PUSH = "push"
    #: 拉取（S3b）编排事件：对端清单页（`action: "preview"`）+ 状态迁移 + 逐条接收进度
    #: （载荷见 `pull.LibraryPullRun.status` 与 `pull.PeerLibraryPage.to_payload`）
    PULL = "pull"
    #: 播放数据同步（S4）事件：帧 8/9 运行状态 + 账目（见 `changelog.DataSyncRun.status`）
    DATA = "data"
    #: 对齐歌词随歌推送（S4）事件：状态 + 逐文件进度（见 `lyrics.LyricsPushRun.status`）
    LYRICS = "lyrics"


@dataclass(frozen=True, slots=True)
class SyncEvent:
    """一条应用级事件（单调递增 seq，UI 按游标轮询）。"""

    seq: int
    at: float
    type: EventType
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """事件字典：`{"seq", "at", "type", **data}`（`events_since` 返回元素）。"""
        payload: dict[str, Any] = {"seq": self.seq, "at": self.at, "type": self.type.value}
        payload.update(self.data)
        return payload


@dataclass(slots=True)
class SyncSessionConfig:
    """会话配置（握手超时可注入；测试用小值）。"""

    handshake_timeout: float = DEFAULT_HANDSHAKE_TIMEOUT
    #: 本机展示名（两端 hello / PairRequest 携带；纯展示，不参与签名）
    display_name: str | None = None
