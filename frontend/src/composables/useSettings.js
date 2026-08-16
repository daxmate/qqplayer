import { reactive, watch } from "vue";

// ============ 歌词显示设置（localStorage 持久化）============
export const LYRIC_SETTINGS_KEY = "qqplayer.lyricSettings.v1";

export const LYRIC_SETTINGS_DEFAULTS = {
  fontFamily: "system", // 'system' 系统默认 | 'serif' 衬线 | 'rounded' 圆体
  fontSize: 20, // 当前句基准字号（px），其他层级按比例缩放
  align: "left", // 'left' | 'center' | 'right'
  engine: "amll", // 歌词滚动引擎：'amll' amll 组件（默认）| 'spring' 自研弹簧 | 'native' 原生平滑
  showRoma: true, // 显示罗马音
  showZh: true, // 显示中文翻译
  showSec: true, // 显示段落标题
  focusPos: 0.5, // 焦点句停靠位置（可视区高度比例）：0.33 | 0.5
  fadeMask: true, // 上下渐隐遮罩
  autoScroll: true, // 切句自动跟随滚动
  offset: 0, // 歌词延迟校准（秒，-2~2）：正值 = 歌词比声音延后显示，负值 = 提前
  source: "local", // 歌词来源优先级：'local' 本地优先 | 'online' 在线优先（失败回退本地）
  colorScheme: "theme", // 配色方案：'theme' 跟随主题强调色 | 其他见 LYRIC_SCHEMES
  jpColor: "", // 主行文字颜色（自定义，空 = 跟随 colorScheme）
  zhColor: "", // 翻译行文字颜色（自定义，空 = 跟随 colorScheme）
};

export const lyricSettings = reactive({ ...LYRIC_SETTINGS_DEFAULTS });

// ============ 界面偏好（localStorage 持久化）============
export const UI_SETTINGS_KEY = "qqplayer.uiSettings.v1";

export const THEME_OPTIONS = ["dark", "light", "auto"]; // 'auto' = 跟随系统

export const ACCENT_OPTIONS = [
  { key: "orange", color: "#ff7e5f", color2: "#feb47b" },
  { key: "blue", color: "#5b9dff", color2: "#8ab4ff" },
  { key: "green", color: "#34d399", color2: "#6ee7b7" },
  { key: "purple", color: "#a78bfa", color2: "#c4b5fd" },
  { key: "pink", color: "#f472b6", color2: "#f9a8d4" },
  { key: "teal", color: "#2dd4bf", color2: "#5eead4" },
];

export const UI_SETTINGS_DEFAULTS = {
  showSongInfo: false, // 跟唱模式歌词面板顶部显示当前歌曲信息（歌名/歌手）
  karaokeShowTime: false, // 跟唱模式每句显示起止时间戳
  karaokeShowNum: true, // 跟唱模式每句左侧显示行号（默认显示，用户可关）
  theme: "dark", // 主题：'dark' 深色 | 'light' 浅色 | 'auto' 跟随系统
  miniTheme: "theme", // 迷你窗外观：'theme' 跟随主窗口主题 | 'dark' 深色 | 'light' 浅色
  accent: "orange", // 强调色预设 key（见 ACCENT_OPTIONS）
  coverBlur: false, // 封面模糊背景（播放器背景铺当前歌曲封面模糊图）
  showCover: true, // 显示封面（关闭后所有封面显示位置隐藏封面图片，不占位——任务 E 起歌词区自动扩充）
  // 封面区域大小：0 = 自适应（min(46vh,340px,center高度-220-间距)，保底歌词 ≥220px）；140~420 = 手动固定值（拖拽分隔条/设置滑块写入）
  // 后端 settings 白名单未收录该字段（PUT 被丢弃、GET 不返回）→ 仅前端本地持久化（localStorage 写透缓存），跨设备不同步
  coverSize: 0,
  compact: false, // 紧凑模式（减小间距与尺寸，提高信息密度）
};

export const uiSettings = reactive({ ...UI_SETTINGS_DEFAULTS });

