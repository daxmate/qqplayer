import { computed, watch } from "vue";
import { audio } from "./audioEngine.ts";
import { state, type LyricLine, type Song } from "./playerState.ts";
import { lyricSettings } from "./useSettings.js";
import { parseLrcText, mergeTranslationLines } from "../utils/parseLrc.js";
import { apiGet, apiPost, apiPut, apiDelete, invalidate } from "../utils/apiClient.js";
import { syncEnabled, nativeMetaSave, nativeMetaLoad, lyricKindKey } from "../utils/sync.js";
import i18n from "../locales/i18n.js";

// 非本地歌（stream 曲库网络条目 / 试听 / URL 播放）：没有可解析的本地歌词文件，
// 按歌名/歌手走在线候选链路（/api/lyric/search 返回候选 LRC 全文 + 翻译），
// 前端解析成与后端 /api/lyric 一致的 lines 结构。失败/无结果返回空歌词（不抛错）。

/** 歌词载荷：lines + 来源信息（在线候选 / 文件兜底共用） */
interface LyricPayload {
  lines: LyricLine[];
  format: string | null;
  source: string | null;
}

/** 在线歌词搜索候选（/api/lyric/search results 条目） */
interface LyricSearchCandidate {
  title?: string;
  artist?: string;
  source?: string;
  text?: string;
  tlyric?: string;
  [key: string]: unknown;
}

/** 手动歌词状态（/api/lyric/manual 响应；fetchManualLyric 未命中时 { specified: false }） */
interface ManualLyricState {
  specified?: boolean;
  path?: string;
  format?: string;
  text?: string;
  source?: string;
  tlyric?: string;
  [key: string]: unknown;
}

/** AI 歌词对齐结果（后端 /api/lyric/align 响应） */
interface AlignResult {
  lrc?: string;
  lines?: unknown;
  duration?: number;
  [key: string]: unknown;
}

export async function loadOnlineLyricForSong(song: Song): Promise<LyricPayload> {
  try {
    const q = new URLSearchParams({ title: song.name || "", artist: song.artist || "" });
    // 歌词搜索结果：1h 缓存 + 离线兜底（离线也能看最近搜过的歌词）
    const r = await apiGet("/api/lyric/search?" + q.toString(), {
      cache: { ttl: 3600, offline: true },
    });
    if (!r.ok) return { lines: [], format: null, source: null };
    const data = r.data || {};
    const results = (Array.isArray(data.results) ? data.results : []) as LyricSearchCandidate[];
    if (!results.length) return { lines: [], format: null, source: null };
    // 首选歌名精确匹配且有歌词的候选；否则第一个带歌词的
    const exact = results.find((r) => r.text && r.title === song.name);
    const hit = exact || results.find((r) => r.text);
    if (!hit) return { lines: [], format: null, source: null };
    let lines = parseLrcText(hit.text || "") as LyricLine[];
    if (hit.tlyric) lines = mergeTranslationLines(lines, parseLrcText(hit.tlyric));
    return { lines, format: lines.length ? "lrc" : null, source: hit.source || "online" };
  } catch {
    return { lines: [], format: null, source: null };
  }
}

// ============ 歌词文件兜底（阶段 F2：iOS 壳 IndexedDB 重启不可靠 → 歌词落文件） ============
// 模式对齐 sync.js nativeMetaSave/Load（Documents/meta/{kind}.json 双写）：成功加载后把
// 最后一次 {lines, format, source} 落文件（fire-and-forget）；网络失败且 IndexedDB 缓存 miss
// 时读文件回填——离线/重启后歌词不丢。kind = lyricKindKey(path)（'lyric:' + 稳定哈希，
// 纯十六进制无路径穿越风险；原生 MetaStore 亦有 kind 净化双保险）。
// 非 iOS 壳（syncEnabled false）→ 不写不读，桌面行为零变化。

/** 歌词落文件（fire-and-forget；失败静默，不影响加载链路） */
async function saveLyricFile(song: Song, data: LyricPayload): Promise<void> {
  if (!syncEnabled() || !song || !song.path) return;
  try {
    const kind = await lyricKindKey(song.path);
    if (!kind) return;
    nativeMetaSave(kind, JSON.stringify(data));
  } catch {
    /* 静默 */
  }
}

/** 读歌词文件兜底；文件缺失/损坏/非 iOS 壳 → null */
async function loadLyricFile(song: Song): Promise<LyricPayload | null> {
  if (!syncEnabled() || !song || !song.path) return null;
  try {
    const kind = await lyricKindKey(song.path);
    if (!kind) return null;
    const json = await nativeMetaLoad(kind);
    if (!json) return null;
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.lines)) return null;
    return {
      lines: data.lines,
      format: typeof data.format === "string" ? data.format : null,
      source: typeof data.source === "string" ? data.source : null,
    };
  } catch {
    return null; // JSON 损坏等 → 按无兜底处理
  }
}

