// 队列域（P1-2 批次2：从 playerCore.js 拆出）
//
// 队列操作 / 连播模式 / 歌曲列表 / 队列顺序 / 自动刷新 / 流媒体 / 选歌 / iOS 本地优先。
// 依赖方向：playerState、audioEngine、useLyric、useAbLoop、nativeAudioBridge（单向，无循环）。
//
// 循环依赖处理（与原始 playerCore.js 的行为零变化）：
//   - 播放会话（playbackSession/flushPlaybackSession）与 showPlayerToast 属 playbackEngine，
//     但 selectSong/playPreview 在函数体内要用 → 经 registerPlaybackHooks 由 playbackEngine
//     在模块求值期注入（避免 queueEngine ↔ playbackEngine 成环）。
//   - playbackSettings 在 playerState（低层共享），本模块直接 import（无环）。
//   - shuffleQueue/shufflePos/playHistory/dbgLog/SPEEDS/ensureShuffleQueue 导出供
//     playbackEngine（播放控制）与 mediaSession（原生切歌跟随）跨域使用。
import {
  state,
  playbackSettings,
  type Song,
  type LyricLine,
  type PlaybackSession,
} from "./playerState.ts";
import {
  audio,
  applySpeed,
  applyVolume,
  fadeOut,
  fadeIn,
  beginFadeSequence,
  type AudioEventListener,
} from "./audioEngine.ts";
import { loadLyric, loadOnlineLyricForSong } from "./useLyric.js";
import { resetAbLoopCount } from "./useAbLoop.js";
import { isNativePlayback, resolveNativeUrl, nativePost } from "./nativeAudioBridge.js";
import { showToast } from "./useToast.js";
import { apiGet, apiPut, apiPost, invalidate } from "../utils/apiClient.js";
import { ensureAsset, assetForSong, nativeMetaSave } from "../utils/sync.js";
import i18n from "../locales/i18n.js";

// ============ 播放会话/toast 回调注入（playbackEngine 注册） ============
export interface PlaybackHooks {
  getSession: () => PlaybackSession | null;
  flushSession: () => void;
  showToast: (msg: string, isErr?: boolean) => void;
}

let playbackHooks: PlaybackHooks = {
  getSession: () => null,
  flushSession: () => {},
  showToast: () => {},
};

export function registerPlaybackHooks(hooks: PlaybackHooks) {
  playbackHooks = hooks;
}

// ============ 选歌参数 ============
export interface SelectSongOpts {
  autoPlay?: boolean;
  source?: string;
  resumeAt?: number;
  fade?: boolean;
  record?: boolean;
  level?: string;
  title?: string; // playUrl 透传给试听歌标题
}

// ============ 队列操作 ============
// 移除 + 撤销：缓存 {index, song} → toast「已移除 [撤销]」→ 插回原位（越界 clamp 到末尾，不丢歌）
// 多首依次移除各自独立撤销（各自 toast、各自原位）；撤销后若处于过滤/分组浏览可能不可见，但数据不丢
const UNDO_DURATION = 5000;

export function removeFromQueue(index: number) {
  if (index < 0 || index >= state.songs.length) return;
  const [song] = state.songs.splice(index, 1);
  if (index < state.currentIndex) {
    state.currentIndex -= 1;
  } else if (index === state.currentIndex) {
    if (state.songs.length) {
      // 移除当前歌：切到原位置的新歌（索引已自然顺延）
      const next = Math.min(index, state.songs.length - 1);
      selectSong(next);
    } else {
      state.currentIndex = -1;
      state.currentSong = null;
      state.isPlaying = false;
      state.lyric = [];
      state.lyricFormat = null;
      audio.pause();
      audio.removeAttribute("src");
    }
  }
  // 歌曲列表变了：洗牌队列失效，下次自动重建
  _resetPlayMode();

  const name = song?.name || i18n.global.t("errors.unknownSong");
  showToast(i18n.global.t("queue.removed", { name }), {
    duration: UNDO_DURATION,
    action: {
      label: i18n.global.t("queue.undo"),
      onClick: () => {
        // 插回原位；原 index 越界（期间又移除了前面的歌）→ clamp 到末尾
        state.songs.splice(Math.min(index, state.songs.length), 0, song);
        // 镜像移除时的索引前移：插回位置在当前歌之前 → 当前索引顺延（越界时当前索引为 -1，不动）
        if (state.currentIndex >= 0 && index <= state.currentIndex) state.currentIndex += 1;
        _resetPlayMode();
        showToast(i18n.global.t("queue.restored", { name }));
      },
    },
  });
}

