<template>
  <div class="mobile-player" :style="playerStyle">
    <!-- 背景层：渐变常驻（无封面/关闭毛玻璃时直接可见） -->
    <div class="mp-gradient" aria-hidden="true"></div>
    <!-- 背景层：封面毛玻璃（uiSettings.glassCover 契约字段，默认开启；无封面/加载失败回退渐变） -->
    <div v-if="glassOn && bgCoverUrl && !bgError" class="mp-glass" aria-hidden="true">
      <img :src="bgCoverUrl" class="mp-glass-img" alt="" @error="bgError = true" />
      <div class="mp-glass-scrim"></div>
    </div>

    <div class="mp-content">
      <!-- ============ 连播模式：Apple Music 三段式 ============ -->
      <template v-if="state.mode === 'continuous'">
        <!-- ① 封面区（顶部，下拉返回手势区） -->
        <div ref="coverRef" class="mp-cover-area" :title="t('mobile.player.pullDownHint')">
          <ChevronDown :size="15" class="mp-pull-hint" />
          <div class="mp-cover-box">
            <img
              v-if="coverUrl && !coverError"
              :src="coverUrl"
              class="mp-cover-img"
              :alt="state.currentSong?.name || ''"
              @error="coverError = true"
            />
            <div v-else class="mp-cover-fallback">
              <Music :size="42" />
            </div>
          </div>
        </div>

        <!-- ② 小歌词区（固定高度、内部滚动、当前句居中、点句跳转） -->
        <div class="mp-lyric-area">
          <KaraokePanel
            :lyric="state.lyric"
            :current="currentLineIndex"
            :expand-btn="false"
            headless
          />
        </div>

        <!-- ③ 歌名/歌手行 + 操作钮（❤️ ➕ 🎤） -->
        <div class="mp-song-row">
          <div class="mp-song-info">
            <div class="mp-song-name">{{ state.currentSong?.name || t("control.noSong") }}</div>
            <div class="mp-song-artist">
              {{ state.currentSong?.artist || "" }}
              <template v-if="state.currentSong?.album"> · {{ state.currentSong.album }}</template>
            </div>
          </div>
          <div class="mp-song-actions">
            <button
              class="mp-orb mp-fav-btn"
              :class="{ on: isFav }"
              :disabled="!state.currentSong"
              :title="isFav ? t('mobile.list.unfavorite') : t('mobile.list.favorite')"
              @click="toggleFavorite(state.currentSong.path)"
            >
              <Heart :size="20" :fill="isFav ? 'currentColor' : 'none'" />
            </button>
            <button
              class="mp-orb mp-add-btn"
              :disabled="!state.currentSong"
              :title="t('mobile.player.addToPlaylist')"
              @click="openAddSheet"
            >
              <Plus :size="20" />
            </button>
            <button
              class="mp-orb mp-karaoke-btn"
              :title="t('mobile.player.karaoke')"
              @click="state.mode = 'karaoke'"
            >
              <Mic :size="19" />
            </button>
          </div>
        </div>

        <!-- ④ 进度条行 -->
        <div class="mp-progress-row">
          <span class="mp-time">{{ fmt(state.currentTime) }}</span>
          <input
            v-if="state.duration > 0"
            class="mp-progress"
            type="range"
            min="0"
            :max="state.duration"
            :value="state.currentTime"
            step="0.1"
            :style="progressStyle"
            @input="onSeek"
          />
          <div v-else class="mp-progress mp-progress-empty"></div>
          <span class="mp-time">{{ fmt(state.duration) }}</span>
        </div>

        <!-- ⑤ 底部控制区（循环/上一首/播放/下一首/歌单/月亮） -->
        <div class="mp-controls-row">
          <button
            class="mp-cbtn mp-mode-btn"
            :class="{ on: state.playMode !== 'order' }"
            :title="playModeTitle"
            @click="cyclePlayMode"
          >
            <Shuffle v-if="state.playMode === 'shuffle'" :size="18" />
            <Repeat1 v-else-if="state.playMode === 'repeatOne'" :size="18" />
            <Repeat v-else :size="18" />
          </button>
          <button class="mp-cbtn" :title="t('control.prevSong')" @click="prevSong">
            <SkipBack :size="20" />
          </button>
          <button class="mp-cbtn mp-play" :title="t('control.playPause')" @click="togglePlay">
            <Pause v-if="state.isPlaying" :size="26" />
            <Play v-else :size="26" />
          </button>
          <button class="mp-cbtn" :title="t('control.nextSong')" @click="nextSong()">
            <SkipForward :size="20" />
          </button>
          <button
            class="mp-cbtn mp-queue-btn"
            :class="{ on: queueOpen }"
            :title="t('mobile.player.queue')"
            @click="toggleQueue"
          >
            <ListMusic :size="18" />
          </button>
          <div class="mp-moon-wrap">
            <button
              class="mp-cbtn mp-moon-btn"
              :class="{ on: sleepTimer.active }"
              :title="t('mobile.player.sleepTimer')"
              @click="openSleepSheet"
            >
              <Moon :size="18" :fill="sleepTimer.active ? 'currentColor' : 'none'" />
            </button>
            <span v-if="sleepTimerText" class="mp-sleep-timer">{{ sleepTimerText }}</span>
          </div>
        </div>
      </template>

      <!-- ============ 跟唱模式：保持现状（全屏 KaraokePanel + karaoke 控制条） ============ -->
      <template v-else>
        <div class="mp-karaoke">
          <KaraokePanel :lyric="state.lyric" :current="currentLineIndex" :expand-btn="false" />
        </div>
        <div v-if="sleepTimerText" class="mp-sleep-timer mp-sleep-line">{{ sleepTimerText }}</div>
        <ControlBar karaoke hide-collapse class="mp-controls" />
      </template>

      <!-- ============ 底部面板：➕ 加到歌单 ============ -->
      <Transition name="mp-sheet">
        <div v-if="addOpen" class="mp-sheet-backdrop" @click="addOpen = false">
          <div class="mp-sheet" @click.stop>
            <div class="mp-sheet-head">
              <span class="mp-sheet-title">{{ t("mobile.player.addToPlaylist") }}</span>
              <button
                class="mp-sheet-close"
                :title="t('mobile.list.back')"
                @click="addOpen = false"
              >
                <X :size="18" />
              </button>
            </div>
            <div class="mp-sheet-body">
              <div v-if="!state.playlists.length" class="mp-sheet-empty">
                {{ t("mobile.list.emptyPlaylists") }}
              </div>
              <div
                v-for="p in state.playlists"
                :key="p.id"
                class="mp-pl-row"
                :class="{ checked: isInPlaylist(p.id, songPath) }"
                @click="togglePlaylistSong(p)"
              >
                <span class="mp-pl-name">{{ p.name }}</span>
                <span class="mp-pl-count">{{
                  t("mobile.count.song", { n: (p.songPaths || []).length })
                }}</span>
                <Check :size="18" class="mp-pl-check" />
              </div>
              <div class="mp-pl-create">
                <input
                  v-model="newName"
                  class="mp-pl-input"
                  :placeholder="t('mobile.player.newPlaylistPlaceholder')"
                  @keyup.enter="createAndAdd"
                />
                <button class="mp-pl-create-btn" :disabled="!newName.trim()" @click="createAndAdd">
                  {{ t("mobile.player.create") }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>

      <!-- ============ 底部面板：歌单键（播放队列 + 快捷入口） ============ -->
      <Transition name="mp-sheet">
        <div v-if="queueOpen" class="mp-sheet-backdrop" @click="queueOpen = false">
          <div class="mp-sheet" @click.stop>
            <div class="mp-sheet-head">
              <span class="mp-sheet-title">{{ t("mobile.player.queue") }}</span>
              <button
                class="mp-sheet-close"
                :title="t('mobile.list.back')"
                @click="queueOpen = false"
              >
                <X :size="18" />
              </button>
            </div>
            <div class="mp-sheet-body">
              <div v-if="!state.songs.length" class="mp-sheet-empty">
                {{ t("mobile.list.emptySongs") }}
              </div>
              <div
                v-for="(s, i) in state.songs"
                :key="i"
                class="mp-queue-row"
                :class="{ current: i === state.currentIndex }"
              >
                <span class="mp-queue-name">{{ s.name }}</span>
                <span class="mp-queue-artist">{{ s.artist }}</span>
                <Music2 v-if="i === state.currentIndex" :size="14" class="mp-queue-eq" />
              </div>
              <div class="mp-sheet-quick">
                <button class="mp-quick" @click="goList('favorites', t('mobile.home.favorites'))">
                  <Heart :size="16" />
                  {{ t("mobile.home.favorites") }}
                </button>
                <button class="mp-quick" @click="goList('playlists', t('mobile.home.playlists'))">
                  <ListMusic :size="16" />
                  {{ t("mobile.home.playlists") }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>

      <!-- ============ 底部面板：月亮（睡眠定时器） ============ -->
      <Transition name="mp-sheet">
        <div v-if="sleepOpen" class="mp-sheet-backdrop" @click="sleepOpen = false">
          <div class="mp-sheet" @click.stop>
            <div class="mp-sheet-head">
              <span class="mp-sheet-title">{{ t("mobile.player.sleepTimer") }}</span>
              <button
                class="mp-sheet-close"
                :title="t('mobile.list.back')"
                @click="sleepOpen = false"
              >
                <X :size="18" />
              </button>
            </div>
            <div class="mp-sheet-body">
              <button
                class="mp-sleep-opt"
                :class="{ on: !sleepTimer.active && !playbackSettings.sleepTimerOn }"
                @click="pickSleep(null)"
              >
                <Moon :size="16" />
                {{ t("mobile.player.sleepTimerOff") }}
              </button>
              <button
                v-for="m in SLEEP_TIMER_OPTIONS"
                :key="m"
                class="mp-sleep-opt"
                :class="{ on: sleepTimer.active && playbackSettings.sleepTimerMinutes === m }"
                @click="pickSleep(m)"
              >
                <Clock :size="16" />
                {{ t("mobile.player.minutes", { n: m }) }}
                <Check
                  v-if="sleepTimer.active && playbackSettings.sleepTimerMinutes === m"
                  :size="16"
                  class="mp-opt-check"
                />
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import {
  Music,
  Music2,
  Mic,
  Heart,
  Plus,
  X,
  Check,
  Moon,
  Clock,
  ListMusic,
  ChevronDown,
  Shuffle,
  Repeat,
  Repeat1,
  Play,
  Pause,
  SkipBack,
  SkipForward,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";
import {
  state,
  playbackSettings,
  uiSettings,
  isFavorite,
  toggleFavorite,
  currentLineIndex,
  cyclePlayMode,
  prevSong,
  nextSong,
  togglePlay,
  seek,
} from "../../composables/usePlayer.js";
import {
  addToPlaylist,
  createPlaylist,
  isInPlaylist,
  removeFromPlaylist,
} from "../../composables/useLibrary.js";
import {
  SLEEP_TIMER_OPTIONS,
  sleepTimer,
  sleepTimerText,
  setSleepTimerMinutes,
  cancelSleepTimer,
  toggleSleepTimer,
} from "../../composables/useSleepTimer.js";
import { showToast, toastError } from "../../composables/useToast.js";
import { resolveServerUrl } from "../../utils/apiClient.js";
import KaraokePanel from "../KaraokePanel.vue";
import ControlBar from "../ControlBar.vue";

const emit = defineEmits(["back", "open-list"]);

const { t } = useI18n();

// ---------- 毛玻璃背景（uiSettings.glassCover 契约：另一任务在 useSettings 定义，默认 true；未定义时兼容为开启） ----------
const glassOn = computed(() => uiSettings.glassCover !== false);
const bgCoverUrl = ref("");
const bgError = ref(false);
const coverUrl = ref("");
const coverError = ref(false);

watch(
  () => {
    const s = state.currentSong;
    return s ? s.path || s.coverUrl || "" : "";
  },
  (key) => {
    bgError.value = false;
    coverError.value = false;
    if (!key) {
      bgCoverUrl.value = "";
      coverUrl.value = "";
      return;
    }
    // 流媒体歌（stream/试听/URL）：网络图直用，不走 /api/cover
    const direct =
      state.currentSong?.coverUrl && !state.currentSong?.path ? state.currentSong.coverUrl : "";
    bgCoverUrl.value = direct || resolveServerUrl("/api/cover?path=" + encodeURIComponent(key));
    coverUrl.value = bgCoverUrl.value;
  },
  { immediate: true },
);

// ---------- 顶部下拉返回手势（仅连播模式封面区；歌词区滚动互不干扰） ----------
const PULL_THRESHOLD = 100; // 松手位移阈值（px）
const PULL_MAX = 160; // 跟手最大位移（px）
const PULL_MIN_VELOCITY = 0.8; // 快速回甩最低速度（px/ms，位移超 PULL_MIN_PX 时触发）
const PULL_MIN_PX = 40; // 速度判定所需最小位移（px）
const PULL_SAMPLE_MIN_MS = 8; // 速度采样最小间隔：亚帧事件（测试/低采样）不产生速度样本

const coverRef = ref(null);
const pullY = ref(0);
const pullDragging = ref(false);
let pullGesture = null; // { startY, lastY, lastT, lastV }

const playerStyle = computed(() => ({
  transform: pullY.value ? `translateY(${pullY.value}px)` : "",
  transition: pullDragging.value ? "none" : "transform 0.25s ease",
}));

function onPullStart(e) {
  const touch = e.touches && e.touches[0];
  if (!touch) return;
  pullGesture = {
    startY: touch.clientY,
    lastY: touch.clientY,
    lastT: Date.now(),
    lastV: 0,
  };
}

function onPullMove(e) {
  const g = pullGesture;
  if (!g) return;
  const touch = e.touches && e.touches[0];
  if (!touch) return;
  const dy = touch.clientY - g.startY;
  if (dy <= 0) return; // 上滑不响应（让位系统行为）
  if (e.cancelable) e.preventDefault();
  const now = Date.now();
  const dt = now - g.lastT;
  if (dt >= PULL_SAMPLE_MIN_MS) {
    const segV = (touch.clientY - g.lastY) / dt;
    if (segV > 0) g.lastV = segV;
    g.lastY = touch.clientY;
    g.lastT = now;
  }
  pullY.value = Math.min(dy, PULL_MAX);
  pullDragging.value = true;
}

function onPullEnd() {
  const g = pullGesture;
  pullGesture = null;
  pullDragging.value = false;
  if (!g) return;
  const fastFlick = pullY.value >= PULL_MIN_PX && g.lastV >= PULL_MIN_VELOCITY;
  if (pullY.value >= PULL_THRESHOLD || fastFlick) {
    emit("back");
    return;
  }
  pullY.value = 0; // 回弹（CSS transition）
}

onMounted(() => {
  window.__qqpPlayerOpen = true; // 契约：播放页打开时不触发原生状态条召唤
  const el = coverRef.value;
  if (!el) return;
  el.addEventListener("touchstart", onPullStart, { passive: true });
  el.addEventListener("touchmove", onPullMove, { passive: false });
  el.addEventListener("touchend", onPullEnd);
  el.addEventListener("touchcancel", onPullEnd);
});

onBeforeUnmount(() => {
  window.__qqpPlayerOpen = false;
  const el = coverRef.value;
  if (!el) return;
  el.removeEventListener("touchstart", onPullStart);
  el.removeEventListener("touchmove", onPullMove);
  el.removeEventListener("touchend", onPullEnd);
  el.removeEventListener("touchcancel", onPullEnd);
});

// ---------- 歌名行 ----------
const isFav = computed(() => (state.currentSong ? isFavorite(state.currentSong.path) : false));
const songPath = computed(() => state.currentSong?.path || "");

// ---------- 进度条 ----------
const progressStyle = computed(() => ({
  "--fill":
    state.duration > 0 ? `${Math.min(100, (state.currentTime / state.duration) * 100)}%` : "0%",
}));

function onSeek(e) {
  seek(parseFloat(e.target.value));
}

function fmt(time) {
  if (!time || isNaN(time)) return "0:00";
  const m = Math.floor(time / 60);
  const s = Math.floor(time % 60);
  return m + ":" + String(s).padStart(2, "0");
}

// ---------- 播放模式 ----------
const playModeTitle = computed(() => {
  if (state.playMode === "shuffle") return t("control.modeShuffle");
  if (state.playMode === "repeatOne") return t("control.modeRepeatOne");
  return t("control.modeOrder");
});

// ---------- 底部面板开关（互斥） ----------
const addOpen = ref(false);
const queueOpen = ref(false);
const sleepOpen = ref(false);

function closeSheets() {
  addOpen.value = false;
  queueOpen.value = false;
  sleepOpen.value = false;
  pullY.value = 0;
}

function openAddSheet() {
  closeSheets();
  addOpen.value = true;
}

function toggleQueue() {
  if (queueOpen.value) {
    queueOpen.value = false;
  } else {
    closeSheets();
    queueOpen.value = true;
  }
}

function openSleepSheet() {
  closeSheets();
  sleepOpen.value = true;
}

// ---------- ➕ 加到歌单 ----------
const newName = ref("");

async function togglePlaylistSong(p) {
  const path = songPath.value;
  if (!path) return;
  try {
    if (isInPlaylist(p.id, path)) {
      await removeFromPlaylist(p.id, path); // 自带「已移除 [撤销]」toast
    } else {
      await addToPlaylist(p.id, path);
      showToast(t("sidebar.drag.added", { name: p.name }));
    }
  } catch (err) {
    toastError(err.message);
  }
}

async function createAndAdd() {
  const name = newName.value.trim();
  if (!name) return;
  try {
    const p = await createPlaylist(name);
    const path = songPath.value;
    if (path) {
      await addToPlaylist(p.id, path);
      showToast(t("sidebar.drag.added", { name: p.name }));
    }
    newName.value = "";
    addOpen.value = false;
  } catch (err) {
    toastError(err.message);
  }
}

// ---------- 歌单键面板：快捷入口（跳到 MobileList，由 MobileShell push 处理） ----------
function goList(kind, title) {
  queueOpen.value = false;
  emit("open-list", { name: "list", kind, title });
}

// ---------- 月亮：睡眠定时器 ----------
function pickSleep(minutes) {
  if (minutes == null) {
    cancelSleepTimer();
  } else {
    setSleepTimerMinutes(minutes);
    if (!sleepTimer.active) toggleSleepTimer(); // 未运行 → 立即启动（选中即激活）
  }
  sleepOpen.value = false;
}
</script>

<style scoped>
.mobile-player {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  will-change: transform;
}
/* 背景：渐变（常驻） */
.mp-gradient {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: linear-gradient(160deg, var(--bg), var(--bg2));
}
/* 背景：封面毛玻璃（放大铺满 + blur + 主题自适应遮罩） */
.mp-glass {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
}
.mp-glass-img {
  position: absolute;
  inset: -80px;
  width: calc(100% + 160px);
  height: calc(100% + 160px);
  object-fit: cover;
  filter: blur(50px) saturate(1.2);
  transform: scale(1.15);
}
/* 遮罩用主题背景色混合：深色主题=暗罩（白字可读），浅色主题=亮罩（深字可读），跟随主题不硬编码 */
.mp-glass-scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--bg) 58%, transparent);
}
.mp-content {
  position: relative;
  z-index: 2;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ---------- ① 封面区（下拉返回手势区） ---------- */
.mp-cover-area {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: calc(10px + env(safe-area-inset-top)) 16px 8px;
  touch-action: manipulation;
}
.mp-pull-hint {
  color: var(--text3);
  margin-bottom: 6px;
  opacity: 0.85;
}
.mp-cover-box {
  width: min(calc(100vw - 32px), 46vh);
  aspect-ratio: 1;
  border-radius: 18px;
  overflow: hidden;
  background: var(--card);
  box-shadow: 0 10px 32px var(--shadow);
  display: flex;
  align-items: center;
  justify-content: center;
}
.mp-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mp-cover-fallback {
  color: var(--text3);
  opacity: 0.75;
}

/* ---------- ② 小歌词区（5 行起步，弹性吃剩余空间 → 控制区贴底） ---------- */
.mp-lyric-area {
  flex: 1;
  min-height: 200px;
  margin-top: 12px;
  display: flex;
  flex-direction: column;
}
.mp-lyric-area > * {
  flex: 1;
  min-height: 0;
}

/* ---------- ③ 歌名/歌手行 + 操作钮 ---------- */
.mp-song-row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px 8px;
}
.mp-song-info {
  flex: 1;
  min-width: 0;
}
.mp-song-name {
  font-size: 18px;
  font-weight: 800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-song-artist {
  font-size: 13px;
  color: var(--text3);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-song-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.mp-orb {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1.5px solid var(--border);
  background: transparent;
  color: var(--text2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.mp-orb:active {
  background: var(--card2);
  color: var(--text);
}
.mp-orb.on {
  color: var(--red);
  border-color: var(--red);
}
.mp-orb:disabled {
  opacity: 0.4;
}

/* ---------- ④ 进度条行（细线 + 圆点，accent） ---------- */
.mp-progress-row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 20px 2px;
}
.mp-time {
  font-size: 11.5px;
  color: var(--text3);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: center;
}
.mp-progress {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    var(--accent) var(--fill, 0%),
    var(--border) var(--fill, 0%)
  );
  outline: none;
  touch-action: manipulation;
}
.mp-progress::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--accent);
  border: none;
  box-shadow: 0 2px 8px var(--accent-glow);
}
.mp-progress::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--accent);
  border: none;
  box-shadow: 0 2px 8px var(--accent-glow);
}
.mp-progress-empty {
  cursor: default;
}

