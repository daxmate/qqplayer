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

    <!-- 列表（行左滑露出操作区：收藏/移除） -->
    <div ref="listEl" class="msv-list">
      <div v-if="loading" class="msv-empty">{{ t("smart.loading") }}</div>
      <div v-else-if="error" class="msv-empty">{{ error }}</div>
      <template v-else>
        <div
          v-for="row in rows"
          :key="row.song.path"
          class="msv-wrap"
          :class="{ open: isOpen(row.song.path) }"
        >
          <!-- 左滑露出的操作区（藏在行内容下方） -->
          <div class="msv-actions">
            <button
              class="msv-act"
              :class="{ on: isFavorite(row.song.path) }"
              :title="
                isFavorite(row.song.path) ? t('mobile.list.unfavorite') : t('mobile.list.favorite')
              "
              @click.stop="actFavorite(row.song.path)"
            >
              <Heart :size="17" :fill="isFavorite(row.song.path) ? 'currentColor' : 'none'" />
            </button>
            <button
              class="msv-act msv-act-remove"
              :title="t('mobile.list.remove')"
              @click.stop="actRemove(row)"
            >
              <Trash2 :size="16" />
            </button>
          </div>
          <div
            class="msv-item"
            :class="{ active: isCurrent(row) }"
            :data-path="row.song.path"
            :style="{
              transform: rowTransform(row.song.path),
              transition: isDragging(row.song.path) ? 'none' : '',
            }"
            @click="onRowClick(row)"
          >
            <div class="msv-cover">
              <img
                v-if="coverOk(row.song.path)"
                :src="coverSrc(row.song.path)"
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
                  <span class="eq-bar"></span><span class="eq-bar"></span
                  ><span class="eq-bar"></span>
                </span>
              </div>
              <div class="msv-sub">
                {{ row.song.artist }}<template v-if="sub(row)"> · {{ sub(row) }}</template>
              </div>
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
import { ChevronLeft, Music2, Heart, Trash2 } from "@lucide/vue";
import {
  state,
  isFavorite,
  toggleFavorite,
  removeFromQueue,
  findSongIndex,
} from "../../composables/usePlayer.js";
import { showToast, toastError } from "../../composables/useToast.js";
import { useSwipeReveal } from "../../composables/useSwipe.js";
import {
  SMART_VIEWS,
  smartViewState,
  loadSmartView,
  playSmartRow,
  fmtSmartSub,
} from "../../composables/useSmartViews.js";
import { resolveServerUrl } from "../../utils/apiClient.js";

const { t } = useI18n();

// 封面 URL（iOS 壳 file:// 下相对路径需转服务器绝对 URL；桌面同源原样返回）
const coverSrc = (path) => resolveServerUrl("/api/cover?path=" + encodeURIComponent(path));

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

// 点击行：刚滑完的点击忽略；已展开的行点击 = 收起；否则播放并打开全屏播放器（与 MobileShell.playFromList 一致）
function onRowClick(row) {
  const path = row.song.path;
  if (consumeSwipe(path)) return;
  if (isOpen(path)) {
    swipe.close();
    return;
  }
  if (!playSmartRow(row)) return;
  emit("open-player");
}

// ============ 左滑操作（swipe-reveal：收藏 / 移除） ============
// 事件委托挂在 .msv-list 上（passive: false，横向判定后才 preventDefault，不抢纵向滚动）
const listEl = ref(null);
const swipe = useSwipeReveal(listEl, { rowSelector: ".msv-item" });
const { isOpen, isDragging, rowTransform, consumeSwipe } = swipe;

// 操作区收藏：与列表页同一函数（乐观更新），静默不打扰
async function actFavorite(path) {
  await toggleFavorite(path);
  swipe.close();
}

// 操作区移除：智能视图行对应队列歌曲 → 从队列移除（与桌面非歌单视图语义一致）
async function actRemove(row) {
  try {
    const idx = findSongIndex(row.song);
    if (idx >= 0) removeFromQueue(idx);
    showToast(t("mobile.list.removed"));
  } catch (e) {
    toastError(e.message);
  }
  swipe.close();
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
/* 左滑操作：行容器（裁切操作区）+ 操作按钮层 + 行内容（左移露出操作区） */
.msv-wrap {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
}
.msv-actions {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: stretch;
  width: 168px;
}
.msv-act {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: var(--card2);
  touch-action: manipulation;
}
.msv-act.on {
  color: var(--red);
}
.msv-act-remove {
  background: color-mix(in srgb, var(--red) 82%, #000);
}
.msv-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: 12px;
  cursor: pointer;
  background: linear-gradient(160deg, var(--bg), var(--bg2)); /* 不透明底：左移时遮住下方操作区 */
  transition:
    background 0.12s,
    transform 0.22s ease; /* 展开/收起过渡；跟手时由内联 transition:none 接管 */
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
