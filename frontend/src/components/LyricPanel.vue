<template>
  <div class="lyric-panel">
    <button class="lyric-spec-btn" title="指定歌词" @click="openLyricSpec()">
      <FileMusic :size="15" />
    </button>
    <!--
      amll LyricPlayer（Apple Music 风格歌词组件）：
      - 自带弹簧物理滚动/逐词高亮/行缩放模糊/手势接管+惯性+自动恢复跟随
      - 数据格式：LyricLine[]（本项目的行级 LRC 转 words 单词行）
      - 主题通过 CSS 变量 --amll-lp-* 覆盖（字号/主色）
      - 段落标题（sec）amll 无对应概念 → 丢弃（取舍记录见分支说明）
    -->
    <LyricPlayer
      ref="playerRef"
      class="amll-host"
      :class="{ 'no-mask': !lyricSettings.fadeMask }"
      :lyric-lines="amllLines"
      :current-time="amllTime"
      :align-position="lyricSettings.focusPos"
      :enable-spring="true"
      :enable-blur="true"
      :enable-scale="true"
      :word-fade-width="0.5"
      :style="amllStyle"
      @line-click="onLineClick"
    />
    <div v-if="!lyric.length" class="lyr-empty">暂无歌词</div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { FileMusic } from "@lucide/vue";
import { LyricPlayer } from "@applemusic-like-lyrics/vue";
import { seek, state, lyricSettings, openLyricSpec, LYRIC_SCHEMES } from "../composables/usePlayer.js";

const props = defineProps({
  lyric: { type: Array, default: () => [] },
  current: { type: Number, default: -1 },
});

const playerRef = ref(null);

const FONTS = {
  system: "",
  serif: '"Songti SC", "SimSun", "Noto Serif SC", serif',
  rounded: '"Yuanti SC", "PingFang SC", "Noto Sans SC", sans-serif',
};

// 行级 LRC → amll LyricLine[]（每行一个"单词"承载整句，startTime/endTime 为句区间）
// 取舍：段落标题（sec）amll 无对应概念，丢弃；KaraokePanel 保持原实现不受影响
// 设置映射：showZh/zhVisible → translatedLyric 字段，showRoma → romanLyric 字段
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

// 主题映射：字号/主色/字体/对齐 → amll CSS 变量与 props
const amllStyle = computed(() => ({
  fontFamily: FONTS[lyricSettings.fontFamily] || "",
  "--amll-lp-font-size": lyricSettings.fontSize + "px",
  "--amll-lp-color":
    lyricSettings.jpColor ||
    LYRIC_SCHEMES.find((s) => s.key === lyricSettings.colorScheme)?.jp ||
    "var(--accent-text)",
}));

function onLineClick(e) {
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
.amll-host {
  width: 100%;
  height: 100%;
  padding: 24px 28px 48px;
  box-sizing: border-box;
}
/* 上下渐隐遮罩（Spotify 式 fade mask，与设置项 fadeMask 对应） */
.amll-host {
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 82%, transparent);
}
.amll-host.no-mask {
  -webkit-mask-image: none;
  mask-image: none;
}
.lyr-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  font-size: 13px;
  pointer-events: none;
}
</style>
