"""共享状态与常量（原 backend.py 全部可变状态/路径常量迁至此）。

约定：业务代码一律 `from app import state` 后 `state.XXX` 模块访问，
禁止 `from app.state import XXX` 绑定导入 —— 测试通过 patch `app.state.XXX`
注入临时路径/状态，绑定导入会让 patch 失效。
"""

import os
import sys
import threading
from pathlib import Path

from app.storage import JsonStore

# 仓库根（backend/app/state.py 上溯 3 级；dist/frontend/scripts 等相对路径均以仓库根为基准）。
# PyInstaller 打包（frozen）时资源位于解包目录 _MEIPASS：前端 dist 以 datas=[('dist','dist')]
# 打进包，运行时 ROOT 指向 _MEIPASS 才能挂载静态文件。
if getattr(sys, "frozen", False):
    ROOT = Path(sys._MEIPASS)
else:
    ROOT = Path(__file__).resolve().parent.parent.parent
# 默认歌曲库：系统推荐位置 ~/Music/QQPlayer（不在仓库内，仓库不存音频文件；
# 用户可在设置/命令行参数指定其他路径，argv 覆盖逻辑在 app/main.py）
DEFAULT_LIBRARY = Path.home() / "Music" / "QQPlayer"
# 端口：QQPLAYER_PORT 环境变量覆盖（测试/多实例隔离用），默认 17627 不变
DEFAULT_PORT = int(os.environ.get("QQPLAYER_PORT", "17627"))


def _default_data_dir() -> Path:
    """平台默认用户数据目录（QQPLAYER_DATA_DIR 环境变量存在时优先，冒烟测试隔离用）。

    - Windows: %APPDATA%\\QQPlayer（APPDATA 缺失时 fallback ~/AppData/Roaming/QQPlayer）
    - 其他平台（macOS/Linux）: ~/Library/Application Support/qqplayer，保持原行为不变
    """
    env_dir = os.environ.get("QQPLAYER_DATA_DIR")
    if env_dir:
        return Path(env_dir)
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "QQPlayer"
        return Path(os.path.expanduser("~")) / "AppData" / "Roaming" / "QQPlayer"
    return Path(os.path.expanduser("~")) / "Library" / "Application Support" / "qqplayer"


# 用户数据目录（收藏等，不放仓库）；打包版冒烟测试用 QQPLAYER_DATA_DIR 覆盖防污染真实数据
DATA_DIR = _default_data_dir()
# SQLite 存储（标准库 sqlite3，WAL）：favorites/playlists/playback_events/reading_progress/ops 表
# （iOS companion 同步底座；旧 JSON 首次启动自动迁移，settings/pairing/大文件仍走原 JSON）
DB_PATH = DATA_DIR / "qqplayer.db"
# sqlite3 连接 busy 超时（秒）：并发写锁等待上限
DB_BUSY_TIMEOUT = 5
FAVORITES_FILE = DATA_DIR / "favorites.json"
PLAYLISTS_FILE = DATA_DIR / "playlists.json"
PLAYBACK_FILE = DATA_DIR / "playback.json"
# 播放队列顺序（前端拖拽排序后保存，启动/刷新时恢复；独立文件，不动 settings.json）
QUEUE_ORDER_FILE = DATA_DIR / "queue_order.json"
# 网络曲库条目（网易云等在线源登记，播放时实时取直链，不落盘音频）
NETWORK_SONGS_FILE = DATA_DIR / "network_songs.json"
# 移动端配对（companion 配对 API）：已配对设备 + 待确认请求（token 只存 SHA-256 哈希，绝不存明文）
PAIRING_FILE = DATA_DIR / "pairing.json"
# 配对鉴权开关：QQPLAYER_ENABLE_AUTH=0 关闭（测试默认关闭；生产默认开启）
AUTH_ENABLED = os.environ.get("QQPLAYER_ENABLE_AUTH", "1") != "0"
# pending 请求超时（秒）：超时后 status 返 expired 并从待确认队列清理
PAIRING_TTL_SECONDS = 300
# 配对请求限流：连续 3 次内正常；第 4 次起指数退避（base 60s）；两次间隔 >10min 重置计数
PAIRING_RATE_BASE_SECONDS = 60
PAIRING_RATE_RESET_SECONDS = 600
# 电子书书架：书籍目录（books/<id>/ 下 book.epub + cover + index.json）与书架元数据
BOOKS_DIR = DATA_DIR / "books"
BOOKS_FILE = DATA_DIR / "books.json"
# 阅读器 V2 标注：按书分组的高亮/书签/笔记（annotations.json）
ANNOTATIONS_FILE = DATA_DIR / "annotations.json"
# 阅读器 V2 生词本：全局跨书生词（vocab.json）
VOCAB_FILE = DATA_DIR / "vocab.json"
# 播放记录滚动保留上限（超了删最旧）
PLAYBACK_LIMIT = 5000
# 播放时长少于该秒数视为误触，不记录
PLAYBACK_MIN_SECONDS = 3

