<template>
  <div class="lyric-panel">
    <div ref="scrollEl" class="lyric-scroll">
      <template v-for="(item, i) in lyric" :key="i">
        <!-- 段落标题 -->
        <div v-if="item.type === 'sec'" class="sec">
          <Music2 :size="12" />
          {{ item.name }}
        </div>
        <!-- 句子 -->
        <div v-else class="lyr" :class="distClass(i)" @click="seekLine(item)">
          <div class="lyr-jp">{{ item.text[0] || "…" }}</div>
          <div v-if="item.text[1]" class="lyr-roma">{{ item.text[1] }}</div>
          <div v-if="item.text[2]" class="lyr-zh">{{ item.text[2] }}</div>
        </div>
      </template>
      <div v-if="!lyric.length" class="lyr-empty">暂无歌词</div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from "vue";
import { Music2 } from "@lucide/vue";
import { seek } from "../composables/usePlayer.js";

const props = defineProps({
  lyric: { type: Array, default: () => [] },
  current: { type: Number, default: -1 },
});

const scrollEl = ref(null);
let lastCurrent = -1;

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

// 当前句变化时滚动到可视区 1/3 高度处（Apple Music 歌词页的停靠位置）
watch(
  () => props.current,
  async (v) => {
    if (v < 0 || v === lastCurrent) return;
    lastCurrent = v;
    await nextTick();
    const el = scrollEl.value;
    if (!el) return;
    const active = el.querySelector(".lyr.active");
    if (active) {
      // 用 getBoundingClientRect 计算（offsetTop 相对 body 会偏，容器上方有封面等元素）
      const rect = active.getBoundingClientRect();
      const crect = el.getBoundingClientRect();
      const top = el.scrollTop + (rect.top - crect.top) - el.clientHeight / 3 + rect.height / 2;
      el.scrollTo({ top, behavior: "smooth" });
    }
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
}
.lyric-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 24px 28px 48px;
  /* 上下渐隐遮罩（Spotify 式 fade mask） */
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
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
/* 纯文字流：无卡片背景，靠字号/颜色/透明度分层 */
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
  font-size: 13.5px;
  font-weight: 400;
  color: var(--text3);
  line-height: 1.6;
  transition:
    font-size 0.3s,
    color 0.3s,
    font-weight 0.3s;
}
.lyr-roma {
  font-size: 11px;
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
  font-size: 11.5px;
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
  font-size: 15px;
  font-weight: 500;
  color: rgba(238, 240, 247, 0.72);
}
.lyr.near .lyr-roma {
  font-size: 11.5px;
  color: rgba(238, 240, 247, 0.6);
  opacity: 0.85;
}
.lyr.near .lyr-zh {
  font-size: 12px;
  color: rgba(238, 240, 247, 0.6);
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
  font-size: 20px;
  font-weight: 700;
  color: #ffd9c9;
}
.lyr.active .lyr-roma {
  font-size: 12.5px;
  color: var(--text2);
  opacity: 1;
}
.lyr.active .lyr-zh {
  font-size: 13px;
  color: var(--text2);
  opacity: 1;
}
.lyr-empty {
  text-align: center;
  color: var(--text3);
  padding: 40px 0;
  font-size: 13px;
}
</style>