// ============ 连播播放模式（列表循环/随机/单曲循环）============
// 变速档位（playbackEngine.cycleSpeed/stepSpeed 共用；原 playerCore 中位于本段之前）
export const SPEEDS = [0.75, 1.0, 1.25];

// 洗牌队列：歌曲索引排列（随机模式用；只读导出——mediaSession 原生切歌跟随 /
// songChangedTargetIndex 传参；写入仅限本模块，跨域写经 setShufflePos）
export let shuffleQueue: number[] = [];
let shufflePos = -1; // 当前歌曲在队列中的位置
// 播放历史栈（歌曲索引），随机模式"上一首"回退用（只读导出——playbackEngine prevSong 读/弹）
export let playHistory: number[] = [];

// 生成洗牌队列：leader（通常为当前歌）固定队首，其余 Fisher-Yates 随机
function buildShuffleQueue(leader: number) {
  const n = state.songs.length;
  if (!n) {
    shuffleQueue = [];
    shufflePos = -1;
    return;
  }
  const rest = [];
  for (let i = 0; i < n; i++) if (i !== leader) rest.push(i);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  shuffleQueue = leader >= 0 ? [leader, ...rest] : rest;
  shufflePos = leader >= 0 ? 0 : -1;
}

// 队列失效（歌曲列表变化 / 当前歌不在队列）时重建
// 导出供 playbackEngine 的 playMode 变化 watch 使用
export function ensureShuffleQueue() {
  if (
    shuffleQueue.length !== state.songs.length ||
    (state.currentIndex >= 0 && !shuffleQueue.includes(state.currentIndex))
  ) {
    buildShuffleQueue(state.currentIndex);
  }
}

// 随机模式下一首：队列顺序推进，一轮播完以当前歌为队首重新洗牌
// opts.autoPlay=true 时（播完自动切歌）切到新歌后继续播放
// 导出供 playbackEngine 的播完自动切歌（ended 事件）调用
export function nextShuffle(opts: SelectSongOpts = {}) {
  ensureShuffleQueue();
  if (shufflePos >= shuffleQueue.length - 1) {
    buildShuffleQueue(state.currentIndex);
    if (shuffleQueue.length > 1) {
      selectSong(shuffleQueue[1], opts);
      return;
    }
    // 只有一首歌：无法推进 → 重播本首
    if (state.currentIndex >= 0 && audio.src) {
      audio.currentTime = 0;
      state.currentTime = 0;
      if (opts.autoPlay) audio.play().catch(() => {});
    }
    return;
  }
  selectSong(shuffleQueue[shufflePos + 1], opts);
}

// 三态循环：列表循环 → 随机 → 单曲循环 → 列表循环
// 注意与跟唱模式的"单句循环/AB 循环"（歌词行级）区分：这是歌曲级播放模式
export function cyclePlayMode() {
  const order = ["order", "shuffle", "repeatOne"];
  state.playMode = order[(order.indexOf(state.playMode) + 1) % order.length];
  playbackSettings.playMode = state.playMode; // 同步持久化（启动时恢复）
  if (state.playMode === "shuffle") ensureShuffleQueue();
}

// 仅供测试：重置播放模式内部状态（洗牌队列/播放历史）
export function _resetPlayMode() {
  shuffleQueue = [];
  shufflePos = -1;
  playHistory = [];
}

// 原生切歌跟随（mediaSession 用）：同步洗牌队列位置（原直接写 shufflePos；
// 跨域只读 import 不能赋值，收敛为 setter）
export function setShufflePos(pos: number) {
  shufflePos = pos;
}

// ============ 歌曲列表 ============
export async function loadLibrary() {
  try {
    // 曲库路径元数据：60s + 离线兜底；setLibrary 后失效
    const r = await apiGet("/api/library", { cache: { ttl: 60, offline: true } });
    if (r.network) return;
    const data = r.data || {};
    state.libraryPath = data.path;
  } catch {
    /* 忽略 */
  }
}

// 音乐库设置：文件类型多选 / 忽略隐藏 / 自动刷新 / 启动自动扫描（后端持久化）
export async function loadLibrarySettings() {
  try {
    // 设置类元数据：60s + 离线兜底；保存后失效
    const r = await apiGet("/api/library/settings", { cache: { ttl: 60, offline: true } });
    if (r.network) return;
    const data = r.data || {};
    state.librarySettings = data.settings;
  } catch {
    /* 忽略 */
  }
}

