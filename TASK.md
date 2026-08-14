# QQPlayer search anything —— 任务 A：全屏搜索层 UI + 集成

## 项目背景
- 项目 `~/codes/qqplayer/`：FastAPI + Vue3 外语学习媒体播放器（音乐 + AB 循环复读 + 有声书）
- 本任务是「search anything」功能主体（用户 2026-08-14 拍板）：把顶栏搜索框升级为 **Spotlight 式全屏搜索层**，能搜索本地歌曲/在线歌曲/歌手/专辑/设置项
- 工作目录：`/Users/dax/codes/qqplayerA`（clone 自主仓库，origin 指向主仓库本地路径）
- 分支：`git checkout -b feat/search-anything-ui`（若已存在：`git checkout main && git pull origin main` 后重建）
- node_modules：`ln -s /Users/dax/codes/qqplayer/node_modules /Users/dax/codes/qqplayerA/frontend/node_modules`（若失效则 `cd frontend && npm install`）
- 测试：`cd frontend && npx vitest run`（⚠️ 不要用管道接 tail——会吞退出码，直接看命令退出码）；lint `npx eslint src`；格式 `npx prettier --check "src/**/*.{js,vue}" "public/*.html"`
- 测试基建：vite.config.js setupFiles 自动装 vue-i18n（`src/__tests__/setup.js`）；matchMedia mock 在 `src/__tests__/helpers/matchMedia.js`（installMatchMedia，须在 import 被测模块前调用）
- i18n：组件 `useI18n().t()`；语言包在 `src/locales/zh-CN/`（新文件要加 index.js 聚合）；key 命名 `<模块>.<功能>.<描述>`
- 视觉验证：playwright 脚本放 `frontend/` 下（可 import playwright），截图存 `/tmp/`；vite dev：`cd frontend && npm run dev`（5173，proxy 已配到主服务 17627）

## 用户已拍板需求（search anything，逐条不许改）
1. 名称 **search anything**（不是 anywhere）
2. 入口：升级现有顶栏搜索框——**常态只显示一个小放大镜图标**，点击展开成搜索框；移动端同步升级
3. 结果五类：**本地歌曲 / 在线歌曲（网易云）/ 歌手 / 专辑 / 设置项**；每项带**类别 badge**；**按匹配度排序**（数据层已排好，你只渲染）；同分优先级 本地>在线>歌手>专辑>设置
4. 设置项结果**行内直接操作**（开关直接切/滑杆直接拖/选择直接换/文本直接改），实时持久化
5. 搜索激活时：**播放界面整体变模糊，搜索框 + 结果列表成为整个页面主体**（全屏遮罩层，盖住一切含顶栏）；**Esc 和点空白收起**；搜索期间音乐继续播放
6. **Cmd+K 全局唤起**（聚焦搜索框），快捷键**可在设置中更改**
7. 空态（聚焦未输入）：显示**全部设置项列表**（按设置分类分组）= 设置目录
8. 歌单不进搜索；歌手/专辑点击 → 进入分组浏览（此行为可先留 onPick 桩，maintainer 集成时接）
9. 在线歌曲点击 = 下载（复用现有下载逻辑，参照 OnlineSearch.vue 的下载实现）；本地歌曲点击 = 播放（selectSong/play）

## 跨任务契约（三任务并行；merge 时 maintainer 按 B→C→A 合，以下模块由并行任务产出，**你的 clone 里还没有 → 本地建临时 stub（同路径，不 commit）让测试能跑**）

### 由 B 产出（你 import 消费）
- `frontend/src/settingsIndex.js`：`export const SETTING_CATEGORIES`（7 分类 {key,labelKey,subTabs?}）+ `export const settingsIndex`（SettingEntry[]）
- SettingEntry：`{ id, category, subTab, labelKey, keywords[], type:'toggle'|'slider'|'select'|'text', get(), set(v), min?,max?,step?,options?,placeholder? }`
- `frontend/src/components/InlineControl.vue`：props `{ entry }`，按 type 渲染内联控件，变更自动调 entry.set(v)（持久化由 settingsSync watch 自动 PUT，不用你管）