/* ---------- ⑤ 底部控制区 ---------- */
.mp-controls-row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: 4px;
  padding: 6px 14px calc(10px + env(safe-area-inset-bottom));
}
.mp-cbtn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: transparent;
  color: var(--text2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition:
    transform 0.12s,
    background 0.15s;
}
.mp-cbtn:active {
  transform: scale(0.92);
  background: var(--card2);
  color: var(--text);
}
.mp-cbtn.on {
  color: var(--accent);
}
.mp-play {
  width: 58px;
  height: 58px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 4px 16px var(--accent-glow2);
}
.mp-play:active {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
}
.mp-play svg {
  margin-left: 2px; /* 播放三角视觉居中 */
}
.mp-moon-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
}
/* 月亮附近小字：倒计时/已到点（连续模式） */
.mp-sleep-timer {
  position: absolute;
  top: calc(100% + 1px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 9.5px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
/* 跟唱模式保留原居中一行小字 */
.mp-sleep-line {
  position: static;
  transform: none;
  text-align: center;
  font-size: 12px;
  color: var(--text3);
  padding: 2px 0 0;
  flex-shrink: 0;
}

/* ---------- 跟唱模式 ---------- */
.mp-karaoke {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.mp-karaoke > * {
  flex: 1;
  min-height: 0;
}
.mp-controls {
  flex-shrink: 0;
}

/* ---------- 底部面板 ---------- */
.mp-sheet-backdrop {
  position: absolute;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-end;
}
.mp-sheet {
  width: 100%;
  max-height: 72%;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border-top: 1px solid var(--border);
  border-radius: 18px 18px 0 0;
  padding: 14px 18px calc(18px + env(safe-area-inset-bottom));
  overflow: hidden;
}
.mp-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.mp-sheet-title {
  font-size: 16px;
  font-weight: 700;
}
.mp-sheet-close {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  background: var(--card2);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.mp-sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-top: 10px;
  -webkit-overflow-scrolling: touch;
}
.mp-sheet-empty {
  padding: 18px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text3);
}

/* 歌单行（➕ 面板） */
.mp-pl-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 4px;
  border-bottom: 1px solid var(--border);
  touch-action: manipulation;
}
.mp-pl-row:active {
  background: var(--card2);
}
.mp-pl-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-pl-count {
  font-size: 12px;
  color: var(--text3);
  flex-shrink: 0;
}
.mp-pl-check {
  color: var(--accent);
  opacity: 0;
  flex-shrink: 0;
}
.mp-pl-row.checked .mp-pl-check {
  opacity: 1;
}
.mp-pl-row.checked .mp-pl-name {
  color: var(--accent);
}
.mp-pl-create {
  display: flex;
  gap: 8px;
  padding: 14px 0 2px;
}
.mp-pl-input {
  flex: 1;
  min-width: 0;
  height: 38px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text);
  padding: 0 12px;
  font-size: 13.5px;
  outline: none;
}
.mp-pl-input:focus {
  border-color: var(--accent);
}
.mp-pl-create-btn {
  height: 38px;
  padding: 0 16px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  font-size: 13.5px;
  font-weight: 700;
  flex-shrink: 0;
  touch-action: manipulation;
}
.mp-pl-create-btn:disabled {
  opacity: 0.45;
}

/* 队列行（歌单键面板） */
.mp-queue-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 4px;
  border-bottom: 1px solid var(--border);
}
.mp-queue-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-queue-artist {
  font-size: 12px;
  color: var(--text3);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
.mp-queue-eq {
  color: var(--accent);
  flex-shrink: 0;
}
.mp-queue-row.current .mp-queue-name {
  color: var(--accent);
  font-weight: 700;
}
.mp-sheet-quick {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}
.mp-quick {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px;
  border-radius: 12px;
  background: var(--bg2);
  color: var(--text);
  font-size: 13.5px;
  font-weight: 600;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.mp-quick:active {
  background: var(--card2);
}

/* 睡眠定时器选项（月亮面板） */
.mp-sleep-opt {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 13px 10px;
  border-radius: 12px;
  font-size: 14px;
  color: var(--text2);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.mp-sleep-opt:active {
  background: var(--card2);
}
.mp-sleep-opt.on {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}
.mp-opt-check {
  margin-left: auto;
}

/* 面板滑入滑出 */
.mp-sheet-enter-active,
.mp-sheet-leave-active {
  transition:
    transform 0.24s ease,
    opacity 0.2s ease;
}
.mp-sheet-enter-from,
.mp-sheet-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>
