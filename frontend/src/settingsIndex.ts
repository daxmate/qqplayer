// 设置项索引（search anything · 设置目录数据层）
//
// 用途：把「设置」建模为可搜索、可内联操作的 SettingEntry 列表——
// 顶栏搜索框（Spotlight 式搜索层）按 keywords 匹配设置项，结果行用
// InlineControl.vue 直接操作（开关/滑杆/选择/文本），实时持久化。
//
// 契约（任务 B 写死，其他任务按此消费）：
//   SETTING_CATEGORIES —— 7 个设置分类（playback/library/download/lyric/ui/shortcuts/about），
//                         lyric 有子 tab：['app','desktop']（SettingsModal 歌词页子页）
//   settingsIndex       —— SettingEntry[]，字段见下
//
// SettingEntry:
//   { id, category, subTab, labelKey, keywords[], type, get(), set(v),
//     min?, max?, step?（slider）、options?: [{value,labelKey}]（select）、placeholder?（text） }
//
// 可选展示字段（SettingsModal SettingRow 消费，搜索层忽略）：
//   render?        —— 特殊交互标记（手写块宿主/块内成员，非“纯简单项”）；
//                     SettingsModal 按 id 分发手写块，标记仅用于排除 SettingRow 通用渲染
//   descKey?       —— 说明文案语言包 key（缺省回落 settings.<id>Desc，无则隐藏）
//   descAfter?     —— desc 渲染在控件下方（默认在上方）
//   marginTop?     —— select 容器额外上边距（px，对齐原模板 seg 内联样式）
//   chips?         —— select 容器样式："ext" 用 ext-grid/ext-chip，缺省 seg/seg-btn
//   valueSuffix?   —— label 内/后值徽标后缀（如 "px"）；badge: "block" 时徽标为 label 后独立 div
//   mobileOnly?    —— 仅移动端渲染（设置弹窗桌面端隐藏）
//   inputType?     —— text 输入框 type（"number" 时 v-model.number 语义）
//
// 持久化说明：
//   - 常规项：set() 只赋 settings reactive 属性，settingsSync 的 deep watch 自动
//     防抖 PUT /api/settings 持久化（不要手动调 API）。
//   - 音乐库项（ignoreHidden/autoRefresh/autoScanOnStart）：字段在 state.librarySettings
//     （后端 /api/library/settings 管理），不走 settingsSync——set() 调 saveLibrarySettings
//     保持与 SettingsModal 相同的持久化路径。
//   - sleepTimerOn：开关语义与 SettingsModal 一致——开启 = 启动倒计时（toggleSleepTimer），
//     关闭 = 取消（cancelSleepTimer），仅赋字段不会真正计时。
import {
  state as playerState,
  playbackSettings as playerPlaybackSettings,
  lyricSettings as playerLyricSettings,
  uiSettings as playerUiSettings,
  desktopLyricSettings as playerDesktopLyricSettings,
  downloadSettings as playerDownloadSettings,
  videoSettings as playerVideoSettings,
  saveLibrarySettings,
  EQ_PRESETS,
  LYRIC_SCHEMES,
  DESKTOP_LYRIC_SCHEMES,
  ACCENT_OPTIONS,
  DOWNLOAD_QUALITY_OPTIONS,
  QUARK_QUALITY_OPTIONS,
  DOWNLOAD_ENGINE_OPTIONS,
  VISUALIZER_STYLES,
} from "./composables/usePlayer.js";
import { sleepTimer, toggleSleepTimer, cancelSleepTimer } from "./composables/useSleepTimer.js";

// usePlayer.js 由初始值推断出强类型（playMode: string、eqGains: number[] 等），而注册表契约
// get(): unknown / set(v: unknown) 是宽松边界（设置值跨 JS/TS 边界，可能被手写块写入任意形态）：
// 这里按宽松键值视图取用，字段级类型校验交给 70 个 entry 的 satisfies SettingEntry[]。
const state = playerState as unknown as Record<string, unknown>;
const playbackSettings = playerPlaybackSettings as unknown as Record<string, unknown>;
const lyricSettings = playerLyricSettings as unknown as Record<string, unknown>;
const uiSettings = playerUiSettings as unknown as Record<string, unknown>;
const desktopLyricSettings = playerDesktopLyricSettings as unknown as Record<string, unknown>;
const downloadSettings = playerDownloadSettings as unknown as Record<string, unknown>;
const videoSettings = playerVideoSettings as unknown as Record<string, unknown>;

// ============ 类型定义（TS 化：70 个 entry satisfies 校验字段完整/拼写）============
export type SettingType = "toggle" | "slider" | "select" | "text" | "custom";

export interface SettingOption {
  value: string | number;
  labelKey: string;
  css?: string;
}

export interface SettingEntry {
  id: string;
  category: string;
  subTab: string | null;
  labelKey: string;
  descKey?: string;
  keywords: string[];
  type: SettingType;
  render?: string;
  get: () => unknown;
  set: (v: unknown) => void;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  chips?: string;
  valueSuffix?: string;
  badge?: string;
  mobileOnly?: boolean;
  descAfter?: boolean;
  inputType?: string;
  marginTop?: number;
}

// ============ 设置分类 ============
export const SETTING_CATEGORIES = [
  { key: "playback", labelKey: "settings.category.playback" },
  { key: "library", labelKey: "settings.category.library" },
  { key: "video", labelKey: "settings.category.video" },
  { key: "download", labelKey: "settings.category.download" },
  { key: "lyric", labelKey: "settings.category.lyric", subTabs: ["app", "desktop"] },
  { key: "ui", labelKey: "settings.category.ui" },
  { key: "shortcuts", labelKey: "settings.category.shortcuts" },
  { key: "about", labelKey: "settings.category.about" },
];

