# QQPlayer 多平台规划（PLANNING）

> 2026-08-16 与大象讨论记录。桌面端完成后启动移动端，**优先 iOS**。
> 2026-08-22 补充：桌面端配对 API 定案（见下）。
> 本文件放仓库内，多台机器开发时 git pull 即可同步信息。

## 定位：移动端是 companion 产品，不是桌面版全功能迁移

- **同网时**：从桌面服务器（FastAPI :17627）下载/同步数据（元数据 + 音频 + 歌词 + 阅读进度）
- **离线后**：基础功能可用——播放、跟唱、阅读；**不提供**桌面重型功能：
  - 歌词 AI 对齐（ForcedAligner，只在桌面跑，移动端只消费结果）
  - 标签刮削/改名（同理）
  - 夸克/网易云搜索下载代理（回桌面再干）
  - 文件系统扫描/监听（没有"曲库文件夹"概念，只有同步下来的缓存）

## 核心思路：前端代码大量复用

- 前端 42k 行 Vue3 源码大部分可复用（歌词渲染/跟唱/EPUB 阅读器 UI 原样用）
- 移动端只需改**数据层** = 同步层 + 离线缓存 + 原生音频播放插件
- 本质：Capacitor（或 Tauri Mobile）壳 + 复用前端 UI + 同步/缓存数据层 + 原生音频插件

## 建议架构

- 桌面端 mDNS 广播（`_qqplayer._tcp`）+ 同步 API：`/api/sync/manifest` 元数据清单 + 版本号
- 移动端按版本**增量拉取**，文件用 HTTP Range 断点续传
- 移动端本地播放已缓存音频（音频 + 歌词 + 封面）
- 收藏/歌单/播放记录/阅读进度本地记录，回网后合并回服务器

## 已定决策（2026-08-16 / 2026-08-22 拷问定案）

1. **移动端定位**：companion 产品，同网同步 + 离线播放/跟唱/阅读
2. **iOS 技术路线**：Swift 原生壳 + WKWebView 复用前端（52k 行 Vue3，mobile.css 移动布局已有）+ AVPlayer 桥 + 同步数据层；不 Swift 重写 UI
3. **配对服务范围**：只服务移动端 → 桌面端；桌面实例间互访不做（以后做分享歌单）
4. **同步协议**：manifest + HTTP Range 断点续传（个人场景够用，不上 WebDAV/S3）
5. **鉴权**：全 API 加 Bearer token（localhost 免鉴权），配对引入信任 + token 持续验证
6. **配对确认**：壳内原生弹窗（macOS Swift / Windows Tauri 都要做）
7. **token**：永久有效 + 手动撤销；明文 HTTP 传输（内容非机密，家庭局域网信任）

## 桌面端配对 API 定案（2026-08-22）

```
【发现】Python zeroconf 广播 _qqplayer._tcp @ :17627
  TXT: v=版本号, name=设备名（hostname）→ iOS 自动列出局域网桌面端

【配对流程】
  iOS  POST /api/pairing/request {device_id, device_name, device_type}
       → pending 队列，返 request_id；同一 device_id 限流（3 次后指数退避，base 60s）
  壳   GET  /api/pairing/pending（1-2s 轮询）→ 弹原生窗（设备名 + 确认/拒绝）
       确认 → POST /api/pairing/request/:id/approve → 生成 64 位 token（SHA-256 哈希存储）
       拒绝 → POST /api/pairing/request/:id/reject
  iOS  GET  /api/pairing/request/:id/status
       pending → 等 / approved → 拿 token（iOS 存 Keychain）
       rejected / expired（pending 5 分钟超时）

【鉴权中间件】
  白名单: /api/pairing/*  |  来源 127.0.0.1 免鉴权  |  其余所有 /api/* 校验 Bearer token，无效 401

【设备管理】GET /api/pairing/devices · DELETE /api/pairing/devices/:device_id（撤销立即失效）

【存储】~/Library/Application Support/qqplayer/pairing.json
  [{ device_id, device_name, device_type, token_hash, created_at, last_seen_at }]
```

**实现要点**：配对模块独立 router + service（backend/app/routers/pairing.py）；壳轮询 pending 用普通 HTTP 定时器即可，不上推送；限流按 device_id 记请求时间，两次间隔 >10min 重置计数。

## ② 前端数据层抽象定案（2026-08-22）

