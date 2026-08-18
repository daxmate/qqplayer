/**
 * 电子书阅读器 - 阅读设置（后端 /api/settings books namespace，深合并）
 *
 * 约定（任务 A 后端契约）：books namespace 追加 7 字段 fontFamily/fontSize/lineHeight/
 * margin/theme/textColor/bgColor；A 合入前后端可能只有 lastReadId，读取时逐字段兜底默认。
 * 设置持久化在后端，localStorage 只读不写（仅一次性迁移旧字号，见 Reader.vue）。
 */
import type { ReaderFontKey, ReaderSettings } from "./types";
import { uiSettings } from "../composables/useSettings.js";

const THEMES = ["light", "sepia", "dark", "auto"] as const;

/**
 * 阅读字体选项（iBooks 式：每项用自身字形渲染预览 + 选中打勾）。
 * key 存设置（保留 V2 四个 key 兼容旧设置），fontFamily 是 epubjs themes 用的
 * CSS font-family（含回退栈；中文场景带衬线/无衬线兜底），default 为空 = 跟随 EPUB 默认。
 */
export interface ReaderFontOption {
  key: ReaderFontKey;
  labelKey: string;
  /** CSS font-family（回退栈写法），default 为空字符串 */
  fontFamily: string;
}

export const READER_FONT_OPTIONS: ReaderFontOption[] = [
  { key: "default", labelKey: "books.fontDefault", fontFamily: "" },
  // 衬线
  {
    key: "serif",
    labelKey: "books.fontGeorgia",
    fontFamily: "Georgia, 'Times New Roman', serif",
  },
  {
    key: "palatino",
    labelKey: "books.fontPalatino",
    fontFamily: "Palatino, 'Palatino Linotype', 'Book Antiqua', 'Times New Roman', serif",
  },
  {
    key: "charter",
    labelKey: "books.fontCharter",
    fontFamily: "Charter, Georgia, 'Times New Roman', serif",
  },
  {
    key: "new-york",
    labelKey: "books.fontNewYork",
    fontFamily: "'New York', Georgia, 'Times New Roman', serif",
  },
  {
    key: "songti-sc",
    labelKey: "books.fontSongti",
    fontFamily: "'Songti SC', STSong, SimSun, 'Times New Roman', serif",
  },
  // 无衬线
  {
    key: "sans",
    labelKey: "books.fontHelveticaNeue",
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  {
    key: "avenir-next",
    labelKey: "books.fontAvenirNext",
    fontFamily: "'Avenir Next', Avenir, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  {
    key: "pingfang-sc",
    labelKey: "books.fontPingfang",
    fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  },
  // 圆体 / 楷体
  {
    key: "rounded",
    labelKey: "books.fontAvenirRounded",
    fontFamily: "'Avenir Next Rounded', 'Arial Rounded MT Bold', sans-serif",
  },
  {
    key: "kaiti-sc",
    labelKey: "books.fontKaiti",
    fontFamily: "'Kaiti SC', STKaiti, KaiTi, serif",
  },
];

/** 字体 key → CSS font-family（未知 key 返回空 = 不覆盖，安全兜底） */
export function readerFontCss(key: ReaderFontKey): string {
  return READER_FONT_OPTIONS.find((o) => o.key === key)?.fontFamily ?? "";
}

/**
 * 排版预设（V3，iBooks 式顶部一排；只含 字体+字号+行距+边距，不含颜色 theme——
 * 颜色仍走独立主题切换，两者不冲突）。
 */
export interface TypographyPreset {
  key: string;
  labelKey: string;
  fontFamily: ReaderFontKey;
  fontSize: number;
  lineHeight: number;
  margin: number;
}

export const TYPOGRAPHY_PRESETS: TypographyPreset[] = [
  {
    key: "default",
    labelKey: "books.presetDefault",
    fontFamily: "default",
    fontSize: 100,
    lineHeight: 1.6,
    margin: 4,
  },
  {
    key: "compact",
    labelKey: "books.presetCompact",
    fontFamily: "sans",
    fontSize: 95,
    lineHeight: 1.4,
    margin: 2,
  },
  {
    key: "relaxed",
    labelKey: "books.presetRelaxed",
    fontFamily: "serif",
    fontSize: 105,
    lineHeight: 1.8,
    margin: 8,
  },
  {
    key: "large",
    labelKey: "books.presetLarge",
    fontFamily: "default",
    fontSize: 125,
    lineHeight: 1.7,
    margin: 4,
  },
];

export const READER_SETTINGS_DEFAULTS: ReaderSettings = {
  fontFamily: "default",
  fontSize: 100,
  lineHeight: 1.6,
  margin: 4,
  bold: false,
  theme: "light",
  textColor: "",
  bgColor: "",
};

/** 主题色预设（theme 三档；auto 运行时解析，见 resolveReaderThemeColors） */
export const READER_THEME_PRESETS: Record<
  "light" | "sepia" | "dark",
  { text: string; bg: string }
> = {
  light: { text: "#1f2328", bg: "#ffffff" },
  sepia: { text: "#5b4636", bg: "#f5ecd9" },
  dark: { text: "#c8ccd4", bg: "#1f2430" },
};

/**
 * 当前生效的主题色对：theme 预设为基础，textColor/bgColor 非空时覆盖；
 * auto 跟随 App 主题（uiSettings.theme，auto 再回落 html data-theme）。
 */
export function resolveReaderThemeColors(settings: ReaderSettings): { text: string; bg: string } {
  let key: "light" | "sepia" | "dark";
  if (settings.theme === "auto") {
    const appDark =
      uiSettings.theme === "dark" ||
      (uiSettings.theme === "auto" &&
        typeof document !== "undefined" &&
        document.documentElement.dataset.theme !== "light");
    key = appDark ? "dark" : "light";
  } else {
    key = settings.theme;
  }
  const preset = READER_THEME_PRESETS[key];
  return { text: settings.textColor || preset.text, bg: settings.bgColor || preset.bg };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`请求失败 (${res.status})`);
  return res.json() as Promise<T>;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 后端值 → 前端合法设置：字段缺失/类型非法回落默认，数值 clamp（后端 A 落地的双保险） */
function normalize(raw: Partial<ReaderSettings> | undefined | null): ReaderSettings {
  const d = READER_SETTINGS_DEFAULTS;
  const s: ReaderSettings = { ...d };
  if (!raw || typeof raw !== "object") return s;
  if (
    typeof raw.fontFamily === "string" &&
    READER_FONT_OPTIONS.some((o) => o.key === raw.fontFamily)
  ) {
    s.fontFamily = raw.fontFamily as ReaderFontKey;
  }
  if (typeof raw.fontSize === "number" && Number.isFinite(raw.fontSize)) {
    s.fontSize = Math.round(clamp(raw.fontSize, 70, 200));
  }
  if (typeof raw.lineHeight === "number" && Number.isFinite(raw.lineHeight)) {
    s.lineHeight = clamp(Math.round(raw.lineHeight * 10) / 10, 1.0, 2.0);
  }
  if (typeof raw.margin === "number" && Number.isFinite(raw.margin)) {
    s.margin = Math.round(clamp(raw.margin, 0, 15));
  }
  if (typeof raw.bold === "boolean") s.bold = raw.bold;
  if (typeof raw.theme === "string" && (THEMES as readonly string[]).includes(raw.theme)) {
    s.theme = raw.theme as ReaderSettings["theme"];
  }
  if (typeof raw.textColor === "string") s.textColor = raw.textColor;
  if (typeof raw.bgColor === "string") s.bgColor = raw.bgColor;
  return s;
}

/** 读取阅读设置：失败/缺字段返回默认值，不抛异常 */
export async function getReaderSettings(): Promise<ReaderSettings> {
  try {
    const data = await request<{ settings?: { books?: Partial<ReaderSettings> } }>("/api/settings");
    return normalize(data.settings?.books);
  } catch {
    return { ...READER_SETTINGS_DEFAULTS };
  }
}

/** 保存阅读设置（books namespace 深合并；失败静默返回 false，成功返回 true） */
export function saveReaderSettings(patch: Partial<ReaderSettings>): Promise<boolean> {
  return request<void>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ books: patch }),
  })
    .then(() => true)
    .catch(() => false);
}