const CATEGORY_KEYS = SETTING_CATEGORIES.map((c) => c.key);

// ============ select 选项（labelKey 均在 zh-CN 语言包）============
const playModeOptions = [
  { value: "order", labelKey: "settings.playModeOrder" },
  { value: "shuffle", labelKey: "settings.playModeShuffle" },
  { value: "repeatOne", labelKey: "settings.playModeRepeatOne" },
];
const engineOptions = [
  { value: "amll", labelKey: "settings.engineAmll" },
  { value: "spring", labelKey: "settings.engineSpring" },
  { value: "native", labelKey: "settings.engineNative" },
];
const fontOptions = [
  { value: "system", labelKey: "settings.fontSystem", css: "" },
  { value: "serif", labelKey: "settings.fontSerif", css: '"Songti SC", "SimSun", serif' },
  {
    value: "rounded",
    labelKey: "settings.fontRounded",
    css: '"Yuanti SC", "PingFang SC", sans-serif',
  },
];
const alignOptions = [
  { value: "left", labelKey: "settings.alignLeft" },
  { value: "center", labelKey: "settings.alignCenter" },
  { value: "right", labelKey: "settings.alignRight" },
];
const focusOptions = [
  { value: 0.33, labelKey: "settings.focusUpperThird" },
  { value: 0.5, labelKey: "settings.focusCenter" },
];
const sourceOptions = [
  { value: "local", labelKey: "settings.sourceLocal" },
  { value: "online", labelKey: "settings.sourceOnline" },
];
// 浏览器 Cookie 来源（yt-dlp --cookies-from-browser；空串 = 不使用）
const browserOptions = [
  { value: "", labelKey: "settings.cookiesFromBrowserNone" },
  { value: "vivaldi", labelKey: "settings.cookiesFromBrowserVivaldi" },
  { value: "chrome", labelKey: "settings.cookiesFromBrowserChrome" },
  { value: "safari", labelKey: "settings.cookiesFromBrowserSafari" },
  { value: "edge", labelKey: "settings.cookiesFromBrowserEdge" },
  { value: "firefox", labelKey: "settings.cookiesFromBrowserFirefox" },
  { value: "brave", labelKey: "settings.cookiesFromBrowserBrave" },
];
const themeOptions = [
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "light", labelKey: "settings.themeLight" },
  { value: "auto", labelKey: "settings.themeAuto" },
];
const miniThemeOptions = [
  { value: "theme", labelKey: "settings.miniThemeTheme" },
  { value: "dark", labelKey: "settings.miniThemeDark" },
  { value: "light", labelKey: "settings.miniThemeLight" },
];
// 均衡器预设（EQ_PRESETS 自带 labelKey，见语言包 eq.js）
const eqPresetOptions = Object.entries(EQ_PRESETS).map(([key, p]) => ({
  value: key,
  labelKey: p.labelKey,
}));
// 强调色预设（ACCENT_OPTIONS 只有色值，labelKey 用 settings.accentColor.*，见语言包 settings.js）
const accentOptions = ACCENT_OPTIONS.map((a) => ({
  value: a.key,
  labelKey: `settings.accentColor.${a.key}`,
}));

// ============ 音乐库设置（后端 /api/library/settings，非 settingsSync）============
// 字段默认值对齐 SettingsModal resetAll 与后端契约；state.librarySettings 未加载时兜底
const LIB_DEFAULTS: Record<string, boolean> = {
  ignoreHidden: true,
  autoRefresh: true,
  autoScanOnStart: true,
};

function libGet(key: string) {
  return (state.librarySettings as Record<string, unknown> | null)?.[key] ?? LIB_DEFAULTS[key];
}

function libSet(key: string, v: unknown) {
  // 与 SettingsModal 相同的持久化路径（PUT /api/library/settings，成功后回写 state）
  saveLibrarySettings({ [key]: v }).catch(() => {});
}

// audioExts（多选数组）注册表语义：get 返回逗号拼接字符串（契约要求原始类型），
// set 拆分回数组走 saveLibrarySettings 持久化；设置弹窗内由 render:"audioExts" 手写 chips 块消费。
function audioExtsGet() {
  const arr = (state.librarySettings as Record<string, unknown> | null)?.audioExts;
  return Array.isArray(arr) ? arr.join(",") : "";
}

function audioExtsSet(v: unknown) {
  const parts = String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  libSet("audioExts", parts);
}

// eqGains（10 段数组）注册表语义：get 返回逗号拼接字符串（契约要求原始类型）；
// set 数字串解析为 10 个 ±12 数字写入，非法输入原样存字符串（playerCore 脏数据归一化兜底）。
function eqGainsGet() {
  const arr = playbackSettings.eqGains;
  return Array.isArray(arr) ? arr.join(",") : "";
}

function eqGainsSet(v: unknown) {
  if (typeof v !== "string") {
    playbackSettings.eqGains = Array.isArray(v) ? v : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    return;
  }
  const parts = v.split(",").map((s) => s.trim());
  const nums = parts.map(Number);
  if (parts.length === 10 && nums.every((n) => Number.isFinite(n))) {
    playbackSettings.eqGains = nums.map((n) => Math.max(-12, Math.min(12, Math.round(n))));
  } else {
    playbackSettings.eqGains = parts;
  }
}

