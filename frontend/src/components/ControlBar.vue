<template>
  <div
    class="controls"
    :class="{ karaoke, collapsible, collapsed }"
    @touchstart.passive="onTouchStart"
    @touchend.passive="onTouchEnd"
  >
    <button
      v-if="!hideCollapse"
      class="collapse-btn"
      :title="t('control.collapse')"
      @click="toggleControls()"
    >
      <ChevronDown :size="16" />
    </button>
    <!-- 进度条 -->
    <div class="progress-row">
      <!-- 迷你频谱条（桌面端；移动端由 MobilePlayer 中部小频谱承担，避免重复） -->
      <MiniSpectrum v-if="!isMobile" class="mini-spectrum-slot" />
      <span class="time">{{ fmt(state.currentTime) }}</span>
      <input
        v-if="state.duration > 0"
        class="progress"
        type="range"
        min="0"
        :max="state.duration"
        :value="state.currentTime"
        step="0.1"
        @input="onSeek"
      />
      <div v-else class="progress progress-empty"></div>
      <span class="time">{{ fmt(state.duration) }}</span>
    </div>

    <!-- 按钮 -->
    <div class="btn-row">
      <template v-if="!karaoke">
        <button
          class="btn"
          :class="{ on: state.playMode !== 'order' }"
          :title="playModeTitle"
          @click="cyclePlayMode"
        >
          <Shuffle v-if="state.playMode === 'shuffle'" :size="15" />
          <Repeat1 v-else-if="state.playMode === 'repeatOne'" :size="15" />
          <Repeat v-else :size="15" />
        </button>
      </template>
      <button v-if="!collapsed" class="btn" :title="t('control.prevSong')" @click="prevSong()">
        <SkipBack :size="17" />
      </button>

      <template v-if="karaoke">
        <button
          v-if="!collapsed"
          class="btn"
          :title="t('control.backToMusic')"
          @click="switchMode('continuous')"
        >
          <ArrowLeft :size="16" />
        </button>
        <button v-if="!collapsed" class="btn" :title="t('control.prevLine')" @click="prevLine">
          <StepBack :size="17" />
        </button>
        <button class="btn play ctrl-play" :title="t('control.playPause')" @click="togglePlay">
          <Pause v-if="state.isPlaying" :size="21" />
          <Play v-else :size="21" />
        </button>
        <button v-if="!collapsed" class="btn" :title="t('control.nextLine')" @click="nextLine">
          <StepForward :size="17" />
        </button>
        <button
          class="btn ctrl-speed"
          :class="{ on: state.speed !== 1.0 }"
          :title="t('control.speed')"
          @click="cycleSpeed"
        >
          <Gauge :size="15" />
          {{ state.speed }}x
        </button>
        <button
          class="btn on ctrl-mic"
          :title="t('control.exitKaraoke')"
          @click="switchMode('continuous')"
        >
          <Mic :size="15" />
          {{ t("control.karaoke") }}
        </button>
        <button
          class="btn ctrl-loop"
          :class="{ on: state.abLoop || state.karaokeLoop }"
          :disabled="!state.karaokeOn"
          :title="loopTitle"
          @pointerdown="onLoopPressStart"
          @pointerup="onLoopPressEnd"
          @pointerleave="onLoopPressEnd"
          @click="onLoopClick"
        >
          <Repeat2 v-if="state.abLoop" :size="15" />
          <Repeat1 v-else :size="15" />
          {{ state.abLoop ? "AB" : t("control.singleLine") }}
        </button>
      </template>
      <template v-else>
        <button class="btn play" :title="t('control.playPause')" @click="togglePlay">
          <Pause v-if="state.isPlaying" :size="21" />
          <Play v-else :size="21" />
        </button>
        <button class="btn" :title="t('control.nextSong')" @click="nextSong()">
          <SkipForward :size="17" />
        </button>
        <button class="btn" :title="t('control.karaoke')" @click="switchMode('karaoke')">
          <Mic :size="15" />
          {{ t("control.karaoke") }}
        </button>
      </template>

      <button v-if="!collapsed" class="btn" :title="t('control.playUrl')" @click="urlOpen = true">
        <Link2 :size="15" />
      </button>

      <button
        v-if="!collapsed && isNetworkCurrent"
        class="btn"
        data-testid="download-btn"
        :class="{ busy: downloadingId !== null }"
        :title="downloadingId !== null ? t('control.downloading') : t('control.download')"
        @click="downloadCurrent"
      >
        <Loader2 v-if="downloadingId !== null" :size="15" class="dl-spin" />
        <Download v-else :size="15" />
      </button>

      <button
        v-if="!collapsed"
        class="btn"
        :class="{ on: state.zhVisible }"
        :title="t('control.toggleZh')"
        @click="toggleZh"
      >
        <Languages :size="15" />
        {{ t("control.zh") }}
      </button>

      <!-- 音量 -->
      <div v-if="!collapsed" class="vol-group">
        <button
          class="btn vol-btn"
          :title="state.muted || state.volume === 0 ? t('control.unmute') : t('control.mute')"
          @click="toggleMute"
        >
          <VolumeX v-if="state.muted || state.volume === 0" :size="15" />
          <Volume1 v-else-if="state.volume < 0.5" :size="15" />
          <Volume2 v-else :size="15" />
        </button>
        <input
          class="vol-slider"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="state.muted ? 0 : state.volume"
          :title="t('control.volume')"
          @input="onVolume"
        />
      </div>
    </div>

    <!-- 当前歌曲信息 -->
    <div v-if="!collapsed" class="song-line">
      <span v-if="state.currentSong" class="song-line-text">
        {{ state.currentSong.name }}
        <template v-if="state.currentSong.artist"> · {{ state.currentSong.artist }}</template>
        <span v-if="state.lyricFormat" class="fmt-badge">{{ state.lyricFormat }}</span>
      </span>
      <span v-else class="song-line-text dim">{{ t("control.noSong") }}</span>
      <button
        v-if="state.currentSong"
        class="song-edit-btn"
        :title="t('tags.editTitle')"
        data-testid="song-edit-btn"
        @click="tagEditorOpen = true"
      >
        <Pencil :size="12" />
      </button>
    </div>

    <!-- 歌曲信息编辑弹窗（标签刮削器） -->
    <TagEditorModal :open="tagEditorOpen" @close="tagEditorOpen = false" />

    <!-- 睡眠定时器倒计时（不显眼小字；移动端在 MobilePlayer 单独显示，这里隐藏避免重复） -->
    <div v-if="!isMobile && sleepTimerText" class="sleep-timer">{{ sleepTimerText }}</div>
    <!-- 播放 URL 弹窗（试听语义：临时播放，默认不计统计；支持电台流） -->
    <Teleport to="body">
      <div v-if="urlOpen" class="url-mask" @click.self="urlOpen = false">
        <div class="url-modal" role="dialog" aria-modal="true">
          <div class="url-title">
            <Link2 :size="15" />
            {{ t("control.playUrl") }}
          </div>
          <input
            v-model="urlInput"
            class="url-input"
            type="text"
            :placeholder="t('control.playUrlPlaceholder')"
            spellcheck="false"
            @keydown.enter="confirmUrl"
          />
          <div v-if="urlError" class="url-err">{{ urlError }}</div>
          <div class="url-actions">
            <button class="url-btn" @click="urlOpen = false">{{ t("common.cancel") }}</button>
            <button class="url-btn primary" @click="confirmUrl">
              {{ t("control.playUrlConfirm") }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Mic,
  ArrowLeft,
  Gauge,
  Link2,
  Repeat1,
  Repeat2,
  Repeat,
  Shuffle,
  Languages,
  Download,
  Loader2,
} from "@lucide/vue";
import { state, setVolume, toggleMute } from "../composables/usePlayer.js";
import { apiPost } from "../utils/apiClient.js";
import { sleepTimerText } from "../composables/useSleepTimer.js";
import { isMobile } from "../composables/useMobileViewport.js";
import TagEditorModal from "./TagEditorModal.vue";
import MiniSpectrum from "./MiniSpectrum.vue";
import {
  togglePlay,
  nextSong,
  prevSong,
  seek,
  prevLine,
  nextLine,
  cycleSpeed,
  toggleKaraokeLoop,
  enterAbLoop,
  exitAbLoop,
  toggleZh,
  cyclePlayMode,
  toggleControls,
  playUrl,
  isStreamSong,
  isPreviewSong,
  downloadSettings,
} from "../composables/usePlayer.js";
import { showToast, toastError } from "../composables/useToast.js";
import { ChevronDown, Volume1, Volume2, VolumeX } from "@lucide/vue";
import { Pencil } from "@lucide/vue";
import { ref } from "vue";

