<template>
  <div class="mobile-player" :style="playerStyle">
    <!-- 背景层：渐变常驻（无封面/关闭毛玻璃时直接可见） -->
    <div class="mp-gradient" aria-hidden="true"></div>
    <!-- 背景层：封面毛玻璃（uiSettings.glassCover 契约字段，默认开启；无封面/加载失败回退渐变） -->
    <div v-if="glassOn && bgCoverUrl && !bgFailed" class="mp-glass" aria-hidden="true">
      <img :src="bgCoverUrl" class="mp-glass-img" alt="" @error="onBgError" />
      <div class="mp-glass-scrim"></div>
    </div>

    <div class="mp-content">
      <!-- ============ 连播模式：Apple Music 三段式 ============ -->
      <template v-if="state.mode === 'continuous'">
        <!-- ① 封面区（顶部：下拉返回 + 横向切歌统一手势区；事件绑定在模板上，随元素出现/消失自动生效） -->
        <div
          ref="coverRef"
          class="mp-cover-area"
          :style="coverStyle"
          :title="t('mobile.player.pullDownHint')"
          @touchstart.passive="onCoverStart"
          @touchmove="onCoverMove"
          @touchend="onCoverEnd"
          @touchcancel="onCoverCancel"
        >
          <ChevronDown :size="15" class="mp-pull-hint" />
          <!-- showCover 关：只隐藏封面图（mp-cover-box），保留 mp-cover-area 手势区——
               该区域承载下拉返回 + 横向切歌手势，整区隐藏会失去返回/切歌能力（无其他入口）；
               歌词区 flex:1 自动上移占满，布局自洽。 -->
          <div v-if="coverVisible('large')" class="mp-cover-box">
            <img
              v-if="coverUrl && !coverFailed"
              :src="coverUrl"
              class="mp-cover-img"
              :alt="state.currentSong?.name || ''"
              @error="onCoverError"
            />
            <div v-else class="mp-cover-fallback">
              <Music :size="42" />
            </div>
          </div>
        </div>

        <!-- ② 小歌词区（固定高度、内部滚动、当前句居中、点句跳转；左划进入全歌词） -->
        <div
          ref="lyricAreaRef"
          class="mp-lyric-area"
          :style="lyricAreaStyle"
          @touchstart.passive="lyricSwipe.handleStart"
          @touchmove="lyricSwipe.handleMove"
          @touchend="lyricSwipe.handleEnd"
          @touchcancel="lyricSwipe.handleCancel"
        >
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
              @click="toggleFavorite(state.currentSong?.path || '')"
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

        <!-- ⑤ 底部控制区（循环/上一首/播放/下一首/歌单/月亮）——共享组件，全歌词界面同款 -->
        <MobileControlsRow
          :queue-open="queueOpen"
          @toggle-queue="toggleQueue"
          @open-sleep="openSleepSheet"
        />
      </template>

      <!-- ============ 跟唱模式：保持现状（全屏 KaraokePanel + karaoke 控制条） ============ -->
      <template v-else>
        <div class="mp-karaoke">
          <KaraokePanel :lyric="state.lyric" :current="currentLineIndex" :expand-btn="false" />
        </div>
        <div v-if="sleepTimerText" class="mp-sleep-timer mp-sleep-line">{{ sleepTimerText }}</div>
        <ControlBar karaoke hide-collapse collapsible class="mp-controls" />
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

    <!-- ============ 全歌词界面（歌词区左划进入；右划/返回按钮关闭） ============ -->
    <Transition name="mp-fl">
      <div
        v-if="fullLyricOpen"
        ref="fullLyricRef"
        class="mp-full-lyric"
        :style="fullLyricStyle"
        @touchstart.passive="fullLyricSwipe.handleStart"
        @touchmove="fullLyricSwipe.handleMove"
        @touchend="fullLyricSwipe.handleEnd"
        @touchcancel="fullLyricSwipe.handleCancel"
      >
        <!-- 背景与主播放页一致：渐变常驻 + 封面毛玻璃（同款 mp-glass 逻辑） -->
        <div class="mp-gradient" aria-hidden="true"></div>
        <div v-if="glassOn && bgCoverUrl && !bgFailed" class="mp-glass" aria-hidden="true">
          <img :src="bgCoverUrl" class="mp-glass-img" alt="" @error="onBgError" />
          <div class="mp-glass-scrim"></div>
        </div>
        <div class="mp-fl-content">
          <div class="mp-fl-head">
            <button
              class="mp-fl-back"
              :title="t('mobile.player.backToPlayer')"
              @click="closeFullLyric"
            >
              <ChevronDown :size="20" />
            </button>
            <div class="mp-fl-info">
              <div class="mp-fl-name">{{ state.currentSong?.name || t("control.noSong") }}</div>
              <div class="mp-fl-artist">
                {{ state.currentSong?.artist || "" }}
                <template v-if="state.currentSong?.album">
                  · {{ state.currentSong.album }}</template
                >
              </div>
            </div>
          </div>
          <!-- 全屏歌词：复用 KaraokePanel（headless），字号略大于播放页（fontScale 1.15） -->
          <div class="mp-fl-lyric">
            <KaraokePanel
              :lyric="state.lyric"
              :current="currentLineIndex"
              :expand-btn="false"
              headless
              :font-scale="1.15"
            />
          </div>
          <MobileControlsRow
            :queue-open="queueOpen"
            @toggle-queue="toggleQueue"
            @open-sleep="openSleepSheet"
          />
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
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
} from "@lucide/vue";
import { useI18n } from "vue-i18n";
import {
  state,
  playbackSettings,
  uiSettings,
  isFavorite,
  toggleFavorite,
  currentLineIndex,
  prevSong,
  nextSong,
  seek,
  type Playlist,
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
import { useCoverURL } from "../../composables/useCoverURL.js";
import { coverVisible } from "../../composables/useCoverGuard.ts";
import KaraokePanel from "../KaraokePanel.vue";
import ControlBar from "../ControlBar.vue";
import MobileControlsRow from "./MobileControlsRow.vue";
import { useHorizontalSwipe } from "../../composables/useSwipe.js";

const emit = defineEmits(["back", "open-list"]);

const { t } = useI18n();

// ---------- 封面 URL（契约 2026-08-27：useCoverURL 唯一入口） ----------
// 播放页大封面 + 毛玻璃背景共用同一 URL 来源：本地歌曲走 useCoverURL（本地 covers 缓存 →
// 内嵌 APIC（断网）→ 远程 /api/cover；@error → markCoverError 兑底），iOS 壳自动本地优先；
// 流媒体歌（stream/试听/URL）网络图直用，不走 /api/cover。恢复在线时对当前歌曲重新 resolve
// （断网期间解析为空/失败标记的封面自动补上，不等切歌）。
const glassOn = computed(() => uiSettings.glassCover !== false);
const coverPath = ref(""); // 当前本地歌曲 path（空 = 流媒体直用或无可解析键）
const coverDirect = ref(""); // 流媒体歌直用 URL（song.coverUrl && !song.path）
const coverError = ref(false); // 流媒体直用图加载失败（本地歌失败走 coverOk 标记）
const bgError = ref(false); // 毛玻璃背景直用图加载失败（本地歌同 coverOk 标记）

const {
  coverSrc,
  coverOk,
  markCoverError,
  resolveCover,
  dispose: disposeCoverURL,
} = useCoverURL({
  onOnlineRefresh: refreshCover,
});

const bgCoverUrl = computed(() => coverDirect.value || coverSrc(coverPath.value));
const coverUrl = computed(() => coverDirect.value || coverSrc(coverPath.value));
const coverFailed = computed(() =>
  coverPath.value ? !coverOk(coverPath.value) : coverError.value,
);
const bgFailed = computed(() => (coverPath.value ? !coverOk(coverPath.value) : bgError.value));

function refreshCover() {
  const s = state.currentSong;
  const key = s ? s.path || s.coverUrl || "" : "";
  coverError.value = false;
  bgError.value = false;
  if (!key) {
    coverDirect.value = "";
    coverPath.value = "";
    return;
  }
  if (!s) return; // key 非空时必有 currentSong（仅用于类型收窄，运行时不可达）
  // 流媒体歌（stream/试听/URL）：网络图直用，不走 /api/cover
  const direct = s.coverUrl && !s.path ? s.coverUrl : "";
  coverDirect.value = direct;
  if (direct) {
    coverPath.value = "";
    return;
  }
  coverPath.value = s.path || "";
  resolveCover(s.path || "", { download: true });
}

watch(
  () => {
    const s = state.currentSong;
    return s ? s.path || s.coverUrl || "" : "";
  },
  refreshCover,
  { immediate: true },
);

function onCoverError() {
  if (coverPath.value) markCoverError(coverPath.value);
  else coverError.value = true; // 流媒体直用图失败：简单错误标记
}

function onBgError() {
  if (coverPath.value) markCoverError(coverPath.value);
  else bgError.value = true; // 流媒体直用图失败：简单错误标记
}

// ---------- 封面区统一手势（下拉返回 + 横向切歌，方向仲裁共存） ----------
// 下拉常量与行为保持原样：PULL_THRESHOLD / PULL_MAX / PULL_MIN_VELOCITY /
// PULL_MIN_PX / PULL_SAMPLE_MIN_MS 均不动；仅把 touch 处理改为先做方向仲裁
// （约 10px 锁定主方向），再分流到横向切歌 / 纵向下拉。
const PULL_THRESHOLD = 100; // 松手位移阈值（px）
const PULL_MAX = 160; // 跟手最大位移（px）
const PULL_MIN_VELOCITY = 0.8; // 快速回甩最低速度（px/ms，位移超 PULL_MIN_PX 时触发）
const PULL_MIN_PX = 40; // 速度判定所需最小位移（px）
const PULL_SAMPLE_MIN_MS = 8; // 速度采样最小间隔：亚帧事件（测试/低采样）不产生速度样本
const AXIS_LOCK_PX = 10; // 方向仲裁锁定阈值（px）：横向/纵向任一主导即锁定主方向
const COVER_SLIDE_MS = 200; // 封面滑出动画时长（与 CSS transition 同步）
const COVER_REPOSITION_FALLBACK_MS = 600; // 切歌后封面 URL 未变化（单曲/相同封面）的滑入兜底
const FULL_LYRIC_SLIDE_MS = 200; // 全歌词界面滑出动画时长（与 CSS transition 同步）

const coverRef = ref<HTMLDivElement | null>(null);
const pullY = ref(0);
const pullDragging = ref(false);
interface CoverGesture {
  startX: number;
  startY: number;
  lastY: number;
  lastT: number;
  lastV: number;
  axis: "h" | "v" | null;
}
let coverGesture: CoverGesture | null = null;

const playerStyle = computed(() => ({
  transform: pullY.value ? `translateY(${pullY.value}px)` : "",
  transition: pullDragging.value ? "none" : "transform 0.25s ease",
}));

// 横向切歌：位移跟随（--mp-swipe-shift 由 useHorizontalSwipe 写入）+ 跟手/动画过渡切换
const coverNoTransition = ref(false); // true=跟手/重定位（无过渡），false=滑出/回弹/滑入（CSS transition）
const coverBusy = ref(false); // 滑出→切歌→滑入编排中：禁止新手势
let pendingSlideIn: { from: number } | null = null;
let choreoTimers: number[] = [];

// 横向手势实例：direction both + 左缘让位（屏幕左缘由 MobileShell 的 useEdgeSwipe 负责页面返回）；
// 监听不在此 bind——封面元素由下方统一手势机直接转发 handleStart/Move/End。
const coverSwipe = useHorizontalSwipe({
  enabled: () => !coverBusy.value && !fullLyricOpen.value,
  direction: "both",
  excludeEdgeZone: true,
  onTrigger: (dir) => coverTriggered(dir),
});

const coverStyle = computed(() => ({
  transform: coverSwipe.shift.value ? `translateX(${coverSwipe.shift.value}px)` : "",
  transition: coverNoTransition.value ? "none" : "transform 0.22s ease",
}));

function onCoverStart(e: TouchEvent) {
  if (coverBusy.value || fullLyricOpen.value) return;
  const touch = e.touches && e.touches[0];
  if (!touch) return;
  coverGesture = {
    startX: touch.clientX,
    startY: touch.clientY,
    lastY: touch.clientY,
    lastT: Date.now(),
    lastV: 0,
    axis: null,
  };
  coverSwipe.handleStart(e);
}

function onCoverMove(e: TouchEvent) {
  const g = coverGesture;
  if (!g) return;
  const touch = e.touches && e.touches[0];
  if (!touch) return;
  const dx = touch.clientX - g.startX;
  const dy = touch.clientY - g.startY;
  if (!g.axis) {
    // 方向仲裁：横向/纵向任一主导（> AXIS_LOCK_PX）即锁定主方向；未锁定前不 preventDefault
    if (Math.abs(dx) > AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy)) g.axis = "h";
    else if (dy > AXIS_LOCK_PX && dy > Math.abs(dx)) g.axis = "v";
    else return;
  }
  if (g.axis === "h") {
    // 横向：跟手位移交给 useHorizontalSwipe（内部含方向/阈值/速度判定）
    coverSwipe.handleMove(e);
    if (coverSwipe.dragging.value) coverNoTransition.value = true;
    return;
  }
  // 纵向：原下拉逻辑（行为不变）
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

function onCoverEnd() {
  const g = coverGesture;
  coverGesture = null;
  if (!g) return;
  if (g.axis === "h") {
    // 横向结束：开过渡（滑出或回弹）；达阈值由 onTrigger 编排，未达阈值内部回弹归零
    coverNoTransition.value = false;
    coverSwipe.handleEnd();
    return;
  }
  pullDragging.value = false;
  if (g.axis === "v") {
    const fastFlick = pullY.value >= PULL_MIN_PX && g.lastV >= PULL_MIN_VELOCITY;
    if (pullY.value >= PULL_THRESHOLD || fastFlick) {
      emit("back");
      return;
    }
    pullY.value = 0; // 回弹（CSS transition）
  } else {
    pullY.value = 0; // 未锁定：无位移
  }
}

function onCoverCancel() {
  coverGesture = null;
  pullDragging.value = false;
  pullY.value = 0;
  coverNoTransition.value = false;
  coverSwipe.handleCancel();
}

// 封面滑出→切歌→滑入编排：
//   松手达阈值 → 带过渡滑出到 ±屏宽（约 200ms）→ 切歌 → 等封面 URL 变化（或兜底）
//   → 无过渡重定位到 ∓屏宽 → 下一帧带过渡滑入 0。期间 coverBusy 锁住重复手势。
function coverTriggered(dir: "left" | "right") {
  coverBusy.value = true;
  coverNoTransition.value = false; // 开过渡：滑出动画
  const w = window.innerWidth || 375;
  coverSwipe.setShift(dir === "left" ? -w : w);
  pendingSlideIn = { from: dir === "left" ? w : -w };
  clearChoreoTimers();
  choreoTimers.push(
    setTimeout(() => {
      // 滑出完成后切歌：左划 → 下一首，右划 → 上一首
      if (dir === "left") nextSong();
      else prevSong();
      // 兜底：封面 URL 未变化（单曲队列/相同封面/加载失败）也要滑入回位
      choreoTimers.push(setTimeout(doCoverSlideIn, COVER_REPOSITION_FALLBACK_MS));
    }, COVER_SLIDE_MS),
  );
}

function doCoverSlideIn() {
  if (!pendingSlideIn) return;
  const from = pendingSlideIn.from;
  pendingSlideIn = null;
  coverNoTransition.value = true; // 无过渡：重定位到对侧（新封面位置）
  coverSwipe.setShift(from);
  void coverRef.value?.offsetWidth; // 强制 reflow：重定位立即生效
  requestAnimationFrame(() => {
    coverNoTransition.value = false; // 开过渡：滑入到 0
    coverSwipe.setShift(0);
    coverBusy.value = false;
  });
}

function clearChoreoTimers() {
  choreoTimers.forEach(clearTimeout);
  choreoTimers = [];
}

// 切歌后封面 URL 变化 → 立即触发滑入编排（不等兜底定时器）
watch(coverUrl, () => {
  if (pendingSlideIn) doCoverSlideIn();
});

// ---------- 歌词区手势：左划 → 进入全歌词界面（右划无动作；纵向滚动让位 KaraokePanel） ----------
const lyricAreaRef = ref(null);
const lyricSwipe = useHorizontalSwipe({
  enabled: () => !fullLyricOpen.value && state.mode === "continuous",
  direction: "left",
  onTrigger: () => openFullLyric(),
});
const lyricAreaStyle = computed(() => ({
  transform: lyricSwipe.shift.value ? `translateX(${lyricSwipe.shift.value}px)` : "",
  transition: lyricSwipe.dragging.value ? "none" : "transform 0.22s ease",
}));

// ---------- 全歌词界面：右划 → 返回主播放页（跟手 + 达阈值滑出；返回按钮同） ----------
const fullLyricOpen = ref(false);
const fullLyricRef = ref(null);
const fullLyricNoTransition = ref(false);
let fullLyricCloseTimer: ReturnType<typeof setTimeout> | undefined = undefined;

const fullLyricSwipe = useHorizontalSwipe({
  enabled: () => fullLyricOpen.value,
  direction: "right",
  onTrigger: () => closeFullLyric(),
});

const fullLyricStyle = computed(() => ({
  transform: fullLyricSwipe.shift.value ? `translateX(${fullLyricSwipe.shift.value}px)` : "",
  transition: fullLyricNoTransition.value ? "none" : "transform 0.22s ease",
}));

function openFullLyric() {
  if (fullLyricOpen.value) return;
  clearTimeout(fullLyricCloseTimer);
  fullLyricOpen.value = true;
  fullLyricNoTransition.value = false;
  fullLyricSwipe.setShift(0); // 入场从 0 开始（Transition 自带右滑入动画）
  lyricSwipe.reset(); // 打开后重置歌词区位移
}

function closeFullLyric() {
  if (!fullLyricOpen.value) return;
  fullLyricNoTransition.value = false; // 开过渡：滑出到右侧
  fullLyricSwipe.setShift(window.innerWidth || 375);
  clearTimeout(fullLyricCloseTimer);
  fullLyricCloseTimer = setTimeout(() => {
    fullLyricOpen.value = false;
    fullLyricSwipe.setShift(0); // 关闭后状态/位移清零
    lyricSwipe.reset();
  }, FULL_LYRIC_SLIDE_MS);
}

// ---------- 手势监听生命周期：事件绑定全部在模板上（@touch*），随元素 v-if 出现/消失自动生效；
// 这里只做组件级清理（定时器）与播放页契约标记。 ----------
onMounted(() => {
  (window as Window & { __qqpPlayerOpen?: boolean }).__qqpPlayerOpen = true; // 契约：播放页打开时不触发原生状态条召唤
});

onBeforeUnmount(() => {
  (window as Window & { __qqpPlayerOpen?: boolean }).__qqpPlayerOpen = false;
  clearChoreoTimers();
  if (fullLyricCloseTimer) clearTimeout(fullLyricCloseTimer);
  disposeCoverURL(); // 取消恢复在线订阅（契约：组件卸载清理）
});

// ---------- 歌名行 ----------
const isFav = computed(() =>
  state.currentSong ? isFavorite(state.currentSong.path || "") : false,
);
const songPath = computed(() => state.currentSong?.path || "");

// ---------- 进度条 ----------
const progressStyle = computed(() => ({
  "--fill":
    state.duration > 0 ? `${Math.min(100, (state.currentTime / state.duration) * 100)}%` : "0%",
}));

function onSeek(e: Event) {
  seek(parseFloat((e.target as HTMLInputElement).value));
}

function fmt(time: number) {
  if (!time || isNaN(time)) return "0:00";
  const m = Math.floor(time / 60);
  const s = Math.floor(time % 60);
  return m + ":" + String(s).padStart(2, "0");
}

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

async function togglePlaylistSong(p: Playlist) {
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
    toastError((err as Error).message);
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
    toastError((err as Error).message);
  }
}

