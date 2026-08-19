<template>
  <div class="app">
    <div v-if="blurCoverUrl" class="bg-blur" :style="{ backgroundImage: `url(${blurCoverUrl})` }" />
    <!-- 移动端（<1024px）：页面栈式布局（媒体库首页 / 列表 / 全屏播放器 + 迷你播放条） -->
    <MobileShell v-if="isMobile" @open-settings="isSettingsOpen = true" />
    <!-- 桌面端（≥1024px）：三栏布局（完全不变） -->
    <template v-else>
      <!-- 顶栏 -->
      <header class="topbar">
        <h1 class="logo">
          <img src="/logo.png" class="logo-img" alt="QQPlayer" />
          <span class="logo-text">Player</span>
        </h1>
        <div class="mode-tabs">
          <button
            class="tab"
            :class="{ on: state.mode === 'continuous' }"
            @click="switchMode('continuous')"
          >
            <Play :size="13" />
            {{ t("app.mode.continuous") }}
          </button>
          <button
            class="tab"
            :class="{ on: state.mode === 'karaoke' }"
            @click="switchMode('karaoke')"
          >
            <Mic :size="13" />
            {{ t("app.mode.karaoke") }}
          </button>
          <button class="tab" :class="{ on: state.mode === 'books' }" @click="switchMode('books')">
            <BookOpen :size="13" />
            {{ t("app.mode.books") }}
          </button>
          <button
            class="tab"
            :class="{ on: state.mode === 'videos' }"
            @click="switchMode('videos')"
          >
            <Video :size="13" />
            {{ t("app.mode.videos") }}
          </button>
        </div>
        <div class="topbar-search">
          <SearchAnything entry />
        </div>
        <div class="topbar-right">
          <button
            v-if="state.mode !== 'books'"
            class="gear-btn mini-btn"
            :class="{ on: miniRunning }"
            :title="miniRunning ? t('app.miniMode.running') : t('app.miniMode.standalone')"
            @click="openMiniPlayer()"
          >
            <PictureInPicture2 :size="18" />
            <span class="gear-label">{{ t("app.miniMode.label") }}</span>
          </button>
          <button
            v-if="state.mode !== 'books'"
            class="gear-btn lyric-float-btn"
            :class="{ on: desktopLyricSettings.enabled }"
            :title="
              desktopLyricSettings.enabled
                ? t('app.desktopLyric.close')
                : t('app.desktopLyric.open')
            "
            @click="toggleDesktopLyric()"
          >
            <MonitorPlay :size="18" />
            <span class="gear-label">{{ t("app.desktopLyric.label") }}</span>
          </button>
          <button class="gear-btn" :title="t('app.settings')" @click="isSettingsOpen = true">
            <Settings :size="18" />
            <span class="gear-label">{{ t("app.settings") }}</span>
          </button>
        </div>
      </header>

      <!-- 主体：连播模式 -->
      <main v-if="state.mode === 'continuous'" class="main continuous" :class="panelClass">
        <ActivityBar v-if="panelsActive" class="activity-bar" />
        <button
          v-if="!panelsActive"
          class="floating-panel-btn"
          :title="t('app.expandPanels')"
          @click="toggleMusicLib()"
        >
          <PanelLeftOpen :size="16" />
        </button>
        <Sidebar v-if="state.musicLibOpen" class="panel sidebar" />
        <Playlist v-if="state.playlistOpen" ref="playlistRef" class="panel playlist" />
        <section ref="centerRef" class="center">
          <!-- 氛围背景层（封面取色光晕，absolute 铺满 center；Cover/LyricPanel 在其上） -->
          <Visualizer class="ambient-layer" />
          <Cover v-if="uiSettings.showCover" :song="state.currentSong" :size="coverSizePx" />
          <!-- 拖拽分隔条（桌面 + 封面开启时）：上下调整封面/歌词区大小，松手记忆 -->
          <div
            v-if="uiSettings.showCover && !isMobile"
            class="cover-divider"
            :class="{ dragging }"
            :title="t('app.coverDragHint')"
            @pointerdown="startCoverDrag"
          />
          <LyricPanel v-if="state.lyric.length" :lyric="state.lyric" :current="currentLineIndex" />
          <div v-else class="no-lyric">
            <Music2 :size="40" class="no-lyric-icon" />
            <span>{{ t("app.noLyric") }}</span>
            <button class="no-lyric-btn" @click="openLyricSpec()">
              <FileMusic :size="14" />
              {{ t("app.specifyLyric") }}
            </button>
          </div>
        </section>
        <ControlBar v-show="!state.controlsHidden" class="panel controls" />
        <button
          v-if="state.controlsHidden"
          class="expand-controls-btn"
          :title="t('app.expandControls')"
          @click="toggleControls()"
        >
          <ChevronUp :size="18" />
        </button>
      </main>

      <!-- 主体：跟唱模式 -->
      <main v-else-if="state.mode === 'karaoke'" class="main karaoke" :class="panelClass">
        <ActivityBar v-if="panelsActive" class="activity-bar" />
        <Sidebar v-if="state.musicLibOpen" class="panel sidebar" />
        <Playlist v-if="state.playlistOpen" ref="playlistRef" class="panel playlist" />
        <KaraokePanel
          class="panel karaoke-panel"
          :lyric="state.lyric"
          :current="currentLineIndex"
          :expand-btn="!panelsActive"
        />
        <ControlBar v-show="!state.controlsHidden" class="panel controls" karaoke />
        <button
          v-if="state.controlsHidden"
          class="expand-controls-btn"
          :title="t('app.expandControls')"
          @click="toggleControls()"
        >
          <ChevronUp :size="18" />
        </button>
      </main>

      <!-- 主体：视频模式（视频库/播放器；ControlBar 保留，背景音乐可继续播） -->
      <main v-else-if="state.mode === 'videos'" class="main videos">
        <VideosView class="videos-area" />
        <ControlBar v-show="!state.controlsHidden" class="panel controls" />
        <button
          v-if="state.controlsHidden"
          class="expand-controls-btn"
          :title="t('app.expandControls')"
          @click="toggleControls()"
        >
          <ChevronUp :size="18" />
        </button>
      </main>

      <!-- 主体：图书模式（书架/阅读器；ControlBar 保留，背景音乐可继续播） -->
      <main v-else class="main books">
        <BooksView class="books-area" />
        <ControlBar v-show="!state.controlsHidden" class="panel controls" />
        <button
          v-if="state.controlsHidden"
          class="expand-controls-btn"
          :title="t('app.expandControls')"
          @click="toggleControls()"
        >
          <ChevronUp :size="18" />
        </button>
      </main>
    </template>

    <div v-if="state.error" class="error-bar">{{ state.error }}</div>

    <!-- 播放器级 toast（流媒体直链失败 / URL 非法等） -->
    <Transition name="player-toast">
      <div v-if="playerToast.msg" class="player-toast" :class="{ err: playerToast.err }">
        {{ playerToast.msg }}
      </div>
    </Transition>

    <SettingsModal :open="isSettingsOpen" @close="isSettingsOpen = false" />
    <LyricSpecModal />
    <!-- search anything 全屏搜索层本体（桌面/移动共用；v-if 由 isSearchOpen 单例控制） -->
    <SearchAnything @pick="onSearchPick" />

    <!-- 拖拽导入遮罩（全局；pointer-events none 不拦截交互，z-index 低于 toast 300） -->
    <Transition name="drag-overlay">
      <div v-if="dragVisible || dragUploading" class="drag-overlay">
        <Upload :size="52" class="drag-overlay-icon" />
        <span class="drag-overlay-text">{{
          dragUploading ? t("import.uploading") : t("import.dropHint")
        }}</span>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import {
  Music2,
  Mic,
  Play,
  Settings,
  PanelLeftOpen,
  ChevronUp,
  FileMusic,
  MonitorPlay,
  PictureInPicture2,
  Upload,
  BookOpen,
  Video,
} from "@lucide/vue";
import Playlist from "./components/Playlist.vue";
import Sidebar from "./components/Sidebar.vue";
import ActivityBar from "./components/ActivityBar.vue";
import Cover from "./components/Cover.vue";
import Visualizer from "./components/Visualizer.vue";
import LyricPanel from "./components/LyricPanel.vue";
import KaraokePanel from "./components/KaraokePanel.vue";
import ControlBar from "./components/ControlBar.vue";
import LyricSpecModal from "./components/LyricSpecModal.vue";
import SettingsModal from "./components/SettingsModal.vue";
import SearchAnything from "./components/SearchAnything.vue";
import BooksView from "./books/BooksView.vue";
import VideosView from "./videos/VideosView.vue";
import MobileShell from "./components/mobile/MobileShell.vue";
import { isMobile } from "./composables/useMobileViewport.js";
import { isSettingsOpen } from "./composables/settingsState.js";
import { setupDragImport, dragVisible, dragUploading } from "./composables/useDragImport.js";
import {
  coverSizePx,
  startCoverDrag,
  dragging,
  observeCoverArea,
} from "./composables/useCoverSize.js";
import {
  state,
  loadSongs,
  loadFavorites,
  loadPlaylists,
  loadQueueOrder,
  setupKeyboardShortcuts,
  setupMediaSession,
  setupPlaybackFlush,
  setupAutoRefresh,
  setupPlayerActions,
  setupMiniStatus,
  restoreLastPlayed,
  toggleControls,
  toggleMusicLib,
  togglePlaylist,
  openLyricSpec,
  currentLineIndex,
  uiSettings,
  desktopLyricSettings,
  miniRunning,
  refreshMiniStatus,
  playerToast,
} from "./composables/usePlayer.js";

