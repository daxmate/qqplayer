<template>
  <div class="lyric-panel">
    <button class="lyric-spec-btn" title="指定歌词" @click="openLyricSpec()">
      <FileMusic :size="15" />
    </button>

    <!--
      引擎一：amll 组件（Apple Music 风格，默认）
      异步加载：只有选 amll 才下载 pixi 等重依赖，native/spring 用户不背体积
    -->
    <LyricPlayer
      v-if="engine === 'amll'"
      class="amll-host"
      :class="{ 'no-mask': !lyricSettings.fadeMask }"
      :data-align="lyricSettings.align"
      :lyric-lines="amllLines"
      :current-time="amllTime"
      :align-position="lyricSettings.focusPos"
      :enable-spring="true"
      :enable-blur="true"
      :enable-scale="true"
      :word-fade-width="0.5"
      :style="amllStyle"
      @line-click="onAmllLineClick"
    />

    <!--
      引擎二/三：自研 DOM（spring 弹簧平移 / native 原生平滑）
      共用同一结构 scrollEl > trackEl > [spacer, 行…, spacer]：
      - spring：overflow hidden + translateY 平移（弹簧动画/手势接管/5s 恢复）
      - native：overflow auto + scrollTo smooth（引擎不接管，走浏览器原生）
    -->
    <div
      v-else
      ref="scrollEl"
      class="lyric-scroll"
      :class="{
        'no-mask': !lyricSettings.fadeMask,
        'native-mode': engine === 'native',
      }"
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
import { ref, watch, computed, nextTick, defineAsyncComponent } from "vue";
import { Music2, FileMusic } from "@lucide/vue";
import { seek, lyricSettings, state, openLyricSpec, LYRIC_SCHEMES } from "../composables/usePlayer.js";
import { useLyricScroll } from "../composables/useLyricScroll.js";

// amll 组件异步加载（vite 自动分包，仅 amll 引擎时下载）
const LyricPlayer = defineAsyncComponent(() =>
  import("@applemusic-like-lyrics/vue").then((m) => m.LyricPlayer),
);

const props = defineProps({
  lyric: { type: Array, default: () => [] },
  current: { type: Number, default: -1 },
});

const scrollEl = ref(null);
const trackEl = ref(null);
let lastCurrent = -1;

