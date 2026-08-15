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
// 持久化说明：
//   - 常规项：set() 只赋 settings reactive 属性，settingsSync 的 deep watch 自动
//     防抖 PUT /api/settings 持久化（不要手动调 API）。
//   - 音乐库项（ignoreHidden/autoRefresh/autoScanOnStart）：字段在 state.librarySettings
//     （后端 /api/library/settings 管理），不走 settingsSync——set() 调 saveLibrarySettings
//     保持与 SettingsModal 相同的持久化路径。
//   - sleepTimerOn：开关语义与 SettingsModal 一致——开启 = 启动倒计时（toggleSleepTimer），
//     关闭 = 取消（cancelSleepTimer），仅赋字段不会真正计时。
import {
  state,
  playbackSettings,
  lyricSettings,
  uiSettings,
  desktopLyricSettings,
  downloadSettings,
  saveLibrarySettings,
  EQ_PRESETS,
  LYRIC_SCHEMES,
  DESKTOP_LYRIC_SCHEMES,
  ACCENT_OPTIONS,
  DOWNLOAD_QUALITY_OPTIONS,
  QUARK_QUALITY_OPTIONS,
  DOWNLOAD_ENGINE_OPTIONS,
} from "./composables/usePlayer.js";
import { sleepTimer, toggleSleepTimer, cancelSleepTimer } from "./composables/useSleepTimer.js";

// ============ 设置分类 ============
export const SETTING_CATEGORIES = [
  { key: "playback", labelKey: "settings.category.playback" },
  { key: "library", labelKey: "settings.category.library" },
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
  { value: "system", labelKey: "settings.fontSystem" },
  { value: "serif", labelKey: "settings.fontSerif" },
  { value: "rounded", labelKey: "settings.fontRounded" },
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
const LIB_DEFAULTS = { ignoreHidden: true, autoRefresh: true, autoScanOnStart: true };

function libGet(key) {
  return state.librarySettings?.[key] ?? LIB_DEFAULTS[key];
}

function libSet(key, v) {
  // 与 SettingsModal 相同的持久化路径（PUT /api/library/settings，成功后回写 state）
  saveLibrarySettings({ [key]: v }).catch(() => {});
}

// ============ 睡眠定时器开关（保持与 SettingsModal 一致的计时语义）============
function setSleepTimerOn(v) {
  if (v) {
    if (!playbackSettings.sleepTimerOn && !sleepTimer.active) toggleSleepTimer();
  } else {
    cancelSleepTimer();
  }
}

// ============ 设置项索引 ============
// 收录原则：SettingsModal.vue 全部可交互设置项（粒度 = 单个设置字段）。
// 跳过项（交互形态超出 toggle/slider/select/text 契约，见任务汇报）：
//   libraryFolder（动作型：POST /api/library + 校验/错误 UI）、audioExts（多选数组）、
//   eqGains（10 段数组）、karaokeNextKey/karaokePrevKey（按键录制交互流）、
//   desktopLyricSettings.enabled（不在设置弹窗，顶栏按钮控制）、reset 类按钮（动作非设置）。
export const settingsIndex = [
  // ==================== 播放 ====================
  {
    id: "playMode",
    category: "playback",
    subTab: null,
    labelKey: "settings.playMode",
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
    keywords: ["均衡器预设", "eq预设", "音效预设", "preset", "流行", "摇滚", "低音"],
    type: "select",
    options: eqPresetOptions,
    get: () => playbackSettings.eqPreset,
    set: (v) => {
      playbackSettings.eqPreset = v;
    },
  },
  {
    id: "abVisual",
    category: "playback",
    subTab: null,
    labelKey: "settings.abVisual",
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
    keywords: ["频谱", "可视化", "频谱图", "visualizer", "频谱条"],
    type: "toggle",
    get: () => playbackSettings.visualizerEnabled,
    set: (v) => {
      playbackSettings.visualizerEnabled = v;
    },
  },
  {
    id: "sleepTimerOn",
    category: "playback",
    subTab: null,
    labelKey: "settings.sleepTimer",
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
    keywords: ["睡眠时长", "定时分钟", "sleep minutes", "时长", "定时"],
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
    id: "ignoreHidden",
    category: "library",
    subTab: null,
    labelKey: "settings.ignoreHidden",
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
    keywords: ["启动扫描", "开机扫描", "自动扫描", "scan", "启动时扫描"],
    type: "toggle",
    get: () => libGet("autoScanOnStart"),
    set: (v) => libSet("autoScanOnStart", v),
  },

  // ==================== 下载 ====================
  {
    id: "downloadDir",
    category: "download",
    subTab: null,
    labelKey: "settings.downloadDir",
    keywords: ["下载目录", "保存位置", "下载路径", "download dir", "目录", "下载文件夹"],
    type: "text",
    placeholder: "settings.downloadDirPlaceholder",
    get: () => downloadSettings.downloadDir,
    set: (v) => {
      downloadSettings.downloadDir = v;
    },
  },
  {
    id: "defaultQuality",
    category: "download",
    subTab: null,
    labelKey: "settings.defaultQuality",
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
    keywords: ["自动滚动", "跟随滚动", "滚动", "autoscroll", "自动跟随"],
    type: "toggle",
    get: () => lyricSettings.autoScroll,
    set: (v) => {
      lyricSettings.autoScroll = v;
    },
  },
  {
    id: "offset",
    category: "lyric",
    subTab: "app",
    labelKey: "settings.lyricOffset",
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
    keywords: ["封面模糊", "模糊背景", "毛玻璃", "blur", "封面背景"],
    type: "toggle",
    get: () => uiSettings.coverBlur,
    set: (v) => {
      uiSettings.coverBlur = v;
    },
  },
  {
    id: "compact",
    category: "ui",
    subTab: null,
    labelKey: "settings.compact",
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
    keywords: ["行号", "跟唱行号", "句号", "行号显示", "line number"],
    type: "toggle",
    get: () => uiSettings.karaokeShowNum,
    set: (v) => {
      uiSettings.karaokeShowNum = v;
    },
  },
];

// ============ 查询辅助（供搜索层复用）============
// 分类 → 子 tab 校验：非 lyric 分类 subTab 恒为 null
export function isLyricEntry(entry) {
  return entry.category === "lyric";
}

export function categoryByKey(key) {
  return SETTING_CATEGORIES.find((c) => c.key === key) || null;
}

export function entriesByCategory(category) {
  return settingsIndex.filter((e) => e.category === category);
}

export { CATEGORY_KEYS };
