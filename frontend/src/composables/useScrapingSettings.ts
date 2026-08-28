// 刮削设置（scraping · 后端 GET/PUT /api/library/settings 持久化）
//
// 契约（后端并行开发中，字段缺失/接口未合并时前端容错）：
//   GET/PUT /api/library/settings → settings.scraping:
//   {
//     "enabled_fields": ["title","artist","album","cover","year","genre","track","album_artist"],
//     "rename_template": "{artist} - {title}",
//     "source_order": ["netease", "musicbrainz"],
//     "batch_enabled": false
//   }
//
// 保存走与音乐库设置同一链路（/api/library/settings；调用方负责防抖，参照
// SettingsModal.saveLib 的 saveLibrarySettings 模式）。
import { reactive } from "vue";
import { apiGet, apiPut, invalidate } from "../utils/apiClient.js";
import i18n from "../locales/i18n.js";

/** 可刮削字段（UI 固定顺序；歌曲对象字段：title=name / artist / album / cover / year / genre / track / album_artist） */
export type ScrapingField =
  "title" | "artist" | "album" | "cover" | "year" | "genre" | "track" | "album_artist";

/** 刮削源（UI 固定顺序；优先级列表为其中的子集） */
export type ScrapingSource = "netease" | "musicbrainz";

/** 刮削设置结构（后端 settings.scraping 命名空间；字段值为宽松 string——
 *  组件层做白名单/顺序操作时按 string 处理，规范化入口负责收敛到白名单） */
export interface ScrapingSettings {
  enabled_fields: string[];
  rename_template: string;
  source_order: string[];
  batch_enabled: boolean;
}

/** 保存结果：{ ok, error }（不抛——批量入口与设置 tab 统一用返回值提示；error 仅 ok=false 时有意义） */
export interface ScrapingSaveResult {
  ok: boolean;
  error: string;
}

// 可刮削字段（UI 固定顺序；歌曲对象字段：title=name / artist / album / cover / year / genre / track / album_artist）
export const SCRAPING_FIELDS: ScrapingField[] = [
  "title",
  "artist",
  "album",
  "cover",
  "year",
  "genre",
  "track",
  "album_artist",
];

// 刮削源（UI 固定顺序；优先级列表为其中的子集）
export const SCRAPING_SOURCES: ScrapingSource[] = ["netease", "musicbrainz"];

export const SCRAPING_SETTINGS_DEFAULTS: ScrapingSettings = {
  enabled_fields: [...SCRAPING_FIELDS],
  rename_template: "{artist} - {title}",
  source_order: [...SCRAPING_SOURCES],
  batch_enabled: false, // 默认关闭：关闭时右键菜单与一键补全入口隐藏
};

export const scrapingSettings = reactive<ScrapingSettings>({ ...SCRAPING_SETTINGS_DEFAULTS });

// ---------- 规范化（非法值回落默认，容错后端未合并/字段缺失） ----------
function normEnabledFields(v: unknown): ScrapingField[] {
  if (!Array.isArray(v)) return [...SCRAPING_FIELDS];
  return SCRAPING_FIELDS.filter((f) => (v as unknown[]).includes(f)); // 白名单过滤 + 固定顺序
}

function normSourceOrder(v: unknown): ScrapingSource[] {
  if (!Array.isArray(v)) return [...SCRAPING_SOURCES];
  return SCRAPING_SOURCES.filter((s) => (v as unknown[]).includes(s)); // 白名单过滤 + 固定顺序
}

// 字段级应用（k in target 才覆盖；后端缺失的字段保持本地默认/当前值）
export function applyScrapingSettings(saved: Partial<ScrapingSettings> | null | undefined): void {
  if (!saved || typeof saved !== "object") return;
  if ("enabled_fields" in saved)
    scrapingSettings.enabled_fields = normEnabledFields(saved.enabled_fields);
  if ("rename_template" in saved) {
    scrapingSettings.rename_template =
      typeof saved.rename_template === "string"
        ? saved.rename_template
        : SCRAPING_SETTINGS_DEFAULTS.rename_template;
  }
  if ("source_order" in saved) scrapingSettings.source_order = normSourceOrder(saved.source_order);
  if ("batch_enabled" in saved) {
    scrapingSettings.batch_enabled =
      typeof saved.batch_enabled === "boolean"
        ? saved.batch_enabled
        : SCRAPING_SETTINGS_DEFAULTS.batch_enabled;
  }
}

// 初始加载：GET /api/library/settings → settings.scraping 字段级应用
// （GET 完成前不 PUT 的门闩由调用方防抖时机保证；此处只管应用与容错）
export async function loadScrapingSettings(): Promise<void> {
  try {
    // 设置类元数据：60s + 离线兜底（与 loadLibrarySettings 同款）
    const r = await apiGet("/api/library/settings", { cache: { ttl: 60, offline: true } });
    if (!r.ok || r.network) return;
    applyScrapingSettings((r.data && r.data.settings && r.data.settings.scraping) || null);
  } catch {
    /* 后端不可达：保持本地默认/上次缓存 */
  }
}

// 保存：PUT /api/library/settings {scraping: 全字段}（调用方防抖）
// 返回 {ok, error?}（不抛——批量入口与设置 tab 统一用返回值提示）
export async function saveScrapingSettings(
  patch: Partial<ScrapingSettings> = {},
): Promise<ScrapingSaveResult> {
  Object.assign(scrapingSettings, patch);
  try {
    const r = await apiPut("/api/library/settings", { scraping: { ...scrapingSettings } });
    if (!r.ok) {
      const data = r.data || {};
      return { ok: false, error: data.detail || i18n.global.t("errors.saveLibrarySettings") };
    }
    invalidate("/api/library/settings");
    // 后端回读的 scraping（未合并时缺失 → 保持本地值）
    applyScrapingSettings((r.data && r.data.settings && r.data.settings.scraping) || null);
    return { ok: true, error: "" };
  } catch {
    return { ok: false, error: i18n.global.t("errors.saveLibrarySettings") };
  }
}

/** renderRenamePreview 的歌曲入参（宽松键值视图：字段可缺省/可扩展） */
export interface RenamePreviewSong {
  name?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  track?: unknown;
  year?: unknown;
  [key: string]: unknown;
}

// ============ 重命名模板实时预览（纯函数，可单测） ============
// 支持占位符 {artist} {title} {album} {track} {year}；缺值替换为空串；
// "/" 作为目录分隔符原样保留（提示文案里说明）；无模板/无歌曲返回空串。
export function renderRenamePreview(
  template: string,
  song: RenamePreviewSong | null | undefined,
): string {
  if (!template || typeof template !== "string" || !song) return "";
  const values = {
    artist: song.artist != null ? String(song.artist) : "",
    title: song.title != null ? String(song.title) : song.name != null ? String(song.name) : "",
    album: song.album != null ? String(song.album) : "",
    track: song.track != null && song.track !== "" ? String(song.track) : "",
    year: song.year != null && song.year !== "" ? String(song.year) : "",
  };
  let out = template;
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}
