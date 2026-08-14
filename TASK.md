# TASK: 标签刮削器 — 前端（tag editor frontend）

> 工作目录：`~/codes/qqplayerB`（fork，origin 指向主仓库 `~/codes/qqplayer`）
> 分支：`feat/tag-editor-frontend`（已创建）
> 只动 frontend/；**禁止碰 backend.py / *.py / tests/**（后端并行开发中，接口按契约 mock）

## 项目背景

QQPlayer 外语学习媒体播放器（Vue 3 + Vite + vue-i18n 11 + lucide 图标）。组件在 `src/components/`，composables 在 `src/composables/`。当前 main = `7c72ba7`，vitest 455 全绿，eslint/prettier 全过。

关键现有设施（复用）：
- 播放状态：`src/composables/usePlayer.js` 的 `state`（`state.currentSong` = {id, path, name, artist, album, cover, ...}）
- 弹窗风格参考：`SettingsModal.vue` / `LyricSpecModal.vue`（遮罩 + 面板 + 底部操作栏）
- i18n：`src/locales/zh-CN/` 按模块拆分（app/control/playlist/...），`index.js` 聚合；组件内 `useI18n().t()`；key 命名 `<模块>.<功能>.<描述>`
- 现有 fetch 模式：看 `OnlineSearch.vue` / `settingsSync.js` 怎么调 `/api/*`
- 歌曲列表刷新：`loadSongs()`（App.vue / useLibrary），保留当前选中/播放的逻辑参考 `setupAutoRefresh`
- 移动端：`useMobileViewport.js` 的 `isMobile` + `mobile.css`；**用户拍板：以后所有新内容都要适配移动端（<1024px）**

## 需求（用户已拍板，逐条实现，不许自由发挥）

1. **歌曲信息编辑弹窗** `TagEditorModal.vue`：
   - 展示当前播放歌曲的封面（`/api/cover?path=`）+ 歌名/歌手/专辑（表单可编辑）
   - 「自动刮削」按钮 → 调 scrape API → 下方候选区两组（网易云 / MusicBrainz），条目 = 封面缩略图 + 标题 + 歌手 + 专辑（+时长，网易云有）；**点击条目 → 填充表单**（title/artist/album 替换 + 封面预览切换）
   - 底部：取消 / 保存；保存成功 → toast（复用现有 toast 模式）→ 刷新歌曲列表 → 关闭弹窗
2. **入口**：`ControlBar.vue` 歌曲信息区（`.song-line`，显示歌名/歌手的那个 span）旁加编辑按钮（lucide `Pencil` 图标，title 提示），只在 `state.currentSong` 存在时显示；迷你窗/移动端迷你条不加
3. **保存后当前播放不中断**：保存响应返回 `newPath`，若正在播放的这首歌改了名 → 更新 `state.currentSong.path`（保持播放不中断），并 `loadSongs()` 刷新列表（保留选中/播放）
4. **移动端适配**：<1024px 弹窗全宽、表单/候选列表可滚动，编辑流程完整可用

## API 契约（写死，与后端 TASK 完全一致；联调前用 mock）

### POST /api/tags/scrape

```jsonc
// request
{ "path": "/绝对/路径/歌曲.mp3" }   // 用 state.currentSong.path
// 200 response
{
  "query": "刮削关键词",
  "netease": [
    { "id": "数字字符串", "title": "安静 (Live)", "artist": "周杰伦", "album": "专辑名", "cover": "https://...或null", "duration": "04:30" }
  ],
  "musicbrainz": [
    { "title": "...", "artist": "...", "album": "...", "cover": "https://...或null", "mbid": "..." }
  ]
}
// 404 文件不存在；两组都可能为空数组（搜不到是正常，显示空态文案）。cover 已由后端 fallback 补好，null 就不显示缩略图。
```

### POST /api/tags

```jsonc
// request
{ "path": "...", "title": "安静", "artist": "周杰伦", "album": "专辑名", "cover_url": "https://...或null" }
// 200 response
{
  "path": "新绝对路径", "name": "新歌名", "artist": "周杰伦", "album": "专辑名",
  "renamed": true, "newPath": "改名后的绝对路径"
}
// 400 参数问题 / 404 / 409 写失败 —— 显示错误 toast，弹窗不关
```

**前端语义**：
- 点候选条目时把该条目的 cover 存入 `cover_url`（保存时传给后端写封面）；用户手动改文本不动封面 → `cover_url` 传 null
- 保存时 title/artist/album 全传（可能为空串？空串也传——后端会 400 全空，前端至少保证有内容，空字段传 "" 即可）
- 改名是后端行为，前端只管用返回的 `newPath` 更新状态

## 技术约束

- 新组件 `src/components/TagEditorModal.vue` + 新语言包 `src/locales/zh-CN/tags.js`（加入 index.js 聚合）；**不要改现有语言包文件**（避免并行冲突，后端任务不碰前端所以其实安全，但保持模块化惯例）
- 弹窗样式沿用现有 modal 风格（遮罩/面板/圆角/强调色变量），**不新增硬编码颜色**（颜色全用 CSS 变量）
- 测试选择器：按钮加 `data-test` 或用稳定 class；注意页面有多个按钮的 title 冲突（参考 i18n 踩坑：迷你/设置都是 .gear-btn，用 `[title="..."]` 区分）
- 移动端：弹窗用 `useMobileViewport` 的 isMobile 或 CSS media query 适配（参考 SettingsModal 的做法），候选列表限高滚动
- 不动后端、不动 `public/*.html`、不动其他组件行为（零回归）

## 验证标准（全部通过才算完成）

1. 新增 vitest：`TagEditorModal.test.js` — 渲染当前歌曲信息 / 刮削调用（mock fetch 返回两组）/ 点选填充表单 / 保存调用（请求体含 cover_url）/ 保存成功刷新+更新 currentSong.path（改名场景）/ 错误 toast 不关弹窗；`ControlBar` 入口按钮存在性 + 无歌时不显示
2. 全量回归：`npx vitest run`（cwd frontend/）— 现有 455 全绿 + 新增全绿
3. `npx eslint src` + `npx prettier --check "src/**/*.{js,vue}"` 全过
4. `npm run build` 成功
5. 联调注意：主服务 17627 还没有 /api/tags 接口（后端并行中）——真实验证可用 `vi.mock` 或起 mock server；**不要为了联调去改后端**，报告里说明联调待后端合并后验证

