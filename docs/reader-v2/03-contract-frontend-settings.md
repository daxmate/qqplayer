# 任务 C：前端阅读设置面板 + 主题应用 + 字号迁移

> 工作目录：`~/codes/qqplayerC/`（clone 自主仓库，分支 feat/reader-frontend-settings）
> 背景：主仓库 `~/codes/qqplayer/`，Vue3 + Vite + TS + lucide + vue-i18n，epub.js 渲染。先读 `docs/reader-v2/00-overview.md`。

## 一、现状（先读代码确认）

- `frontend/src/books/Reader.vue`（525 行）：顶栏（返回/书名/目录/字号±10%/翻页）+ epub.js 挂载 + 左右点击翻页热区 + 目录抽屉
- 字号现存在 **localStorage `qqplay…Size`**（70~200，默认 100），`bumpFontSize(±10)` 调整
- `frontend/src/books/api.ts`：已有 `getLastReadBookId`/`setLastReadBookId` 走 `/api/settings`（GET 读、PUT 深合并写）——**沿用同一模式读写阅读设置**
- 后端契约（任务 A 实现，你按契约 mock 编码）：settings.json `books` namespace 追加 7 字段：`fontFamily`(default|serif|sans|rounded, 默认 default)、`fontSize`(70-200 int, 默认 100)、`lineHeight`(1.0-2.0, 默认 1.6)、`margin`(0-15 int, 默认 4)、`theme`(light|sepia|dark|auto, 默认 light)、`textColor`(str 空=主题默认)、`bgColor`(str 空=主题默认)
- i18n：`frontend/src/locales/zh-CN/books.js` + `en-US/books.js`，现有键结构先读

## 二、交付内容

### 1. 阅读设置面板（新组件 `frontend/src/books/ReaderSettingsPanel.vue`）

- 顶部工具栏按钮（Reader.vue 顶栏加 gear 图标按钮，lucide `Settings2` 或 `Palette`）→ 打开面板（右侧滑出抽屉，参照现有目录抽屉的 Transition/遮罩模式）
- 面板内容：
  - **字体**：字体族 4 选（默认/衬线/无衬线/圆体），图标或下拉；字号 - / 百分比 / +（复用现有 ±10 逻辑但写回后端）
  - **行距**：滑杆或 -/+（1.0~2.0 步进 0.1），显示当前值
  - **页边距**：滑杆或 -/+（0~15 步进 1，单位 px 展示）
  - **主题**：4 卡片单选（浅色/米黄/深色/跟随系统），每个带色块预览
  - **颜色**：正文颜色 + 背景颜色 两个颜色选择器（`<input type="color">`），选择后写入 textColor/bgColor（即自定义覆盖）；提供"恢复主题默认"按钮清空 textColor/bgColor
- 所有控件改动 → 防抖 300ms PUT `/api/settings`（`{"books": {...}}` 深合并），失败静默（参照 setLastReadBookId 的 catch 模式）；**localStorage 只读不写**

### 2. 设置应用到 epub.js（Reader.vue）

- 打开书时读一次 `/api/settings` 拿 books 阅读设置（可并入现有初始化），存本地 reactive
- 应用（epub.js rendition.themes API）：
  - 字体族：`rendition.themes.font(family)`（default → 不调用或恢复默认；serif→`"Georgia, serif"`、sans→`"Helvetica, Arial, sans-serif"`、rounded→`"Avenir Next Rounded, Arial Rounded MT Bold, sans-serif"`）
  - 字号：`rendition.themes.fontSize(fontSize + "%")`
  - 行距：`rendition.themes.override("line-height", lineHeight + "")`（作用到 p/body，实测哪个生效用哪个，可 `override("body", ...)` 组合）
  - 页边距：`rendition.themes.override("body", \`margin: 0 ${margin}px\`)` 或 wrapper padding（实测）
  - 主题色：按 theme 取预设对（light `#1f2328`/`#ffffff`；sepia `#5b4636`/`#f5ecd9`；dark `#c8ccd4`/`#1f2430`；auto 跟随 App 主题——读现有 theme 设置 `uiSettings.theme`，dark→dark 预设、light→light 预设），textColor/bgColor 非空时覆盖预设；用 `rendition.themes.override("color", ...)` + `override("background", ...)`（background 要同时盖 iframe 内容区背景，实测若只盖 body 不够则 `rendition.themes.default({...})` 或容器 css）
- 设置变化时实时应用（watch settings reactive，不需要重新加载书）
- **迁移**：删除 Reader.vue 中 localStorage 字号逻辑（FONT_KEY 读/写），初始化时若 localStorage 有旧值且后端无自定义（fontSize 仍是默认 100 且 localStorage 有值）→ 用 localStorage 值 PUT 一次后端并清除 localStorage（一次性迁移）；否则直接走后端值

### 3. 测试

- Reader.test.ts 更新（mock 现有模式）：设置面板打开/关闭、控件修改触发 PUT（fetch mock 断言 body）、字号 localStorage 迁移逻辑（有旧值→PUT+清除；无旧值→用后端值）
- 新组件测试：ReaderSettingsPanel 渲染 + 控件 emit/写回
- 跑：`npx vitest run`（或项目现有脚本，先读 package.json）；`npx eslint src` + `npx prettier --check "src/**/*.{js,vue}"`

## 三、技术约束

- 文件白名单见 overview；**不碰** Bookshelf.vue / BooksView.vue / MobileBooks.vue / types.ts 已有字段
- 桌面行为零回归：现有翻页/目录/进度逻辑不动
- 文案全走 i18n（zh-CN + en-US 各加一组键，如 books.fontFamily / books.theme / books.lineHeight / books.margin / books.textColor / books.bgColor / books.settings 等，命名风格跟随现有 books.js 键）
- 禁 localStorage 存新设置（只允许一次性迁移的读+清除）

## 四、交付要求

- commit：`feat(reader): ...` 中文描述
- push origin feat/reader-frontend-settings
- 汇报：改动清单/测试结果/设计决策/遗留项
- 验证：vite dev（`npm run dev` 5173 proxy 到主服务）手动验证设置面板 + 主题应用效果，playwright 截图存 /tmp 可加分
