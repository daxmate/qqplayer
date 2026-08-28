// Swift 壳右键菜单桥接（歌曲列表 / 智能视图 / 侧边栏歌单）
//
// 背景：浏览器端歌曲列表右键菜单用 @contextmenu.prevent 弹自定义菜单（Playlist.vue / SmartViewPanel.vue ContextMenu 组件），
// 但 Swift 壳的 WKWebView 里 contextmenu 事件被系统吞掉不触发。照抄阅读器（Reader.vue）的壳桥接范式：
//
//   1. 前端 document 监听 mousedown（button===2 或 ⌃+左键）——WKWebView 里右键 mousedown/mouseup 正常触发，
//      只有 contextmenu 被吞——检测目标是否落在歌曲行（.pl-item[data-path] 全部歌曲 / .sv-item[data-path] 智能视图行）
//      或侧边栏歌单（.sb-item[data-playlist-id]），组装上下文 ctxTarget 经 "native" 通道上报
//      （type: 'ctxState'，去重：上下文没变化不重复发）
//   2. 壳 willOpenMenu 按 ctxState 注入原生 NSMenu 项（播放/下一首播放/收藏/加歌单…）
//   3. 菜单点击 → evaluateJavaScript 调 window.__qqCtxMenu.play() 等 → 这里派发 window 事件，
//      Playlist.vue / SmartViewPanel.vue / Sidebar.vue 监听并复用浏览器右键菜单同一套动作实现（行为完全一致）
//
// 浏览器环境（无 window.qqplayerNative）init 直接返回，不挂任何监听、不装全局 API，右键行为零影响。

import { state, isFavorite } from "./usePlayer.js";
import { useShellBridge } from "./useShellBridge.js";

/** 壳右键上下文目标：最近一次右键命中的目标（壳菜单动作的数据源） */
interface CtxTarget {
  kind: "song" | "playlist";
  // 歌曲上下文（kind === 'song'）
  path?: string | null;
  songIndex?: number;
  songName?: string;
  artist?: string;
  album?: string;
  isFav?: boolean;
  hasPath?: boolean;
  canGoArtist?: boolean;
  canGoAlbum?: boolean;
  // 歌单上下文（kind === 'playlist'）
  playlistId?: string | null;
  playlistName?: string;
  songCount?: number;
}

/** 壳安装的全局右键菜单 API（evaluateJavaScript 调用入口） */
interface CtxMenuApi {
  play: () => void;
  playNext: () => void;
  toggleFav: () => void;
  addPlaylist: () => void;
  remove: () => void;
  goArtist: () => void;
  goAlbum: () => void;
  editTags: () => void;
  rename: () => void;
  delete: () => void;
}

declare global {
  interface Window {
    /** Swift 壳右键菜单 API（installCtxMenuApi 安装；壳点击 NSMenu 项经 evaluateJavaScript 调用） */
    __qqCtxMenu?: CtxMenuApi;
  }
}

// 模块级右键上下文：最近一次右键命中的目标（壳菜单动作的数据源）
let ctxTarget: CtxTarget | null = null; // { kind: 'song', path, songIndex, songName, artist, album, isFav, hasPath, canGoArtist, canGoAlbum }
//                  | { kind: 'playlist', playlistId, playlistName, songCount }
//                  | null（空白区右键 → 清空壳缓存，显示默认系统菜单）
let lastKey = ""; // 去重：上下文没变化不重复上报（壳缓存仍有效）
let mousePos: { x: number; y: number } = { x: 0, y: 0 }; // 右键坐标（「添加到歌单…」浮层锚定用）
let inited = false; // init 幂等（main.js 只调一次，测试多次调用不重复挂监听）

/** 是否运行在 Swift 原生壳内（壳注入 window.qqplayerNative；浏览器没有） */
function inNativeShell(): boolean {
  return typeof window !== "undefined" && !!window.qqplayerNative;
}

/** 上下文去重 key：JSON 全量比较（null = 空白区） */
function ctxKey(ctx: CtxTarget | null): string {
  return ctx ? JSON.stringify(ctx) : "none";
}

/**
 * 从右键事件目标找命中项：
 * - 歌曲行 `.pl-item[data-path]`（全部歌曲/歌单视图）与 `.sv-item[data-path]`（智能视图：最近添加/最近播放/常听排行）
 *   ——网络歌 path=null 时 Vue 不渲染该属性，自然不命中 → 壳显示系统菜单
 * - 侧边栏歌单 `.sb-item[data-playlist-id]`（Sidebar 为歌单行挂了 data-playlist-id；全部歌曲/智能视图入口没有 → 不命中）
 * - 其余区域 → null（清空上下文）
 */
function buildCtx(e: MouseEvent): CtxTarget | null {
  const t = e.target;
  if (t instanceof Element) {
    // 合并选择器：全部歌曲行与智能视图行同一套歌曲上下文（songIndex 按 state.songs 全库索引，
    // 智能视图行是 state.songs 的过滤视图，path 可匹配）
    const row = t.closest(".pl-item[data-path], .sv-item[data-path]");
    if (row) {
      const path = row.getAttribute("data-path");
      const songIndex = state.songs.findIndex((s) => s.path === path);
      const song = songIndex >= 0 ? state.songs[songIndex] : null;
      if (song) {
        return {
          kind: "song",
          path,
          songIndex,
          songName: song.name || "",
          artist: song.artist || "",
          album: song.album || "",
          isFav: isFavorite(path),
          hasPath: !!path,
          // 与 ContextMenu.vue 的 canGoArtist/canGoAlbum 同源：歌手/专辑非空才显示入口
          // （Playlist 分组视图内隐藏入口的细化逻辑只在浏览器菜单生效，壳内点击重复进入同一视图无害）
          canGoArtist: !!(song.artist && String(song.artist).trim()),
          canGoAlbum: !!(song.album && String(song.album).trim()),
        };
      }
      return null; // 行不在当前曲库（数据未加载完）→ 不处理
    }
    const sb = t.closest(".sb-item[data-playlist-id]");
    if (sb) {
      const id = sb.getAttribute("data-playlist-id");
      const p = state.playlists.find((x) => x.id === id);
      if (p) {
        return {
          kind: "playlist",
          playlistId: id,
          playlistName: p.name || "",
          songCount: (p.songPaths || []).length,
        };
      }
      return null;
    }
  }
  return null;
}

