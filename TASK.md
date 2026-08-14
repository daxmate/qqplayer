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
