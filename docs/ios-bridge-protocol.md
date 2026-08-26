# iOS 壳双端桥协议（Web ↔ Native）

QQPlayer iOS 伴侣壳（SwiftUI + WKWebView）与前端 Web 应用之间的通信契约。
维护者：Pass 3 架构层（2026-08-26）。以 `mobile/ios/Sources/WebShellView.swift` / `AVPlayerBridge.swift` / `RemoteCommandManager.swift` / `MetadataManager.swift` 与前端 `playerCore.js` / `nativeAudioBridge.js` / `sync.js` / `useShellBridge.js` 为准。

## 通道

- **Web → Native**：`window.qqplayerIosBridge.postMessage({cmd, ...payload})`（documentStart 注入；file:// 与 http:// 均可用）。WKScriptMessageHandler `userContentController(_:didReceive:)` 收到后按 cmd 分域分发。
- **Native → Web**：`pushToWeb(event:payload:)` → `evaluateJavaScript("window.dispatchEvent(new CustomEvent('qqplayer:' + event, {detail: payload}))")`（播放事件另有 `playerBridge.onEvent` → 同一通道）。

## webCmd（Web → Native 命令）

### 播放域（→ AVPlayerBridge.handleCommand）

| cmd | payload | 说明 |
|---|---|---|
| `load` | `{url}` | 加载并替换当前 item（makeItem / 内嵌封面预读 / loadedmetadata 推送） |
| `play` | – | 播放；seek 进行中（pendingSeek）→ 置 playAfterSeek，seek 完成回调里续播 |
| `pause` | – | 暂停 + 锁屏播放态同步 |
| `seek` | `{t}`（Double 或 Int，秒） | 精确 seek（tolerance 0）+ pendingSeek 串行化；完成补推 paused（跳转暂停场景） |
| `setVolume` | `{v}`（0~1） | 音量，夹取后写 player.volume |
| `setRate` | `{r}` | 变速（跟唱 0.75/1.0/1.25）；播放中生效 |
| `setMetadata` | 见 MetadataManager | 锁屏元数据（标题/歌手/专辑/封面/时长），封面三策略（data: 同步 / 内嵌兑底 / 异步拉取） |
| `setPlaying` | `{playing: Bool}` | 锁屏播放态显式同步 |
| `setQueue` | `{songs: [{url,name,...}], index}` | 播放顺序快照（前端 selectSong 后 nativeSyncQueue 同步）；越界夹取，空/非法清空 |
| `playAudio` | `{url}`（http/https） | 词典发音等短音频原生播放（不弹系统播放器） |

### UI / 生命周期域

| cmd | payload | 说明 |
|---|---|---|
| `nativeReady` | – | 前端适配层就绪；壳收到后才开始推播放事件（防事件早于监听器） |
| `nativeLog` | `{line}` | 前端诊断日志转原生通道（nativecmd.log） |
| `pullRevealStatusBar` | – | 顶部下拉召唤状态条浮层（3s 自动收回） |

### 同步 / 资产域（→ DownloadManager）

| cmd | payload | 说明 |
|---|---|---|
| `syncDownload` | `{items: [{url, path, sha256, size?}]}` | 批量下载资产；path 为沙盒相对路径（isSafePath 校验，http/https 白名单）；进度/完成回推 syncAssetProgress / syncAssetDone |
| `hasAsset` | `{path, requestId}` | 本地资产查询 → 回推 assetStatus `{requestId, path, exists, localURL}` |
| `cancelDownloads` | – | 取消全部下载 |
| `deleteAssets` | `{scope: "all"\|"audio"\|"books"\|"dicts"}` | 删除资产；完成后回推 assetsDeleted `{scope}` |
| `assetsSize` | – | 资产总占用（字节）→ 回推 assetsSize `{total}` |

### 元数据域（→ MetaStore，IndexedDB 失效兜底）

| cmd | payload | 说明 |
|---|---|---|
| `metaSave` | `{kind, json}` | 原子写 `Documents/meta/{kind}.json`（fire-and-forget，无回执） |
| `metaLoad` | `{kind, requestId}` | 读文件 → 回推 metaLoaded `{requestId, kind, json?}`；缺失/损坏无 json 字段，前端 8s 超时兜底 |

