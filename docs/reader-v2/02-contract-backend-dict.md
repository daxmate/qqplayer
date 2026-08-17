# 任务 B：后端词典域 — MDX/MDD 模块 + dict API

> 工作目录：`~/codes/qqplayerB/`（clone 自主仓库，分支 feat/reader-backend-dict）
> 背景：主仓库 `~/codes/qqplayer/`，FastAPI + app/ 包结构。先读 `docs/reader-v2/00-overview.md`。

## 一、交付内容

### 1. 依赖（requirements.txt 追加）

- `readmdict`（MDX 解析）
- `python-lzo`（readmdict 依赖；**本机编译需要**：`brew install lzo` 后 `LDFLAGS="-L$(brew --prefix lzo)/lib" CPPFLAGS="-I$(brew --prefix lzo)/include" pip install python-lzo`；requirements.txt 只记包名，编译环境在文档注释里说明）

### 2. settings dict namespace（`app/services/settings.py` 只加这个 namespace，2 个字段）

```python
"dict": {
    "dictionaries": (list, _norm_dict_list),   # 词典配置数组，见下
    "activeDictId": ("", _norm_str),
},
```

`_norm_dict_list` 校验器（在 settings.py 内新增）：list 中每项 dict 必须含 `id`(str)/`name`(str)/`path`(str)；非法项丢弃；过滤后保留原顺序；空列表合法。

**词典配置项结构**（存 settings.json dict.dictionaries）：
```json
{"id": "d_<uuid>", "name": "LDOCE6++ En-Cn", "path": "/abs/path/to/xxx.mdx", "kind": "local", "role": "define", "enabled": true, "addedAt": 1710000000000}
```
- `kind`: `"local"`（用户填的本地路径）| `"uploaded"`（上传到 DATA_DIR/dicts/ 的文件）
- `role`: `"define"`（释义词典）| `"frequency"`（词频词典）；**自动检测：文件名（不含扩展名）含 "coca" 或 "frequency"（大小写不敏感）→ role="frequency"，否则 "define"**
- `state.py` 加 `DICT_SETTINGS_DEFAULTS = {"dictionaries": [], "activeDictId": ""}`（供 settings.py 引用，单一来源）

### 3. MDX/MDD 封装（新文件 `app/services/dict_reader.py`）

```python
class MdxDict:
    def __init__(self, path: str): ...      # 打开 mdx（同目录同名 .mdd 自动挂载）
    @property
    def name(self) -> str                    # 文件名去扩展名
    def lookup(self, word: str) -> str | None  # 词条 HTML（str），未命中 None
    def lookup_variants(self, word: str) -> str | None  # 变形兜底：s/es/ies/ed/ing/er/est/ly/d（简单规则，命中即返回）
    def resource(self, relpath: str) -> bytes | None    # mdd 内资源（css/js/img/音频），无 mdd 或无资源返回 None
    def has_mdd(self) -> bool
```

实现要点：
- `from readmdict import MDX, MDD`；`word in mdx` 判断命中，`mdx[word][0][1]` 取 HTML bytes（utf-8 解码 errors="ignore"）
- keys 遍历用 `mdx._key_list`（内部属性，若版本不同则遍历 `mdx.keys()`——以实测为准）
- **大词典打开慢（LDOCE6++ 等），`lookup` 首次调用时才懒初始化**（内部 `_ensure_loaded()`）；索引构建结果缓存到模块级 dict（key=path），并提供 `clear_cache()`（测试用）
- `resource()`：MDD 用 `mdd[path_bytes]` 查；路径规范化（去前导 `/`、`\` 转 `/`）
- 词条 HTML 里常见引用：`<link href="xxx.css">`、`<img src="xxx.gif">`、`sound://xxx.mp3`、`file:///...` —— **本任务不重写 HTML**（前端渲染时处理），resource() 只负责按路径取字节

### 4. dict API（新文件 `app/routers/dict.py`）

router 注册方式参照任务 A 说明（先读 `app/main.py` 确认，尽量不动 main.py 逻辑）。