const { t } = useI18n();

const centerRef = ref(null);
let cleanupCoverObserve = null;

// 封面模糊背景：当前歌曲封面 URL（开关 + 有歌时显示；流媒体歌用 coverUrl 网络图）
const blurCoverUrl = computed(() => {
  if (!uiSettings.coverBlur || !state.currentSong) return "";
  const s = state.currentSong;
  if (s.coverUrl) return s.coverUrl;
  if (!s.path) return "";
  return "/api/cover?path=" + encodeURIComponent(s.path);
});

// 面板组合 class：控制 grid 列数/区域（4 种状态）
const panelsActive = computed(() => state.musicLibOpen || state.playlistOpen);
const panelClass = computed(() => {
  const c = [];
  if (panelsActive.value) c.push("has-tabbar");
  if (state.musicLibOpen) c.push("has-music");
  if (state.playlistOpen) c.push("has-playlist");
  if (state.controlsHidden) c.push("no-controls");
  return c;
});

function switchMode(m) {
  state.mode = m;
}

// 图书模式：关闭迷你窗/桌面歌词（入口按钮已隐藏，此处处理已开着的浮窗）
// 壳内走 native 消息；浏览器走 close scheme（壳新增 qqplayermini://close / qqplayerlyric://close）
function closeFloatingForReader() {
  if (desktopLyricSettings.enabled) {
    desktopLyricSettings.enabled = false;
    if (window.qqplayerNative) {
      window.webkit.messageHandlers.native.postMessage({ type: "lyric", show: false });
    } else {
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = "qqplayerlyric://close";
      document.body.appendChild(iframe);
      setTimeout(() => iframe.remove(), 1000);
    }
  }
  if (miniRunning.value) {
    if (window.qqplayerNative) {
      window.webkit.messageHandlers.native.postMessage({ type: "closeMini" });
    } else {
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = "qqplayermini://close";
      document.body.appendChild(iframe);
      setTimeout(() => iframe.remove(), 1000);
    }
    refreshMiniStatus();
  }
}

