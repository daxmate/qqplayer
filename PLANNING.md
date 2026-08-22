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

## 路线

1. 桌面端完善 ✅（阅读器/歌词对齐/Windows Tauri 壳/打包链路均已完）
2. 移动端启动（进行中）：**优先 iOS**（Swift 壳 + WKWebView 复用前端 + AVPlayer 桥），再 Android / 鸿蒙
   - ① 桌面端配对 API（2026-08-22 定案，待开发）
   - ② 前端数据层抽象（apiClient 统一出口 + 离线缓存层）
   - ③ iOS 壳（mDNS 发现 + 配对 + AVPlayer 桥 + 同步/缓存）

## 平台难度参考（复用现有代码前提下）

| 平台 | 难度 | 说明 |
|------|------|------|
| Windows | 🟢 简单 | 壳 + 打包，Python 后端可继续用 |
| macOS | ✅ 已有 | — |
| Android | 🟡 中等 | Capacitor 壳 + 后端 TS 移植 + SAF 文件访问 + 音频插件 |
| iOS | 🔴 偏难 | 沙盒/后台/审核三座大山 + 无 Python |
| 鸿蒙 | 🟡 中等 | ArkWeb 壳，逻辑复用，生态/API 适配 |

## 并行开发约定（多机器协作）

后端已拆 app 包（routers/services/state/storage/main），新功能按模块建独立 router + service 文件，冲突极小。
前端公共接线文件（App.vue mode 切换 / locales index / ActivityBar/Sidebar 导航）是主要冲突点，约定：
- 各功能主体代码进独立目录（如 `books/`、`videos/`），不互相引用
- 接线层改动保持小而独立提交，频繁 pull/push
- 冲突时以"后合的人负责解决接线"为原则
