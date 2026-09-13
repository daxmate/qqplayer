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

## 10. 文件传输帧（4/5/6）

**帧号**（`SyncFrame.swift:57-59`）：`file_meta = 4` / `file_chunk = 5` / `file_ack = 6`。

共同约定：

- 三帧都是 **ready 之后的业务帧**：`flags` bit0（`0x01` encrypted）**必须置位**，未加密的业务帧 = 协议违例 → 断连（`SyncPeerSession+Frames.swift:281`）。
- payload = 对应载荷类型的 **JSON 字节**（`JSONEncoder` 默认输出；`SyncFileTransferModels.swift:98-106`）。
- 会话层解密后整帧经 `onApplicationFrame` 交给应用层（`SyncPeerSession+Frames.swift:304-308`）。
- 字段「可加不可改名」（`SyncFileTransferModels.swift:12`）；JSON 键名 = Swift 属性名（各载荷结构体均无自定义 `CodingKeys`）。
- 编码/解码两侧都受 16 MiB payload 上限约束（`SyncFrame.swift:93`）。

### 10.1 `file_meta`（4）· `FileMetaPayload`

| 字段 | 类型 | 单位 | 可空 | 语义 | 源码 |
| --- | --- | --- | --- | --- | --- |
| `fileID` | string | — | 否 | 传输唯一 ID；断点续传时**必须与首轮一致** | `SyncFileTransferModels.swift:28` |
| `name` | string | — | 否 | 文件名（**不含路径**；接收端落盘名） | `SyncFileTransferModels.swift:30` |
| `totalSize` | Int64 | 字节 | 否 | 文件总字节数 | `SyncFileTransferModels.swift:32` |
| `chunkSize` | Int64 | 字节 | 否 | 分块大小（发送端定，固定 `262144`） | `SyncFileTransferModels.swift:34` |
| `sha256Hex` | string | — | 否 | 全文件 SHA-256 小写 hex（64 字符） | `SyncFileTransferModels.swift:36` |
| `startOffset` | Int64 | 字节 | 否（缺省 `0`） | 续传起点；必须对齐块边界（0 或 `% chunkSize == 0`） | `SyncFileTransferModels.swift:38` |

发送端构造点（一次传输一帧，`startOffset` 由调用方给，默认 0）：`SyncFileSender.swift:148-153`。

接收端参数校验集（`SyncFileReceiver.swift:387-406`，任一不满足 → 回 `protocolError` 中止，`:203-205`）：

1. `fileID` / `name` 非空；`name` 不是 `.` / `..`，不含 `/` 与 `\`（防目录穿越）；
2. `totalSize >= 0`、`startOffset >= 0`、`startOffset <= totalSize`；
3. `chunkSize > 0` 且 `chunkSize <= 16 MiB`（`SyncFrame.maxPayloadSize`）；
4. `startOffset == 0 || startOffset % chunkSize == 0`；
5. `sha256Hex` 为 64 位 hex（`SyncFileChecksum.swift:39-41`）；
6. `totalSize == 0` 时 `sha256Hex` 必须等于空数据 SHA-256 `e3b0c442…b855`（`SyncFileChecksum.swift:14`，自洽性检查 `SyncFileReceiver.swift:402-404`）。

### 10.2 `file_chunk`（5）· `FileChunkPayload`

| 字段 | 类型 | 单位 | 可空 | 语义 | 源码 |
| --- | --- | --- | --- | --- | --- |
| `fileID` | string | — | 否 | 所属传输 ID | `SyncFileTransferModels.swift:43` |
| `offset` | Int64 | 字节 | 否 | 本块起点；**必须等于接收端已收完整字节数**，且对齐块边界 | `SyncFileTransferModels.swift:45` |
| `data` | base64 string | — | 否 | 块字节（`Data` 经 JSON 自动 base64） | `SyncFileTransferModels.swift:46` |

块大小上限：`byteCount > 0 && byteCount <= chunkSize && byteCount <= totalSize - received`，否则中止（`SyncFileReceiver.swift:319-327`）。末块可小于 `chunkSize`。

### 10.3 `file_ack`（6）· `FileAckPayload`

| 字段 | 类型 | 单位 | 可空 | 语义 | 源码 |
| --- | --- | --- | --- | --- | --- |
| `fileID` | string | — | 否 | 所属传输 ID | `SyncFileTransferModels.swift:52` |
| `receivedBytes` | Int64 | 字节 | 否 | 接收端 `.part` 当前**完整**字节数（已对齐块边界） | `SyncFileTransferModels.swift:53` |
| `done` | bool | — | 否 | 本文件已完成（校验通过 + 已落正式名） | `SyncFileTransferModels.swift:54` |
| `error` | string | — | 否 | 线上错误码（见下表），无错 = `"none"` | `SyncFileTransferModels.swift:55` |

`error` 取值（`String` 原始值 = 枚举 case 名，`SyncFileTransferModels.swift:59-67`）：

| 值 | 含义 | 源码 |
| --- | --- | --- |
| `none` | 无错误（进度/成功信号） | `SyncFileTransferModels.swift:60` |
| `ioError` | 落盘 IO 失败（非磁盘满） | `SyncFileTransferModels.swift:61` |
| `diskFull` | 磁盘满（`ENOSPC` / `NSFileWriteOutOfSpaceError` 映射） | `SyncFileTransferModels.swift:62`、`SyncFileReceiver.swift:448-453` |
| `checksumMismatch` | 整文件 SHA-256 与 `file_meta.sha256Hex` 不符（`.part` 已删） | `SyncFileTransferModels.swift:63`、`SyncFileReceiver.swift:365-370` |
| `resumeMismatch` | 接收端断点状态与请求 `startOffset` 不符 | `SyncFileTransferModels.swift:64`、`SyncFileReceiver.swift:249-260` |
| `cancelled` | 本端主动取消（接收端当前不主动回此码） | `SyncFileTransferModels.swift:65` |
| `protocolError` | 协议违例（参数非法 / 无 meta 先到块 / 块序错 / 交叠传输 / 载荷解码失败） | `SyncFileTransferModels.swift:66` |

`done` 判定：接收端只在**整文件校验通过并改名成功后**置 `done=true` 且 `receivedBytes = totalSize`（`SyncFileReceiver.swift:378-381`）；幂等命中（目标已存在且 size+sha 相同）也回 `done=true`（`:216-217`）；0 字节文件回 `done=true, receivedBytes=0`（`:238-241`）。

接收端**不收 `file_ack`**：收到即静默忽略（`SyncFileReceiver.swift:155-157`）。

### 10.4 常量

| 常量 | 值 | 说明 | 源码 |
| --- | --- | --- | --- |
| 分块大小 | `262144` 字节（256 KiB） | 发送端定；块 base64 后约 342 KB，远小于帧上限 | `SyncFileTransferModels.swift:22` |
| 帧 payload 上限 | `16 * 1024 * 1024` 字节 | 编解码双侧校验 | `SyncFrame.swift:93` |
| `file_meta` / `file_chunk` 上限 | 同上 | 解码超限抛 `payloadTooLarge` | `SyncFrame.swift:136-138` |
| 等待 `file_ack` 超时 | `30` 秒（`defaultAckTimeout`） | 每块等待一次；0 = 禁用（仅测试） | `SyncFileSender.swift:79`、`:38` |
| SHA-256 流式读窗口 | `1_048_576` 字节（1 MiB） | 大文件不整进内存 | `SyncFileChecksum.swift:26` |
| 断点对齐粒度 | `chunkSize` | `alignDown(v, chunkSize) = v - v % chunkSize` | `SyncFileSender.swift:317-319`、`SyncFileReceiver.swift:421-423` |

### 10.5 断点续传 / `.part` 落盘 / SHA-256

**落盘形态**：接收端先写 `{name}.part`（与最终文件同目录），校验通过后改名到位（`SyncFileReceiver.swift:209`）。

| 主题 | 规则 | 源码 |
| --- | --- | --- |
| 整文件 SHA-256 何时算 | **发送端**：`send()` 内先流式读一遍算（发 `file_meta` 前） | `SyncFileSender.swift:131-137` |
| 同上 | **接收端**：① 幂等判定时对已存在目标文件算一次；② 收齐全部块后对 `.part` 算一次 | `SyncFileReceiver.swift:215`、`:360` |
| 和谁比 | 接收端结果与 `file_meta.sha256Hex` 比较；发送端不校验（把结果交接收端判定） | `SyncFileReceiver.swift:365` |
| 大小写 | 接收端比较前统一 `lowercased()`（线上发小写 hex，收大小写不敏感） | `SyncFileReceiver.swift:210`、`:365` |
| 原子落盘 | 校验通过 → `FileManager.replaceItemAt(finalURL, withItemAt: partURL)`（目标已存在则替换，不先删） | `SyncFileReceiver.swift:373` |
| 校验失败 | 删 `.part` + 回 `error=checksumMismatch, receivedBytes=0`（发送端可从头重发） | `SyncFileReceiver.swift:365-370` |
| IO 失败（改名/写出） | 回 `ioError`（`.part` 保留，可续传） | `SyncFileReceiver.swift:374-377`、`:329-337` |
| 0 字节文件 | 不发块：接收端确保最终文件存在且为 0 字节，回 `done=true` | `SyncFileReceiver.swift:222-242` |
| 幂等 | 目标文件已存在 + `size == totalSize` + SHA-256 相符 → 直接 `done=true`，不重写不重传 | `SyncFileReceiver.swift:212-218` |

**断点续传语义**（`startOffset > 0`）：

1. 发送端把 `startOffset` 放进 `file_meta`（`:148-150`）。
2. 接收端读 `.part` 现有字节数，向下对齐到块边界得 `alignedPart`（`SyncFileReceiver.swift:244-246`）。
   - `.part` 不存在且 `startOffset > 0` → 没有可续数据源 → 回 `resumeMismatch`（`:249-252`）。
   - `startOffset == 0` → 删掉任何残留 `.part`，从头收（`:254-256`）。
   - `alignedPart != startOffset` → 回 `resumeMismatch`（`:257-261`）。
   - `.part` 尾部有半块残留（写块中途异常）→ `truncate` 到块边界；**对齐失败绝不静默继续**，直接回 `ioError` 并中止（`:266-275`）。
3. 接收端回初始 ack：`receivedBytes = 0`（从头）或 `alignedPart`（续传），`done=false`（`:278`、`:290`）。
4. 发送端从 `alignDown(ack.receivedBytes, chunkSize)` 处读下一块继续发（`SyncFileSender.swift:221-236`）。
5. 续传起点已含全部字节（上轮收齐但未及改名）→ 接收端直接走整文件校验收尾（`SyncFileReceiver.swift:281-284`）。

**续传尝试间隔的失败语义**：接收端回 `resumeMismatch` 时，调用方可改 `startOffset = 0` 重试一次（`SyncFileTransferModels.swift:92-93`）。

**本地错误（不上线，仅供调用方决策）**：`SyncFileTransferError` 含 `sessionNotReady` / `fileUnavailable` / `transferInProgress` / `invalidArgument` / `cancelled` / `sessionClosed` / `sendFailed` / `ioError` / `diskFull` / `checksumMismatch` / `resumeMismatch` / `protocolError`（`SyncFileTransferModels.swift:71-96`）。

### 10.6 错误与中止语义

**发送端对 ack 的判定**（`SyncFileSender.swift:196-251`）：

| 收到 | 判定 | 源码 |
| --- | --- | --- |
| `error != none` | 本轮失败（映射为本地错误；`resumeMismatch` 保留给调用方做 `startOffset=0` 重试） | `SyncFileSender.swift:201-203`、`:305-315` |
| `done == true` | `receivedBytes` 必须 == `totalSize`，否则 `protocolError`（"done ack 字节数与 totalSize 不符"） | `SyncFileSender.swift:205-210` |
| `done == false` | `receivedBytes` 必须在 `[0, totalSize]`，且**必须严格大于上次 ack**（重复/回退 = `protocolError`，防死循环重发） | `SyncFileSender.swift:213-219` |
| 未 `done` 但字节已收齐 | `protocolError`（"ack 未 done 但字节已收齐"） | `SyncFileSender.swift:222-224` |
| 别的 `fileID` 的 ack | 静默忽略（空闲期 stray ack 同样忽略） | `SyncFileSender.swift:197-198` |

**超时**：每发一块重挂 `30s` 定时器；到点按 `protocolError("等待 file_ack 超时")` 终止本轮并清状态（可重试，不留悬挂）（`SyncFileSender.swift:256-278`）。

**中止路径**：

| 触发 | 行为 | 源码 |
| --- | --- | --- |
| 发送端 `cancel()` | 停止发送，回调 `.cancelled`；接收端 `.part` 保留可续传 | `SyncFileSender.swift:166-170` |
| 会话断连（任一端） | 发送端回调 `.sessionClosed`；接收端清内存状态、**保留 `.part`** | `SyncFileSender.swift:173-177`、`SyncFileReceiver.swift:119-126` |
| 接收端 `cancel()` | 清内存状态，`.part` 保留 | `SyncFileReceiver.swift:108-116` |
| 接收端 meta 解码失败 | 若能从原始 JSON 取出 `fileID` → 回 `protocolError` 让发送端干净失败；取不到则靠发送端 ack 超时兜底 | `SyncFileReceiver.swift:133-139`、`:165-176` |
| 接收端块解码失败 / 块序违例 / 越界 | 回 `protocolError`（带当前 `receivedBytes`）并中止 | `SyncFileReceiver.swift:142-153`、`:309-327` |
| 交叠传输 | 同一接收端收到**不同 `fileID`** 的 meta / 无 meta 先到块 → 回 `protocolError`（v1 单飞，不支持交叠） | `SyncFileReceiver.swift:196-199`、`:300-307` |
| 发送端并发 `send()` | 直接 `throw transferInProgress`（未开始 = 抛错，不走回调） | `SyncFileSender.swift:107-110` |
| 会话未 ready | `throw sessionNotReady` | `SyncFileSender.swift:111-113` |

**回调契约**：`send()` 只对「未开始的传输」（参数/文件/会话前置错误）抛错；一旦传输开始，终态**每轮恰一次**经 `onCompletion` 通知（锁外触发）（`SyncFileSender.swift:15-16`、`:29-33`）。

### 10.7 正常传输时序

```
发送端(SyncFileSender)                                  接收端(SyncFileReceiver)
   |                                                          |
   |  本地：流式算全文件 SHA-256                                |
   |                                                          |
   |-- file_meta(4) {fileID,name,totalSize,chunkSize,          |
   |                 sha256Hex,startOffset=0} --------------->|  校验参数
   |                                                          |  幂等检查 / 断点对齐
   |<-- file_ack(6) {fileID,receivedBytes=0,done=false,       |  打开 .part 追加写
   |                 error=none} ------------------------------|
   |                                                          |
   |-- file_chunk(5) {fileID,offset=0,data(256KiB)} --------->|  写 .part
   |<-- file_ack(6) {receivedBytes=262144,done=false} --------|
   |                                                          |
   |-- file_chunk(5) {offset=262144,data} ------------------->|  …每块一次停等…
   |<-- file_ack(6) {receivedBytes=524288,done=false} --------|
   |                       …                                 |
   |-- file_chunk(5) {offset=totalSize-末块长度,data} ------->|  收齐
   |                                                          |  整文件 SHA-256
   |                                                          |  相符 → .part 原子改名为正式文件
   |<-- file_ack(6) {receivedBytes=totalSize,done=true,       |
   |                 error=none} ------------------------------|
   |  本轮成功（onCompletion）                                  |  已就绪（onCompletion，带 fileID+sha256+URL）
