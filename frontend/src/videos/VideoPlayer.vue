<template>
  <div class="video-player">
    <!-- 页头：返回 + 标题 + 字幕状态 -->
    <header class="vp-head">
      <button class="vp-back" :title="t('videos.back')" @click="$emit('close')">
        <ChevronLeft :size="18" />
      </button>
      <span v-if="isOnlineVideo(video)" class="vp-provider">{{ video.provider }}</span>
      <span class="vp-title" :title="displayName">{{ displayName }}</span>
      <span v-if="isOnlineVideo(video)" class="vp-sub-count" :class="{ dim: !subtitles.length }">
        {{ video.subtitles?.[0]?.name || t("videos.subEmpty") }}
      </span>
      <span v-else-if="subtitles.length" class="vp-sub-count">
        {{ t("videos.subCount", { n: subtitles.length }) }}
      </span>
      <span v-else class="vp-sub-count dim">{{ t("videos.subEmpty") }}</span>
    </header>

    <!-- 视频区：<video> + 当前句浮层字幕（原文 + 翻译，翻译有值才显示） -->
    <div class="vp-stage">
      <video
        ref="videoEl"
        class="vp-video"
        :src="src"
        controls
        playsinline
        @timeupdate="onTimeupdate"
        @loadedmetadata="onLoadedMeta"
        @seeking="onSeeking"
        @play="isPlaying = true"
        @pause="isPlaying = false"
        @ended="isPlaying = false"
      />
      <div v-if="currentCue" class="vp-overlay-sub">
        <div class="vp-overlay-text">{{ currentCue.text }}</div>
        <div v-if="currentCue.translation" class="vp-overlay-trans">
          {{ currentCue.translation }}
        </div>
      </div>
    </div>

    <!-- 跟唱控制条（交互对齐 karaoke ControlBar：单击单句循环 / 长按 AB 区间 / 变速 / 跟读开关） -->
    <div class="vp-controls">
      <button class="vc-btn" :title="t('videos.prevLine')" @click="prevLine()">
        <StepBack :size="17" />
      </button>
      <button class="vc-btn vc-play" :title="t('videos.playPause')" @click="togglePlay">
        <Pause v-if="isPlaying" :size="21" />
        <Play v-else :size="21" />
      </button>
      <button class="vc-btn" :title="t('videos.nextLine')" @click="nextLine()">
        <StepForward :size="17" />
      </button>
      <button
        class="vc-btn"
        :class="{ on: speed !== 1 }"
        :title="t('videos.speed')"
        @click="cycleSpeed"
      >
        <Gauge :size="15" />
        {{ speed }}x
      </button>
      <button
        class="vc-btn"
        :class="{ on: karaokeOn }"
        :title="t('videos.karaokeToggle')"
        @click="karaokeOn = !karaokeOn"
      >
        <Mic :size="15" />
        {{ t("videos.karaoke") }}
      </button>
      <button
        class="vc-btn"
        :class="{ on: abLoop || singleLoop }"
        :disabled="!karaokeOn || !subtitles.length"
        :title="loopTitle"
        @pointerdown="onLoopPressStart"
        @pointerup="onLoopPressEnd"
        @pointerleave="onLoopPressEnd"
        @click="onLoopClick"
      >
        <Repeat2 v-if="abLoop" :size="15" />
        <Repeat1 v-else :size="15" />
        {{ abLoop ? "AB" : t("videos.singleLine") }}
      </button>
      <span class="vc-time">{{ fmt(currentTime) }} / {{ fmt(duration) }}</span>
    </div>

    <!-- 字幕列表（仿 karaoke 歌词行：逐句渲染 / 当前句高亮 / 点击跳转；双字幕：原文 + 翻译） -->
    <div ref="subScrollEl" class="vp-subs">
      <div v-if="!subtitles.length" class="vp-sub-empty">
        <Captions :size="40" />
        <span>{{ t("videos.subEmpty") }}</span>
      </div>
      <div
        v-for="(cue, i) in subtitles"
        :key="i"
        class="vline"
        :class="vlineClass(i)"
        @click="onLineClick(i)"
      >
        <span class="vline-time">{{ fmt(cue.start) }}</span>
        <div class="vline-body">
          <div class="vline-text">{{ cue.text }}</div>
          <div v-if="cue.translation" class="vline-trans">{{ cue.translation }}</div>
        </div>
        <span v-if="abBadge(i)" class="vline-badge">{{ abBadge(i) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Play,
  Pause,
  StepBack,
  StepForward,
  Mic,
  Gauge,
  Repeat1,
  Repeat2,
  ChevronLeft,
  Captions,
} from "@lucide/vue";
import type { SubtitleCue, VideoSource } from "./types";
import {
  fetchSubtitles,
  fetchOnlineSubtitles,
  streamUrl,
  onlineStreamUrl,
  isLibraryVideo,
  isOnlineVideo,
} from "./api";
import { toastError } from "../composables/useToast.js";

const props = defineProps<{ video: VideoSource }>();
defineEmits<{ close: [] }>();
const { t } = useI18n();

const videoEl = ref<HTMLVideoElement | null>(null);
const subScrollEl = ref<HTMLElement | null>(null);

// ============ 播放状态（video 事件驱动） ============
const currentTime = ref(0);
const duration = ref(0);
const isPlaying = ref(false);

// 播放地址：库内视频走后端流接口；在线视频走防盗链代理（原始页链接，缓冲外 seek 时带 t= 重建起点）；本地加载直接用 object URL
// streamT：在线视频缓冲外 seek 的重建起点（秒）。置位后 src 变为带 t= 的合成流地址，浏览器重新加载；
// 之后保持该值（当前流就是从 t 秒开始的），直到再次重建或组件卸载（父层按视频 key 重挂载，不会跨视频泄漏）。
const streamT = ref<number | null>(null);
const src = computed(() => {
  const v = props.video;
  if (isLibraryVideo(v)) return streamUrl(v.path);
  if (isOnlineVideo(v)) return onlineStreamUrl(v.url, streamT.value ?? undefined);
  return v.localUrl;
});

// 标题：在线视频用 title，本地/库内用 name
const displayName = computed(() => {
  const v = props.video;
  return isOnlineVideo(v) ? v.title || t("videos.untitled") : v.name;
});

// ============ 字幕 ============
const subtitles = ref<SubtitleCue[]>([]);
// 当前高亮句（最后一条已开始的字幕；句间间隙保持上一句）
const highlightIdx = ref(-1);
// 跟唱锚点句（正在唱/刚停下的句；句末判定与循环逻辑用，非响应式依赖）
const anchorLine = ref(-1);

// 当前句浮层字幕（视频下方叠加显示，双字幕随 translation 有无）
const currentCue = computed(() =>
  highlightIdx.value >= 0 ? subtitles.value[highlightIdx.value] : null,
);

function locateLineAt(t: number): number {
  const lines = subtitles.value;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].start) idx = i;
    else break;
  }
  return idx;
}

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "--:--";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ============ 跟唱交互（对齐 karaoke：跟读暂停 / 变速 / 单句循环 / AB 区间） ============
const SPEEDS = [0.75, 1.0, 1.25];
const karaokeOn = ref(true); // 跟读暂停：每句播完自动停
const singleLoop = ref(false); // 单句循环
const abLoop = ref<{ a: number; b: number | null } | null>(null); // AB 区间：b=null 等选终点
const speed = ref(1.0);

