# QQPlayer 阅读器 V2 — 并行开发契约总览

> 2026-08-17 定。用户拍板后开工。目标：阅读器从"能看书"升级为"外语学习阅读器"。

## 用户已拍板的需求（逐条，子代理不许猜）

1. **阅读设置**（字体族/字号/行距/页边距/颜色/主题）—— 持久化走**后端 settings**（settings.json books namespace），**禁止 localStorage 存设置**（现有 fontSize localStorage 要迁移到后端）
2. **发音不做系统 TTS**—— 查词/词典相关只**留接口**（后端响应带 audio 字段、前端按钮 disabled 占位），后面再接
3. **查词 = 本地 MDX 词典**（readmdict 库解析 .mdx/.mdd）—— **APP 不预置任何词典**，用户自己加载（支持：指定本地路径 / 上传 mdx+mdd 文件）
4. **高亮/笔记/书签 存后端**（JsonStore 持久化，非 localStorage/IndexedDB）
5. **COCA 词频标注**—— 用户配置了 COCA 词典时，查词弹窗显示词频等级（★）
6. **翻译本次不做**（等用户 AI 模块加入后再定，接口候选 DeepSeek/GLM-4-Flash 已记档）
7. 手机端/NAS 后续再说，架构不阻塞即可（后端 API 天然跨端）
8. 所有新文案进 i18n（frontend/src/locales/zh-CN/books.js + en-US/books.js），代码里禁止硬编码中文

## 任务拆分与批次

| 任务 | fork | 分支 | 内容 | 批次 |
|---|---|---|---|---|
| A 后端存储类 | qqplayerA | feat/reader-backend-core | settings books namespace 扩展 + annotations + vocab API | 第一批（并行） |
| B 后端词典域 | qqplayerB | feat/reader-backend-dict | MDX/MDD 模块 + dict 配置/查询/上传/资源/词频 API | 第一批（并行） |
| C 前端阅读设置 | qqplayerC | feat/reader-frontend-settings | 设置面板 UI + 主题应用 + 字号迁移 | 第一批（并行） |
| D 前端标注+查词 | qqplayerD | feat/reader-frontend-annotations | 高亮/书签/笔记 UI + 查词弹窗 + 生词本 + 词典管理 UI | **第二批**（等 A/B/C 合入，因为都改 Reader.vue） |

## 文件白名单（冲突控制）

- 任务 A 只碰：`app/services/settings.py`（仅 books namespace 字段）、`app/state.py`（books defaults + annotations/vocab store）、`app/routers/annotations.py`(新)、`app/routers/vocab.py`(新)、`tests/`、`docs/reader-v2/`
- 任务 B 只碰：`app/services/settings.py`（仅 dict namespace 字段）、`app/state.py`（dict defaults）、`app/services/dict_reader.py`(新)、`app/routers/dict.py`(新)、`requirements.txt`、`tests/`、`docs/reader-v2/`
- A/B 都会动 `app/services/settings.py` 和 `app/state.py`：**A 只加 books namespace 的 7 个字段；B 只加 dict namespace 的 2 个字段**（不同区域，git 三路合并可自动合并；不得互相覆盖或重构对方区域）
- 任务 C 只碰：`frontend/src/books/Reader.vue`（顶栏按钮 + 设置应用逻辑 + 删 fontSize localStorage）、`frontend/src/books/ReaderSettingsPanel.vue`(新)、`frontend/src/books/settings.ts`(新，可并入 api.ts 则并入)、`frontend/src/locales/zh-CN/books.js`、`frontend/src/locales/en-US/books.js`、`frontend/src/__tests__/Reader.test.ts`、`docs/reader-v2/`
- 任务 D 只碰：`frontend/src/books/`（新组件 + Reader.vue 交互）、`frontend/src/locales/`、`frontend/src/__tests__/`、`docs/reader-v2/`
- 禁止碰：`app/routers/books.py`（书架/进度契约冻结）、`app/routers/settings.py`、`backend.py`、`app/main.py`、`frontend/src/books/Bookshelf.vue` 结构、`frontend/src/books/types.ts`（只允许追加新类型，不允许改已有字段语义）

## 全局技术约束

- 后端：`state.XXX` 模块访问，禁止 from-import 绑定；JsonStore 存数据；settings 校验器模式见 `app/services/settings.py`（_norm_bool/_norm_str/_norm_num 等，新字段必须配校验器）
- settings PUT 是**深合并语义**（save_all_settings 只合并传入字段），新 namespace 自动兼容
- 前端：Vue3 + TS（books 目录是 TS）+ lucide 图标 + vue-i18n；epub.js 渲染
- 测试：后端 pytest（主仓库 venv：`~/codes/qqplayer/venv/bin/python -m pytest`）；前端 vitest；格式 `npx prettier --check "src/**/*.{js,vue}"` + `npx eslint src`；提交前必须过
- 每个任务：commit 规范（feat/fix/docs 前缀，中文描述），push 分支到 origin（fork 的 origin 指向主仓库本地路径）

## 词典文件（用户机器实测）

- 目录：`/Users/dax/Documents/Personal/Dictionary/`（**iCloud 同步目录，文件可能是 dataless 占位——后端打开失败要报清晰错误，提示用户先在 Finder 下载**）
- 可用词典：LDOCE6++ En-Cn V2-19（英汉，ldoce6encn/）、牛津高阶9英汉双解 V3.1.2、牛津高阶8简体、LDOCE6 英英、OALD9 英英、韦氏 mwaled、COCA Frequency 60000（词频表）、汉语大词典
- readmdict 依赖 python-lzo（brew lzo + LDFLAGS/CPPFLAGS 编译，见 02 契约）

## 验收总流程（maintainer 执行）

1. 每任务交付 → review diff（重点：文件白名单外改动、桌面行为零回归）
2. merge --no-ff 到 main → 全量测试（pytest + vitest + build + eslint + prettier）
3. 真实链路 E2E（扩展 ui-books-test.mjs 或新脚本）→ deploy → 用户验收