// 歌词加载 URL（缓存 key / 失效共用同一构造，保证路径一致）
function lyricUrl(path: string | null, prefer: string): string {
  return (
    "/api/lyric?path=" +
    encodeURIComponent(path as string) +
    "&prefer=" +
    encodeURIComponent(prefer)
  );
}

/** 歌词文件本地读取快速超时（ms）：原生 metaLoad 异常挂起时兜底，防歌词加载被拖住 */
const LOCAL_LYRIC_READ_TIMEOUT_MS = 1500;

// ============ 歌词加载（默认当前歌）；来源优先级按 lyricSettings.source：============
// 'local' 本地优先 | 'online' 在线优先（在线失败后端自动回退本地）
export async function loadLyric(index: number = state.currentIndex): Promise<void> {
  if (index < 0 || index >= state.songs.length) {
    state.lyric = [];
    state.lyricFormat = null;
    state.lyricSource = null;
    return;
  }
  const song = state.songs[index];
  // 非本地歌（stream 网络歌 / path 为 null）：在线歌词链路（歌名/歌手搜索）
  if (!song.path || song.type === "stream") {
    const res = await loadOnlineLyricForSong(song);
    state.lyric = res.lines;
    state.lyricFormat = res.format;
    state.lyricSource = res.source;
    return;
  }
  try {
    // 本地优先（2026-08-27 用户原则：播放/歌词本地优先，没有才找主机）：
    // 先读歌词文件兜底（同步中心落盘 Documents/meta/lyric:<hash>.json，毫秒级）——
    // 命中立即显示，离线也秒出（不等待网络超时）；随后远程并行拉取，成功则覆盖刷新（在线更新）。
    // 快速超时兜底：原生 metaLoad 异常挂起时 1.5s 视为无文件，不阻塞歌词加载。
    const local = await Promise.race([
      loadLyricFile(song),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOCAL_LYRIC_READ_TIMEOUT_MS)),
    ]);
    if (local) {
      state.lyric = local.lines;
      state.lyricFormat = local.format;
      state.lyricSource = local.source;
    }
    // 远程：断网时 api 内部短路立即失败（不等待超时）；在线成功 → 覆盖 + 更新文件
    const r = await apiGet(lyricUrl(state.songs[index].path, lyricSettings.source), {
      cache: { ttl: 3600, offline: true },
    });
    if (r.ok) {
      const data = r.data || {};
      const lines = data.lines || [];
      // 仅当远程有内容（或本地为空）时覆盖——本地已显示且远程空（后端无歌词）保持现状
      if (lines.length || !local) {
        state.lyric = lines;
        state.lyricFormat = data.format || null;
        state.lyricSource = data.source || null;
      }
      // 歌词文件兜底写（fire-and-forget）：最后一次成功结果，不区分 prefer 来源
      saveLyricFile(song, {
        lines: state.lyric,
        format: state.lyricFormat,
        source: state.lyricSource,
      });
      return;
    }
    // 远程失败（断网/超时）：本地已显示则保持；未命中则已在上面的 local 分支处理
    if (local) return;
  } catch {
    /* 网络错误：本地已显示则保持；未命中走下方空歌词 */
    if (await loadLyricFile(song)) return;
  }
  // 本地文件也没有（新歌从未同步过歌词）→ 空歌词
  state.lyric = [];
  state.lyricFormat = null;
  state.lyricSource = null;
}

// 歌词来源优先级切换：实时重载当前歌曲歌词
watch(
  () => lyricSettings.source,
  () => {
    loadLyric();
  },
);

// ============ 手动指定歌词 ============
// openLyricSpec/closeLyricSpec 已随 specLyricOpen 迁至 uiState.ts（经 usePlayer barrel 导出）

// 查询歌曲是否有手动指定歌词
export async function fetchManualLyric(path: string | null): Promise<ManualLyricState> {
  try {
    // 手动指定状态：1h 缓存（保存/清除后失效）
    const r = await apiGet("/api/lyric/manual?path=" + encodeURIComponent(path as string), {
      cache: { ttl: 3600, offline: true },
    });
    if (r.ok) return r.data;
  } catch {
    /* 网络错误 */
  }
  return { specified: false };
}