### 配对 / 鉴权域

| cmd | payload | 说明 |
|---|---|---|
| `unauthorized` | – | 401 到达 → 清 Keychain 配对 → 回发现页重新配对 |

## nativeCmd（Native → Web 事件）

| event | payload | 触发 |
|---|---|---|
| `loadedmetadata` | `{duration}` | item status readyToPlay（前端设 duration + 断点恢复 seek） |
| `playing` | `{t}` | rate > 0 观察 / 中断结束后恢复 |
| `paused` | `{t}` | rate == 0 且非 seek 且非缓冲等待 / seek 完成补推 / 中断开始 |
| `ended` | – | didPlayToEnd（Web 侧走自动切歌/单曲循环） |
| `timeupdate` | `{t, duration}` | ~250ms 定时器（驱动 Web 进度 + 锁屏进度） |
| `error` | `{message}` | item load 失败 |
| `songChanged` | `{index}` | 锁屏/线控后台切歌（原生执行后推；index 为原生队列快照位置） |
| `syncAssetProgress` | `{path, received, total}` | 下载进度 |
| `syncAssetDone` | `{path, localURL, sha256, ok, error?}` | 下载完成/失败 |
| `assetStatus` | `{requestId, path, exists, localURL}` | hasAsset 回执 |
| `assetsSize` | `{total}` | assetsSize 回执 |
| `assetsDeleted` | `{scope}` | deleteAssets 完成 |
| `metaLoaded` | `{requestId, kind, json?}` | metaLoad 回执 |
| `appState` | `{state}` | 前后台切换（ScenePhase） |
| `swipe` | `{dir: "left"\|"right"}` | 原生手势翻页 → Reader |
| `remoteCommand` | `{cmd, t?}` | 锁屏/线控命令到达原生（诊断上报，webCmd 对照用） |

## 关键时序

### 桥就绪
1. WKWebView 加载，documentStart 注入 `qqplayerIosBridge`
2. 前端启动 → `nativeReady` → 壳开始推播放事件

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
`syncDownload{items}` → 逐个下载 → `syncAssetProgress` → `syncAssetDone`；前端 `hasAsset` 查询/校验 → `assetStatus`

### 音频中断
来电/其他 app 抢占 → interruption began（中断前在播则记恢复）→ 推 `paused` → ended → 恢复播放推 `playing`（手动暂停后被打断不恢复）

### 401
任意资源请求 401 → 前端发 `unauthorized` → 壳清 Keychain 配对 → 回发现页

## 前端消费方映射

| 模块 | 职责 |
|---|---|
| `playerCore.js` | 播放命令发出 + 播放事件消费（loadedmetadata/playing/paused/ended/timeupdate/songChanged/error） |
| `nativeAudioBridge.js` | `qqplayerIosBridge` 探测 + postMessage 封装（非 iOS 环境恒 false） |
| `sync.js` | 同步/资产/元数据命令 + 事件（assetStatus/metaLoaded/syncAssetProgress/syncAssetDone/assetsSize/assetsDeleted） |
| `usePullRevealStatusBar.js` | 顶部下拉手势 → pullRevealStatusBar |
| `useShellBridge.js` | 桌面壳统一桥（webkit/tauri 双通道；pickLibrary/pickDictFiles 为桌面消息，iOS 静默忽略） |

## 待核对 TODO（Pass 3 只读核对记录）

- [ ] `pickLibrary` / `pickDictFiles`：macOS 壳消息，iOS 壳 `handlePlaybackCommand` 未知命令静默忽略——确认无 iOS 调用方后可在文档标注"仅桌面"
- [ ] `syncAssetDone` payload 字段以前端 `sync.js` 消费为准（path/localURL/sha256/ok/error 与 DownloadManager 实测一致，未逐一字段级核对）
- [ ] 锁屏 `changePlaybackPosition` 事件经 `remoteCommand` 上报的 `t` 与前端 seek 处理链路未端到端核对（模拟器锁屏媒体卡片不显示，真机验收项）
- [ ] 前端 `debuglog.json`（dbgLog → nativeMetaSave）与原生 `nativecmd.log` 双通道互补，无合并计划（长期排查工具）
