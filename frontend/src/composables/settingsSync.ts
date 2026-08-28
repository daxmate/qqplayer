// 统一 Settings 层（QQPlayer 持久化迁移 · 前端）
//
// 架构定位：localStorage 降级为「启动缓存 + 写透缓存」，后端 GET/PUT /api/settings 为唯一真源。
//
//   - 启动：各模块原有的同步 localStorage 读取（首屏不闪变）保留；本模块随后异步 GET /api/settings，
//     字段级（k in saved）覆盖对应 reactive 与 player 状态。
//   - 变更：任意设置变化（ui/lyric/desktopLyric/playback + player 状态）→ 统一防抖 300ms
//     PUT /api/settings（按 namespace 传全字段），同时同步写透 localStorage。
//   - loaded 标志：初始 GET 返回前不允许 PUT（防止拉取结果触发回写覆盖后端）。
//   - 一次性导入：GET 返回后对比「启动时本地缓存快照」做字段级 diff——本地有值且 ≠ 后端 → 只上传脏字段；
//     上传成功后脏值落回 reactive（本地旧数据胜出），写透缓存同步 → 下次启动幂等（不再上传）。
//
// 结构：ui/lyric/desktopLyric 三个 reactive 在本模块直接引用（useSettings 无反向依赖）；
// player 侧（playbackSettings + volume/panel/controls/lastPlayed）由 playerCore 通过
// registerPlayerBridge 注册桥接（避免 playerCore ↔ 本模块的循环依赖）。
import { watch } from "vue";
import { apiGet, apiPut, invalidate } from "../utils/apiClient.js";
import {
  uiSettings,
  lyricSettings,
  desktopLyricSettings,
  downloadSettings,
  videoSettings,
  DOWNLOAD_SETTINGS_DEFAULTS,
  UI_SETTINGS_KEY,
  LYRIC_SETTINGS_KEY,
  DOWNLOAD_SETTINGS_KEY,
  VIDEO_SETTINGS_KEY,
} from "./useSettings.js";
import { uiState } from "./uiState.ts";

const SAVE_DEBOUNCE_MS = 300;

// player.mode 合法值（与 playerCore 启动缓存校验一致；后端老版本不返回该字段时不参与）
const MODE_VALUES = ["continuous", "karaoke", "books"];

/** playerCore 注册的桥：暴露 player 侧状态/设置与缓存 keys（避免本模块 ↔ playerCore 循环依赖） */
export interface PlayerBridge {
  state: {
    volume: number;
    muted: boolean;
    mode: string;
    [k: string]: unknown;
  };
  playbackSettings: {
    rememberVolume: boolean;
    resumeLast: boolean;
    [k: string]: unknown;
  };
  lastPlayedState: {
    path: string | null;
    position: number;
    ts: number;
  };
  audio: {
    volume: number;
  };
  keys: {
    PLAYBACK_SETTINGS_KEY: string;
    VOLUME_KEY: string;
    UI_STATE_KEY: string;
    LAST_PLAYED_KEY: string;
    MODE_KEY: string;
  };
  persistPlayerCache: () => void;
}

// ---------- player 桥（playerCore 注册；注册前 player 相关逻辑不可用）----------
let playerBridge: PlayerBridge | null = null;
let stopPlayerWatches: Array<() => void> = [];
let loadStarted = false; // GET 仅在桥注册后发起（避免 vitest 模块求值微任务插入时桥未注册即应用）

export function registerPlayerBridge(bridge: PlayerBridge): void {
  stopPlayerWatches.forEach((stop) => stop());
  stopPlayerWatches = [];
  playerBridge = bridge;
  stopPlayerWatches.push(
    watch(
      [
        () => bridge.state.volume,
        () => uiState.musicLibOpen,
        () => uiState.controlsHidden,
        () => bridge.state.mode,
        bridge.lastPlayedState,
      ],
      () => scheduleSave(),
      { deep: true },
    ),
    watch(bridge.playbackSettings, () => scheduleSave(), { deep: true }),
  );
  ensureLoadStarted();
}