function cycleSpeed() {
  const i = SPEEDS.indexOf(speed.value);
  speed.value = SPEEDS[(i + 1) % SPEEDS.length];
  if (videoEl.value) videoEl.value.playbackRate = speed.value;
}

// 跳到某句句首；pauseAfter=true 时暂停（跟读句末语义）。
// 统一走 seekVideo：缓冲内原生 set currentTime，缓冲外（在线合成流）换源重建。
function seekToLine(i: number, pauseAfter = false) {
  const lines = subtitles.value;
  const v = videoEl.value;
  if (i < 0 || i >= lines.length || !v) return;
  anchorLine.value = i;
  seekVideo(Math.max(0, lines[i].start), pauseAfter ? "pause" : "auto");
}

// 点击字幕行：无 AB → 播放该句；等选终点 → 设为终点；区间内 → 跳转播放；
// 区间外 → 退出 AB 并播放（与 karaoke clickLine 一致）
function onLineClick(i: number) {
  const lines = subtitles.value;
  if (i < 0 || i >= lines.length) return;
  const ab = abLoop.value;
  if (!ab) {
    playAt(i);
    return;
  }
  if (ab.b === null) {
    setAbEnd(i);
    return;
  }
  if (i < ab.a || i > ab.b) {
    abLoop.value = null;
    playAt(i);
    return;
  }
  playAt(i);
}

