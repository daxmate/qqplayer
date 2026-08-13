<template>
  <div class="lyric-panel">
    <button class="lyric-spec-btn" title="指定歌词" @click="openLyricSpec()">
      <FileMusic :size="15" />
    </button>
    <div
      ref="scrollEl"
      class="lyric-scroll"
      :class="{ 'no-mask': !lyricSettings.fadeMask }"
      :style="scrollStyle"
    >
      <div ref="trackEl" class="lyric-track">
        <!-- 顶部占位（高度 JS 设为视口一半）：让第一句能滚到垂直居中 -->
        <div class="lyric-spacer" aria-hidden="true"></div>
        <template v-for="(item, i) in lyric" :key="i">
        <!-- 段落标题 -->
        <div v-if="item.type === 'sec' && lyricSettings.showSec" class="sec">
          <Music2 :size="12" />
          {{ item.name }}
        </div>
        <!-- 句子 -->
        <div
          v-else-if="item.type === 'line'"
          class="lyr"
          :class="distClass(i)"
          @click="seekLine(item)"
        >
          <div class="lyr-jp">{{ item.text[0] || "…" }}</div>
          <div v-if="item.text[1] && lyricSettings.showRoma" class="lyr-roma">
            {{ item.text[1] }}
          </div>
          <div v-if="item.text[2] && lyricSettings.showZh && state.zhVisible" class="lyr-zh">
            {{ item.text[2] }}
          </div>
        </div>
      </template>
      <div v-if="!lyric.length" class="lyr-empty">暂无歌词</div>
        <!-- 底部占位（高度 JS 设为视口一半）：让最后一句能滚到垂直居中 -->
        <div class="lyric-spacer" aria-hidden="true"></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, computed, nextTick } from "vue";
import { Music2, FileMusic } from "@lucide/vue";
import { seek, lyricSettings, state, openLyricSpec, LYRIC_SCHEMES } from "../composables/usePlayer.js";
import { useLyricScroll } from "../composables/useLyricScroll.js";

const props = defineProps({
  lyric: { type: Array, default: () => [] },
  current: { type: Number, default: -1 },
});

const scrollEl = ref(null);
const trackEl = ref(null);
let lastCurrent = -1;

// transform 平移滚动（引擎无关；滚轮手动接管，动画被用户滚动打断时自动让位）
const { scrollTo } = useLyricScroll(scrollEl, trackEl, {
  getFocusPos: () => lyricSettings.focusPos,
});

const FONTS = {
  system: "",
  serif: '"Songti SC", "SimSun", "Noto Serif SC", serif',
  rounded: '"Yuanti SC", "PingFang SC", "Noto Sans SC", sans-serif',
};

// 字号/字体/对齐/渐隐 → 全部走 CSS 变量与内联样式
const scrollStyle = computed(() => ({
  fontFamily: FONTS[lyricSettings.fontFamily] || "",
  textAlign: lyricSettings.align,
  "--fs-active": lyricSettings.fontSize + "px",
  // 配色：自定义颜色优先，否则配色方案色，否则主题强调色
  "--lyr-jp": lyricSettings.jpColor || LYRIC_SCHEMES.find((s) => s.key === lyricSettings.colorScheme)?.jp || "var(--accent-text)",
  "--lyr-zh": lyricSettings.zhColor || LYRIC_SCHEMES.find((s) => s.key === lyricSettings.colorScheme)?.zh || "var(--text2)",
}));

// 距离分级：0 = 当前句，1 = 相邻句，2 = 更远（决定字号/透明度层级）
function distClass(i) {
  const d = props.current < 0 ? 99 : Math.abs(i - props.current);
  if (d === 0) return "active";
  if (d === 1) return "near";
  return "far";
}

watch(
  () => props.lyric,
  () => {
    lastCurrent = -1; // 切歌重置，保证新歌第一句也会触发滚动
  },
);

// 当前句变化时滚动到焦点停靠位置（默认可视区 1/3 高度，Apple Music 式）
watch(
  () => props.current,
  async (v) => {
    if (v < 0 || v === lastCurrent) return;
    lastCurrent = v;
    if (!lyricSettings.autoScroll) return; // 关闭自动跟随：只高亮不滚动
    await nextTick();
    const active = scrollEl.value?.querySelector(".lyr.active");
    if (active) scrollTo(active);
  },
);

function seekLine(item) {
  // 连播模式：点击句子可跳转试听（用户主动点击，允许 seek）
  seek(item.s);
}
</script>

