# QQPlayer 视频模块（Video）立项

> 2026-08-17 与大象讨论拍板。目的：**学语言**——视频跟唱式逐句练习。
> 仿 TODO.md 立项格式。后端已拆 app 包（routers/services/state/storage/main），按并行开发约定：功能主体进独立目录，接线层小而独立提交。
> 08-17 晚：Coco 评审 6 条意见，大象逐条拍板，结论以文中 ✅ 标记。

## 需求（大象拍板）

1. **视频双源**：在线播放 + 本地加载（本地文件夹 / 加载文件）
2. **视频跟唱**：字幕逐句高亮、点击句子跳转、跟读暂停、变速、**AB 循环 / 单句循环**——交互对齐现有音乐跟唱全交互（✅ 08-17 采纳 Coco 意见：学语言一句话反复听价值大）
3. **字幕时间戳用 AI 生成**：本地 ASR 转写视频音轨 → 时间戳字幕。**最后实现**，本轮接口占位不动（✅ 08-17 拍板：引擎走 omlx/Qwen3-ASR 管线还是 faster-whisper，等大象方案弄完整再定）
4. **独立 Tab**：mode-tabs 加第四个（continuous / karaoke / books / videos）
5. **不做元数据刮削**：视频裸播，标题/封面不折腾

## 在线视频源（大象拍板）

- **统一以 yt-dlp 为底层引擎**（大象机器已装 `/opt/homebrew/bin/yt-dlp` 2026.07.04）：解析 / 下载 / 字幕一条龙，覆盖 1000+ 站点（B站、YouTube、抖音等）
- settings 里**内置多个源**（预设常用站点入口），用户可**自定义添加**（粘贴任意 yt-dlp 支持的链接）
- 源 = provider 模式，仿现有 `netease_provider.py` / `quark_provider.py` / `gequhai_provider.py`，但底层统一走 yt-dlp

## 技术方案

### 前端（`frontend/src/videos/`，仿 `books/`）

- `App.vue`：mode-tabs 加 videos tab；`switchMode` 扩展；`locales` 加对应文案
- 核心组件：`<video>` 元素 + 字幕层
  - 字幕逐句渲染 / 点击跳转 / 当前句高亮：复用 karaoke 交互（把"歌词行"换成"字幕行"）
  - 变速（0.75/1.0/1.25）、跟读开关（每句播完自动停）、AB 循环 / 单句循环（对齐 karaoke 全交互）
  - 双字幕可选（原文 + 翻译，学语言用）；✅ 08-17 拍板翻译来源：优先网站自带双语字幕；网站只有单语种时**不自动翻译**，用户自己调 AI 翻译
- 字幕格式：SRT / VTT / JSON（对齐现有 lyric 手动指定格式的解析思路）
- 本地视频：文件列表 + 播放（不刮削，就按文件名显示）

### 后端（`app/routers/videos.py` + `app/services/video*.py`，仿 `books.py`）

- **视频流服务**：Range seek 复用 `stream.py` 模式
- **FFmpeg 集成**（大象拍板：不难，加上；✅ 08-17 补充探测分级）：
  - **ffprobe 先探测容器/编码**：浏览器原生能放的（如 mp4 + h264/aac）直接喂，不走转码
  - 不能放的分级对策：① 换容器（`-c:v copy`）→ ② 只转音轨（`-c:v copy -c:a aac`）→ ③ 全重编码（h265/AV1 很慢，放最后）
  - 音频抽取：给 ASR 管线用（ffmpeg 抽音轨 → wav/mp3）
  - 后续可扩展：缩略图、转 HLS 流
- **在线源代理**：B 站等平台的流地址带防盗链（Referer/UA 校验 + 时效 URL），后端代理转发加头，前端拿不到直链
  - ✅ 08-17 细节（coco 定）：流代理必须透传 206/Content-Range（seek 依赖）；yt-dlp 直链有时效，播放中断需重新解析

### 字幕管线（分三级，按优先级）

1. 外部字幕文件（本地 `.srt` / `.vtt`，在线源自带字幕如 B 站 CC 字幕）
2. 手动指定（对齐现有歌词手动指定交互）
3. **AI 转写（占位）**：`app/services/transcribe.py`，本轮只定义接口：

```python
# 输入：本地视频/音频文件路径（或 URL）
# 输出：时间戳字幕 JSON [{"start": float, "end": float, "text": str, "translation": str|None}, ...]
async def transcribe(media_path: str, language: str | None = None) -> list[dict]: ...
```

- 实现留到最后（✅ 08-17 拍板：引擎待大象方案完整再定——候选 omlx/Qwen3-ASR 管线 或 faster-whisper 本地跑，M 芯片可离线转写）
- 转写结果缓存 `~/.cache/qqplayer/subtitle/`（对齐歌词缓存结构），按视频路径隔离

### 在线源 provider 抽象（底层统一 yt-dlp）

```python
class VideoProvider:
    name: str

    def search(
        self, query: str, limit: int = 20
    ) -> list[dict]: ...  # 搜索视频（yt-dlp 不支持搜索，需站点 API 或搜索页解析）
    def get_stream(self, video_id: str) -> dict: ...  # yt-dlp -g 拿直链，防盗链/时效由后端代理
    def get_subtitles(
        self, video_id: str
    ) -> list[dict] | None: ...  # yt-dlp 自动字幕（CC / auto-subs）
    def download(self, url: str, dest: str) -> str: ...  # yt-dlp 下载到本地曲库/视频库
```

- **yt-dlp 调用方式**：`pip install yt-dlp` 进项目 venv（版本可锁），subprocess 调 CLI（`--dump-json` / `-g` / `--write-auto-subs`），输出 JSON 解析，稳定可靠；✅ 08-17 细节（coco 定）：锁版本后定期升级，网站改版会导致解析失效
- **内置源**：B站（国内直连 + CC 字幕）、YouTube（字幕最全，国内需代理，先做接口预留）、抖音——都是 yt-dlp 支持的站点，区别只在搜索入口（yt-dlp 不做搜索，内置源各自接搜索 API 或搜索页）；✅ 08-17 拍板：**B站搜索后置**（wbi 签名是已知坑），第一版在线源以粘贴链接通用解析为主；YouTube 搜索可用 yt-dlp `ytsearch`（免费）
- **自定义源**：用户粘贴任意链接（B站视频页/YouTube/抖音……），yt-dlp 通用解析出流 + 字幕，几乎零配置

## 实施顺序建议

1. **本地视频**：文件列表 + 播放 + 字幕渲染 + 跟唱交互（打通核心体验，不依赖在线）
2. **FFmpeg**：探测 + 转码兜底 + 音频抽取（体量小，顺手做）
3. **在线源（粘贴链接先行）**：yt-dlp 通用解析 + 自定义源 + settings 集成（✅ 08-17 拍板：B站搜索后置）
4. **B站 provider 搜索**：搜索入口后置（wbi 签名坑，接官方搜索 API / 搜索页解析）
5. **AI 转写**：最后实现（接口本轮已留好，引擎待定）

## 待确认 / 开放点

- 视频跟唱的双字幕布局（原文在上 / 翻译在下，还是左右）——先对齐 karaoke 布局，落地时确认
- ✅ 已定（08-17）：在线视频**默认不缓存** + 显式下载按钮（coco 落地）；B站搜索后置、粘贴链接先行；翻译来源见上（网站自带双语优先，单语种不自动翻译）