const props = defineProps({
  karaoke: { type: Boolean, default: false },
  // 全屏播放器等场景：不显示“收起控制区”按钮（移动端控制条始终展开）
  hideCollapse: { type: Boolean, default: false },
  // 移动端跟唱模式：控制区可下滑收起/上滑展开（桌面端不传，零影响）
  collapsible: { type: Boolean, default: false },
  // 受控收起态（由父级 MobilePlayer 统一管理，供顶部信息按钮联动）
  collapsed: { type: Boolean, default: false },
});

const emit = defineEmits(["update:collapsed"]);

const { t } = useI18n();

// ============ 移动端跟唱：控制区折叠（下滑收起 / 上滑展开） ============
// 收起态只保留：进度条 + 播放 + 倍速 + 跟唱 + 循环；
// 其余按钮 v-if="!collapsed" 隐藏；桌面端不传 collapsible，此逻辑完全不生效。
let touchStart: { x: number; y: number } | null = null; // 手势起点（仅在 collapsible 时记录）

function onTouchStart(e: TouchEvent) {
  if (!props.collapsible) return;
  const t0 = e.touches?.[0] || e.changedTouches?.[0];
  if (!t0) return;
  touchStart = { x: t0.clientX, y: t0.clientY };
}

function onTouchEnd(e: TouchEvent) {
  if (!props.collapsible || !touchStart) return;
  const t0 = e.changedTouches?.[0];
  if (!t0) {
    touchStart = null;
    return;
  }
  const dx = t0.clientX - touchStart.x;
  const dy = t0.clientY - touchStart.y;
  touchStart = null;
  // 位移不足 30px 视为点击；垂直主导（|dy| > |dx|*1.2）才判定为折叠手势，
  // 进度条/滑块的横向拖动天然免疫
  if (Math.abs(dy) < 30 || Math.abs(dy) <= Math.abs(dx) * 1.2) return;
  if (dy > 0)
    collapse(); // 下滑 → 收起
  else expand(); // 上滑 → 展开
}