```

续传轮（`startOffset = 上一轮 ack.receivedBytes`，对齐块边界）：

```
   |-- file_meta(4) {…, startOffset=N} ---------------------->|  .part 对齐后 == N → 续写
   |<-- file_ack(6) {receivedBytes=N, done=false} ------------|
   |-- file_chunk(5) {offset=N, data} ----------------------->|  …
```

### ⚠️ 与设计文档差异

- 设计文档 §6.1 只写「断点传输 → 校验 → 入库」，**未规定**分块大小、错误码枚举、ack 超时与 `.part` 命名；本章按实现事实补齐（256 KiB / 7 个错误码 / 30s / `{name}.part`）。
- 设计文档 §5 未提「幂等：目标已存在且 size+sha 相符直接 `done`」。实现有该短路（`SyncFileReceiver.swift:212-218`），线上表现为该文件**不发任何块**。
- 设计文档 §6.1 的「从设备下载（Client→Host）」描述的是**字节方向**；协议事实上**发起方恒为 Mac**（§12b 决策 6），下载时由 Mac 发 `sync_fetch_request`(12)、设备回推字节（见 §11）。

## 11. manifest 与按路径拉取（10/11、12/13）

**帧号**（`SyncFrame.swift:63-66`）：`manifest_request = 10` / `manifest_response = 11` / `sync_fetch_request = 12` / `sync_fetch_result = 13`。四帧均加密、payload 为 JSON（同 §10 共同约定，`SyncPeerSession+Frames.swift:281`、`:304-308`）。

### 11.1 `manifest_request`（10）· `SyncManifestRequest`

| 字段 | 类型 | 可空 | 语义 | 源码 |
| --- | --- | --- | --- | --- |
| `collection` | SyncCollection | 否 | 集合过滤参数（全库 / 歌单 / 手动勾选） | `SyncManifest.swift:57` |
| `knownHashes` | object(string→string) | 是 | 请求方已知的「相对路径 → content_hash」；**v1 恒缺省**（请求全量），增量请求预留 | `SyncManifest.swift:60` |

`SyncCollection` 结构（`SyncCollection.swift:24-53`）：

| 字段 | 类型 | 语义 | 源码 |
| --- | --- | --- | --- |
| `kind` | string | `"all"` / `"playlists"` / `"tracks"`（枚举 raw value） | `SyncCollection.swift:26-30`、`:32` |
| `ids` | string[] | `playlists` = 歌单标识列表；`tracks` = 歌曲 stableId 列表；`all` 忽略（空数组） | `SyncCollection.swift:34` |

- `.all` = 全库（`SyncCollection.swift:37`）；选择性集合但 `ids` 为空 = **不选任何文件**（与 `.all` 语义相反，`SyncCollection.swift:49-52`）。
- 集合过滤在**两端各自执行**：请求方过滤 manifest，应答方过滤自己回得去的条目（`SyncCollection.swift:88-95`）。

### 11.2 `manifest_response`（11）· `SyncManifestResponse`

| 字段 | 类型 | 可空 | 语义 | 源码 |
| --- | --- | --- | --- | --- |
| `entries` | ManifestEntry[] | 否 | 集合过滤后的条目，**按 `relativePath` 升序**（确定性） | `SyncManifest.swift:71`、`SyncManifestGenerator.swift:72` |
| `rootName` | string | 是 | 对端曲库根显示名（诊断/UI 用，**不参与对账**） | `SyncManifest.swift:73` |

`ManifestEntry`（对账条目，`SyncManifest.swift:25-50`）：

| 字段 | 类型 | 单位 | 可空 | 语义 | 源码 |
| --- | --- | --- | --- | --- | --- |
| `relativePath` | string | — | 否 | 相对**曲库根**的 POSIX 路径（如 `Album/01 Song.flac`）——**对账键** | `SyncManifest.swift:27` |
| `size` | Int64 | 字节 | 否 | 文件字节数 | `SyncManifest.swift:29` |
| `mtimeMs` | Int64 | 毫秒 since 1970 | 否 | 修改时间（变更提示；**v1 不参与判定**） | `SyncManifest.swift:31` |
| `contentHash` | string | — | **是** | 全文件 SHA-256 小写 hex（跨端歌曲身份键）；缺省 = 尚未指纹 | `SyncManifest.swift:33` |
| `stableId` | string | — | **是** | 本端 stableId（跨端引用映射用，**不参与对账**） | `SyncManifest.swift:35` |

**分页：没有。** `manifest_response` 是**单帧全量**——载荷中不存在 `page` / `cursor` / `total` / `hasMore` 一类字段；唯一上限是 16 MiB payload（`SyncFrame.swift:93`），超限即编码拒绝（`SyncFrame.swift:136-138`）。

**路径口径（对账键的单一事实源）**：`normalizeRelativePath` 拒绝空串 / 绝对路径 / `..` 逃逸，去 `./` 前缀与重复 `/`，统一 `\` → `/`，返回 nil 表示非法（调用方丢弃，绝不"顺手修正"）（`SyncManifestGenerator.swift:88-105`）。

**未接线不应答**：本地 manifest 提供者未接线时**不回帧**（绝不回空表——空表会被对端解读为"对端曲库为空"）（`SyncManifestPeer.swift:93-96`）。

**请求方行为**：`requestManifest` 发帧（`collection` 缺省 `.all`）（`SyncManifestPeer.swift:64-68`）；收到响应解码后交上层（`SyncManifestPeer.swift:110-119`）。

### 11.3 对账规则（`SyncManifestReconciler`，拉取方向）

输入 = 对端 manifest（远端）+ 本端清单（本地）；输出只有两个列表（`SyncManifestReconciler.swift:40-66`）：

| 情形 | 归属 | 源码 |
| --- | --- | --- |
| 远端有、本地**没有该 relativePath** | `toFetch`（补齐缺失） | `SyncManifestReconciler.swift:50-53` |
| 同路径，双侧 `contentHash` **非空且相等** | `unchanged` | `SyncManifestReconciler.swift:54-55`、`:70-75` |
| 同路径，hash 不同，**或任一侧为 nil**（尚未指纹） | `toFetch`（保守：宁可多传一次，不可漏传） | `SyncManifestReconciler.swift:56-58`、`:71-73` |
| **远端没有、本地有** | **什么都不做**（不进任何列表，本端原样保留） | `SyncManifestReconciler.swift:61-65` |

- **永不传播删除**：本地清单只用于判定"本地是否已有该路径 / 内容是否相同"，**不参与任何删除判定**（`SyncManifestReconciler.swift:10-14`、`:37-39`）。
- 输出均按 `relativePath` 升序（确定性）（`SyncManifestReconciler.swift:88-90`）；`reconciliation.isEmpty`（`toFetch` 为空）是幂等重跑判据（`SyncManifestReconciler.swift:29-32`）。
- **推送方向**（Mac → 设备）用同一份内容判定单点 `contentMatches`，但方向判定另写（以**本端选择集**为准，"我该给对端送什么"）：对端缺该路径 → 推送；同路径 hash 相同 → 跳过；任一侧 nil → 保守推送；**对端多出来的条目不动作**（`SyncLibraryPushController.swift:136-165`）。

### 11.4 `sync_fetch_request`（12）· `SyncFetchRequest`

| 字段 | 类型 | 可空 | 语义 | 源码 |
| --- | --- | --- | --- | --- |
| `collection` | SyncCollection | 否 | 集合（与 manifest 请求同一语义） | `SyncLibrarySyncModels.swift:56` |
| `relativePaths` | string[] | 否 | 请求的文件相对路径（相对**对端曲库根**，POSIX `/`）；**原样透传**，应答方逐条校验 | `SyncLibrarySyncModels.swift:59` |

- 请求列表是**显式点名**：协议里不存在"给我整个目录"这种指令，应答方只认列表里的路径（`SyncLibrarySyncModels.swift:14-16`）。
- 请求方构包前先 `normalize`（去非法 / 去重 / 升序）；应答方**仍须自行校验**（不信任对端）（`SyncLibrarySyncModels.swift:66-77`）。
- ⚠️ **待核实**：`collection` 字段的注释声称「应答方用它做二次集合过滤，防止越集合读取」（`SyncLibrarySyncModels.swift:55`），但当前应答器 `makePlan` 只接收 `relativePaths`，**未消费 `request.collection`**（`SyncLibraryFetchResponder.swift:258-263`）——线上字段存在、语义悬空。

### 11.5 `sync_fetch_result`（13）· `SyncFetchResult`

| 字段 | 类型 | 可空 | 语义 | 源码 |
| --- | --- | --- | --- | --- |
| `completed` | string[] | 否 | 已成功送达（且接收端 SHA-256 校验通过）的**规范化**相对路径；构造时排序去重 | `SyncLibrarySyncModels.swift:89`、`:94-98` |
| `failed` | SyncFileFetchFailure[] | 否 | 失败记录（构造时按 `(relativePath, reason)` 排序） | `SyncLibrarySyncModels.swift:91`、`:96-98` |

`SyncFileFetchFailure`（`SyncLibrarySyncModels.swift:81-84`）：

| 字段 | 类型 | 语义 | 源码 |
| --- | --- | --- | --- |
| `relativePath` | string | **请求方原始字符串**（原样回填，便于对端定位；非法路径也如实计入，不静默丢弃） | `SyncLibrarySyncModels.swift:82` |
| `reason` | string | 失败原因（取值见下） | `SyncLibrarySyncModels.swift:83` |

`reason` 取值（跨端字符串契约，可加不可改，`SyncLibrarySyncModels.swift:34-49`）：

| 值 | 含义 | 源码 |
| --- | --- | --- |
| `invalid_path` | 空 / 绝对路径 / 含 `..` 逃逸 / 规范化后为空 | `SyncLibrarySyncModels.swift:36` |
| `out_of_root` | 规范化后仍落在根之外（纵深防御）/ 软链逃逸出根 | `SyncLibrarySyncModels.swift:38`、`SyncLibraryFetchResponder.swift:229-231` |
| `not_found` | 根内不存在该文件（歌词未配置根 / 映射不到也归此） | `SyncLibrarySyncModels.swift:40`、`SyncLibraryFetchResponder.swift:177-188`、`:219-221` |
| `not_regular_file` | 存在但不是常规文件（目录等） | `SyncLibrarySyncModels.swift:42`、`SyncLibraryFetchResponder.swift:222-224` |
| `send_failed` | 传输失败（发送端终态）/ 现算 fileID 失败 | `SyncLibrarySyncModels.swift:44`、`SyncLibraryFetchResponder.swift:317`、`:367` |
| `session_closed` | 会话在推送过程中关闭（结果帧发不出去，直接收尾） | `SyncLibrarySyncModels.swift:46`、`SyncLibraryFetchResponder.swift:360-366` |
| `cancelled` | 本端主动取消 | `SyncLibrarySyncModels.swift:48` |

`SyncFetchResult.isFullSuccess` = `failed.isEmpty`（`SyncLibrarySyncModels.swift:101`）。

### 11.6 单文件按路径拉取时序

```
Mac（发起方 / SyncLibraryPullController）              设备（被动端 / SyncLibraryFetchResponder）
   |                                                       |
   |-- manifest_request(10) {collection} ---------------->|  本端清单（含 @lyrics 条目）
   |<-- manifest_response(11) {entries, rootName} ---------|
   |  reconcile：本地缺失 / 内容不同 → toFetch              |
   |  （远端没有而本地有的条目：什么都不做）                  |
   |-- sync_fetch_request(12) {collection,                 |
   |                          relativePaths:[...]} ------->|  逐条解析计划（越界/不存在 → failed）
   |                                                       |  串行推送：
   |<== file_meta(4) / file_chunk(5) / file_ack(6) =======>|  停等传输（同 §10）
   |  收齐 → SHA-256 校验 → 认领 → 落位 → 入库             |
   |<-- sync_fetch_result(13) {completed, failed} ---------|  全部推完（含全失败/空请求）
   |  终态 done（summary）                                  |
