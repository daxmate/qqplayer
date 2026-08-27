# iOS 壳双端桥协议（Web ↔ Native）

QQPlayer iOS 伴侣壳（SwiftUI + WKWebView）与前端 Web 应用之间的通信契约。

> **权威定义以 [`docs/ios-bridge-contract.json`](./ios-bridge-contract.json) 为准**，本文件为可读说明。
> 两者不一致时以契约 JSON 为准。双端契约测试自动校验一致性：
> 前端 `frontend/src/__tests__/iosBridgeContract.test.js` + 壳 `mobile/ios/Tests/BridgeContractTests.swift`
> （新增/删除任何 cmd 或 event 而不同步契约 JSON，测试即红）。

维护者：Pass 3 架构层（2026-08-26）。实现参考：`mobile/ios/Sources/WebShellView.swift` / `AVPlayerBridge.swift` / `RemoteCommandManager.swift` / `MetadataManager.swift` 与前端 `playerCore.js` / `nativeAudioBridge.js` / `sync.js` / `apiClient.js` / `useShellBridge.js`。

## 通道

- **Web → Native**：`window.qqplayerIosBridge.postMessage({cmd, ...payload})`（documentStart 注入；file:// 与 http:// 均可用）。WKScriptMessageHandler `userContentController(_:didReceive:)`（handler name=`qqplayerIos`）收到后按 cmd 分域分发。
- **Native → Web**：`pushToWeb(event:payload:)` → `evaluateJavaScript` 调 **`window.qqplayerOnNativeEvent(name, payload)`**（由前端 `nativeAudioBridge.js` 的 `installNativeEventSink` 独占安装；播放事件另有 `playerBridge.onEvent` → 同一通道）。`nativeReady` 前的原生事件进入队列，就绪后冲刷。

## webCmd（Web → Native 命令）

> 状态标记：`active` = 双端均有；`legacy` = 前端仍可能发送但壳不处理（历史路径）；`shellOnly` = 壳处理但前端当前无发送方。见契约 JSON `statusEnum`。

### 播放域（→ AVPlayerBridge.handleCommand）

| cmd | 状态 | payload | 说明 |
|---|---|---|---|
| `load` | active | `{url}` | 加载并替换当前 item（makeItem / 内嵌封面预读 / loadedmetadata 推送） |
| `play` | active | – | 播放；seek 进行中（pendingSeek）→ 置 playAfterSeek，seek 完成回调里续播 |
| `pause` | active | – | 暂停 + 锁屏播放态同步 |
| `seek` | active | `{t}`（Double 或 Int，秒） | 精确 seek（tolerance 0）+ pendingSeek 串行化；完成补推 paused（跳转暂停场景） |
| `setVolume` | active | `{v}`（0~1） | 音量，夹取后写 player.volume（muted 复用 v=0） |
| `setRate` | active | `{r}` | 变速（跟唱 0.75/1.0/1.25）；播放中生效 |
| `setMetadata` | active | `{title, artist, album, coverUrl}` | 锁屏元数据（标题/歌手/专辑/封面），封面三策略（data: 同步 / 内嵌兑底 / 异步拉取） |
| `setPlaying` | active | `{playing: Bool}` | 锁屏播放态显式同步（playing/paused/ended 回执时前端回发对齐） |
| `setQueue` | active | `{songs: [{url, title, artist, album}], index}` | 播放顺序快照（前端 selectSong 后 nativeSyncQueue 同步）；stream 歌 url 为空（原生跳过）；越界夹取，空/非法清空 |
| `playAudio` | active | `{url}`（http/https） | 词典发音等短音频原生播放（独立 AVPlayer，不弹系统播放器 UI） |

### UI / 生命周期域

| cmd | 状态 | payload | 说明 |
|---|---|---|---|
| `nativeReady` | active | – | 前端适配层就绪；壳收到后才开始推播放事件（防事件早于监听器） |
| `nativeLog` | shellOnly | `{line}` | 前端诊断日志转原生通道（nativecmd.log）；**当前前端无发送方**（壳预留，与 dbgLog → metaSave 双通道互补） |
| `pullRevealStatusBar` | active | – | 顶部下拉召唤状态条浮层（3s 自动收回） |

### 同步 / 资产域（→ DownloadManager）