export async function saveLibrarySettings(patch: Record<string, unknown>) {
  const r = await apiPut("/api/library/settings", patch);
  if (!r.ok) {
    const data = r.data || {};
    throw new Error(data.detail || i18n.global.t("errors.saveLibrarySettings"));
  }
  const data = r.data || {};
  state.librarySettings = data.settings;
  invalidate("/api/library/settings");
  return data;
}

export async function setLibrary(path: string) {
  const r = await apiPost("/api/library", { path });
  if (!r.ok) {
    const data = r.data || {};
    throw new Error(data.detail || i18n.global.t("errors.setLibrary"));
  }
  invalidate("/api/library");
  await loadSongs({ force: true });
}

export async function loadSongs(opts: { force?: boolean } = {}) {
  state.loading = true;
  state.error = "";
  try {
    // 曲库元数据：60s + 离线兜底（离线启动也能看到上次曲库）；force 跳过缓存读（刷新场景）
    const r = await apiGet("/api/songs", {
      cache: { ttl: 60, offline: true },
      force: !!opts.force,
    });
    if (r.network) throw new Error(r.message); // 网络失败走 catch（state.error 提示）
    const songs = r.data;
    state.songs = songs;
    // iOS 壳元数据文件兜底：IndexedDB 重启不可靠（免费签名覆盖安装被清），
    // 成功拿到的曲库落 Documents/meta/songs.json（fire-and-forget；非壳/失败静默）
    if (isNativePlayback()) {
      try {
        nativeMetaSave("songs", JSON.stringify(songs));
      } catch {
        /* 写文件失败静默：不影响加载 */
      }
    }
    // 拖拽排序持久化的队列顺序：刷新/启动时恢复（loadQueueOrder 需先于首次 loadSongs 完成，见 App.vue）
    applyQueueOrder();
    if (songs.length && state.currentIndex < 0) {
      state.currentIndex = 0;
      await selectSong(0);
    } else if (songs.length && state.currentSong) {
      // 刷新后保持当前选中：本地歌按 path；网络歌（path=null）按 streamId
      const cur = state.currentSong;
      const idx = cur.path
        ? state.songs.findIndex((s) => s.path === cur.path)
        : cur.streamId
          ? state.songs.findIndex((s) => s.type === "stream" && s.streamId === cur.streamId)
          : -1;
      if (idx >= 0) {
        state.currentIndex = idx;
        // 同步 currentSong 引用到新数组：刮削保存/曲库刷新后播放界面立即显示新信息
        // （不改 audio/不重播；mediaSession 元数据 watch 自动跟随更新）
        state.currentSong = state.songs[idx];
      }
    }
  } catch (e) {
    state.error = i18n.global.t("errors.loadSongs", { msg: (e as Error).message });
  } finally {
    state.loading = false;
  }
}

// ============ 播放队列顺序（后端持久化 /api/queue/order）============
// 队列 = state.songs 顺序（点击播放/切歌/列表渲染都按它走）。
// 拖拽排序后 PUT 到后端（不放 localStorage），启动/刷新时恢复；
// 只影响顺序——「最近添加」等智能视图是 computed 按 mtime/plays 字段排序，不受数组顺序影响。
// 顺序键：本地歌 = 文件路径；网络歌 path 为 null，用 'stream:<streamId>'。
let queueOrder: string[] | null = null; // 后端持久化的顺序键数组；null = 未加载

export function _resetQueueOrder() {
  queueOrder = null;
}

function queueKey(song: Song | null | undefined): string | null {
  return song?.type === "stream" && song.streamId
    ? "stream:" + song.streamId
    : (song?.path ?? null);
}

// 拉取持久化队列顺序（App 启动时先于 loadSongs 调用一次，之后走本地缓存）
export async function loadQueueOrder() {
  try {
    // 队列顺序元数据：60s + 离线兜底；persistQueueOrder 后失效
    const r = await apiGet("/api/queue/order", { cache: { ttl: 60, offline: true } });
    if (r.ok) {
      const data = r.data || {};
      if (Array.isArray(data.paths)) queueOrder = data.paths;
    }
  } catch {
    /* 后端暂不可用：保持默认顺序，下次重启再试 */
  }
}

// 保存当前队列顺序到后端（乐观更新本地缓存；失败抛错由调用方 toast）
export async function persistQueueOrder() {
  const paths = state.songs.map(queueKey).filter((k) => typeof k === "string");
  queueOrder = paths; // 本地缓存先行：刷新时立即恢复，不依赖后端往返
  const r = await apiPut("/api/queue/order", { paths });
  if (!r.ok) throw new Error(i18n.global.t("errors.reorderQueue"));
  invalidate("/api/queue/order");
}

