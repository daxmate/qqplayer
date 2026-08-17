# 任务 D：前端标注 + 查词 + 生词本 + 词典管理 UI

> 工作目录：`~/codes/qqplayerD/`（clone 自主仓库，分支 feat/reader-frontend-annotations）
> **第二批任务**：等 A/B/C 合入 main 后 spawn（fork 基线 = 最新 main）。先读 `docs/reader-v2/00-overview.md` + 01/02/03 契约（后端 API 形状以 A/B 契约为准，前端设置以 C 契约为准）。

## 一、后端 API（任务 A/B 已实现，按此调用）

- annotations：`GET /api/books/{bid}/annotations`；`PUT /api/books/{bid}/annotations/highlights {cfi,text,color}`→`{id}`；`DELETE .../highlights/{hid}`；`PUT .../bookmarks {cfi,text}`；`DELETE .../bookmarks/{id}`；`PUT .../notes {cfi,excerpt,text}`；`PATCH .../notes/{id} {text}`；`DELETE .../notes/{id}`（全 204/404 语义见 01 契约）
- vocab：`GET /api/vocab`；`POST /api/vocab {word,context,bookId,bookTitle,cfi}`→`{id}`；`DELETE /api/vocab/{id}`；`GET /api/vocab/export`（txt 下载，`word\tbookTitle\tcontext`）
- dict：`GET /api/dict`；`POST /api/dict/scan {path}`；`POST /api/dict {path,name?}`；`POST /api/dict/upload`（multipart file）；`POST /api/dict/activate {id}`；`PATCH /api/dict/{id} {enabled}`；`DELETE /api/dict/{id}`；`GET /api/dict/query?word=&dictId=`；`GET /api/dict/resource/{dictId}/{path}`；`GET /api/dict/frequency?word=`
- 高亮颜色：yellow/green/blue/pink

## 二、交付内容

### 1. 选中工具栏（新组件 `frontend/src/books/SelectionToolbar.vue`）

- 阅读区选中文字（mouseup，选中非空且跨 1 个字符以上）→ 选中区域上方/下方悬浮工具条（箭头定位，参照网页阅读器惯例；位置计算：getBoundingClientRect，越界翻转）
- 按钮：**查词**（lucide `BookOpen`/`Search`）、**高亮**（`Highlighter`，点开 4 色小圆点选择）、**笔记**（`StickyNote`）、（书签在顶栏，不在工具栏）
- 点击按钮后清空选区并收起工具栏
- 选中文字为空/失焦 → 收起；滚动/翻页时收起
- 事件由 Reader.vue 统一挂载（props/emit 契约：`props {x, y, visible}`，`emit("lookup", text)`, `emit("highlight", text, color)`, `emit("note", text)`）

### 2. 高亮（epub.js annotations + 后端持久化）

**epub.js annotations API 预研结论（maintainer 实测 0.3.93 源码，直接照此实现）**：
- `rendition.annotations.add("highlight", cfiRange, data, cb, className, styles)` — **styles 直接传内联 CSS 对象**（如 `{ backgroundColor: "#fff59d" }`），无需 themes.register；返回 annotation 对象
- `rendition.annotations.remove(cfiRange, "highlight")` — **按 cfiRange 删除**（不是 id）→ 后端存的 cfi 必须与 add 时完全一致
- **章节切换自动重放**：hooks.render 已注册 inject，按 spinePos 分组，切章/翻页自动重新 attach（无需手动监听 rendered）
- 点击高亮无内置事件：需监听 contents click + cfi 范围判断；实现成本高可降级为仅列表删除（契约允许）
- 后端返回的 annotations 重放：打开书时 `GET /api/books/{bid}/annotations` → 逐条 add；删除本地用 remove(cfi, "highlight") + 后端 DELETE

### 3. 书签

- 顶栏书签按钮（lucide `Bookmark`，active 态）：点击 → 当前页 `rendition.currentLocation().start.cfi` 存书签（text 用"第 N 页"或章节标题+进度，前端生成）
- 列表 + 点击跳转（`rendition.display(cfi)`）

### 4. 笔记

- 选中 → 工具栏"笔记" → 弹输入框（modal 或 inline popover，带原文摘录展示）→ 保存 `PUT .../notes {cfi, excerpt, text}`
- 笔记列表（AnnotationPanel）：摘录 + 正文，可编辑（PATCH）/删除（DELETE），点击跳转 cfi
- 正文中的笔记锚点：高亮式下划线标注（可选，P0 可用列表代替）

### 5. 标注侧栏（新组件 `frontend/src/books/AnnotationPanel.vue`）

