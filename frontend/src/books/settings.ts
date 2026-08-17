/**
 * 电子书阅读器 - 阅读设置（后端 /api/settings books namespace，深合并）
 *
 * 约定（任务 A 后端契约）：books namespace 追加 7 字段 fontFamily/fontSize/lineHeight/
 * margin/theme/textColor/bgColor；A 合入前后端可能只有 lastReadId，读取时逐字段兜底默认。
 * 设置持久化在后端，localStorage 只读不写（仅一次性迁移旧字号，见 Reader.vue）。
 */
import type { ReaderSettings } from "./types";
import { uiSettings } from "../composables/useSettings.js";

const FONT_FAMILIES = ["default", "serif", "sans", "rounded"] as const;
const THEMES = ["light", "sepia", "dark", "auto"] as const;

export const READER_SETTINGS_DEFAULTS: ReaderSettings = {
  fontFamily: "default",
  fontSize: 100,
  lineHeight: 1.6,
  margin: 4,
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
    (FONT_FAMILIES as readonly string[]).includes(raw.fontFamily)
  ) {
    s.fontFamily = raw.fontFamily as ReaderSettings["fontFamily"];
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
