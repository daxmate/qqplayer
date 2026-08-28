<template>
  <div class="karaoke-panel">
    <div v-if="!headless" class="kp-head">
      <button
        v-if="expandBtn"
        class="kp-expand"
        :title="t('karaoke.expandLib')"
        @click="expandPanels()"
      >
        <PanelLeftOpen :size="14" />
      </button>
      <span class="kp-title">
        <Mic :size="13" />
        {{ t("karaoke.title") }}
      </span>
      <span v-if="uiSettings.showSongInfo && state.currentSong" class="kp-song" :title="songTitle">
        {{ songTitle }}
      </span>
      <span class="kp-hint">{{ abHint }}</span>
      <button class="kp-spec-btn" :title="t('spec.title')" @click="openLyricSpec()">
        <FileMusic :size="14" />
      </button>
      <!-- 移动端跟唱：顶部信息按钮常驻（控制区收起时提示展开，展开时提示可收起） -->
      <template v-if="showInfoBtn">
        <button class="kp-info-btn" :title="infoBtnTitle" @click="tipOpen = !tipOpen">
          <Info :size="14" />
        </button>
        <Transition name="ctrl-tip">
          <div v-if="tipOpen" class="kp-tip" @click="onTipClick()">
            {{ controlsCollapsed ? t("control.expandTip") : t("control.collapseTip") }}
          </div>
        </Transition>
      </template>
    </div>
    <!-- AB 区间进度：区间确定后显示当前句在区间内的位置（abVisual 开关控制） -->
    <div v-if="abProgress" class="ab-progress">
      <div class="ab-progress-track">
        <i class="ab-progress-fill" :style="{ width: abProgress.pct + '%' }"></i>
      </div>
      <span v-if="abProgress.inside" class="ab-progress-label">{{
        t("karaoke.abProgress", { pos: abProgress.pos, total: abProgress.total })
      }}</span>
    </div>
    <div
      ref="scrollEl"
      class="kp-scroll"
      :class="{ 'no-mask': !lyricSettings.fadeMask, 'native-mode': karaokeEngine === 'native' }"
      :style="scrollStyle"
    >
      <div ref="trackEl" class="kp-track">
        <!-- 顶部占位（高度 JS 设为视口一半）：让第一句能滚到垂直居中 -->
        <div class="kp-spacer" aria-hidden="true"></div>
        <template v-for="(item, i) in lyric" :key="i">
          <div v-if="item.type === 'sec' && lyricSettings.showSec" class="sec">
            <Music2 :size="12" />
            {{ item.name }}
          </div>
          <div
            v-else-if="item.type === 'line'"
            class="kline"
            :class="klineClass(i)"
            @click="playLineAt(i)"
          >
            <span
              v-if="(!headless && uiSettings.karaokeShowNum) || abBadge(i)"
              class="kline-num"
              :class="{ 'ab-badge': abBadge(i) }"
              >{{ abBadge(i) || lineNumber(i) }}</span
            >
            <div class="kline-body" :style="{ textAlign: lyricSettings.align }">
              <div class="kline-jp">{{ item.text[0] || "…" }}</div>
              <div v-if="item.text[1] && lyricSettings.showRoma" class="kline-roma">
                {{ item.text[1] }}
              </div>
              <div v-if="item.text[2] && lyricSettings.showZh && state.zhVisible" class="kline-zh">
                {{ item.text[2] }}
              </div>
            </div>
            <span v-if="uiSettings.karaokeShowTime" class="kline-time"
              >{{ fmt(item.s) }} – {{ fmt(item.e) }}</span
            >
          </div>
        </template>
        <div v-if="!lyric.length" class="kp-empty">
          <div class="kp-empty-icon">
            <Mic :size="44" />
          </div>
          <div>{{ t("karaoke.emptyTitle") }}</div>
          <div class="kp-empty-sub">{{ t("karaoke.emptySub") }}</div>
          <button class="kp-empty-btn" @click="openLyricSpec()">
            <FileMusic :size="14" />
            {{ t("spec.title") }}
          </button>
        </div>
        <!-- 底部占位（高度 JS 设为视口一半）：让最后一句能滚到垂直居中 -->
        <div class="kp-spacer" aria-hidden="true"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick } from "vue";
