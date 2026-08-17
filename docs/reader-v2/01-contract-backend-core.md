# 任务 A：后端存储类 — settings books 扩展 + annotations + vocab

> 工作目录：`~/codes/qqplayerA/`（clone 自主仓库，分支 feat/reader-backend-core）
> 背景：主仓库 `~/codes/qqplayer/`，FastAPI + app/ 包结构。先读 `docs/reader-v2/00-overview.md`。

## 一、交付内容

### 1. settings books namespace 扩展（阅读设置，逐字段）

`app/services/settings.py` 的 `_SETTINGS_SPEC["books"]` 现有 `lastReadId` 一个字段，追加以下 7 个字段（**只允许追加，不允许改 lastReadId 语义**）：

```python
"fontFamily": ("default", lambda v, d: _norm_str(v, d, allowed={"default", "serif", "sans", "rounded"})),
"fontSize": (100, lambda v, d: _norm_num(v, d, lo=70, hi=200, integer=True)),
"lineHeight": (1.6, lambda v, d: _norm_num(v, d, lo=1.0, hi=2.0)),
"margin": (4, lambda v, d: _norm_num(v, d, lo=0, hi=15, integer=True)),
"theme": ("light", lambda v, d: _norm_str(v, d, allowed={"light", "sepia", "dark", "auto"})),
"textColor": ("", _norm_str),
"bgColor": ("", _norm_str),
```

- `state.py` 的 books 相关 defaults 同步（新增 `READER_SETTINGS_DEFAULTS` dict 常量，值同上，放 state.py 供 settings.py 引用——参照现有 LIBRARY_SETTINGS_DEFAULTS 模式；**注意保持默认值单一来源：settings.py 里从 state.READER_SETTINGS_DEFAULTS 取，不要两处手写常量**）
- 主题语义（前端消费，后端只存值不解释）：light 浅色 / sepia 米黄护眼 / dark 深色 / auto 跟随 App 主题；textColor/bgColor 非空 = 自定义颜色覆盖（前端颜色选择器写入）

### 2. annotations 存储 + API（高亮/书签/笔记，按书分组）

**存储**：`app/state.py` 新增 `annotations_store = JsonStore(lambda: ANNOTATIONS_FILE, default={})`，`ANNOTATIONS_FILE = DATA_DIR / "annotations.json"`（参照 books_store 模式，默认 {}）。

**结构**（annotations.json）：
```json
{
  "<bookId>": {
    "highlights": [{"id": "hl_<uuid>", "cfi": "epubcfi(...)", "text": "选中文字", "color": "yellow", "createdAt": 1710000000000}],
    "bookmarks":  [{"id": "bm_<uuid>", "cfi": "epubcfi(...)", "text": "书签标签（如 第 3 页）", "createdAt": 1710000000000}],
    "notes":      [{"id": "nt_<uuid>", "cfi": "epubcfi(...)", "excerpt": "原文摘录", "text": "笔记正文", "createdAt": 1710000000000, "updatedAt": 1710000000000}]
  }
}
```

**API**（新文件 `app/routers/annotations.py`，挂到 app.main.py 的 router 列表——参照其他 router 注册方式；如 app/main.py 禁止碰则改 `app/routers/__init__.py` 或按现状模式注册，先读 main.py 确认）：

- `GET /api/books/{bid}/annotations` → 该书完整 annotations 对象（无则返回 `{"highlights":[],"bookmarks":[],"notes":[]}`）
- `PUT /api/books/{bid}/annotations/highlights` body `{"cfi","text","color"}` → 创建，返回 `{"id": "hl_..."}`；color 校验 allowed `{"yellow","green","blue","pink"}` 非法回落 yellow；text 非空
- `DELETE /api/books/{bid}/annotations/highlights/{hid}` → 204
- `PUT /api/books/{bid}/annotations/bookmarks` body `{"cfi","text"}` → 创建，返回 `{"id":"bm_..."}`；同 cfi 重复创建允许（不去重，前端保证）
- `DELETE /api/books/{bid}/annotations/bookmarks/{bid2}` → 204
- `PUT /api/books/{bid}/annotations/notes` body `{"cfi","excerpt","text"}` → 创建，返回 `{"id":"nt_..."}`；text 允许空串（点开只读摘录）
- `PATCH /api/books/{bid}/annotations/notes/{nid}` body `{"text"}` → 更新 text + updatedAt
- `DELETE /api/books/{bid}/annotations/notes/{nid}` → 204
- 所有写操作：bookId 不存在于 books_store 时返回 404 `{"detail":"book not found"}`；id 用 `uuid4().hex` 前缀（`f"hl_{uuid4().hex}"`）
- 删除/更新不存在的 id → 404

### 3. vocab 生词本存储 + API

**存储**：`app/state.py` 新增 `vocab_store = JsonStore(lambda: VOCAB_FILE, default=[])`，`VOCAB_FILE = DATA_DIR / "vocab.json"`。

**结构**（vocab.json，全局跨书）：
```json
[{"id": "vw_<uuid>", "word": "hello", "context": "原句上下文（书里选中时的句子）", "bookId": "", "bookTitle": "", "cfi": "", "addedAt": 1710000000000}]
```

**API**（新文件 `app/routers/vocab.py`）：
- `GET /api/vocab` → 数组（按 addedAt 倒序，最新在前）
- `POST /api/vocab` body `{"word","context","bookId","bookTitle","cfi"}` → 创建，返回 `{"id":"vw_..."}`；word 必填非空，context/bookId/bookTitle/cfi 允许空串
- `DELETE /api/vocab/{vid}` → 204；不存在 404
- `GET /api/vocab/export` → **text/plain** 下载，格式每行 `word\tbookTitle\tcontext`（tab 分隔，UTF-8，Content-Disposition attachment filename=vocab.txt）；空词表返回 200 空文件

### 4. 测试（tests/ 下，参照现有风格）

- settings：新字段默认值/合法值/非法回落/越界 clamp（fontSize 71/70/200/201、lineHeight 1.0/2.5、theme 非法值、textColor 非字符串）→ pytest 参数化
- annotations：创建/列表/删除/404（book 不存在、id 不存在）/color 非法回落/notes PATCH 更新 updatedAt
- vocab：创建/列表倒序/删除/404/export 格式（含空词表）
- 跑：`~/codes/qqplayer/venv/bin/python -m pytest tests/ -x -q`（**fork 无 venv，用主仓库 venv**，cwd 在 fork）

## 二、技术约束

- 只碰白名单文件（见 overview）；`app/routers/books.py`、`app/routers/settings.py`、`backend.py`、`app/main.py` 禁止改（router 注册若必须动 main.py，改为在 `app/routers/__init__.py` 或现有模式内完成，先读代码确认，**不得改动 main.py 其他逻辑**）
- JsonStore 用法参照 `app/routers/books.py` 里 books_store 的读写模式（`store.data` 读、赋值后 `store.save()`）
- 校验器复用 settings.py 现有 _norm_*；新校验器只在自己文件内加
- 提交前：`~/codes/qqplayer/venv/bin/ruff format --check .` + `ruff check .`（在 fork 跑，venv 用主仓库的）——**这是硬性要求，漏跑会 CI 红**

## 三、交付要求

- commit 规范：`feat(reader): ...` 中文描述，可拆多个 commit
- push 到 origin feat/reader-backend-core
- 汇报格式：改动清单（文件级）/ 测试结果（数量）/ 设计决策 / 遗留项（不许假装完成）