watch(
  () => state.mode,
  (mode) => {
    if (mode === "books") closeFloatingForReader();
  },
);

// 桌面歌词悬浮窗：原生壳内直接开关面板（同进程）；浏览器版走 URL scheme 调起（拉起主 app 显示面板）
// 用隐藏 iframe 触发（location.href 会让当前页面尝试导航到未知协议，Vivaldi 可能弹窗/卡顿）
function toggleDesktopLyric() {
  desktopLyricSettings.enabled = !desktopLyricSettings.enabled;
  if (window.qqplayerNative) {
    // Swift 壳内：通知壳显示/隐藏歌词面板（壳会回写面板状态保持同步）
    window.webkit.messageHandlers.native.postMessage({
      type: "lyric",
      show: desktopLyricSettings.enabled,
    });
  } else if (desktopLyricSettings.enabled) {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = "qqplayerlyric://open";
    document.body.appendChild(iframe);
    setTimeout(() => iframe.remove(), 1000);
  }
}

// 迷你模式：原生壳内进程内开面板（主窗口自动隐藏由壳处理）；浏览器版走 scheme 调起
// 控制指令走 /api/player/action 队列回主页面执行；运行状态由 miniRunning 轮询点亮开关
function openMiniPlayer() {
  if (window.qqplayerNative) {
    window.webkit.messageHandlers.native.postMessage({ type: "openMini" });
  } else {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = "qqplayermini://open";
    document.body.appendChild(iframe);
    setTimeout(() => iframe.remove(), 1000);
  }
  refreshMiniStatus(); // 立即查一次，点亮更快
}

