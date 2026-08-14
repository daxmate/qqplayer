# QQPlayer search anything —— 任务 C：数据源 + 匹配度打分

## 项目背景
- 项目 `~/codes/qqplayer/`：FastAPI + Vue3 外语学习媒体播放器（音乐 + AB 循环复读 + 有声书）
- 本任务属于「search anything」功能（用户 2026-08-14 拍板）：把顶栏搜索框升级为 Spotlight 式全屏搜索层，能搜索本地歌曲/在线歌曲/歌手/专辑/设置项，**混合列表按匹配度排序**
- 工作目录：`/Users/dax/codes/qqplayerC`（clone 自主仓库，origin 指向主仓库本地路径）
- 分支：`git checkout -b feat/search-anything-data`（若已存在：`git checkout main && git pull origin main` 后重建）
- node_modules：`ln -s /Users/dax/codes/qqplayer/node_modules /Users/dax/codes/qqplayerC/frontend/node_modules`（若失效则 `cd frontend && npm install`）
- 测试：`cd frontend && npx vitest run`（⚠️ 不要用管道接 tail——会吞退出码，直接看命令退出码）；lint `npx eslint src`；格式 `npx prettier --check "src/**/*.{js,vue}" "public/*.html"`
- 测试基建：vite.config.js setupFiles 自动装 vue-i18n；matchMedia mock 在 `src/__tests__/helpers/matchMedia.js`
- i18n：composables 里 `import i18n from "../locales/i18n.js"` → `i18n.global.t()`
- 真实数据：83 首歌；在线搜索 API `GET /api/online/search?q=&limit=`（dev 时 vite proxy 5173 → localhost:17627，vite.config.js 已配）

## 用户已拍板需求（不许改）
1. 搜索结果五类：**本地歌曲 / 在线歌曲（网易云）/ 歌手 / 专辑 / 设置项**
2. **按匹配度排序**（最佳在前）；同匹配度优先级：**本地歌曲 > 在线歌曲 > 歌手 > 专辑 > 设置**
3. 匹配度规则：**前缀匹配 > 包含匹配**；字段权重 歌名 > 歌手 > 专辑（歌曲）；名称前缀 > 名称包含 > 别名匹配（歌手/专辑/设置）

## 你的产出（三任务并行，契约部分必须一字不差）

### 1. `frontend/src/utils/score.js`（新文件，纯函数无 vue 依赖）
```js
export function matchScore(query, text) // → number
// 规则：query 空 → 0；normalize（src/utils/searchNormalize.js 的 normalizeQuery/normalizeText）后：
//   text 以 query 开头 → 100（前缀）；text 包含 query → 50（包含）；都不中 → 0
// 加分细则自定（如 text 完全相等 → 再 +20），但必须满足：前缀命中 > 包含命中 > 不中
export function kindRank(kind) // → number：'song'=0 'online'=1 'artist'=2 'album'=3 'setting'=4
```

### 2. `frontend/src/composables/useSearchAnything.js`（新文件，模块级单例）
```js
export function useSearchAnything()
// 模块顶层共享 ref（单例），多次调用返回同一实例。返回：
// { query: Ref<string>, results: Ref<ResultItem[]>, loading: Ref<boolean>,
//   isSearchOpen: Ref<boolean>, clear(): void }
```
行为：
- `query` watch（防抖 250ms）：空 → `results=[]`、loading=false；非空 → 并行收集五类 → 打分 → 排序
- 本地歌曲：`import { state } from "./usePlayer.js"`（state.songs），normalize 后对 `[name, artist, album]` 三字段分别 matchScore，取最高分；**字段权重加分：name 命中 +20、artist +10、album +0**（设计细则自定，测试断言要覆盖）
- 在线：`fetch('/api/online/search?q=' + encodeURIComponent(q) + '&limit=20')`；**searchSeq 过期丢弃**（快速连续输入时旧响应作废，参照现有 OnlineSearch.vue 的做法）；请求期间 loading=true；失败静默（results 不含在线组，不报错）
- 歌手：state.songs 按 artist 聚合（空 artist 归"未知歌手"）计数；对歌手名 matchScore
- 专辑：按 album 聚合（空 album 归"未知专辑"）计数；专辑名 matchScore；artists 去重 >2 显示 `"A / B 等"`
- 设置：`import { settingsIndex } from "../settingsIndex.js"`（**此文件由并行任务 B 产出，你的 clone 里还没有**——本地建临时 stub 放同路径：`export const settingsIndex = []` 即可跑通你的测试；stub 不 commit，merge 后 maintainer 用真实文件全量重跑）；对每项匹配 `i18n.global.t(entry.labelKey)` 文案 + entry.keywords 别名（别名命中 +10）
- 每类结果上限：本地 8 / 在线 20 / 歌手 5 / 专辑 5 / 设置 10（可微调）
- 排序：score 降序 → kindRank 升序 → title localeCompare（zh collation）
- ResultItem 结构（**写死，A 任务按此消费**）：
```js
{ kind: 'song'|'online'|'artist'|'album'|'setting',
  id, title, subtitle, badge, score, payload }
// song:    payload = state.songs 条目（title=name, subtitle='artist · album', badge='本地'）
// online:  payload = {id,title,artist,album,cover,duration,quality}（title=item.title, badge='在线'）
// artist:  payload = {artist, count}（title=artist, subtitle=`${count} 首`, badge='歌手'）
// album:   payload = {album, artists, count}（title=album, subtitle=artists 串, badge='专辑'）
// setting: payload = SettingEntry（title=t(labelKey), subtitle=分类名, badge='设置'）
// badge 文案建议直接写死中文（A 会做 i18n 渲染，badge 作为 kind 标识符）；title/subtitle 用 i18n 时注意 composable 里用 i18n.global.t()
```

### 3. 测试
- `frontend/src/__tests__/score.test.js`：前缀 > 包含 > 不中；空 query=0；normalize 互通（简体/繁体/带声调字母）
- `frontend/src/__tests__/useSearchAnything.test.js`：
  - mock fetch（/api/online/search 返回 fake 列表）；state.songs 注入 fake 歌曲（import { state } 直接赋值，测试后恢复，注意其他测试文件隔离）
  - 断言：五类结果出现 / 前缀命中排最前 / 同分优先级（本地 > 在线 > 设置……）/ 字段权重（歌名命中排歌手命中前）/ 防抖（vi.useFakeTimers）/ 在线失败静默 / clear() 清空

## 红线
- 只新增：score.js / useSearchAnything.js / 两个测试文件；本地临时 stub settingsIndex.js（**不 commit**）
- 不碰任何现有文件（不碰 usePlayer/playerCore/OnlineSearch/App.vue/SettingsModal/语言包等）
- 已有测试不许改（全量 vitest 必须保持全绿）

## 交付
- git status 干净（stub 不 commit）；commit（conventional style：`feat(frontend): search anything 数据源 + 匹配度打分`）；push 到 fork origin 的 feat/search-anything-data
- 汇报：改动清单 / 设计决策（打分细则/聚合逻辑/上限）/ 测试结果（vitest X passed）/ 遗留项——不许假装完成