# 桌面歌词/迷你窗：主页面状态上报，悬浮窗轮询读取（内存态，不持久化）
_now_playing: dict = {
    "path": None,
    "name": None,
    "artist": None,
    "duration": 0.0,
    "currentTime": 0.0,
    "isPlaying": False,
    "volume": 1.0,
    "lineIndex": -1,
    "updatedAt": 0.0,
    "accent": None,
}
_now_playing_lock = threading.Lock()
# 迷你窗控制指令队列：迷你窗 POST 入队，主播放器页面轮询取走执行（内存态）
# 元素: {"action": str, "value": float|None}
_player_actions: list[dict] = []
_player_actions_lock = threading.Lock()
# 合法指令白名单（防止任意指令注入）
_PLAYER_ACTIONS = {"togglePlay", "play", "pause", "next", "prev", "seek", "volume"}
# 迷你窗运行状态：Swift 壳启动/退出时上报，主页面轮询点亮顶栏开关
_mini_status: dict = {"running": False}
_mini_status_lock = threading.Lock()

# 库变动监听：事件去抖窗口（秒）与扫描缓存
WATCH_DEBOUNCE_SECONDS = 2.0
# 孤儿歌词定期清理：每周一 03:00（本次无设置 UI，默认开启即可）
LYRIC_CLEANUP_ENABLED = True
LYRIC_CLEANUP_HOUR = 3
_scan_cache: dict | None = None  # {"library": str, "songs": [...]}
_scan_version = 0
_scan_lock = threading.Lock()
_watch_timer: threading.Timer | None = None
_watch_observer = None  # watchdog Observer（延迟 import 避免顶层依赖 watchdog）

# 运行时歌曲库路径（可通过命令行参数修改；argv 覆盖逻辑在 app/main.py 模块级）
LIBRARY = DEFAULT_LIBRARY

# 支持的音频格式（默认全选，可在设置里多选过滤）
DEFAULT_AUDIO_EXTS = [".mp3", ".flac", ".m4a", ".wav", ".ogg", ".aac", ".opus"]
AUDIO_EXTS = set(DEFAULT_AUDIO_EXTS)
LYRIC_EXTS = {".srt", ".lrc"}