function playAt(i: number) {
  const lines = subtitles.value;
  const v = videoEl.value;
  if (i < 0 || i >= lines.length || !v) return;
  anchorLine.value = i;
  seekVideo(Math.max(0, lines[i].start), "play"); // 保持原语义：跳转后播放（缓冲外走重建 + 续播）
}

// 上一句 / 下一句（对齐 karaoke prevLine/nextLine）
function currentLine() {
  return anchorLine.value >= 0 ? anchorLine.value : highlightIdx.value;
}
function prevLine() {
  const cur = currentLine();
  if (cur > 0) playAt(cur - 1);
}
function nextLine() {
  const lines = subtitles.value;
  const cur = currentLine();
  if (cur >= 0 && cur < lines.length - 1) playAt(cur + 1);
}

// 循环按钮：单击切换单句循环 / 退出 AB；长按 500ms 进入 AB（对齐 ControlBar 交互）
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressFired = false;

const loopTitle = computed(() => {
  const ab = abLoop.value;
  if (ab) {
    return ab.b === null
      ? t("videos.abWaitEnd", { n: ab.a + 1 })
      : t("videos.abSet", { a: ab.a + 1, b: ab.b + 1 });
  }
  return t("videos.abHint");
});

function onLoopPressStart() {
  if (!karaokeOn.value || !subtitles.value.length) return;
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
    longPressFired = false;
    return;
  }
  if (abLoop.value) {
    abLoop.value = null; // AB 循环中：单击退出
  } else {
    singleLoop.value = !singleLoop.value; // 单句循环开关
  }
}

// 进入 AB：当前句为起点，等待点终点（无当前句忽略）
function enterAbLoop() {
  if (abLoop.value) return;
  const cur = currentLine();
  if (cur < 0) return;
  abLoop.value = { a: cur, b: null };
}

// 选终点：终点在起点前自动交换（对齐 karaoke setAbEnd）
function setAbEnd(i: number) {
  const ab = abLoop.value;
  const lines = subtitles.value;
  if (!ab || i < 0 || i >= lines.length || i === ab.a) return;
  let a = ab.a;
  let b = i;
  if (b < a) [a, b] = [b, a];
  abLoop.value = { a, b };
}

// AB 区间视觉（对齐 karaoke klineClass：区间内绿标，端点 A/B）
function vlineClass(i: number) {
  const cls: Record<string, boolean> = { active: i === highlightIdx.value };
  const ab = abLoop.value;
  if (ab && ab.b !== null && i >= ab.a && i <= ab.b) {
    cls["ab-in"] = true;
    if (i === ab.a) cls["ab-start"] = true;
    if (i === ab.b) cls["ab-end"] = true;
  }
  return cls;
}

// AB 端点徽标：起点 A / 终点 B（区间确定后显示；对齐 karaoke abBadge）
function abBadge(i: number) {
  const ab = abLoop.value;
  if (!ab || ab.b === null) return "";
  if (i === ab.a) return "A";
  if (i === ab.b) return "B";
  return "";
}