/** 上报 ctxState 给壳（统一壳桥：webkit 走 postMessage / tauri 走 invoke / 浏览器 noop）；非壳环境 / 发送失败静默 */
function postCtxState(): void {
  if (!inNativeShell()) return;
  const msg = ctxTarget
    ? {
        type: "ctxState",
        kind: ctxTarget.kind,
        path: ctxTarget.path ?? null,
        songIndex: ctxTarget.songIndex ?? -1,
        playlistId: ctxTarget.playlistId ?? null,
        songName: ctxTarget.songName ?? "",
        playlistName: ctxTarget.playlistName ?? "",
        isFav: !!ctxTarget.isFav,
        hasPath: !!ctxTarget.hasPath,
        canGoArtist: !!ctxTarget.canGoArtist,
        canGoAlbum: !!ctxTarget.canGoAlbum,
      }
    : { type: "ctxState", kind: null };
  try {
    useShellBridge().report(msg);
  } catch {
    /* 壳消息发送失败忽略（不影响列表交互） */
  }
}

/** 右键 mousedown：WKWebView 里 contextmenu 被系统吞掉，用 mousedown(button===2) 检测（⌃+左键也触发系统菜单，一并处理） */
function onRightMousedown(e: MouseEvent): void {
  if (e.button !== 2 && !(e.button === 0 && e.ctrlKey)) return;
  mousePos = { x: e.clientX, y: e.clientY };
  const ctx = buildCtx(e);
  const key = ctxKey(ctx);
  if (key === lastKey) return; // 上下文没变：壳缓存仍有效，不重复上报
  lastKey = key;
  ctxTarget = ctx;
  postCtxState();
}

/** 派发动作事件给组件（Playlist.vue / SmartViewPanel.vue / Sidebar.vue 监听，复用浏览器右键菜单同一套实现） */
function dispatch(type: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

/** 挂载全局菜单 API：壳点击系统右键菜单项时经 evaluateJavaScript 调用；按当前上下文 kind 路由到对应动作 */
function installCtxMenuApi(): void {
  window.__qqCtxMenu = {
    // 歌曲：播放 | 歌单：打开并播第一首
    play: () => {
      const c = ctxTarget;
      if (!c) return;
      if (c.kind === "song") dispatch("qqplayer:ctx-play", { path: c.path });
      else if (c.kind === "playlist") dispatch("qqplayer:ctx-playplaylist", { id: c.playlistId });
    },
    playNext: () => {
      if (ctxTarget?.kind === "song") dispatch("qqplayer:ctx-playnext", { path: ctxTarget.path });
    },
    toggleFav: () => {
      if (ctxTarget?.kind === "song") dispatch("qqplayer:ctx-togglefav", { path: ctxTarget.path });
    },
    // 添加到歌单…：带右键坐标（Playlist 加歌浮层锚定在鼠标位置，与浏览器菜单一致）
    addPlaylist: () => {
      if (ctxTarget?.kind === "song")
        dispatch("qqplayer:ctx-addplaylist", {
          path: ctxTarget.path,
          x: mousePos.x,
          y: mousePos.y,
        });
    },
    // 移到废纸篓：与浏览器菜单同一确认弹窗链路
    remove: () => {
      if (ctxTarget?.kind === "song") dispatch("qqplayer:ctx-deletesong", { path: ctxTarget.path });
    },
    goArtist: () => {
      if (ctxTarget?.kind === "song") dispatch("qqplayer:ctx-goartist", { path: ctxTarget.path });
    },
    goAlbum: () => {
      if (ctxTarget?.kind === "song") dispatch("qqplayer:ctx-goalbum", { path: ctxTarget.path });
    },
    // 编辑标签/刮削：打开 TagEditorModal（Playlist/SmartViewPanel 监听，autoScrape 自动刮削）
    // 网络歌（path=null）不命中歌曲行 → 无 ctxTarget，静默
    editTags: () => {
      if (ctxTarget?.kind === "song") dispatch("qqplayer:ctx-edittags", { path: ctxTarget.path });
    },
    // 歌单：重命名（行内输入）/ 删除（撤销 toast）
    rename: () => {
      if (ctxTarget?.kind === "playlist")
        dispatch("qqplayer:ctx-renameplaylist", { id: ctxTarget.playlistId });
    },
    delete: () => {
      if (ctxTarget?.kind === "playlist")
        dispatch("qqplayer:ctx-deleteplaylist", { id: ctxTarget.playlistId });
    },
  };
}

/**
 * 初始化壳右键菜单桥接（main.js 调用；浏览器内静默 no-op）。
 * 幂等：重复调用不重复挂监听 / 装 API。
 */
export function initNativeCtxMenu(): void {
  if (inited || !inNativeShell()) return;
  inited = true;
  document.addEventListener("mousedown", onRightMousedown, true);
  installCtxMenuApi();
}

/** 测试隔离：清空去重缓存与上下文（让下一次右键必然重新上报） */
export function resetNativeCtxMenu(): void {
  lastKey = "";
  ctxTarget = null;
}
