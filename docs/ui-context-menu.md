# 右键菜单三层架构与接线规范（P2-A 文档化）

> 2026-08-27 P2-A 审计补充：**菜单机制本就共享**（ContextMenu.vue 已是单一组件），本次不改代码，只补文档。
> 目标：说清「浏览器自定义菜单 ↔ 壳桥接 ↔ 原生 NSMenu」三层如何协作，以及为什么移动端没有菜单。
> 关联：`docs/ios-bridge-protocol.md`（桥契约）、`frontend/src/composables/useNativeCtxMenu.js`（桥接实现）、`desktop/macOS/main.swift`（壳侧注入）。

## 一、三层结构总览

```
  浏览器（无壳）                     Swift 壳（WKWebView）
  ─────────────                   ─────────────────────
  ① ContextMenu.vue               ③ 壳侧原生 NSMenu（main.swift willOpenMenu）
   @contextmenu.prevent 弹自定义菜单  ↑ 注入菜单项（按 ctxState kind）
        │                          │ 菜单点击 → evaluateJavaScript
        │                          │   window.__qqCtxMenu.play() 等
        │        ┌─────────────────┴──────────────┐
        │        │ ② useNativeCtxMenu.js（壳桥接）  │
        │        │  mousedown(button===2/⌃+左键)    │
        │        │  → 命中歌曲行/歌单项 → 组装 ctxTarget
        │        │  → "native" 通道上报 ctxState（去重）
        │        │  → 装全局 API window.__qqCtxMenu.*
        │        │  → 点击派发 window qqplayer:ctx-* 事件
        │        └────────────────┬──────────────┘
        │                         │
        └───────────┬─────────────┘
                    ▼
    Playlist.vue / SmartViewPanel.vue / Sidebar.vue
    监听 qqplayer:ctx-* → 复用浏览器右键菜单同一套动作实现（行为完全一致）
```

- **① Web 自定义菜单**：`frontend/src/components/ContextMenu.vue`（Teleport 到 body，播放/下一首/收藏/加歌单/推送到设备/去歌手/去专辑/编辑标签/删除）。
  浏览器端由 Playlist.vue / SmartViewPanel.vue 的 `@contextmenu.prevent` 触发；组件已共享，两处用法一致。
- **② 壳桥接**：`frontend/src/composables/useNativeCtxMenu.js`。WKWebView 里 `contextmenu` 事件被系统吞掉不触发，
  但 `mousedown`（右键 / ⌃+左键）正常——前端 document 级监听检测命中（`.pl-item[data-path]` / `.sv-item[data-path]` /
  `.sb-item[data-playlist-id]`），组装上下文经 `"native"` 通道上报 `ctxState`（上下文无变化去重不重发），并安装
  全局 API `window.__qqCtxMenu.*`；菜单点击 → evaluateJavaScript 调该 API → 派发 `qqplayer:ctx-*` window 事件。
  浏览器环境（无 `window.qqplayerNative`）init 直接返回，零监听、零影响。
- **③ 壳侧原生 NSMenu**：`desktop/macOS/main.swift`。`willOpenMenu` 按最新 `ctxState` 的 kind（song / playlist / nil）
  注入应用菜单项（播放/下一首播放/收藏/加歌单/删除/编辑标签/去歌手/去专辑…）；kind 为 nil（空白区右键）或上下文过期
  → 不注入，保留系统菜单。点击动作统一 `callJS("window.__qqCtxMenu?.xxx()")` 回前端（失败静默）。

## 二、动作接线（行为一致性保证）

壳内菜单动作与浏览器菜单**共用同一套实现**：Playlist.vue / SmartViewPanel.vue / Sidebar.vue 各自监听
`qqplayer:ctx-*` 事件（play / playnext / togglefav / addplaylist / deletesong / goartist / goalbum / edittags…），
回调复用浏览器右键菜单的动作函数 → 行为完全一致，无第二套逻辑。事件只在原生壳内由 `__qqCtxMenu` 派发，浏览器永不触发。

## 三、移动端为什么没有菜单（原生体验原则）

移动端（`components/mobile/*`）**不渲染 ContextMenu、不初始化 useNativeCtxMenu、无任何 NSMenu**：
触屏没有右键概念，长按手势已分配给行操作（左滑操作区 useSwipeReveal / 封面手势区），菜单用原生体验替代
（列表行左滑操作、播放页手势）。P2-A 明确**不加 Web 菜单**——维持原生体验，桌面右键菜单机制不向移动端迁移。

## 四、改菜单时的接线检查清单

1. 菜单项文案在 `locales/*/playlist.js`（`playlist.ctx.*`），加项先加文案。
2. 浏览器菜单：改 ContextMenu.vue 的按钮 + emit；触发方（Playlist / SmartViewPanel）`@ctx-*` 接动作。
3. 壳内菜单：useNativeCtxMenu.js 的 ctxTarget 组装 + `__qqCtxMenu` API + 派发事件；
   触发方加对应 `qqplayer:ctx-*` 监听（**必须**与浏览器动作同实现，禁止另写逻辑）。
4. 壳侧注入：desktop/macOS/main.swift `insertCtxMenuItems` 加 NSMenuItem + `callJS` 对应 API。
5. 浏览器右键行为回归：无壳环境 `contextmenu` 自定义菜单正常；壳环境 NSMenu 注入、点击动作与浏览器一致。
