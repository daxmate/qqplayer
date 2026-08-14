<template>
  <Teleport to="body">
    <div v-if="panelStyle" class="sv-panel" :style="panelStyle">
      <div class="sv-head">
        <button class="sv-back" :title="t('smart.back')" @click="close">
          <ArrowLeft :size="15" />
        </button>
        <span class="sv-title">{{ t(meta.titleKey) }}</span>
        <span class="sv-count">{{ t("smart.count", { n: rows.length }) }}</span>
      </div>
      <div class="sv-list">
        <div v-if="loading" class="sv-empty">{{ t("smart.loading") }}</div>
        <div v-else-if="error" class="sv-empty">{{ error }}</div>
        <template v-else>
          <div
            v-for="row in rows"
            :key="row.song.path"
            class="sv-item"
            :class="{ active: isCurrent(row) }"
            :data-path="row.song.path"
            @click="playRow(row)"
          >
            <span class="sv-cover">
              <img
                v-if="coverOk(row.song.path)"
                :src="coverUrl(row.song.path)"
                alt=""
                loading="lazy"
                @error="markCoverError(row.song.path)"
              />
              <Music2 v-else :size="18" />
            </span>
            <span class="sv-info">
              <span class="sv-name">{{ row.song.name }}</span>
              <span class="sv-sub">
                {{ row.song.artist }}
                <template v-if="sub(row)"> · {{ sub(row) }}</template>
              </span>
            </span>
            <span v-if="isCurrent(row)" class="sv-eq" :title="t('smart.playing')">
              <span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span>
            </span>
          </div>
          <div v-if="!rows.length" class="sv-empty">{{ t(meta.emptyKey) }}</div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, Music2 } from "@lucide/vue";
import { state } from "../composables/usePlayer.js";
import {
  SMART_VIEWS,
  smartViewState,
  loadSmartView,
  playSmartRow,
  fmtSmartSub,
} from "../composables/useSmartViews.js";

const { t } = useI18n();

const props = defineProps({
  kind: { type: String, required: true },
});
const emit = defineEmits(["close"]);

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
function playRow(row) {
  playSmartRow(row);
}
function close() {
  emit("close");
}

// ============ 定位：覆盖桌面播放列表面板（.main .playlist 的网格位置） ============
// 智能视图复用播放列表所在的 280px 列；面板随 Playlist 的 rect 变化自适应
const panelStyle = ref(null);
let ro = null;

function measure() {
  const el = document.querySelector(".main .playlist");
  if (!el) {
    panelStyle.value = null;
    return;
  }
  const r = el.getBoundingClientRect();
  panelStyle.value = {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
}

function setupMeasure() {
  ro?.disconnect();
  const el = document.querySelector(".main .playlist");
  if (!el) return;
  ro = new ResizeObserver(measure);
  ro.observe(el);
}

// 布局变化（侧栏开关/控制区收起/窗口缩放）后重新对齐
function remeasure() {
  requestAnimationFrame(measure);
}

function onKeydown(e) {
  if (e.key === "Escape") close();
}

watch(() => state.musicLibOpen, remeasure);
watch(() => state.controlsHidden, remeasure);
watch(
  () => props.kind,
  (k) => loadSmartView(k),
  { flush: "post" },
);

onMounted(() => {
  measure();
  setupMeasure();
  window.addEventListener("resize", remeasure);
  window.addEventListener("keydown", onKeydown);
  loadSmartView(props.kind); // 进入视图时拉取数据
});
onBeforeUnmount(() => {
  ro?.disconnect();
  window.removeEventListener("resize", remeasure);
  window.removeEventListener("keydown", onKeydown);
});

// ============ 封面错误缓存 ============
const coverErrors = ref(new Set());
function coverOk(path) {
  return !coverErrors.value.has(path);
}
function markCoverError(path) {
  coverErrors.value.add(path);
}
function coverUrl(path) {
  return "/api/cover?path=" + encodeURIComponent(path);
}
</script>

<style scoped>
.sv-panel {
  position: fixed;
  z-index: 40;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: linear-gradient(160deg, var(--bg), var(--bg2)); /* 与 body 底色一致，覆盖原列 */
}
.sv-head {
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sv-back {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  transition: all 0.12s;
  flex-shrink: 0;
}
@media (hover: hover) {
  .sv-back:hover {
    background: var(--border);
    color: var(--text);
  }
}
.sv-back:active {
  transform: scale(0.92);
}
.sv-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sv-count {
  font-size: 11px;
  color: var(--text3);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.sv-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.sv-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.12s;
}
@media (hover: hover) {
  .sv-item:hover {
    background: var(--card2);
  }
}
.sv-item.active {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 22%, transparent),
    color-mix(in srgb, var(--accent2) 12%, transparent)
  );
}
.sv-cover {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--card2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  font-size: 0;
}
.sv-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.sv-info {
  flex: 1;
  min-width: 0;
}
.sv-name {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sv-sub {
  display: block;
  font-size: 11.5px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sv-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
}
.sv-eq .eq-bar {
  width: 3px;
  border-radius: 1.5px;
  background: currentColor;
  height: 100%;
  animation: sv-eq-bounce 1s ease-in-out infinite;
}
.sv-eq .eq-bar:nth-child(2) {
  animation-delay: -0.33s;
}
.sv-eq .eq-bar:nth-child(3) {
  animation-delay: -0.66s;
}
@keyframes sv-eq-bounce {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}
.sv-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  padding: 30px 0;
}
</style>