## 交付要求

- commit 规范：`feat(frontend): 歌曲信息编辑弹窗 + 标签刮削候选（tag editor）` 风格，可分多个 commit
- push 到 `origin feat/tag-editor-frontend`（origin 是主仓库本地路径，push 即到主仓库 refs）
- 汇报格式：改动清单 / 设计决策 / 测试结果（新增数+全量）/ 遗留项（不许假装完成）
- 完成后在 TASK.md 末尾追加「完成状态」节，写明测试数字和 push 的 commit

---

## 完成状态（2026-08-14，前端子代理）

### 改动清单

| 文件 | 说明 |
|---|---|
| `frontend/src/components/TagEditorModal.vue`（新） | 歌曲信息编辑弹窗：封面 `/api/cover?path=` + 歌名/歌手/专辑表单 + 「自动刮削」按钮（POST `/api/tags/scrape`，网易云/MusicBrainz 两组候选：封面缩略图+标题+歌手+专辑+时长）→ 点选填充表单并切换封面预览 → 取消/保存（POST `/api/tags`） |
| `frontend/src/components/ControlBar.vue` | `.song-line` 旁加 Pencil 编辑按钮（`state.currentSong` 存在才显示，`data-testid="song-edit-btn"`），点击打开 TagEditorModal；样式沿用现有变量，移动端按钮 22px→30px 触摸目标 |
| `frontend/src/locales/zh-CN/tags.js`（新） | 语言包，key 命名 `tags.<功能>.<描述>`（editTitle/scrapeBtn/groupNetease/saveSuccess/saveFailed…） |
| `frontend/src/locales/zh-CN/index.js` | 聚合加入 tags |
| `frontend/src/__tests__/TagEditorModal.test.js`（新） | 8 个用例（见下） |
| `frontend/src/__tests__/ControlBar.test.js`（新） | 2 个用例（入口按钮存在性/无歌不显示） |