```

应答侧要点：

- **越界拒读**：每条请求路径先过纯路径数学（规范化 + 根内包含性）（`SyncLibraryFetchResponder.swift:199`、`SyncLibrarySyncModels.swift:173-184`）；再过磁盘三道——存在 / 常规文件 / `resolvingSymlinksInPath` 后仍在根内（`SyncLibraryFetchResponder.swift:217-233`）。任一不过 → `failed`，**绝不读根外文件**。
- **串行**：v1 单飞——一个 responder 同时只服务一个请求，服务中收到新请求**直接忽略**（`SyncLibraryFetchResponder.swift:266-270`）；推完一个文件（收到 `onCompletion`）才发下一个（`:284-303`、`:340-370`）。
- **fileID 口径**：`content_hash`（缺失则现算 SHA-256）；歌词文件现算（`SyncLibraryFetchResponder.swift:307-320`）。
- **结果帧必发**：所有路径走完（含空请求 / 全失败）都会回 `sync_fetch_result`（`SyncLibraryFetchResponder.swift:290-294`、`:405-409`）；唯一例外是会话已断（结果帧发不出去，直接收尾，`SyncLibraryFetchResponder.swift:360-366`）。
- **落地与认领（发起侧）**：收到的文件先落 `曲库根/.sync-incoming/`（`SyncLibraryPullController.swift:253-258`、`:97`）→ 按**传输级身份**（`fileID` 或 `sha256`）认领到目标相对路径（不用文件名当键，防同名不同目录错位）→ 原子移入（目标已存在则替换，失败保留本端原文件）→ 走既有入库入口（`SyncLibraryPullController.swift:339-401`、`SyncLibrarySyncModels.swift:96`）。
- 收到 `sync_fetch_result` 即收尾（`SyncLibraryPullController.swift:418-437`）；**无删除阶段**（§12b 决策 7）。

**对齐歌词通道**：wire 命名空间 `@lyrics/{歌曲 content_hash}.json`（`SyncAlignedLyrics.swift:37`、`:48`、`:55`），与曲库文件**共用同一路径命名空间与同一套根内校验**；`@lyrics/` 请求只在歌词根内解析，未配置歌词根一律 `not_found`（`SyncLibrarySyncModels.swift:119-146`、`SyncLibraryFetchResponder.swift:167-190`）。

### ⚠️ 与设计文档差异

- `sync_fetch_request.collection` 的「应答方二次集合过滤」语义：设计/代码注释有声明（`SyncLibrarySyncModels.swift:55`），实现未消费 → 记为**待核实**（见 11.4）。
- 设计文档 §6.1 写「同步集合 = 用户显式选择」，但 v1 线上请求的 `collection` **恒为 `.all`**（`SyncLibraryPushController.swift:277-279`、`SyncLibraryPullController.swift:93`），"选择"实际在**发起端本地的 filter 上执行**（`SyncLibraryPullController.swift:139-151`、`SyncLibraryPushController.swift:66-70`）——集合语义尚未通过线上 `collection` 字段传递。
- 设计文档 §6.1 的 manifest 字段清单（相对路径、大小、mtime、content_hash）与实现一致；实现另有 `stableId` 字段（本端引用映射用，跨端无效，`SyncManifest.swift:35`），设计文档未列。

## 12. 推送声明（14）

**帧号**（`SyncFrame.swift:69`）：`libraryPushAnnounce = 14`（Mac → 设备，加密，payload = JSON）。帧值语义：10–13 不动，新增从 14 起（`SyncLibraryPushModels.swift:21`）。

### 12.1 `library_push_announce`（14）· `SyncLibraryPushAnnounce`

| 字段 | 类型 | 可空 | 语义 | 源码 |
| --- | --- | --- | --- | --- |
| `entries` | SyncPushEntry[] | 否 | 一批即将推送的文件声明，**按 `relativePath` 升序** | `SyncLibraryPushModels.swift:111` |

构造时（发送端与接收端共用同一类型）：排序 + **同相对路径去重（first wins）** + 丢弃结构非法条目（`SyncLibraryPushModels.swift:113-123`）；`isEmpty` = 无可接收内容（`SyncLibraryPushModels.swift:126`）。

`SyncPushEntry`（一条声明，`SyncLibraryPushModels.swift:37-103`）：

| 字段 | 类型 | 可空 | 语义 | 源码 |
| --- | --- | --- | --- | --- |
| `relativePath` | string | 否 | 接收端落位路径（相对**接收端曲库根**，POSIX `/`；与 manifest 对账键同一口径） | `SyncLibraryPushModels.swift:39` |
| `transferName` | string | 否 | 本次 `file_meta.name`（**单段**文件名）——接收端据此把收到的传输认领到本条目 | `SyncLibraryPushModels.swift:41` |
| `fileID` | string | 否 | 传输唯一 ID（v1 = `content_hash`；歌词文件 = 歌词所属歌曲的 `content_hash`） | `SyncLibraryPushModels.swift:43`、`:371-379`（发送端构造） |
| `sha256Hex` | string | 否 | 全文件 SHA-256 小写 hex（接收端 `SyncFileReceiver` 会校验） | `SyncLibraryPushModels.swift:45` |
| `size` | Int64 | 否 | 文件字节数 | `SyncLibraryPushModels.swift:47` |

条目结构合法性（`isStructurallyValid`，接收端落盘前校验，不合法一律不落位，`SyncLibraryPushModels.swift:94-102`）：`relativePath` 规范化后与自身相等；`transferName` == 该路径末段且通过单段校验（非空、非 `.`/`..`、长度 ≤ 255、不含 `/` 与 `\`、不以 `.` 开头，`SyncLibraryPushModels.swift:80-85`）；`fileID` 形态合法（非空、≤ 128、不含路径分隔符，`SyncLibraryPushModels.swift:87-92`）；`sha256Hex` 非空。

**为什么单独有声明帧**（而不是把相对路径塞进 `file_meta.name`）：`name` 的既有语义是"文件名（不含路径）"+ 单段校验，改语义会把路径安全责任压到传输层；声明帧把目标相对路径放在**应用层**，用同一套 `normalizeRelativePath` 口径校验（`SyncLibraryPushModels.swift:13-19`）。

### 12.2 推送流程时序

```
Mac（发起方 / SyncLibraryPushController）            设备（被动端 / SyncLibraryPassiveHost）
   |                                                       |
   |-- manifest_request(10) {collection:.all} ------------>|
   |<-- manifest_response(11) {entries} -------------------|
   |  推送方向对账（以本端选择集为准）：                       |
   |    对端缺该路径 / hash 不同 / 任一侧 nil → 推           |
   |    同路径 hash 相同 → 跳过                              |
   |    对端多出来的条目 → 什么都不做（不传播删除）             |
   |  无可推条目 → 不发声明，直接 done                        |
   |-- library_push_announce(14) {entries:[…]} ----------->|  建认领表（传输名/fileID/sha → 目标相对路径）
   |                                                       |  （不回任何应答帧）
   |-- file_meta(4) / file_chunk(5) ---------------------->|  接收 → 认领 → 落位 → 入库
   |<-- file_ack(6) {done=true} ---------------------------|  （每个文件一次停等传输，顺序串行）
   |-- file_meta(4) / file_chunk(5) ---------------------->|  下一个文件 …
   |<-- file_ack(6) {done=true} ---------------------------|
   |  队列空 → done（summary：planned / skipped /           |  声明条目全部进终态 → 批次收尾
   |           completed / failed）                         |