### 由 C 产出（你 import 消费）
- `frontend/src/utils/score.js`：`matchScore(query,text)` + `kindRank(kind)`（你用不到也可以不 import）
- `frontend/src/composables/useSearchAnything.js`：模块级单例 `useSearchAnything()` 返回：
  `{ query: Ref<string>, results: Ref<ResultItem[]>, loading: Ref<boolean>, isSearchOpen: Ref<boolean>, clear(): void }`
- ResultItem：`{ kind:'song'|'online'|'artist'|'album'|'setting', id, title, subtitle, badge, score, payload }`
  - song.payload = 歌曲对象；online.payload = {id,title,artist,album,cover,duration,quality}；artist.payload = {artist,count}；album.payload = {album,artists,count}；setting.payload = SettingEntry

### stub 约定（重要）
- 你的 clone 里建**临时 stub**：`frontend/src/settingsIndex.js`（导出空数组 + 1-2 条示例条目）、`frontend/src/composables/useSearchAnything.js`（最小实现：ref + 空 results）、`frontend/src/components/InlineControl.vue`（渲染 entry.labelKey 文本的占位）
- 组件/测试按**真实路径** import；stub **不 commit**（交付时 git status 干净）；merge 后 maintainer 全量重跑验证真实集成

## 你的产出

### 1. `frontend/src/components/SearchAnything.vue`（新文件，核心）
- **常态**：渲染小放大镜图标按钮（`@lucide/vue` 的 Search 图标，尺寸参考原 topbar 搜索框风格），title 提示「搜索（Cmd+K）」
- **搜索层**（isSearchOpen=true 时显示，Transition 淡入）：
  - 全屏遮罩：fixed inset-0，**z-index 高于一切（含 topbar）**；背景 = `backdrop-filter: blur(16px)` + 半透明遮罩（盖住播放界面 → 实现"播放界面变模糊"；音乐继续播放，不动 audio）
  - 大搜索框：居中偏上（宽 ~640px，移动端全宽），自动聚焦，显示放大镜图标 + 清除按钮 + 防抖 loading 指示（loading 时小 spinner）
  - 结果列表：单列混合列表，每行 = 类别 badge（本地/在线/歌手/专辑/设置，不同配色）+ title + subtitle；**键盘导航**：↑↓ 移动高亮（hover 同步）、Enter 执行、输入框内 ↑↓ 需 preventDefault 防止光标移动
  - 设置行：点击/Enter → 行内展开 InlineControl（entry=payload），再点收起；**同一时间只展开一个**
  - 空态（query 空）：显示全部设置项（按 SETTING_CATEGORIES 分组渲染，分类标题 + 条目列表，可滚动）——设置目录
  - 收起：Esc / 点遮罩空白处 / 点放大镜；收起时 isSearchOpen=false、clear()
- **Cmd+K**：组件挂载时注册 window keydown 监听：`if (e.metaKey && e.code === 'KeyK') { e.preventDefault(); isSearchOpen = !isSearchOpen }`（**默认 Meta+K；若 playbackSettings.searchKey 被用户改过则按改过的判断**——searchKey 存 e.code 风格如 'KeyN'/'Meta+K'，参考 SettingsModal 的 fmtKey 逻辑；简化：只支持默认 Meta+K + searchKey 字段判断，存 'Meta+K' 表示 Cmd+K）；打开时 nextTick 聚焦输入框；组件卸载移除监听
- **移动端**：同一组件全屏覆盖（v-if 同一遮罩），宽度/字号自适应（参考 mobile.css 断点 <1024px）