### 设计决策

- **弹窗开关由 ControlBar 本地持有**（`tagEditorOpen` ref + props.open/emit close），弹窗组件内嵌于 ControlBar，Teleport 到 body——App.vue/MobilePlayer.vue 零改动，零回归；迷你窗（mini.html 独立静态页）与移动端迷你条（MiniPlayerBar）不渲染 ControlBar，天然无此按钮
- **保存不中断播放**：用响应 `newPath` 直接改 `state.currentSong.path/name/artist/album`，**不触碰 audio.src**；随后 `await loadSongs()`（loadSongs 按 path 保持 currentIndex，改名后也能定位新列表项）。测试断言 audio.src 未变
- **封面语义**：点候选 → `cover_url`=条目 cover（null 则不写封面）；手动改文本 → `cover_url` 恒 null。预览 computed：`cover_url` 优先，否则 `/api/cover?path=currentSong.path`（改名后自动指向新路径）
- **toast 独立 Teleport**：保存成功先关弹窗，toast 在 body 层继续显示 3.2s（复用 OnlineSearch 的自绘 toast 模式）
- **移动端**：<1024px 弹窗全宽/全屏由现有 `mobile.css` 的 `.modal-mask/.modal` 规则统一处理（零新增全局样式）；本组件内断点只做表单堆叠 + 候选列表随 `.tag-body` 滚动 + 触摸目标
- 空字段传 `""`（契约允许），全空时前端拦截并 toast（对应后端 400 语义）
- 打开弹窗/弹窗内切歌时从 `state.currentSong` 重同步表单（immediate watch + path watch），避免误编辑上一首
- 测试 fetch mock 用 `vi.stubGlobal` 而非 `vi.spyOn`（vitest4 下 spyOn 的全局 mock 不被 `unstubAllGlobals` 还原，同文件多 mock 会串测试）

### 测试结果（真实数字）

- 新增 10 个用例全绿：TagEditorModal 渲染（表单值+封面 URL）/ 刮削请求体 {path} + 两组候选渲染 / 空态文案 / 点选填充表单+封面预览切换 / 保存请求体含 cover_url / 手动改文本 cover_url=null / 保存成功改名 → currentSong.path 更新 + audio.src 未动 + loadSongs 刷新 + 成功 toast + emit close / 400 错误 → err toast + 弹窗不关 + 不刷新；ControlBar 入口（有歌显示+点击开弹窗 / 无歌不显示）
- 全量回归：`npx vitest run`（cwd frontend/）= **27 files / 465 tests 全绿**（455 存量 + 10 新增）
- `npx eslint src` 0 error 0 warning；`npx prettier --check "src/**/*.{js,vue}"` 全过；`npm run build` 成功

### 遗留项 / 联调注意

- **联调待后端合并**：主服务 17627 的 `/api/tags/scrape`、`/api/tags` 尚未实现（后端并行开发中），本前端严格按 TASK.md 契约实现，验证全部走 mock fetch；后端合并后需真机联调一次（刮削真实返回、保存改名落盘、封面写入）
- 后端 400/404/409 的 error 字段格式未知，前端兼容 `data.error || data.detail`；如后端返回结构不同，联调时微调
- `cover_url` 为 null 时预览回落 `/api/cover`（文件内嵌封面）；若后端保存后内嵌封面写入有延迟，预览可能短暂显示旧封面（loadSongs 刷新后自然更新）

### Push

- commit：`785a336 feat(frontend): 歌曲信息编辑弹窗 + 标签刮削候选（tag editor）`
- 已 push 到 `origin feat/tag-editor-frontend`（主仓库 refs）

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