- 顶栏按钮（lucide `Highlighter` 或 `Library`）打开右侧滑出抽屉（参照目录抽屉模式），两个 tab：**标注**（高亮+书签+笔记分节，或统一列表带类型图标）/**生词本**
- 标注 tab：三类条目列表，每条：类型图标 + 摘录/标签 + 跳转按钮 + 删除（高亮带色点，笔记可编辑）
- 生词本 tab：`GET /api/vocab` 列表（word + bookTitle + context），删除按钮，"导出 txt"按钮（`window.open('/api/vocab/export')` 或 a[download] 触发下载）
- 空态文案

### 6. 查词弹窗（新组件 `frontend/src/books/DictLookupModal.vue`）

- 选中 → 工具栏"查词" → 弹窗（居中 modal，宽 ~480px，高 ~60vh 可滚动）
- 顶部：查的词 + **词典切换下拉**（`GET /api/dict` 的 enabled define 词典列表，切换重新 query，默认 activeDictId）+ **发音按钮（disabled + 锁图标 title="发音功能开发中"——留接口，不做系统 TTS）**
- 正文：**sandbox iframe 渲染词条 HTML**（`srcdoc` 注入 + 资源 URL 重写）
  - HTML 资源重写规则：`src="xxx"` / `href="xxx.css"` 相对路径 → `/api/dict/resource/<dictId>/<path>`（sound://xxx → 同上）；`<script>` 标签剔除（sandbox 无脚本权限，但显式剥离防意外）；`<base>` 注入不适用 srcdoc，用字符串替换
  - iframe sandbox 属性：`sandbox="allow-same-origin"`（无 allow-scripts）
  - 词典 HTML 自带 `<style>` 保留（排版靠它）
- 词频徽标：query 响应 frequency 非空时显示 ★ 等级（rank/total 映射：≤1000 ★★★★★ / ≤5000 ★★★★ / ≤15000 ★★★ / ≤30000 ★★ / 其余 ★，title 显示 "COCA 词频 #rank/total"）
- 底部：**"加入生词本"按钮**（POST /api/vocab，word=查的词，context=选中的原句，bookId/cfi 由 Reader 传入；成功后按钮变"已加入"disabled + toast）
- 未命中/无词典：友好空态（无词典时提示"设置 → 词典管理 添加词典"并给跳转入口）
- 查词历史不做（P0）

### 7. 词典管理（新组件 `frontend/src/books/DictManagerModal.vue`）

- 入口：Bookshelf.vue 顶栏"词典"按钮（lucide `BookMarked`/`Library`），弹窗管理
- 内容：
  - 已添加词典列表：name + 路径 + role 徽标（释义/词频）+ enabled 开关 + 设为默认（radio/按钮，标 activeDictId）+ 删除
  - **添加方式 1（本地路径）**：路径输入框 + "扫描"按钮（`POST /api/dict/scan`，展示候选列表点选添加）——或直接输入 mdx 路径添加
  - **添加方式 2（上传）**：`<input type="file">` 选 .mdx/.mdd → `POST /api/dict/upload`（FormData；**大文件上传要显示进度条**，fetch 无进度事件，用 XMLHttpRequest 实现上传进度，或先不做进度只转圈——优先 XHR 进度，成本低）；提示"先传 .mdx 再传同名 .mdd"
  - 提示文案：词典需先下载到本地（iCloud 未下载的文件无法读取）
- 手机端入口：MobileBooks.vue 也加（第二批次内可降级：仅桌面端入口，汇报说明）

### 8. 测试

- 组件单测（mock fetch + mock epubjs，参照现有 Reader.test.ts mock 模式）：SelectionToolbar 显示/收起/emit；DictLookupModal 查询渲染/词典切换/加入生词本/空态；AnnotationPanel 列表/删除/跳转；DictManagerModal 列表/扫描/上传/启停/删除
- **真实链路 E2E（硬性要求，参照 `frontend/ui-books-test.mjs` 模式新建 `frontend/ui-reader-v2-test.mjs`）**：起主服务（deploy 后或本地 uvicorn）→ 浏览器打开书架 → 导入最小 epub → 打开书 → 脚本化选中文字（execCommand 或 dispatchEvent）→ 断言查词弹窗出现（无词典时显示空态）→ 手动配一个词典（用 tests 生成的最小 mdx fixture，或跳过查词部分）→ 高亮流程（选中→加高亮→刷新页面断言高亮仍在→列表删除）→ 书签/笔记增删 → 生词本加入/导出
- 跑：vitest + eslint + prettier + build

## 三、技术约束

- 文件白名单见 overview；**禁碰**：Bookshelf.vue 可加按钮但不动其结构（顶部工具条加一项）、Reader.vue 现有逻辑零回归（翻页/目录/进度/设置面板）
- epub.js 版本先读 package.json；annotations API 签名以安装版本实测为准
- 文案全走 i18n（zh-CN + en-US books.js 追加键）
- 后端失败一律 toast（复用现有 toast 体系，先读 App.vue/ToastContainer 用法）

## 四、交付要求

- commit：`feat(reader): ...` 中文描述
- push origin feat/reader-frontend-annotations
- 汇报：改动清单/测试结果（单测+E2E）/设计决策（含降级项）/遗留项
- **不许假装完成**：每项功能必须真实跑通（E2E 或截图证明）