// ============ 句末处理（对齐 karaoke handleKaraokeTick） ============
// 跟读开：句末回句首暂停（可反复练一句）；单句循环：句末回句首续播；
// AB 区间：A→B 连播，B 播完跳回 A；等选终点（b=null）：起点句循环
function onTimeupdate() {
  const v = videoEl.value;
  if (!v) return;
  const t = v.currentTime;
  currentTime.value = t;
  highlightIdx.value = locateLineAt(t);
  if (!karaokeOn.value || !subtitles.value.length) return;
  const lines = subtitles.value;
  // 锚点失效（间隙/seek 回退）→ 重新定位
  if (anchorLine.value < 0 || t < lines[anchorLine.value].start) {
    anchorLine.value = locateLineAt(t);
  }
  if (anchorLine.value < 0 || t < lines[anchorLine.value].end) return;
  // 一次跳变可能跨多个短句：逐句推进直到落在句内或触发循环/暂停（guard 防死循环）
  let li = anchorLine.value;
  let guard = 0;
  while (li >= 0 && t >= lines[li].end && guard++ < 20) {
    // 坏句（end <= start）：无法锚定暂停，跳过推进
    if (lines[li].end <= lines[li].start) {
      li += 1;
      continue;
    }
    const ab = abLoop.value;
    if (ab && li >= ab.a) {
      if (ab.b !== null && li === ab.b) {
        seekToLine(ab.a, false); // B 播完 → 跳回 A 续播
        return;
      }
      if (ab.b === null || li < ab.b) {
        if (ab.b === null) {
          seekToLine(ab.a, false); // 等选终点：起点句循环
          return;
        }
        li += 1; // 区间中间句播完 → 锚点推进下一句
        continue;
      }
      // seek 跳出区间到终点之后：按单句循环/暂停处理
    }
    if (singleLoop.value) {
      seekToLine(li, false); // 单句循环：回句首续播
    } else {
      seekToLine(li, true); // 句末回句首暂停，方便反复跟读
    }
    return;
  }
  anchorLine.value = li; // AB 区间内正常推进后落位
}

// ============ 基础播放控制 ============
function togglePlay() {
  const v = videoEl.value;
  if (!v) return;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}

// ============ seek 统一入口（B站合成流 seek 重建，C1 方案） ============
// 在线视频（B站 DASH 合成流）不支持原生 Range seek：目标超出当前缓冲只能换源重建。
// 库内/本地视频后端支持 Range，始终原生 seek，不重建。
const suppressSeek = ref(false); // 程序内设 currentTime 置位，@seeking 消费后复位（防重建死循环）
let pendingSeek: number | null = null; // 重建后待恢复的进度（loadedmetadata 后落位）
let resumeAfterRebuild = false; // 重建后是否续播（重建前在播 / 显式要求播放）

/** 目标时间是否落在 <video> 已缓冲范围内（合成流缓冲外无法原生 seek） */
function isBuffered(t: number): boolean {
  const v = videoEl.value;
  if (!v || !v.buffered || v.buffered.length === 0) return false;
  for (let i = 0; i < v.buffered.length; i++) {
    if (t >= v.buffered.start(i) && t <= v.buffered.end(i)) return true;
  }
  return false;
}

/** 程序内设 currentTime（置 suppressSeek 防 @seeking 再入；兜底宏任务复位防陈旧标志吞掉后续用户拖动） */
function setCurrentTime(t: number) {
  const v = videoEl.value;
  if (!v) return;
  suppressSeek.value = true;
  v.currentTime = t;
  setTimeout(() => {
    suppressSeek.value = false;
  }, 0);
}