const engine = computed(() => lyricSettings.engine);
// 弹簧引擎只在 spring 模式接管事件；native 模式释放（走原生滚动）
const springActive = computed(() => engine.value === "spring");
const { scrollTo } = useLyricScroll(scrollEl, trackEl, {
  getFocusPos: () => lyricSettings.focusPos,
  enabled: springActive,
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
    if (engine.value === "native") {
      // 原生引擎：scrollTo smooth（不接管事件，行为交给浏览器）
      const el = scrollEl.value;
      if (!el) return;
      const active = el.querySelector(".lyr.active");
      if (active) {
        // 用 getBoundingClientRect 计算（offsetTop 相对 body 会偏，容器上方有封面等元素）
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
    const active = scrollEl.value?.querySelector(".lyr.active");
    if (active) {
      // 弹簧引擎：行间隔传入弹簧策略（快歌硬、慢歌软）
      const cur = props.lyric[v];
      const prev = props.lyric[v - 1];
      const intervalMs =
        cur && prev && typeof cur.s === "number" && typeof prev.s === "number"
          ? cur.s - prev.s
          : undefined;
      scrollTo(active, { intervalMs });
    }
  },
);

function seekLine(item) {
  // 连播模式：点击句子可跳转试听（用户主动点击，允许 seek）
  seek(item.s);
}

// ============ amll 引擎：数据与事件 ============

// 行级 LRC → amll LyricLine[]（每行一个"单词"承载整句，startTime/endTime 为句区间）
// 取舍：段落标题（sec）amll 无对应概念，丢弃
const amllLines = computed(() =>
  props.lyric
    .filter((x) => x.type === "line")
    .map((x) => ({
      words: [
        {
          word: x.text[0] || "",
          startTime: Math.round(x.s * 1000),
          endTime: Math.round(x.e * 1000),
        },
      ],
      translatedLyric:
        x.text[2] && lyricSettings.showZh && state.zhVisible ? x.text[2] : "",
      romanLyric: x.text[1] && lyricSettings.showRoma ? x.text[1] : "",
      startTime: Math.round(x.s * 1000),
      endTime: Math.round(x.e * 1000),
      isBG: false,
      isDuet: false,
    })),
);

// amll currentTime 要求毫秒整数；组件按调用频率自动决定滚动节奏
const amllTime = computed(() => Math.round((state.currentTime || 0) * 1000));

// 主题映射：字号/主色/字体 → amll CSS 变量
const amllStyle = computed(() => ({
  fontFamily: FONTS[lyricSettings.fontFamily] || "",
  "--amll-lp-font-size": lyricSettings.fontSize + "px",
  "--amll-lp-color":
    lyricSettings.jpColor ||
    LYRIC_SCHEMES.find((s) => s.key === lyricSettings.colorScheme)?.jp ||
    "var(--accent-text)",
}));

function onAmllLineClick(e) {
  // 点击歌词行跳转试听（amll 行事件）
  const line = e.line?.getLine?.();
  if (line && typeof line.startTime === "number") seek(line.startTime / 1000);
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
/* spring 引擎：transform 平移滚动，容器不滚动 */
.lyric-scroll {
  height: 100%;
  overflow: hidden;
  padding: 24px 28px 48px;
  /* 上下渐隐遮罩（Spotify 式 fade mask） */
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
}
/* native 引擎：原生滚动容器（spring 的 transform 会被释放，这里恢复原生） */
.lyric-scroll.native-mode {
  overflow-y: auto;
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
.lyr {
  padding: 9px 14px;
  cursor: pointer;
  transition:
    font-size 0.3s,
    color 0.3s,
    opacity 0.3s,
    transform 0.3s;
  transform-origin: left center;
}
.lyr:hover {
  opacity: 0.9;
}
.lyr-jp {
  font-size: calc(var(--fs-active, 20px) * 0.675);
  font-weight: 400;
  color: var(--text3);
  line-height: 1.6;
  transition:
    font-size 0.3s,
    color 0.3s,
    font-weight 0.3s;
}
.lyr-roma {
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
.lyr-zh {
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
/* ============ amll 引擎样式 ============ */
.amll-host {
  width: 100%;
  height: 100%;
  padding: 24px 28px 48px;
  box-sizing: border-box;
}
.amll-host {
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
}
.amll-host.no-mask {
  -webkit-mask-image: none;
  mask-image: none;
}
/* ============ amll 引擎：水平对齐覆盖 ============
   amll 组件无水平对齐 prop/CSS 变量；歌词主行是 flex 容器 + inline-block span
   （text-align: start）。按 data-align 覆盖内部类（[class*=] 抗 hash 变化）：
   - mainLine 本身 text-align（纯文本节点行）+ span（逐词结构行）双覆盖
   - 行容器 align-items 同步（flex 布局下兜底）
*/
.amll-host[data-align="center"] :deep([class*="lyricMainLine"]) {
  text-align: center;
}
.amll-host[data-align="center"] :deep([class*="lyricMainLine"]) span {
  text-align: center;
}
.amll-host[data-align="center"] :deep([class*="lyricLineWrapper"]) {
  align-items: center;
}
.amll-host[data-align="right"] :deep([class*="lyricMainLine"]) {
  text-align: right;
}
.amll-host[data-align="right"] :deep([class*="lyricMainLine"]) span {
  text-align: right;
}
.amll-host[data-align="right"] :deep([class*="lyricLineWrapper"]) {
  align-items: flex-end;
}
</style>
