<template>
  <div class="lyric-panel">
    <div ref="scrollEl" class="lyric-scroll">
      <template v-for="(item, i) in lyric" :key="i">
        <!-- 段落标题 -->
        <div v-if="item.type === 'sec'" class="sec">♪ {{ item.name }}</div>
        <!-- 句子 -->
        <div v-else class="lyr" :class="{ active: i === current }" @click="seekLine(item)">
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
import { seek } from "../composables/usePlayer.js";

const props = defineProps({
  lyric: { type: Array, default: () => [] },
  current: { type: Number, default: -1 },
});

const scrollEl = ref(null);
let lastCurrent = -1;

// 当前句变化时滚动到中间（连播不 seek，只滚动高亮）
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
      const top = active.offsetTop - el.clientHeight / 2 + active.clientHeight / 2;
      // auto：直接定位到中间（smooth 在多句快速切换时动画叠加会停不准）
      el.scrollTo({ top, behavior: "auto" });
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
  padding: 18px 24px;
}
.sec {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent2);
  letter-spacing: 2px;
  margin: 18px 0 8px;
}
.sec:first-child {
  margin-top: 0;
}
.lyr {
  padding: 10px 14px;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s;
  border-left: 3px solid transparent;
  opacity: 0.55;
  transform: scale(0.99);
}
.lyr:hover {
  background: var(--card2);
  opacity: 0.85;
}
.lyr.active {
  opacity: 1;
  background: linear-gradient(135deg, rgba(255, 126, 95, 0.16), rgba(254, 180, 123, 0.06));
  border-left-color: var(--accent);
  transform: scale(1);
}
.lyr-jp {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.5;
}
.lyr.active .lyr-jp {
  color: #ffd9c9;
}
.lyr-roma {
  font-size: 12px;
  color: var(--text2);
  margin-top: 2px;
  font-style: italic;
  line-height: 1.4;
}
.lyr-zh {
  font-size: 12.5px;
  color: var(--text3);
  margin-top: 3px;
  line-height: 1.4;
}
.lyr-empty {
  text-align: center;
  color: var(--text3);
  padding: 40px 0;
  font-size: 13px;
}
</style>
