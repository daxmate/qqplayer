# 主机可达性契约（Host Reachability Contract）

> 2026-08-27 立。背景：APP 启动即触发主机动作雨（syncNow 动画 / 60s 指令轮询 /
> selfTest / reportAssets），无局域网时全部挂着等 10s 超时、显示"fetch 失败"；
> 且状态条"已连接 xxx"依据历史配对记录而非实时可达性，误导用户。
> 本契约：**启动先探测，不可达即全局离线，所有主机动作短路；配对记录保留，恢复自动补。**

## 原则

1. iOS 是独立 APP：不连局域网不影响所有本地功能（播放/封面/歌词/列表）。
2. **可达性 = 实时探测结果，不是历史配对记录**。配对记录只代表"曾经配过"。
3. 主机不可达 = 全局离线（复用现有 offline 机制）；恢复在线自动补同步，不打扰用户。
4. 所有主机动作（同步/轮询/自检/上报/写队列回放）在离线时**不发请求、不转动画、不报错**。

## 状态模型（apiClient.js）

```
hostReachable: "unknown" | "online" | "offline"   // 模块级状态
offline（现有）: 设备断网 || hostOffline  || 请求失败降级   // isOffline() 已合并
```

- `probeHost()`：GET `/api/ping`，快速超时 **2500ms**。
  成功 → hostReachable=online，offline=false；失败/超时 → hostReachable=offline，setOffline(true)。
  返回 boolean。幂等（并发探测合并）。
- **启动探测**：App onMounted 最先 await probeHost()（与 UI 渲染并行，不阻塞首帧）。
- **恢复探测**：仅 offline 时启用——`online` 事件（navigator.onLine 变 true）+ 30s 定时器
  （轻量，失败静默）。探测成功 → hostReachable=online + setOffline(false) + 触发恢复回调
  （补一次 syncNow + pollCommands + 封面/列表刷新由各模块 onOfflineChange 自理）。
- **请求短路**：api() 的 deviceOffline 短路（现有 1.5 节）放宽为 `isOffline()`——
  hostOffline 时 GET 有 cache 读缓存（含过期）、无 cache 快速失败（不发请求）；
  POST/PUT/DELETE 快速失败。**绝不等待系统 TCP 超时。**

注意：offline 是"结果状态"，hostReachable 是"探测状态"。请求失败降级（现有 catch 分支
setOffline(true)）保留；但离线时请求已短路，不会进入该分支。恢复探测成功后 setOffline(false)，
后续请求自然恢复网络路径。**不能出现"离线后永远离线"**：恢复探测必须无条件定期执行。

## 启动动作 gate（App.vue onMounted）

探测完成后：

| 动作 | 在线 | 离线 |
|---|---|---|
| initSync → syncNow | ✅ | ❌ 跳过（保留事件订阅，不主动拉 manifest） |
| ensureCommandPolling | ✅ | ❌ 不启动轮询（恢复在线后再启动） |
| reportAssets / pollCommands | ✅ | ❌ |
| runStartupSelfTest | ✅ | ❌ |
| flushPendingOps（dirty 队列） | ✅ | ❌（保留队列，恢复后自动回放） |
| loadSongs / loadFavorites / loadPlaylists / loadQueueOrder / backfillMetaFromFile | ✅ | ✅ 走缓存/本地文件（本地优先原则：列表必须能看） |
| restoreLastPlayed | ✅ | ✅（本地恢复播放） |

**恢复在线**（onOfflineChange(false)）：补一次 syncNow + pollCommands + 启动轮询 +
flushPendingOps（dirty 队列回放）。列表/封面刷新由各模块自行监听。

## sync.ts 短路

- `syncNow()`：开头 `if (isOffline()) return {ok:false, message:"主机离线"}`，
  **不设 syncing=true**（杜绝"动画转来转去"）。
- `ensureCommandPolling()`：`isOffline()` 时不启动 interval。
- `pollCommands()` / `reportAssets()`：开头 `isOffline()` 短路返回。

## 状态条（iOS 原生）

- 前端新增桥命令 `hostStatus`：`{online: bool}`（offline 变化时发送；
  启动探测完成时发一次）。
- iOS `WebShellView` 处理 `hostStatus` → 通知 RootView。
- `RootView` 状态条三态：
  - server != nil 且 online → 绿点「已连接 xxx」（现状）
  - server != nil 且 offline → 灰点「离线（主机不可达）」（**新增**，替代误导性的"已连接"）
  - server == nil → 灰点「未连接桌面端」（现状）
- 桥契约 `docs/ios-bridge-contract.json` 增加 `hostStatus` 命令（Web→Native），
  双端契约测试（前端 iosBridgeContract.test.js + iOS BridgeContractTests.swift）同步。

## 后端

- 新增 `GET /api/ping` → `{ok: true}`（极轻量，无鉴权依赖——探测时 token 可能无效/过期，
  不因 401 误判主机离线；但带 token 时也接受）。后端测试覆盖。

## 验收标准

- 无局域网启动：状态条显示「离线」灰点（不是"已连接"）；无同步动画、无 fetch 失败提示；
  列表/已下载歌/封面/歌词全部可用。
- 恢复局域网（主机回来）：30s 内自动转「已连接」+ 自动补一次同步，无需重启。
- 有局域网正常启动：行为与现状一致（探测成功 → 正常同步）。
- 前端 `pnpm test` 全绿；后端 pytest 全绿；iOS xcodebuild test 全绿。
