<template>
  <div class="karaoke-panel">
    <div class="kp-head">
      <span>🎤 逐句练习</span>
      <span class="kp-hint">点击句子播放 · 播完自动停</span>
    </div>
    <div ref="scrollEl" class="kp-scroll">
      <template v-for="(item, i) in lyric" :key="i">
        <div v-if="item.type === 'sec'" class="sec">♪ {{ item.name }}</div>
        <div v-else class="kline" :class="{ active: i === current }" @click="playLineAt(i)">
          <span class="kline-num">{{ lineNumber(i) }}</span>
          <div class="kline-body">
            <div class="kline-jp">{{ item.text[0] || "…" }}</div>
            <div v-if="item.text[1]" class="kline-roma">{{ item.text[1] }}</div>
            <div v-if="item.text[2]" class="kline-zh" :class="{ hidden: !state.zhVisible }">
              {{ item.text[2] }}
            </div>
          </div>
          <span class="kline-time">{{ fmt(item.s) }} – {{ fmt(item.e) }}</span>
        </div>
      </template>
      <div v-if="!lyric.length" class="kp-empty">
        <div class="kp-empty-icon">🎤</div>
        <div>这首歌没有歌词文件</div>
        <div class="kp-empty-sub">在歌曲同目录放置同名 .srt 或 .lrc 即可跟唱</div>
        <div class="kp-empty-sub">SRT 格式：每句可 1~3 行（原文 / 罗马音 / 中文）</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from "vue";
import { state, playLine } from "../composables/usePlayer.js";

const props = defineProps({
  lyric: { type: Array, default: () => [] },
  current: { type: Number, default: -1 },
});

const scrollEl = ref(null);
const lineIndexMap = ref([]); // lyric 数组索引 -> 行号（只计 line）
let lastCurrent = -1;

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

function playLineAt(lyricIdx) {
  const lineNo = lineIndexMap.value.indexOf(lyricIdx);
  if (lineNo >= 0) playLine(lineNo);
}

watch(
  () => props.current,
  async (v) => {
    if (v < 0 || v === lastCurrent) return;
    lastCurrent = v;
    await nextTick();
    const el = scrollEl.value;
    if (!el) return;
    const active = el.querySelector(".kline.active");
    if (active) {
      const top = active.offsetTop - el.clientHeight / 2 + active.clientHeight / 2;
      el.scrollTo({ top, behavior: "smooth" });
    }
  },
);

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}
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
.kp-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--text3);
}
.kp-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px 30px;
  scroll-behavior: smooth;
}
.sec {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent2);
  letter-spacing: 2px;
  margin: 20px 0 8px;
}
.sec:first-child {
  margin-top: 0;
}
.kline {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 11px 14px;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.15s;
  border-left: 4px solid transparent;
  margin-bottom: 8px;
  background: var(--bg2);
}
.kline:hover {
  background: var(--card2);
}
.kline.active {
  background: linear-gradient(135deg, rgba(255, 126, 95, 0.22), rgba(254, 180, 123, 0.1));
  border-left-color: var(--accent);
  box-shadow:
    0 0 0 1px var(--accent),
    0 4px 14px rgba(255, 126, 95, 0.2);
}
.kline-num {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--card2);
  color: var(--text2);
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
}
.kline.active .kline-num {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.kline-body {
  flex: 1;
  min-width: 0;
}
.kline-jp {
  font-size: 17px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.5;
}
.kline.active .kline-jp {
  color: #ffd9c9;
}
.kline-roma {
  font-size: 12.5px;
  color: var(--text2);
  margin-top: 2px;
  font-style: italic;
  line-height: 1.4;
}
.kline-zh {
  font-size: 13px;
  color: var(--text3);
  margin-top: 4px;
  line-height: 1.4;
}
.kline-zh.hidden {
  display: none;
}
.kline-time {
  font-size: 11px;
  color: var(--text3);
  flex-shrink: 0;
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
.kp-empty {
  text-align: center;
  color: var(--text3);
  padding: 60px 20px;
  font-size: 14px;
}
.kp-empty-icon {
  font-size: 44px;
  margin-bottom: 14px;
}
.kp-empty-sub {
  font-size: 12px;
  color: var(--text3);
  margin-top: 8px;
  line-height: 1.6;
}
</style>
