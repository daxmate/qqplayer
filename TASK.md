# TASK: 标签刮削器 — 后端（tag scraper backend）

> 工作目录：`~/codes/qqplayerA`（fork，origin 指向主仓库 `~/codes/qqplayer`）
> 分支：`feat/tag-scraper-backend`（已创建）
> 只动后端 + 后端测试；**禁止碰 frontend/ 任何文件**

## 项目背景

QQPlayer 外语学习媒体播放器（FastAPI 后端 `backend.py` 单文件 ~1500 行 + `netease_provider.py` + `lyric_fetch.py`）。端口 17627，launchd 托管。当前 main = `7c72ba7`，后端 pytest 142 全绿，ruff 全过。

关键现有设施（直接复用，别重造）：
- `netease_provider.py`：`NeteaseProvider.search(query, limit=20) -> [{id, title, artist(逗号连接), album, cover(URL或None), duration("mm:ss"), level}]` — eapi 加密官方接口
- `backend.py` `extract_tags(f: Path) -> (artist, title, album)`（mutagen 读，1178 行附近）
- `backend.py` `_sanitize_filename(name) -> str`（995 行附近，清洗非法字符）
- `backend.py` `_load_favorites/_save_playlists/_load_playback` 等（路径引用数据结构见下）
- 封面接口 `/api/cover`（读内嵌 APIC/covr + 文件夹 cover.jpg）

## 需求（用户已拍板，逐条实现，不许自由发挥）

1. **刮削多源候选**：`POST /api/tags/scrape` 同时查网易云 + MusicBrainz，返回两组候选
2. **写标签**：`POST /api/tags` 用 mutagen 写回歌名/歌手/专辑/封面（原子写，写坏不损坏原文件）
3. **改名统一**：保存标签时文件名统一为 `{artist} - {title}.{ext}`（artist 为空则 `{title}.{ext}`）；网易云候选标题自带版本后缀（如 `安静 (Live)`），天然保留版本标注；目标文件名已存在 → 加 ` (2)`/` (3)` 序号，绝不覆盖
4. **引用迁移**：改名后迁移所有旧路径引用（favorites / playlists / playback 三个数据文件里的 path 字段）
5. **封面 fallback 链**：网易云 cover → iTunes Search API → Cover Art Archive → 空。**在 scrape 返回前就补好**，前端直接展示 cover 字段，不感知 fallback

## API 契约（写死，与前端 TASK 完全一致，不许改形状）

### POST /api/tags/scrape

```jsonc
// request
{ "path": "/绝对/路径/歌曲.mp3" }
// 200 response
{
  "query": "刮削关键词（后端自己定：当前标签 title 优先，空则文件名 stem）",
  "netease": [
    { "id": "数字字符串", "title": "安静 (Live)", "artist": "周杰伦", "album": "专辑名", "cover": "https://...或null", "duration": "04:30" }
  ],
  "musicbrainz": [
    { "title": "...", "artist": "...", "album": "...", "cover": "https://...或null", "mbid": "recording MBID" }
  ]
}
// 错误：404 文件不存在；500 异常。两边候选都可能为空数组（搜不到），不是错误。
```

### POST /api/tags

```jsonc
// request（title/artist/album 至少一个非空；cover_url 可选=空则不碰封面；不传 rename 字段）
{ "path": "/绝对/路径/歌曲.mp3", "title": "安静", "artist": "周杰伦", "album": "专辑名", "cover_url": "https://...或null" }
// 200 response
{
  "path": "新绝对路径（改名后）",   // 未改名 = 原路径
  "name": "新歌名",                 // 写标签用的 title（或标签读取回退文件名 stem）
  "artist": "周杰伦",
  "album": "专辑名",
  "renamed": true,                  // 是否发生了文件改名
  "newPath": "改名后的绝对路径"      // 未改名时 == path
}
// 错误：400 全空/非法格式不支持写；404 文件不存在；409 写失败（原子写失败等）
```

**写标签语义**（后端决定，前端不传）：
- 每次保存都重命名：`{artist} - {title}.{ext}`（清洗后），除非目标名 == 当前文件名
- cover_url 非空 → 下载（httpx）写入内嵌封面；下载失败 → 忽略封面继续写文本标签（不报错）
- 支持格式：MP3（ID3v2）、M4A/MP4（MP4 tags + covr）、FLAC（VorbisComment + picture）；OGG/OPUS → 只写文本标签，封面跳过；WAV/AAC 等其他 → 400「该格式不支持写标签」
- **原子写**：先 `shutil.copy2` 到同目录临时文件 → mutagen 改临时文件 → `os.replace(tmp, original)`；任何一步失败原文件保持完好