function collapse() {
  emit("update:collapsed", true);
}

function expand() {
  emit("update:collapsed", false);
}

// 模式切换（音乐 ↔ 跟唱；顶栏 tab 已不提供跟唱入口，这里由按钮直达）
// 退出跟唱时清理 AB/单句循环：避免回到连播模式后歌词区残留 A/B 标注、句子循环播放
function switchMode(m: string) {
  if (m === "continuous") {
    exitAbLoop();
    if (state.karaokeLoop) state.karaokeLoop = false;
  }
  state.mode = m;
}

// 歌曲信息编辑弹窗开关（仅当前播放歌曲存在时入口按钮可见）
const tagEditorOpen = ref(false);

// ============ 下载当前网络歌（试听/曲库网络歌） ============
// 与 SearchAnything 同一链路：POST /api/online/download → 网易云取直链落盘到下载目录
// （设置 download.downloadDir，空 = 曲库），曲库 mtime 监听自动刷新。
// 当前歌是网络歌（type=stream / type=preview / type=url）时显示下载按钮；本地歌不显示。
const isNetworkCurrent = computed(
  () => isStreamSong(state.currentSong) || isPreviewSong(state.currentSong),
);
const downloadingId = ref<string | number | null>(null); // 下载中的 streamId（同一时刻只下一首）

