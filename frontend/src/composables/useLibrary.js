import { computed } from "vue";
import { state, audio, selectSong, _resetPlayMode } from "./playerCore.js";
import { showToast, toastError } from "./useToast.js";
import { apiGet, apiPost, apiDelete, invalidate, writeLocal } from "../utils/apiClient.js";
import { nativeMetaSave } from "../utils/sync.js";
import { isNativePlayback } from "./nativeAudioBridge.js";
import i18n from "../locales/i18n.js";

// 歌曲行拖到侧栏歌单（HTML5 DnD）的传输 MIME 类型：
// 自定义槽位避开 sortablejs 原生拖拽写入的 'Text'（=text/plain，行文本会被覆盖）；
// Playlist.vue（源）与 Sidebar.vue（目标）共用这一契约。
export const DRAG_SONG_TYPE = "application/x-qqplayer-song";

// ============ 收藏（后端持久化 ~/Library/Application Support/qqplayer）============
export async function loadFavorites() {
  try {
    // 元数据级缓存：60s + 离线兜底（iOS 离线可看收藏）；toggle 成功后失效
    const r = await apiGet("/api/favorites", { cache: { ttl: 60, offline: true } });
    if (r.ok) {
      const data = r.data || {};
      state.favorites = data.paths || [];
      // iOS 壳元数据文件兜底（IndexedDB 重启不可靠）：收藏落文件，fire-and-forget
      if (isNativePlayback()) {
        try {
          nativeMetaSave("favorites", JSON.stringify(state.favorites));
        } catch {
          /* 写文件失败静默 */
        }
      }
    }
  } catch {
    /* 忽略 */
  }
}

export function isFavorite(path) {
  return state.favorites.includes(path);
}

export async function toggleFavorite(path) {
  // 写路径本地优先：乐观更新 UI → 入 dirty 队列 → 立即同步
  // 网络失败保留队列（离线语义）；HTTP 拒绝回滚（服务端为准，与改造前一致）
  const wasFav = state.favorites.includes(path);
  if (wasFav) {
    state.favorites.splice(state.favorites.indexOf(path), 1);
  } else {
    state.favorites.push(path);
  }
  const result = await writeLocal({ url: "/api/favorites/toggle", method: "POST", body: { path } });
  if (result === "ok") {
    invalidate("/api/favorites");
  } else if (result === "rejected") {
    // 回滚（原实现：失败静默回滚，不抛错）
    if (wasFav) {
      state.favorites.push(path);
    } else {
      state.favorites.splice(state.favorites.indexOf(path), 1);
    }
  }
}

// ============ 歌单（后端持久化 ~/Library/Application Support/qqplayer/playlists.json）============
export async function loadPlaylists() {
  try {
    // 歌单元数据：60s + 离线兜底；增删改成功后失效
    const r = await apiGet("/api/playlists", { cache: { ttl: 60, offline: true } });
    if (r.ok) {
      const data = r.data || {};
      state.playlists = data.playlists || [];
      // iOS 壳元数据文件兜底（IndexedDB 重启不可靠）：歌单落文件，fire-and-forget
      if (isNativePlayback()) {
        try {
          nativeMetaSave("playlists", JSON.stringify(state.playlists));
        } catch {
          /* 写文件失败静默 */
        }
      }
      // 当前激活的歌单被删了 → 退回全部歌曲
      if (state.activePlaylistId && !state.playlists.some((p) => p.id === state.activePlaylistId)) {
        state.activePlaylistId = null;
      }
    }
  } catch {
    /* 忽略 */
  }
}

export const activePlaylist = computed(
  () => state.playlists.find((p) => p.id === state.activePlaylistId) || null,
);

function _playlistById(pid) {
  return state.playlists.find((p) => p.id === pid) || null;
}

export function isInPlaylist(pid, path) {
  const p = _playlistById(pid);
  return !!p && (p.songPaths || []).includes(path);
}

// 新建歌单：服务端生成 id，保持等待响应后入列表（与改造前一致；写入成功后失效列表缓存）
export async function createPlaylist(name) {
  const r = await apiPost("/api/playlists", { name: name.trim() });
  if (!r.ok) {
    const data = r.data || {};
    throw new Error(data.detail || i18n.global.t("errors.createPlaylist"));
  }
  const p = r.data;
  state.playlists.push(p);
  invalidate("/api/playlists");
  return p;
}

export async function renamePlaylist(pid, name) {
  const p = _playlistById(pid);
  if (!p) return;
  const old = p.name;
  p.name = name.trim(); // 乐观更新
  const result = await writeLocal({
    url: `/api/playlists/${pid}`,
    method: "PATCH",
    body: { name: name.trim() },
  });
  if (result === "ok") {
    invalidate("/api/playlists");
  } else if (result === "rejected") {
    p.name = old; // 回滚
    throw new Error(i18n.global.t("errors.renamePlaylist"));
  }
  // queued（网络失败）：本地保留新名，队列稍后自动同步
}