```
【apiClient 统一出口】
  53 处裸 fetch（17 文件）一次性全迁；统一 baseURL + Bearer token header + 缓存钩子
  baseURL：桌面浏览器=localhost:17627；iOS=配对后桌面 IP（壳注入）

【缓存分层】
  小数据全量同步 → 元数据/歌词/封面/电子书（存 IndexedDB，纯前端可测）
  大文件按需     → 音频/词典（手动选择下载，可管理删除；MDX/MDD 词典单本 GB 级）
  声明式缓存：调用点标注 {cache: {ttl, offline}}

【写路径】本地乐观写入（即时生效）→ dirty 队列（IndexedDB）→ 回网批量 push → last-write-wins

【离线行为】请求失败自动降级（切离线读缓存，成功自动恢复，轻提示）；401 特判 → 清配对信息 → 引导重新配对（绝不静默）

【播放记录】全量同步（几百 KB 无所谓，合并逻辑简单）
```

**边界**：②只做前端侧；桌面端同步 API（manifest/dirty 合并）归③ iOS 壳阶段一起开发。

## 路线

1. 桌面端完善 ✅（阅读器/歌词对齐/Windows Tauri 壳/打包链路均已完）
2. 移动端启动（进行中）：**优先 iOS**（Swift 壳 + WKWebView 复用前端 + AVPlayer 桥），再 Android / 鸿蒙
   - ① 桌面端配对 API（✅ 已合入 main `65aa22e`，待部署生效）
   - ② 前端数据层抽象（✅ 已合入 main `50ef79e`）
   - ③ iOS 壳（定案完成 2026-08-22）：
     - 任务 A：SQLite 持久化升级（favorites/playlists/playback/进度/ops 表，JSON 迁移）
     - 任务 B：桌面端同步 API（manifest + ops 双向，依赖 A）
     - 任务 C：① 增强——多桌面配对（device_id 多 token，按 server_id 维度）
     - 任务 D：iOS 壳阶段1+2（SwiftUI 骨架 + 发现配对 + AVPlayer 桥 + 后台锁屏，bundle 前端）
     - 任务 E：阶段3+4（同步层对接 + 跟唱/阅读/词典全功能验证）

## 平台难度参考（复用现有代码前提下）

| 平台 | 难度 | 说明 |
|------|------|------|
| Windows | 🟢 简单 | 壳 + 打包，Python 后端可继续用 |
| macOS | ✅ 已有 | — |
| Android | 🟡 中等 | Capacitor 壳 + 后端 TS 移植 + SAF 文件访问 + 音频插件 |
| iOS | 🔴 偏难 | 沙盒/后台/审核三座大山 + 无 Python |
| 鸿蒙 | 🟡 中等 | ArkWeb 壳，逻辑复用，生态/API 适配 |

## ③ iOS 壳定案（2026-08-22）

```
【工程】mobile/ios/（SwiftUI + WKWebView + xcodeproj，命令行 xcodebuild 可构建）
【前端加载】frontend 构建产物 bundle 进 App（离线可用）；apiClient 注入 qqplayer.server/token
【播放】playerCore 原生适配层（window.qqplayerNative 分支，桌面浏览器行为不变）+ AVPlayer（毫秒 seek）
【后台/锁屏】AVAudioSession .playback + UIBackgroundModes audio + MPNowPlayingInfoCenter
           + MPRemoteCommandCenter（含耳机线控）
【发现/配对】NWBrowser 搜 _qqplayer._tcp → 调 ① API → token 存 Keychain；多桌面配对（多 token）
【同步】启动 + 前台恢复 + 手动三触发；元数据全量 + 音频/词典按需（sha256 差量 + Range 断点）
【范围】全量：播放（AB循环/歌词）/跟唱/阅读器（点词查义 + 独立查词页）/词典/后台锁屏/全资源同步
【账号】免费 Apple ID 开发（7 天重签）；TestFlight/公开分发等遥测数据近 1 万再买付费账号
【遥测】匿名最小集（设备UUID/版本/平台/启动事件）→ 用户轻量服务器 → 默认开 + 设置可关 → 后端实现
【iOS 技术坑】ATS 加 NSAllowsLocalNetworking（HTTP 明文）；Info.plist 加 NSLocalNetworkUsageDescription

【同步 API（桌面端新增）】
  GET /api/sync/manifest —— 全量元数据清单 {version, songs[], playlists[], favorites[], books[], dicts[]}
  POST /api/sync/ops —— 手机 push dirty 队列（带 ts）
  GET  /api/sync/ops?since= —— 拉桌面端增量（append-only 游标）
  双向 last-write-wins（ts 大者胜）；鉴权由 ① 中间件覆盖

【新增前置任务：SQLite 持久化升级】
  favorites/playlists/playback/阅读进度/ops 表 → SQLite（qqplayer.db，标准库 sqlite3，WAL）
  旧 JSON 首次启动自动迁移（幂等，旧文件改名 .migrated.bak）；settings/pairing/大文件不动
  理由：ops 日志游标查询 + 多端并发写 + last-write-wins 合并是数据库舒适区，JSON 撑不住
```