# 本地视频格式白名单（视频模块：/api/videos 列表扫描 + stream/subtitle 服务）
VIDEO_EXTS = [".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".ts"]

# ============ 统一设置文件路径（单一 settings.json · 9 namespace）============
SETTINGS_FILE = DATA_DIR / "settings.json"
# 遗留单文件设置（一次性迁移数据源；迁移后只读保留作备份，不再写入）
UI_SETTINGS_FILE = DATA_DIR / "ui_settings.json"
DESKTOP_LYRIC_FILE = DATA_DIR / "desktop_lyric.json"
# 内存缓存：完整 9 namespace 结构
_settings: dict | None = None

# ---- 各 namespace 默认值 ----
# library：现有 LIBRARY_SETTINGS_DEFAULTS 4 字段
LIBRARY_SETTINGS_DEFAULTS = {
    "audioExts": DEFAULT_AUDIO_EXTS,
    "ignoreHidden": True,  # 忽略隐藏文件/文件夹
    "autoRefresh": True,  # watchdog 自动刷新（库变动自动重扫）
    "autoScanOnStart": True,  # 启动时自动扫描歌曲库
}
# ui：前端 frontend/src/composables/useSettings.js UI_SETTINGS_DEFAULTS 全部 9 字段（只读拷贝）
UI_SETTINGS_DEFAULTS = {
    "showSongInfo": False,  # 跟唱模式歌词面板顶部显示当前歌曲信息
    "karaokeShowTime": False,  # 跟唱模式每句显示起止时间戳
    "karaokeShowNum": True,  # 跟唱模式每句左侧显示行号
    "theme": "dark",  # 主题：'dark' 深色 | 'light' 浅色 | 'auto' 跟随系统
    "miniTheme": "theme",  # 迷你窗外观：'theme' 跟随主窗口 | 'dark' 深色 | 'light' 浅色
    "accent": "orange",  # 强调色预设 key
    "coverBlur": False,  # 封面模糊背景
    "compact": False,  # 紧凑模式
    "showCover": True,  # 显示封面（关闭后隐藏封面图片，保留占位）
}
# lyric：前端 useSettings.js LYRIC_SETTINGS_DEFAULTS 全部 15 字段
LYRIC_SETTINGS_DEFAULTS = {
    "fontFamily": "system",  # 'system' | 'serif' | 'rounded'
    "fontSize": 20,  # 当前句基准字号（px）
    "align": "left",  # 'left' | 'center' | 'right'
    "engine": "amll",  # 歌词滚动引擎：'amll' | 'spring' | 'native'
    "showRoma": True,  # 显示罗马音
    "showZh": True,  # 显示中文翻译
    "showSec": True,  # 显示段落标题
    "focusPos": 0.5,  # 焦点句停靠位置（0~1）
    "fadeMask": True,  # 上下渐隐遮罩
    "autoScroll": True,  # 切句自动跟随滚动
    "offset": 0,  # 歌词延迟校准（秒，-2~2）
    "source": "local",  # 'local' 本地优先 | 'online' 在线优先
    "colorScheme": "theme",  # 配色方案 key
    "jpColor": "",  # 主行文字颜色（自定义）
    "zhColor": "",  # 翻译行文字颜色（自定义）
}
# playback：前端 frontend/src/composables/playerCore.js PLAYBACK_SETTINGS_DEFAULTS 全部 35 字段
PLAYBACK_SETTINGS_DEFAULTS = {
    "playMode": "order",  # 'order' 列表循环 | 'shuffle' 随机 | 'repeatOne' 单曲循环
    "resumeLast": True,  # 启动时恢复上次播放的歌曲与进度
    "rememberVolume": True,  # 记住音量
    "fadeSec": 0,  # 切歌淡入淡出时长（秒）；0 = 关闭
    "karaokeNextKey": "KeyN",  # 跟唱：下一句快捷键
    "karaokePrevKey": "KeyP",  # 跟唱：上一句快捷键
    "searchKey": "Meta+K",  # 搜索：打开 search anything（Cmd+K；存 e.code 风格）
    # 任务 G：快捷键全量可录制（默认值 e.code 风格；⌘ 组合存 "Meta+<code>"）
    "shortcutPlayPause": "Space",  # 播放 / 暂停
    "shortcutRewind": "ArrowLeft",  # 快退 10 秒
    "shortcutForward": "ArrowRight",  # 快进 10 秒
    "shortcutVolUp": "ArrowUp",  # 音量 +10%
    "shortcutVolDown": "ArrowDown",  # 音量 -10%
    "shortcutPrevTrack": "Meta+ArrowLeft",  # 上一首（⌘←）
    "shortcutNextTrack": "Meta+ArrowRight",  # 下一首（⌘→）
    "shortcutMute": "KeyM",  # 静音切换
    "shortcutFav": "KeyF",  # 收藏 / 取消收藏当前歌
    "shortcutCycleMode": "KeyR",  # 播放模式切换
    "shortcutZhToggle": "KeyL",  # 中文翻译显示开关
    "shortcutKaraokeMode": "KeyG",  # 连播 ↔ 跟唱模式切换
    "shortcutAbA": "KeyA",  # AB 循环：设起点
    "shortcutAbB": "KeyB",  # AB 循环：设终点
    "shortcutSlower": "BracketLeft",  # 变速 -
    "shortcutFaster": "BracketRight",  # 变速 +
    "shortcutVolStepUp": "Meta+ArrowUp",  # 音量 +20%（⌘↑）
    "shortcutVolStepDown": "Meta+ArrowDown",  # 音量 -20%（⌘↓）
    "eqEnabled": False,  # 均衡器开关
    "eqPreset": "flat",  # 均衡器预设 key（'custom' = 用户自定义）
    "eqGains": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  # 自定义增益（dB，-12~12，10 段）
    "abVisual": True,  # AB 循环区间可视化
    "abLoopCountOn": True,  # AB 循环计数（防走开安全阀）
    "abLoopMaxCount": 10,  # AB 循环计数上限（1-20）
    "visualizerEnabled": True,  # 频谱可视化开关
    "visualizerStyle": "bars",  # 视觉化样式：bars/radial/wave/pulse/mirror/particle
    "streamStats": False,  # 流媒体播放计入播放统计
    "sleepTimerOn": False,  # 睡眠定时器开关（运行中的倒计时不持久化，刷新即取消）
    "sleepTimerMinutes": 30,  # 睡眠定时器时长（分钟，chip 单选 15/30/45/60/90）
}
# desktopLyric：现有 DESKTOP_LYRIC_DEFAULTS 11 字段（不动）
DESKTOP_LYRIC_DEFAULTS = {
    "enabled": False,
    "showZh": True,
    "fontFamily": "system",
    "fontSize": 26,
    "zhSize": 16,
    "align": "center",
    "width": 460,
    "height": 140,
    "colorScheme": "white",
    "jpColor": "#ffffff",
    "zhColor": "#ffffff",
}
# books：阅读器 V2 阅读设置默认值（settings.py _SETTINGS_SPEC["books"] 从这里引用，单一来源）
READER_SETTINGS_DEFAULTS = {
    "fontFamily": "default",  # 正文字体：'default' | 'serif' | 'sans' | 'rounded'
    "fontSize": 100,  # 字号（基准百分比 %），70~200
    "lineHeight": 1.6,  # 行距倍率，1.0~2.0
    "margin": 4,  # 页边距，0~15
    "theme": "light",  # 主题：'light' | 'sepia' | 'dark' | 'auto'
    "textColor": "",  # 自定义文字颜色（非空覆盖主题）
    "bgColor": "",  # 自定义背景颜色（非空覆盖主题）
}
# player：播放器运行时状态（volume 数字 0~1；panel/controls 布尔；lastPlayed 对象或 null）
PLAYER_SETTINGS_DEFAULTS = {
    "volume": 1.0,
    "panel": True,
    "controls": False,
    "lastPlayed": None,
}
# dict：词典域默认值（任务 B 只加这个 namespace，不动其他）
DICT_SETTINGS_DEFAULTS = {
    "dictionaries": [],  # 词典配置数组（id/name/path/kind/role/enabled/addedAt）
    "activeDictId": "",  # 当前激活释义词典 id（空 = 未激活）
}

# ============ 曲库导入 ============
# 单文件导入大小上限（超出报 error 不写盘）
IMPORT_MAX_BYTES = 500 * 1024 * 1024  # 500MB

# ============ AI 歌词对齐 ============
# Qwen3-ForcedAligner 本地对齐工具（项目内 backend/scripts/lyric-align：oMLX 内嵌 python +
# mlx-community 模型 + ffmpeg + nagisa；模型缺失时自动下载，ModelScope 优先、HuggingFace 保底）
ALIGN_SCRIPT = str(ROOT / "backend" / "scripts" / "lyric-align")
# 模型缺失时首次使用会先下载（约 1GB），超时上限放宽到 600s
ALIGN_TIMEOUT = 600
# 模型手动下载指引（自动下载失败时附进错误 detail）
ALIGN_MODEL_URL = "https://modelscope.cn/models/mlx-community/Qwen3-ForcedAligner-0.6B-5bit"

# 词典上传目录：上传的 MDX/MDD 文件（<uuid>.mdx / <uuid>.mdd，同 uuid 自动配对）
DICTS_DIR = DATA_DIR / "dicts"

# ============ P1 存储抽象：JSON store 实例 ============
# 路径全部延迟解析（path_getter 可调用）：测试 patch state.XXX_FILE 后
# load/save 自动走新路径，import 时不需要固化路径。
# 注：favorites/playlists/playback 已迁 SQLite（app/db.py），此处只保留仍用 JSON 的域。
queue_order_store = JsonStore(lambda: QUEUE_ORDER_FILE, default=[])
network_songs_store = JsonStore(lambda: NETWORK_SONGS_FILE, default=[])
books_store = JsonStore(lambda: BOOKS_FILE, default=[])
annotations_store = JsonStore(lambda: ANNOTATIONS_FILE, default={})
vocab_store = JsonStore(lambda: VOCAB_FILE, default=[])
pairing_store = JsonStore(lambda: PAIRING_FILE, default={"devices": [], "pending": []})