// ---------- 状态机 ----------
let loaded = false; // 初始 GET 完成前不允许 PUT（防止拉取结果触发回写覆盖后端）
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// 防抖保存：写透本地缓存（始终）+ 后端 PUT（loaded 后）
function scheduleSave(): void {
  writeLocalCache();
  if (!loaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

async function flushSave(): Promise<void> {
  saveTimer = null;
  try {
    const r = await apiPut("/api/settings", buildPayload());
    if (r.ok) invalidate("/api/settings"); // 写透缓存：下次 GET 不走旧缓存
  } catch {
    /* 后端不可达：保留本地缓存，下次变化再试 */
  }
}

// PUT 载荷：全 namespace 全字段；player 按开关过滤（rememberVolume / resumeLast）
function buildPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ui: { ...uiSettings },
    lyric: { ...lyricSettings },
    desktopLyric: { ...desktopLyricSettings },
    download: { ...downloadSettings },
    video: { ...videoSettings },
  };
  if (playerBridge) {
    const { state, playbackSettings, lastPlayedState } = playerBridge;
    payload.playback = { ...playbackSettings };
    const player: Record<string, unknown> = {
      panel: uiState.musicLibOpen, // 即原 PANEL_KEY 的 musicLib 字段
      controls: uiState.controlsHidden, // 即原 CONTROLS_KEY
      mode: state.mode, // 模式记忆：始终上传（不受 rememberVolume/resumeLast 开关影响）
    };
    // 开关语义：rememberVolume=false 不 PUT volume；resumeLast=false 不 PUT lastPlayed
    if (playbackSettings.rememberVolume) player.volume = state.volume;
    if (playbackSettings.resumeLast && lastPlayedState.path) {
      player.lastPlayed = { ...lastPlayedState };
    }
    payload.player = player;
  }
  return payload;
}

// 写透本地缓存：保持「启动缓存」最新（下次启动同步读取 + 导入 diff 用）
function writeLocalCache(): void {
  try {
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(uiSettings));
  } catch {
    /* 忽略写入失败 */
  }
  try {
    localStorage.setItem(LYRIC_SETTINGS_KEY, JSON.stringify(lyricSettings));
  } catch {
    /* 忽略写入失败 */
  }
  try {
    localStorage.setItem(DOWNLOAD_SETTINGS_KEY, JSON.stringify(downloadSettings));
  } catch {
    /* 忽略写入失败 */
  }
  try {
    localStorage.setItem(VIDEO_SETTINGS_KEY, JSON.stringify(videoSettings));
  } catch {
    /* 忽略写入失败 */
  }
  playerBridge?.persistPlayerCache();
}

// ---------- 初始加载（GET 为唯一真源）----------
// 注：不在这里直接发起——等 playerCore 注册桥后再发（见 ensureLoadStarted），
// 保证 GET 应用时 playerBridge 已就绪；settingsLoadPromise 供 restoreLastPlayed 等等待。
export let settingsLoadPromise: Promise<void> | null = null;

function ensureLoadStarted(): void {
  if (loadStarted) return;
  loadStarted = true;
  settingsLoadPromise = loadSettings();
}

async function loadSettings(): Promise<void> {
  try {
    // 设置元数据：60s + 离线兜底（离线时用上次成功设置，本地缓存仍为写透层）
    const r = await apiGet("/api/settings", { cache: { ttl: 60, offline: true } });
    if (!r.ok) return;
    const data = (r.data || {}) as Record<string, unknown>;
    const s = (data.settings || {}) as Record<string, unknown>;
    // 快照必须在 GET 应用前捕获（写透 watch 会立刻把缓存覆写成后端值）
    const snapshots = captureLocalSnapshots();
    applyNamespace(s.ui, uiSettings);
    applyNamespace(s.lyric, lyricSettings);
    applyNamespace(s.desktopLyric, desktopLyricSettings);
    applyNamespace(s.download, downloadSettings);
    applyNamespace(s.video, videoSettings);
    normalizeDownloadSettings();
    if (playerBridge) {
      applyNamespace(s.playback, playerBridge.playbackSettings);
      applyPlayer(s.player);
    }
    await importLocalDiffs(s, snapshots);
  } catch {
    /* 后端不可达：降级为纯本地缓存模式（loaded 置真，后续变化照常 PUT 重试） */
  } finally {
    loaded = true;
  }
}

// 字段级应用：只覆盖 reactive 已知字段（k in saved），后端没返回的字段保持现状
function applyNamespace<T extends object>(saved: unknown, target: T): void {
  if (!saved || typeof saved !== "object") return;
  const record = saved as Record<string, unknown>;
  for (const k of Object.keys(target)) {
    if (k in record) (target as Record<string, unknown>)[k] = record[k];
  }
}

// download namespace 取值容错：音质枚举非法值回落默认（契约字段缺失由 applyNamespace 兜底）
const DOWNLOAD_QUALITY_VALUES = ["standard", "exhigh", "lossless", "hires"];
const QUARK_QUALITY_VALUES = ["mp3", "flac"];
const DOWNLOAD_ENGINE_VALUES = ["httpx", "aria2"];
function normalizeDownloadSettings(): void {
  if (!DOWNLOAD_QUALITY_VALUES.includes(downloadSettings.defaultQuality)) {
    downloadSettings.defaultQuality = DOWNLOAD_SETTINGS_DEFAULTS.defaultQuality;
  }
  if (!QUARK_QUALITY_VALUES.includes(downloadSettings.quarkQuality)) {
    downloadSettings.quarkQuality = DOWNLOAD_SETTINGS_DEFAULTS.quarkQuality;
  }
  if (!DOWNLOAD_ENGINE_VALUES.includes(downloadSettings.engine)) {
    downloadSettings.engine = DOWNLOAD_SETTINGS_DEFAULTS.engine;
  }
}

