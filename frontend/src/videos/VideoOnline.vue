<template>
  <div class="vo-online">
    <!-- 解析中 -->
    <div v-if="resolving" class="vo-state">
      <Loader2 :size="40" class="spin" />
      <span>{{ t("videos.resolving") }}</span>
    </div>

    <!-- 解析失败（后端 400 带原因） -->
    <div v-else-if="error" class="vo-state vo-error">
      <AlertCircle :size="40" />
      <span>{{ t("videos.resolveError") }}</span>
      <p class="vo-error-detail">{{ error }}</p>
    </div>

    <!-- 解析结果卡片：标题 / provider / 时长 / 字幕语言标签；点击进播放器 -->
    <div v-else-if="result" class="vo-result">
      <button class="vo-card" :title="t('videos.onlinePlayHint')" @click="emit('play', result)">
        <span class="vo-thumb">
          <Clapperboard :size="24" />
        </span>
        <span class="vo-meta">
          <span class="vo-title">{{ result.title || t("videos.untitled") }}</span>
          <span class="vo-sub">
            <span class="vo-provider">{{ result.provider }}</span>
            <template v-if="result.duration">
              <span class="vo-dot">·</span>
              {{ fmtDuration(result.duration) }}
            </template>
          </span>
          <span v-if="result.subtitles && result.subtitles.length" class="vo-tags">
            <span v-for="s in result.subtitles" :key="s.lang" class="vo-tag" :title="s.name">
              {{ t("videos.cc") }} · {{ s.name }}
            </span>
          </span>
        </span>
        <Play :size="15" class="vo-play-hint" />
      </button>
      <p class="vo-hint">{{ t("videos.onlinePlayHint") }}</p>
    </div>

    <!-- 空态引导 -->
    <div v-else class="vo-state">
      <Globe :size="40" />
      <span>{{ t("videos.resolveEmpty") }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Play, Loader2, AlertCircle, Globe, Clapperboard } from "@lucide/vue";
import type { OnlineVideo } from "./types";

defineProps<{
  /** 解析请求进行中（地址栏按钮 loading 同步） */
  resolving: boolean;
  /** 解析成功的结果；null = 还没解析成功 */
  result: OnlineVideo | null;
  /** 解析失败错误文案（空 = 无错误） */
  error: string;
}>();

const emit = defineEmits<{ play: [video: OnlineVideo] }>();
const { t } = useI18n();

/** 秒 → 播放器同款时间格式（<1h 用 M:SS，≥1h 用 H:MM:SS） */
function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
</script>

<style scoped>
.vo-online {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 2px 16px;
}
.vo-state {
  height: 100%;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text3);
  font-size: 13.5px;
}
.vo-state svg {
  opacity: 0.55;
}
.vo-state .spin {
  animation: vo-spin 0.9s linear infinite;
}
@keyframes vo-spin {
  to {
    transform: rotate(360deg);
  }
}
.vo-error {
  color: var(--danger, #e5484d);
}
.vo-error-detail {
  max-width: 420px;
  font-size: 12.5px;
  color: var(--text3);
  text-align: center;
  line-height: 1.5;
  word-break: break-all;
  margin: 0;
}
.vo-result {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 结果卡片：点击进播放器（仿 vl-card） */
.vo-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--card);
  border: 1px solid var(--border);
  text-align: left;
  transition: all 0.15s;
  min-width: 0;
}
.vo-card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  transform: translateY(-2px);
  box-shadow: 0 6px 16px var(--shadow-sm);
}
.vo-thumb {
  width: 56px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 8px;
  background: var(--bg2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
}
.vo-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.vo-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vo-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text3);
  font-variant-numeric: tabular-nums;
}
.vo-provider {
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 700;
}
.vo-dot {
  opacity: 0.6;
}
.vo-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.vo-tag {
  padding: 2px 8px;
  border-radius: 8px;
  background: var(--card2);
  border: 1px solid var(--border);
  color: var(--text2);
  font-size: 11.5px;
  font-weight: 600;
}
.vo-play-hint {
  flex-shrink: 0;
  color: var(--text3);
  opacity: 0;
  transition: all 0.15s;
}
.vo-card:hover .vo-play-hint {
  opacity: 1;
  color: var(--accent-text);
}
.vo-hint {
  margin: 0;
  text-align: center;
  font-size: 12px;
  color: var(--text3);
}
</style>