// ============ 睡眠定时器开关（保持与 SettingsModal 一致的计时语义）============
function setSleepTimerOn(v: unknown) {
  if (v) {
    if (!playbackSettings.sleepTimerOn && !sleepTimer.active) toggleSleepTimer();
  } else {
    cancelSleepTimer();
  }
}

// ============ 设置项索引 ============
// 收录原则：SettingsModal.vue 全部可交互设置项（粒度 = 单个设置字段）。
// 跳过项（交互形态超出 toggle/slider/select/text 契约，见任务汇报）：
//   libraryFolder（动作型：POST /api/library + 校验/错误 UI）、karaokeNextKey/karaokePrevKey（按键录制交互流）、
//   desktopLyricSettings.enabled（不在设置弹窗，顶栏按钮控制）、reset 类按钮（动作非设置）。
// 特殊交互项（audioExts/eqGains/cookiesFromBrowser/coverSize 等）已收录：
//   get/set 以字符串形态满足契约（数组 join/split），SettingsModal 内由 render 标记分发手写块。
export const settingsIndex = [
  // ==================== 播放 ====================
  {
    id: "playMode",
    category: "playback",
    subTab: null,
    labelKey: "settings.playMode",
    descKey: "settings.playModeDesc",
    keywords: ["播放模式", "模式", "播放顺序", "随机", "单曲循环", "play mode", "shuffle"],
    type: "select",
    options: playModeOptions,
    get: () => playbackSettings.playMode,
    set: (v) => {
      playbackSettings.playMode = v;
    },
  },
  {
    id: "resumeLast",
    category: "playback",
    subTab: null,
    labelKey: "settings.resumeLast",
    descKey: "settings.resumeLastDesc",
    keywords: ["恢复上次播放", "启动恢复", "上次播放", "断点续播", "resume", "last played"],
    type: "toggle",
    get: () => playbackSettings.resumeLast,
    set: (v) => {
      playbackSettings.resumeLast = v;
    },
  },
  {
    id: "rememberVolume",
    category: "playback",
    subTab: null,
    labelKey: "settings.rememberVolume",
    descKey: "settings.rememberVolumeDesc",
    keywords: ["记住音量", "音量记忆", "音量", "volume"],
    type: "toggle",
    get: () => playbackSettings.rememberVolume,
    set: (v) => {
      playbackSettings.rememberVolume = v;
    },
  },
  {
    id: "fadeSec",
    category: "playback",
    subTab: null,
    labelKey: "settings.fade",
    render: "fade",
    keywords: ["淡入淡出", "切歌过渡", "渐入渐出", "fade", "crossfade", "过渡"],
    type: "slider",
    min: 0,
    max: 5,
    step: 0.5,
    get: () => playbackSettings.fadeSec,
    set: (v) => {
      playbackSettings.fadeSec = v;
    },
  },
  {
    id: "eqEnabled",
    category: "playback",
    subTab: null,
    labelKey: "settings.eq",
    render: "eqPanel",
    keywords: ["均衡器", "eq", "均衡", "音效", "equalizer"],
    type: "toggle",
    get: () => playbackSettings.eqEnabled,
    set: (v) => {
      playbackSettings.eqEnabled = v;
    },
  },
  {
    id: "eqPreset",
    category: "playback",
    subTab: null,
    labelKey: "settings.eqPreset",
    render: "eqPanel", // 属于 EQ 面板内部（eqEnabled 手写块），不单独渲染
    keywords: ["均衡器预设", "eq预设", "音效预设", "preset", "流行", "摇滚", "低音"],
    type: "select",
    options: eqPresetOptions,
    get: () => playbackSettings.eqPreset,
    set: (v) => {
      playbackSettings.eqPreset = v;
    },
  },
  {
    id: "eqGains",
    category: "playback",
    subTab: null,
    labelKey: "settings.eqGains",
    render: "eqGains", // 十段滑杆特殊交互（EQ 面板内手写块），搜索层按 custom 文本内联编辑
    keywords: ["均衡器增益", "eq增益", "十段", "eq gains", "equalizer", "自定义均衡"],
    type: "custom",
    get: eqGainsGet,
    set: eqGainsSet,
  },
  {
    id: "abVisual",
    category: "playback",
    subTab: null,
    labelKey: "settings.abVisual",
    descKey: "settings.abVisualDesc",
    keywords: ["AB循环可视化", "区间可视化", "ab视觉", "ab visual", "循环标记"],
    type: "toggle",
    get: () => playbackSettings.abVisual,
    set: (v) => {
      playbackSettings.abVisual = v;
    },
  },
  {
    id: "abLoopCountOn",
    category: "playback",
    subTab: null,
    labelKey: "settings.abLoopCount",
    render: "abLoop",
    keywords: ["循环计数", "防走开", "ab循环次数", "安全阀", "count", "loop count"],
    type: "toggle",
    get: () => playbackSettings.abLoopCountOn,
    set: (v) => {
      playbackSettings.abLoopCountOn = v;
    },
  },
  {
    id: "abLoopMaxCount",
    category: "playback",
    subTab: null,
    labelKey: "settings.abLoopMaxCount",
    render: "abLoop", // 属于 AB 循环块（abLoopCountOn 手写块）内
    keywords: ["循环次数上限", "ab循环次数", "循环遍数", "loop count", "max count", "次数"],
    type: "slider",
    min: 1,
    max: 20,
    step: 1,
    get: () => playbackSettings.abLoopMaxCount,
    set: (v) => {
      playbackSettings.abLoopMaxCount = v;
    },
  },
  {
    id: "visualizerEnabled",
    category: "playback",
    subTab: null,
    labelKey: "settings.visualizer",
    render: "vizPanel",
    keywords: ["频谱", "可视化", "频谱图", "visualizer", "频谱条"],
    type: "toggle",
    get: () => playbackSettings.visualizerEnabled,
    set: (v) => {
      playbackSettings.visualizerEnabled = v;
    },
  },
  {
    id: "ambientEnabled",
    category: "playback",
    subTab: null,
    labelKey: "settings.ambient",
    render: "vizPanel", // 视觉面板内部子开关
    keywords: ["氛围背景", "光晕", "封面取色", "ambient", "呼吸"],
    type: "toggle",
    get: () => playbackSettings.ambientEnabled,
    set: (v) => {
      playbackSettings.ambientEnabled = v;
    },
  },
  {
    id: "miniSpectrumEnabled",
    category: "playback",
    subTab: null,
    labelKey: "settings.miniSpectrum",
    render: "vizPanel", // 视觉面板内部子开关
    keywords: ["迷你频谱", "频谱条", "mini", "spectrum"],
    type: "toggle",
    get: () => playbackSettings.miniSpectrumEnabled,
    set: (v) => {
      playbackSettings.miniSpectrumEnabled = v;
    },
  },
  {
    id: "visualizerStyle",
    category: "playback",
    subTab: null,
    labelKey: "settings.visualizerStyleLabel",
    render: "vizPanel", // 视觉面板内部样式 chips
    keywords: [
      "视觉化样式",
      "频谱样式",
      "波形",
      "圆环",
      "脉冲",
      "镜像",
      "粒子",
      "visualizer style",
      "radial",
      "wave",
      "pulse",
      "mirror",
      "particle",
    ],
    type: "select",
    options: VISUALIZER_STYLES.map((s) => ({ value: s.id, labelKey: s.labelKey })),
    get: () => playbackSettings.visualizerStyle,
    set: (v) => {
      playbackSettings.visualizerStyle = v;
    },
  },
  {
    id: "streamStats",
    category: "playback",
    subTab: null,
    labelKey: "settings.streamStats",
    descKey: "settings.streamStatsDesc",
    keywords: ["流媒体", "试听", "播放统计", "计入统计", "stream", "preview", "试听统计"],
    type: "toggle",
    get: () => playbackSettings.streamStats,
    set: (v) => {
      playbackSettings.streamStats = v;
    },
  },
  {
    id: "sleepTimerOn",
    category: "playback",
    subTab: null,
    labelKey: "settings.sleepTimer",
    render: "sleepTimer",
    keywords: ["睡眠定时器", "定时暂停", "定时器", "sleep", "sleep timer", "倒计时"],
    type: "toggle",
    get: () => playbackSettings.sleepTimerOn,
    set: setSleepTimerOn,
  },
  {
    id: "sleepTimerMinutes",
    category: "playback",
    subTab: null,
    labelKey: "settings.duration",
    render: "sleepTimer", // 属于睡眠定时器块（sleepTimerOn 手写块）内
    keywords: ["睡眠时长", "定时分钟", "sleep minutes", "时长", "定时"],
    // 契约：5-120（step 5）任意分钟都生效——后端 settings.py 同步接受 5-120 范围
    // （消费为纯前端倒计时）；桌面/移动端 chip 快捷值仍为 15/30/45/60/90。
    type: "slider",
    min: 5,
    max: 120,
    step: 5,
    get: () => playbackSettings.sleepTimerMinutes,
    set: (v) => {
      playbackSettings.sleepTimerMinutes = v;
    },
  },

  // ==================== 音乐库 ====================
  {
    id: "audioExts",
    category: "library",
    subTab: null,
    labelKey: "settings.fileTypes",
    render: "audioExts", // 多选 chips 特殊交互（设置弹窗内手写块），搜索层按 text 逗号编辑
    keywords: ["文件类型", "音频格式", "扩展名", "格式", "file types", "ext", "mp3", "flac"],
    type: "text",
    get: audioExtsGet,
    set: audioExtsSet,
  },
  {
    id: "ignoreHidden",
    category: "library",
    subTab: null,
    labelKey: "settings.ignoreHidden",
    descKey: "settings.ignoreHiddenDesc",
    keywords: ["隐藏文件", "忽略隐藏", "隐藏", "hidden", "忽略"],
    type: "toggle",
    get: () => libGet("ignoreHidden"),
    set: (v) => libSet("ignoreHidden", v),
  },
  {
    id: "autoRefresh",
    category: "library",
    subTab: null,
    labelKey: "settings.autoRefresh",
    descKey: "settings.autoRefreshDesc",
    keywords: ["自动刷新", "刷新曲库", "监听文件夹", "refresh", "自动更新"],
    type: "toggle",
    get: () => libGet("autoRefresh"),
    set: (v) => libSet("autoRefresh", v),
  },
  {
    id: "autoScanOnStart",
    category: "library",
    subTab: null,
    labelKey: "settings.autoScanOnStart",
    descKey: "settings.autoScanOnStartDesc",
    keywords: ["启动扫描", "开机扫描", "自动扫描", "scan", "启动时扫描"],
    type: "toggle",
    get: () => libGet("autoScanOnStart"),
    set: (v) => libSet("autoScanOnStart", v),
  },

  // ==================== 视频 ====================
  {
    id: "bilibiliCookie",
    category: "video",
    subTab: null,
    labelKey: "settings.bilibiliCookie",
    descKey: "settings.bilibiliCookieDesc",
    keywords: ["B站", "bilibili", "哔哩哔哩", "cookie", "Cookie", "在线播放", "视频有声"],
    type: "text",
    placeholder: "settings.bilibiliCookiePlaceholder",
    get: () => videoSettings.bilibiliCookie,
    set: (v) => {
      videoSettings.bilibiliCookie = v;
    },
  },
  {
    id: "cookiesFromBrowser",
    category: "video",
    subTab: null,
    labelKey: "settings.cookiesFromBrowser",
    descKey: "settings.cookiesFromBrowserDesc",
    render: "cookies", // 原生 select 特殊交互（设置弹窗内手写块）
    keywords: [
      "浏览器cookie",
      "cookie来源",
      "浏览器登录态",
      "cookie from browser",
      "vivaldi",
      "chrome",
    ],
    type: "select",
    options: browserOptions,
    get: () => videoSettings.cookiesFromBrowser,
    set: (v) => {
      videoSettings.cookiesFromBrowser = v;
    },
  },

  // ==================== 下载 ====================
  {
    id: "downloadDir",
    category: "download",
    subTab: null,
    labelKey: "settings.downloadDir",
    descKey: "settings.downloadDirDesc",
    keywords: ["下载目录", "保存位置", "下载路径", "download dir", "目录", "下载文件夹"],
    type: "text",
    placeholder: "settings.downloadDirPlaceholder",
    get: () => downloadSettings.downloadDir,
    set: (v) => {
      downloadSettings.downloadDir = v;
    },
  },
  {
    id: "maxSpeed",
    category: "download",
    subTab: null,
    labelKey: "settings.maxSpeed",
    descKey: "settings.maxSpeedDesc",
    keywords: ["下载限速", "限速", "速度限制", "max speed", "限速下载"],
    type: "text",
    inputType: "number", // 数字输入（与改造前 v-model.number 一致）
    min: 0,
    step: 0.5,
    placeholder: "settings.maxSpeedPlaceholder",
    get: () => downloadSettings.maxSpeed,
    set: (v) => {
      downloadSettings.maxSpeed = v;
    },
  },
  {
    id: "defaultQuality",
    category: "download",
    subTab: null,
    labelKey: "settings.defaultQuality",
    descKey: "settings.defaultQualityDesc",
    chips: "ext", // 设置弹窗用 ext-grid 样式（其余 select 默认 seg）
    keywords: ["音质", "默认音质", "码率", "quality", "无损", "flac", "hires"],
    type: "select",
    options: DOWNLOAD_QUALITY_OPTIONS.map((q) => ({ value: q.key, labelKey: q.labelKey })),
    get: () => downloadSettings.defaultQuality,
    set: (v) => {
      downloadSettings.defaultQuality = v;
    },
  },
  {
    id: "quarkQuality",
    category: "download",
    subTab: null,
    labelKey: "settings.quarkQuality",
    descKey: "settings.quarkQualityDesc",
    marginTop: 4,
    keywords: ["歌曲海", "夸克", "下载品质", "mp3", "flac", "无损"],
    type: "select",
    options: QUARK_QUALITY_OPTIONS.map((q) => ({ value: q.key, labelKey: q.labelKey })),
    get: () => downloadSettings.quarkQuality,
    set: (v) => {
      downloadSettings.quarkQuality = v;
    },
  },
  {
    id: "downloadEngine",
    category: "download",
    subTab: null,
    labelKey: "settings.downloadEngine",
    descKey: "settings.downloadEngineDesc",
    marginTop: 4,
    keywords: ["下载引擎", "aria2", "内置", "引擎", "下载方式"],
    type: "select",
    options: DOWNLOAD_ENGINE_OPTIONS.map((e) => ({ value: e.key, labelKey: e.labelKey })),
    get: () => downloadSettings.engine,
    set: (v) => {
      downloadSettings.engine = v;
    },
  },
  {
    id: "aria2Rpc",
    category: "download",
    subTab: null,
    labelKey: "settings.aria2Rpc",
    render: "aria2",
    keywords: ["aria2", "rpc", "下载服务器", "地址"],
    type: "text",
    placeholder: "settings.aria2RpcPlaceholder",
    get: () => downloadSettings.aria2Rpc,
    set: (v) => {
      downloadSettings.aria2Rpc = v;
    },
  },
  {
    id: "aria2Secret",
    category: "download",
    subTab: null,
    labelKey: "settings.aria2Secret",
    render: "aria2", // 与 aria2Rpc 同块（engine==='aria2' 才显示）
    keywords: ["aria2", "密钥", "token", "secret", "密码"],
    type: "text",
    placeholder: "settings.aria2SecretPlaceholder",
    get: () => downloadSettings.aria2Secret,
    set: (v) => {
      downloadSettings.aria2Secret = v;
    },
  },

  // ==================== 歌词 · APP（子 tab: app）====================
  {
    id: "engine",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.scrollEngine",
    descKey: "settings.scrollEngineDesc",
    keywords: ["滚动引擎", "引擎", "engine", "amll", "弹簧", "原生"],
    type: "select",
    options: engineOptions,
    get: () => lyricSettings.engine,
    set: (v) => {
      lyricSettings.engine = v;
    },
  },
  {
    id: "fontFamily",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.lyricFont",
    keywords: ["歌词字体", "字体", "font", "衬线", "圆体"],
    type: "select",
    options: fontOptions,
    get: () => lyricSettings.fontFamily,
    set: (v) => {
      lyricSettings.fontFamily = v;
    },
  },
  {
    id: "fontSize",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.fontSize",
    descKey: "settings.fontSizeDesc",
    valueSuffix: "px", // 设置弹窗 label 内嵌值徽标（inline）
    keywords: ["字号", "歌词大小", "字体大小", "font size", "字大小"],
    type: "slider",
    min: 14,
    max: 30,
    step: 1,
    get: () => lyricSettings.fontSize,
    set: (v) => {
      lyricSettings.fontSize = v;
    },
  },
  {
    id: "align",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.align",
    keywords: ["对齐", "对齐方式", "align", "左对齐", "居中", "右对齐"],
    type: "select",
    options: alignOptions,
    get: () => lyricSettings.align,
    set: (v) => {
      lyricSettings.align = v;
    },
  },
  {
    id: "showRoma",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.showRoma",
    descKey: "settings.showRomaDesc",
    keywords: ["罗马音", "romaji", "罗马", "假名注音"],
    type: "toggle",
    get: () => lyricSettings.showRoma,
    set: (v) => {
      lyricSettings.showRoma = v;
    },
  },
  {
    id: "showZh",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.showZh",
    descKey: "settings.showZhDesc",
    keywords: ["中文翻译", "翻译", "译文", "翻译显示", "中文", "translation"],
    type: "toggle",
    get: () => lyricSettings.showZh,
    set: (v) => {
      lyricSettings.showZh = v;
    },
  },
  {
    id: "showSec",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.showSection",
    descKey: "settings.showSectionDesc",
    keywords: ["段落标题", "小节标题", "副歌标题", "段落", "section", "标题"],
    type: "toggle",
    get: () => lyricSettings.showSec,
    set: (v) => {
      lyricSettings.showSec = v;
    },
  },
  {
    id: "focusPos",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.focusPos",
    keywords: ["焦点停靠", "停靠位置", "焦点", "focus", "焦点句"],
    type: "select",
    options: focusOptions,
    get: () => lyricSettings.focusPos,
    set: (v) => {
      lyricSettings.focusPos = v;
    },
  },
  {
    id: "fadeMask",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.fadeMask",
    descKey: "settings.fadeMaskDesc",
    keywords: ["渐隐", "遮罩", "上下渐隐", "fade mask", "淡出"],
    type: "toggle",
    get: () => lyricSettings.fadeMask,
    set: (v) => {
      lyricSettings.fadeMask = v;
    },
  },
  {
    id: "autoScroll",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.autoScroll",
    descKey: "settings.autoScrollDesc",
    keywords: ["自动滚动", "跟随滚动", "滚动", "autoscroll", "自动跟随"],
    type: "toggle",
    get: () => lyricSettings.autoScroll,
    set: (v) => {
      lyricSettings.autoScroll = v;
    },
  },
  {
    id: "amllBlur",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.amllBlur",
    descKey: "settings.amllBlurDesc",
    keywords: ["amll模糊", "模糊效果", "高斯模糊", "歌词模糊", "amll blur", "blur"],
    type: "toggle",
    get: () => lyricSettings.amllBlur,
    set: (v) => {
      lyricSettings.amllBlur = v;
    },
  },
  {
    id: "amllSpring",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.amllSpring",
    descKey: "settings.amllSpringDesc",
    keywords: ["弹簧动画", "物理动画", "amll弹簧", "弹簧", "spring", "amll spring"],
    type: "toggle",
    get: () => lyricSettings.amllSpring,
    set: (v) => {
      lyricSettings.amllSpring = v;
    },
  },
  {
    id: "amllScale",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.amllScale",
    descKey: "settings.amllScaleDesc",
    keywords: ["放大效果", "当前行放大", "amll放大", "scale", "放大动画"],
    type: "toggle",
    get: () => lyricSettings.amllScale,
    set: (v) => {
      lyricSettings.amllScale = v;
    },
  },
  {
    id: "offset",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.lyricOffset",
    render: "offset",
    keywords: ["歌词延迟", "延迟校准", "偏移", "offset", "校准", "不同步"],
    type: "slider",
    min: -2,
    max: 2,
    step: 0.1,
    get: () => lyricSettings.offset,
    set: (v) => {
      lyricSettings.offset = v;
    },
  },
  {
    id: "source",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.sourcePriority",
    descKey: "settings.sourcePriorityDesc",
    descAfter: true, // 原模板 desc 在控件下方
    keywords: ["歌词来源", "来源优先级", "本地优先", "在线优先", "source", "歌词源"],
    type: "select",
    options: sourceOptions,
    get: () => lyricSettings.source,
    set: (v) => {
      lyricSettings.source = v;
    },
  },
  {
    id: "colorScheme",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.colorScheme",
    render: "scheme",
    keywords: ["歌词配色", "配色方案", "颜色主题", "color scheme", "配色"],
    type: "select",
    options: LYRIC_SCHEMES.map((s) => ({ value: s.key, labelKey: s.labelKey })),
    get: () => lyricSettings.colorScheme,
    set: (v) => {
      lyricSettings.colorScheme = v;
    },
  },
  {
    id: "jpColor",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.mainLineColor",
    render: "fontColor", // 主行+翻译颜色同块（jpColor 宿主）
    keywords: ["主行颜色", "歌词颜色", "颜色", "color", "主行"],
    type: "text",
    placeholder: "settings.fontColorPlaceholder",
    get: () => lyricSettings.jpColor,
    set: (v) => {
      lyricSettings.jpColor = v;
    },
  },
  {
    id: "zhColor",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.translationColor",
    render: "fontColor", // 与 jpColor 同块
    keywords: ["翻译颜色", "翻译行颜色", "译文颜色", "translation color"],
    type: "text",
    placeholder: "settings.fontColorPlaceholder",
    get: () => lyricSettings.zhColor,
    set: (v) => {
      lyricSettings.zhColor = v;
    },
  },

  // ==================== 歌词 · 桌面（子 tab: desktop）====================
  {
    id: "desktopShowZh",
    category: "lyric",
    subTab: "desktop",
    labelKey: "settings.showZh",
    descKey: "settings.desktopShowZhDesc",
    keywords: ["桌面歌词翻译", "桌面翻译", "翻译", "desktop translation", "悬浮窗翻译"],
    type: "toggle",
    get: () => desktopLyricSettings.showZh,
    set: (v) => {
      desktopLyricSettings.showZh = v;
    },
  },
  {
    id: "desktopFontFamily",
    category: "lyric",
    subTab: "desktop",
    labelKey: "settings.font",
    keywords: ["桌面歌词字体", "字体", "font", "悬浮窗字体"],
    type: "select",
    options: fontOptions,
    get: () => desktopLyricSettings.fontFamily,
    set: (v) => {
      desktopLyricSettings.fontFamily = v;
    },
  },
  {
    id: "desktopFontSize",
    category: "lyric",
    subTab: "desktop",
    labelKey: "settings.mainFontSize",
    valueSuffix: "px",
    badge: "block", // 原模板徽标是 label 后的独立 div
    keywords: ["主行字号", "桌面字号", "字体大小", "font size", "主行大小"],
    type: "slider",
    min: 18,
    max: 40,
    step: 1,
    get: () => desktopLyricSettings.fontSize,
    set: (v) => {
      desktopLyricSettings.fontSize = v;
    },
  },
  {
    id: "desktopZhSize",
    category: "lyric",
    subTab: "desktop",
    labelKey: "settings.translationFontSize",
    valueSuffix: "px",
    badge: "block",
    keywords: ["翻译字号", "译文大小", "翻译大小", "translation size"],
    type: "slider",
    min: 12,
    max: 26,
    step: 1,
    get: () => desktopLyricSettings.zhSize,
    set: (v) => {
      desktopLyricSettings.zhSize = v;
    },
  },
  {
    id: "desktopAlign",
    category: "lyric",
    subTab: "desktop",
    labelKey: "settings.alignShort",
    keywords: ["对齐", "桌面歌词对齐", "align", "悬浮窗对齐"],
    type: "select",
    options: alignOptions,
    get: () => desktopLyricSettings.align,
    set: (v) => {
      desktopLyricSettings.align = v;
    },
  },
  {
    id: "desktopWidth",
    category: "lyric",
    subTab: "desktop",
    labelKey: "settings.windowWidth",
    valueSuffix: "px",
    badge: "block",
    keywords: ["窗体宽度", "窗口宽度", "宽度", "width", "悬浮窗宽度"],
    type: "slider",
    min: 300,
    max: 800,
    step: 10,
    get: () => desktopLyricSettings.width,
    set: (v) => {
      desktopLyricSettings.width = v;
    },
  },
  {
    id: "desktopHeight",
    category: "lyric",
    subTab: "desktop",
    labelKey: "settings.windowHeight",
    valueSuffix: "px",
    badge: "block",
    keywords: ["窗体高度", "窗口高度", "高度", "height", "悬浮窗高度"],
    type: "slider",
    min: 80,
    max: 300,
    step: 10,
    get: () => desktopLyricSettings.height,
    set: (v) => {
      desktopLyricSettings.height = v;
    },
  },
  {
    id: "desktopColorScheme",
    category: "lyric",
    subTab: "desktop",
    labelKey: "settings.colorScheme",
    render: "scheme",
    keywords: ["桌面歌词配色", "配色方案", "color scheme", "悬浮窗配色", "配色"],
    type: "select",
    options: DESKTOP_LYRIC_SCHEMES.map((s) => ({ value: s.key, labelKey: s.labelKey })),
    get: () => desktopLyricSettings.colorScheme,
    set: (v) => {
      desktopLyricSettings.colorScheme = v;
    },
  },
  {
    id: "desktopJpColor",
    category: "lyric",
    subTab: "desktop",
    labelKey: "settings.mainLineColor",
    render: "fontColor", // 主行+翻译颜色同块（desktopJpColor 宿主）
    keywords: ["主行颜色", "桌面歌词颜色", "颜色", "color"],
    type: "text",
    placeholder: "settings.fontColorPlaceholder",
    get: () => desktopLyricSettings.jpColor,
    set: (v) => {
      desktopLyricSettings.jpColor = v;
    },
  },
  {
    id: "desktopZhColor",
    category: "lyric",
    subTab: "desktop",
    labelKey: "settings.translationColor",
    render: "fontColor", // 与 desktopJpColor 同块
    keywords: ["翻译颜色", "桌面翻译颜色", "译文颜色"],
    type: "text",
    placeholder: "settings.fontColorPlaceholder",
    get: () => desktopLyricSettings.zhColor,
    set: (v) => {
      desktopLyricSettings.zhColor = v;
    },
  },

  // ==================== 界面 ====================
  {
    id: "theme",
    category: "ui",
    subTab: null,
    labelKey: "settings.appearance",
    marginTop: 8,
    keywords: ["主题", "外观", "深色", "浅色", "theme", "暗色", "亮色"],
    type: "select",
    options: themeOptions,
    get: () => uiSettings.theme,
    set: (v) => {
      uiSettings.theme = v;
    },
  },
  {
    id: "miniTheme",
    category: "ui",
    subTab: null,
    labelKey: "settings.miniTheme",
    marginTop: 8,
    keywords: ["迷你窗", "迷你窗外观", "迷你主题", "mini theme", "mini"],
    type: "select",
    options: miniThemeOptions,
    get: () => uiSettings.miniTheme,
    set: (v) => {
      uiSettings.miniTheme = v;
    },
  },
  {
    id: "accent",
    category: "ui",
    subTab: null,
    labelKey: "settings.accent",
    render: "accent",
    keywords: ["强调色", "主题色", "accent", "颜色主题", "橙", "蓝", "绿", "紫", "粉", "青"],
    type: "select",
    options: accentOptions,
    get: () => uiSettings.accent,
    set: (v) => {
      uiSettings.accent = v;
    },
  },
  {
    id: "coverBlur",
    category: "ui",
    subTab: null,
    labelKey: "settings.coverBlur",
    descKey: "settings.coverBlurDesc",
    keywords: ["封面模糊", "模糊背景", "毛玻璃", "blur", "封面背景"],
    type: "toggle",
    get: () => uiSettings.coverBlur,
    set: (v) => {
      uiSettings.coverBlur = v;
    },
  },
  {
    id: "glassCover",
    category: "ui",
    subTab: null,
    labelKey: "settings.glassCover",
    descKey: "settings.glassCoverDesc",
    mobileOnly: true, // 毛玻璃封面仅移动端生效（设置弹窗桌面端不渲染）
    keywords: ["毛玻璃", "毛玻璃封面", "模糊封面", "glass cover", "玻璃", "移动端背景"],
    type: "toggle",
    get: () => uiSettings.glassCover,
    set: (v) => {
      uiSettings.glassCover = v;
    },
  },
  {
    id: "showCover",
    category: "ui",
    subTab: null,
    labelKey: "settings.showCover",
    descKey: "settings.showCoverDesc",
    keywords: ["显示封面", "封面", "隐藏封面", "封面显示", "show cover", "cover", "大封面"],
    type: "toggle",
    get: () => uiSettings.showCover,
    set: (v) => {
      uiSettings.showCover = v;
    },
  },
  {
    id: "showListCover",
    category: "ui",
    subTab: null,
    labelKey: "settings.showListCover",
    descKey: "settings.showListCoverDesc",
    keywords: ["列表封面", "缩略图", "列表缩略图", "封面", "list cover", "thumbnail"],
    type: "toggle",
    get: () => uiSettings.showListCover,
    set: (v) => {
      uiSettings.showListCover = v;
    },
  },
  {
    id: "coverSize",
    category: "ui",
    subTab: null,
    labelKey: "settings.coverSize",
    descKey: "settings.coverSizeDesc",
    render: "coverSize", // 百分比/自适应特殊显示（设置弹窗内手写块），搜索层按 slider 内联调
    keywords: ["封面大小", "封面区域", "封面尺寸", "cover size", "自适应"],
    type: "slider",
    min: 0,
    max: 420,
    step: 10,
    get: () => uiSettings.coverSize,
    set: (v) => {
      uiSettings.coverSize = v;
    },
  },
  {
    id: "compact",
    category: "ui",
    subTab: null,
    labelKey: "settings.compact",
    descKey: "settings.compactDesc",
    keywords: ["紧凑模式", "紧凑", "compact", "密度"],
    type: "toggle",
    get: () => uiSettings.compact,
    set: (v) => {
      uiSettings.compact = v;
    },
  },
  {
    id: "showSongInfo",
    category: "ui",
    subTab: null,
    labelKey: "settings.showSongInfo",
    descKey: "settings.showSongInfoDesc",
    keywords: ["歌曲信息", "歌名歌手", "当前歌曲", "song info", "跟唱信息"],
    type: "toggle",
    get: () => uiSettings.showSongInfo,
    set: (v) => {
      uiSettings.showSongInfo = v;
    },
  },
  {
    id: "karaokeShowTime",
    category: "ui",
    subTab: null,
    labelKey: "settings.karaokeShowTime",
    descKey: "settings.karaokeShowTimeDesc",
    keywords: ["时间戳", "跟唱时间", "ktv时间", "起止时间", "timestamp"],
    type: "toggle",
    get: () => uiSettings.karaokeShowTime,
    set: (v) => {
      uiSettings.karaokeShowTime = v;
    },
  },
  {
    id: "karaokeShowNum",
    category: "ui",
    subTab: null,
    labelKey: "settings.karaokeShowNum",
    descKey: "settings.karaokeShowNumDesc",
    keywords: ["行号", "跟唱行号", "句号", "行号显示", "line number"],
    type: "toggle",
    get: () => uiSettings.karaokeShowNum,
    set: (v) => {
      uiSettings.karaokeShowNum = v;
    },
  },
] satisfies SettingEntry[];

// ============ 查询辅助（供搜索层复用）============
// 分类 → 子 tab 校验：非 lyric 分类 subTab 恒为 null
export function isLyricEntry(entry: SettingEntry) {
  return entry.category === "lyric";
}

export function categoryByKey(key: string) {
  return SETTING_CATEGORIES.find((c) => c.key === key) || null;
}

export function entriesByCategory(category: string) {
  return settingsIndex.filter((e) => e.category === category);
}

export { CATEGORY_KEYS };