// 按持久化顺序重排 state.songs：匹配到的按保存顺序前置，其余（新歌/试听残留等）保持相对顺序补在末尾。
// 保存的顺序与当前曲库无交集（换库/清库）→ 不重排，保持曲库默认顺序。
function applyQueueOrder() {
  if (!Array.isArray(queueOrder) || !queueOrder.length) return;
  // 键可能为 null（无 path/streamId 的临时歌）；宽松键值语义与原 JS 一致
  const byKey = new Map<string | null, Song>();
  for (const s of state.songs) {
    const k = queueKey(s);
    if (!byKey.has(k)) byKey.set(k, s);
  }
  const ordered: Song[] = [];
  const seen = new Set<string | null>();
  for (const key of queueOrder) {
    if (seen.has(key) || !byKey.has(key)) continue;
    ordered.push(byKey.get(key) as Song);
    seen.add(key);
  }
  if (!ordered.length) return; // 与当前曲库无交集 → 不动
  for (const s of state.songs) {
    const k = queueKey(s);
    if (seen.has(k)) continue;
    ordered.push(s);
    seen.add(k);
  }
  if (ordered.length !== state.songs.length) return; // 防御：长度不一致不重排
  state.songs = ordered;
}

// 队列拖拽排序：把 from 位置的歌挪到 to（全部歌曲视图 onEnd 调用）。
// 队列顺序变了 → 洗牌队列/播放历史失效（_resetPlayMode），下次自动重建。
export function reorderQueue(from: number, to: number) {
  if (from < 0 || to < 0 || from >= state.songs.length || to >= state.songs.length) return;
  if (from === to) return;
  const [song] = state.songs.splice(from, 1);
  state.songs.splice(to, 0, song);
  // 当前播放索引跟随：被移走的歌在原当前歌之前/之后决定偏移；移的就是当前歌 → 直接换到新位置
  if (from === state.currentIndex) {
    state.currentIndex = to;
  } else if (from < state.currentIndex && to >= state.currentIndex) {
    state.currentIndex -= 1;
  } else if (from > state.currentIndex && to <= state.currentIndex) {
    state.currentIndex += 1;
  }
  _resetPlayMode();
}

// 定位歌曲在队列（state.songs）中的索引：本地歌按 path；网络歌（type=stream, path=null）
// 按 streamId——旧写法 findIndex(s => s.path === song.path) 对网络歌会匹配到第一个
// stream 条目（path 全为 null）→ 播错歌/不播放（2026-08-16 用户反馈"最近添加有时点击不播放"）
export function findSongIndex(song: Song | null | undefined): number {
  if (!song) return -1;
  if (song.type === "stream" && song.streamId) {
    return state.songs.findIndex((s) => s.type === "stream" && s.streamId === song.streamId);
  }
  if (song.path) {
    return state.songs.findIndex((s) => s.path === song.path);
  }
  return -1;
}

// ============ 歌曲库自动刷新（iCloud 文件夹变动） ============
let refreshTimer: number | null = null;

export function setupAutoRefresh(intervalMs = 3000) {
  // 幂等：重复调用不叠加 timer
  if (refreshTimer) return;
  refreshTimer = setInterval(async () => {
    try {
      // 版本号是实时探活，不走缓存
      const r = await apiGet("/api/library/version");
      if (!r.ok) return; // 接口异常：静默，状态保持，下轮重试
      const { version } = r.data || {};
      if (state.libraryVersion == null) {
        state.libraryVersion = version;
      } else if (version !== state.libraryVersion) {
        state.libraryVersion = version;
        await loadSongs({ force: true }); // 刷新后保持当前选中/播放（loadSongs 已处理）
      }
    } catch {
      // 后端暂不可用：静默，下轮重试
    }
  }, intervalMs);
}

export function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ============ 流媒体歌（曲库网络条目 / 试听 / URL 播放）============
// 曲库网络条目：{type:'stream', streamId, provider, path:null, name, artist, album, duration, coverUrl}
// 试听歌：{type:'preview', ...}；URL 播放：{type:'url', url, ...}——两者都是「临时播放列表」语义
// （不改 state.songs / 不改 currentIndex，播完自然停，任何切歌操作回到主队列）

export function isStreamSong(song: Song | null | undefined): boolean {
  return !!song && (song.type === "stream" || (song.path === null && !!song.streamId));
}

export function isPreviewSong(song: Song | null | undefined): boolean {
  return !!song && (song.type === "preview" || song.type === "url");
}

