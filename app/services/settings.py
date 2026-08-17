"""设置服务：统一设置（单一 settings.json · 7 namespace）读写/迁移 + 字段校验。

路径/内存缓存全部走 app.state（state.SETTINGS_FILE 等，延迟解析）——
测试 patch app.state.XXX 后这里读到的就是临时路径。
"""

import json

from app import state

_SETTINGS_NAMESPACES = (
    "library",
    "ui",
    "lyric",
    "playback",
    "desktopLyric",
    "player",
    "download",
    "books",
)


# ============ 字段校验器（合法值保留/规范化，非法值回落默认）============
def _norm_bool(v, default):
    """布尔：类型非法回落默认"""
    return v if isinstance(v, bool) else default


def _norm_str(v, default, allowed=None):
    """字符串：类型非法回落默认；allowed 给定时必须是其中一员"""
    if isinstance(v, str) and (allowed is None or v in allowed):
        return v
    return default


def _norm_num(v, default, lo=None, hi=None, integer=False):
    """数字：类型非法回落默认；越界 clamp（eqGains/volume 等明确要求 clamp 的字段用）"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    if lo is not None and v < lo:
        v = lo
    if hi is not None and v > hi:
        v = hi
    return int(v) if integer else v


def _norm_exts(v, default):
    """audioExts：字符串扩展名列表（小写、带点）；过滤后非空才采纳，否则回落默认"""
    if isinstance(v, list) and v:
        exts = [str(e).lower() for e in v if isinstance(e, str) and e.startswith(".")]
        if exts:
            return exts
    return default


def _norm_search_history(v, default):
    """searchHistory：搜索历史字符串数组（最新在前）；过滤非字符串/空白，截断 10 条，空列表合法"""
    if isinstance(v, list):
        items = [str(s).strip() for s in v if isinstance(s, str) and s.strip()]
        return items[:10]
    return default


def _norm_eq_gains(v):
    """eqGains：必须是长度 10 数字数组（clamp ±12）；非法回落全 0"""
    default = list(state.PLAYBACK_SETTINGS_DEFAULTS["eqGains"])
    if not isinstance(v, list) or len(v) != 10:
        return default
    gains = []
    for g in v:
        if isinstance(g, bool) or not isinstance(g, (int, float)):
            return default
        gains.append(min(12.0, max(-12.0, float(g))))
    return gains


def _norm_last_played(v):
    """lastPlayed：{path: str, time: number} 或 null；非法结构回落 null"""
    if isinstance(v, dict) and isinstance(v.get("path"), str):
        t = v.get("time")
        if isinstance(t, (int, float)) and not isinstance(t, bool):
            return {"path": v["path"], "time": t}
    return None


# 每 namespace 字段规范: {字段: (默认值, 校验器)}；不在白名单的字段一律忽略
_SETTINGS_SPEC = {
    "library": {
        "audioExts": (state.LIBRARY_SETTINGS_DEFAULTS["audioExts"], _norm_exts),
        "ignoreHidden": (state.LIBRARY_SETTINGS_DEFAULTS["ignoreHidden"], _norm_bool),
        "autoRefresh": (state.LIBRARY_SETTINGS_DEFAULTS["autoRefresh"], _norm_bool),
        "autoScanOnStart": (state.LIBRARY_SETTINGS_DEFAULTS["autoScanOnStart"], _norm_bool),
    },
    "ui": {
        "showSongInfo": (state.UI_SETTINGS_DEFAULTS["showSongInfo"], _norm_bool),
        "karaokeShowTime": (state.UI_SETTINGS_DEFAULTS["karaokeShowTime"], _norm_bool),
        "karaokeShowNum": (state.UI_SETTINGS_DEFAULTS["karaokeShowNum"], _norm_bool),
        "theme": ("dark", lambda v, d: _norm_str(v, d, allowed={"dark", "light", "auto"})),
        "miniTheme": ("theme", lambda v, d: _norm_str(v, d, allowed={"theme", "dark", "light"})),
        "accent": (
            "orange",
            lambda v, d: _norm_str(
                v, d, allowed={"orange", "blue", "green", "purple", "pink", "teal"}
            ),
        ),
        "coverBlur": (state.UI_SETTINGS_DEFAULTS["coverBlur"], _norm_bool),
        "compact": (state.UI_SETTINGS_DEFAULTS["compact"], _norm_bool),
        "showCover": (state.UI_SETTINGS_DEFAULTS["showCover"], _norm_bool),
        # 任务 D：搜索历史（字符串数组，最新在前，最多 10 条）——后端统一设置存储，跨引擎同步
        "searchHistory": ([], lambda v, d: _norm_search_history(v, d)),
    },
    "lyric": {
        "fontFamily": (
            "system",
            lambda v, d: _norm_str(v, d, allowed={"system", "serif", "rounded"}),
        ),
        "fontSize": (20, lambda v, d: _norm_num(v, d, lo=14, hi=30)),
        "align": ("left", lambda v, d: _norm_str(v, d, allowed={"left", "center", "right"})),
        "engine": ("amll", lambda v, d: _norm_str(v, d, allowed={"amll", "spring", "native"})),
        "showRoma": (True, _norm_bool),
        "showZh": (True, _norm_bool),
        "showSec": (True, _norm_bool),
        "focusPos": (0.5, lambda v, d: _norm_num(v, d, lo=0.0, hi=1.0)),
        "fadeMask": (True, _norm_bool),
        "autoScroll": (True, _norm_bool),
        "offset": (0, lambda v, d: _norm_num(v, d, lo=-2.0, hi=2.0)),
        "source": ("local", lambda v, d: _norm_str(v, d, allowed={"local", "online"})),
        "colorScheme": ("theme", _norm_str),
        "jpColor": ("", _norm_str),
        "zhColor": ("", _norm_str),
    },
    "playback": {
        "playMode": (
            "order",
            lambda v, d: _norm_str(v, d, allowed={"order", "shuffle", "repeatOne"}),
        ),
        "resumeLast": (True, _norm_bool),
        "rememberVolume": (True, _norm_bool),
        "fadeSec": (0, lambda v, d: _norm_num(v, d, lo=0.0, hi=5.0)),
        "karaokeNextKey": ("KeyN", _norm_str),
        "karaokePrevKey": ("KeyP", _norm_str),
        "searchKey": ("Meta+K", _norm_str),
        # 任务 G：18 个新快捷键字段（全量可录制，字符串归一化）
        "shortcutPlayPause": ("Space", _norm_str),
        "shortcutRewind": ("ArrowLeft", _norm_str),
        "shortcutForward": ("ArrowRight", _norm_str),
        "shortcutVolUp": ("ArrowUp", _norm_str),
        "shortcutVolDown": ("ArrowDown", _norm_str),
        "shortcutPrevTrack": ("Meta+ArrowLeft", _norm_str),
        "shortcutNextTrack": ("Meta+ArrowRight", _norm_str),
        "shortcutMute": ("KeyM", _norm_str),
        "shortcutFav": ("KeyF", _norm_str),
        "shortcutCycleMode": ("KeyR", _norm_str),
        "shortcutZhToggle": ("KeyL", _norm_str),
        "shortcutKaraokeMode": ("KeyG", _norm_str),
        "shortcutAbA": ("KeyA", _norm_str),
        "shortcutAbB": ("KeyB", _norm_str),
        "shortcutSlower": ("BracketLeft", _norm_str),
        "shortcutFaster": ("BracketRight", _norm_str),
        "shortcutVolStepUp": ("Meta+ArrowUp", _norm_str),
        "shortcutVolStepDown": ("Meta+ArrowDown", _norm_str),
        "eqEnabled": (False, _norm_bool),
        "eqPreset": (
            "flat",
            lambda v, d: _norm_str(
                v,
                d,
                allowed={"flat", "pop", "rock", "jazz", "classical", "bass", "vocal", "custom"},
            ),
        ),
        "eqGains": (state.PLAYBACK_SETTINGS_DEFAULTS["eqGains"], lambda v, d: _norm_eq_gains(v)),
        "abVisual": (True, _norm_bool),
        "abLoopCountOn": (True, _norm_bool),
        "abLoopMaxCount": (10, lambda v, d: _norm_num(v, d, lo=1, hi=20, integer=True)),
        "visualizerEnabled": (True, _norm_bool),
        # 任务 K：视觉化 6 样式（bars/radial/wave/pulse/mirror/particle），非法值回落默认
        "visualizerStyle": (
            "bars",
            lambda v, d: _norm_str(
                v, d, allowed={"bars", "radial", "wave", "pulse", "mirror", "particle"}
            ),
        ),
        "streamStats": (False, _norm_bool),
        "sleepTimerOn": (False, _norm_bool),
        "sleepTimerMinutes": (30, lambda v, d: v if v in {15, 30, 45, 60, 90} else d),
    },
    "desktopLyric": {
        "enabled": (False, _norm_bool),
        "showZh": (True, _norm_bool),
        "fontFamily": (
            "system",
            lambda v, d: _norm_str(v, d, allowed={"system", "serif", "rounded"}),
        ),
        "fontSize": (26, lambda v, d: _norm_num(v, d, lo=18, hi=40)),
        "zhSize": (16, lambda v, d: _norm_num(v, d, lo=12, hi=26)),
        "align": ("center", lambda v, d: _norm_str(v, d, allowed={"left", "center", "right"})),
        "width": (460, lambda v, d: _norm_num(v, d, lo=300, hi=800)),
        "height": (140, lambda v, d: _norm_num(v, d, lo=80, hi=300)),
        "colorScheme": ("white", _norm_str),
        "jpColor": ("#ffffff", _norm_str),
        "zhColor": ("#ffffff", _norm_str),
    },
    "player": {
        "volume": (1.0, lambda v, d: _norm_num(v, d, lo=0.0, hi=1.0)),
        "panel": (True, _norm_bool),
        "controls": (False, _norm_bool),
        "lastPlayed": (None, lambda v, d: _norm_last_played(v)),
        # 任务：记住当前模式（连播/跟唱/阅读），重启恢复
        "mode": (
            "continuous",
            lambda v, d: _norm_str(v, d, allowed={"continuous", "karaoke", "books"}),
        ),
    },
    "books": {
        # 阅读模式：上次打开的书 id（重进阅读模式自动打开并恢复进度）；空 = 未读过
        "lastReadId": ("", _norm_str),
        # 阅读器 V2 阅读设置 7 字段（默认值单一来源 state.READER_SETTINGS_DEFAULTS；
        # 前端 ReaderSettingsPanel 消费，禁止 localStorage 存设置）
        "fontFamily": (
            state.READER_SETTINGS_DEFAULTS["fontFamily"],
            lambda v, d: _norm_str(v, d, allowed={"default", "serif", "sans", "rounded"}),
        ),
        "fontSize": (
            state.READER_SETTINGS_DEFAULTS["fontSize"],
            lambda v, d: _norm_num(v, d, lo=70, hi=200, integer=True),
        ),
        "lineHeight": (
            state.READER_SETTINGS_DEFAULTS["lineHeight"],
            lambda v, d: _norm_num(v, d, lo=1.0, hi=2.0),
        ),
        "margin": (
            state.READER_SETTINGS_DEFAULTS["margin"],
            lambda v, d: _norm_num(v, d, lo=0, hi=15, integer=True),
        ),
        "theme": (
            state.READER_SETTINGS_DEFAULTS["theme"],
            lambda v, d: _norm_str(v, d, allowed={"light", "sepia", "dark", "auto"}),
        ),
        # 自定义颜色覆盖：非空 = 用户颜色选择器写入，前端解释，后端只存值
        "textColor": (state.READER_SETTINGS_DEFAULTS["textColor"], _norm_str),
        "bgColor": (state.READER_SETTINGS_DEFAULTS["bgColor"], _norm_str),
    },
    "download": {
        # 在线下载目录：非空用该路径，空 = 当前歌曲库
        "downloadDir": ("", _norm_str),
        "defaultQuality": (
            "exhigh",
            lambda v, d: _norm_str(v, d, allowed={"standard", "exhigh", "lossless", "hires"}),
        ),
        # 歌曲海下载品质：夸克分享里同歌通常有 mp3(320k)/flac 两个版本，按偏好挑，缺则降级
        "quarkQuality": ("mp3", lambda v, d: _norm_str(v, d, allowed={"mp3", "flac"})),
        # 下载引擎：httpx = 内置流式下载；aria2 = 本机 aria2 daemon（RPC），未配置/不可用自动降级 httpx
        "engine": ("httpx", lambda v, d: _norm_str(v, d, allowed={"httpx", "aria2"})),
        "aria2Rpc": ("http://localhost:6800/jsonrpc", _norm_str),
        "aria2Secret": ("dax", _norm_str),
    },
}


def _norm_namespace(ns: str, data: dict) -> dict:
    """按 spec 规范化单个 namespace：白名单字段 + 类型/取值校验，非法值回落默认"""
    spec = _SETTINGS_SPEC[ns]
    out = {}
    for k, (default, norm) in spec.items():
        out[k] = norm(data[k], default) if k in data else default
    return out


def load_all_settings() -> dict:
    """读取统一设置（内存缓存；文件缺失/损坏时回落各 namespace 默认值）"""
    if state._settings is not None:
        return state._settings
    data = {}
    try:
        if state.SETTINGS_FILE.exists():
            raw = json.loads(state.SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data = raw
    except (OSError, json.JSONDecodeError):
        data = {}
    merged = {}
    for ns in _SETTINGS_NAMESPACES:
        raw_ns = data.get(ns) if isinstance(data.get(ns), dict) else {}
        merged[ns] = _norm_namespace(ns, raw_ns)
    state._settings = merged
    return merged


def save_all_settings(patch: dict) -> dict:
    """namespace→字段两级深合并保存并更新缓存（只合并传入字段，未传字段不动；未知 namespace 忽略）"""
    merged = dict(load_all_settings())
    for ns in _SETTINGS_NAMESPACES:
        if ns in patch and isinstance(patch[ns], dict):
            merged[ns] = _norm_namespace(ns, {**merged[ns], **patch[ns]})
    try:
        state.DATA_DIR.mkdir(parents=True, exist_ok=True)
        state.SETTINGS_FILE.write_text(
            json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass
    state._settings = merged
    return merged


def migrate_legacy_settings() -> None:
    """旧三文件一次性迁移 → 统一 settings.json（幂等；旧文件保留不删作备份）

    旧 library 文件就叫 settings.json（与新区文件同名）！所以必须先把旧文件读进内存，
    再写新结构（library 数据并入 library namespace），绝不能先覆盖后读。
    新文件已是新格式（顶层含 namespace 键）→ 整体跳过（幂等）。
    """
    # 1) 读旧 library 文件（若已是新格式则说明已迁移，跳过）
    legacy_library: dict = {}
    if state.SETTINGS_FILE.exists():
        try:
            existing = json.loads(state.SETTINGS_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = None
        if isinstance(existing, dict) and any(k in existing for k in _SETTINGS_NAMESPACES):
            return  # 已是统一格式
        if isinstance(existing, dict):
            legacy_library = existing
    # 2) 旧 ui / 桌面歌词文件先读入内存（此时还没动新文件，安全）
    legacy_ui: dict = {}
    if state.UI_SETTINGS_FILE.exists():
        try:
            raw = json.loads(state.UI_SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                legacy_ui = raw
        except (OSError, json.JSONDecodeError):
            pass
    legacy_desktop: dict = {}
    if state.DESKTOP_LYRIC_FILE.exists():
        try:
            raw = json.loads(state.DESKTOP_LYRIC_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                legacy_desktop = raw
        except (OSError, json.JSONDecodeError):
            pass
    # 3) 无任何旧数据 → 不写文件（保持默认）
    if not legacy_library and not legacy_ui and not legacy_desktop:
        return
    # 4) 组装新结构：默认值 + 旧数据（library 全量字段；ui 只迁 theme/miniTheme；desktopLyric 全量）
    merged = {ns: _norm_namespace(ns, {}) for ns in _SETTINGS_NAMESPACES}
    merged["library"] = _norm_namespace("library", legacy_library)
    merged["ui"] = _norm_namespace(
        "ui", {k: v for k, v in legacy_ui.items() if k in ("theme", "miniTheme")}
    )
    merged["desktopLyric"] = _norm_namespace("desktopLyric", legacy_desktop)
    try:
        state.DATA_DIR.mkdir(parents=True, exist_ok=True)
        state.SETTINGS_FILE.write_text(
            json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        return
    state._settings = merged


# ============ 兼容层（旧函数名保留，内部操作统一存储；现有调用方零改动）============
def load_settings() -> dict:
    """读取音乐库设置（library namespace；内存缓存 + 默认值合并）"""
    return dict(load_all_settings()["library"])


def _normalize_setting(key: str, value):
    """按字段类型规范化设置值，非法值回落默认（library namespace 校验入口）"""
    spec = _SETTINGS_SPEC["library"]
    if key not in spec:
        return value
    default, norm = spec[key]
    return norm(value, default)


def save_settings(patch: dict) -> dict:
    """合并保存音乐库设置到统一存储并更新内存缓存（返回规范化后的完整 library 设置）"""
    return dict(save_all_settings({"library": patch})["library"])


def load_ui_settings() -> dict:
    """读取界面设置（ui namespace：前端 8 字段；主窗口与迷你窗跨引擎共享）"""
    return dict(load_all_settings()["ui"])


def save_ui_settings(patch: dict) -> dict:
    """合并保存界面设置到统一存储（PUT 现在可接受全部 8 个 ui 字段）"""
    return dict(save_all_settings({"ui": patch})["ui"])


def load_desktop_lyric_settings() -> dict:
    """读取桌面歌词设置（desktopLyric namespace；主播放器与悬浮窗跨引擎共享）"""
    return dict(load_all_settings()["desktopLyric"])


def save_desktop_lyric_settings(patch: dict) -> dict:
    """合并保存桌面歌词设置到统一存储"""
    return dict(save_all_settings({"desktopLyric": patch})["desktopLyric"])
