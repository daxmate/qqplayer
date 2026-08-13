# 🎵 QQPlayer 小千千

本地音乐播放器 + 跟唱练习器。FastAPI + Vue 3 + Vite。

## 功能

- **连播模式** = 普通播放器：播放列表、播放/暂停/上一首/下一首、专辑封面、歌词滚动高亮
- **跟唱模式** = 逐句练习：点击句子跳转播放、每句显示原文/罗马音/中文、变速（0.75/1.0/1.25）、跟唱开关（每句播完自动停）
- **主题**：深色 / 浅色 / 跟随系统；强调色 6 种预设（橙红/蓝/绿/紫/粉/青）
- **封面模糊背景**：背景铺当前歌曲封面模糊图 + 毛玻璃面板（设置 → 界面）
- **紧凑模式**：减小间距与尺寸提高信息密度（设置 → 界面）
- 歌曲库可切换任意本地文件夹（默认 iCloud 音乐库）
- 封面：内嵌封面（ID3 APIC / MP4 covr）优先，其次文件夹 cover.jpg
- 歌词：手动指定优先（`~/.cache/qqplayer/lyric/manual/`），其次本地同名 `.srt` / `.lrc`，最后在线获取（网易云原文+中文翻译，lrclib 兜底；缓存 `~/.cache/qqplayer/lyric/`）
- 音频流支持 Range（可 seek）

## 数据位置

- **歌曲库**（默认，`backend.py` 内置）：`/Users/dax/Library/Mobile Documents/iCloud~dev~clq~Cosmos-Music-Player/Documents`（iCloud 同步的音乐文件夹，约 84 首）。运行时可用命令行参数覆盖：`./venv/bin/python backend.py [歌曲库路径]`
- **歌词缓存**：`~/.cache/qqplayer/lyric/`（在线获取的歌词自动缓存，30 天有效，不影响功能）
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

## API

| 接口 | 说明 |
|---|---|
| `GET /api/songs` | 扫描歌曲库 |
| `GET /api/library` / `POST /api/library` | 查看/设置歌曲库路径 |
| `GET /api/cover?path=` | 提取封面 |
| `GET /api/lyric?path=` | 解析歌词（手动指定 → 本地 srt/lrc → 在线获取） |
| `GET /api/lyric/manual?path=` | 查询手动指定歌词状态 |
| `PUT /api/lyric/manual` | 保存手动指定歌词（上传/在线选择/粘贴） |
| `DELETE /api/lyric/manual?path=` | 清除手动指定歌词 |
| `GET /api/lyric/search?title=&artist=` | 多源搜索歌词候选（网易云+lrclib） |
| `GET /api/audio?path=` | 音频流（Range 支持） |