// 实时获取流媒体直链（每次播放前请求，不缓存）。失败自动重试一次；仍失败返回 null（调用方 toast）
export async function fetchStreamUrl(
  provider: string | undefined,
  id: string | number | undefined,
  level = "exhigh",
): Promise<string | null> {
  if (!id && id !== 0) return null;
  const url =
    "/api/stream/url?provider=" +
    encodeURIComponent(provider || "netease") +
    "&id=" +
    encodeURIComponent(id) +
    "&level=" +
    encodeURIComponent(level);
  for (let attempt = 0; attempt < 2; attempt++) {
    // 流媒体直链有时效，每次播放前实时取（不缓存）
    const r = await apiGet(url);
    if (r.ok && r.data && r.data.url) return r.data.url;
  }
  return null;
}

// 试听歌描述（playPreview/playUrl 入参）
export interface PreviewDesc {
  url?: string;
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
  id?: string | number;
  provider?: string;
  duration?: number;
}

// URL 播放 / 试听歌 → 内部歌对象（path: null，标记临时播放语义）
function toPreviewSong(desc: PreviewDesc): Song {
  if (desc.url) {
    return {
      type: "url",
      path: null,
      streamId: desc.url,
      provider: "http",
      name: desc.title || urlTitle(desc.url),
      artist: desc.artist || "",
      album: desc.album || "",
      coverUrl: desc.cover || "",
      duration: 0,
      url: desc.url,
    };
  }
  return {
    type: "preview",
    path: null,
    streamId: String(desc.id),
    provider: desc.provider || "netease",
    name: desc.title || "",
    artist: desc.artist || "",
    album: desc.album || "",
    coverUrl: desc.cover || "",
    duration: desc.duration || 0,
  };
}

// URL 默认标题：取文件名（pathname 最后一段）或域名
function urlTitle(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    return last || u.hostname;
  } catch {
    return url;
  }
}

// 网络直链 → 同源代理 URL：EQ/频谱音频图常驻接管 audio 后，跨域媒体必须带 CORS 头
// （网易云等直链不带 → 浏览器静音输出）。走 /api/stream/proxy 同源转发（支持 Range 拖动）。
// 非 http(s)（本地 /api/audio 等）原样返回（防御性）。
function streamProxyUrl(url: string): string {
  return typeof url === "string" && /^https?:\/\//i.test(url)
    ? "/api/stream/proxy?url=" + encodeURIComponent(url)
    : url;
}

// 试听 = 临时播放列表（核心语义，用户 2026-08-16 拍板）：
// - 保存当前播放上下文（currentIndex / currentSong 不动；isPlaying 由 play 事件接管）
// - 不改 state.songs、不改 currentIndex
// - 播完（ended）自然停止，不自动 nextSong
// - nextSong / prevSong / selectSong → 走主队列正常逻辑（基于未动的 currentIndex，试听自然丢弃）
// - 试听中歌词 / 封面照常显示（在线匹配）；不上报播放统计（streamStats 关时）
// 返回 true = 已开始试听；false = 直链获取失败（已 toast）
export async function playPreview(desc: PreviewDesc, opts: SelectSongOpts = {}): Promise<boolean> {
  const song = toPreviewSong(desc);
  // 取直链：URL 播放直接用 url；网络试听实时请求（失败重试一次，仍失败 toast）
  let src = song.url || null;
  if (!src) {
    src = await fetchStreamUrl(song.provider, song.streamId, opts.level);
    if (!src) {
      playbackHooks.showToast(
        i18n.global.t("errors.streamUrlFailed", { name: song.name || "" }),
        true,
      );
      return false;
    }
  }
  // 停止旧歌并上报旧会话（主队列正在播的歌是真实播放，照常上报）
  audio.pause();
  const sess = playbackHooks.getSession();
  if (sess) sess.completed = audio.ended;
  playbackHooks.flushSession();
  // 挂载试听源：不改 state.songs / currentIndex（http(s) 直链走同源代理防跨域无声）
  state.currentSong = song;
  state.isPlaying = false;
  audio.src = streamProxyUrl(src);
  applySpeed(); // 换源后恢复变速 + 音频图路由（浏览器换 src 可能重置 playbackRate）
  applyVolume();
  state.currentTime = 0;
  state.duration = 0;
  state.lyric = [];
  state.lyricFormat = null;
  state.lyricSource = null;
  state.abLoop = null;
  resetAbLoopCount();
  if (opts.autoPlay !== false) {
    audio.play().catch(() => {});
  }
  // 预取时长（电台流 duration=Infinity → 保持 0，进度条走空态不崩）
  audio.addEventListener(
    "loadedmetadata",
    () => {
      state.duration = isFiniteNumber(audio.duration) ? audio.duration : 0;
    },
    { once: true },
  );
  // 试听歌词：在线匹配（歌名/歌手）
  const lr = await loadOnlineLyricForSong(song);
  state.lyric = lr.lines as LyricLine[];
  state.lyricFormat = lr.format;
  state.lyricSource = lr.source;
  return true;
}

