import { computed, watch } from "vue";
import { audio, state } from "./playerCore.js";
import { lyricSettings } from "./useSettings.js";
import { parseLrcText, mergeTranslationLines } from "../utils/parseLrc.js";
import i18n from "../locales/i18n.js";

// 非本地歌（stream 曲库网络条目 / 试听 / URL 播放）：没有可解析的本地歌词文件，
// 按歌名/歌手走在线候选链路（/api/lyric/search 返回候选 LRC 全文 + 翻译），
// 前端解析成与后端 /api/lyric 一致的 lines 结构。失败/无结果返回空歌词（不抛错）。
export async function loadOnlineLyricForSong(song) {
  try {
    const q = new URLSearchParams({ title: song.name || "", artist: song.artist || "" });
    const res = await fetch("/api/lyric/search?" + q.toString(), { cache: "no-store" });
    if (!res.ok) return { lines: [], format: null, source: null };
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) return { lines: [], format: null, source: null };
    // 首选歌名精确匹配且有歌词的候选；否则第一个带歌词的
    const exact = results.find((r) => r.text && r.title === song.name);
    const hit = exact || results.find((r) => r.text);
    if (!hit) return { lines: [], format: null, source: null };
    let lines = parseLrcText(hit.text || "");
    if (hit.tlyric) lines = mergeTranslationLines(lines, parseLrcText(hit.tlyric));
    return { lines, format: lines.length ? "lrc" : null, source: hit.source || "online" };
  } catch {
    return { lines: [], format: null, source: null };
  }
}

// ============ 歌词加载（默认当前歌）；来源优先级按 lyricSettings.source：============
// 'local' 本地优先 | 'online' 在线优先（在线失败后端自动回退本地）
export async function loadLyric(index = state.currentIndex) {
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
    const res = await fetch(
      "/api/lyric?path=" +
        encodeURIComponent(state.songs[index].path) +
        "&prefer=" +
        lyricSettings.source,
      { cache: "no-store" },
    );
    if (res.ok) {
      const data = await res.json();
      state.lyric = data.lines || [];
      state.lyricFormat = data.format || null;
      state.lyricSource = data.source || null;
      return;
    }
  } catch {
    /* 网络错误走空歌词 */
  }
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
export function openLyricSpec() {
  state.specLyricOpen = true;
}

export function closeLyricSpec() {
  state.specLyricOpen = false;
}

// 查询歌曲是否有手动指定歌词
export async function fetchManualLyric(path) {
  try {
    const res = await fetch("/api/lyric/manual?path=" + encodeURIComponent(path), {
      cache: "no-store",
    });
    if (res.ok) return await res.json();
  } catch {
    /* 网络错误 */
  }
  return { specified: false };
}

// 保存手动指定歌词（覆盖旧值）；tlyric 为可选中文翻译 LRC（JSON 歌词携带）
export async function saveManualLyric({ path, format, text, source, tlyric }) {
  const res = await fetch("/api/lyric/manual", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, format, text, source, tlyric: tlyric || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || i18n.global.t("errors.saveLyric"));
  return data;
}

// 清除手动指定歌词（恢复自动获取）
export async function deleteManualLyric(path) {
  try {
    const res = await fetch("/api/lyric/manual?path=" + encodeURIComponent(path), {
      method: "DELETE",
    });
    return res.ok;
  } catch {
    return false;
  }
}

