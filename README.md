# 🎵 QQPlayer 小千千

本地音乐播放器 + 跟唱练习器。FastAPI + Vue 3 + Vite。

## 功能

- **连播模式** = 普通播放器：播放列表、播放/暂停/上一首/下一首、专辑封面、歌词滚动高亮
- **均衡器 EQ**：10 段（31Hz~16kHz，±12dB）+ 7 预设（平直/流行/摇滚/爵士/古典/低音增强/人声）+ 自定义滑杆，设置 → 播放 → 均衡器，实时生效
- **跟唱模式** = 逐句练习：点击句子跳转播放、每句显示原文/罗马音/中文、变速（0.75/1.0/1.25）、跟唱开关（每句播完自动停）
- **桌面歌词悬浮窗**：独立小窗置顶显示当前句（原文 + 中文翻译双行），可拖动 / 调大小 / 换配色 / 跟随主题强调色；顶栏按钮调起（见下方安装说明）
- **迷你模式**：右下角独立小窗（封面 + 歌名 + 上一首/播放暂停/下一首 + 可拖动进度条 + 音量），控制指令回主播放器执行；顶栏按钮调起并实时反映运行状态（见下方安装说明）
- **歌单管理**：多歌单创建/改名/删除、拖拽排序、批量加歌浮层
- **按歌手 / 专辑分组浏览**：卡片网格聚合，点击进入分组歌曲列表（分组内搜索/排序/收藏照常）
- **iCloud 歌曲库自动刷新**：watchdog 监听文件夹变动自动重扫，列表实时更新（可关闭）
- **系统媒体键（MediaSession）**：键盘媒体键 / 控制中心 / 锁屏控制播放、切歌
- **播放统计**：完整播放历史 + 统计 API（喂每日三首推荐）
- **在线搜索 + 下载**：顶栏搜索框在线搜网易云（本地/在线分组），下载直接落盘曲库（默认音质 320k，可设置下载目录/音质），watchdog 自动刷新
- **search anything 全屏搜索**：顶栏小放大镜（或 Cmd+K）唤起 Spotlight 式全屏搜索层——混合搜索本地歌曲 / 在线歌曲 / 歌手 / 专辑 / 设置项，按匹配度排序（简繁/声调互通）；设置项结果可直接行内开关/滑杆/选择/输入；空态展示全部设置目录；歌手/专辑直达分组浏览
- **音乐标签编辑 + 刮削**：歌曲信息弹窗（Pencil 按钮）编辑歌名/歌手/专辑/封面；输入关键词自动刮削候选（网易云 + MusicBrainz，封面 fallback 链），点选即填；保存写 ID3v2 / MP4 / FLAC 标签（OGG/OPUS 只文本，原子写盘不损坏原文件）；自动统一改名 `{artist} - {title}.{ext}`（重名加序号不覆盖），收藏/歌单/播放统计路径自动迁移
- **手动指定歌词**：上传 `.lrc` / `.srt` / JSON、在线搜索挑选（网易云 + lrclib 多源候选）、粘贴文本，优先级最高
- **专业设置**：左侧分类导航（播放 / 音乐库 / 歌词 / 界面 / 快捷键 / 关于）——播放模式、启动恢复上次播放、记住音量、切歌淡入淡出、歌词延迟校准、歌词来源优先级、文件类型多选（7 种格式）、忽略隐藏文件、自动刷新开关、启动自动扫描
- **主题**：深色 / 浅色 / 跟随系统；强调色 6 种预设（橙红/蓝/绿/紫/粉/青）
- **封面模糊背景**：背景铺当前歌曲封面模糊图 + 毛玻璃面板（设置 → 界面）
- **紧凑模式**：减小间距与尺寸提高信息密度（设置 → 界面）
- 歌曲库可切换任意本地文件夹（默认 iCloud 音乐库）
- 封面：内嵌封面（ID3 APIC / MP4 covr）优先，其次文件夹 cover.jpg
- 歌词：手动指定优先（`~/.cache/qqplayer/lyric/manual/`），其次本地同名 `.srt` / `.lrc`，最后在线获取（网易云原文+中文翻译，lrclib 兜底；缓存 `~/.cache/qqplayer/lyric/`）
- 音频流支持 Range（可 seek）

## 数据位置

- **歌曲库**（默认，`backend.py` 内置）：`/Users/dax/Library/Mobile Documents/iCloud~dev~clq~Cosmos-Music-Player/Documents`（iCloud 同步的音乐文件夹，约 84 首）。运行时可用命令行参数覆盖：`./venv/bin/python backend.py [歌曲库路径]`
- **歌词缓存**：`~/.cache/qqplayer/lyric/`（在线获取的歌词自动缓存，30 天有效；手动指定歌词存 `manual/` 子目录，按歌曲路径隔离，不碰歌曲目录）
- **应用数据**：`~/Library/Application Support/qqplayer/`（收藏 `favorites.json` / 歌单 `playlists.json` / 播放统计 `playback.json` / 音乐库设置 `settings.json` / 桌面歌词设置 `desktop_lyric.json`）
- **测试数据**：不入仓库（歌曲文件太大，约 22MB）。`tests/` 用 `tmp_path` 现场生成假 mp3/srt 跑测试，不依赖真实音频；等以后有外部贡献者再考虑如何提供样例数据

## 启动

服务由 **launchd** 托管（`com.daxmate.qqplayer`）：登录后自动启动，进程崩溃自动拉起。

