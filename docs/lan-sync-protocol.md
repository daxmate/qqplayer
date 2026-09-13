# QQPlayer 局域网同步（S2）线协议规范 · web/FastAPI 主机实现版

> 本文件是 **Swift 端既有实现（~/codes/qqplayer-swift，QQPlayer/Sync/*.swift）的逐字段提取**，
> 供 web 版（FastAPI + Vue）以 Host 角色接入同一协议。权威真源是 Swift 源码，
> 实现与本文件冲突时**以 Swift 源码为准并回来修本文件**。
>
> 提取日期 2026-09-14。协议版本 `protoVersion = 1`。

## 0. 角色与拓扑（web 主机场景）

```
web QQPlayer（Host / 服务端，本仓库）      iOS QQPlayer（Client / 移动端）
├─ 曲库（桌面 ~/Music/QQPlayer）            ├─ 沙盒 Documents 曲库
├─ TCP 监听（帧协议）+ mDNS 广播            ├─ 扫码/手输配对 → 主动连接
└─ 本机 DB（真源）                          └─ 本地 DB（同 schema）
```

- Host = 内容生产端 + 服务端；Client = 移动端，**同步发起方恒为 Host**（iOS 纯被动端）。
- 一个 Client 可配对多台 Host；每台 Host 独立同步。
- 加密为**应用层**（非 TLS）：ChaCha20-Poly1305 + X25519 会话密钥，见 §2。

## 1. 传输与帧格式

- TCP 连接，无 TLS。帧头恒明文。
- 帧 = `magic(4B "QQP1") | length(4B big-endian = payload 字节数) | type(1B) | flags(1B) | payload(N)`
  - 帧头 10B：`QQP1` + 4B 大端长度 + 1B type + 1B flags。
  - `flags` bit0(`0x01`) = encrypted。配对/握手帧（type 0/1/2）**恒明文**；
    ready 后业务帧一律置位并加密 payload。
  - payload 上限 16 MiB（编解码双侧校验）；magic 错/type 非法/超限 = 流损坏 → 断连。
- 加密帧 payload = `nonce(12) ‖ ciphertext ‖ tag(16)`（ChaCha20-Poly1305 combined），
  长度 = 明文长度 + 28。
  - nonce = 4B 零前缀 ‖ 8B 大端计数器（首帧 counter = 1，方向独立计数）。
  - **AAD = 完整 10B 帧头**（`QPQP1?`：用**加密后**的 payload 长度、含 encrypted flag 的 flags），
    收发两端 AAD 必须逐字节一致。
  - 收方先校验密文内嵌 nonce == 期望计数（防乱序/重放/回退）再做 AEAD 校验。
- 流式拼帧：按 `length` 前缀切帧，残缺帧留缓冲；magic 校验在整帧收齐前先做。

## 2. 握手与会话加密

连接建立后、业务帧前，双方各发一帧 `type=0 handshake`（明文），payload 为 `SyncHello` JSON：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `role` | string | `"client"`（连接发起方）/ `"host"`（服务方） |
| `deviceID` | string | 签名方长期 Device ID（全量 base32，52 字符） |
| `peerDeviceID` | string | 签名方"以为在跟谁说话"的对方 ID；空串 = 未知（首连） |
| `ephemeralPublicKey` | string | 一次性 X25519 公钥 raw 32B，**standard** base64 |
| `signature` | string | Ed25519 签名（64B）base64，输入 = `ephemeralPub(32B) ‖ peerDeviceID(utf8) ‖ role(utf8)` |
| `name` | string? | 发送方展示名（**不参与签名**，纯展示；旧端无此字段 = 不带名） |

握手流程：

1. **client 先发 hello**（`peerDeviceID` = 期望主机 ID / 扫码候选 ID / 空串），**host 应答 hello**。
2. 验签（TOFU pinning）：
   - 已配对：用配对记录里的对方 Ed25519 公钥验 hello 签名。
   - 未配对（host 信任表无此 client）：host **不验签**先回 hello（配对路径由 QR nonce 签名另行认证）。
   - 绑定校验：`hello.peerDeviceID` 非空时必须 == 本端 Device ID；**host 的 hello 必须绑定 client ID**（`allowEmptyPeerBinding = false`），client 的 hello 允许空绑定（首连未知）。
   - `role` 必须与期望一致（防跨角色重放）。
3. 密钥派生（双方用自己 ephemeral 私钥 + 对方 hello 的 ephemeral 公钥）：
   `shared = X25519(myPrivate, peerPublic)`
   `master = HKDF-SHA256(ikm=shared, salt=b"", info=b"qqplayer-sync/v1/master", 32B)`
   `c2h    = HKDF-SHA256(ikm=master, salt=b"", info=b"qqplayer-sync/v1/dir/c2h", 32B)`
   `h2c    = HKDF-SHA256(ikm=master, salt=b"", info=b"qqplayer-sync/v1/dir/h2c", 32B)`
   host：send=h2c / recv=c2h；client：send=c2h / recv=h2c（**方向密钥不可混用**）。
4. 握手超时：host 在 `waitingForPeerHello` / `waitingForPairRequest` 阶段挂 `handshakeTimeout`（缺省 10s）；
   `waitingForPairApproval` / `waitingForPairResponse` **不挂超时**（等人工决定）。

**⚠️ 签名字节不可复现（2026-09-14 web 端实现实测）**：Apple CryptoKit 的 Ed25519 是 **hedged** 变体 ——
同一密钥、同一消息两次签名结果不同（`swiftc` 实测 `s1 != s2`，且都与本仓库向量里的 `signature_b64` 不同，
三者互相验签全部通过）。因此：

- 跨语言向量比对**只能比对签名输入的字节与验签结果，不能比对签名字节**（`tools/lansync-vectors` 即按此口径）；
- 本端（web）签名是确定性 RFC8032（字节正确性由 RFC8032 §7.1 官方向量锁定）；
  iOS 侧用标准 Ed25519 验签语义，能验通任何合法签名（含本端确定性签名），互操作不受影响。

## 3. 配对流程（QR 为主，手输为备）

### 3.1 QR 载荷（Host 生成并展示）

`PairQRPayload` JSON（QR 码文本 = 该 JSON 的 utf8）：

| 字段 | 说明 |
| --- | --- |
| `protoVersion` | int，当前 1 |
| `hostName` | Host 展示名 |
| `deviceID` | Host 全量 Device ID |
| `publicKey` | Host Ed25519 公钥 raw 32B，standard base64 |
| `sessionNonce` | 一次性 16B 随机 nonce，standard base64 |

- nonce 生命周期：展示 QR 时注册进 host nonce 池；**配对完成 / 停止监听 / 换新码**时作废
  （Swift 端 `SyncPairingNonceRegistry`，2026-09-13 起 TTL = ∞，靠显式作废）。

### 3.2 配对消息

`PairRequest`（client → host，`type=1`，明文）：

| 字段 | 说明 |
| --- | --- |
| `clientDeviceID` | client 全量 Device ID |
| `clientPublicKey` | client Ed25519 公钥 raw base64 |
| `nonceSignature` | Ed25519 签名（64B）base64，**对 QR 里的 sessionNonce 原始字节签名** |
| `clientName` | client 展示名（可选，不参与验签） |

`PairResponse`（host → client，`type=2`，明文）：`{"approved": bool, "reason": string?}`

### 3.3 Host 侧状态迁移（本实现需完整复刻）

```
接连接 → waitingForPeerHello
  ← client hello：校验 role=client、deviceID 合法；
     若信任表已有该 client：验签（pinning + 绑定本端 ID，允许空绑定）通过才继续，否则 close(handshakeFailed)
     回 host hello（peerDeviceID = client.deviceID，必须绑定，不得为空）
     若已配对 → 派生密钥 → ready
     若未配对 → waitingForPairRequest（挂超时）
  ← pair_request：
     1. 结构校验：deviceID 合法；publicKey 32B；DeviceID == SHA256(pubkey) 指纹；nonceSignature 64B
     2. request.clientDeviceID 必须 == 本连接 hello 里的 deviceID（防配流劫持）
     3. nonce 验签：用 request.clientPublicKey 对 nonce 池里任一未作废 nonce 验签，命中即消耗
     4. 任一失败 → 回 approved=false + reason → 断连（明确失败，不静默）
     5. 全部通过 → waitingForPairApproval + 触发 UI 批准卡（建议名 = DeviceID 分组格式）
  ← 用户批准 → 落 client 信任记录（peerID/peerPublicKey/displayName/role=client/pairedAt/lastSeenAt）
             → 回 approved=true → 派生密钥 → ready
  ← 用户拒绝 → 回 approved=false + reason → 断连
```

- 派生密钥的双方 ephemeral 来自本连接已交换的两个 hello（host hello + client hello）。
- `lastSeenAt`：最近一次成功连接时刷新。

### 3.4 手动输入（备选）

Host 以 `DeviceID.formatted()` 分组展示 ID（每 7 字符一组、`-` 分隔，共 8 组：7×7+3），
用户比对首/尾组后走同一握手流程（client 用 host ID 作 `peerDeviceID`）。
注意：手输路径**没有 QR nonce**，本仓库实现需与 Swift 端确认该路径是否要求 nonce（见「开放问题」）。

## 4. Device ID 编码（`DeviceID.swift`）

- 全量 ID = `SHA256(Ed25519 公钥 raw 32B)` → RFC4648 **base32 大写、无填充**（52 字符）。
- 展示格式 = 每 7 字符一组、`-` 分隔（末组 3 字符）：`ABCDEFG-HIJKLMN-...`。
- 手输规范化：去 `-`/空白 → 大写 → 长度 52 → 解码 base32（32B、尾部填充位必须为 0）→ 再编码回写。
- 一致性校验：`DeviceID == base32(SHA256(pubkey))`。

## 5. 帧类型表（v1，线上 1B 值）

| 值 | 名称 | 加密 | 方向/用途 |
| --- | --- | --- | --- |
| 0 | handshake | 明文 | 双向，`SyncHello` |
| 1 | pair_request | 明文 | client → host，`PairRequest` |
| 2 | pair_response | 明文 | host → client，`PairResponse` |
| 3 | ping | 加密 | 双向占位（v1 无心跳：**收到忽略、不回**，防 ping-pong） |
| 4 | file_meta | 加密 | 文件传输元数据（M2b） |
| 5 | file_chunk | 加密 | 文件分块（M2b） |
| 6 | file_ack | 加密 | 分块确认（M2b） |
| 7 | bye | 加密 | 优雅关闭 |
| 8 | change_log_pull | 加密 | 播放数据增量拉取（M4-1） |
| 9 | change_log_push | 加密 | 播放数据增量推送（M4-1） |
| 10 | manifest_request | 加密 | 文件同步 manifest 请求（M3-3a） |
| 11 | manifest_response | 加密 | manifest 应答（M3-3a） |
| 12 | sync_fetch_request | 加密 | 按路径拉取请求（M3-3b） |
| 13 | sync_fetch_result | 加密 | 按路径拉取结果（M3-3b） |
| 14 | library_push_announce | 加密 | Mac → 设备：声明即将推送的文件与目标相对路径（R1b-1） |
| 15 | peer_library_request | 加密 | 对端内容清单请求（T9） |
| 16 | peer_library_response | 加密 | 对端内容清单应答（T9） |

- ready 后收到 type 0/1/2 = 协议违例 → 断连；未 ready 收到 type ≥ 3 = 协议违例。
- 未知 type 值 = 解码期即拒（流损坏）。

## 6. 会话阶段与关闭原因（UI/状态机口径）

阶段：`idle → waitingForPeerHello → (host) waitingForPairRequest → waitingForPairApproval → ready`
/ `(client) waitingForPairResponse → ready`；任意阶段 → `closed`。

关闭原因：`userCancelled` / `remoteClosed` / `receivedBye` / `handshakeTimeout` /
`handshakeFailed(err)` / `peerUntrusted` / `pairingRejected(reason)` / `storageError` /
`protocolViolation` / `transportError`。

## 7. 信任记录（`PeerDevice`）

| 列/键 | 说明 |
| --- | --- |
| `peer_id` | 对方全量 Device ID |
| `peer_public_key` | 对方 Ed25519 公钥 raw base64（pinning 依据，握手验签用） |
| `display_name` | 展示名 |
| `role` | `host` / `client`（对方的角色） |
| `paired_at` / `last_seen_at` | Int64 epoch 秒 |
| `notes` | 可空 |

撤销配对 = 删除记录；此后任何连接验指纹失败即拒。**web 端存储形态见实现（本仓库为 JSON/SQLite，键名沿用本表）。**

## 8. 发现（mDNS/Bonjour）

- 服务类型 `_qqplayer-sync._tcp`（**注意：与旧 companion 协议的 `_qqplayer._tcp` 不同**）。
- Host 广播：`TXT = {protoVer: "1", name: <设备名>}`；**不广播完整 Device ID**。
- Client 浏览并连接后以指纹验证身份（广播内容本身不可信）。
- 手动 IP 兜底路径见设计文档 §3。

## 9. 待补章节（由后续实现任务提取后并入本文件）

- §10 文件同步：manifest（10/11）、按路径拉取（12/13）、推送声明（14）、分块传输（4/5/6）载荷与状态机
- §11 播放数据同步：change_log（8/9）、LWW、游标、content_hash 映射
- §12 对端内容清单（15/16）载荷与分页
- §13 对齐歌词同步（随歌通道）
- §14 web 主机与 iOS 客户端的能力矩阵（本仓库实现范围 vs 未实现帧）

## 开放问题（待用户拍板）

1. **web 主机的能力范围**：仅配对+传输（M1/M2），还是含文件推送（M3）与播放数据（M4）？——影响工作量数量级。
2. **手输配对路径**：Swift 端手输路径是否也要求 QR nonce？若无 nonce 来源，web 端手输配对是否需要额外放行（安全权衡）。
3. **web 版运行位置**：与 macOS Swift 版同机并存（两个 Host 都在广播）还是独立部署（NAS 等）——影响端口/发现与 UI 措辞。
