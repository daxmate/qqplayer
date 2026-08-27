// UI 开关状态（P1-2：从 playerCore.js 迁出）
//
// 规则：面板类持久化、弹窗类瞬态。
//   - 面板类（musicLibOpen / playlistOpen / controlsHidden）：localStorage 持久化，
//     统一存单一 key qqplayer.ui.v1（JSON {musicLib, playlist, controlsHidden}）。
//   - 弹窗类（specLyricOpen）：纯内存瞬态，不持久化（每次启动都是关闭态）。
//
// 持久化写入口：
//   - toggle* 直接同步写透（与旧 persistPanels 语义一致）；
//   - 模块级 watch 兜底：外部直接改 uiState 字段（settingsSync 后端应用 / Sidebar 自动开面板）
//     也会在 nextTick 写透，保持「后端应用值落回本地缓存」的旧行为。
import { reactive, watch } from "vue";

/** 统一 UI 开关持久化 key（v1 起合并 panel/controls 两把旧 key） */
export const UI_STATE_KEY = "qqplayer.ui.v1";

// 旧 key（仅作首次升级迁移源；迁移后统一读写新 key，旧 key 保留不删，回滚旧版本仍可读到）
const LEGACY_PANEL_KEY = "qqplay…p.v1"; // 历史遗留：key 名含 U+2026（照原样保留以读旧数据）
const LEGACY_CONTROLS_KEY = "qqplayer.controls.v1";

export const uiState = reactive({
  musicLibOpen: true, // 音乐库面板开关（左侧 tab 栏控制，localStorage 持久化）
  playlistOpen: true, // 播放列表面板开关（与 musicLibOpen 同 key 持久化）
  controlsHidden: false, // 播放控制区收起（向下隐藏，localStorage 持久化）
  specLyricOpen: false, // 手动指定歌词弹窗开关（纯内存瞬态，不持久化）
});

function loadUiState() {
  // 优先读新 key
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (typeof saved.musicLib === "boolean") uiState.musicLibOpen = saved.musicLib;
      if (typeof saved.playlist === "boolean") uiState.playlistOpen = saved.playlist;
      if (typeof saved.controlsHidden === "boolean") uiState.controlsHidden = saved.controlsHidden;
      return;
    }
  } catch {
    /* 新 key 损坏：忽略，继续尝试旧 key 迁移 */
  }
  // 旧 key 迁移：首次升级后读一次旧值，写入新 key，此后统一走新 key。
  // 仅当确实读到旧数据时才写新 key——空缓存不写（与旧代码「首次 toggle 才写缓存」一致，
  // 避免凭空生成的默认缓存被一次性导入 diff 误判为「本地脏数据胜出」）。
  let migrated = false;
  try {
    const rawPanel = localStorage.getItem(LEGACY_PANEL_KEY);
    if (rawPanel) {
      const saved = JSON.parse(rawPanel);
      if (typeof saved.musicLib === "boolean") uiState.musicLibOpen = saved.musicLib;
      if (typeof saved.playlist === "boolean") uiState.playlistOpen = saved.playlist;
    }
    try {
      const rawControls = localStorage.getItem(LEGACY_CONTROLS_KEY);
      if (rawControls !== null) uiState.controlsHidden = rawControls === "1";
    } catch {
      /* 忽略 */
    }
    migrated = rawPanel != null || localStorage.getItem(LEGACY_CONTROLS_KEY) != null;
  } catch {
    /* 忽略损坏的旧缓存 */
  }
  if (migrated) persistUiState();
}
loadUiState();

function persistUiState() {
  try {
    localStorage.setItem(
      UI_STATE_KEY,
      JSON.stringify({
        musicLib: uiState.musicLibOpen,
        playlist: uiState.playlistOpen,
        controlsHidden: uiState.controlsHidden,
      }),
    );
  } catch {
    /* 忽略写入失败 */
  }
}

// 外部直接改字段（settingsSync 后端应用 / Sidebar 自动开面板等）→ nextTick 写透缓存
watch(
  [() => uiState.musicLibOpen, () => uiState.playlistOpen, () => uiState.controlsHidden],
  persistUiState,
);

export function toggleMusicLib() {
  uiState.musicLibOpen = !uiState.musicLibOpen;
  persistUiState();
}

export function togglePlaylist() {
  uiState.playlistOpen = !uiState.playlistOpen;
  persistUiState();
}

export function toggleControls() {
  uiState.controlsHidden = !uiState.controlsHidden;
  persistUiState();
}

// specLyricOpen：弹窗类瞬态，不持久化
export function openLyricSpec() {
  uiState.specLyricOpen = true;
}

export function closeLyricSpec() {
  uiState.specLyricOpen = false;
}
