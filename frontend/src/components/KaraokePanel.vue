<template>
  <div class="karaoke-panel">
    <div class="kp-head">
      <button
        v-if="expandBtn"
        class="kp-expand"
        title="展开音乐库 / 播放列表"
        @click="expandPanels()"
      >
        <PanelLeftOpen :size="14" />
      </button>
      <span class="kp-title">
        <Mic :size="13" />
        逐句练习
      </span>
      <span v-if="uiSettings.showSongInfo && state.currentSong" class="kp-song" :title="songTitle">
        {{ songTitle }}
      </span>
      <span class="kp-hint">{{ abHint }}</span>
    </div>
    <div
      ref="scrollEl"
      class="kp-scroll"
      :class="{ 'no-mask': !lyricSettings.fadeMask }"
      :style="scrollStyle"
    >
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
          <span v-if="uiSettings.karaokeShowNum" class="kline-num" :class="{ 'ab-badge': abBadge(i) }">{{
            abBadge(i) || lineNumber(i)
          }}</span>
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
        <div>这首歌没有歌词文件</div>
        <div class="kp-empty-sub">在歌曲同目录放置同名 .srt 或 .lrc 即可跟唱</div>
        <div class="kp-empty-sub">SRT 格式：每句可 1~3 行（原文 / 罗马音 / 中文）</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, computed, nextTick } from "vue";
import { Mic, Music2, PanelLeftOpen } from "@lucide/vue";
import {
  state,
  clickLine,
  lyricSettings,
  uiSettings,
  toggleMusicLib,
} from "../composables/usePlayer.js";

const props = defineProps({
  lyric: { type: Array, default: () => [] },
  current: { type: Number, default: -1 },
  expandBtn: { type: Boolean, default: false }, // 面板全关时显示展开按钮（跟唱模式无悬浮按钮区）
});

function expandPanels() {
  toggleMusicLib();
}

const scrollEl = ref(null);
const lineIndexMap = ref([]); // lyric 数组索引 -> 行号（只计 line）
let lastCurrent = -1;

const FONTS = {
  system: "",
  serif: '"Songti SC", "SimSun", "Noto Serif SC", serif',
  rounded: '"Yuanti SC", "PingFang SC", "Noto Sans SC", sans-serif',
};

// 字号/字体/渐隐 → CSS 变量与内联样式（与连播 LyricPanel 一致）
const scrollStyle = computed(() => ({
  fontFamily: FONTS[lyricSettings.fontFamily] || "",
  "--fs-active": lyricSettings.fontSize + "px",
}));

watch(
  () => props.lyric,
  (v) => {
    lineIndexMap.value = v.map((x, i) => (x.type === "line" ? i : -1)).filter((i) => i >= 0);
    lastCurrent = -1;
  },
  { immediate: true },
);

function lineNumber(lyricIdx) {
  return lineIndexMap.value.indexOf(lyricIdx) + 1;
}

// 当前歌曲信息（设置开关控制）
const songTitle = computed(() => {
  const s = state.currentSong;
  if (!s) return "未选择歌曲";
  return s.artist ? `${s.name} · ${s.artist}` : s.name;
});

function fmt(t) {
  if (t == null || Number.isNaN(t)) return "--:--";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}

// ============ AB 循环：区间高亮 + 提示 ============
const abHint = computed(() => {
  const ab = state.abLoop;
  if (!ab) return "点击句子播放 · 播完自动停";
  if (ab.b === null) return `AB 循环：起点第 ${ab.a + 1} 句，请点击终点句`;
  return `AB 循环：第 ${ab.a + 1} ~ ${ab.b + 1} 句 · 单击退出`;
});

function abLineNo(lyricIdx) {
  return lineIndexMap.value.indexOf(lyricIdx);
}

function klineClass(lyricIdx) {
  const cls = { active: lyricIdx === props.current };
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

function abBadge(lyricIdx) {
  const ab = state.abLoop;
  const n = abLineNo(lyricIdx);
  if (!ab || ab.b === null) return "";
  if (n === ab.a) return "A";
  if (n === ab.b) return "B";
  return "";
}

function playLineAt(lyricIdx) {
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
  margin-left: auto;
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
  overflow-y: auto;
  padding: 16px 22px 48px;
  /* 上下渐隐遮罩（与连播歌词一致） */
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
}
.kp-scroll.no-mask {
  -webkit-mask-image: none;
  mask-image: none;
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
  color: rgba(238, 240, 247, 0.72);
}
.kline.near .kline-roma {
  font-size: calc(var(--fs-active, 20px) * 0.575);
  color: rgba(238, 240, 247, 0.6);
  opacity: 0.85;
}
.kline.near .kline-zh {
  font-size: calc(var(--fs-active, 20px) * 0.6);
  color: rgba(238, 240, 247, 0.6);
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
  color: #ffd9c9;
}
.kline.active .kline-roma {
  font-size: calc(var(--fs-active, 20px) * 0.625);
  color: var(--text2);
  opacity: 1;
}
.kline.active .kline-zh {
  font-size: calc(var(--fs-active, 20px) * 0.65);
  color: var(--text2);
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
  color: #ffd9c9;
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
  border-left-color: rgba(74, 222, 128, 0.55);
}
.kline.ab-in:not(.active) .kline-num {
  background: rgba(74, 222, 128, 0.22);
  color: #4ade80;
}
/* AB 端点 A/B 徽标：绿色渐变（末尾定义，特异性覆盖 active 与区间底色） */
.kline.ab-in .kline-num.ab-badge {
  background: linear-gradient(135deg, #22c55e, #4ade80);
  color: #fff;
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
  font-size: 12px;
  color: var(--text3);
  margin-top: 8px;
  line-height: 1.6;
}
</style>