/**
 * 统一 seek 入口：字幕句跳转（playAt/seekToLine）与原生进度条拖动（@seeking）都走这里。
 * 目标在缓冲内 → 原生 currentTime（丝滑不重建）；
 * 缓冲外（仅在线视频）→ 重建流：换 src 带 t=<目标秒>，loadedmetadata 后恢复进度与播放状态。
 * intent：'auto' 跟随原播放状态 / 'play' 跳转后播放 / 'pause' 跳转后暂停。
 */
function seekVideo(t: number, intent: "auto" | "play" | "pause" = "auto") {
  const v = videoEl.value;
  if (!v) return;
  const target = Math.max(0, t);
  if (isOnlineVideo(props.video) && !isBuffered(target)) {
    rebuildStream(target, intent);
    return;
  }
  setCurrentTime(target);
  if (intent === "play") v.play().catch(() => {});
  else if (intent === "pause") v.pause();
}

/** 缓冲外 seek → 重建流：src 换成带 t= 的合成流地址，等 loadedmetadata 后恢复进度 */
function rebuildStream(t: number, intent: "auto" | "play" | "pause") {
  const v = props.video;
  if (!isOnlineVideo(v)) return;
  const el = videoEl.value;
  const wasPlaying = el ? !el.paused : false;
  pendingSeek = Math.floor(t);
  // 重建后是否续播：显式 play 一定续播；auto 跟随重建前状态；pause 不续播（跟读句末暂停语义）
  resumeAfterRebuild = intent === "play" || (intent === "auto" && wasPlaying);
  streamT.value = pendingSeek; // src 变化 → 浏览器从目标时间重新加载合成流
}

/** 用户拖原生进度条：目标超出缓冲 → 走统一重建（程序内 seek 被 suppressSeek 吞掉，不重复处理） */
function onSeeking() {
  const v = videoEl.value;
  if (!v) return;
  if (suppressSeek.value) {
    suppressSeek.value = false;
    return;
  }
  seekVideo(v.currentTime);
}

function onLoadedMeta() {
  const el = videoEl.value;
  if (!el) return;
  // 合成流浏览器可能拿不到 duration（fMP4 分片，0/NaN/Infinity）：resolve 返回的 v.duration 兜底
  const metaDur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
  const resolveDur = isOnlineVideo(props.video) ? props.video.duration || 0 : 0;
  duration.value = resolveDur || metaDur || 0;
  if (Number.isFinite(el.playbackRate)) speed.value = el.playbackRate;
  // 重建流加载完成：恢复进度（置 suppressSeek 防 seeking 再入）+ 按需续播
  if (pendingSeek !== null) {
    const target = pendingSeek;
    pendingSeek = null;
    setCurrentTime(target);
    if (resumeAfterRebuild) {
      resumeAfterRebuild = false;
      el.play().catch(() => {});
    }
  }
}

// 当前句变化 → 列表滚动跟随（nearest 不抢用户滚动）
watch(highlightIdx, async () => {
  if (highlightIdx.value < 0) return;
  await nextTick();
  const el = subScrollEl.value?.querySelector(".vline.active");
  el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
});

// 本地加载视频：object URL 卸载时释放
onUnmounted(() => {
  if (pressTimer) clearTimeout(pressTimer);
  const v = props.video;
  if ("localUrl" in v) URL.revokeObjectURL(v.localUrl);
});

// 字幕加载：库内视频拉同名字幕；在线视频拉 resolve 返回的第一个可用字幕 lang（无则纯播放）；
// 本地加载无字幕，纯播放
onMounted(async () => {
  const v = props.video;
  if (isLibraryVideo(v)) {
    try {
      subtitles.value = await fetchSubtitles(v.path);
    } catch {
      toastError(t("videos.subLoadError"));
    }
    return;
  }
  if (isOnlineVideo(v)) {
    // 无可选字幕（resolve 未返回字幕信息）→ 不请求字幕接口，纯播放
    const lang = v.subtitles?.[0]?.lang;
    if (!lang) return;
    try {
      subtitles.value = await fetchOnlineSubtitles(v.url, lang);
    } catch {
      toastError(t("videos.subLoadError"));
    }
  }
});
</script>

