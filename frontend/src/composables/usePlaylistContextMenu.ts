// Playlist 右键菜单（桌面浏览器 + Swift 壳 NSMenu 共用同一套动作）
//
// 从 Playlist.vue 拆出（行为零变化重构）：ctx* 状态与动作 + 全局事件桥（CTX_EVENTS）。
// 壳右键菜单链路：Swift 注入 NSMenu → 点击调 __qqCtxMenu → window 派发 qqplayer:ctx-* 事件 →
// 这里消费（与浏览器右键菜单共用 playFor/playNextFor/goArtistFor/goAlbumFor/openAddMenuAt/openDeleteDialog），
// 事件只在原生壳内派发，浏览器永不触发。
//
// 依赖注入（主组件传入）：浏览过滤 ref（进歌手/进专辑判定与写入）、可见列表读取、对话框打开函数。
// 生命周期：onMounted 绑定事件 / onBeforeUnmount 解绑，由 composable 自管。

import { ref, computed, onMounted, onBeforeUnmount, type Ref } from "vue";
import { state, selectSong, play, toggleFavorite, _resetPlayMode } from "./usePlayer.js";
import { ADD_MENU_WIDTH } from "../components/AddToPlaylistMenu.vue";

/** 曲库歌曲（Playlist 行数据；字段与后端 /api/songs 条目一致，path 语义与 playerState 对齐） */
interface CtxSong {
  id?: string;
  name?: string;
  artist?: string;
  album?: string;
  path: string | null;
  [key: string]: unknown;
}

interface CtxDeps {
  /** 当前可见列表（过滤/排序后视图行，{ song, i } 结构；openCtxMenu 按视图索引取行） */
  getVisible: () => Array<{ song: CtxSong; i: number }>;
  /** 分组过滤 ref（进歌手/进专辑时写入；判定“已在该分组视图内”时读取） */
  browseFilter: Ref<{ type: string; value: string; artist?: string } | null>;
  /** 空值归一（未知歌手/专辑兜底名） */
  norm: (v: unknown, fallback: string) => string;
  UNKNOWN_ARTIST: string;
  UNKNOWN_ALBUM: string;
  /** 打开加歌浮层（主组件转发到 AddToPlaylistMenu） */
  openAddMenuAt: (path: string, anchor: unknown) => void;
  /** 移到废纸篓确认弹窗（主组件弹窗协调） */
  openDeleteDialog: (paths: string[]) => void;
  /** 编辑标签/刮削弹窗（主组件弹窗协调；与右键菜单同一链路，内部处理 null） */
  openTagEditor: (song: CtxSong | null) => void;
  /** 设备选择浮层（主组件弹窗协调） */
  openDevicePicker: (songs: unknown[]) => void;
}

