# iOS 同步层桥契约（阶段3 · 2026-08-22 定）

Web（WKWebView 内前端）与 Native（Swift 壳）之间同步相关消息格式。
播放桥（play/pause/seek/load/setMetadata 等）沿用现有 `qqplayerIos` handler，本文只定义同步/资产相关消息。

## Web → Native（`window.qqplayerIosBridge.postMessage(msg)`）

### syncDownload —— 批量下载请求
```json
{
  "cmd": "syncDownload",
  "items": [
    { "url": "http://192.168.1.5:17627/api/audio?path=...", "path": "audio/<sha256>.m4a", "sha256": "<hex>", "size": 1234567 }
  ]
}
```
- `url`：桌面服务器绝对 URL（media_url_template 展开后）
- `path`：App 沙盒内相对存储路径（`Documents/qqplayer-assets/<path>`），下载完成后 AVPlayer 播 `file://` 全路径
- `sha256`：期望内容校验值（hex）。**后端 manifest 暂未提供内容哈希时传空字符串 ""**，原生侧跳过内容校验（size 校验仍生效）；非空时严格校验，不匹配则删除重下（最多 2 次）
- `size`：期望大小（可选，用于进度展示）
- Native 侧串行/并发下载（并发 ≤3），断点续传（已有部分文件 + `Range` 请求），完成/失败逐条回传事件

### hasAsset —— 本地资产查询
```json
{ "cmd": "hasAsset", "path": "audio/<sha256>.m4a", "requestId": 1 }
```
回执事件 `assetStatus`（见下）。Web 播放前先查，有本地文件则直接播本地（离线可用）。

### cancelDownloads —— 取消全部下载
```json
{ "cmd": "cancelDownloads" }
```
取消队列中未开始的下载；进行中的下载完成后不再回传（或回传 error: "cancelled"）。

## Native → Web（`window.qqplayerOnNativeEvent(name, payload)`）

### syncAssetProgress —— 单文件下载进度
```json
{ "name": "syncAssetProgress", "path": "audio/<sha256>.m4a", "received": 123, "total": 456 }
```
total 未知时为 0；Web 侧聚合显示总进度。

### syncAssetDone —— 单文件下载完成/失败
```json
{ "name": "syncAssetDone", "path": "audio/<sha256>.m4a", "ok": true, "sha256": "<hex>", "localURL": "file:///.../qqplayer-assets/audio/<sha256>.m4a" }
```
失败时 `ok: false` + `error` 字段。

### assetStatus —— hasAsset 回执
```json
{ "name": "assetStatus", "requestId": 1, "path": "audio/<sha256>.m4a", "exists": true, "localURL": "file:///..." }
```

### appState —— 应用生命周期（scenePhase）
```json
{ "name": "appState", "state": "active" | "inactive" | "background" }
```
Web 收到 `active` 触发一次同步（前台恢复触发点）；`background` 时暂停低优先级下载。

## 存储约定

- 资产根目录：`Documents/qqplayer-assets/`（子目录按类型：`audio/`、`dicts/`、`books/`）
- 文件名用内容寻址（sha256 前缀），同名即同内容，天然去重
- 元数据（songs/playlists/favorites 等）仍走 IndexedDB（apiClient 声明式缓存），不进沙盒

## 同步触发点（Web 侧 sync.js）

1. 启动：webReady（前端适配层就绪）后自动 syncNow()
2. 前台恢复：收到 `appState active` → syncNow()
3. 手动：设置页「立即同步」按钮 → syncNow()

syncNow() 流程：GET /api/sync/manifest → version 变化才更新 IndexedDB 各集合 → 返回摘要（歌曲数/播放列表数/待下载资产数）→ 不自动全量下载（按需），仅更新「待下载清单」供 UI 展示。
