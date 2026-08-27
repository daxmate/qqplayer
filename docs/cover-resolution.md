# 封面解析契约（Cover Resolution Contract）

> 2026-08-27 立。背景：封面"从哪来"的决策散落 5 处独立实现（桌面 Cover.vue 直出 /
> 播放页手写远程 / 列表 useCoverURL / 锁屏 resolveCoverForMetadata / iOS 原生
> CoverDecision），行为不一致，导致"有时播放没封面"。本契约收敛为**单一事实源**。

## 原则：决策上收，执行下沉

- **决策（选哪个源、兑底顺序、何时重试）只能有一份，在 JS 侧**（有测试、可迭代）。
- **原生（iOS）只执行**：解码 data URL、缩放 ≤1024、写 MPNowPlayingInfoCenter、
  读本地音频内嵌 APIC（getEmbeddedCover / loadEmbeddedArtwork）。不做"封面从哪来"的决策。
- 任何新封面消费点必须接入唯一入口，禁止手写 path→URL 映射。

## 唯一入口

| 场景 | 入口 | 兑底顺序 |
|---|---|---|
| UI 封面（列表/播放页/迷你条/桌面） | `useCoverURL`（composables/useCoverURL.js） | 本地 covers 缓存 → 内嵌 APIC（断网）→ 远程 `/api/cover`；`@error` → markCoverError（缓存 → 内嵌） |
| 锁屏/Now Playing 元数据 | `resolveCoverForMetadata`（mediaSession.ts） | 本地缓存 → data URL（转 data: 失败兑底原始 URL）→ **内嵌 APIC（断网兑底）** → 远程 data URL |
| 原生锁屏渲染 | `MetadataManager`（iOS） | 只解码/兑底/异步增强，不决策数据源 |

### useCoverURL 契约

- `resolveCover(path, {download})`：同 path 幂等（已解析跳过）；本地缓存 → 内嵌（断网）→ 远程。
- `markCoverError(path)`：远程加载失败 → 兑底本地缓存 → 内嵌；都无保持错误标记。
- **恢复在线重试（本契约新增）**：订阅 `onOfflineChange`，offline→online 时清空
  `urlMap` + `coverErrors`，对"当前歌曲 + 当前可见行"重新 resolveCover——
  断网期间解析为空/失败标记的封面必须在恢复后自动补上，不允许等到切歌。
- 桌面/非壳环境：同步远程直出（`syncEnabled()===false` 路径），行为与现状一致。

### resolveCoverForMetadata 契约

- 本地 covers 缓存命中 → `coverToDataURL`（失败兑底原始本地 URL）。
- 未命中且断网（`isOffline()`）→ `assetForSong` + `getEmbeddedCover` 内嵌兑底
  （本契约新增；覆盖"断网 + 封面未缓存 + 歌已下载"的锁屏空白场景）。
- 未命中且在线 → `cacheCover`（后台缓存）+ 远程 → `coverToDataURL`（失败兑底远程 URL）。
- 任一步 await 后 `isCurrent` 校验：已切歌返回 null，不覆盖新歌元数据。

### iOS MetadataManager 契约

- `loadEmbeddedArtwork` 预读完成时（本契约新增）：若 `MPNowPlayingInfoCenter`
  当前无 artwork（无旧封面兑底、异步拉取未成功）→ 用内嵌图回补锁屏。
  消除"setMetadata 先到、内嵌后读完"的时序竞争。
- `CoverDecision` 保留为"执行策略"（data: 同步 / 内嵌兑底+异步 / 纯异步），
  但**数据源顺序由前端下发保证**（前端给 data URL 或本地 URL，原生不自行决定走远程）。

## 消费点清单（契约测试据此扫描）

| # | 消费点 | 接入状态 |
|---|---|---|
| 1 | `MobileList.vue`（移动列表行） | ✅ useCoverURL |
| 2 | `MobileSmartList.vue`（移动智能视图） | ✅ useCoverURL |
| 3 | `MiniPlayerBar.vue`（迷你播放条） | ✅ useCoverURL |
| 4 | `MobilePlayer.vue`（播放页大封面 + 毛玻璃背景） | ❌ 手写远程 → **改 useCoverURL** |
| 5 | `Cover.vue`（桌面封面组件） | ❌ 组件内直出 → **改 useCoverURL**（非壳环境行为零变化） |
| 6 | `mediaSession.ts` resolveCoverForMetadata（锁屏） | ⚠️ 补内嵌兑底 |
| 7 | iOS `MetadataManager`（锁屏渲染） | ⚠️ 补内嵌回补 |

歌词面板（useLyric/LyricPanel）不显示封面，不在清单内。

## 防裸调契约测试（coverResolutionContract.test.js）

静态扫描 + 行为断言，防止回归：

1. **禁止裸调**：扫描 `frontend/src/components/**` 与 `frontend/src/composables/*`，
   不允许出现 `resolveServerUrl("/api/cover` 或手写 `path→/api/cover` 映射
   （白名单：useCoverURL.js、nativeAudioBridge.ts 的 resolveCoverURL 本身）。
2. **消费点接入断言**：MobilePlayer.vue / Cover.vue 必须 import 并调用 useCoverURL。
3. **行为断言**：useCoverURL 恢复在线（触发 onOfflineChange(false)）后，断网时解析为空
   的 path 会被重新 resolve（mock sync 层断言 resolveCover 再次调用）。
4. 桌面环境（非壳）：resolveCover 仍同步远程直出（行为零变化回归）。

## 验收标准

- 断网（含主机不可达）播放已下载歌：列表/播放页/迷你条/锁屏全部有封面（缓存或内嵌）。
- 恢复在线后：所有消费点封面自动补齐（不等切歌）。
- 桌面端行为零变化（Cover.test.js 等既有测试全绿）。
- 前端 `pnpm test` 全绿；iOS `xcodebuild test` 全绿（改 Swift 时）。
