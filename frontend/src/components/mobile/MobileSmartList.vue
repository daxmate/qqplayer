<template>
  <div class="msv-page">
    <!-- 顶栏：返回 + 标题 + 数量 -->
    <header class="msv-head">
      <button class="msv-back" :title="t('smart.back')" @click="$emit('close')">
        <ChevronLeft :size="24" />
      </button>
      <h1 class="msv-title">{{ t(meta.titleKey) }}</h1>
      <span class="msv-count">{{ t("smart.count", { n: rows.length }) }}</span>
    </header>

    <!-- 列表 -->
    <div class="msv-list">
      <div v-if="loading" class="msv-empty">{{ t("smart.loading") }}</div>
      <div v-else-if="error" class="msv-empty">{{ error }}</div>
      <template v-else>
        <div
          v-for="row in rows"
          :key="row.song.path"
          class="msv-item"
          :class="{ active: isCurrent(row) }"
          :data-path="row.song.path"
          @click="onPlay(row)"
        >
          <div class="msv-cover">
            <img
              v-if="coverOk(row.song.path)"
              :src="'/api/cover?path=' + encodeURIComponent(row.song.path)"
              :alt="row.song.name"
              loading="lazy"
              @error="markCoverError(row.song.path)"
            />
            <Music2 v-else :size="18" />
          </div>
          <div class="msv-info">
            <div class="msv-name">
              {{ row.song.name }}
              <span
                v-if="isCurrent(row) && state.isPlaying"
                class="msv-eq"
                :title="t('smart.playing')"
              >
                <span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span>
              </span>
            </div>
            <div class="msv-sub">
              {{ row.song.artist }}<template v-if="sub(row)"> · {{ sub(row) }}</template>
            </div>
          </div>
        </div>
        <div v-if="!rows.length" class="msv-empty">{{ t(meta.emptyKey) }}</div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronLeft, Music2 } from "@lucide/vue";
import { state } from "../../composables/usePlayer.js";
import {
  SMART_VIEWS,
  smartViewState,
  loadSmartView,
  playSmartRow,
  fmtSmartSub,
} from "../../composables/useSmartViews.js";

const { t } = useI18n();

const props = defineProps({
  kind: { type: String, required: true }, // recentAdded | recentPlayed | topPlayed
});
const emit = defineEmits(["close", "open-player"]);

const meta = computed(() => SMART_VIEWS[props.kind] || SMART_VIEWS.recentAdded);
const rows = computed(() => smartViewState.rows);
const loading = computed(() => smartViewState.loading);
const error = computed(() => smartViewState.error);

function isCurrent(row) {
  return state.currentSong && row.song.path === state.currentSong.path;
}
function sub(row) {
  return fmtSmartSub(row);
}

// 点击行：播放并打开全屏播放器（与 MobileShell.playFromList 一致）
function onPlay(row) {
  if (!playSmartRow(row)) return;
  emit("open-player");
}

// 进入视图时拉取数据（切换 kind 重新拉取）
watch(
  () => props.kind,
  (k) => loadSmartView(k),
  { immediate: true },
);

// ============ 封面错误缓存 ============
const coverErrors = ref(new Set());
function coverOk(path) {
  return !coverErrors.value.has(path);
}
function markCoverError(path) {
  coverErrors.value.add(path);
}
</script>

<style scoped>
.msv-page {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: linear-gradient(160deg, var(--bg), var(--bg2)); /* 与 body 底色一致，覆盖首页 */
}
.msv-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  padding-top: calc(10px + env(safe-area-inset-top));
}
.msv-back {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  flex-shrink: 0;
  touch-action: manipulation;
}
.msv-back:active {
  background: var(--card2);
  color: var(--text);
}
.msv-title {
  flex: 1;
  min-width: 0;
  font-size: 17px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}
.msv-count {
  width: 38px;
  font-size: 12px;
  color: var(--text3);
  text-align: right;
  flex-shrink: 0;
}
.msv-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 28px;
  -webkit-overflow-scrolling: touch;
}
.msv-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.12s;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.msv-item:active {
  background: var(--card2);
}
.msv-item.active {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 20%, transparent),
    color-mix(in srgb, var(--accent2) 10%, transparent)
  );
}
.msv-cover {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--card2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  font-size: 0;
}
.msv-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.msv-info {
  flex: 1;
  min-width: 0;
}
.msv-name {
  font-size: 14.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 6px;
}
.msv-sub {
  font-size: 12px;
  color: var(--text3);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.msv-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 11px;
  flex-shrink: 0;
  color: var(--accent);
}
.msv-eq .eq-bar {
  width: 3px;
  border-radius: 1.5px;
  background: currentColor;
  height: 100%;
  animation: msv-eq-bounce 1s ease-in-out infinite;
}
.msv-eq .eq-bar:nth-child(2) {
  animation-delay: -0.33s;
}
.msv-eq .eq-bar:nth-child(3) {
  animation-delay: -0.66s;
}
@keyframes msv-eq-bounce {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}
.msv-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13.5px;
  padding: 40px 0;
}
</style>
