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

// 歌词配色方案（APP 歌词 + 桌面歌词共用）：{ key, label, jp 主行色, zh 翻译色 }
// 'theme' 为 APP 歌词专属：跟随主题强调色（默认）
export const LYRIC_SCHEMES = [
  { key: "theme", label: "跟随主题", jp: "", zh: "" },
  { key: "white", label: "经典白", jp: "#ffffff", zh: "#e8e8e8" },
  { key: "warm", label: "暖阳橙", jp: "#ffd9a0", zh: "#ffc46b" },
  { key: "pink", label: "樱花粉", jp: "#ffb7c5", zh: "#ff8fa3" },
  { key: "cyan", label: "冰川青", jp: "#9be8ff", zh: "#5cc8ee" },
  { key: "green", label: "薄荷绿", jp: "#b8f5c8", zh: "#7fd99a" },
  { key: "purple", label: "薰衣草紫", jp: "#d4c4ff", zh: "#a88fff" },
  { key: "blue", label: "星空蓝", jp: "#a8c8ff", zh: "#6f9dff" },
];

// 桌面歌词配色方案（含「跟随主题」）：{ key, label, jp 主行色, zh 翻译色 }
export const DESKTOP_LYRIC_SCHEMES = [
  { key: "theme", label: "跟随主题", jp: "", zh: "" },
  ...LYRIC_SCHEMES.filter((s) => s.key !== "theme"),
];

export const desktopLyricSettings = reactive({ ...DESKTOP_LYRIC_DEFAULTS });

// 桌面歌词设置走后端存储（主播放器 Vivaldi 与悬浮窗 WKWebView 跨引擎共享，localStorage 不通）
let desktopLyricLoaded = false;
let desktopLyricSaveTimer = null;

async function loadDesktopLyricSettings() {
  try {
    const res = await fetch("/api/desktop-lyric/settings", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const saved = data.settings || {};
    for (const k of Object.keys(desktopLyricSettings)) {
      if (k in saved) desktopLyricSettings[k] = saved[k];
    }
    desktopLyricLoaded = true;
  } catch {
    /* 忽略 */
  }
}
loadDesktopLyricSettings();

// Swift 壳内歌词面板被原生关闭（✕/双击）时回写状态，主页面开关保持同步
if (typeof window !== "undefined") {
  window.addEventListener("qqplayer:lyricstate", (e) => {
    if (e.detail && typeof e.detail.enabled === "boolean") {
      desktopLyricSettings.enabled = e.detail.enabled;
    }
  });
}

watch(
  desktopLyricSettings,
  () => {
    if (!desktopLyricLoaded) return; // 初始加载完成前不写回（避免覆盖后端值）
    if (desktopLyricSaveTimer) clearTimeout(desktopLyricSaveTimer);
    desktopLyricSaveTimer = setTimeout(async () => {
      try {
        await fetch("/api/desktop-lyric/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...desktopLyricSettings }),
        });
      } catch {
        /* 忽略 */
      }
    }, 300); // 防抖合并连续修改
  },
  { deep: true },
);

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

// 设置变化即时应用
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

watch(
  uiSettings,
  () => {
    try {
      localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(uiSettings));
    } catch {
      /* 忽略写入失败 */
    }
  },
  { deep: true },
);

// 主题/迷你窗外观同步后端（迷你窗与主播放器跨引擎共享：主窗口在浏览器时 localStorage 不通）
let uiSyncTimer = null;
watch(
  () => [uiSettings.theme, uiSettings.miniTheme],
  () => {
    if (uiSyncTimer) clearTimeout(uiSyncTimer);
    uiSyncTimer = setTimeout(async () => {
      try {
        await fetch("/api/ui/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme: uiSettings.theme, miniTheme: uiSettings.miniTheme }),
        });
      } catch {
        /* 忽略 */
      }
    }, 300);
  },
);

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

watch(
  lyricSettings,
  () => {
    try {
      localStorage.setItem(LYRIC_SETTINGS_KEY, JSON.stringify(lyricSettings));
    } catch {
      /* 忽略写入失败 */
    }
  },
  { deep: true },
);