// 播放 URL（电台流 / 直链）：playPreview 语义（临时播放，不落库、默认不计统计）
export async function playUrl(url: string, opts: SelectSongOpts = {}) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
    playbackHooks.showToast(i18n.global.t("errors.urlInvalid"), true);
    return;
  }
  await playPreview({ url: url.trim(), title: opts.title || "" }, opts);
}

function isFiniteNumber(v: number): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

// ============ 选歌 ============
// 调试记录：播放决策链路（2026-08-25 定位"从固定秒数开始播"问题用；
// 写 Documents/meta/debuglog.json，模拟器沙盒可直接读）
// 导出供 playbackEngine（seek）与 mediaSession（远端命令/原生切歌）打点
const dbgBuf: Array<Record<string, unknown>> = [];
export function dbgLog(ev: string, data?: Record<string, unknown> | null) {
  try {
    dbgBuf.push({ ts: Date.now(), ev, ...(data || {}) });
    if (dbgBuf.length > 300) dbgBuf.splice(0, dbgBuf.length - 300);
    if (isNativePlayback()) {
      try {
        nativeMetaSave("debuglog", JSON.stringify(dbgBuf.slice(-80)));
      } catch {
        /* 写日志失败静默 */
      }
    }
  } catch {
    /* 日志不影响播放 */
  }
}

// songChanged 对齐索引（纯逻辑，vitest 可测）：普通模式 index 直接映射；
// shuffle 模式经 shuffleQueue 映射（index 是播放顺序中的位置）；越界/空队列返回 -1
// （songChanged 的 index 是原生 queue 快照位置，快照由 nativeSyncQueue 按同一顺序同步）
export function songChangedTargetIndex(
  playMode: string,
  index: number,
  shuffleQueueArg: number[],
  songsLen: number,
): number {
  if (!(index >= 0) || !(songsLen > 0)) return -1;
  if (playMode === "shuffle") {
    if (!(index >= 0 && index < shuffleQueueArg.length)) return -1;
    const t = shuffleQueueArg[index];
    return t >= 0 && t < songsLen ? t : -1;
  }
  return index < songsLen ? index : -1;
}

// 播放顺序快照 → 原生（setQueue）：锁屏/线控后台切歌用（Web 挂起时原生独立执行）。
// 本地歌绝对 URL（resolveNativeUrl，AVPlayer 直接拉）；stream 歌 url 空（原生跳过，
// MVP 限制：流媒体直链有时效，后台无法离线取）。顺序与前端一致：shuffle 用洗牌队列，
// 普通模式用歌曲列表顺序。
function nativeSyncQueue() {
  const order = state.playMode === "shuffle" ? shuffleQueue : state.songs.map((_, i) => i);
  const idx = state.playMode === "shuffle" ? shufflePos : state.currentIndex;
  const songs = order.map((songIdx) => {
    const s = state.songs[songIdx];
    return {
      // 非 stream 歌 path 必然存在；最小化 as 保持原 JS 语义
      url: isStreamSong(s)
        ? ""
        : resolveNativeUrl("/api/audio?path=" + encodeURIComponent(s.path as string)),
      title: s.name || "",
      artist: s.artist || "",
      album: s.album || "",
    };
  });
  nativePost({ cmd: "setQueue", songs, index: idx < 0 ? 0 : idx });
}

// 当前 selectSong / maybePrefetchAsset 挂的 loadedmetadata 监听器引用
// （切歌时清理，防旧歌的 resumeAt 劫持新歌——2026-08-25 固定秒数开始播放根因）
let loadedMetaHandler: AudioEventListener | null = null;
let prefetchMetaHandler: AudioEventListener | null = null;