// 在线搜索歌词候选（网易云 + lrclib）
export async function searchLyricCandidates(title, artist) {
  const q = new URLSearchParams({ title: title || "", artist: artist || "" });
  const res = await fetch("/api/lyric/search?" + q.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(i18n.global.t("errors.searchLyric"));
  return (await res.json()).results || [];
}

export function toggleZh() {
  state.zhVisible = !state.zhVisible;
}

// ============ 跟唱模式：点句跳转 ============
export const lineItems = computed(() => state.lyric.filter((x) => x.type === "line"));

// 歌词延迟校准：offset > 0 = 歌词比声音延后显示。
// 音频时间 t 在歌词时间轴上对应 t - offset；歌词时间 s 在音频轴上对应 s + offset。
// 定位/锚点比较统一用 lyricTime()，跳句 seek 统一用 audioTime()。
export const lyricTime = (t) => t - lyricSettings.offset;
export const audioTime = (t) => t + lyricSettings.offset;

// 跟唱模式锚点：正在唱的句子索引（-1 = 未锚定，如前奏/间隙）
// 不靠每次 timeupdate 反推当前句——句末 e 一过 currentLineIndex 就指向下一句，
// "反推"永远判断不出该停，导致一句唱完不停
// 注意：这是非响应式模块状态（computed 缓存问题特意避免 reactive），
// 用对象包一层便于跨模块（playerCore/useAbLoop）读写。
export const karaokeState = { line: -1 };

// 严格区间匹配：t 落在哪一句内（不含间隙/前奏/尾声）
export function locateLine(t) {
  const lines = lineItems.value;
  const tt = lyricTime(t);
  for (let i = 0; i < lines.length; i++) {
    if (tt >= lines[i].s && tt < lines[i].e) return i;
  }
  return -1;
}

// 重新锚定当前时间所在句（playerCore 的 play/seek 调用；-1 = 前奏/间隙，播到下一句时自动锚定）
export function reanchorKaraoke(t) {
  karaokeState.line = locateLine(t);
}

// 仅供测试：重置跟唱锚点
export function _resetKaraokeAnchor() {
  karaokeState.line = -1;
}

// 跳到某句句首；keepPlaying=true 时若暂停中则继续播
export function jumpToLine(lineIndex, keepPlaying) {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  karaokeState.line = lineIndex;
  audio.currentTime = Math.max(0, audioTime(lines[lineIndex].s));
  state.currentTime = audio.currentTime;
  if (keepPlaying && audio.paused) audio.play().catch(() => {});
}

export function playLine(lineIndex) {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const ln = lines[lineIndex];
  karaokeState.line = lineIndex;
  audio.currentTime = Math.max(0, audioTime(ln.s));
  audio.play().catch(() => {});
}

// 当前跟唱句索引（快捷键跳句用，不经 computed 缓存）
// currentLineIndex 是 computed，而 karaokeState.line 是非响应式模块变量：
// 连续按键（n 后立即 p）时 computed 可能返回缓存旧值，导致上一句/下一句跳错。
// 这里直接读最新值：暂停时用锚点句，播放中用时间反推。
function currentKaraokeIndex() {
  if (state.mode === "karaoke" && karaokeState.line >= 0 && !state.isPlaying) {
    return karaokeState.line;
  }
  return locateLine(state.currentTime);
}

export function prevLine() {
  const cur = currentKaraokeIndex();
  if (cur > 0) playLine(cur - 1);
}

export function nextLine() {
  const lines = lineItems.value;
  const cur = currentKaraokeIndex();
  if (cur >= 0 && cur < lines.length - 1) playLine(cur + 1);
}

// 当前高亮句（按时间戳定位）
// 取「最后一条已开始的句子」：句间间隙（上一句 e ~ 下一句 s）中保持上一句，
// 播放结束后保持最后一句；这样跟唱模式 timeupdate 才能识别「该停了」
export const currentLineIndex = computed(() => {
  const lines = lineItems.value;
  if (!lines.length) return -1;
  // 跟唱模式暂停（含句末自动停）时保持锚点句：句尾边界 e == 下一句 s 时，
  // 时间反推（t >= s）会把停在句尾的音频判进下一句 → 视觉上"播完自动跳下一句"；
  // 跟唱要反复练同一句，暂停时应该始终停留在刚唱完的那句
  if (state.mode === "karaoke" && karaokeState.line >= 0 && !state.isPlaying) {
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
