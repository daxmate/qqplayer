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
import {
  uiSettings,
  lyricSettings,
  desktopLyricSettings,
  downloadSettings,
  DOWNLOAD_SETTINGS_DEFAULTS,
  UI_SETTINGS_KEY,
  LYRIC_SETTINGS_KEY,
  DOWNLOAD_SETTINGS_KEY,
} from "./useSettings.js";

const SAVE_DEBOUNCE_MS = 300;

// ---------- player 桥（playerCore 注册；注册前 player 相关逻辑不可用）----------
let playerBridge = null;
let stopPlayerWatches = [];
let loadStarted = false; // GET 仅在桥注册后发起（避免 vitest 模块求值微任务插入时桥未注册即应用）

export function registerPlayerBridge(bridge) {
  stopPlayerWatches.forEach((stop) => stop());
  stopPlayerWatches = [];
  playerBridge = bridge;
  stopPlayerWatches.push(
    watch(
      [
        () => bridge.state.volume,
        () => bridge.state.musicLibOpen,
        () => bridge.state.controlsHidden,
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
let saveTimer = null;

// 防抖保存：写透本地缓存（始终）+ 后端 PUT（loaded 后）
function scheduleSave() {
  writeLocalCache();
  if (!loaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

async function flushSave() {
  saveTimer = null;
  try {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload()),
    });
  } catch {
    /* 后端不可达：保留本地缓存，下次变化再试 */
  }
}

// PUT 载荷：全 namespace 全字段；player 按开关过滤（rememberVolume / resumeLast）
function buildPayload() {
  const payload = {
    ui: { ...uiSettings },
    lyric: { ...lyricSettings },
    desktopLyric: { ...desktopLyricSettings },
    download: { ...downloadSettings },
  };
  if (playerBridge) {
    const { state, playbackSettings, lastPlayedState } = playerBridge;
    payload.playback = { ...playbackSettings };
    const player = {
      panel: state.musicLibOpen, // 即原 PANEL_KEY 的 musicLib 字段
      controls: state.controlsHidden, // 即原 CONTROLS_KEY
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
function writeLocalCache() {
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
  playerBridge?.persistPlayerCache();
}

// ---------- 初始加载（GET 为唯一真源）----------
// 注：不在这里直接发起——等 playerCore 注册桥后再发（见 ensureLoadStarted），
// 保证 GET 应用时 playerBridge 已就绪；settingsLoadPromise 供 restoreLastPlayed 等等待。
export let settingsLoadPromise = null;

function ensureLoadStarted() {
  if (loadStarted) return;
  loadStarted = true;
  settingsLoadPromise = loadSettings();
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const s = data.settings || {};
    // 快照必须在 GET 应用前捕获（写透 watch 会立刻把缓存覆写成后端值）
    const snapshots = captureLocalSnapshots();
    applyNamespace(s.ui, uiSettings);
    applyNamespace(s.lyric, lyricSettings);
    applyNamespace(s.desktopLyric, desktopLyricSettings);
    applyNamespace(s.download, downloadSettings);
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
function applyNamespace(saved, target) {
  if (!saved || typeof saved !== "object") return;
  for (const k of Object.keys(target)) {
    if (k in saved) target[k] = saved[k];
  }
}

// download namespace 取值容错：音质枚举非法值回落默认（契约字段缺失由 applyNamespace 兜底）
const DOWNLOAD_QUALITY_VALUES = ["standard", "exhigh", "lossless", "hires"];
const QUARK_QUALITY_VALUES = ["mp3", "flac"];
const DOWNLOAD_ENGINE_VALUES = ["httpx", "aria2"];
function normalizeDownloadSettings() {
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
function applyPlayer(p) {
  if (!p || typeof p !== "object") return;
  const { state, audio, playbackSettings, lastPlayedState } = playerBridge;
  if (playbackSettings.rememberVolume) {
    if (typeof p.volume === "number" && !Number.isNaN(p.volume)) {
      state.volume = Math.min(1, Math.max(0, p.volume));
      audio.volume = state.muted ? 0 : state.volume;
    }
  } else {
    // rememberVolume=false：启动忽略后端 volume（用默认 1.0，并覆盖启动缓存可能恢复的值）
    state.volume = 1.0;
    audio.volume = state.muted ? 0 : state.volume;
  }
  if (typeof p.panel === "boolean") state.musicLibOpen = p.panel;
  if (typeof p.controls === "boolean") state.controlsHidden = p.controls;
  if (p.lastPlayed && typeof p.lastPlayed === "object" && p.lastPlayed.path) {
    Object.assign(lastPlayedState, {
      path: p.lastPlayed.path,
      position: Number(p.lastPlayed.position) || 0,
      ts: p.lastPlayed.ts || Date.now(),
    });
  }
}

// ---------- 一次性导入（字段级 diff → 只上传脏字段）----------
function captureLocalSnapshots() {
  const snaps = {};
  const entries = [
    ["ui", UI_SETTINGS_KEY],
    ["lyric", LYRIC_SETTINGS_KEY],
    ["download", DOWNLOAD_SETTINGS_KEY],
  ];
  if (playerBridge) {
    entries.push(
      ["playback", playerBridge.keys.PLAYBACK_SETTINGS_KEY],
      ["volume", playerBridge.keys.VOLUME_KEY],
      ["panel", playerBridge.keys.PANEL_KEY],
      ["controls", playerBridge.keys.CONTROLS_KEY],
      ["lastPlayed", playerBridge.keys.LAST_PLAYED_KEY],
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

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function importLocalDiffs(server, snaps) {
  const dirty = {};
  collectDirty(dirty, "ui", snaps.ui, server.ui, uiSettings);
  collectDirty(dirty, "lyric", snaps.lyric, server.lyric, lyricSettings);
  collectDirty(dirty, "download", snaps.download, server.download, downloadSettings);
  if (playerBridge) {
    collectDirty(dirty, "playback", snaps.playback, server.playback, playerBridge.playbackSettings);
    const playerDirty = collectPlayerDirty(server.player, snaps);
    if (playerDirty) dirty.player = playerDirty;
  }
  if (!Object.keys(dirty).length) return; // 无脏字段：幂等，不上传
  let ok = false;
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dirty),
    });
    ok = res.ok;
  } catch {
    /* 忽略 */
  }
  if (!ok) return;
  // 上传成功：脏值落回 reactive（本地旧数据胜出）→ 写透缓存 → 下次启动幂等
  applyDirty(dirty);
}

function collectDirty(dirty, ns, raw, serverNs, target) {
  if (!raw || !serverNs || typeof serverNs !== "object") return;
  let local;
  try {
    local = JSON.parse(raw);
  } catch {
    return; // 损坏缓存：跳过
  }
  if (!local || typeof local !== "object") return;
  const fields = {};
  for (const k of Object.keys(local)) {
    // 只对比 reactive 已知字段且后端也返回的字段；本地有值且 ≠ 后端 → 视为用户改过的旧数据
    if (k in target && k in serverNs && !deepEqual(local[k], serverNs[k])) {
      fields[k] = local[k];
    }
  }
  if (Object.keys(fields).length) dirty[ns] = fields;
}

// player 脏字段收集（开关过滤：rememberVolume=false 不上传 volume；resumeLast=false 不上传 lastPlayed；
// 后端没返回的字段不参与 diff——避免把缓存回灌给尚未支持该字段的后端）
function collectPlayerDirty(sp, snaps) {
  if (!sp || typeof sp !== "object" || !playerBridge) return null;
  const { playbackSettings } = playerBridge;
  const fields = {};
  if (playbackSettings.rememberVolume && snaps.volume != null && "volume" in sp) {
    const v = parseFloat(snaps.volume);
    if (!Number.isNaN(v) && v >= 0 && v <= 1 && sp.volume !== v) fields.volume = v;
  }
  if (snaps.panel != null && "panel" in sp) {
    try {
      const panel = JSON.parse(snaps.panel);
      if (typeof panel.musicLib === "boolean" && sp.panel !== panel.musicLib) {
        fields.panel = panel.musicLib;
      }
    } catch {
      /* 损坏缓存 */
    }
  }
  if (snaps.controls != null && "controls" in sp) {
    if (sp.controls !== (snaps.controls === "1")) fields.controls = snaps.controls === "1";
  }
  if (playbackSettings.resumeLast && snaps.lastPlayed != null && "lastPlayed" in sp) {
    try {
      const lp = JSON.parse(snaps.lastPlayed);
      if (lp && lp.path) {
        const spLp = sp.lastPlayed;
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
  return Object.keys(fields).length ? fields : null;
}

// 导入成功后把脏值落回 reactive（本地旧数据胜出；watch 随之写透缓存）
function applyDirty(dirty) {
  const targets = {
    ui: uiSettings,
    lyric: lyricSettings,
    download: downloadSettings,
    playback: playerBridge?.playbackSettings,
  };
  for (const [ns, fields] of Object.entries(dirty)) {
    if (ns === "player") {
      if (!playerBridge) continue;
      const { state, audio, lastPlayedState } = playerBridge;
      if (typeof fields.volume === "number") {
        state.volume = Math.min(1, Math.max(0, fields.volume));
        audio.volume = state.muted ? 0 : state.volume;
      }
      if (typeof fields.panel === "boolean") state.musicLibOpen = fields.panel;
      if (typeof fields.controls === "boolean") state.controlsHidden = fields.controls;
      if (fields.lastPlayed && fields.lastPlayed.path)
        Object.assign(lastPlayedState, fields.lastPlayed);
      continue;
    }
    const target = targets[ns];
    if (!target) continue;
    for (const k of Object.keys(fields)) {
      if (k in target) target[k] = fields[k];
    }
  }
}

// 统一 watch：四个设置对象任意变化 → 防抖 PUT + 写透缓存
watch([uiSettings, lyricSettings, desktopLyricSettings, downloadSettings], () => scheduleSave(), {
  deep: true,
});
