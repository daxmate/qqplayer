# 🎵 Music Player

本地音乐播放器 + 跟唱练习器。FastAPI + Vue 3 + Vite。

## 功能

- **连播模式** = 普通播放器：播放列表、播放/暂停/上一首/下一首、专辑封面、歌词滚动高亮
- **跟唱模式** = 逐句练习：点击句子跳转播放、每句显示原文/罗马音/中文、变速（0.75/1.0/1.25）、跟唱开关（每句播完自动停）
- 歌曲库可切换任意本地文件夹（默认 iCloud 音乐库）
- 封面：内嵌封面（ID3 APIC / MP4 covr）优先，其次文件夹 cover.jpg
- 歌词：同名 `.srt` / `.lrc`，其次文件夹内唯一歌词文件
- 音频流支持 Range（可 seek）

## 启动

```bash
./启动.command            # 一键启动（iCloud 歌曲库，自动开浏览器）
# 或
./venv/bin/python backend.py [歌曲库路径]
# 默认端口 8765，访问 http://localhost:8765
```

## 开发

```bash
cd frontend
pnpm install
pnpm dev        # 开发服务器（代理 /api 到 8765）
pnpm build      # 构建到 ../dist（后端直接托管）
```

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
| `GET /api/lyric?path=` | 解析歌词（srt/lrc → 段落+句子） |
| `GET /api/audio?path=` | 音频流（Range 支持） |