| cmd | 状态 | payload | 说明 |
|---|---|---|---|
| `syncDownload` | active | `{items: [{url, path, sha256, size?, wifiOnly?}]}` | 批量下载资产；path 为沙盒相对路径（isSafePath 校验，http/https 白名单）；`wifiOnly` 为前端每次请求携带的仅 Wi-Fi 开关（T3，未带回落原生当前开关）；进度/完成回推 syncAssetProgress / syncAssetDone |
| `hasAsset` | active | `{path, requestId}` | 本地资产查询 → 回推 assetStatus `{requestId, path, exists, localURL}` |
| `cancelDownloads` | active | – | 取消全部下载 |
| `deleteAssets` | active | `{paths: string[]}` 或 `{scope: "all"\|"audio"\|"books"\|"dicts"}` | 精确删除（孤儿清理/类型前缀过滤/封面过期）或整类删除（旧壳回退）；完成后回推 assetsDeleted（paths/scope 原样回显） |
| `assetsSize` | active | – | 资产总占用（字节）→ 回推 assetsSize `{total, byType}`（T3 扩展明细；旧前端只读 total） |
| `assetIndex` | active | – | 资产注册表全量 → 回推 assetIndex `{assets: [{path, sha256, size}]}`（更新检测/孤儿计算数据源） |
| `setWifiOnly` | active | `{on: Bool}` | 仅 Wi-Fi 下载开关（fire-and-forget 无回执；蜂窝下挂起下载） |
| `getDeviceId` | active | `{requestId}` | 设备标识查询（Keychain 持久）→ 回推 deviceId `{requestId, deviceId}` |

### 元数据域（→ MetaStore，IndexedDB 失效兜底）

| cmd | 状态 | payload | 说明 |
|---|---|---|---|
| `metaSave` | active | `{kind, json}` | 原子写 `Documents/meta/{kind}.json`（fire-and-forget，无回执） |
| `metaLoad` | active | `{kind, requestId}` | 读文件 → 回推 metaLoaded `{requestId, kind, json?}`；缺失/损坏无 json 字段，前端 8s 超时兜底 |

### 配对 / 鉴权域

| cmd | 状态 | payload | 说明 |
|---|---|---|---|
| `unauthorized` | active | – | 401 到达 → 清 Keychain 配对 → 前端"未连接"模式（qqplayerTokenInvalid 通知） |
| `openPairing` | active | – | "未连接"引导页"去配对"按钮 → 壳发 qqplayerOpenPairing 通知 → 主界面打开配对 sheet（T4a：主界面永远可达） |

### 网络域（历史路径）

| cmd | 状态 | payload | 说明 |
|---|---|---|---|
| `http` | legacy | `{id, url, method, headers, body}` | ⚠️ 历史网络桥（file:// 页面禁 fetch http 的产物）；`nativeHttpAvailable()` 仅 file:// 触发，2026-08-22 壳改本地 http server 后不再生效，壳也无分发分支（未知命令静默忽略）。契约保留记录防误删 |

## nativeEvent（Native → Web 事件）

> 通道：`window.qqplayerOnNativeEvent(name, payload)`（见上）。`remoteCommand` 的 `payload.cmd` 是**事件负载值**（play/pause/toggle/next/prev/seekto），不是 webCmd。

| event | payload | 触发 |
|---|---|---|
| `loadedmetadata` | `{duration}` | item status readyToPlay（前端设 duration + 断点恢复 seek） |
| `playing` | `{t}` | rate > 0 观察 / 中断结束后恢复 |
| `paused` | `{t}` | rate == 0 且非 seek 且非缓冲等待 / seek 完成补推 / 中断开始 |
| `ended` | – | didPlayToEnd（Web 侧走自动切歌/单曲循环） |
| `timeupdate` | `{t, duration}` | ~250ms 定时器（驱动 Web 进度 + 锁屏对齐） |
| `error` | `{message}` | item load 失败（**前端当前无消费者**——已知缺口，sink default 分支丢弃） |
| `songChanged` | `{index}` | 锁屏/线控后台切歌（原生执行后推；index 为原生队列快照位置） |
| `remoteCommand` | `{cmd: "play"\|"pause"\|"toggle"\|"next"\|"prev"\|"seekto", t?}` | 锁屏/耳机线控命令到达原生（AVPlayerBridge.onRemoteCommand → pushToWeb；诊断上报 /api/debuglog） |
| `syncAssetProgress` | `{path, received, total}` | 下载进度（total 未知为 0） |
| `syncAssetDone` | `{path, ok, sha256, localURL?, error?}` | 下载完成/失败 |
| `assetStatus` | `{requestId, path, exists, localURL}` | hasAsset 回执 |
| `assetsSize` | `{total, byType: {audio, covers, lyric, books, dicts, meta, other}}` | assetsSize 回执（T3 扩展 byType，字节） |
| `assetIndex` | `{assets: [{path, sha256, size}]}` | assetIndex 回执（注册表缺失/损坏 → 空数组） |
| `assetsDeleted` | `{paths: string[]}` 或 `{scope}` | deleteAssets 完成回执（paths/scope 原样回显；旧壳不回推 → 前端超时兜底） |
| `metaLoaded` | `{requestId, kind, json?}` | metaLoad 回执 |
| `deviceId` | `{requestId, deviceId}` | getDeviceId 回执（Keychain 持久设备标识） |
| `appState` | `{state: "active"\|"inactive"\|"background"}` | 前后台切换（ScenePhase）；就绪冲刷时补发当前状态 |
| `swipe` | `{dir: "left"\|"right"}` | 原生手势翻页（UIPanGestureRecognizer）→ Reader |

