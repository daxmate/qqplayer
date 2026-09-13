# web 版接入 S2 局域网同步（Host 角色）· 实施计划

> 目标（2026-09-14 用户要求）：让 **web 版 QQPlayer（FastAPI + Vue）** 能与**现在的 iOS 版**
> （Swift 原生，~/codes/qqplayer-swift）**配对 + 同步**。
> 线协议契约见 `docs/lan-sync-protocol.md`（从 Swift 源码逐字段提取）。

## 1. 与设计文档的关系

`~/codes/qqplayer-swift/docs/lan-sync-design.md` §1 已预留插槽：

> 未来 web/NAS 主机按同契约另行实现（FastAPI 侧），客户端不感知。

本计划就是该插槽的落地：**iOS 端一行不改**，web 端实现 Host 角色。

## 2. 架构

```
backend/app/lansync/                 ← 新增包（协议实现，零 Web 框架依赖，纯 asyncio + pycryptodome）
├─ deviceid.py     Device ID 编解码（base32 52 字符 / 分组展示 / 规范化）
├─ frame.py        帧编解码 + 流式拼帧解码器（QQP1 头、16MiB 上限）
├─ crypto.py       身份(Ed25519) / hello 签名验签 / X25519+HKDF 派生 / ChaCha20-Poly1305 会话加密
├─ trust.py        信任表（配对记录持久化 + pinning 查询）
├─ qr.py           PairQRPayload 编解码 + 一次性 nonce 池
├─ session.py      单连接会话状态机（host 角色；transport 抽象，测试用内存回环）
├─ server.py       asyncio TCP 监听（NWListener 对位）+ mDNS 广播（_qqplayer-sync._tcp）
├─ service.py      SyncService 应用级单例：生命周期 / 身份 / 配对 / 设备 / 事件
└─ models.py       会话阶段、关闭原因、事件数据类
backend/app/routers/lansync.py       ← FastAPI 路由（/api/lansync/*）
frontend/src/...                     ← 同步设置页：本机身份 / 添加设备(QR) / 批准卡 / 设备列表
```

- 依赖：**pycryptodome（已在 requirements）**，无需新依赖。
  Ed25519 = `Crypto.Signature.eddsa`，X25519 = `Crypto.PublicKey.ECC("Curve25519")` + `Crypto.Protocol.DH`，
  HKDF = `Crypto.Protocol.KDF.HKDF`，AEAD = `Crypto.Cipher.ChaCha20_Poly1305`。
  （`cryptography` 包在本 venv 不可用，不要引入。）
- 独立于旧 companion 协议（`services/sync.py`/`pairing.py`/`mdns.py` 的 `_qqplayer._tcp` HTTP 老链路）：
  **新链路不碰老文件**，两条链路互不影响（老链路随 iOS WebView 壳退役，保留现状）。

## 3. 冻结接口（SyncService · UI/路由按此对接）

```python
class SyncService:
    def __init__(self, *, store_dir: Path, device_name: str, port: int = 0): ...
    async def start(self) -> None          # 起 TCP 监听 + mDNS 广播（幂等）
    async def stop(self) -> None
    @property
    def status(self) -> dict               # {"running": bool, "port": int, "device_name": str, "protocol_version": 1}
    @property
    def identity_info(self) -> dict        # {"device_id", "device_id_formatted", "public_key"}
    def start_pairing(self) -> dict        # {"qr_payload": str(JSON文本), "nonce": str(b64)}；重复调用 = 换新码作废旧码
    def stop_pairing(self) -> None         # 作废当前 nonce
    @property
    def pending_pairs(self) -> list[dict]  # [{"request_id","device_id","device_id_formatted","display_name","suggested_display_name","received_at"}]
    def approve_pair(self, request_id: str, display_name: str | None = None) -> bool
    def reject_pair(self, request_id: str, reason: str | None = None) -> bool
    def cancel_pair(self, request_id: str) -> bool      # 直接断开发起中的会话
    def devices(self) -> list[dict]        # [{"peer_id","display_name","role","paired_at","last_seen_at","online","phase"}]
    def remove_device(self, peer_id: str) -> bool       # 撤销配对（断连 + 删记录）
    def events_since(self, cursor: int) -> tuple[int, list[dict]]   # 事件轮询（UI 用）
```

- 事件类型（`events_since` 返回）：`{"type": "session", "phase": ...}`、`{"type": "pair_request", ...}`、
  `{"type": "pair_result", "approved": bool}`、`{"type": "device", "peer_id": ...}`、`{"type": "error", "message": ...}`。
- 线程/异步：全部异步 API；内部无阻塞调用（文件 IO 用 `asyncio.to_thread`）。
- store_dir 默认：**与 web 后端现有数据目录同级**（`backend_data`/`app.state` 现有约定），
  文件：`lansync_identity.json`（含私钥，权限 0600）、`lansync_devices.json`（信任表）。

## 4. 里程碑

| # | 内容 | 验收 | 状态 |
| --- | --- | --- | --- |
| M1 | 协议底座：deviceid / frame / crypto（身份+握手+派生+AEAD） | pytest 单测（含 RFC 向量）+ 与 Swift 生成向量逐字节比对 | 进行中 |
| M2 | 会话状态机（host）：hello / pair_request / 批准 / ready / 业务帧转发 | 内存回环端到端：Python 参考客户端完成配对进入 ready | 进行中 |
| M3 | 服务层 + TCP 监听 + mDNS 广播 + 身份/信任表持久化 | 本地起服务，`_qqplayer-sync._tcp` 可被 `dns-sd -B` 看到 | 进行中 |
| M4 | FastAPI 路由 + Vue 同步页（身份/QR/批准卡/设备列表） | 接口自测 + 前端构建通过；UI 验收交用户 | 待做 |
| M5 | **真机验收**：iPhone 扫 web 版 QR 完成配对（用户操作） | 用户真机 | 待做 |
| M6 | 内容同步：manifest(10/11) / 内容清单(15/16) / 拉取(12/13) / 推送(14+4/5/6) | 待 M5 后按能力矩阵推进 | 规划中 |
| M7 | 播放数据同步：change_log(8/9) + LWW + content_hash 映射 + 对齐歌词 | 同上 | 规划中 |

## 5. 验证策略（不依赖模拟器）

1. **纯逻辑单测**（pytest，backend/tests）：Device ID / 帧编解码 / 握手正反例 / nonce 池 / 状态机迁移。
2. **跨语言向量比对**（`tools/lansync-vectors`）：用 macOS `swiftc` 编译 Swift 端**纯逻辑文件**
   （DeviceID/SyncFrame/SyncCrypto，CryptoKit 在 macOS 可用）生成 JSON 向量，Python 侧逐字节复算比对。
   覆盖：device_id、hello 签名输入与签名、ECDH+HKDF 派生密钥、AEAD（nonce/AAD/密文）、帧编码。
   —— 这是「iOS 能否验通 web 端握手」的**离线铁证**。
3. **Python 回环端到端**：测试用参考客户端（按 §1-§3 规范实现 client 角色）连本机 host，
   完成 hello → pair_request → 批准 → ready → 收发加密帧。
4. **真机**（用户）：iPhone 扫码配对 + 后续内容同步验收。

## 6. 开放问题（待用户拍板，见协议文档末节）

1. web 主机的能力范围（仅配对/传输，还是含文件推送与播放数据）——决定 M6/M7 工作量。
2. 手输配对路径是否要求 nonce（Swift 端语义待确认）。
3. web 版与 macOS Swift 版是否同机并存（两个 Host 同时广播的取舍）。