// ============ 桌面歌词悬浮窗设置（后端存储：主播放器与悬浮窗跨引擎共享）============
export const DESKTOP_LYRIC_DEFAULTS = {
  enabled: false, // 主播放器顶栏开关记住状态（上次开着就开）
  showZh: true, // 显示中文翻译
  fontFamily: "system", // 字体：'system' 系统默认 | 'serif' 衬线 | 'rounded' 圆体
  fontSize: 26, // 主行（日文）字号 px
  zhSize: 16, // 翻译行字号 px
  align: "center", // 对齐：'left' | 'center' | 'right'
  width: 460, // 悬浮窗宽度 px
  height: 140, // 悬浮窗高度 px
  colorScheme: "white", // 配色方案 key（见 DESKTOP_LYRIC_SCHEMES；'theme' = 跟随主播放器强调色）
  jpColor: "#ffffff", // 主行文字颜色（配色方案的落地值，可被方案覆盖）
  zhColor: "#ffffff", // 翻译行文字颜色
};

// 歌词配色方案（APP 歌词 + 桌面歌词共用）：{ key, labelKey, jp 主行色, zh 翻译色 }
// 'theme' 为 APP 歌词专属：跟随主题强调色（默认）；中文文案在 settings.js（任务 A 维护）
export const LYRIC_SCHEMES = [
  { key: "theme", labelKey: "settings.lyricScheme.theme", jp: "", zh: "" },
  { key: "white", labelKey: "settings.lyricScheme.white", jp: "#ffffff", zh: "#e8e8e8" },
  { key: "warm", labelKey: "settings.lyricScheme.warm", jp: "#ffd9a0", zh: "#ffc46b" },
  { key: "pink", labelKey: "settings.lyricScheme.pink", jp: "#ffb7c5", zh: "#ff8fa3" },
  { key: "cyan", labelKey: "settings.lyricScheme.cyan", jp: "#9be8ff", zh: "#5cc8ee" },
  { key: "green", labelKey: "settings.lyricScheme.green", jp: "#b8f5c8", zh: "#7fd99a" },
  { key: "purple", labelKey: "settings.lyricScheme.purple", jp: "#d4c4ff", zh: "#a88fff" },
  { key: "blue", labelKey: "settings.lyricScheme.blue", jp: "#a8c8ff", zh: "#6f9dff" },
];

// 桌面歌词配色方案（含「跟随主题」）：{ key, labelKey, jp 主行色, zh 翻译色 }
export const DESKTOP_LYRIC_SCHEMES = [
  { key: "theme", labelKey: "settings.desktopLyricScheme.theme", jp: "", zh: "" },
  ...LYRIC_SCHEMES.filter((s) => s.key !== "theme"),
];

export const desktopLyricSettings = reactive({ ...DESKTOP_LYRIC_DEFAULTS });

// ============ 在线下载设置（后端存储：download namespace）============
export const DOWNLOAD_SETTINGS_KEY = "qqplayer.downloadSettings.v1";

// 音质选项（下载时使用的音质）：standard=标准 128k / exhigh=极高 320k / lossless=无损 FLAC / hires=Hi-Res
// labelKey 文案在 settings.js（settings.downloadQuality.*）
export const DOWNLOAD_QUALITY_OPTIONS = [
  { key: "standard", labelKey: "settings.downloadQuality.standard" },
  { key: "exhigh", labelKey: "settings.downloadQuality.exhigh" },
  { key: "lossless", labelKey: "settings.downloadQuality.lossless" },
  { key: "hires", labelKey: "settings.downloadQuality.hires" },
];

export const DOWNLOAD_SETTINGS_DEFAULTS = {
  downloadDir: "", // 下载目录；空 = 下载到当前曲库
  defaultQuality: "exhigh", // 默认音质：standard/exhigh/lossless/hires
  quarkQuality: "mp3", // 歌曲海下载品质：'mp3' MP3 320k | 'flac' FLAC（夸克网盘直链）
  engine: "httpx", // 歌曲海下载引擎：'httpx' 内置 | 'aria2' aria2
  aria2Rpc: "", // aria2 RPC 地址（engine=aria2 时生效）
  aria2Secret: "", // aria2 RPC 密钥（engine=aria2 时生效）
};