<style scoped>
.lyric-panel {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--card);
  border-radius: 16px;
  border: 1px solid var(--border);
  position: relative;
}
.lyric-spec-btn {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 5;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  background: color-mix(in srgb, var(--card) 80%, transparent);
  border: 1px solid var(--border);
  transition: all 0.15s;
}
.lyric-spec-btn:hover {
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.lyric-scroll {
  height: 100%;
  overflow: hidden; /* transform 平移滚动：不再用原生滚动 */
  padding: 24px 28px 48px;
  /* 上下渐隐遮罩（Spotify 式 fade mask） */
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
}
.lyric-track {
  position: relative; /* 行 offsetTop 的定位基准 */
}
.lyric-scroll.no-mask {
  -webkit-mask-image: none;
  mask-image: none;
}
.lyric-spacer {
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
/* 纯文字流：无卡片背景，靠字号/颜色/透明度分层；字号以 --fs-active 为基准按比例缩放 */
/* 切换过渡统一节奏（0.45s ease-in-out）：滚动动画同为 0.3~0.55s，动作连贯柔和 */
.lyr {
  padding: 9px 14px;
  cursor: pointer;
  transition:
    font-size 0.45s cubic-bezier(0.25, 0.1, 0.25, 1),
    color 0.45s cubic-bezier(0.25, 0.1, 0.25, 1),
    opacity 0.45s cubic-bezier(0.25, 0.1, 0.25, 1),
    transform 0.45s cubic-bezier(0.25, 0.1, 0.25, 1);
  transform-origin: left center;
}
.lyr:hover {
  opacity: 0.9;
}
.lyr-jp {
  font-size: calc(var(--fs-active, 20px) * 0.675);
  /* 行高固定（由设置字号决定，不随状态字号变）：切句时行不跳动、滚动目标稳定 */
  line-height: calc(var(--fs-active, 20px) * 1.5);
  font-weight: 400;
  color: var(--text3);
  transition:
    font-size 0.45s cubic-bezier(0.25, 0.1, 0.25, 1),
    color 0.45s cubic-bezier(0.25, 0.1, 0.25, 1),
    font-weight 0.45s cubic-bezier(0.25, 0.1, 0.25, 1);
}
.lyr-roma {
  font-size: calc(var(--fs-active, 20px) * 0.55);
  line-height: calc(var(--fs-active, 20px) * 0.625 * 1.4);
  color: var(--text3);
  margin-top: 2px;
  font-style: italic;
  opacity: 0.75;
  transition:
    font-size 0.45s cubic-bezier(0.25, 0.1, 0.25, 1),
    color 0.45s cubic-bezier(0.25, 0.1, 0.25, 1),
    opacity 0.45s cubic-bezier(0.25, 0.1, 0.25, 1);
}
.lyr-zh {
  font-size: calc(var(--fs-active, 20px) * 0.575);
  line-height: calc(var(--fs-active, 20px) * 0.65 * 1.4);
  color: var(--text3);
  margin-top: 3px;
  opacity: 0.7;
  transition:
    font-size 0.45s cubic-bezier(0.25, 0.1, 0.25, 1),
    color 0.45s cubic-bezier(0.25, 0.1, 0.25, 1),
    opacity 0.45s cubic-bezier(0.25, 0.1, 0.25, 1);
}
/* 相邻句：略放大、提亮（中间层） */
.lyr.near {
  opacity: 1;
}
.lyr.near .lyr-jp {
  font-size: calc(var(--fs-active, 20px) * 0.75);
  font-weight: 500;
  color: var(--text-soft);
}
.lyr.near .lyr-roma {
  font-size: calc(var(--fs-active, 20px) * 0.575);
  color: var(--text-faint);
  opacity: 0.85;
}
.lyr.near .lyr-zh {
  font-size: calc(var(--fs-active, 20px) * 0.6);
  color: var(--text-faint);
  opacity: 0.8;
}
/* 更远句：整体更淡（最底层） */
.lyr.far {
  opacity: 0.68;
}
/* 当前句：放大加粗、亮白（播放器焦点句） */
.lyr.active {
  transform: scale(1);
}
.lyr.active .lyr-jp {
  font-size: var(--fs-active, 20px);
  font-weight: 700;
  color: var(--lyr-jp, var(--accent-text));
}
.lyr.active .lyr-roma {
  font-size: calc(var(--fs-active, 20px) * 0.625);
  color: var(--text2);
  opacity: 1;
}
.lyr.active .lyr-zh {
  font-size: calc(var(--fs-active, 20px) * 0.65);
  color: var(--lyr-zh, var(--text2));
  opacity: 1;
}
.lyr-empty {
  text-align: center;
  color: var(--text3);
  padding: 40px 0;
  font-size: 13px;
}
</style>