export function usePlaylistContextMenu(deps: CtxDeps) {
  const ctxOpen = ref(false);
  const ctxSong = ref<CtxSong | null>(null);
  const ctxIdx = ref(-1); // 曲库队列索引（viewSongs 可能被过滤/排序，用原始 i）
  const ctxPos = ref({ x: 0, y: 0 });

  function openCtxMenu(e: MouseEvent, vi: number) {
    const entry = deps.getVisible()[vi];
    if (!entry) return;
    ctxSong.value = entry.song;
    ctxIdx.value = entry.i;
    ctxPos.value = { x: e.clientX, y: e.clientY };
    ctxOpen.value = true;
  }

  function ctxClose() {
    ctxOpen.value = false;
  }

  // 进歌手/进专辑：仅可跳转时显示（已在该分组视图内 → 隐藏对应入口）
  const ctxCanGoArtist = computed(() => {
    const s = ctxSong.value;
    if (!s || !s.artist) return false;
    const v = deps.norm(s.artist, deps.UNKNOWN_ARTIST);
    return !(deps.browseFilter.value?.type === "artist" && deps.browseFilter.value.value === v);
  });
  const ctxCanGoAlbum = computed(() => {
    const s = ctxSong.value;
    if (!s || !s.album) return false;
    const v = deps.norm(s.album, deps.UNKNOWN_ALBUM);
    return !(deps.browseFilter.value?.type === "album" && deps.browseFilter.value.value === v);
  });

  // 播放指定曲库索引的歌（浏览器/壳右键菜单共用；idx 越界静默）
  function playFor(idx: number) {
    if (idx >= 0 && idx < state.songs.length) {
      selectSong(idx);
      play();
    }
  }

  function ctxPlay() {
    playFor(ctxIdx.value);
    ctxClose();
  }

  // 下一首播放：把该歌挪到当前歌之后并立即播放（列表即队列，避免重复条目）
  function playNextFor(idx: number) {
    if (idx < 0 || idx >= state.songs.length) return;
    const cur = state.currentIndex;
    if (cur < 0 || idx === cur) {
      selectSong(idx);
      play();
      return;
    }
    const song = state.songs[idx];
    state.songs.splice(idx, 1);
    // 取走后当前歌索引可能前移；插到当前歌之后
    const cur2 = idx < cur ? cur - 1 : cur;
    state.songs.splice(cur2 + 1, 0, song);
    _resetPlayMode(); // 洗牌队列失效，selectSong 会按新歌重建
    selectSong(cur2 + 1);
    play();
  }

  function ctxPlayNext() {
    playNextFor(ctxIdx.value);
    ctxClose();
  }

  function ctxToggleFav() {
    const p = ctxSong.value?.path;
    if (p != null) toggleFavorite(p);
    ctxClose();
  }

  // 加歌单：复用现有 addMenu 浮层，锚定在鼠标位置（假 rect 右对齐 → 菜单从光标处展开）
  function ctxAddPlaylist() {
    const p = ctxSong.value?.path;
    if (p == null) {
      ctxClose();
      return;
    }
    const { x, y } = ctxPos.value;
    ctxClose();
    deps.openAddMenuAt(p, {
      getBoundingClientRect: () => ({
        left: x,
        top: y,
        right: x + ADD_MENU_WIDTH,
        bottom: y + 4,
        width: ADD_MENU_WIDTH,
        height: 4,
      }),
    });
  }

  // 进歌手/进专辑分组视图（浏览器/壳右键菜单共用）：按歌曲数据设置 browseFilter
  function goArtistFor(song: CtxSong | null) {
    if (song?.artist) {
      deps.browseFilter.value = {
        type: "artist",
        value: deps.norm(song.artist, deps.UNKNOWN_ARTIST),
      };
    }
  }

  function goAlbumFor(song: CtxSong | null) {
    if (song?.album) {
      deps.browseFilter.value = {
        type: "album",
        value: deps.norm(song.album, deps.UNKNOWN_ALBUM),
        artist: song.artist,
      };
    }
  }

  function ctxGoArtist() {
    goArtistFor(ctxSong.value);
    ctxClose();
  }

  function ctxGoAlbum() {
    goAlbumFor(ctxSong.value);
    ctxClose();
  }

  function ctxDelete() {
    const p = ctxSong.value?.path;
    if (p == null) {
      ctxClose();
      return;
    }
    ctxClose();
    deps.openDeleteDialog([p]);
  }

  // 编辑标签/刮削：打开 TagEditorModal（autoScrape 自动触发刮削），编辑对象 = 被右键的歌曲
  function ctxEditTags() {
    const s = ctxSong.value;
    ctxClose();
    deps.openTagEditor(s);
  }

  // 推送到设备（右键单选 → DevicePickerModal）
  function ctxPushToDevice() {
    const s = ctxSong.value;
    ctxClose();
    deps.openDevicePicker(s ? [s] : []);
  }

  // ============ Swift 壳右键菜单动作（useNativeCtxMenu 上报上下文 → 壳注入 NSMenu → 点击调 __qqCtxMenu → 事件派发到这里） ============
  function ctxSongFromEvent(e: Event): CtxSong | null {
    const path = (e as CustomEvent).detail?.path;
    if (path == null) return null;
    return state.songs.find((s) => s.path === path) ?? null;
  }

  function onCtxPlay(e: Event) {
    const s = ctxSongFromEvent(e);
    if (s) playFor(state.songs.indexOf(s));
  }

  function onCtxPlayNext(e: Event) {
    const s = ctxSongFromEvent(e);
    if (s) playNextFor(state.songs.indexOf(s));
  }

  function onCtxToggleFav(e: Event) {
    const s = ctxSongFromEvent(e);
    if (s?.path != null) toggleFavorite(s.path);
  }

  // 加歌单：与 ctxAddPlaylist 同一锚定方式（右键坐标 → 假 rect 右对齐 → 浮层从光标处展开）
  function onCtxAddPlaylist(e: Event) {
    const p = (e as CustomEvent).detail?.path;
    if (p == null) return;
    const { x, y } = (e as CustomEvent).detail;
    deps.openAddMenuAt(p, {
      getBoundingClientRect: () => ({
        left: x,
        top: y,
        right: x + ADD_MENU_WIDTH,
        bottom: y + 4,
        width: ADD_MENU_WIDTH,
        height: 4,
      }),
    });
  }

  // 移到废纸篓：与 ctxDelete 同一确认弹窗链路
  function onCtxDeleteSong(e: Event) {
    const p = (e as CustomEvent).detail?.path;
    if (p != null) deps.openDeleteDialog([p]);
  }

  function onCtxGoArtist(e: Event) {
    const s = ctxSongFromEvent(e);
    if (s) goArtistFor(s);
  }

  function onCtxGoAlbum(e: Event) {
    const s = ctxSongFromEvent(e);
    if (s) goAlbumFor(s);
  }

  // 编辑标签/刮削（壳菜单）：与浏览器右键菜单同一链路 → 打开 TagEditorModal(autoScrape)
  function onCtxEditTags(e: Event) {
    const s = ctxSongFromEvent(e);
    if (s) deps.openTagEditor(s);
  }

  const CTX_EVENTS: Array<[string, (e: Event) => void]> = [
    ["qqplayer:ctx-play", onCtxPlay],
    ["qqplayer:ctx-playnext", onCtxPlayNext],
    ["qqplayer:ctx-togglefav", onCtxToggleFav],
    ["qqplayer:ctx-addplaylist", onCtxAddPlaylist],
    ["qqplayer:ctx-deletesong", onCtxDeleteSong],
    ["qqplayer:ctx-goartist", onCtxGoArtist],
    ["qqplayer:ctx-goalbum", onCtxGoAlbum],
    ["qqplayer:ctx-edittags", onCtxEditTags],
  ];

  function bindCtxEvents() {
    for (const [name, fn] of CTX_EVENTS) window.addEventListener(name, fn);
  }

  function unbindCtxEvents() {
    for (const [name, fn] of CTX_EVENTS) window.removeEventListener(name, fn);
  }

  onMounted(bindCtxEvents); // 壳右键菜单动作（浏览器内事件永不派发，无副作用）
  onBeforeUnmount(unbindCtxEvents);

  return {
    ctxOpen,
    ctxSong,
    ctxPos,
    openCtxMenu,
    ctxClose,
    ctxCanGoArtist,
    ctxCanGoAlbum,
    ctxPlay,
    ctxPlayNext,
    ctxToggleFav,
    ctxAddPlaylist,
    ctxGoArtist,
    ctxGoAlbum,
    ctxDelete,
    ctxEditTags,
    ctxPushToDevice,
    bindCtxEvents,
    unbindCtxEvents,
  };
}