export async function selectSong(index: number, opts: SelectSongOpts = {}): Promise<void> {
  if (index < 0 || index >= state.songs.length) return;
  dbgLog("selectSong", { idx: index, resumeAt: opts.resumeAt ?? null, autoPlay: !!opts.autoPlay });
  const seq = beginFadeSequence();
  // 切歌淡入淡出：正在播放且开启淡出 → 先淡出旧歌再换源
  const fade = opts.fade === false ? 0 : playbackSettings.fadeSec;
  const wasPlaying = !audio.paused && !!audio.src;
  if (fade > 0 && wasPlaying) {
    const ok = await fadeOut(fade, seq);
    if (!ok) return; // 淡出期间又被切歌：放弃本次（新切歌接管）
  }
  // 切歌：先上报旧歌的播放会话（若正在播放）
  // 自然播完（ended 触发自动切歌）时 audio.ended=true → 标记 completed
  const sess = playbackHooks.getSession();
  if (sess) sess.completed = audio.ended;
  playbackHooks.flushSession();
  // 记录本次选歌来源（播放事件建会话时使用）
  state.lastSource = opts.source || "manual";
  // 播放历史：记录旧歌（随机模式"上一首"回退）；回退本身不记录
  if (opts.record !== false && state.currentIndex >= 0 && state.currentIndex !== index) {
    playHistory.push(state.currentIndex);
    if (playHistory.length > 100) playHistory.shift();
  }
  // 洗牌队列定位：手动选了队列外的歌 → 以它为队首重建队列
  const qIdx = shuffleQueue.indexOf(index);
  if (qIdx >= 0) {
    shufflePos = qIdx;
  } else {
    buildShuffleQueue(index);
  }
  state.currentIndex = index;
  state.currentSong = state.songs[index];
  state.isPlaying = false;
  audio.pause();
  // 监听器先换新（必须在 src 赋值之前）：旧 resumeAt 监听器不得劫持新歌的 loadedmetadata。
  // 2026-08-26 复发根因：清理+挂载原在 await loadLyric 之后，而 audio.src 赋值在前——
  // 原生加载完成即 emit loadedmetadata，歌词加载慢时（网络请求）竞态窗口内旧监听器
  // （带旧断点 resumeAt）仍活着 → 新歌被 seek 到旧断点（固定秒数开始/尾部跳过）。
  // 另：nativeAudioBridge 自定义事件系统曾忽略 {once:true}（2026-08-26 已修），
  // 监听器挂上即需显式清理，清理时机必须早于任何 src 赋值。
  if (loadedMetaHandler && typeof audio.removeEventListener === "function") {
    audio.removeEventListener("loadedmetadata", loadedMetaHandler);
  }
  loadedMetaHandler = () => {
    state.duration = isFiniteNumber(audio.duration) ? audio.duration : 0;
    dbgLog("loadedmetadata", { dur: state.duration, resumeAt: opts.resumeAt ?? null });
    if (opts.resumeAt != null && audio.duration) {
      const t = Math.min(opts.resumeAt, Math.max(0, audio.duration - 0.5));
      dbgLog("loadedmetadata.seek", { t });
      audio.currentTime = t;
      state.currentTime = t;
    }
  };
  audio.addEventListener("loadedmetadata", loadedMetaHandler, { once: true });
  // 曲库网络条目（stream 歌）：实时取直链（失败重试一次，仍失败 toast）；本地歌走 /api/audio
  let src: string | null;
  const curSong = state.currentSong;
  if (curSong && isStreamSong(curSong)) {
    const { provider, streamId } = curSong;
    src = await fetchStreamUrl(provider, streamId, opts.level);
    if (!src) {
      // 保持已选歌曲状态（UI 可见），但不播放；清掉旧源避免播放键续播上一首
      audio.removeAttribute("src");
      state.currentTime = 0;
      state.duration = 0;
      playbackHooks.showToast(
        i18n.global.t("errors.streamUrlFailed", { name: curSong.name || "" }),
        true,
      );
      return;
    }
  } else {
    // 本地歌 path 必然非空（非 stream 且走到这里的 currentSong 一定带 path）；最小化 as 保持原 JS 语义
    src = "/api/audio?path=" + encodeURIComponent((state.currentSong as Song).path as string);
  }
  audio.src = streamProxyUrl(src);
  dbgLog("selectSong.src", { src: audio.src });
  // iOS：播放顺序快照同步原生（锁屏/线控后台切歌用；Web 挂起时原生按此快照切歌）
  if (isNativePlayback()) nativeSyncQueue();
  applySpeed(); // 换源后恢复变速 + 音频图路由（浏览器换 src 可能重置 playbackRate）
  // iOS 同步：本地歌资产本地优先（不阻塞远程播放；已下载时回执后切本地播放）
  maybePrefetchAsset(state.currentSong, { resumeAt: opts.resumeAt });
  // 换源后恢复目标音量（淡出可能把音量降到 0；自动播放时由 fadeIn 平滑回升）
  applyVolume();
  state.currentTime = 0;
  state.duration = 0;
  state.lyric = [];
  state.lyricFormat = null;
  state.lyricSource = null;
  state.abLoop = null; // 切歌重置 AB 循环
  resetAbLoopCount(); // 切歌重置 AB 循环计数（防走开安全阀）
  // 自动播放（播完自动切歌场景）：上一首结束切到新歌后继续播放
  if (opts.autoPlay) {
    audio.play().catch(() => {});
    if (fade > 0) fadeIn(fade);
  }
  // 加载歌词
  await loadLyric(index);
  // 预取时长；恢复上次播放时在这里 seek 到断点
  // （电台流 duration=Infinity → 保持 0，进度条走空态不崩）
  // 监听器清理+挂载已提前到 src 赋值前（见 selectSong 上部注释，2026-08-26）：
  // 旧 resumeAt 监听器不得劫持新歌，且清理必须早于原生 loadedmetadata 到达。
}