async function downloadCurrent() {
  const song = state.currentSong;
  const id = song?.streamId;
  if (!song || !id || downloadingId.value !== null) return;
  downloadingId.value = id;
  try {
    const res = await apiPost("/api/online/download", {
      id,
      level: downloadSettings.defaultQuality,
      title: song.name,
      artist: song.artist || "",
    });
    if (!res.ok) {
      const data = (res.data || {}) as Record<string, unknown>;
      throw new Error(String(data.error || data.message || ""));
    }
    showToast(t("control.downloadSuccess", { title: song.name }));
  } catch (err) {
    toastError(t("control.downloadFailed", { msg: (err as Error).message || "" }));
  } finally {
    downloadingId.value = null;
  }
}

// ============ 播放 URL（试听语义；校验 http/https，非法提示不关闭弹窗） ============
const urlOpen = ref(false);
const urlInput = ref("");
const urlError = ref("");

async function confirmUrl() {
  const raw = urlInput.value.trim();
  if (!/^https?:\/\//i.test(raw)) {
    urlError.value = t("control.playUrlInvalid");
    return;
  }
  urlOpen.value = false;
  urlInput.value = "";
  urlError.value = "";
  await playUrl(raw);
}

function onSeek(e: Event) {
  seek(parseFloat((e.target as HTMLInputElement).value));
}

function onVolume(e: Event) {
  setVolume(parseFloat((e.target as HTMLInputElement).value));
}

// 循环按钮：单击切换单句循环 / 退出 AB；长按 500ms 进入 AB 循环
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressFired = false;

const loopTitle = computed(() => {
  const ab = state.abLoop;
  if (ab) {
    return ab.b === null
      ? t("karaoke.abWaitEnd", { n: ab.a + 1 })
      : t("karaoke.abSet", { a: ab.a + 1, b: ab.b + 1 });
  }
  return t("karaoke.abHint");
});

// 连播播放模式：三态循环切换（列表循环 → 随机 → 单曲循环）
const playModeTitle = computed(() => {
  if (state.playMode === "shuffle") return t("control.modeShuffle");
  if (state.playMode === "repeatOne") return t("control.modeRepeatOne");
  return t("control.modeOrder");
});

function onLoopPressStart() {
  if (!state.karaokeOn) return;
  longPressFired = false;
  pressTimer = setTimeout(() => {
    longPressFired = true;
    enterAbLoop();
  }, 500);
}

function onLoopPressEnd() {
  if (pressTimer) clearTimeout(pressTimer);
}

function onLoopClick() {
  if (longPressFired) {
    // 长按已触发 AB 循环，吞掉本次 click
    longPressFired = false;
    return;
  }
  if (state.abLoop) {
    exitAbLoop(); // AB 循环中：单击退出
  } else {
    toggleKaraokeLoop(); // 单句循环开关
  }
}

function fmt(t: number) {
  if (!t || isNaN(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}
</script>

<style scoped>
.controls {
  position: relative;
  background: var(--card);
  border-radius: 16px;
  border: 1px solid var(--border);
  padding: 30px 20px 12px; /* 顶部留白容纳居中收起按钮 */
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.collapse-btn {
  position: absolute;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  width: 26px;
  height: 22px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  opacity: 0.55;
  transition: all 0.15s;
}
.collapse-btn:hover {
  opacity: 1;
  color: var(--text);
  background: var(--border);
}
.progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.mini-spectrum-slot {
  margin-right: 2px; /* 与时间戳轻微拉开，频谱不贴死 */
}
.time {
  font-size: 12px;
  color: var(--text2);
  font-variant-numeric: tabular-nums;
  min-width: 38px;
  text-align: center;
}
.progress {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 5px;
  border-radius: 3px;
  background: var(--border);
  outline: none;
  cursor: pointer;
}
.progress::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow: 0 2px 6px var(--accent-glow);
}
.progress-empty {
  cursor: default;
}
.btn-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}
.btn {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--card2);
  color: var(--text);
  font-size: 14px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition: all 0.15s;
  white-space: nowrap;
}
.btn:hover {
  background: var(--border);
}
.btn:active {
  transform: scale(0.94);
}
.btn.play {
  width: 56px;
  height: 56px;
  font-size: 22px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 4px 14px var(--accent-glow2);
}
.btn.on {
  background: color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--accent-ink);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}