### 2. 集成点（改动现有文件）
- `frontend/src/App.vue`：topbar 里 `.topbar-search` div（第 32-34 行包着 OnlineSearch）**替换**为 SearchAnything（放大镜入口）；SearchAnything 组件本体（遮罩层）挂载在 App 根部（v-if 由 isSearchOpen 控制，桌面移动共用）；**不要删除 OnlineSearch.vue 文件**（maintainer 收尾处理）
- `frontend/src/components/mobile/MobileHome.vue`：搜索入口（现有 searchEntry 导航 + 内联 OnlineSearch）改为 → 打开全局搜索层（`isSearchOpen = true`）；移除 MobileHome 里的 OnlineSearch 使用（组件文件保留）
- `frontend/src/composables/playerCore.js`：SHORTCUT_HANDLER（~344 行）开头加守卫：`if (isSearchOpen.value) return;`（import { useSearchAnything } from "./useSearchAnything.js"）——防止搜索层打开时 Space/←→/↑↓ 误触播放
- `frontend/src/components/SettingsModal.vue`：快捷键分类（~912 行 section）加「打开搜索」可录制项：
  - 参照现有 karaokeNextKey/karaokePrevKey 录制机制（recording ref + onRecordKeydown，~1240-1265 行）：shortcuts 数组加 `{ keys: [fmtKey(playbackSettings.searchKey)], labelKey: 'settings.shortcutSearch', recordable: 'search' }`，录制时写 `playbackSettings.searchKey = e.code`（默认 'Meta+K'）
  - ⚠️ 注意 Cmd+K 是组合键：录制按单键处理（用户录一个键如 'KeyK' 时，运行时处理 `e.metaKey && e.code === 'KeyK'` 或纯单键，逻辑你定但要和 SearchAnything 的监听一致）
- `backend.py`（前端 clone 里也有，根目录）：PLAYBACK_SETTINGS_DEFAULTS（~155 行）加 `"searchKey": "Meta+K",  # 搜索：打开 search anything`；_SETTINGS_SCHEMA playback 段（~300 行）加 `"searchKey": ("Meta+K", _norm_str),`
- `tests/test_settings.py`：加 searchKey 测试（默认值 / 非法回落默认 / 合法保留）——⚠️ 后端测试跑法：`cd /Users/dax/codes/qqplayer && ./venv/bin/python -m pytest tests/test_settings.py -q`（用主仓库 venv，clone 无 venv）
- i18n：新建 `frontend/src/locales/zh-CN/search.js`（搜索层全部文案：placeholder/清除/加载中/空态提示/分类名/badge 名/设置目录标题/无结果等），加入 index.js 聚合；SettingsModal 新文案（settings.shortcutSearch）加到 settings.js

### 3. 测试：`frontend/src/__tests__/SearchAnything.test.js`
- stub 依赖（vi.mock useSearchAnything / 本地 stub settingsIndex + InlineControl 走真实路径 import）
- 覆盖：放大镜常态渲染 / 点击打开遮罩 / 输入渲染结果行（badge 可见）/ 键盘导航（↑↓ 高亮移动 + Enter 执行）/ Esc 与点空白收起 / 空态显示设置目录分组 / 设置行展开内联控件 / Cmd+K 打开（mock keydown）/ isSearchOpen 时 playerCore 守卫（可放 playerCore 已有测试文件或这里）
- matchMedia 需要时用 installMatchMedia

## 验证标准
- vitest 全绿（含新测试，已有测试不许改）；eslint / prettier 过
- **playwright 冒烟**（截图 /tmp/，脚本放 frontend/ 下）：① 顶栏显示放大镜（无输入框）② 点击或 Cmd+K 打开全屏搜索层、背景可见模糊 ③ 输入"五月天"出现本地歌曲 + 歌手 + 专辑（badge 可见）④ 繁体/英文输入能命中（normalize）⑤ Esc 收起 ⑥ 空态显示设置目录 ⑦ 设置行展开内联开关切换生效 ⑧ 移动端视口（375px）搜索层正常
- 桌面布局零回归（≥1024px：主界面/设置弹窗/播放器/迷你条都正常）

## 红线
- 不删 OnlineSearch.vue（maintainer 收尾处理）；不碰 B/C 产出的真实文件（你的 stub 不 commit）
- 已有测试不改（除 test_settings.py 是**新增** searchKey 用例）
- 桌面行为零回归；移动端新内容要适配

## 交付
- git status 干净（stub 不 commit）；commit 规范（可拆多个：feat(search): ... / feat(backend): searchKey 设置字段 / test(search): ...）；push 到 fork origin 的 feat/search-anything-ui
- 汇报：改动清单（文件级）/ 设计决策（Cmd+K 组合键处理/展开互斥/遮罩层级）/ 测试结果（vitest X passed + pytest searchKey 用例）/ playwright 冒烟结果 / 遗留项——不许假装完成