**改名引用迁移**（重要）：改名前先记录旧绝对路径，rename 成功后把以下三处数据文件中的旧路径替换为新路径并保存：
- `favorites.json`（`_load_favorites` 返回的 list[str]）
- `playlists.json`（`songPaths` 数组）
- `playback.json`（每条记录的 `path` 字段）

## 技术约束

- 网易云复用 `netease_provider.py` 的 `search()`；**不要改 netease_provider.py 现有函数签名/返回结构**（其他功能在用）
- 刮削候选不做合并去重（两组并列展示，前端自己选）
- MusicBrainz 必须带自定义 User-Agent（如 `QQPlayer/1.0 (https://github.com/daxmate/qqplayer)`），否则 403；请求频率低频（每次调用前 sleep 1s 即可）
- MusicBrainz 封面：recording 的 release 列表取第一个有 `id` 的 release MBID → `https://coverartarchive.org/release/{mbid}/front`（404 就 cover=null，不报错）
- iTunes fallback：`https://itunes.apple.com/search?term={title}+{artist}&media=music&limit=5`，取 `results[0].artworkUrl100` 换成 `artworkUrl600` 拿高清
- httpx 请求全部 try/except，**任何外部源挂掉都不影响其他源**（单源失败返回空数组，整体不 500）
- 新代码放哪：写标签+改名+迁移逻辑建议放 backend.py 新增函数区（或新模块 `tag_editor.py` 由 backend.py import，你自己选，保持 backend.py 可读性）；刮削 provider 建议新模块 `tag_scraper.py`
- 不用改 settings 存储；不需要新设置项

## 验证标准（全部通过才算完成）

1. 新增 pytest：写标签（MP3/M4A/FLAC 三格式：文本+封面）、原子写失败保护、改名+序号冲突、引用迁移三文件、格式不支持 400、全空 400、scrape 多源返回形状（mock httpx）、封面 fallback 链（mock）
2. 全量回归：`~/codes/qqplayer/venv/bin/python -m pytest`（cwd 在 fork，用主仓库 venv）— 现有 142 全绿 + 新增全绿
3. `ruff check backend.py tag_scraper.py tag_editor.py tests/` 全过（如有新模块）
4. 真实文件端到端：临时目录生成/复制一个真 mp3（或 tmp_path 假 mp3），curl 调两个 API 验证：scrape 返回两组、tags 写标签后 extract_tags 能读回、文件名变成 `歌手 - 歌名.ext`、favorites 里预置该路径改名后自动迁移
5. 注意：跑服务用 `uvicorn backend:app --port 17628`（不要碰 17627 主服务）

## 交付要求

- commit 规范：`feat(backend): 标签刮削/写入 + 改名引用迁移（tag scraper）` 风格，可分多个 commit
- push 到 `origin feat/tag-scraper-backend`（origin 是主仓库本地路径，push 即到主仓库 refs）
- 汇报格式：改动清单 / 设计决策（新模块怎么分的）/ 测试结果（新增数+全量）/ 遗留项（不许假装完成）
- 完成后在 TASK.md 末尾追加「完成状态」节，写明测试数字和 push 的 commit

---

## 完成状态（2026-08-14）

### 改动清单
- 新增 `tag_scraper.py`：多源刮削（网易云复用 `netease_provider.search` + 新写 MusicBrainz ws/2 recording 搜索），封面 fallback 链（网易云 cover → iTunes Search API → Cover Art Archive）在 scrape 返回前补好；任何单源失败返回空数组不 500
- 新增 `tag_editor.py`：mutagen 写标签（MP3 ID3v2.3 / M4A·MP4（MP4 tags+covr）/ FLAC（VorbisComment+Picture），OGG/OPUS 只写文本标签跳过封面）；原子写 `copy2` 临时文件 → 改临时文件 → `os.replace` 落位，失败回滚原文件完好；统一改名 `{artist} - {title}.{ext}`（artist 空 → `{title}.{ext}`，title 也空 → `{artist}.{ext}`，都空不改名），重名加 ` (2)/(3)` 序号绝不覆盖
- `backend.py`：
  - `POST /api/tags/scrape`：query = 当前标签 title 优先（空则文件名 stem），返回 `{query, netease[], musicbrainz[]}`
  - `POST /api/tags`：写标签+改名+迁移；400 全空/格式不支持、404 文件不存在、409 写失败
  - `_migrate_path_refs`：改名成功后迁移 favorites.json / playlists.json(songPaths) / playback.json(path) 三处旧路径（命中才写文件）
  - 顺带修复 `extract_tags` 对 MP4/FLAC/OGG 的 list 标签值解析（原会返回 `['周杰伦']` 这种带括号的脏值，且 FLAC/OGG 迭代出 (key,value) 元组导致原逻辑直接异常返回 None）