/* 带文字的按钮（变速/跟唱/译） */
.btn:has(span),
.btn:not(:has(> span)):not(.play) {
  padding: 0 16px;
}
.btn-row .btn {
  width: auto;
  min-width: 44px;
  padding: 0 14px;
  font-size: 13.5px;
}
.btn-row .btn.play {
  width: 56px;
  font-size: 22px;
  padding: 0;
}
.btn.busy {
  color: var(--accent);
}
.dl-spin {
  animation: dl-spin 0.9s linear infinite;
}
@keyframes dl-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.vol-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: 6px;
  padding-left: 14px;
  border-left: 1px solid var(--border);
}
.vol-btn {
  min-width: 36px !important;
  padding: 0 10px !important;
}
.vol-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 80px;
  height: 5px;
  border-radius: 3px;
  background: var(--border);
  outline: none;
  cursor: pointer;
}
.vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow: 0 2px 6px var(--accent-glow);
}
.btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}
.song-line {
  text-align: center;
  font-size: 12.5px;
  color: var(--text2);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.song-line-text.dim {
  color: var(--text3);
}
/* 歌曲信息编辑按钮（仅在播放歌曲时显示；迷你窗/移动端迷你条不渲染 ControlBar 故天然无此按钮） */
.song-edit-btn {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
  transition: all 0.15s;
}
@media (hover: hover) {
  .song-edit-btn:hover {
    color: var(--text);
    background: var(--border);
  }
}
/* 移动端：增大触摸目标 */
@media (max-width: 1023.98px) {
  .song-edit-btn {
    width: 30px;
    height: 30px;
  }
}
/* 睡眠定时器倒计时：不显眼小字 */
.sleep-timer {
  text-align: center;
  font-size: 11px;
  color: var(--text3);
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}
/* 播放 URL 弹窗 */
.url-mask {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  padding: 16px;
}
.url-modal {
  width: 380px;
  max-width: 100%;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 24px 72px var(--shadow-strong);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.url-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.url-input {
  width: 100%;
  height: 38px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text);
  font-size: 13.5px;
  outline: none;
  transition: border-color 0.15s;
}
.url-input:focus {
  border-color: var(--accent);
}
.url-input::placeholder {
  color: var(--text3);
}
.url-err {
  font-size: 12px;
  color: #ff6b6b;
}
.url-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.url-btn {
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
}
@media (hover: hover) {
  .url-btn:hover {
    color: var(--text);
    border-color: var(--accent);
  }
}
.url-btn.primary {
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border-color: transparent;
}
.fmt-badge {
  display: inline-block;
  margin-left: 8px;
  margin-right: 8px; /* 与编辑按钮拉开间距（.song-line 的 flex gap 8px 之上再加 8px，总 16px），避免徽标与铅笔按钮视觉粘连 */
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--card2);
  color: var(--text2);
  font-size: 10.5px;
  text-transform: uppercase;
  vertical-align: 1px;
}
/* ---------- 移动端跟唱折叠态 ---------- */
/* 收起时更紧凑：30px 顶部留白是桌面 collapse-btn 用的，移动端隐藏了该按钮 */
.controls.collapsible.collapsed {
  padding-top: 10px;
}
/* 收起态按钮排序：倍速 | 播放 跟唱 | 单句 · 编辑 信息（flex order，仅收起态生效） */
.controls.collapsed .ctrl-speed {
  order: 1;
}
.controls.collapsed .ctrl-play {
  order: 2;
}
.controls.collapsed .ctrl-mic {
  order: 3;
}
.controls.collapsed .ctrl-loop {
  order: 4;
}
</style>
