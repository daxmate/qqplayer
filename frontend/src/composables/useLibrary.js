import { computed } from "vue";
import { state, audio, selectSong, _resetPlayMode } from "./playerCore.js";
import { showToast, toastError } from "./useToast.js";
import i18n from "../locales/i18n.js";

// 歌曲行拖到侧栏歌单（HTML5 DnD）的传输 MIME 类型：
// 自定义槽位避开 sortablejs 原生拖拽写入的 'Text'（=text/plain，行文本会被覆盖）；
// Playlist.vue（源）与 Sidebar.vue（目标）共用这一契约。
export const DRAG_SONG_TYPE = "application/x-qqplayer-song";

// ============ 收藏（后端持久化 ~/Library/Application Support/qqplayer）============
export async function loadFavorites() {
  try {
    const res = await fetch("/api/favorites", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      state.favorites = data.paths || [];
    }
  } catch {
    /* 忽略 */
  }
}

export function isFavorite(path) {
  return state.favorites.includes(path);
}

export async function toggleFavorite(path) {
  // 乐观更新：先改 UI，失败回滚
  const wasFav = state.favorites.includes(path);
  if (wasFav) {
    state.favorites.splice(state.favorites.indexOf(path), 1);
  } else {
    state.favorites.push(path);
  }
  try {
    await fetch("/api/favorites/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  } catch {
    // 回滚
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
    const res = await fetch("/api/playlists", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      state.playlists = data.playlists || [];
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

export async function createPlaylist(name) {
  const res = await fetch("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || i18n.global.t("errors.createPlaylist"));
  }
  const p = await res.json();
  state.playlists.push(p);
  return p;
}

export async function renamePlaylist(pid, name) {
  const p = _playlistById(pid);
  if (!p) return;
  const old = p.name;
  p.name = name.trim(); // 乐观更新
  try {
    const res = await fetch(`/api/playlists/${pid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!res.ok) throw new Error();
  } catch {
    p.name = old; // 回滚
    throw new Error(i18n.global.t("errors.renamePlaylist"));
  }
}

export async function deletePlaylist(pid) {
  const idx = state.playlists.findIndex((p) => p.id === pid);
  if (idx < 0) return;
  const [removed] = state.playlists.splice(idx, 1);
  if (state.activePlaylistId === pid) state.activePlaylistId = null;
  try {
    const res = await fetch(`/api/playlists/${pid}`, { method: "DELETE" });
    if (!res.ok) throw new Error();
  } catch {
    state.playlists.splice(idx, 0, removed); // 回滚
    throw new Error(i18n.global.t("errors.deletePlaylist"));
  }
}

export async function addToPlaylist(pid, path) {
  const p = _playlistById(pid);
  if (!p || isInPlaylist(pid, path)) return;
  p.songPaths.push(path); // 乐观更新
  try {
    const res = await fetch(`/api/playlists/${pid}/songs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) throw new Error();
  } catch {
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
  try {
    const res = await fetch(`/api/playlists/${pid}/songs/${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error();
  } catch {
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
  try {
    const res = await fetch(`/api/playlists/${pid}/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) throw new Error();
  } catch {
    p.songPaths = old; // 回滚
    throw new Error(i18n.global.t("errors.reorderPlaylist"));
  }
}

// ============ 移到废纸篓（删除曲库歌曲 + 磁盘文件）============
// DELETE /api/library/songs → { deleted: number, missing: [path], errors: [{path, reason}] }
// 网络歌 path 为 null 不参与删除；调用方（Playlist.vue）负责 toast 汇总与 loadSongs() 刷新
// 非 200 抛错（调用方 toastError）；成功返回契约对象
// 注意：后端并行开发中，按上述契约实现；后端未就绪时 fetch 失败会走到抛错分支
export async function deleteLibrarySongs(paths) {
  let res;
  try {
    res = await fetch("/api/library/songs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
  } catch {
    // 网络失败（后端未就绪 / 服务未起）统一报「删除失败」
    throw new Error(i18n.global.t("errors.deleteSongs"));
  }
  if (!res.ok) {
    throw new Error(i18n.global.t("errors.deleteSongs"));
  }
  return res.json();
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