export async function deletePlaylist(pid) {
  const idx = state.playlists.findIndex((p) => p.id === pid);
  if (idx < 0) return;
  const [removed] = state.playlists.splice(idx, 1);
  if (state.activePlaylistId === pid) state.activePlaylistId = null;
  const result = await writeLocal({ url: `/api/playlists/${pid}`, method: "DELETE" });
  if (result === "ok") {
    invalidate("/api/playlists");
  } else if (result === "rejected") {
    state.playlists.splice(idx, 0, removed); // 回滚
    throw new Error(i18n.global.t("errors.deletePlaylist"));
  }
}

export async function addToPlaylist(pid, path) {
  const p = _playlistById(pid);
  if (!p || isInPlaylist(pid, path)) return;
  p.songPaths.push(path); // 乐观更新
  const result = await writeLocal({
    url: `/api/playlists/${pid}/songs`,
    method: "POST",
    body: { path },
  });
  if (result === "ok") {
    invalidate("/api/playlists");
  } else if (result === "rejected") {
    p.songPaths = p.songPaths.filter((x) => x !== path); // 回滚
    throw new Error(i18n.global.t("errors.addToPlaylist"));
  }
}

// 移除成功后的撤销：加回歌单末尾（POST 现有 API；原位恢复需整体重排，成本高价值低）
const UNDO_DURATION = 5000;

async function restoreToPlaylist(pid, path, name) {
  try {
    await addToPlaylist(pid, path);
    showToast(i18n.global.t("playlist.restoredToPlaylist", { name }));
  } catch (e) {
    toastError(e.message || i18n.global.t("errors.addToPlaylist"));
  }
}

export async function removeFromPlaylist(pid, path) {
  const p = _playlistById(pid);
  if (!p) return;
  const removed = p.songPaths.filter((x) => x === path);
  p.songPaths = p.songPaths.filter((x) => x !== path); // 乐观更新
  const result = await writeLocal({
    url: `/api/playlists/${pid}/songs/${encodeURIComponent(path)}`,
    method: "DELETE",
  });
  if (result === "ok") {
    invalidate("/api/playlists");
  } else if (result === "rejected") {
    p.songPaths.push(...removed); // 回滚
    throw new Error(i18n.global.t("errors.removeFromPlaylist"));
  }
  // 移除成功：toast「已移除 [撤销]」（函数内部处理，Playlist.vue 两个调用处自动生效）
  const song = state.songs.find((s) => s.path === path);
  const name = song?.name || i18n.global.t("errors.unknownSong");
  showToast(i18n.global.t("playlist.removedFromPlaylist", { name }), {
    duration: UNDO_DURATION,
    action: {
      label: i18n.global.t("queue.undo"),
      onClick: () => restoreToPlaylist(pid, path, name),
    },
  });
}

export async function setPlaylistOrder(pid, paths) {
  const p = _playlistById(pid);
  if (!p) return;
  const old = p.songPaths;
  p.songPaths = paths; // 乐观更新
  const result = await writeLocal({
    url: `/api/playlists/${pid}/order`,
    method: "PUT",
    body: { paths },
  });
  if (result === "ok") {
    invalidate("/api/playlists");
  } else if (result === "rejected") {
    p.songPaths = old; // 回滚
    throw new Error(i18n.global.t("errors.reorderPlaylist"));
  }
}

// ============ 移到废纸篓（删除曲库歌曲 + 磁盘文件）============
// DELETE /api/library/songs → { deleted: number, missing: [path], errors: [{path, reason}] }
// 网络歌 path 为 null 不参与删除；调用方（Playlist.vue）负责 toast 汇总与 loadSongs() 刷新
// 非 200 抛错（调用方 toastError）；成功返回契约对象
// 注意：后端并行开发中，按上述契约实现；后端未就绪时网络失败会走到抛错分支
export async function deleteLibrarySongs(paths) {
  const r = await apiDelete("/api/library/songs", { body: { paths } });
  if (!r.ok) {
    // 网络失败（后端未就绪 / 服务未起）统一报「删除失败」
    throw new Error(i18n.global.t("errors.deleteSongs"));
  }
  return r.data;
}

// 从播放队列移除已删除的歌曲（文件已删，撤销无意义 → 不弹队列撤销 toast）
// 复用 removeFromQueue 的索引处理思路：splice + currentIndex 修正 + 当前歌自动切下一首
// 倒序移除保证索引不漂移；网络歌（path=null）不参与
const _deletePathSet = (paths) => new Set((paths || []).filter((p) => p != null));

export function removeSongsFromQueue(paths) {
  const set = _deletePathSet(paths);
  for (let i = state.songs.length - 1; i >= 0; i--) {
    const song = state.songs[i];
    if (song?.path && set.has(song.path)) _spliceQueueAt(i);
  }
}

// removeFromQueue 的核心索引逻辑（无 toast/撤销；撤销由删除 toast 语义取代）
function _spliceQueueAt(index) {
  state.songs.splice(index, 1);
  if (index < state.currentIndex) {
    state.currentIndex -= 1;
  } else if (index === state.currentIndex) {
    if (state.songs.length) {
      // 删除当前歌：切到原位置的新歌（索引已自然顺延）
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
}