// search anything：歌手/专辑结果 → 打开 Playlist 分组浏览（@pick 由 App 根部实例触发）
const playlistRef = ref(null);
function onSearchPick(item) {
  if (!state.playlistOpen) togglePlaylist();
  nextTick(() => {
    const type = item.kind === "artist" ? "artists" : "albums";
    const value = item.kind === "artist" ? item.payload.artist : item.payload.album;
    playlistRef.value?.openBrowse(type, value);
  });
}

// 智能视图右键「进歌手/进专辑」→ 同一链路：打开 Playlist 分组浏览
// （SmartViewPanel 已先 emit close 关闭智能视图，这里补开播放列表面板 + 设置分组过滤）
function onOpenBrowse(e) {
  const { type, value } = e.detail || {};
  if (!type || !value) return;
  if (!state.playlistOpen) togglePlaylist();
  nextTick(() => {
    playlistRef.value?.openBrowse(type === "artist" ? "artists" : "albums", value);
  });
}

let cleanupDragImport = null;

onMounted(() => {
  // 队列顺序持久化：先拉取再加载歌曲（loadSongs 恢复顺序依赖该缓存）
  loadQueueOrder().then(() => {
    loadSongs().then(() => restoreLastPlayed());
  });
  loadFavorites();
  loadPlaylists();
  setupKeyboardShortcuts();
  setupMediaSession();
  setupPlaybackFlush();
  setupAutoRefresh();
  setupPlayerActions();
  setupMiniStatus();
  // 桌面全局拖拽导入：window 级监听，卸载时清理
  cleanupDragImport = setupDragImport();
  // 封面/歌词区尺寸：RO 量 center 高度（自适应保底 + 拖拽范围硬保护依赖）
  cleanupCoverObserve = observeCoverArea(centerRef.value);
  window.addEventListener("qqplayer:open-browse", onOpenBrowse);
});

onUnmounted(() => {
  window.removeEventListener("qqplayer:open-browse", onOpenBrowse);
  cleanupDragImport?.();
  cleanupDragImport = null;
  cleanupCoverObserve?.();
  cleanupCoverObserve = null;
});
</script>

<style scoped>
.app {
  position: relative;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 封面模糊背景层（fixed 全屏垫底，面板半透明后透出） */
.bg-blur {
  position: fixed;
  inset: 0;
  z-index: 0;
  background-size: cover;
  background-position: center;
  filter: blur(72px) saturate(1.6);
  transform: scale(1.25); /* 模糊后边缘不留黑 */
  opacity: 0.72;
  pointer-events: none;
  transition: opacity 0.5s;
}
.bg-blur::after {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--blur-mask);
}
.app > *:not(.bg-blur) {
  position: relative;
  z-index: 1;
}
/* 顶栏 */
.topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 12px 20px;
  background: var(--topbar-bg);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
/* 顶栏悬浮层（在线搜索下拉面板）需盖过主内容区：
   选择器优先级要高于 `.app > *:not(.bg-blur)`（0,2,0），否则 z-index 被覆盖为 1 */
