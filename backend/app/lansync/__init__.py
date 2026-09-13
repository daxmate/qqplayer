"""局域网同步（S2）协议实现 —— web/FastAPI 主机（Host）侧。

纯 asyncio + pycryptodome，**零 Web 框架依赖**：本包不 import fastapi/starlette，
供 routers/service 层按需调用。线协议契约见 `docs/lan-sync-protocol.md`，
权威真源为 Swift 端 `QQPlayer/Sync/*.swift`。

模块划分：
- `deviceid`  Device ID 编解码（base32 52 字符 / 分组展示 / 手输规范化）
- `frame`     帧编解码 + 流式拼帧解码器（QQP1 头 / 16MiB 上限）
- `crypto`    身份(Ed25519) / hello 签名验签 / X25519+HKDF 派生 / ChaCha20-Poly1305 会话加密
- `qr`        PairQRPayload 编解码 + 一次性 nonce 池
- `trust`     信任表（配对记录持久化 + pinning 查询）
- `models`    会话阶段 / 关闭原因 / 事件数据类
"""

from __future__ import annotations

__all__ = ["deviceid", "frame", "crypto", "qr", "trust", "models"]