// 应用 player namespace（保留开关语义：rememberVolume=false 忽略后端 volume，用默认 1.0）
function applyPlayer(p: unknown): void {
  if (!p || typeof p !== "object") return;
  const record = p as Record<string, unknown>;
  if (!playerBridge) return;
  const { state, audio, playbackSettings, lastPlayedState } = playerBridge;
  if (playbackSettings.rememberVolume) {
    if (typeof record.volume === "number" && !Number.isNaN(record.volume)) {
      state.volume = Math.min(1, Math.max(0, record.volume));
      audio.volume = state.muted ? 0 : state.volume;
    }
  } else {
    // rememberVolume=false：启动忽略后端 volume（用默认 1.0，并覆盖启动缓存可能恢复的值）
    state.volume = 1.0;
    audio.volume = state.muted ? 0 : state.volume;
  }
  if (typeof record.panel === "boolean") uiState.musicLibOpen = record.panel;
  if (typeof record.controls === "boolean") uiState.controlsHidden = record.controls;
  if (MODE_VALUES.includes(record.mode as string)) state.mode = record.mode as string;
  if (record.lastPlayed && typeof record.lastPlayed === "object") {
    const lp = record.lastPlayed as Record<string, unknown>;
    if (lp.path) {
      Object.assign(lastPlayedState, {
        path: lp.path,
        position: Number(lp.position) || 0,
        ts: lp.ts || Date.now(),
      });
    }
  }
}