- 新增 `tests/test_tag_scraper.py`（12 例）、`tests/test_tag_editor.py`（20 例）

### 设计决策
- 模块划分：刮削 provider 独立 `tag_scraper.py`（类 + 依赖注入 client/netease_search/sleep_fn，测试全 mock 网络，与 netease_provider 测试风格一致）；写标签/原子写/改名独立 `tag_editor.py`；backend.py 只加路由 + 引用迁移（迁移复用现有 `_load/_save_*` 避免循环依赖，改名成功通过 `migrate` 回调触发）
- 原子写实现：目标名去重后 `copy2 → mutagen 改 tmp → os.replace(tmp, target)`；target 为原路径时原地替换，为新名时原子改名后 `unlink` 旧路径；任何一步失败 tmp 清理、原文件保持完好（409）
- 封面 fallback 频率控制：MusicBrainz ws/2 每次调用前 sleep 1s（测试注入 sleep_fn 跳过）；Cover Art Archive 与 iTunes 是独立服务不 sleep，CAA 同 release MBID 做结果缓存去重（一次查询多个候选共享）
- CAA 判定：302/307 重定向都算有封面（实测 archive.org 返回 307），404 → cover=null 不报错
- 网易云候选只暴露契约 6 字段（去掉内部 level 等）；MB 候选 5 字段（title/artist/album/cover/mbid）
- 写标签只写请求提供的非空字段，不删除既有标签；cover_url 空/下载失败 → 不碰封面（不影响文本标签）

### 测试结果（真实数字）
- 新增 pytest：**32 例全绿**（写标签 MP3/M4A/FLAC 文本+封面、OGG 只文本、原子写失败保护、改名+序号冲突、改名目标同名不重复改名、仅 artist 改名、仅 album 不改名 name 回退 stem、引用迁移三文件、格式不支持 400、全空 400、404、409 回滚、cover 下载失败忽略、scrape 返回形状、封面 fallback 链 iTunes→CAA、CAA 404 不报错、单源失败隔离、MB 自定义 UA + sleep 1s、CAA 同 MBID 去重、artist-credit joinphrase）
- 全量回归：**174 passed**（原有 142 + 新增 32），`~/codes/qqplayer/venv/bin/python -m pytest`（cwd 在 fork）
- ruff：`ruff check backend.py tag_scraper.py tag_editor.py tests/` 全过
- 真实文件端到端（uvicorn 127.0.0.1:17628，隔离 DATA_DIR 不碰真实用户数据）：
  - scrape 真实网络：网易云 20 条（query 取 ID3 title）、MusicBrainz 20 条（Thriller/Michael Jackson，12 条带 CAA 封面）；中文歌 MB 无结果返回空数组属正常
  - tags 写标签：`老歌.mp3 → 周杰伦 - 安静.mp3`，extract_tags 读回 `(周杰伦, 安静, 范特西)`，内嵌封面 329KB JPEG（真实下载），favorites.json 旧路径自动迁移为新路径
  - 错误：全空 400 / .wav 400 / 不存在 404 全部符合契约

### 遗留项
- 改名与旧路径迁移的极端竞态未处理：若改名瞬间另一个进程在写同一数据文件，迁移可能丢一次写（与现有 `_save_*` 的非原子写一致，低频场景可接受）
- OGG/OPUS 只写文本标签按需求实现；.opus 与 .ogg 共用同一代码路径（`_write_ogg` 按 ext 选 OggVorbis/OggOpus），但 pytest 只覆盖了 .ogg 真实文件，.opus 未单独建真实文件用例
- `os.replace(tmp, target)` 成功后 `unlink` 旧路径若失败会返回 409（罕见：权限/占用），此时新旧文件并存，原文件内容未损坏
- extract_tags 修复改变了 M4A/FLAC/OGG 标签的返回格式（去掉 list 括号），对现有功能是修正；全量回归已确认无影响

### push
- commit `67c6339`（feat(backend): 标签刮削/写入 + 改名引用迁移）→ 已 push `origin feat/tag-scraper-backend`
