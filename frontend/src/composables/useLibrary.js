import { computed } from "vue";
import { state } from "./playerCore.js";
import { showToast, toastError } from "./useToast.js";
import i18n from "../locales/i18n.js";

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