import type { PropType } from "vue";
import { useI18n } from "vue-i18n";
import { Mic, Music2, PanelLeftOpen, FileMusic, Info } from "@lucide/vue";
import {
  state,
  clickLine,
  lyricSettings,
  uiSettings,
  playbackSettings,
  toggleMusicLib,
  openLyricSpec,
  LYRIC_SCHEMES,
} from "../composables/usePlayer.js";
import { useLyricScroll } from "../composables/useLyricScroll.js";
import type { LyricLine } from "../composables/playerState.js";

const { t } = useI18n();

const props = defineProps({
  lyric: { type: Array as PropType<LyricLine[]>, default: () => [] },
  current: { type: Number, default: -1 },
  expandBtn: { type: Boolean, default: false }, // 面板全关时显示展开按钮（跟唱模式无悬浮按钮区）
  // 纯歌词展示模式（移动端音乐模式）：隐藏面板头（逐句练习标题/AB 提示/歌词库入口），
  // 只留滚动歌词区；无歌词时 kp-empty 仍自带歌词库入口，不丢能力
  headless: { type: Boolean, default: false },
  // 字号缩放（全歌词界面用）：默认 1 不影响现有使用方，>1 时按比例放大 --fs-active
  fontScale: { type: Number, default: 1 },
  // 移动端跟唱：顶部信息按钮常驻（控制区收起时提示上滑展开，展开时提示下滑可收起）
  showInfoBtn: { type: Boolean, default: false },
  // 底部控制区当前收起态（决定气泡文案与点击行为）
  controlsCollapsed: { type: Boolean, default: false },
});

const emit = defineEmits(["expand-controls", "collapse-controls"]);

// 信息按钮气泡：收起态 → 提示展开（点气泡展开）；展开态 → 提示收起（点气泡收起）
const tipOpen = ref(false);
const infoBtnTitle = computed(() =>
  props.controlsCollapsed ? t("control.expandHint") : t("control.collapseHint"),
);
function onTipClick() {
  tipOpen.value = false;
  emit(props.controlsCollapsed ? "expand-controls" : "collapse-controls");
}

function expandPanels() {
  toggleMusicLib();
}

const scrollEl = ref<HTMLElement | null>(null);
const trackEl = ref<HTMLElement | null>(null);
const lineIndexMap = ref<number[]>([]); // lyric 数组索引 -> 行号（只计 line）
let lastCurrent = -1;

// 跟唱面板不支持 amll（自定义 AB 循环/行号/时间 UI）：amll 时回退弹簧引擎
const karaokeEngine = computed(() =>
  lyricSettings.engine === "amll" ? "spring" : lyricSettings.engine,
);
const springActive = computed(() => karaokeEngine.value === "spring");

// transform 平移滚动（弹簧引擎；滚轮手动接管，动画被用户滚动打断时自动让位）
const { scrollTo } = useLyricScroll(scrollEl, trackEl, {
  getFocusPos: () => lyricSettings.focusPos,
  enabled: springActive,
});

const FONTS = {
  system: "",
  serif: '"Songti SC", "SimSun", "Noto Serif SC", serif',
  rounded: '"Yuanti SC", "PingFang SC", "Noto Sans SC", sans-serif',
};

// 字号/字体/渐隐 → CSS 变量与内联样式（与连播 LyricPanel 一致）
const scrollStyle = computed(() => ({
  fontFamily: FONTS[lyricSettings.fontFamily as keyof typeof FONTS] || "",
  "--fs-active": Math.round(lyricSettings.fontSize * props.fontScale) + "px",
  // 配色：自定义颜色优先，否则配色方案色，否则主题强调色
  "--lyr-jp":
    lyricSettings.jpColor ||
    LYRIC_SCHEMES.find((s) => s.key === lyricSettings.colorScheme)?.jp ||
    "var(--accent-text)",
  "--lyr-zh":
    lyricSettings.zhColor ||
    LYRIC_SCHEMES.find((s) => s.key === lyricSettings.colorScheme)?.zh ||
    "var(--text2)",
}));