```bash
./deploy.sh              # 部署/更新：拉代码 → 装依赖 → 构建前端 → 重启服务
```

手动控制：

```bash
launchctl kickstart -k gui/$(id -u)/com.daxmate.qqplayer   # 重启服务
launchctl bootout gui/$(id -u)/com.daxmate.qqplayer        # 停止服务
./venv/bin/python backend.py [歌曲库路径]                    # 前台调试
```

- 默认端口 **17627**，访问 http://localhost:17627
- 日志：`~/Library/Logs/qqplayer/out.log` / `err.log`

## 桌面歌词悬浮窗

独立小窗置顶显示当前歌词（原文 + 中文翻译双行），Swift 原生壳（NSPanel 无边框 / 透明 / 置顶 / 不占 Dock）：

```bash
./desktop-lyric/build.sh --install   # 编译并安装到 /Applications
```

安装后：播放器顶栏按钮调起，或直接打开 QQPlayerLyric.app。窗口可拖动、可调大小；设置 → 歌词 → 桌面歌词可调字体 / 字号 / 对齐 / 配色 / 窗体大小 / 中文翻译开关。

## 迷你窗

右下角独立小窗（封面 + 歌名/歌手 + 上一首/播放暂停/下一首 + 可拖动进度条 + 音量滑杆），Swift 原生壳，控制指令经后端队列回主播放器执行：

```bash
./desktop-mini/build.sh --install   # 编译并安装到 /Applications
```

安装后：播放器顶栏画中画按钮调起（或 `open qqplayermini://`）。迷你窗悬浮右下角，顶部拖动条可拖动，双击拖动条或点 ✕ 关闭；顶栏按钮实时反映运行状态（关闭后自动熄灭）。注意：控制依赖主播放器页面保持打开（指令由页面轮询执行）。

## 开发

```bash
# 后端（Python 3.10+）
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
./venv/bin/python backend.py [歌曲库路径]

# 前端
cd frontend
pnpm install
pnpm dev        # 开发服务器（代理 /api 到 17627）
pnpm build      # 构建到 ../dist（后端直接托管）
```

## 测试 / 质量

```bash
# 后端：ruff lint + format + pytest
./venv/bin/ruff check .
./venv/bin/ruff format --check .
./venv/bin/python -m pytest

# 前端：eslint + prettier + vitest + build
cd frontend
pnpm exec eslint .
pnpm exec prettier --check .
pnpm vitest run
pnpm build
```

CI（GitHub Actions）会在每次 push/PR 自动跑以上全部检查。

## SRT 歌词格式（跟唱模式）

- 段落标题独立成块：`# 主歌1`（前后空行）
- 每句 1~3 行：原文 / 罗马音 / 中文

```
# 主歌1

1
00:00:24,000 --> 00:00:31,100
君が前に付き合っていた人のこと
kimi ga mae ni tsuki atte ita hito no koto
关于你之前交往过的那个人
```

## JSON 歌词格式（手动指定）

手动指定歌词支持 QQPlayer 缓存 JSON 结构（`~/.cache/qqplayer/lyric/` 或 `align_lyric.py` 对齐产物）：

```json
{
  "lrc": "[00:01.00]原文行",
  "tlyric": "[00:01.00]中文翻译行",
  "source": "netease"
}
```

- `lrc` 必填（LRC 文本），`tlyric` 可选（中文翻译，自动合并进歌词行）
- 上传或粘贴 JSON 时自动提取并转成 LRC 保存

## API

| 接口 | 说明 |
|---|---|
| `GET /api/songs` | 扫描歌曲库 |
| `GET /api/library` / `POST /api/library` | 查看/设置歌曲库路径 |
| `GET /api/library/version` | 歌曲库版本号（前端轮询自动刷新用） |
| `GET/PUT /api/library/settings` | 音乐库设置（文件类型/忽略隐藏/自动刷新/启动扫描） |
| `GET /api/cover?path=` | 提取封面 |
| `GET /api/lyric?path=` | 解析歌词（手动指定 → 本地 srt/lrc → 在线获取） |
| `GET /api/lyric/manual?path=` | 查询手动指定歌词状态 |
| `PUT /api/lyric/manual` | 保存手动指定歌词（上传/在线选择/粘贴） |
| `DELETE /api/lyric/manual?path=` | 清除手动指定歌词 |
| `GET /api/lyric/search?title=&artist=` | 多源搜索歌词候选（网易云+lrclib） |
| `GET /api/audio?path=` | 音频流（Range 支持） |
| `GET /api/favorites` / `POST /api/favorites/toggle` | 收藏列表 / 切换收藏 |
| `POST /api/playback` / `GET /api/playback` / `GET /api/playback/stats` | 播放统计上报 / 历史查询 / 聚合统计 |
| `GET/POST /api/playlists`、`PATCH/DELETE /api/playlists/{id}` | 歌单管理（增删改查） |
| `POST /api/playlists/{id}/songs`、`DELETE /api/playlists/{id}/songs/{path}` | 歌单加歌 / 移除歌曲 |
| `PUT /api/playlists/{id}/order` | 歌单整体重排 |
| `POST /api/now-playing` / `GET /api/now-playing` | 当前播放状态上报（桌面歌词）/ 轮询 |
| `GET/PUT /api/desktop-lyric/settings` | 桌面歌词设置 |
| `POST /api/tags/scrape` | 标签刮削候选（网易云 + MusicBrainz recording，封面 fallback 链） |
| `POST /api/tags` | 写入歌曲标签 + 统一改名（mutagen，原子写盘） |