**开发阶段**：阶段1 壳骨架+发现配对 → 阶段2 AVPlayer 桥+后台锁屏 → 阶段3 同步层（依赖 SQLite 升级）→ 阶段4 全功能接入验证（跟唱/阅读/词典）。

## 仓库结构规划（2026-08-22 定）

```
desktop/          # 桌面形态（功能完整版）
  macOS/          # Swift 壳（已有）
  Windows/        # Tauri 壳（已有）
mobile/           # 移动形态（companion 定位，与桌面功能差异大）
  ios/            # Swift 壳（待建，① 配对 API + ② 数据层已就绪）
  android/        # 未来
  harmonyos/      # 未来
```

移动端与桌面端是两个产品定位：companion（同步+离线）vs 完整版，不混放。

## 并行开发约定（多机器协作）

后端已拆 app 包（routers/services/state/storage/main），新功能按模块建独立 router + service 文件，冲突极小。
前端公共接线文件（App.vue mode 切换 / locales index / ActivityBar/Sidebar 导航）是主要冲突点，约定：
- 各功能主体代码进独立目录（如 `books/`、`videos/`），不互相引用
- 接线层改动保持小而独立提交，频繁 pull/push
- 冲突时以"后合的人负责解决接线"为原则

## 桌面配对管理 Tab（2026-08-24 定案，拷问后）

**需求**：桌面设置区加「配对」tab，管理已配对设备（删除/备注）+ 待确认请求兜底；iOS 壳补配对失效提示。

**拷问结论**（用户拍板）：
- Q1 删除后 iOS 壳要有「配对失效」提示（现状：401 静默清配对踢回发现页，无任何提示）→ 本次做
- Q2 待确认请求列表 = 只读展示 + 删除（= reject），**不提供批准入口**（批准走弹窗，避免双入口）
- Q3 本机信息卡（IP/server_id/mDNS 状态）**不做**——用户觉得展示不舒服
- Q4 设备备注（note）要做——重名手机区分
- Q5 「暂停配对」开关**不做**
- Q6 手机端已下载文件清理**不做**（由 iOS 端自行决定）

### 范围

**前端（SettingsModal 新增「配对」tab，Smartphone 图标）**
1. 已配对设备列表：device_name/type 图标/created_at/last_seen_at/note；操作：删除（确认弹窗）+ 编辑备注（行内/弹窗输入）
2. 待确认请求（只读+删除）：device_name/type/created_at + 删除按钮（= POST /reject，幂等）；无批准按钮
3. 空状态：「暂无配对设备」
4. iOS 壳内（qqplayerIosBridge 存在）隐藏该 tab？——**否，保留显示**（iOS 用同一前端，配对管理原生 DiscoveryView 已有，但 tab 无操作入口也行？→ 定：**iOS 也显示**，数据源同桌面（本实例 devices），删除/备注对 iOS 发起方无意义但无害；暂不特判，减少分支）——等等，iOS 的 apiClient baseURL 是本机 127.0.0.1 MiniHTTPServer，/api/pairing/devices 会代理到桌面端，删除本实例配对 = 删自己？**定案：iOS 壳隐藏该 tab**（配对管理归原生 DiscoveryView；避免删自己）
5. i18n zh-CN/en-US + 组件/逻辑测试

**后端**
- devices 条目加 note 字段（默认 ""）
- GET /api/pairing/devices 返回 note
- 新增 PATCH /api/pairing/devices/{server_id}/{device_id}，body {note} → 更新备注（幂等，404 当不存在时返回 404）
- 测试：note 默认/更新/持久化/幂等；devices 列表含 note

**iOS 壳**
- WebShellView `unauthorized`：清配对前弹用户可见提示（alert「配对已失效，请重新配对」）→ 再回发现页
- 测试：手动（真机/模拟器：桌面删配对 → 手机下次请求 401 → 弹提示回发现页）

### 不做
- 本机信息卡 / 暂停配对开关 / 一键全部撤销 / 手机端文件清理联动 / pending 批准入口