<style scoped>
.video-player {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--card);
  border-radius: 16px;
  border: 1px solid var(--border);
}
.vp-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.vp-back {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text2);
  transition: all 0.15s;
  flex-shrink: 0;
}
.vp-back:hover {
  color: var(--text);
  background: var(--border);
}
.vp-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 在线视频 provider 徽标（bilibili / youtube 等） */
.vp-provider {
  flex-shrink: 0;
  padding: 2px 9px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 700;
}
.vp-sub-count {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-text);
  font-variant-numeric: tabular-nums;
}
.vp-sub-count.dim {
  color: var(--text3);
}
.vp-stage {
  position: relative;
  flex-shrink: 0;
  background: #000;
  aspect-ratio: 16 / 9;
  max-height: 46%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.vp-video {
  width: 100%;
  height: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}
/* 当前句浮层字幕：视频底部叠加（原文 + 可选翻译） */
.vp-overlay-sub {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 8%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 16px;
  pointer-events: none;
  text-align: center;
}
.vp-overlay-text {
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  text-shadow:
    0 2px 8px rgba(0, 0, 0, 0.9),
    0 0 2px rgba(0, 0, 0, 0.9);
  line-height: 1.4;
}
.vp-overlay-trans {
  font-size: 15px;
  color: #ffe9d6;
  text-shadow:
    0 2px 8px rgba(0, 0, 0, 0.9),
    0 0 2px rgba(0, 0, 0, 0.9);
  line-height: 1.4;
}
/* 跟唱控制条 */
.vp-controls {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.vc-btn {
  height: 34px;
  min-width: 34px;
  padding: 0 10px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  background: var(--card2);
  color: var(--text2);
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.15s;
  flex-shrink: 0;
}
.vc-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--border);
}
.vc-btn.on {
  color: var(--accent-text);
  background: var(--accent-soft);
}
.vc-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.vc-play {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 4px 12px var(--accent-glow);
}
.vc-play:hover:not(:disabled) {
  color: #fff;
  filter: brightness(1.08);
}
.vc-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--text3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
/* 字幕列表（仿 karaoke 歌词行） */
.vp-subs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 24px;
}
.vline {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  border-left: 3px solid transparent;
  cursor: pointer;
  transition: all 0.2s;
}
.vline:hover {
  background: var(--card2);
}
.vline-time {
  width: 52px;
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--text3);
  font-variant-numeric: tabular-nums;
  margin-top: 4px;
  transition: color 0.2s;
}
.vline-body {
  flex: 1;
  min-width: 0;
}
.vline-text {
  font-size: 14.5px;
  color: var(--text2);
  line-height: 1.55;
  transition: all 0.2s;
}
.vline-trans {
  font-size: 13px;
  color: var(--text3);
  margin-top: 2px;
  line-height: 1.45;
  opacity: 0.8;
  transition: all 0.2s;
}
/* 当前句：放大加粗、主题色（对齐 karaoke active） */
.vline.active {
  border-left-color: var(--accent);
  background: var(--accent-soft);
}
.vline.active .vline-time {
  color: var(--accent-text);
}
.vline.active .vline-text {
  font-size: 16px;
  font-weight: 700;
  color: var(--accent-text);
}
.vline.active .vline-trans {
  color: var(--text2);
  opacity: 1;
}
/* AB 区间：细绿竖条（对齐 karaoke ab-in） */
.vline.ab-in:not(.active) {
  border-left-color: var(--green-border);
}
.vline.ab-in:not(.active) .vline-time {
  color: var(--green);
}
/* AB 端点：A/B 徽标 */
.vline-badge {
  flex-shrink: 0;
  margin-top: 3px;
  padding: 1px 7px;
  border-radius: 8px;
  font-size: 10.5px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--green-grad1), var(--green));
  color: #fff;
}
.vp-sub-empty {
  height: 100%;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text3);
  font-size: 13.5px;
}
</style>