## 关键时序

### 桥就绪
1. WKWebView 加载，documentStart 注入 `qqplayerIosBridge`
2. 前端启动 → `nativeReady` → 壳开始推播放事件（此前事件排队）

### 选歌播放（app 内）
1. 用户点歌 → `selectSong` → `nativeSyncQueue()` 发 `setQueue{songs, index}`（shuffle 按洗牌队列顺序；本地歌绝对 URL，stream 歌 url 空）
2. `load{url}` → 原生 makeItem + 内嵌封面预读 → `loadedmetadata{duration}`
3. 断点恢复（resumeAt）→ `seek{t}` → `playing{t}` → `timeupdate` 循环

### 锁屏 / 线控后台切歌（Web 挂起）
1. 锁屏 next/prev/play/pause/seek → MPRemoteCommandCenter → RemoteCommandManager（原生直接执行，不依赖 JS）
2. 切歌：playQueueRelative（QueueCursor 环绕）→ 原生 load + play + applyMetadata → 推 `songChanged{index}`
3. 前端回前台：按 `songChangedTargetIndex(playMode, index, shuffleQueue, songsLen)` 对齐状态（不重新 load）
4. 队列空 / stream 歌 url 空 → 跳过（MVP 限制）；未同步队列（旧客户端）→ 兑底转发 Web

### 资产同步
`syncDownload{items}` → 逐个下载 → `syncAssetProgress` → `syncAssetDone`；前端 `hasAsset` 查询/校验 → `assetStatus`；精确删除/整类删除 → `assetsDeleted`；`assetIndex`/`assetsSize` 供更新检测与占用展示

### 音频中断
来电/其他 app 抢占 → interruption began（中断前在播则记恢复）→ 推 `paused` → ended → 恢复播放推 `playing`（手动暂停后被打断不恢复）

### 401
任意资源请求 401 → 前端发 `unauthorized` → 壳清 Keychain 配对 → "未连接"模式

## 前端消费方映射

| 模块 | 职责 |
|---|---|
| `playerCore.js` | 播放命令发出（nativeReady/setQueue）+ 播放事件消费（loadedmetadata/playing/paused/ended/timeupdate/songChanged） |
| `nativeAudioBridge.js` | `qqplayerIosBridge` 探测 + postMessage 封装 + 事件入口（installNativeEventSink）+ 播放域命令（load/seek/setVolume/setRate/play/pause/setPlaying/setMetadata/unauthorized） |
| `sync.js` | 同步/资产/元数据命令 + 事件订阅（assetStatus/metaLoaded/syncAssetProgress/syncAssetDone/assetsSize/assetIndex/assetsDeleted/appState/deviceId） |
| `apiClient.js` | `http` 历史网络桥（legacy，当前不触发） |
| `usePullRevealStatusBar.js` | 顶部下拉手势 → pullRevealStatusBar |
| `NoConnectionView.vue` | "未连接"引导页 → openPairing |
| `DictLookupModal.vue` | 词典发音 → playAudio |
| `Reader.vue` | 订阅 swipe 翻页 |
| `useShellBridge.js` | **桌面壳**统一桥（webkit/tauri 双通道；pickLibrary/pickDictFiles 为桌面消息，iOS 静默忽略） |

## 待核对 TODO（契约测试落地时核对记录）

- [x] `pickLibrary` / `pickDictFiles`：**已核对**——macOS 壳消息（useShellBridge.js 仅 tauri/webkit 探测，无 iOS 发送方），iOS 壳 `handlePlaybackCommand` 未知命令静默忽略——文档已标注"仅桌面"
- [x] `syncAssetDone` payload 字段：**已核对**——path/localURL/sha256/ok/error 与 DownloadManager onDone 实现一致（契约 JSON nativeEvent.syncAssetDone 已字段级记录）
- [ ] 锁屏 `changePlaybackPosition` 事件经 `remoteCommand` 上报的 `t` 与前端 seek 处理链路未端到端核对（模拟器锁屏媒体卡片不显示，真机验收项）
- [ ] 前端 `debuglog.json`（dbgLog → nativeMetaSave）与原生 `nativecmd.log` 双通道互补，无合并计划（长期排查工具）