watch(
  () => props.lyric,
  (v: LyricLine[]) => {
    lineIndexMap.value = v.map((x, i) => (x.type === "line" ? i : -1)).filter((i) => i >= 0);
    lastCurrent = -1;
  },
  { immediate: true },
);

function lineNumber(lyricIdx: number) {
  return lineIndexMap.value.indexOf(lyricIdx) + 1;
}

// 当前歌曲信息（设置开关控制）
const songTitle = computed(() => {
  const s = state.currentSong;
  if (!s) return t("control.noSong");
  return s.artist ? `${s.name} · ${s.artist}` : s.name;
});

function fmt(t: number) {
  if (t == null || Number.isNaN(t)) return "--:--";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}

// ============ AB 循环：区间高亮 + 提示 ============
const abHint = computed(() => {
  const ab = state.abLoop;
  if (!ab) return t("karaoke.abHintIdle");
  if (ab.b === null) return t("karaoke.abHintWaitEnd", { n: ab.a + 1 });
  return t("karaoke.abHintSet", { a: ab.a + 1, b: ab.b + 1 });
});

function abLineNo(lyricIdx: number) {
  return lineIndexMap.value.indexOf(lyricIdx);
}

function klineClass(lyricIdx: number) {
  const cls: Record<string, boolean> = { active: lyricIdx === props.current };
  // 距离分级（与连播歌词一致的字体层级）
  const d = props.current < 0 ? 99 : Math.abs(lyricIdx - props.current);
  if (d === 1) cls.near = true;
  if (d >= 2) cls.far = true;
  const ab = state.abLoop;
  const n = abLineNo(lyricIdx);
  if (ab && ab.b !== null && n >= ab.a && n <= ab.b) {
    cls["ab-in"] = true;
    if (n === ab.a) cls["ab-start"] = true;
    if (n === ab.b) cls["ab-end"] = true;
  }
  return cls;
}

function abBadge(lyricIdx: number) {
  if (!playbackSettings.abVisual) return "";
  const ab = state.abLoop;
  const n = abLineNo(lyricIdx);
  if (!ab) return "";
  if (n === ab.a) return "A"; // 等选终点（b=null）时也标出起点
  if (ab.b !== null && n === ab.b) return "B";
  return "";
}

// AB 区间进度：b 确定后显示当前句在区间内的位置（第 pos/total 句）
// 当前句在区间外（如 seek 跳出区间但 AB 未退）→ 进度条归零、不显示标签
const abProgress = computed(() => {
  if (!playbackSettings.abVisual) return null;
  const ab = state.abLoop;
  if (!ab || ab.b === null) return null;
  const total = ab.b - ab.a + 1;
  const cur = abLineNo(props.current);
  const inside = cur >= ab.a && cur <= ab.b;
  const pos = inside ? cur - ab.a + 1 : 0;
  return { pos, total, inside, pct: inside ? (pos / total) * 100 : 0 };
});

function playLineAt(lyricIdx: number) {
  const lineNo = abLineNo(lyricIdx);
  if (lineNo < 0) return;
  clickLine(lineNo); // AB 循环中：区间外退出并播放；区间内跳转播放；等选终点时设为终点
}

watch(
  () => props.current,
  async (v) => {
    if (v < 0 || v === lastCurrent) return;
    lastCurrent = v;
    if (!lyricSettings.autoScroll) return; // 关闭自动跟随：只高亮不滚动
    await nextTick();
    if (karaokeEngine.value === "native") {
      // 原生引擎：scrollTo smooth
      const el = scrollEl.value;
      if (!el) return;
      const active = el.querySelector(".kline.active");
      if (active) {
        // 与连播歌词一致：停靠焦点位置（默认 1/3 高度）+ 平滑滚动
        const rect = active.getBoundingClientRect();
        const crect = el.getBoundingClientRect();
        const top =
          el.scrollTop +
          (rect.top - crect.top) -
          el.clientHeight * lyricSettings.focusPos +
          rect.height / 2;
        el.scrollTo({ top, behavior: "smooth" });
      }
      return;
    }
    const active = scrollEl.value?.querySelector(".kline.active");
    if (active) {
      // 弹簧引擎：行间隔传入弹簧策略（快歌硬、慢歌软）
      const cur = props.lyric[v];
      const prev = props.lyric[v - 1];
      const intervalMs =
        cur &&
        prev &&
        cur.type === "line" &&
        prev.type === "line" &&
        typeof cur.s === "number" &&
        typeof prev.s === "number"
          ? cur.s - prev.s
          : undefined;
      scrollTo(active as HTMLElement, { intervalMs });
    }
  },
);
</script>