```

**应答方式（关键）**：接收端收到帧 14 **不回任何应答帧**——没有 announce 的 ack/result 帧。送达确认就是**每个文件的 `file_ack` `done=true`**（`SyncLibraryPushController.swift:19-22`、`:452-474`）；发送端以"队列清空"结束本轮（`SyncLibraryPushController.swift:399-449`）。接收端以"本批声明条目全部进终态"结束本轮（`SyncLibraryPassiveHost.swift:426`、`:464`）。

发送侧要点：

- 声明只发一次，且**在第一个 `file_meta` 之前**；随后按声明顺序**串行**走既有停等传输（帧 4/5/6）（`SyncLibraryPushController.swift:336-350`、`:431-435`）。
- 无待推送条目（全部已一致 / 无可发送内容）→ **不发声明**，直接终态（`SyncLibraryPushController.swift:330-334`）。
- 构造声明前已算好每个文件的 SHA-256 与 `size`（`:354-369`）；拿不到可发送实体（路径非法 / 文件不存在 / 不可读）→ 计入本地失败账目，不发该条（`SyncLibraryPushController.swift:296-308`）。
- 声明结构非法被丢弃的条目**如实记账**（不静默）（`SyncLibraryPushController.swift:310-322`）。
- 传输身份：歌曲 = 条目 `content_hash`（缺失回落文件 SHA-256）；歌词 = 所属歌曲的 `content_hash`（`SyncLibraryPushController.swift:371-379`）。
- 对齐歌词随歌推送，wire 路径 `@lyrics/{歌曲 content_hash}.json`，与 §11 同一命名空间；`manual` / `network` 歌词不参与（`SyncLibraryPushModels.swift` 头部 + `SyncLibraryPushController.swift:36-38`）。

接收侧要点：

- 帧 14 解码失败 → **忽略**（不落位任何东西）（`SyncLibraryPassiveHost.swift:253-259`）。
- 收到声明即重建认领表与批次状态；空声明 → 直接收尾（`SyncLibraryPassiveHost.swift:260-279`）。
- **认领键是传输级身份**（`fileID` 或 `sha256` 命中；同身份多条时优先传输名一致者）；身份认不到但**该传输名在剩余条目里唯一**时才按名兜底；否则返回 nil = **不猜、不落位**（`SyncLibraryPushModels.swift:177-223`）——理由：同名不同目录（`A/01 Song.flac` / `B/01 Song.flac`）按名认领会静默错位（`SyncLibraryPushModels.swift:170-176`）。
- **未声明过的传输**（名字/身份不在认领表）不落位、不索引，清临时文件并记账（`SyncLibraryPassiveHost.swift:26-27`、`:52-53`）。
- 传输失败按 `fileID` 归因到声明条目并计入失败（失败也进终态，否则批次永不收尾）（`SyncLibraryPassiveHost.swift:284-313`）。
- **不传播删除**：声明只描述"要送到哪里"，协议里不存在删除指令；落位只有"目标已存在 → 同路径就地替换为新内容"（`SyncLibraryPushModels.swift:28-29`、`SyncLibraryPushModels.swift:256-270` 的 `moveAtomically`）。

### ⚠️ 与设计文档差异

- 本章与设计文档 §6.1 + §12b 决策 6/7 一致（发起方恒为 Mac、不传播删除、无删除指令），**无冲突**。
- 设计文档未描述「推送没有独立结束帧、以逐文件 `file_ack done` 为送达凭据」这一点，本章按实现补齐。
- 设计文档 §6.1 说「同步集合 = 用户显式选择」，v1 推送请求的 `collection` 恒为 `.all`（选择在发送端本地 filter 执行，见 §11 差异小节）。

## 13. 对端内容清单（15/16）

### 13.1 帧与用途

| 帧值 | 名称 | 方向 | 用途 | 源码 |
| --- | --- | --- | --- | --- |
| 15 | `peer_library_request` | 发起方（Mac / 主机）→ 对端 | 请求对端某一类内容清单（歌单 / 曲目，可带歌单筛选与搜索词） | `QQPlayer/Sync/SyncFrame.swift:72` |
| 16 | `peer_library_response` | 对端 → 发起方 | 一页清单条目 + 曲库摘要（摘要恒返回） | `QQPlayer/Sync/SyncFrame.swift:75` |

- 两帧都是 ready 后的业务帧（payload 为 JSON 字节、加密传输），会话层解密后经 `onApplicationFrame` 转发给应用层 handler（`QQPlayer/Sync/SyncFrame.swift:28-31`）。
- 与文件清单（帧 10/11 manifest）的区别：manifest 只有相对路径 + 大小 + 指纹，拿不到对端的**歌单结构与曲目元数据**（标题 / 歌手 / 大小）；本对帧补的正是这个能力，UI 侧「内容面板随同步方向切换数据源」靠它（`QQPlayer/Sync/SyncPeerLibraryModels.swift:8-12`）。
- 端侧实现：被动端应答 `SyncPeerLibraryResponder`（`QQPlayer/Sync/SyncPeerLibraryResponder.swift:57-77`）；发起侧客户端 `SyncPeerLibraryClient`（`QQPlayer/Sync/SyncPeerLibraryClient.swift:92-132`）。

### 13.2 `peer_library_request`(15) 载荷

载荷类型 `SyncPeerLibraryRequestPayload`（`QQPlayer/Sync/SyncPeerLibraryModels.swift:29`）：

| 字段 | 类型 | 语义 | 源码 |
| --- | --- | --- | --- |
| `scope` | string | 请求范围：`"playlists"` / `"tracks"`（枚举 `SyncPeerLibraryScope`，线上仍是 String 保前向兼容）。**非法值 → 对端回空清单 + `total: 0`**（不报错、不断会话） | `SyncPeerLibraryModels.swift:32`；枚举 `SyncPeerLibraryModels.swift:102-107` |
| `playlistID` | string? | 目标歌单标识（**对端 slug**；收藏用 `@favorites`）。仅 `scope == "tracks"` 且在歌单内筛选时给；nil / 空 = 全库 | `SyncPeerLibraryModels.swift:35` |
| `query` | string? | `tracks` 搜索词（对端做 contains 匹配，空 = 不过滤） | `SyncPeerLibraryModels.swift:37` |
| `offset` | int | 分页起点（`>= 0`；负值由**对端**钳到 0） | `SyncPeerLibraryModels.swift:39` |
| `limit` | int | 页大小（`1...500`；越界由**对端**钳制） | `SyncPeerLibraryModels.swift:41` |
| `requestID` | uint64 | 关联请求 / 响应（本端自增；响应原样回显，不匹配的响应一律丢弃） | `SyncPeerLibraryModels.swift:43` |

两端共识常量：

| 常量 | 值 | 语义 | 源码 |
| --- | --- | --- | --- |
| `minLimit` | `1` | 页大小下限 | `SyncPeerLibraryModels.swift:46` |
| `maxLimit` | `500` | 页大小上限（防对端一次拉爆内存 / 帧上限） | `SyncPeerLibraryModels.swift:48` |
| `maxQueryLength` | `128` | 搜索词长度上限（不可信输入，超长截断） | `SyncPeerLibraryModels.swift:50` |

应答侧归一（不可信输入的唯一收口，`SyncPeerLibraryModels.swift:68-98`）：

| 归一属性 | 行为 | 源码 |
| --- | --- | --- |
| `clampedLimit` | `<= 0 → 1`，`> 500 → 500` | `SyncPeerLibraryModels.swift:71-73` |
| `clampedOffset` | 负值 → 0 | `SyncPeerLibraryModels.swift:76-78` |
| `scopeValue` | 未知字符串 → nil（非法 scope） | `SyncPeerLibraryModels.swift:81-83` |
| `normalizedQuery` | 去首尾空白 + 截断到 128；空 → nil（= 不过滤） | `SyncPeerLibraryModels.swift:86-90` |
| `normalizedPlaylistID` | 去空白；空 → nil（= 全库）。**形态非法时仍返回原值**——由成员表查不到自然收成空集，绝不回落「全库」 | `SyncPeerLibraryModels.swift:95-98` |

### 13.3 `peer_library_response`(16) 载荷

载荷类型 `SyncPeerLibraryResponsePayload`（`QQPlayer/Sync/SyncPeerLibraryModels.swift:205`）：

| 字段 | 类型 | 语义 | 源码 |
| --- | --- | --- | --- |
| `requestID` | uint64 | 回显请求的 `requestID` | `SyncPeerLibraryModels.swift:207` |
| `scope` | string | 回显请求的 scope（非法值原样回显，便于请求方定位） | `SyncPeerLibraryModels.swift:209` |
| `total` | int | 该 scope 下（含筛选）**总条数**（不是本页条数） | `SyncPeerLibraryModels.swift:211` |
| `items` | array | 本页条目（联合类型，见下） | `SyncPeerLibraryModels.swift:213` |
| `hasMore` | bool | 后面还有页（`end < items.count` 判定） | `SyncPeerLibraryModels.swift:215` |
| `libraryTrackCount` | int | 对端曲库总曲目数（摘要；**恒返回**，与分页无关） | `SyncPeerLibraryModels.swift:217` |
| `librarySizeBytes` | int64 | 对端曲库总大小（摘要；未知大小按 0 计） | `SyncPeerLibraryModels.swift:219` |
| `truncated` | bool | 对端因装配上限截断（诊断） | `SyncPeerLibraryModels.swift:221` |

条目是**两端同构的联合**（手写 Codable：带 `kind` 判别字段的扁平 JSON，而非 Swift 合成 enum 的嵌套形态，跨语言 / 跨版本可读，加新 case 不破坏旧端解码）：

```json
{"kind": "playlist", "playlist": {...}}
{"kind": "track",    "track":    {...}}
```

| 条目类型 | 字段 | 类型 | 语义 | 源码 |
| --- | --- | --- | --- | --- |
| 歌单 `SyncPeerPlaylistItem` | `id` | string | 对端歌单标识（slug；收藏用 `@favorites`） | `SyncPeerLibraryModels.swift:114` |
| 歌单 | `name` | string | 展示名 | `SyncPeerLibraryModels.swift:116` |
| 歌单 | `trackCount` | int | 曲目数（自洽纪律见 §13.6） | `SyncPeerLibraryModels.swift:118` |
| 曲目 `SyncPeerTrackItem` | `relativePath` | string | 跨端对账键（相对**对端曲库根**的 POSIX 路径） | `SyncPeerLibraryModels.swift:124` |
| 曲目 | `title` | string? | 标题（nil = 未知） | `SyncPeerLibraryModels.swift:126` |
| 曲目 | `artistName` | string? | 歌手展示名（nil = 未知） | `SyncPeerLibraryModels.swift:128` |
| 曲目 | `sizeBytes` | int64 | 文件字节数（对端 `file_size` 口径；未知 = 0） | `SyncPeerLibraryModels.swift:130` |
| 曲目 | `contentHash` | string? | 内容指纹（nil = 尚未指纹，与 manifest 同口径） | `SyncPeerLibraryModels.swift:132` |

- 判别字段与编码：`kind` / `playlist` / `track` 三个键（`SyncPeerLibraryModels.swift:156-160`），`Kind` 取值 `playlist` / `track`（`:162-165`），编码分支见 `:177-187`。
- 页内序工具：`playlistItems` / `trackItems` 按页内序取对应子集（`SyncPeerLibraryModels.swift:243-251`）。
- **编码确定性**：`SyncPeerLibraryCodec.encode` 用 `.sortedKeys`（键排序）——同一份值编出的字节逐字节一致，便于跨端比对与测试断言（`SyncPeerLibraryModels.swift:256-263`）。

### 13.4 分页语义（游标 = offset）

- **没有 opaque token / 游标串**：分页游标就是 `offset`，单位是**当前 scope + 当前筛选条件下**的条目序号（不是全库序号）。
- 应答侧取页：`start = min(clampedOffset, items.count)`、`end = min(start + clampedLimit, items.count)`，空切片返回 `items: []`（`QQPlayer/Sync/SyncPeerLibraryCatalog.swift:151-168`，关键行 `:155-157`）。
- `total` = **筛选后**的总条数（`SyncPeerLibraryCatalog.swift:162`），`hasMore` = `end < items.count`（`:163`）。
- 页大小钳制在**应答侧**（请求来自对端 = 不可信输入）；请求侧只按共识取值（`SyncPeerLibraryModels.swift:20-21` + `:71-78`）。
- 请求方自动翻页：`fetchPlaylists()` 以 `maxLimit`(500) 为页大小循环，`offset += response.items.count`，停止条件 = `!hasMore || items.isEmpty || pages >= maxAutoPages`（`SyncPeerLibraryClient.swift:92-110`，`maxAutoPages = 20` 见 `:44`）。
- 摘要不依赖分页：`libraryTrackCount` / `librarySizeBytes` **每次响应都带**，空页 / 非法 scope 也有值，UI 顶部「N 首 · 约 X GB」不必翻页（`SyncPeerLibraryModels.swift:202-204`；`SyncPeerLibraryCatalog.swift:137-148`）。
- 摘要取数客户端：`fetchLibrarySummary()` 借一页 `limit: 1` 的 tracks 请求取值（`SyncPeerLibraryClient.swift:112-116`）。

#### 13.4.1 顺序与去重（构造期归一）

| 对象 | 归一规则 | 源码 |
| --- | --- | --- |
| 歌单清单 | 按 `(name, id)` 升序 + 按 `id` 去重（同 id 保留排序后最靠前者） | `SyncPeerLibraryCatalog.swift:170-181` |
| 曲目清单 | 按 `(relativePath, 其余字段破平)` 升序 + 按 `relativePath` 去重；同路径重复时用其余字段**确定性**破平（`sorted` 不保证稳定） | `SyncPeerLibraryCatalog.swift:183-206` |
| 曲目清单上限 | 超过 `maxEntries = 50_000` 按已排序前缀截断（确定性），`truncated` 透传到响应 | `SyncPeerLibraryCatalog.swift:39-40`、`:193-196` |

#### 13.4.2 无效输入与失败语义

| 情形 | 行为 | 源码 |
| --- | --- | --- |
| 非法 / 未知 `scope` | 空清单 + `total: 0`，**摘要照常返回**（断会话代价远大于空页） | `SyncPeerLibraryCatalog.swift:66-70`、`:137-148` |
| `offset` / `limit` 越界 | 应答侧钳制（见上） | `SyncPeerLibraryModels.swift:71-78` |
| `playlistID` 未知 / 形态非法 | **空集**（绝不回落全库——那是把整个曲库甩给一个非法请求） | `SyncPeerLibraryCatalog.swift:110-118` |
| `playlists` 范围下的 `playlistID` | 无意义，忽略（按契约只有 `tracks` 用） | `SyncPeerLibraryCatalog.swift:73-77` |
| `query` 超长 | 截断到 128 | `SyncPeerLibraryModels.swift:86-90` |
| 请求载荷解码失败 | 不回答，仅记账（对端按超时处理） | `SyncPeerLibraryResponder.swift:60-66` |
| 响应载荷解码失败 / 无在途请求 | 客户端丢弃（仅诊断），不影响其它在途请求 | `SyncPeerLibraryClient.swift:236-251` |
| 对端在超时内不答 | 抛 `.timeout`（默认 10s），UI 显示失败态，绝不永久等待；另有 `.sessionNotReady` / `.sessionClosed` / `.cancelled` / `.sendFailed` | `SyncPeerLibraryClient.swift:30-41`、`:66`、`:215-221`、`:231-234` |

- **应答端全程不抛**：解码 / 取事实 / 编码任一失败都只记账，不影响会话状态机（`SyncPeerLibraryResponder.swift:9-14`、`:70-77`）。
- 每次请求前检查 `session.isReady`（未就绪 → `.sessionNotReady`，不静默挂起）；`requestID` 由发起侧自增分配（`SyncPeerLibraryClient.swift:164-192`）。

### 13.5 歌单标识命名空间

标识空间在一个请求里混用三类：**保留标识**（`@` 前缀）、**真实 slug**、以及仅本端 UI 存在的合成项。

| 标识 | 含义 | 发帧 15 时的 `playlistID` | 来源 |
| --- | --- | --- | --- |
| `@library` | 全部曲库（**仅本端 UI 合成项**，不出现在对端清单里） | `nil`（= 既有「不过滤」语义） | 设计文档 §12c；`QQPlayer/Sync/SyncBrowseSource.swift:72` |
| `@favorites` | 收藏（已有保留标识） | `@favorites` | `QQPlayer/Sync/SyncCollectionSelection.swift:64` |
| `<slug>` | 真实歌单（既有） | `<slug>` | 设计文档 §12c；`SyncPeerLibraryCatalog.swift:117` |
| `@smart:recentAdded` | 最近添加（自动歌单） | `@smart:recentAdded` | `QQPlayer/Sync/SyncBrowseSource.swift:54`、`:61` |
| `@smart:recentPlayed` | 最近播放（自动歌单） | `@smart:recentPlayed` | `QQPlayer/Sync/SyncBrowseSource.swift:56`、`:61` |
| `@smart:topPlayed` | 常听排行（自动歌单） | `@smart:topPlayed` | `QQPlayer/Sync/SyncBrowseSource.swift:58`、`:61` |

- 保留前缀与构造：`smartPrefix = "@smart:"`（`SyncBrowseSource.swift:74`），wire id = `"@smart:" + rawValue`（`:60-61`）；解析 `parse(id:)` 只认已知种类，`@smart:` 后不是已知种类或未知 `@` 前缀 → **解析失败 → 不产生任何来源**（`SyncBrowseSource.swift:121-131`）。
- **形态校验**（`SyncCollectionSelection.isValidPlaylistID`，`QQPlayer/Sync/SyncCollectionSelection.swift:71-77`）：非空、长度 ≤ `maxPlaylistIDLength = 128`（`:67`）、非 `.` / `..`、不含 `/` 与 `\`、不含控制字符。
- **非法 / 未知标识 = 空集**（不回全库）；对端实现点 `SyncPeerLibraryCatalog.orderedMemberPaths` 先做形态校验、再查成员表（`SyncPeerLibraryCatalog.swift:114-118`）。
- 向后兼容（设计文档 §12c）：老对端不认识 `@smart:*` → 清单里没有这些条目 → 发起端仅表现为「来源下拉里没有自动歌单分组」，不报错、不影响既有路径；新发起端 → 老对端把未知 `@smart:*` 按「未知歌单 = 空集」处理。

### 13.6 来源内曲目顺序规则

**规则：来源内列表顺序 = 来源自身顺序**（设计文档 §12c.1，2026-09-13 统一；两端一致）。

| 来源 | 顺序 | 源码 |
| --- | --- | --- |
| 全部曲库 | `relativePath` 升序（既有契约，未变） | `SyncPeerLibraryCatalog.swift:88-89`、`:187-206` |
| 收藏 / 真实歌单 | 成员表顺序（收藏顺序 / 歌单成员序） | `SyncPeerLibraryCatalog.swift:90-92`、`:95-103` |
| 最近添加 | `modification_date` 降序（最新在前） | 设计文档 §12c.1 |
| 最近播放 | 最近播放时间倒序（同曲去重） | 设计文档 §12c.1 |
| 常听排行 | 播放次数降序（并列按累计时长） | 设计文档 §12c.1 |

- 对端侧：`trackPathsByPlaylist` 存**有序**成员表（顺序是语义的一部分，去重由装配方保证——同路径重复取首个），`QQPlayer/Sync/SyncPeerLibraryCatalog.swift:31-35`。
- tracks 范围带 `playlistID` 收窄时按该来源序返回（`matchedTracks`，`SyncPeerLibraryCatalog.swift:93-108`：先按成员顺序建 rank 索引再排序，`:96-102`）；**未带 `playlistID` 时仍是 `relativePath` 升序**（既有契约不动，`:89`）。
- 来源内 `query` 只做过滤、**不重排**（`SyncPeerLibraryCatalog.swift:104-107`）。
- 自动歌单成员口径与播放列表页同一数据层（`SmartPlaylistStore` 的 `recentAddedTracks` / `recentPlayedTracks` / `topPlayedTracks`），**条数上限同为 `SmartPlaylistStore.limit` = 50**（设计文档 §12c、§12c.1）。
- 自动歌单条目装配是纯函数且确定性：顺序 = `SyncBrowseSmartKind.allCases`（固定序，与同步页展示序一致）；成员**保持来源自身顺序**并与曲目清单求交（不在清单里的成员不计入）；名称为空回落标识本身（`SyncPeerLibraryCatalog.swift:212-244`，`:229-241`）。

### 13.7 `trackCount` 自洽纪律

- **对端清单里每个歌单条目的 `trackCount` 恒等于「按该 id 筛 tracks 的条数」**（成员集先与曲目清单求交，否则顶部摘要的数字会与筛选结果对不上）。`@favorites` 同款纪律，`@smart:*` 由 `smartPlaylistEntries` 收口（`QQPlayer/Sync/SyncPeerLibraryCatalog.swift:216-222`、`:232`、`:238`）；设计文档 §12c「数字自洽纪律」+ §12c.1 末条。
- 因此 `trackCount` **不是**「该歌单在全库的成员总数」：成员不在对端曲目清单里（例如未同步到本机）就不计入。
- 注意摘要字段 `libraryTrackCount`（响应顶层）与条目 `trackCount` 是两码事：前者 = 对端曲库总曲目数（`SyncPeerLibraryCatalog.swift:57`、`:164-165`）。

> ⚠️ 与设计文档差异
>
> - 本章按设计文档 §12c 表格记为「`@library` 仅本端 UI 合成项」；当前**对端清单里不会出现 `@library`**（`SyncPeerLibraryCatalog` 只装配真实歌单 / 收藏 / `@smart:*`），与设计文档一致。
> - 设计文档 §12c 列了 3 个自动歌单来源，年代（`@smart:decades`）本期不做（解析为 nil = 空集）——本章按现状只列 3 个。
> - 待核实：`@smart:*` 的名称来源（`names[SyncBrowseSmartKind]`）在对端装配层的具体取值未在本章展开（属装配事实，非线上契约）。

---

## 14. 播放数据变更日志（8/9）

### 14.1 帧与用途

| 帧值 | 名称 | 方向 | 用途 | 源码 |
| --- | --- | --- | --- | --- |
| 8 | `change_log_pull` | 数据消费方 → 数据所有者 | 带「我已经消费到哪」的游标，拉取增量 | `QQPlayer/Sync/SyncFrame.swift:61` |
| 9 | `change_log_push` | 双向 | 一批 outbox 行 + 本批末行 id。**既是帧 8 的应答，也是发起方主动推增量用的同一帧** | `QQPlayer/Sync/SyncFrame.swift:62` |

- 会话层处理器 `SyncChangeLogPeer`：收 8 → 从本端 outbox 取增量回推 9；收 9 → 解码 → 本地化 → LWW 对账 → 应用落库（`QQPlayer/Sync/SyncChangeLogPeer.swift:8-32`、`:160-169`）。
- **主动推送与 pull 应答共用帧 9**，两种路径逐字同口径（`SyncChangeLogPeer.swift:107-123`、`:188-204`）。
- 一次「独立同步数据」动作 = 推本端增量 + 拉对端增量，与文件传输完全解耦（`QQPlayer/Sync/SyncDataSyncCoordinator.swift:5-14`）。

### 14.2 `change_log_pull`(8) 载荷

载荷类型 `SyncChangeLogPullRequest`（`QQPlayer/Sync/SyncDataSyncModels.swift:133`）：

| 字段 | 类型 | 语义 | 源码 |
| --- | --- | --- | --- |
| `cursor` | int64 | 请求方已消费到的**本端（应答方）** outbox 最大 id；`0` = 全量拉 | `SyncDataSyncModels.swift:135`（注释 `:134`） |

- 应答 = 帧 9（服务端取 `id > cursor` 的批）；载荷无其它字段，**没有分页参数**——一轮一应答，超 500 行由应答方按后续游标继续（`SyncDataSyncModels.swift:131-132`；`SyncChangeLogPeer.swift:18-20`）。

### 14.3 `change_log_push`(9) 载荷

载荷类型 `SyncChangeLogPushPayload`（`QQPlayer/Sync/SyncDataSyncModels.swift:140`）：

| 字段 | 类型 | 语义 | 源码 |
| --- | --- | --- | --- |
| `entries` | array | 线上 outbox 行（见下） | `SyncDataSyncModels.swift:142` |
| `lastOutboxID` | int64 | 本批**末尾的本端 outbox id** = 对端应记下的游标 | `SyncDataSyncModels.swift:144` |

行元素 `SyncChangeLogWireEntry`（`QQPlayer/Sync/SyncDataSyncModels.swift:150`）：

| 字段 | 类型 | 语义 | 源码 |
| --- | --- | --- | --- |
| `id` | int64 | 发送侧 outbox 自增 id（对端用它在同 ms 多行时做确定性排序；`0` = 无 id） | `SyncDataSyncModels.swift:151` |
| `entity` | string | 被同步实体（`SyncChangeEntity.rawValue`） | `SyncDataSyncModels.swift:152` |
| `rowKey` | string | 行键（**发送端本地形态**；接收端按 `contentHash` 本地化改写） | `SyncDataSyncModels.swift:153` |
| `op` | string | `upsert` / `delete`（**delete 不上线**，见 §14.9） | `SyncDataSyncModels.swift:154` |
| `updatedAtMs` | int64 | 变更时刻（毫秒 since 1970）= LWW 判据 | `SyncDataSyncModels.swift:155` |
| `contentHash` | string? | 跨端歌曲引用键（nil = 不引用歌曲 / 老端 / 指纹缺失） | `SyncDataSyncModels.swift:156` |
| `payloadJSON` | string? | 行快照 JSON（delete 行为 nil） | `SyncDataSyncModels.swift:157` |

本地存储行 `SyncChangeLogRow`（表 `sync_outbox`）与之同构，列名 `row_key` / `updated_at` / `payload_json`（`QQPlayer/Sync/SyncDataSyncModels.swift:51-87`）。

### 14.4 实体与操作

| `entity` 值 | 含义 | 参与 v1 同步 | 源码 |
| --- | --- | --- | --- |
| `favorite` | 收藏 | ✅ | `QQPlayer/Sync/SyncDataSyncModels.swift:29`、`:38` |
| `play_history` | 播放历史（自动歌单数据源） | ✅ | `SyncDataSyncModels.swift:30`、`:38` |
| `playlist` | 歌单结构（slug / 标题 / 封面等） | ✅ | `SyncDataSyncModels.swift:31`、`:38` |
| `playlist_item` | 歌单项（歌单 ↔ 曲目 + position） | ✅ | `SyncDataSyncModels.swift:32`、`:38` |
| `playback_position` | 播放位置上下文 | ❌（`v1Synced` 不含；本地载体是 UserDefaults，非 DB 行） | `SyncDataSyncModels.swift:33`、`:38`；`QQPlayer/Sync/SyncPlaybackCarryPeer.swift:35-36` |

| `op` 值 | 含义 | 源码 |
| --- | --- | --- |
| `upsert` | 新增 / 覆盖（落快照） | `QQPlayer/Sync/SyncDataSyncModels.swift:43` |
| `delete` | 删除（**本地记录但不上线**） | `SyncDataSyncModels.swift:44` |

设置白名单同步 v1 不做（代码里留有 TODO），`v1Synced` 就是权威清单（`SyncDataSyncModels.swift:35-38`）。

### 14.5 `row_key` 形态（对账键第二段）

| 实体 | `row_key` 形态 | 源码 |
| --- | --- | --- |
| `favorite` | `track_stable_id`（本端形态） | `QQPlayer/Sync/SyncChangeLogApplier.swift:15` |
| `play_history` | `"{trackStableId}\|{playedAt}"`（复合；从**最后一个** `\|` 切，左段可含 `\|`） | `SyncChangeLogApplier.swift:16-18`、`:184-193` |
| `playlist` | `slug` | `SyncChangeLogApplier.swift:21` |
| `playlist_item` | `"{playlistSlug}\|{trackStableId}"`（两侧都是字符串） | `SyncChangeLogApplier.swift:24-25`、`:195-203` |
| `playback_position` | `track_stable_id` | `SyncChangeLogMapping.swift:251-253` |

- 行内歌曲引用提取的**单一事实源**：`SyncTrackReference`（`QQPlayer/Sync/SyncChangeLogMapping.swift:100-123`）——`favorite` / `playback_position` 取 `rowKey`，`play_history` / `playlist_item` 先解析复合键、失败回落读 payload 快照，`playlist` **不引用歌曲**（`:102-104`）。

### 14.6 游标语义（两种方向，两张表，绝不可复用）

| 表 | 键列 | 含义 | 谁写 / 谁读 | 源码 |
| --- | --- | --- | --- | --- |
| `sync_cursor` | `peer_id`, `last_outbox_id` | **本端已消费的对端 outbox 位置**（拉取游标） | `SyncChangeLogPeer.handlePush` 写、`sendPull` 读 | `SyncDataSyncModels.swift:93-103`、`:109-111` |
| `sync_push_cursor` | `peer_id`, `last_outbox_id` | **本端已推给对端的本端 outbox 位置**（推送游标） | `SyncChangeLogPeer.sendIncrement` 读写 | `SyncDataSyncModels.swift:117-127` |

- ⚠️ 两表键同为 `peer_id` 却指向两条完全不同的变更流：**合表 = 推 / 拉互相把对方的位置当自己的起点**（重复推或漏推）（`SyncDataSyncModels.swift:109-116`）。
- `pull(cursor)` 语义：应答方取**本端** outbox 中 `id > cursor` 的批（`QQPlayer/Sync/SyncChangeLogStore.swift:136-149`）；无记录 = 0（全量）（`:87-94`）。
- **`lastOutboxID` 口径（S1 审计修订，2026-09-12）**：= **本批实际发出去的最后一行 id**（与取批**同一读事务**内取值），不再 = outbox 全局末尾——后者在分页下会把本批没发出的行永久越过（`SyncChangeLogStore.swift:151-179`，关键行 `:178`；说明 `:163-167`）。空批 = 不推进（返回传入 cursor）。
- 批内被删除策略过滤掉的 delete 行**算在本批内**：它们永不上线，允许被越过（`SyncChangeLogStore.swift:166-167`；`SyncChangeLogPeer.swift:199-200`）。
- 批大小：`page(after:limit:)` 默认 `limit = 500`（`SyncChangeLogStore.swift:137`、`:168`）；主动推送 `sendIncrement(maxPerBatch: 500)`，`limit <= 0` 夹到 1（`SyncChangeLogPeer.swift:125-127`）。
- **推送必须全部批次成功才推进 `pushCursor`**：任一批抛错 → 整体抛错且游标不动（重推幂等由对端 LWW 保证）（`SyncChangeLogPeer.swift:151-153`）；**空增量不发帧、不动游标、返回 0**（`:152`）。
- 被推方收到帧 9 后推进自己的 `sync_cursor` 到 `payload.lastOutboxID`（挂起行已持久化，游标可安全推进：数据不丢）（`SyncChangeLogPeer.swift:266-267`）。
- 拉取是**一次性请求-应答**，无跨帧状态（`SyncChangeLogPeer.swift:31-32`、`:276-281`）。

### 14.7 LWW 规则

- **LWW 键 = `(entity, row_key)`**；同键冲突以 `updated_at`（毫秒）**大者胜**（`QQPlayer/Sync/SyncLWWReconcile.swift:6-8`）。
- 每键的**代表行** = 组内 `updated_at` 最大、平局取 `id` 最大（= 最新落库）（`SyncLWWReconcile.swift:41-47`、`:54-81`）。
- 同键比较结果（`SyncLWWReconcile.swift:90-105`）：

| 情形 | 裁定 | 源码 |
| --- | --- | --- |
| 远端 `updated_at` > 本地 | 应用远端 | `SyncLWWReconcile.swift:93-94` |
| 远端 `updated_at` == 本地，远端是 delete、本地是 upsert | **delete 胜**（显式删除意图优先） | `SyncLWWReconcile.swift:96-99` |
| 其余平局 | **本端胜**（不应用远端，避免乒乓）；delete vs delete 不应用 | `SyncLWWReconcile.swift:99-104`、`:19-21` |
| 远端独有的键 | 直接应用 | `SyncLWWReconcile.swift:86-89` |

- 函数只返回「应应用的远端行」，按 `(updatedAtMs, id)` 升序输出（调用方逐条应用即幂等收敛）（`SyncLWWReconcile.swift:29-32`、`:107`）；本端胜出的行无需动作（本端是事实源，后续推送让对端收敛）（`:9-10`）。
- **v1 时钟统一用 `outbox.updated_at`**：`favorite` / `play_history` / `playlist_item` 业务表无 `updated_at` 列，混用两套时钟会让平局规则复杂化（`SyncLWWReconcile.swift:12-17`）。
- 对账前，本地侧按 `(entity, row_key)` 取本端最新行作代表（批量查询，键集合 = 远端批本地化后的键集合；S4 审计修掉 N+1）（`SyncChangeLogPeer.swift:245-262`；`SyncChangeLogStore.swift:223-256`）。
- 应用：`SyncChangeLogApplier.apply` 逐行独立事务，单行失败不影响其余行；返回成功应用行数（`QQPlayer/Sync/SyncChangeLogApplier.swift:51-61`）。各实体应用语义见该文件 `:14-31`（`playlist_item` 依赖 `playlist` 先落库，本地没这个 slug 则跳过，`:153-180`）。

### 14.8 `content_hash` 引用映射

- **发送侧**：outbox 行 → wire entry 时，按行内歌曲引用（`row_key` / payload 的 `track_stable_id`）查 `track` 表取 `content_hash` 填入 `wire.contentHash`；该行不引用歌曲 / 引用歌不在本端 / 指纹为空 → `nil`。wire 的 `row_key` 与 `payload` **仍是发送端本地 stableId**（v1 线上格式与 M4-1 一致，老 peer 可平滑互通）（`QQPlayer/Sync/SyncChangeLogMapping.swift:15-19`、`:160-190`）。
- **接收侧**：`contentHash` → 本地 `stableId`（查 `track WHERE content_hash = ? ORDER BY id LIMIT 1`，同 hash 多行取最早入库，保证两端确定性）（`SyncChangeLogMapping.swift:58-74`），命中则把 `row_key` 与 payload 内歌曲引用**改写成本地 stableId** 再进 LWW 对账（不先本地化就对不上键 → 各记一条、永不收敛）（`:20-24`、`:194-209`、`:229-258`）。
- **降级**：`contentHash` 为 nil（老 peer 或该行无歌曲引用）→ 不做映射，按原样透传应用，保证与老 peer 互通（`SyncChangeLogMapping.swift:25-26`、`:200-204`）。
- **本地缺歌**：映射不到本地 stableId → **挂起**（表 `sync_pending_change`，挂起键 = `(entity, content_hash, remote_row_key)`，保留远端原始 `row_key` 供重放），歌到位后重放，**数据不丢**（`SyncChangeLogMapping.swift:134-135`；`QQPlayer/Sync/SyncChangeLogPendingStore.swift:31-55`、`:66-80`）。
- 改写是对每个实体分别做的（`favorite` / `play_history` / `playlist_item` / `playback_position` 四支；`playlist` 无歌曲键不改）（`SyncChangeLogMapping.swift:235-257`）。

### 14.9 仅同步两端共有歌 · 跟歌走 · 不传播删除

**决策 8（仅两端共有歌 + 跟歌走）** 的线上表现是一个**计划器**：

- 一次「携带」的输入 = 本轮刚传输完的歌曲相对路径集合 + 本端曲库事实；产出 = 要随歌带走的播放数据条目（对账键 = `entity + row_key`；身份键 = `content_hash`）（`QQPlayer/Sync/SyncPlaybackCarryPlan.swift:15-17`）。
- 三条硬规则（唯一实现点）（`SyncPlaybackCarryPlan.swift:18-25`）：
  1. **只覆盖这次传输的歌**——不传的路径一律不带（不做全库播放数据对账）；
  2. **只带两端都有的歌**——对端在传输完成后没有该 `content_hash`（未配对）→ 跳过并记账，不伪造身份键；
  3. **删除不上线**——delete 行一律不进携带批，且同一键在本批末尾是 delete 时其更早的 upsert 也不带（复用删除策略单一事实源）。
- 配对判据：`peerContentHashes` = 对端本轮 manifest 的 `content_hash` ∪ 本轮成功传输歌曲的**本地指纹**（只看 manifest 会把「刚同步过去的歌」全部误判成未配对）（`SyncPlaybackCarryPlan.swift:103-131`，`:109-111` 说明）。
- 跳过明细一律记账，不静默丢：`lyricsPathsIgnored` / `skippedUnknownPath` / `skippedUnfingerprinted` / `skippedNotPaired` / `skippedNoPlaybackData`（`SyncPlaybackCarryPlan.swift:181-191`）。
- **推送方向**：计划 → 发帧 9，`lastOutboxID` = 批内最大 outbox id（S3 审计，与 pull 应答同口径）；**空批不发帧、不动对端游标**（`QQPlayer/Sync/SyncPlaybackCarryPeer.swift:163-195`、`:176`、`:185-193`）。
- **拉取方向**：先算「这批歌里两端共有」的范围，再发帧 8；应答帧 9 由既有 `SyncChangeLogPeer` 按同一套本地化 / LWW / 落库路径处理（`SyncPlaybackCarryPeer.swift:199-216`）。
- ⚠️ **已知边界（如实记录）**：
  - 帧 8/9 **没有歌维度字段**，且 §12b 修订不允许改帧语义 → 「只带这次传输的歌」在**发送侧**强制（推送方向由计划器收口）；拉取方向沿用既有**游标增量**语义（对端 outbox 中 > 本端游标的行），按 `content_hash` 本地化，本地缺歌挂起不丢（`SyncPlaybackCarryPeer.swift:23-26`）。
  - 推送批次是歌维度子集，帧 9 的 `lastOutboxID` 只有「本批实际末行 id」一种口径 → 批内末行可能**小于**对端已记下的位置（早先的批推得更靠后）→ **游标会回退**；本端没有「已推给该 peer 的位置」的反向记录，无法做单调保护。v1 该游标是惰性的（移动端纯被动、永不主动 pull）；若 v2 引入移动端主动 pull，必须把 carry 与游标语义分开（`SyncPlaybackCarryPeer.swift:26-34`、`:180-184`）。
  - `playback_position` 不参与携带（不在 `v1Synced`）；歌单结构（`playlist` 行）非歌维度，走选择集同步（`SyncPlaybackCarryPeer.swift:35-36`）。

**决策 7（不传播删除）** 的判定集中在一个纯逻辑入口 `SyncChangeLogDeletionPolicy`（`QQPlayer/Sync/SyncChangeLogDeletionPolicy.swift:5-11`）：

| 规则 | 行为 | 源码 |
| --- | --- | --- |
| `deleteOperation` | 线上删除 op 常量 = `"delete"`（与 `SyncChangeOp.delete.rawValue` 对齐，由契约测试兜底） | `SyncChangeLogDeletionPolicy.swift:35` |
| `isTransmittable(op:)` | **delete 不上线**；未知 op 不误伤（只有 delete 被拦） | `SyncChangeLogDeletionPolicy.swift:44-46` |
| `transmittableIndexes(rows:)` | ① 自身是 delete 的行不上线；② 同一 `(entity, rowKey)` 在**本批最后一行是 delete** 时，其更早的 upsert 也不上线（否则会在对端复活一个本端已删除的状态，而 delete 永不上线 → 无法纠正） | `SyncChangeLogDeletionPolicy.swift:48-71` |
| `shouldIgnore(op:)` | 接收侧 **delete 一律忽略**；拦截必须在 `localize` **之前**（否则会被判成「本地缺歌」挂起，永远等不到歌到位） | `SyncChangeLogDeletionPolicy.swift:78-82`；`SyncChangeLogPeer.swift:229-236` |

- 五个消费点：发送侧逐行过滤 + 发送侧批次抑制 + 接收侧拦截 + 应用层兜底 + 挂起重放防御（`SyncChangeLogDeletionPolicy.swift:13-18`）。应用层兜底：`applyOne` 入口直接丢弃 delete 行、绝不删本地业务行（`QQPlayer/Sync/SyncChangeLogApplier.swift:63-69`）。
- 本地业务行与本地 outbox **照常记录 delete**（本地事务完整、变更留痕），且与业务行**同一 write 事务**原子提交（`QQPlayer/Sync/SyncChangeLogStore.swift:10-13`、`:34-50`）。

> ⚠️ 与设计文档差异
>
> - 设计文档 §6.2 写「冲突：v1 简单 LWW + 变更留痕」，未写平局细则；源码里平局规则是**delete 压 upsert、其余本端胜**（`SyncLWWReconcile.swift:18-21`），本章以源码为准，设计文档无需改（属 §6.2 未展开的实现细节）。
> - 设计文档 §6.2 把「播放位置上下文」列入同步范围，但 `SyncChangeEntity.v1Synced` 实际**不含** `playback_position`（本地载体是 UserDefaults，v1 不落库）（`SyncDataSyncModels.swift:38`；`SyncChangeLogApplier.swift:28-31`）——**本章按源码记为「v1 不参与」**，与设计文档的「范围」表述存在口径差。
> - `SyncPlaybackCarryPeer` 记的「游标可能回退、无单调保护」是已知边界（`SyncPlaybackCarryPeer.swift:26-34`），设计文档 §12b 未提；v2 若引入移动端主动 pull 需先解决。
> - 待核实：`sendIncrement` 的 `onIncrementSent` 计数口径 = 「本端 outbox 增量行数（含被过滤的 delete）」，**不等于** wire 条目数（`SyncChangeLogPeer.swift:122-123`）——若后续按此计数做 UI 展示需要换算。

---

## 15. 对齐歌词（随歌通道）

### 15.1 类型标记：`aligned` / `manual` / `network`

歌词的「类型」不是模型字段，而是**存储命名空间（目录）**——由所在目录唯一确定（`QQPlayer/Services/AlignedLyricsStore.swift:10-13`、`:16-21`）：

| 标记 | 含义 | 本端目录 | 参与同步 | 源码 |
| --- | --- | --- | --- | --- |
| `aligned` | 对齐产物（桌面版 AI 对齐 / 跟唱对齐） | `Documents/lyrics-aligned/` | ✅ **唯一参与** | `AlignedLyricsStore.swift:37`、`:46`；`:53` |
| `manual` | 用户手动指定（歌词搜索页选择，`LyricsManager` 所有） | `Documents/lyrics-manual/` | ❌ 默认不同步 | `AlignedLyricsStore.swift:39`、`:47` |
| `network` | 在线源缓存（lrclib / 网易云，`LyricsSearch` 所有） | `Documents/lyrics-cache/tracks/` | ❌ 两端各自下载 | `AlignedLyricsStore.swift:41`、`:48` |

- 判定收敛在 `LyricsStoreKind.synchronizesWithLibrary`（**只有 `aligned` 为 true**）；同步侧要判「哪些歌词同步」只经 `synchronizedKinds`，不写字面量（`AlignedLyricsStore.swift:52-57`）。
- 文件形态：一歌一文件、键 = 本端 `stableId`、内容 = 裸 `Lyrics` JSON（与 `manual` 同构，同一解码器可读）（`AlignedLyricsStore.swift:8-9`、`:22-25`）。
- 为什么不给 `Lyrics` 模型加 `kind` 字段：`manual` / `network` 的现有 JSON 必须逐字节语义不变，且这两类文件本来就不需要自描述（类型由目录确定）（`AlignedLyricsStore.swift:16-21`）。

### 15.2 线上命名空间与键

**wire 路径命名空间：`@lyrics/{歌曲 content_hash}.json`**（`QQPlayer/Sync/SyncAlignedLyrics.swift:17`、`:34-39`）。

| 常量 / 函数 | 值 / 行为 | 源码 |
| --- | --- | --- |
| `prefix` | `"@lyrics/"`（含结尾 `/`） | `SyncAlignedLyrics.swift:37` |
| `fileExtension` | `"json"` | `SyncAlignedLyrics.swift:39` |
| `isLyricsPath(_:)` | 先规范化再判前缀（`./@lyrics/...` 也算） | `SyncAlignedLyrics.swift:41-45` |
| `wirePath(songContentHash:)` | 歌曲 `content_hash` → `@lyrics/{hash}.json`；hash 非法 = nil | `SyncAlignedLyrics.swift:47-51` |
| `songContentHash(fromWirePath:)` | wire 路径 → 歌曲 `content_hash`；只接受**单层**文件名（`@lyrics/a/b.json` / `@lyrics/../x.json` 一律 nil） | `SyncAlignedLyrics.swift:53-64` |
| `fileName(songContentHash:)` | 歌曲 `content_hash` → 本地库文件名 `{hash}.json` | `SyncAlignedLyrics.swift:66-70` |
| `isValidContentHash(_:)` | 非空、长度 ≤ 128、非 `.` / `..`、无 `/` 与 `\`、字符集限字母 / 数字 / `-` / `_` / `.`（**收到的哈希来自对端，按不可信输入处理，绝不拿它拼路径**） | `SyncAlignedLyrics.swift:72-78` |

**为什么用歌曲 `content_hash` 而不是本端 `stableId` 作对账键**：`stableId` 是绝对路径哈希，跨端必不相同——用它会让两端互相以为对方缺失（一边反复拉、一边被当成远端已删而清掉）；用内容指纹则两端天然同名（内容相同 = 同一首歌）（`SyncAlignedLyrics.swift:11-16`）。
**歌词文件自身的字节哈希** 只用于**内容比对**（放 `ManifestEntry.contentHash`）——对齐产物被重新生成时靠它触发重新拉取（`SyncAlignedLyrics.swift:14-15`、`:110-115`）。
选**前缀命名空间**（而非显式多根）的理由：线上仍是「一个 `relativePath` 对账键」，Reconciler / 拉取请求列表语义零改动；`@` 前缀不可能与真实曲库文件重名；安全属性靠**根表 + 逐根包含性 / 软链校验**，不靠命名空间本身（`SyncAlignedLyrics.swift:18-25`）。

### 15.3 随歌同步通道（没有歌词专用帧）

歌词走**既有文件同步通道**，不新增帧：

| 环节 | 载体 | 源码 |
| --- | --- | --- |
| 生成清单 | `SyncAlignedLyricsManifest.entries(...)` 把歌词库条目变成 `ManifestEntry`（路径 = `@lyrics/{歌曲 hash}.json`，`contentHash` = 歌词文件自身 SHA-256，`stableId` = 本端歌曲 stableId＝单端引用信息，不参与对账） | `SyncAlignedLyrics.swift:107-138` |
| 清单传输 | 帧 10/11 `manifest_request` / `manifest_response` | `QQPlayer/Sync/SyncManifest.swift:54-79` |
| 点名拉取 | 帧 12/13 `sync_fetch_request` / `sync_fetch_result`（请求列表里的 `@lyrics/...` 也是普通相对路径） | `QQPlayer/Sync/SyncLibrarySyncModels.swift:53-64`、`:86-102` |
| 字节搬运 | 帧 4/5/6 停等传输 | `QQPlayer/Sync/SyncFileTransferModels.swift:25-56` |
| 推送方向 | 帧 14 `library_push_announce` 的条目里直接带 `@lyrics/...` 目标路径；`fileID` = **歌词所属歌曲的** `content_hash` | `QQPlayer/Sync/SyncLibraryPushModels.swift:37-47`、`:42`；`QQPlayer/Sync/SyncLibraryPushController.swift:382-390` |
| 根表映射 | wire 路径归属根：`@lyrics/...` → 歌词根，其余 → 曲库根；未配置歌词根时 `@lyrics/` 请求一律 `not_found` | `SyncLibrarySyncModels.swift:117-146`、`:157-167` |

- **歌词没有独立的同步触发**：它依附歌曲——歌同步了 aligned 歌词跟着到，歌删除则歌词清理（设计文档 §6.3）。
- 生成时的两条纪律（`SyncAlignedLyrics.swift:108-115`）：
  - 歌曲指纹缺失 → 该条**跳过**（没有跨端身份键就没法对账，宁可不同步也不写一条无法映射的路径）；
  - 同 wire 路径多条（同内容重复歌曲）→ 按 `stableId` 升序取首个（确定性）；
  - 输出按 `relativePath` 升序；可再经集合过滤（Host 应答 manifest 用）（`:137`、`:140-148`）。

### 15.4 键与映射规则（接收侧安装）

| 步骤 | 行为 | 源码 |
| --- | --- | --- |
| 取歌曲哈希 | wire 路径 → `content_hash` | `QQPlayer/Sync/SyncLyricsReceiver.swift:140` |
| 映射本地歌 | `content_hash` → 本端 `stableId`（生产实现 = `SyncContentHashResolver`，与播放数据同一张 `track` 表、同一查询，不新写 SQL） | `SyncLyricsReceiver.swift:141`；`QQPlayer/Sync/SyncChangeLogMapping.swift:78-95` |
| 落库 | 交给 `AlignedLyricsStore.install(receivedFileAt:forStableId:)`（**不落进曲库根、不写孤儿文件**） | `SyncLyricsReceiver.swift:144` |
| 本端还没入库 | 先**暂存**，收尾时再试一次映射；仍解析不出 → **丢弃**（歌词是依附歌曲的内容，不留孤儿），下次同步从对端 manifest 重新拉到（**自愈**），不引入第二套挂起队列 | `SyncLyricsReceiver.swift:11-14`、`:73-94`、`:96-117` |
| 收尾之后再到的歌词 | 不暂存，直接「映射得到就装、映射不到就丢」 | `SyncLyricsReceiver.swift:15`、`:80-92` |
| 一次接收的结论 | `installed` / `pending` / `discarded` / `failed`（四态，调用方只记账不重实现） | `SyncLyricsReceiver.swift:26-36` |

- **映射关闭（歌词同步关闭）**：`SyncLyricsContentMapping.unresolved` 两端都解析不出结果 → manifest 不含歌词、收到也不落库（`SyncAlignedLyrics.swift:98-102`）。
- **不传播删除**：本类型**不存在删除本端歌词的路径**（`SyncLyricsReceiver.swift:16`）——收到落盘失败只清临时文件，不动已有歌词。
- 控制器与被动端**共用同一实现**（`SyncLyricsReceiver`），避免第二套歌词落库路径（`SyncLyricsReceiver.swift:5-6`；接线点 `QQPlayer/Sync/SyncLibraryPassiveHost.swift:20`、`:150-161`、`:350`；主动拉取侧 `QQPlayer/Sync/SyncLibraryPullController.swift:442`）。

> ⚠️ 与设计文档差异
>
> - 设计文档 §6.3 说存储「延续现状 `Documents/lyrics-manual/{stableId}.json` 形态」；源码实际把 aligned **分到独立目录** `Documents/lyrics-aligned/`（`AlignedLyricsStore.swift:22-25`、`:46`）——**形态**（一歌一文件 + `{stableId}.json` + 裸 Lyrics JSON）一致，**目录**不同。本章按源码记录；设计文档该句建议后续措辞修正（不属本任务范围）。
> - 设计文档 §12b 开放问题 1「手动指定歌词（manual）后续是否需要纳入同步」——现状仍为**不纳入**（`AlignedLyricsStore.swift:53`），且同步侧判定已收口，将来只需改 `synchronizesWithLibrary` 一处（但帧/路径命名空间需另行设计，`@lyrics/` 只承载 aligned 语义）。

---

## 16. web 主机能力矩阵与实现缺口清单

web 版（FastAPI + Vue，本仓库）以 **Host + 同步发起方** 角色接入（对应 Swift 端的 Mac 侧）。本章按「内容同步」两条流程列出需要实现的帧与控制器 / 服务，并对现有 web 代码给出能力矩阵。

### 16.1 两条流程的帧序列

**流程 A：推歌到 iPhone（web → 设备）**——发起方决定推哪些歌，先声明再串行送字节。

| 步 | 帧 | 方向 | 说明 |
| --- | --- | --- | --- |
| 1 | 10 `manifest_request` → 11 `manifest_response` | web → 设备 | 取设备清单做对账（判断哪些要补） |
| 2 | 14 `library_push_announce` | web → 设备 | 声明「接下来送哪些文件、各自落到哪个相对路径」（含 `@lyrics/...` 歌词条目） |
| 3 | 4 `file_meta` / 5 `file_chunk` → 6 `file_ack` | web → 设备 | 停等分块传输（web 是发送端：发 meta/chunk，收 ack 推进） |
| 4 | 9 `change_log_push` | web → 设备 | 播放数据「跟歌走」携带（本批歌的播放数据；无条目则不发帧） |

**流程 B：从手机拉取（设备 → web）**——发起方点名要文件，设备推过来。

| 步 | 帧 | 方向 | 说明 |
| --- | --- | --- | --- |
| 1 | 15 `peer_library_request` → 16 `peer_library_response` | web → 设备 | 取设备**内容清单**（歌单 / 曲目 + 摘要），供 UI 展示「从 iPhone 下载」的列表 |
| 2 | 10 → 11 | web → 设备 | 取设备 manifest（对账「本端是否已有」+ 拿 `content_hash`） |
| 3 | 12 `sync_fetch_request` → 13 `sync_fetch_result` | web → 设备 | 点名请求路径（含 `@lyrics/...`） |
| 4 | 4 / 5 / 6 | 设备 → web | web 是接收端：收 `file_meta` / `file_chunk`，回 `file_ack`；落 `.part` → SHA-256 校验 → 落位 |
| 5 | 8 `change_log_pull` → 9 `change_log_push` | web → 设备 | 拉对端播放数据增量（应答帧 9 由 web 消费并接 LWW） |

- 移动端是**纯被动端**（不主动发起），两条流程都由 Host 侧编排（设计文档 §6.1、§12b 决策 6；`QQPlayer/Sync/SyncLibraryPassiveHost.swift:5-8`）。
- 帧 3（ping）/ 7（bye）不属内容同步；帧 0/1/2 属握手配对（web 已实现，见 `docs/lan-sync-web-host-plan.md` M1-M2）。

### 16.2 能力矩阵（web 现状）

| 能力 | 帧 / 组件 | web 现状 | 证据（本仓库） | Swift 参考实现 |
| --- | --- | --- | --- | --- |
| 帧编解码（0-16 全表、16 MiB 上限、流式拼帧） | 全部 | ✅ 已实现 | `backend/app/lansync/frame.py`（枚举 `:62-78`） | `QQPlayer/Sync/SyncFrame.swift` |
| 业务帧**收发通道**（ready 白名单 + 应用层回调） | 4-16 | ✅ 已实现（只做通道） | `backend/app/lansync/session.py:67-81`、`:611-632` | `SyncPeerSession+Frames.swift:280-316` |
| 业务帧**语义实现**（任一帧的解码 / 业务处理） | 4-16 | ❌ 缺失（回调钩子默认 `None`） | `backend/app/lansync/service.py:158-174`、`:402-409` | 各帧 handler（见 §16.3） |
| 内容清单请求 / 应答 | 15 / 16 | ❌ 缺失 | 全仓 grep 无实现（仅 `frame.py` / `session.py` 出现帧名） | `SyncPeerLibraryModels.swift`、`SyncPeerLibraryCatalog.swift`、`SyncPeerLibraryResponder.swift`、`SyncPeerLibraryClient.swift` |
| manifest 请求 / 应答 | 10 / 11 | ❌ 缺失 | 同上 | `SyncManifest.swift`、`SyncManifestGenerator.swift`、`SyncManifestPeer.swift` |
| 按路径拉取请求 / 结果 | 12 / 13 | ❌ 缺失 | 同上 | `SyncLibrarySyncModels.swift`、`SyncLibraryFetchResponder.swift` |
| 推送声明 | 14 | ❌ 缺失 | 同上 | `SyncLibraryPushModels.swift`、`SyncLibraryPassiveHost.swift` |
| 文件分块传输（停等 / 断点 / SHA-256） | 4 / 5 / 6 | ❌ 缺失 | 同上 | `SyncFileTransferModels.swift`、`SyncFileSender.swift`、`SyncFileReceiver.swift` |
| 播放数据变更日志 + LWW + 游标 | 8 / 9 | ❌ 缺失 | 同上 | `SyncDataSyncModels.swift`、`SyncChangeLogStore.swift`、`SyncChangeLogPeer.swift`、`SyncLWWReconcile.swift`、`SyncChangeLogApplier.swift` |
| `content_hash` 双向映射 + 缺歌挂起重放 | （8/9 载荷内） | ❌ 缺失 | 同上 | `SyncChangeLogMapping.swift`、`SyncChangeLogPendingStore.swift` |
| 删除不传播策略 | （8/9 载荷内） | ❌ 缺失 | 同上 | `SyncChangeLogDeletionPolicy.swift` |
| 播放数据「跟歌走」 | （8/9 载荷内） | ❌ 缺失 | 同上 | `SyncPlaybackCarryPlan.swift`、`SyncPlaybackCarryPeer.swift` |
| aligned 歌词命名空间与随歌安装 | （10/11 + 12/13 内） | ❌ 缺失 | 同上 | `SyncAlignedLyrics.swift`、`SyncLyricsReceiver.swift`、`Services/AlignedLyricsStore.swift` |
| 推送 / 拉取编排（一次同步的动作与状态机） | — | ❌ 缺失 | 同上 | `SyncLibraryPushController.swift`、`SyncLibraryPullController.swift`、`SyncCollectionSyncCoordinator.swift`、`SyncDataSyncCoordinator.swift` |
| 会话事件分发链（多 handler 挂接、先己后彼、释放不牵连他人） | — | ❌ 缺失（回调是单值字段） | `backend/app/lansync/session.py:336-348`（单个 `on_application_frame`） | `SyncPeerSession+Frames.swift:599-660`（`SyncSessionAttachment`） |
| 内容选择与 `@smart:*` 命名空间 | （15 载荷内） | ❌ 缺失 | 同上 | `SyncCollectionSelection.swift`、`SyncBrowseSource.swift` |
| 曲库事实（路径 → `stableId` / `content_hash`）与 outbox 写点 | — | ⚠️ 待核实（web 侧有曲库 / DB 模块，本次未取证其是否具备 `content_hash` 与 outbox） | `backend/app/db.py`、`backend/app/routers/library.py`（未在本次取证范围） | `SyncLocalLibraryProvider.swift`、`SyncPlaybackCarryPeer.swift:49-120`、`SyncChangeLogStore.swift:31-83` |

**矩阵口径说明**：✅ = 本仓库代码里可定位到实现；❌ = 全仓 grep 只有帧名出现、无载荷模型与处理器；⚠️ = 未取证（不臆断）。「Swift 参考实现」列给出对位文件，供实现时逐字段对照。

### 16.3 实现缺口清单（每条指向 Swift 参考实现）

按依赖顺序排列；括号内是该文件**是干什么的**。

1. **分发链 / handler 挂接** → `SyncPeerSession+Frames.swift`（会话层帧分发：ready 后按帧号路由，`SyncSessionAttachment` 让多个 handler 链式挂接且互不牵连）、`SyncManifestPeer.swift`（帧 10/11 的分发钩子）。
2. **帧载荷模型（逐字段复刻）** → `SyncManifest.swift`（10/11 载荷）、`SyncLibrarySyncModels.swift`（12/13 载荷 + 路径解析）、`SyncLibraryPushModels.swift`（14 载荷 + 认领表 / 落位）、`SyncPeerLibraryModels.swift`（15/16 载荷）、`SyncDataSyncModels.swift`（8/9 载荷 + outbox 行 + 两张游标表）、`SyncFileTransferModels.swift`（4/5/6 载荷 + 线上错误码 + 256KB 块）。
3. **对端内容清单** → `SyncPeerLibraryResponder.swift`（收 15 → 读本端事实 → 回 16，全程不抛）、`SyncPeerLibraryCatalog.swift`（排序 / 去重 / 分页 / 筛选 / 钳制的纯逻辑）、`SyncPeerLibraryClient.swift`（发起侧：requestID 配对 + 10s 超时 + 自动翻页上限 20 页）。**这是流程 B 第 1 步的前置，也是流程 A UI 侧「对端有什么」的数据源。**
4. **manifest 生成与对账** → `SyncManifestGenerator.swift`（相对路径规范化 + 条目生成）、`SyncManifestPeer.swift`（帧 10/11 收发）、`SyncManifestReconciler.swift`（两端清单对账 → toFetch / toPush）。
5. **文件字节搬运** → `SyncFileSender.swift`（发送端：整文件 SHA-256 → meta → 停等分块，256KB）、`SyncFileReceiver.swift`（接收端：`.part` 流式落盘 + 断点对齐 + 校验 + 幂等）。
6. **按路径拉取应答（设备侧能力，web 作为被动端时也要）** → `SyncLibraryFetchResponder.swift`（收 12 → **逐条根内包含性 + 软链校验**（越界拒读）→ 串行用 FileSender 推 → 回 13）、`SyncLocalLibraryProvider.swift`（被动侧能力装配：manifest 应答 + 拉取应答）。
7. **推送声明与接收认领** → `SyncLibraryPushModels.swift`（`SyncPushClaimTable` 传输级身份 → 目标相对路径；`SyncLibraryLanding` 原子落位、失败保留本端原文件）、`SyncLibraryPassiveHost.swift`（收 14 + 收文件 + 认领落位 + 歌词安装的被动端装配）。
8. **发起端两条编排** → `SyncLibraryPushController.swift`（推：拿对端 manifest → 计划 toPush → 发 14 → 串行推送 → 汇总）、`SyncLibraryPullController.swift`（拉：拿对端 manifest → 计划 toFetch → 发 12 → 收文件 + 校验 + 落位 → 收 13 收尾）、`SyncCollectionSyncCoordinator.swift`（选中集合的单向补齐编排，含「对端多出来的什么都不做」）、`SyncDataSyncCoordinator.swift`（独立「同步数据」：一次 = 推本端增量 + 拉对端增量）。
9. **播放数据链路** → `SyncChangeLogStore.swift`（outbox 追加 / 两张游标 / 分页取批，事务纪律）、`SyncChangeLogPeer.swift`（帧 8/9 处理：应答 pull、主动推增量、收批）、`SyncLWWReconcile.swift`（LWW 纯逻辑）、`SyncChangeLogApplier.swift`（胜出行落本地业务表）。
10. **跨端引用映射与竞态兜底** → `SyncChangeLogMapping.swift`（发送侧填 `contentHash`、接收侧本地化改写）、`SyncChangeLogPendingStore.swift`（缺歌挂起 + 歌到位重放）。
11. **删除不传播（单一事实源）** → `SyncChangeLogDeletionPolicy.swift`（发送侧逐行过滤 + 批次抑制、接收侧一律忽略；五个消费点必须都走它）。
12. **播放数据跟歌走** → `SyncPlaybackCarryPlan.swift`（计划器：只带本次传输的、只带两端共有的、delete 不带）、`SyncPlaybackCarryPeer.swift`（生产接线：帧 9 推 / 帧 8 拉 + 本端曲库事实）。
13. **对齐歌词** → `SyncAlignedLyrics.swift`（`@lyrics/{歌曲 content_hash}.json` 命名空间 + manifest 条目 + content_hash 映射）、`SyncLyricsReceiver.swift`（接收安装编排：暂存 / 收尾重试 / 丢弃，无删除路径）、`Services/AlignedLyricsStore.swift`（歌词库唯一入口：目录即类型标记，仅 `aligned` 参与同步）。
14. **内容选择 / `@smart:*`** → `SyncCollectionSelection.swift`（歌单标识形态校验 + 选择集展开）、`SyncBrowseSource.swift`（`@library` / `@favorites` / `<slug>` / `@smart:*` 解析与排序，零 IO）。
15. **顶层服务装配** → `SyncLibraryPassiveHost.swift`（一个已配对会话的被动端能力全套接线）、`SyncPlaybackCarryPeer.swift:128-157`（携带驱动装配，含「必须强持有 handler」的坑）。

### 16.4 本章假设与待核实

- **假设 1**：web Host 在 S2 拓扑里同时扮演「服务端」与「发起方（Mac 角色）」，因此两条流程的**发起动作**都在 web 侧；设备（iOS）保持纯被动（设计文档 §6.1 + §12b 决策 6）。
- **假设 2**：§16.1 的两条流程按 Swift 现有实现（`SyncLibraryPushController` / `SyncLibraryPullController`）的帧序复刻；Swift 端未实现的时序细节（例如推送批与播放数据携带的先后）以各自文件为准。
- **待核实 1**：web 侧曲库 / DB 是否已有 `content_hash` 列与 outbox（`sync_outbox` / `sync_cursor` / `sync_push_cursor` / `sync_pending_change`）——本次只取证到 `frame.py` / `session.py` / `service.py`，`backend/app/db.py`、`routers/library.py` 未读；矩阵中该行标 ⚠️ 而非 ✅/❌。
- **待核实 2**：web 侧会话回调目前是**单值字段**（`session.py:336-348`），多 handler 需要自己实现一个分发链（Swift 用 `SyncSessionAttachment`）；是否需要保持「释放不牵连其它 handler」的语义由实现方定。
- **待核实 3**：`docs/lan-sync-web-host-plan.md` M6/M7 里程碑与本清单的映射（该文档 M6 = 内容同步 10/11 + 15/16 + 12/13 + 14 + 4/5/6，M7 = 8/9 + LWW + content_hash + 对齐歌词），本章未改动该文档。

> ⚠️ 与设计文档差异
>
> - 设计文档 §1 说「未来 web/NAS 主机按同契约另行实现（FastAPI 侧），客户端不感知」——本章确认：**客户端确实不感知**（帧值 / 载荷 / 语义全部复用 v1），但 web 侧当前**只有帧与通道层**，业务语义（内容同步 / 播放数据）尚未实现（见 §16.2 矩阵）。
> - 设计文档 §5「原语集（逻辑层，与传输解耦）」把 `manifestFetch` / `filePull(fileID, offset)` / `filePush` 写成抽象原语；线上实际帧号与命名是 10/11、12/13、14+4/5/6（`SyncFrame.swift:52-75`），本章按线上实现记录。

---

## 开放问题（待用户拍板）

1. **web 主机的能力范围**：仅配对+传输（M1/M2），还是含文件推送（M3）与播放数据（M4）？——影响工作量数量级。
2. **手输配对路径**：Swift 端手输路径是否也要求 QR nonce？若无 nonce 来源，web 端手输配对是否需要额外放行（安全权衡）。
3. **web 版运行位置**：与 macOS Swift 版同机并存（两个 Host 都在广播）还是独立部署（NAS 等）——影响端口/发现与 UI 措辞。