// ---------- 一次性导入（字段级 diff → 只上传脏字段）----------
function captureLocalSnapshots(): Record<string, string | null> {
  const snaps: Record<string, string | null> = {};
  const entries: Array<[string, string]> = [
    ["ui", UI_SETTINGS_KEY],
    ["lyric", LYRIC_SETTINGS_KEY],
    ["download", DOWNLOAD_SETTINGS_KEY],
    ["video", VIDEO_SETTINGS_KEY],
  ];
  if (playerBridge) {
    entries.push(
      ["playback", playerBridge.keys.PLAYBACK_SETTINGS_KEY],
      ["volume", playerBridge.keys.VOLUME_KEY],
      ["panel", playerBridge.keys.UI_STATE_KEY], // 统一 key：含 musicLib/playlist/controlsHidden
      ["lastPlayed", playerBridge.keys.LAST_PLAYED_KEY],
      ["mode", playerBridge.keys.MODE_KEY],
    );
  }
  for (const [ns, key] of entries) {
    try {
      snaps[ns] = localStorage.getItem(key);
    } catch {
      snaps[ns] = null;
    }
  }
  return snaps;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function importLocalDiffs(
  server: Record<string, unknown>,
  snaps: Record<string, string | null>,
): Promise<void> {
  const dirty: Record<string, unknown> = {};
  collectDirty(dirty, "ui", snaps.ui, server.ui, uiSettings);
  collectDirty(dirty, "lyric", snaps.lyric, server.lyric, lyricSettings);
  collectDirty(dirty, "download", snaps.download, server.download, downloadSettings);
  collectDirty(dirty, "video", snaps.video, server.video, videoSettings);
  if (playerBridge) {
    collectDirty(dirty, "playback", snaps.playback, server.playback, playerBridge.playbackSettings);
    const playerDirty = collectPlayerDirty(server.player, snaps);
    if (playerDirty) dirty.player = playerDirty;
  }
  if (!Object.keys(dirty).length) return; // 无脏字段：幂等，不上传
  let ok = false;
  try {
    const r = await apiPut("/api/settings", dirty);
    ok = r.ok;
    if (ok) invalidate("/api/settings");
  } catch {
    /* 忽略 */
  }
  if (!ok) return;
  // 上传成功：脏值落回 reactive（本地旧数据胜出）→ 写透缓存 → 下次启动幂等
  applyDirty(dirty);
}

function collectDirty(
  dirty: Record<string, unknown>,
  ns: string,
  raw: string | null | undefined,
  serverNs: unknown,
  target: Record<string, unknown>,
): void {
  if (!raw || !serverNs || typeof serverNs !== "object") return;
  let local: Record<string, unknown>;
  try {
    local = JSON.parse(raw);
  } catch {
    return; // 损坏缓存：跳过
  }
  if (!local || typeof local !== "object") return;
  const fields: Record<string, unknown> = {};
  for (const k of Object.keys(local)) {
    // 只对比 reactive 已知字段且后端也返回的字段；本地有值且 ≠ 后端 → 视为用户改过的旧数据
    if (
      k in target &&
      k in (serverNs as Record<string, unknown>) &&
      !deepEqual(local[k], (serverNs as Record<string, unknown>)[k])
    ) {
      fields[k] = local[k];
    }
  }
  if (Object.keys(fields).length) dirty[ns] = fields;
}

// player 脏字段收集（开关过滤：rememberVolume=false 不上传 volume；resumeLast=false 不上传 lastPlayed；
// 后端没返回的字段不参与 diff——避免把缓存回灌给尚未支持该字段的后端）
function collectPlayerDirty(
  sp: unknown,
  snaps: Record<string, string | null>,
): Record<string, unknown> | null {
  if (!sp || typeof sp !== "object" || !playerBridge) return null;
  const server = sp as Record<string, unknown>;
  const { playbackSettings } = playerBridge;
  const fields: Record<string, unknown> = {};
  if (playbackSettings.rememberVolume && snaps.volume != null && "volume" in server) {
    const v = parseFloat(snaps.volume);
    if (!Number.isNaN(v) && v >= 0 && v <= 1 && server.volume !== v) fields.volume = v;
  }
  if (snaps.panel != null && ("panel" in server || "controls" in server)) {
    try {
      const ui = JSON.parse(snaps.panel) as Record<string, unknown>;
      if (typeof ui.musicLib === "boolean" && "panel" in server && server.panel !== ui.musicLib) {
        fields.panel = ui.musicLib;
      }
      if (
        typeof ui.controlsHidden === "boolean" &&
        "controls" in server &&
        server.controls !== ui.controlsHidden
      ) {
        fields.controls = ui.controlsHidden;
      }
    } catch {
      /* 损坏缓存 */
    }
  }
  if (playbackSettings.resumeLast && snaps.lastPlayed != null && "lastPlayed" in server) {
    try {
      const lp = JSON.parse(snaps.lastPlayed) as Record<string, unknown>;
      if (lp && lp.path) {
        const spLp = server.lastPlayed as Record<string, unknown> | null | undefined;
        if (!spLp || spLp.path !== lp.path || spLp.position !== lp.position) {
          fields.lastPlayed = {
            path: lp.path,
            position: Number(lp.position) || 0,
            ts: lp.ts || Date.now(),
          };
        }
      }
    } catch {
      /* 损坏缓存 */
    }
  }
  // mode：本地缓存值合法且 ≠ 后端 → 上传；后端没返回该字段（老版本）不参与 diff
  if (snaps.mode != null && "mode" in server) {
    if (MODE_VALUES.includes(snaps.mode) && server.mode !== snaps.mode) fields.mode = snaps.mode;
  }
  return Object.keys(fields).length ? fields : null;
}

// 导入成功后把脏值落回 reactive（本地旧数据胜出；watch 随之写透缓存）
function applyDirty(dirty: Record<string, unknown>): void {
  const targets: Record<string, Record<string, unknown> | null | undefined> = {
    ui: uiSettings,
    lyric: lyricSettings,
    download: downloadSettings,
    video: videoSettings,
    playback: playerBridge?.playbackSettings,
  };
  for (const [ns, fields] of Object.entries(dirty)) {
    if (ns === "player") {
      if (!playerBridge) continue;
      const { state, audio, lastPlayedState } = playerBridge;
      const pf = fields as Record<string, unknown>;
      if (typeof pf.volume === "number") {
        state.volume = Math.min(1, Math.max(0, pf.volume));
        audio.volume = state.muted ? 0 : state.volume;
      }
      if (typeof pf.panel === "boolean") uiState.musicLibOpen = pf.panel;
      if (typeof pf.controls === "boolean") uiState.controlsHidden = pf.controls;
      if (MODE_VALUES.includes(pf.mode as string)) state.mode = pf.mode as string;
      if (pf.lastPlayed && typeof pf.lastPlayed === "object") {
        const lp = pf.lastPlayed as Record<string, unknown>;
        if (lp.path) Object.assign(lastPlayedState, lp);
      }
      continue;
    }
    const target = targets[ns];
    if (!target) continue;
    const f = fields as Record<string, unknown>;
    for (const k of Object.keys(f)) {
      if (k in target) target[k] = f[k];
    }
  }
}

// 统一 watch：四个设置对象任意变化 → 防抖 PUT + 写透缓存
watch(
  [uiSettings, lyricSettings, desktopLyricSettings, downloadSettings, videoSettings],
  () => scheduleSave(),
  { deep: true },
);