// ============ iOS 同步：本地歌播放资产本地优先（阶段3 · E1 修复） ============
// 选歌播放时对本地歌（path 非空）总是查本地资产（hasAsset → assetStatus 回执）：
//   - 已下载（exists=true）→ 回执 localURL，切本地播放（快、省流量、断网可播）
//   - 未下载 → 保持远程播放（不阻塞）；「是否自动下载」的判断在 ensureAsset 内部
//     （autoPrefetchEnabled 开启才发 syncDownload，默认关 = 只查不下载；
//     下载由同步管理页显式触发）。
// 桌面浏览器 / macOS 壳（无 iOS 桥）→ 直接 return，行为零变化。
/**
 * 选歌播放前本地资产查询（内部函数；导出供单元测试直接驱动 assetStatus 回执）。
 */
export async function maybePrefetchAsset(song: Song, opts: SelectSongOpts = {}): Promise<void> {
  try {
    if (!isNativePlayback() || !song || !song.path) return;
    const item = await assetForSong(song as unknown as Parameters<typeof assetForSong>[0]);
    if (!item) return;
    const localURL = await ensureAsset(item);
    if (!localURL) return; // 未下载 / 已发起后台下载：保持远程播放
    // 回执已存在 → 切本地播放；仅当仍是同一首歌且源未被用户切换时生效
    if (state.currentSong !== song) return;
    const curSrc = audio.src;
    if (!curSrc || curSrc === localURL) return;
    const wasPlaying = !audio.paused;
    const t = audio.currentTime || 0;
    // 断点兜底：换源后镜像清零（t=0 = 新歌还没开始播）时，调用方带的恢复位置
    // （restoreLastPlayed 断点续播）生效——切本地后从断点继续而不是从 0 开始
    const resumeAt = t > 0 ? t : (opts.resumeAt ?? 0) > 0 ? (opts.resumeAt as number) : 0;
    dbgLog("prefetch.rcv", { t, optsResumeAt: opts.resumeAt ?? null, resumeAt, src: audio.src });
    audio.removeAttribute("src");
    audio.src = localURL; // 本地文件秒开（原生 load → AVPlayer 本地播放）
    dbgLog("prefetch.local", { localURL });
    applyVolume();
    if (wasPlaying) audio.play().catch(() => {});
    // 保留进度：loadedmetadata 后再 seek（原生 load 未就绪时 seek 可能被丢弃）
    // 监听器清理 + 同歌校验：切歌后旧 onMeta 不得在新歌的 loadedmetadata 上触发
    // （否则旧断点劫持新歌，2026-08-25 固定秒数开始播放根因之一）
    if (prefetchMetaHandler && typeof audio.removeEventListener === "function") {
      audio.removeEventListener("loadedmetadata", prefetchMetaHandler);
    }
    if (resumeAt > 0) {
      prefetchMetaHandler = (e) => {
        audio.removeEventListener("loadedmetadata", prefetchMetaHandler as AudioEventListener);
        if (state.currentSong !== song) return; // 已切歌：旧回执不 seek
        const dur = (e ? (e as { duration?: number }).duration : undefined) || audio.duration || 0;
        // clamp 防越界：目标超过 duration-0.5 会播到尾部立即 ended（"直接跳过"）
        const target = dur > 0 ? Math.min(resumeAt, Math.max(0, dur - 0.5)) : resumeAt;
        dbgLog("prefetch.seek", { resumeAt, dur, target });
        if (target > 0) {
          audio.currentTime = target;
          state.currentTime = target;
        }
      };
      audio.addEventListener("loadedmetadata", prefetchMetaHandler, { once: true });
    }
  } catch {
    /* 预取失败静默：远程播放不受影响 */
  }
}