// 歌曲海下载品质选项（labelKey 文案在 settings.js：settings.quarkQualityOptions.*）
export const QUARK_QUALITY_OPTIONS = [
  { key: "mp3", labelKey: "settings.quarkQualityOptions.mp3" },
  { key: "flac", labelKey: "settings.quarkQualityOptions.flac" },
];

// 歌曲海下载引擎选项（labelKey 文案在 settings.js：settings.downloadEngineOptions.*）
export const DOWNLOAD_ENGINE_OPTIONS = [
  { key: "httpx", labelKey: "settings.downloadEngineOptions.httpx" },
  { key: "aria2", labelKey: "settings.downloadEngineOptions.aria2" },
];

export const downloadSettings = reactive({ ...DOWNLOAD_SETTINGS_DEFAULTS });

// 桌面歌词设置并入统一 Settings 层（settingsSync.js）：load/save 走 GET/PUT /api/settings 的
// desktopLyric namespace（主播放器 Vivaldi 与悬浮窗 WKWebView 跨引擎共享，localStorage 不通）
// Swift 壳内歌词面板被原生关闭（✕/双击）时回写状态，主页面开关保持同步
if (typeof window !== "undefined") {
  window.addEventListener("qqplayer:lyricstate", (e) => {
    if (e.detail && typeof e.detail.enabled === "boolean") {
      desktopLyricSettings.enabled = e.detail.enabled;
    }
  });
}

// ============ 主题 / 强调色 / 封面模糊 / 紧凑模式应用（html data-* 属性驱动 CSS）============
let themeMedia = null;

function onPrefersColorChange() {
  if (uiSettings.theme === "auto") applyTheme();
}

function applyTheme() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const mq =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: light)")
      : null;
  if (mq && mq !== themeMedia) {
    themeMedia?.removeEventListener?.("change", onPrefersColorChange);
    themeMedia = mq;
    mq.addEventListener?.("change", onPrefersColorChange);
  }
  const resolved =
    uiSettings.theme === "auto" ? (mq?.matches ? "light" : "dark") : uiSettings.theme;
  root.dataset.theme = resolved;
}

function applyAccent() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.accent = uiSettings.accent;
}

function applyCompact() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (uiSettings.compact) root.dataset.compact = "true";
  else delete root.dataset.compact;
}

function applyCoverBlur() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (uiSettings.coverBlur) root.dataset.blur = "true";
  else delete root.dataset.blur;
}

// 设置变化即时应用（持久化由统一 Settings 层负责：settingsSync.js 防抖 PUT + 写透缓存）
watch(() => uiSettings.theme, applyTheme);
watch(() => uiSettings.accent, applyAccent);
watch(() => uiSettings.compact, applyCompact);
watch(() => uiSettings.coverBlur, applyCoverBlur);

function loadUiSettings() {
  try {
    const raw = localStorage.getItem(UI_SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k of Object.keys(uiSettings)) {
      if (k in saved) uiSettings[k] = saved[k];
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadUiSettings();

// 启动时按持久化值应用一次（必须在 loadUiSettings 之后）
applyTheme();
applyAccent();
applyCompact();
applyCoverBlur();
// 注：旧的 theme/miniTheme → /api/ui/settings 双写 watch（uiSyncTimer）已删除——统一 Settings 层全量管

// 下载设置 localStorage 启动缓存（首屏不闪变；持久化由统一 Settings 层负责）
function loadDownloadSettings() {
  try {
    const raw = localStorage.getItem(DOWNLOAD_SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k of Object.keys(downloadSettings)) {
      if (k in saved) downloadSettings[k] = saved[k];
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadDownloadSettings();

function loadLyricSettings() {
  try {
    const raw = localStorage.getItem(LYRIC_SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k of Object.keys(lyricSettings)) {
      if (k in saved) lyricSettings[k] = saved[k];
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadLyricSettings();
// 注：lyricSettings 持久化由统一 Settings 层负责（settingsSync.js：防抖 PUT + 写透缓存）
// 注：coverSize 复用同一通道持久化（settingsSync 写透 localStorage；后端白名单无此字段，PUT 丢弃不报错）
