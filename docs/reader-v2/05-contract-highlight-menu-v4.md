# 任务 V4：iBooks 式高亮菜单 + 书内搜索

> 目标：图书阅读器选中文字后的菜单改为 iBooks 式布局（顶部一行色点常驻 + 下方功能列表），新增紫色/下划线标注、点击高亮弹菜单（换色/移除）、书内搜索。
>
> 用户拍板（2026-08-18）：① 色板对齐 iBooks（5 色 + 下划线）；② 菜单形态照 iBooks；③ 翻译不做（macOS 系统菜单已有）；④ 书内搜索要做；⑤ 共享/语音不做（macOS 内置）；⑥ 点击已有高亮弹菜单（换色/移除）要做；⑦ Swift 壳内保持系统右键菜单现状，不改壳。
>
> 浏览器端（HTML 菜单）功能清单：**5 色点（黄/绿/蓝/粉/紫）+ U 下划线**（顶行）+ 功能列表 **添加笔记 / 移除（选中已有高亮时）/ 查询「词」（仅单词选中时）/ 搜索 / 拷贝**。翻译、共享、语音不做。

## 一、共享契约（maintainer 已落地于主干，三个子代理在其上开发）

### 1. 类型（`frontend/src/books/types.ts`，已改）

- `HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple"`（UI 五色）
- 新增 `HighlightStyle = "highlight" | "underline"`
- `HighlightAnnotation` 加 `style: HighlightStyle`；`color` 类型扩为 `HighlightColor | "red"`（underline 固定 "red"）
- 新增 `BookSearchResult { href, chapterTitle, sentence, cfi, matchStart, matchEnd }` + `BookSearchResponse { query, results }`

### 2. API 层（`frontend/src/books/annotations.ts`，已改）

- `HIGHLIGHT_COLOR_STYLES` / `HIGHLIGHT_COLOR_HEX` 加 `purple: #b388ff`
- 新增 `UNDERLINE_COLOR = "red"`、`UNDERLINE_STYLE = { stroke: "#e5484d", "stroke-width": "2" }`
- `createHighlight(bookId, {cfi, text, color, style?})`（style 缺省 "highlight"）
- 新增 `searchBook(bookId, query): Promise<BookSearchResponse>` → `GET /api/books/{bid}/search?q=`

### 3. 后端契约（`docs/reader-v2/01-contract-backend-core.md` 第五节，已写）

- 高亮 color 白名单扩为 `{yellow,green,blue,pink,purple,red}`，非法回落 yellow；新增 `style` 字段（`{highlight,underline}`，缺省/非法回落 highlight）；GET 返回时旧数据规范化补 `style:"highlight"`
- 新增 `GET /api/books/{bid}/search?q=`：index.json 句子级大小写不敏感匹配，上限 100 条，返回 `{query, results[]}`，`cfi` 为句子起始 CFI（必须能被 epub.js display 定位）；q 空/超 100 → 400；无 index → 空 results

## 二、三个子代理分工（并行，各自独立 git worktree）

### Agent A — 后端（分支 `feat/reader-hlmenu-backend`）

- `app/routers/annotations.py`：`_HIGHLIGHT_COLORS` 加 purple/red；高亮创建/读取支持 `style`；GET 规范化旧数据
- 新增书内搜索接口 `GET /api/books/{bid}/search`（可放 `app/routers/books.py` 或 annotations.py，按现状结构）
  - cfi 生成：zipfile 重开 book.epub，spine 顺序解析 XHTML，提纯逻辑与 `app/services/book_import.py::_build_index` 一致，句子映射回原文文本节点，按 CFI 规范生成
- 测试：`tests/test_annotations.py` 补 style/purple 用例；新增 `tests/fixtures/mini.epub`（手写最小 EPUB）+ `tests/test_book_search.py`

### Agent B — 前端菜单（分支 `feat/reader-hlmenu-frontend`）

- `frontend/src/books/SelectionToolbar.vue` 重做：iBooks 式（顶行 5 色点 + U 按钮；下方功能列表：添加笔记 / 移除（选中 cfi 已有高亮时显示）/ 查询（选中为单词时显示）/ 搜索 / 拷贝）。拷贝用 `navigator.clipboard`；点击后清选区收起
- 新建点击高亮弹菜单（iBooks 式小菜单：5 色换色 + U 切换 + 移除 + 添加笔记）：epub.js marks 点击检测（调研 `rendition.annotations` mark 事件 / contents click + `e.target.closest(".epubjs-hl")` 取 cfi/id），Reader.vue 集成
- Reader.vue：`addHighlight` 支持 style（underline 用 `annotations.add("underline", ...)` + `UNDERLINE_STYLE`）；`removeHighlight` 按 `h.style` 传 `"highlight"|"underline"` 给 `annotations.remove`；换色 = 删除重建（后端无 PATCH）；工具栏 emit 契约扩展（search/copy/remove）
- `AnnotationPanel.vue`：高亮色点支持 5 色；下划线条目样式区分（图标/标记）
- 测试：`frontend/src/__tests__/ReaderAnnotations.test.ts` 等补用例；跑 vitest

### Agent C — 前端搜索（分支 `feat/reader-search-frontend`）

- 新建 `frontend/src/books/SearchPanel.vue`：侧滑/弹层面板，输入框（预填选中词）+ 结果列表（章节标题 + 句子，命中词高亮）+ 点击结果跳转（`rendition.display(cfi)` + 临时高亮命中词）+ 空态/加载态
- Reader.vue 集成：搜索打开/关闭 state（顶栏搜索按钮 + 菜单"搜索"项都触发）、`@jump` 处理、临时高亮（搜索态用一次性 `annotations.add`，跳转/关闭时清理）
- 测试：组件单测（mock fetch）+ 真实链路验证

## 三、共同约束

- **先读 `docs/reader-v2/00-overview.md`**（文件白名单/既有约定）；epub.js API 以 `frontend/package.json` 实际版本为准
- 文案走 i18n（`frontend/src/locales/zh-CN/books.js` + en-US）
- 提交前：后端 `ruff format --check .` + `ruff check .`；前端 prettier + eslint（QQPlayer 有 git pre-commit hook 强制）
- commit 中文描述（`feat(reader): ...`），push 到各自分支，**不碰 main**；merge 由 maintainer 做
- 汇报：改动清单 / 测试结果 / 设计决策 / 遗留项；**不许假装完成**，每项功能真实跑通