<style scoped>
.karaoke-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--card);
  border-radius: 16px;
  border: 1px solid var(--border);
}
.kp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  font-size: 13px;
  font-weight: 700;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.kp-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.kp-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--text3);
}
/* AB 区间进度条：区间确定后显示（细绿条，与区间高亮色系协调） */
.ab-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 18px 8px;
  flex-shrink: 0;
}
.ab-progress-track {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--green-soft);
  overflow: hidden;
}
.ab-progress-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--green-grad1), var(--green));
  transition: width 0.3s;
}
.ab-progress-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--green);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.kp-spec-btn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  background: var(--card2);
  border: 1px solid var(--border);
  transition: all 0.15s;
  margin-left: auto;
  flex-shrink: 0;
}
.kp-spec-btn:hover {
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}
/* 移动端跟唱折叠：顶部信息按钮（控制区收起时显示） */
.kp-info-btn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  background: var(--card2);
  border: 1px solid var(--border);
  transition: all 0.15s;
  flex-shrink: 0;
  margin-left: 6px;
}
.kp-info-btn:hover {
  color: var(--text);
  background: var(--border);
}
/* 信息气泡：标题栏下方右对齐（点击 → 展开控制区） */
.kp-tip {
  position: absolute;
  top: calc(100% + 8px);
  right: 12px;
  background: var(--card2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 12.5px;
  color: var(--text);
  box-shadow: 0 8px 24px var(--shadow-strong);
  cursor: pointer;
  white-space: nowrap;
  z-index: 10;
}
.kp-tip-enter-active,
.kp-tip-leave-active {
  transition:
    opacity 0.15s,
    transform 0.15s;
}
.kp-tip-enter-from,
.kp-tip-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.kp-expand {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text2);
  opacity: 0.6;
  transition: all 0.15s;
  flex-shrink: 0;
  margin-right: 6px;
}
.kp-expand:hover {
  opacity: 1;
  color: var(--text);
  background: var(--border);
}
.kp-song {
  font-size: 12px;
  font-weight: 600;
  color: var(--text2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  padding: 0 8px;
}
.kp-scroll {
  flex: 1;
  overflow: hidden; /* transform 平移滚动：不再用原生滚动 */
  padding: 16px 22px 48px;
  /* 上下渐隐遮罩（与连播歌词一致） */
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
}
/* native 引擎：原生滚动容器 */
.kp-scroll.native-mode {
  overflow-y: auto;
}
.kp-track {
  position: relative; /* 行 offsetTop 的定位基准 */
}
.kp-scroll.no-mask {
  -webkit-mask-image: none;
  mask-image: none;
}
.kp-spacer {
  /* 高度由 useLyricScroll 按视口一半动态设置（第一句/最后一句可滚到中央） */
  flex-shrink: 0;
}
.sec {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent2);
  letter-spacing: 2px;
  margin: 22px 0 10px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sec:first-child {
  margin-top: 0;
}
/* 纯文字流：字体层级跟随连播歌词，功能元素（行号/时间/AB）保留 */
.kline {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 9px 14px;
  cursor: pointer;
  transition: all 0.3s;
  border-left: 3px solid transparent;
}
.kline:hover {
  background: none;
}
/* 歌词正文占满行内剩余宽度：text-align 才有居中/右对齐空间（行号固定最左） */
.kline-body {
  flex: 1;
  min-width: 0;
}
.kline-jp {
  font-size: calc(var(--fs-active, 20px) * 0.675);
  font-weight: 400;
  color: var(--text3);
  line-height: 1.6;
  transition:
    font-size 0.3s,
    color 0.3s,
    font-weight 0.3s;
}
.kline-roma {
  font-size: calc(var(--fs-active, 20px) * 0.55);
  color: var(--text3);
  margin-top: 2px;
  font-style: italic;
  line-height: 1.4;
  opacity: 0.75;
  transition:
    font-size 0.3s,
    color 0.3s,
    opacity 0.3s;
}
.kline-zh {
  font-size: calc(var(--fs-active, 20px) * 0.575);
  color: var(--text3);
  margin-top: 3px;
  line-height: 1.4;
  opacity: 0.7;
  transition:
    font-size 0.3s,
    color 0.3s,
    opacity 0.3s;
}
.kline-zh.hidden {
  display: none;
}
/* 相邻句：略放大、提亮（中间层） */
.kline.near {
  opacity: 1;
}
.kline.near .kline-jp {
  font-size: calc(var(--fs-active, 20px) * 0.75);
  font-weight: 500;
  color: var(--text-soft);
}
.kline.near .kline-roma {
  font-size: calc(var(--fs-active, 20px) * 0.575);
  color: var(--text-faint);
  opacity: 0.85;
}
.kline.near .kline-zh {
  font-size: calc(var(--fs-active, 20px) * 0.6);
  color: var(--text-faint);
  opacity: 0.8;
}
/* 更远句：整体更淡（最底层） */
.kline.far {
  opacity: 0.68;
}
/* 当前句：放大加粗、亮白（与连播歌词一致的焦点效果） */
.kline.active {
  border-left-color: var(--accent);
}
.kline.active .kline-jp {
  font-size: var(--fs-active, 20px);
  font-weight: 700;
  color: var(--lyr-jp, var(--accent-text));
}
.kline.active .kline-roma {
  font-size: calc(var(--fs-active, 20px) * 0.625);
  color: var(--text2);
  opacity: 1;
}
.kline.active .kline-zh {
  font-size: calc(var(--fs-active, 20px) * 0.65);
  color: var(--lyr-zh, var(--text2));
  opacity: 1;
}
/* 每句时间戳（设置开关控制） */
.kline-time {
  font-size: 11px;
  color: var(--text3);
  flex-shrink: 0;
  margin-top: 7px;
  font-variant-numeric: tabular-nums;
  transition: color 0.3s;
}
.kline.active .kline-time {
  color: var(--accent-text);
}
/* 行号圆点 */
.kline-num {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--card2);
  color: var(--text2);
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 6px;
  transition: all 0.3s;
}
.kline.active .kline-num {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  margin-top: 9px; /* 跟随焦点句字号放大，圆点下移对齐 */
}
/* AB 循环区间：细绿竖条 + 行号绿色（active 保持焦点高亮） */
.kline.ab-in:not(.active) {
  border-left-color: var(--green-border);
}
.kline.ab-in:not(.active) .kline-num {
  background: var(--green-soft);
  color: var(--green);
}
/* AB 端点 A/B 徽标：绿色渐变（末尾定义，特异性覆盖 active 与区间底色） */
.kline.ab-in .kline-num.ab-badge {
  background: linear-gradient(135deg, var(--green-grad1), var(--green));
  color: #fff;
}
/* 等选终点（b=null）：起点 A 徽标落在 active 行上，独立规则覆盖 active 橙色渐变 */
.kline.active .kline-num.ab-badge {
  background: linear-gradient(135deg, var(--green-grad1), var(--green));
  color: #fff;
  /* 不跟随焦点句下移：A/B 徽标与普通数字标号保持同一水平线 */
  margin-top: 6px;
}
.kp-empty {
  text-align: center;
  color: var(--text3);
  padding: 60px 20px;
  font-size: 14px;
}
.kp-empty-icon {
  margin-bottom: 14px;
  color: var(--text3);
  opacity: 0.6;
}
.kp-empty-sub {
  font-size: 12.5px;
  color: var(--text3);
  opacity: 0.85;
  margin-top: 4px;
}
.kp-empty-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 18px;
  padding: 8px 18px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text2);
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.15s;
}
.kp-empty-btn:hover {
  border-color: var(--accent);
  color: var(--accent-text);
  background: var(--accent-soft);
}
.kp-empty-sub {
  font-size: 12px;
  color: var(--text3);
  margin-top: 8px;
  line-height: 1.6;
}
</style>