// 保存手动指定歌词（覆盖旧值）；tlyric 为可选中文翻译 LRC（JSON 歌词携带）
export async function saveManualLyric({
  path,
  format,
  text,
  source,
  tlyric,
}: {
  path: string | null;
  format?: string;
  text?: string;
  source?: string;
  tlyric?: string;
}): Promise<unknown> {
  const r = await apiPut("/api/lyric/manual", {
    path,
    format,
    text,
    source,
    tlyric: tlyric || undefined,
  });
  const data = r.data || {};
  if (!r.ok) throw new Error(data.detail || i18n.global.t("errors.saveLyric"));
  // 歌词/手动状态缓存失效：下次加载立即拿到新值
  invalidate("/api/lyric/manual?path=" + encodeURIComponent(path as string));
  invalidate(lyricUrl(path, lyricSettings.source));
  return data;
}

// 清除手动指定歌词（恢复自动获取）
export async function deleteManualLyric(path: string | null): Promise<boolean> {
  try {
    const r = await apiDelete("/api/lyric/manual?path=" + encodeURIComponent(path as string));
    if (r.ok) {
      invalidate("/api/lyric/manual?path=" + encodeURIComponent(path as string));
      invalidate(lyricUrl(path, lyricSettings.source));
    }
    return r.ok;
  } catch {
    return false;
  }
}

// 在线搜索歌词候选（网易云 + lrclib）
export async function searchLyricCandidates(
  title: string,
  artist: string,
): Promise<LyricSearchCandidate[]> {
  const q = new URLSearchParams({ title: title || "", artist: artist || "" });
  const r = await apiGet("/api/lyric/search?" + q.toString());
  if (!r.ok) throw new Error(i18n.global.t("errors.searchLyric"));
  return (r.data && r.data.results) || [];
}

// AI 歌词对齐：纯歌词文本（无时间戳）→ 后端调本地 Qwen3-ForcedAligner 生成时间戳 → LRC 字符串
// 对齐耗时较长（模型加载 + 长音频分段），调用方负责 loading 态；失败抛带 detail 的 Error
// language 第一版不传（后端自动检测）
export async function alignLyric({
  path,
  text,
}: {
  path: string | null;
  text: string;
}): Promise<AlignResult> {
  const r = await apiPost("/api/lyric/align", { path, text });
  const data = r.data || {};
  if (!r.ok) throw new Error(data.detail || i18n.global.t("spec.alignFailed"));
  return data; // { lrc, lines, duration? }
}

export function toggleZh(): void {
  state.zhVisible = !state.zhVisible;
}

// ============ 跟唱模式：点句跳转 ============

/** 时间歌词行（state.lyric 中 type==='line' 的子集；节标题行不含 s/e） */
type LyricLineEntry = Extract<LyricLine, { type: "line" }>;

export const lineItems = computed<LyricLineEntry[]>(() =>
  state.lyric.filter((x): x is LyricLineEntry => x.type === "line"),
);

// 歌词延迟校准：offset > 0 = 歌词比声音延后显示。
// 音频时间 t 在歌词时间轴上对应 t - offset；歌词时间 s 在音频轴上对应 s + offset。
// 定位/锚点比较统一用 lyricTime()，跳句 seek 统一用 audioTime()。
export const lyricTime = (t: number): number => t - lyricSettings.offset;
export const audioTime = (t: number): number => t + lyricSettings.offset;

// 跟唱模式锚点：正在唱的句子索引（-1 = 未锚定，如前奏/间隙）
// 不靠每次 timeupdate 反推当前句——句末 e 一过 currentLineIndex 就指向下一句，
// "反推"永远判断不出该停，导致一句唱完不停
// 注意：这是非响应式模块状态（computed 缓存问题特意避免 reactive），
// 用对象包一层便于跨模块（playerCore/useAbLoop）读写。
export const karaokeState: { line: number } = { line: -1 };

// 跳句静默窗口（2026-08-23 跟唱"下一句马上停"根因修复）：
// playLine/jumpToLine 跳转后，AVPlayer seek 异步 + timeupdate 250ms 回传延迟的窗口内，
// ticker 会读到旧播放时间 → 误判锚点失效重定位回旧句 → 跳转完成后被判定"旧句句末"→ 立即暂停。
// 跳转后 300ms 内 ticker 不做锚点重定位（句末判定仍生效，不受影响）。
let jumpQuietUntil = 0;

export function markKaraokeJump(): void {
  jumpQuietUntil = performance.now() + 300;
}

/** ticker 是否处于跳转静默窗口（静默期内不重定位锚点） */
export function karaokeJumpQuiet(): boolean {
  return performance.now() < jumpQuietUntil;
}

/** 仅供测试：重置跳转静默窗口（防跨测试 300ms 窗口泄漏） */
export function _resetKaraokeJump(): void {
  jumpQuietUntil = 0;
}