// ---------- 歌单键面板：快捷入口（跳到 MobileList，由 MobileShell push 处理） ----------
function goList(kind: string, title: string) {
  queueOpen.value = false;
  emit("open-list", { name: "list", kind, title });
}

// ---------- 月亮：睡眠定时器 ----------
function pickSleep(minutes: number | null) {
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

/* ---------- ① 封面区（下拉返回 + 横向切歌统一手势区；手势全部由 JS 接管，禁浏览器手势干扰） ---------- */
.mp-cover-area {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: calc(10px + env(safe-area-inset-top)) 20px 8px;
  touch-action: none;
  will-change: transform;
}
.mp-pull-hint {
  color: var(--text3);
  margin-bottom: 6px;
  opacity: 0.85;
}
.mp-cover-box {
  width: min(calc(100vw - 40px), 46vh);
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

/* ---------- ② 小歌词区（5 行起步，弹性吃剩余空间 → 控制区贴底；左划进入全歌词） ---------- */
.mp-lyric-area {
  flex: 1;
  min-height: 200px;
  margin-top: 12px;
  padding: 0 20px; /* 左右与上下区块统一 20px（2026-08-26） */
  display: flex;
  flex-direction: column;
  /* 纵向滚动归浏览器/KaraokePanel，横向左划由 JS 接管（pan-y 让浏览器不抢横向） */
  touch-action: pan-y;
  will-change: transform;
}
.mp-lyric-area > * {
  flex: 1;
  min-height: 0;
}
/* 歌词卡片内部滚动区自带 22px 左右 padding，外层已给 20px → 内层归零避免双重缩进 */
.mp-lyric-area :deep(.kp-scroll) {
  padding-left: 0;
  padding-right: 0;
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

/* ---------- ⑤ 底部控制区（共享组件 MobileControlsRow，样式在组件内） ---------- */
/* 跟唱模式：保留原居中一行睡眠小字（自带基础样式，不依赖共享组件作用域） */
.mp-sleep-line {
  position: static;
  transform: none;
  white-space: nowrap;
  text-align: center;
  font-size: 12px;
  color: var(--text3);
  font-variant-numeric: tabular-nums;
  padding: 2px 0 0;
  flex-shrink: 0;
}

/* ---------- ⑥ 全歌词界面（歌词区左划进入；覆盖主播放页，底部面板在其上） ---------- */
.mp-full-lyric {
  position: absolute;
  inset: 0;
  z-index: 55; /* 主播放页(50)之上、底部面板(60)之下 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  will-change: transform;
}
.mp-fl-content {
  position: relative;
  z-index: 2;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.mp-fl-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: calc(10px + env(safe-area-inset-top)) 16px 8px;
}
.mp-fl-back {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text2);
  flex-shrink: 0;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.mp-fl-back:active {
  background: var(--border);
  color: var(--text);
}
.mp-fl-info {
  flex: 1;
  min-width: 0;
}
.mp-fl-name {
  font-size: 17px;
  font-weight: 800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-fl-artist {
  font-size: 12.5px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 全屏歌词：弹性占满中间，字号由 fontScale 放大；卡片底色透出毛玻璃（改透明） */
.mp-fl-lyric {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 20px 10px;
}
.mp-fl-lyric > * {
  flex: 1;
  min-height: 0;
}
.mp-fl-lyric :deep(.karaoke-panel) {
  background: transparent;
  border-color: transparent;
}
.mp-fl-lyric :deep(.kp-scroll) {
  padding-left: 0;
  padding-right: 0;
}
/* 全歌词界面入场/出场：从右侧滑入/滑出（Apple Music 风格） */
.mp-fl-enter-active,
.mp-fl-leave-active {
  transition: transform 0.26s ease;
}
.mp-fl-enter-from,
.mp-fl-leave-to {
  transform: translateX(100%);
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
/* 跟唱页顶部安全区：标题栏不压进 iOS 状态栏（连播封面区已有同款处理，跟唱漏了） */
.mp-karaoke :deep(.kp-head) {
  padding-top: calc(12px + env(safe-area-inset-top));
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