.app > header.topbar {
  z-index: 2;
}
.logo {
  font-size: 18px;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.logo-img {
  width: 40px;
  height: 40px;
  border-radius: 9px;
  flex-shrink: 0;
  box-shadow: 0 3px 8px var(--shadow-sm);
}
.logo-text {
  font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-size: 18px;
  font-weight: 500;
  letter-spacing: 1.5px;
  color: var(--text);
}
.mode-tabs {
  display: flex;
  background: var(--bg2);
  border-radius: 12px;
  padding: 3px;
  flex-shrink: 0;
}
.tab {
  padding: 8px 18px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tab.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.gear-btn {
  height: 36px;
  padding: 0 12px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: var(--text2);
  transition: all 0.15s;
  flex-shrink: 0;
}
.gear-label {
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.gear-btn:hover {
  background: var(--card2);
  color: var(--text);
}
.gear-btn svg {
  transition: transform 0.4s;
}
.gear-btn:hover svg {
  transform: rotate(60deg);
}
/* 顶栏 search anything 入口（放大镜；组件内自带样式，这里只占位） */
.topbar-search {
  flex-shrink: 0;
}
/* 顶栏右侧按钮组：整体推到最右，悬浮窗在左、设置贴右边缘 */
.topbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.lyric-float-btn.on {
  color: var(--accent);
  background: var(--accent-soft);
}
.lyric-float-btn.on svg {
  transform: none;
}
/* 迷你模式开关：点亮样式与桌面歌词按钮一致 */
.mini-btn.on {
  color: var(--accent);
  background: var(--accent-soft);
}
.mini-btn.on svg {
  transform: none;
}

/* 主体 */
.main {
  flex: 1;
  display: flex;
  gap: 14px;
  padding: 14px 20px;
  min-height: 0;
}
.main.continuous,
.main.karaoke {
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: 1fr auto;
  grid-template-areas:
    "center"
    "controls";
  position: relative;
}
.main.continuous.has-tabbar,
.main.karaoke.has-tabbar {
  grid-template-columns: 64px 1fr;
  grid-template-areas:
    "activity center"
    "activity controls";
}
.main.continuous.has-tabbar.has-music,
.main.karaoke.has-tabbar.has-music {
  grid-template-columns: 64px 200px 1fr;
  grid-template-areas:
    "activity sidebar center"
    "activity controls controls";
}
.main.continuous.has-tabbar.has-playlist,
.main.karaoke.has-tabbar.has-playlist {
  grid-template-columns: 64px 280px 1fr;
  grid-template-areas:
    "activity playlist center"
    "activity controls controls";
}
.main.continuous.has-tabbar.has-music.has-playlist,
.main.karaoke.has-tabbar.has-music.has-playlist {
  grid-template-columns: 64px 200px 280px 1fr;
  grid-template-areas:
    "activity sidebar playlist center"
    "activity controls controls controls";
}
/* 控制区收起：去掉 controls 行，内容区占满 */
.main.continuous.no-controls,
.main.karaoke.no-controls {
  grid-template-rows: 1fr;
  grid-template-areas: "center";
}
/* 跟唱模式：面板容器圆角统一直角（用户反馈跟唱界面圆角不协调） */
.main.karaoke .karaoke-panel,
.main.karaoke .controls,
.main.karaoke .activity-bar {
  border-radius: 0;
}
.main.continuous.has-tabbar.no-controls,
.main.karaoke.has-tabbar.no-controls {
  grid-template-areas: "activity center";
}
.main.continuous.has-tabbar.has-music.no-controls,
.main.karaoke.has-tabbar.has-music.no-controls {
  grid-template-areas: "activity sidebar center";
}
.main.continuous.has-tabbar.has-playlist.no-controls,
.main.karaoke.has-tabbar.has-playlist.no-controls {
  grid-template-areas: "activity playlist center";
}
.main.continuous.has-tabbar.has-music.has-playlist.no-controls,
.main.karaoke.has-tabbar.has-music.has-playlist.no-controls {
  grid-template-areas: "activity sidebar playlist center";
}
/* 图书模式：纵向布局（书架/阅读器 + 底部控制条），不参与面板 grid */
.main.books {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  position: relative;
}
.books-area {
  flex: 1;
  min-height: 0;
}
/* 视频模式：与图书一致（视频库/播放器 + 底部控制条） */
.main.videos {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  position: relative;
}
.videos-area {
  flex: 1;
  min-height: 0;
}
.activity-bar {
  grid-area: activity;
  border-right: 1px solid var(--border);
  background: var(--bg2);
  border-radius: 16px 0 0 16px;
}
.sidebar {
  grid-area: sidebar;
}
.playlist {
  grid-area: playlist;
}
/* 都关时：内容区左上角悬浮展开按钮（不占布局，logo 不移位） */
.floating-panel-btn {
  position: absolute;
  top: 14px;
  left: 20px;
  z-index: 10;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text2);
  opacity: 0.6;
  transition: all 0.15s;
}
.floating-panel-btn:hover {
  opacity: 1;
  color: var(--text);
  background: var(--border);
}
.expand-controls-btn {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text2);
  opacity: 0.6;
  transition: all 0.15s;
}
.expand-controls-btn:hover {
  opacity: 1;
  color: var(--text);
  background: var(--border);
}
.center {
  position: relative; /* 氛围背景层 absolute 定位锚点（Visualizer ambient 模式铺满） */
  grid-area: center;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}
/* 拖拽分隔条：封面与歌词之间，hover 高亮；拖拽中全宽高亮 */
.cover-divider {
  flex-shrink: 0;
  height: 6px;
  margin: -9px 0; /* 视觉细条 + 扩大命中区（盖住 gap 12px，两侧各露 3px） */
  border-radius: 3px;
  cursor: ns-resize;
  transition: background 0.15s;
  z-index: 2;
}
.cover-divider:hover {
  background: color-mix(in srgb, var(--accent) 35%, transparent);
}
.cover-divider.dragging {
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}
/* 氛围背景层在底层；其余内容（封面/歌词/空态）抬升一层 */
.center > :not(.ambient-layer) {
  position: relative;
  z-index: 1;
}
.controls {
  grid-area: controls;
}
/* 控制条左侧贴着音乐库/播放列表边栏时：左侧两角改直角（右侧保持 16px 圆角）；
   无边栏时保持全圆角。连播/跟唱共用 panelClass，此处统一覆盖（scoped 下组件根节点带父作用域属性，选择器可命中） */
.main.has-music .controls,
.main.has-playlist .controls {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
/* 歌词面板（连播模式）同理：左侧贴着音乐库/播放列表边栏时左两角改直角（右侧保持 16px 圆角）；
   无边栏时保持全圆角（LyricPanel 根节点，scoped 机制与 .controls 相同） */
.main.has-music .lyric-panel,
.main.has-playlist .lyric-panel {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.no-lyric {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text3);
  font-size: 14px;
  min-height: 80px;
}
.no-lyric-icon {
  opacity: 0.6;
}
.no-lyric-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  padding: 7px 16px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text2);
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.15s;
}
.no-lyric-btn:hover {
  border-color: var(--accent);
  color: var(--accent-text);
  background: var(--accent-soft);
}
/* 跟唱模式：复用连播的面板 grid（选择器在上方成对共用），karaoke-panel 占中央区域 */
.karaoke-panel {
  grid-area: center;
}
.error-bar {
  position: fixed;
  left: 50%;
  bottom: 80px;
  transform: translateX(-50%);
  background: rgba(220, 60, 60, 0.92);
  color: #fff;
  padding: 10px 20px;
  border-radius: 20px;
  font-size: 13px;
  z-index: 99;
}
/* 播放器级 toast（流媒体直链失败 / URL 非法等） */
.player-toast {
  position: fixed;
  left: 50%;
  bottom: 56px;
  transform: translateX(-50%);
  z-index: 500;
  background: rgba(38, 41, 55, 0.95);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 10px 18px;
  border-radius: 12px;
  font-size: 12.5px;
  box-shadow: 0 10px 32px var(--shadow-strong);
  white-space: nowrap;
  max-width: calc(100vw - 32px);
  overflow: hidden;
  text-overflow: ellipsis;
}
.player-toast.err {
  border-color: rgba(255, 107, 107, 0.5);
  color: #ffb3b3;
}
.player-toast-enter-active,
.player-toast-leave-active {
  transition:
    opacity 0.25s,
    transform 0.25s;
}
.player-toast-enter-from,
.player-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
/* 拖拽导入遮罩：全屏半透明跟随主题变量，中间大字提示 + 图标；
   pointer-events: none 不拦截交互；z-index 高于内容/搜索层(200)、低于 toast(300) */
.drag-overlay {
  position: fixed;
  inset: 0;
  z-index: 250;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(4px);
  pointer-events: none;
  border: 3px dashed var(--accent);
  color: var(--accent-text);
}
.drag-overlay-icon {
  opacity: 0.92;
  filter: drop-shadow(0 4px 12px var(--shadow-sm));
}
.drag-overlay-text {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 1px;
}
.drag-overlay-enter-active,
.drag-overlay-leave-active {
  transition: opacity 0.18s;
}
.drag-overlay-enter-from,
.drag-overlay-leave-to {
  opacity: 0;
}
</style>