- `GET /api/dict` → `{"dictionaries": [...], "activeDictId": "..."}`（settings 原样返回）
- `POST /api/dict/scan` body `{"path": "/abs/path"}` → 扫描路径（文件或目录，目录递归一层即可）：找 `.mdx` 文件，返回候选列表 `[{"path": "...", "name": "文件名", "size": 123, "mddExists": true}]`；路径不存在 404 `{"detail":"path not found"}`；无 mdx 返回空数组
- `POST /api/dict` body `{"path": "/abs/xxx.mdx", "name": "可选覆盖名"}` → 添加词典配置（kind="local"，role 自动检测），重复 path 返回 409 `{"detail":"already added"}`；path 不是 .mdx 或文件不存在 400；返回完整配置项
- `POST /api/dict/upload`（multipart，字段名 `file`）→ 流式写入 `DATA_DIR/dicts/<uuid>.<ext>`（mdx 或 mdd；**必须流式 `await file.read(1MB)` 循环写，禁止整文件读内存**——牛津 mdd 可能 1GB+）；mdx 上传后配置项 kind="uploaded" 并加入 dictionaries；mdd 上传时若已有同名 mdx 的配置项则补全其 mdd（按上传文件名匹配，如 `xxx.mdd` 匹配 name=xxx 的配置）；返回配置项或 `{"ok": true}`
- `POST /api/dict/activate` body `{"id": "d_xxx"}` → 设置 activeDictId；id 不存在 404
- `PATCH /api/dict/{id}` body `{"enabled": bool}` → 启停切换；404 不存在
- `DELETE /api/dict/{id}` → 204；kind="uploaded" 时同时删除 DATA_DIR/dicts/ 下对应文件；activeDictId 被删则清空
- `GET /api/dict/query?word=hello&dictId=d_xxx` → 
  ```json
  {"word": "hello", "found": true, "html": "<词条HTML>", "source": "LDOCE6++ En-Cn", "audio": [{"label": "英", "url": "/api/dict/resource/d_xxx/sound.mp3"}], "frequency": null}
  ```
  - dictId 缺省用 activeDictId，再缺省用第一个 enabled 的 define 词典；没有可用词典 → 200 `{"found": false, "html": "", "source": "", "audio": [], "frequency": null, "error": "no dictionary configured"}`
  - lookup 未命中 → 尝试 lookup_variants → 仍无 `{"found": false, "html": "", ...}`
  - audio：解析词条 HTML 中的 `sound://xxx` / `src="xxx.mp3"` 引用（mdd 内存在该资源），最多 2 个；**发音后续再接，这里只把 URL 暴露出来**
  - frequency：若存在 enabled 且 role="frequency" 的词典（自动取第一个），查词频返回 `{"rank": 123, "total": 60000}`，未命中 null
- `GET /api/dict/resource/{dict_id}/{path:path}` → mdd 资源字节，正确 Content-Type（.css text/css、.js application/javascript、.jpg/.jpeg image/jpeg、.png image/png、.gif image/gif、.mp3 audio/mpeg、.svg image/svg+xml、.woff/.woff2 font、其余 application/octet-stream）；不存在 404；词典不存在 404
- `GET /api/dict/frequency?word=hello` → `{"rank": 123, "total": 60000}` 或 `{"rank": null, "total": null}`（无 frequency 词典/未命中）

### 5. 测试（tests/）

- 造测试数据：**不依赖用户词典目录**。用脚本生成最小 mdx（readmdict 支持创建吗？——readmdict 只读。用 `mdict-utils` 或直接写最小 mdx 二进制？**简化：测试用 monkeypatch**，dict_reader 的 lookup 打桩；或者 tests 里生成最小 MDX 文件——先读 readmdict 源码看有没有写支持，没有就 stub**。以 stub 为主，契约行为测试走 router 层 patch）
- dict_reader：打开真实小词典（tests/fixtures/ 下放一个生成的最小 mdx？若 readmdict 无写能力则跳过，用 monkeypatch 覆盖）
- router：scan（存在/不存在路径）、add（成功/重复/非法 path）、activate（成功/404）、query（found/miss/variants/无词典/audio 提取/frequency）、resource（存在/404/Content-Type）、upload（小文件 mdx+mdd 流式）
- 注意：settings dict namespace 校验器测试（合法/非法项过滤）

## 二、技术约束

- 文件白名单见 overview（A 也动 settings.py/state.py，**你只允许加 dict namespace 的 2 个字段 + DICT_SETTINGS_DEFAULTS，不得碰 books namespace 和现有字段**）
- 打开词典失败（文件不存在/权限/dataless iCloud 占位——实测读 dataless 文件报 `OSError: [Errno 11] Resource deadlock avoided`）→ query 返回 200 + `{"found": false, "error": "dict load failed: <原因>"}`，**不要 500**
- 懒加载 + 模块级缓存（dict_reader.py 内 `_CACHE: dict[str, MdxDict]`），并发读安全（构建时加锁 threading.Lock，简单即可）
- 提交前 ruff format + ruff check（用主仓库 venv `~/codes/qqplayer/venv/bin/ruff`）——硬性要求

## 三、交付要求

- commit：`feat(reader): ...` 中文描述
- push origin feat/reader-backend-dict
- 汇报：改动清单/测试结果/设计决策/遗留项（不许假装完成）
- **验证环境**：主仓库 venv 已装好 readmdict + lzo；fork 里 `~/codes/qqplayer/venv/bin/python -m pytest tests/ -x -q`（cwd 在 fork）
- 可选真实冒烟（词典已下载完时）：`/Users/dax/Documents/Personal/Dictionary/ldoce6encn/LDOCE6++ En-Cn V2-19.mdx` 查 hello 应命中