// 严格区间匹配：t 落在哪一句内（不含间隙/前奏/尾声）
export function locateLine(t: number): number {
  const lines = lineItems.value;
  const tt = lyricTime(t);
  for (let i = 0; i < lines.length; i++) {
    if (tt >= lines[i].s && tt < lines[i].e) return i;
  }
  return -1;
}

// 重新锚定当前时间所在句（playerCore 的 play/seek 调用；-1 = 前奏/间隙，播到下一句时自动锚定）
export function reanchorKaraoke(t: number): void {
  karaokeState.line = locateLine(t);
}

// 仅供测试：重置跟唱锚点
export function _resetKaraokeAnchor(): void {
  karaokeState.line = -1;
}

// 跳到某句句首；keepPlaying=true 时若暂停中则继续播
export function jumpToLine(lineIndex: number, keepPlaying: boolean): void {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  karaokeState.line = lineIndex;
  markKaraokeJump(); // 跳转静默窗口：防 ticker 用旧时间重定位锚点
  audio.currentTime = Math.max(0, audioTime(lines[lineIndex].s));
  state.currentTime = audio.currentTime;
  if (keepPlaying && audio.paused) audio.play().catch(() => {});
}

export function playLine(lineIndex: number): void {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const ln = lines[lineIndex];
  karaokeState.line = lineIndex;
  markKaraokeJump(); // 跳转静默窗口：防 ticker 用旧时间重定位锚点
  audio.currentTime = Math.max(0, audioTime(ln.s));
  state.currentTime = audio.currentTime; // 同步本地视图时间（jumpToLine 同款；iOS 无 timeupdate 回传前定位依赖它）
  audio.play().catch(() => {});
}

// 当前跟唱句索引（快捷键跳句用，不经 computed 缓存）
// currentLineIndex 是 computed，而 karaokeState.line 是非响应式模块变量：
// 连续按键（n 后立即 p）时 computed 可能返回缓存旧值，导致上一句/下一句跳错。
// 这里直接读最新值：暂停时用锚点句，播放中用时间反推。
function currentKaraokeIndex(): number {
  // 暂停判断用 audio.paused（本地同步）：iOS 上 state.isPlaying 靠原生事件回传有桥往返延迟，
  // 句末暂停瞬间按上一句/下一句会误走"播放中"分支（locateLine 在句末边界返回下一句 → +1 跳两句）
  if (state.mode === "karaoke" && karaokeState.line >= 0 && audio.paused) {
    // 锚点过期校验（同 currentLineIndex）：时间已越过锚点句句末 → 按时间反推
    const lines = lineItems.value;
    if (lyricTime(state.currentTime) >= lines[karaokeState.line].e) {
      return locateLine(state.currentTime);
    }
    return karaokeState.line;
  }
  return locateLine(state.currentTime);
}

export function prevLine(): void {
  const cur = currentKaraokeIndex();
  if (cur > 0) playLine(cur - 1);
}

export function nextLine(): void {
  const lines = lineItems.value;
  const cur = currentKaraokeIndex();
  if (cur >= 0 && cur < lines.length - 1) playLine(cur + 1);
}

// 当前高亮句（按时间戳定位）
// 取「最后一条已开始的句子」：句间间隙（上一句 e ~ 下一句 s）中保持上一句，
// 播放结束后保持最后一句；这样跟唱模式 timeupdate 才能识别「该停了」
export const currentLineIndex = computed<number>(() => {
  const lines = lineItems.value;
  if (!lines.length) return -1;
  // 跟唱模式暂停（含句末自动停）时保持锚点句：句尾边界 e == 下一句 s 时，
  // 时间反推（t >= s）会把停在句尾的音频判进下一句 → 视觉上"播完自动跳下一句"；
  // 跟唱要反复练同一句，暂停时应该始终停留在刚唱完的那句
  // （暂停判断用 audio.paused 同步值，见 currentKaraokeIndex 注释）
  if (state.mode === "karaoke" && karaokeState.line >= 0 && audio.paused) {
    // 锚点过期校验（2026-08-23 高亮卡死兜底）：iOS 播放状态靠原生事件回传，
    // seek 抖动/事件乱序可能让 audio.paused 在播放中误报 true → 走暂停分支返回旧锚点。
    // 若当前时间已越过锚点句句末（不可能"暂停在句内但时间过了"），按时间反推。
    const lt = lyricTime(state.currentTime);
    if (lt >= lines[karaokeState.line].e) {
      return locateLine(state.currentTime);
    }
    return karaokeState.line;
  }
  const t = lyricTime(state.currentTime);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].s) idx = i;
    else break;
  }
  return idx;
});
