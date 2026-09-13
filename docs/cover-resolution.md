# 封面解析契约（Cover Resolution Contract）

> 2026-08-27 立。背景：封面"从哪来"的决策散落 5 处独立实现（桌面 Cover.vue 直出 /
> 播放页手写远程 / 列表 useCoverURL / 锁屏 resolveCoverForMetadata / iOS 原生
> CoverDecision），行为不一致，导致"有时播放没封面"。本契约收敛为**单一事实源**。
>
> **2026-09-13 更新（iOS 壳退役）**：iOS 伴侣壳（`mobile/ios`，注入 `window.qqplayerIosBridge`）
> 已退役，其封面链路（原生锁屏渲染 `MetadataManager`、`resolveCoverForMetadata`、内嵌 APIC
> 兑底 `getEmbeddedCover` / `cachedCoverURL` / `cacheCover`）随壳下线。现契约只覆盖主机端
> （浏览器 / Tauri 壳）与 `useCoverURL` 单一入口。

## 原则：决策上收，执行下沉

- **决策（选哪个源、兑底顺序、何时重试）只能有一份，在 JS 侧**（有测试、可迭代）。
- 任何新封面消费点必须接入唯一入口，禁止手写 path→URL 映射。

## 唯一入口

| 场景 | 入口 | 解析顺序 |
|---|---|---|
| UI 封面（列表/播放页/迷你条/桌面） | `useCoverURL`（composables/useCoverURL.ts） | 远程 `/api/cover?path=…`（同 path 幂等）；`@error` → markCoverError（标记失败、回退占位图） |
| 锁屏 / Now Playing artwork | `mediaSession.ts`（自有 URL 构造） | 流媒体歌用 `coverUrl` 网络图；本地歌 `absoluteUrl("/api/cover?path=…")` |

### useCoverURL 契约

- `resolveCover(path, {download})`：同 path 幂等（已解析跳过）；主机端直接解析远程 URL
  （`download` 仅为保持调用方签名，主机端无下载语义）。
- `markCoverError(path)`：远程加载失败 → 标记失败（占位图）；本地/内嵌兑底已随 iOS 壳删除。
- **恢复在线重试**：订阅 `onOfflineChange`，offline→online 时清空
  `urlMap` + `coverErrors`，对"当前歌曲 + 当前可见行"重新 resolveCover——
  断网期间解析为空/失败标记的封面必须在恢复后自动补上，不允许等到切歌。
- 浏览器与壳内行为一致：均走远程直出（`syncEnabled()` 不再是解析分支判据）。

## 消费点清单（契约测试据此扫描）

| # | 消费点 | 接入状态 |
|---|---|---|
| 1 | `MobileList.vue`（移动列表行） | ✅ useCoverURL |
| 2 | `MobileSmartList.vue`（移动智能视图） | ✅ useCoverURL |
| 3 | `MiniPlayerBar.vue`（迷你播放条） | ✅ useCoverURL |
| 4 | `MobilePlayer.vue`（播放页大封面 + 毛玻璃背景） | ✅ useCoverURL |
| 5 | `Cover.vue`（桌面封面组件） | ✅ useCoverURL |
| 6 | `mediaSession.ts`（锁屏/Now Playing artwork） | ✅ 自有 URL 构造（白名单） |
| 7 | ~~iOS `MetadataManager`（原生锁屏渲染）~~ | ⚰️ 随 iOS 壳退役删除（2026-09-13） |
| 8 | ~~`resolveCoverForMetadata`（锁屏封面决策）~~ | ⚰️ 随 iOS 壳退役删除（2026-09-13） |

歌词面板（useLyric/LyricPanel）不显示封面，不在清单内。

## 防裸调契约测试（coverResolutionContract.test.ts）

静态扫描 + 行为断言，防止回归：

1. **禁止裸调**：扫描 `frontend/src/components/**` 与 `frontend/src/composables/*`，
   不允许出现 `resolveServerUrl("/api/cover` 或手写 `path→/api/cover` 映射
   （白名单：`useCoverURL.ts`（唯一入口自身）、`mediaSession.ts`（锁屏/媒体键元数据域））。
2. **消费点接入断言**：MobilePlayer.vue / Cover.vue 必须 import 并调用 useCoverURL。
3. **行为断言**：useCoverURL 恢复在线（触发 `onOfflineChange(false)`）后，断网时解析为空
   的 path 会被重新 resolve（断言 resolveCover 再次调用）。

## 验收标准

- 断网（含主机不可达）播放：列表/播放页/迷你条/锁屏显示占位或远程失败态，
  **恢复在线后各消费点封面自动补齐**（不等切歌）。
- 前端 `pnpm test` 全绿（`coverResolutionContract` / `coverOffline` 等契约测试在内）。
