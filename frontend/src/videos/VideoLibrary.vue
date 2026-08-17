<template>
  <div class="video-library">
    <!-- 工具栏：标题 + 加载文件入口 -->
    <div class="vl-toolbar">
      <h2 class="vl-title">{{ t("videos.title") }}</h2>
      <button class="vl-load-btn" @click="openFilePicker">
        <FolderInput :size="15" />
        {{ t("videos.loadFile") }}
      </button>
    </div>

    <!-- 视频列表 -->
    <div v-if="videos.length" class="vl-list">
      <button
        v-for="video in videos"
        :key="video.path"
        class="vl-card"
        :title="video.name"
        @click="emit('open', video)"
      >
        <span class="vl-thumb">
          <Video :size="26" class="vl-thumb-icon" />
        </span>
        <span class="vl-meta">
          <span class="vl-name">{{ video.name }}</span>
          <span class="vl-sub">
            {{ formatSize(video.size) }}
            <template v-if="video.mtime"> · {{ formatMtime(video.mtime) }}</template>
          </span>
        </span>
        <Play :size="15" class="vl-play-hint" />
      </button>
    </div>

    <!-- 空态引导 -->
    <div v-else class="vl-empty">
      <Video :size="46" class="vl-empty-icon" />
      <p class="vl-empty-title">{{ t("videos.empty") }}</p>
      <p class="vl-empty-hint">{{ t("videos.emptyHint") }}</p>
      <button class="vl-load-btn" @click="openFilePicker">
        <FolderInput :size="15" />
        {{ t("videos.loadFile") }}
      </button>
    </div>

    <!-- 隐藏文件选择（本地加载：不进库、不传后端） -->
    <input
      ref="fileInput"
      class="vl-file-input"
      type="file"
      accept="video/*,.mkv,.webm,.mov,.mp4,.avi,.flv,.ts,.m4v"
      @change="onFilePicked"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Video, Play, FolderInput } from "@lucide/vue";
import type { LocalVideo, VideoItem } from "./types";
import { fetchVideos } from "./api";
import { showToast, toastError } from "../composables/useToast.js";

const emit = defineEmits<{ open: [video: VideoItem | LocalVideo] }>();
const { t } = useI18n();

const videos = ref<VideoItem[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMtime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function load() {
  try {
    videos.value = await fetchVideos();
  } catch {
    toastError(t("videos.loadError"));
  }
}

function openFilePicker() {
  fileInput.value?.click();
}

// 本地加载：File API 生成 object URL 直接播（不进库、不传后端，刷新即失）
function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 允许重复选择同一文件
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    toastError(t("videos.loadInvalid"));
    return;
  }
  const local: LocalVideo = {
    name: file.name,
    localUrl: URL.createObjectURL(file),
  };
  showToast(t("videos.loadDone", { name: file.name }));
  emit("open", local);
}

onMounted(load);
</script>

<style scoped>
.video-library {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.vl-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 2px 12px;
}
.vl-title {
  font-size: 16px;
  font-weight: 700;
}
.vl-load-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s;
  flex-shrink: 0;
}
.vl-load-btn:hover {
  filter: brightness(1.08);
}
.vl-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  align-content: start;
  padding: 2px;
}
.vl-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--card);
  border: 1px solid var(--border);
  text-align: left;
  transition: all 0.15s;
  min-width: 0;
}
.vl-card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  transform: translateY(-2px);
  box-shadow: 0 6px 16px var(--shadow-sm);
}
.vl-thumb {
  width: 52px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 8px;
  background: var(--bg2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
}
.vl-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.vl-name {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vl-sub {
  font-size: 12px;
  color: var(--text3);
  font-variant-numeric: tabular-nums;
}
.vl-play-hint {
  flex-shrink: 0;
  color: var(--text3);
  opacity: 0;
  transition: all 0.15s;
}
.vl-card:hover .vl-play-hint {
  opacity: 1;
  color: var(--accent-text);
}
.vl-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text3);
}
.vl-empty-icon {
  opacity: 0.55;
}
.vl-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text2);
}
.vl-empty-hint {
  font-size: 12.5px;
  margin-bottom: 8px;
}
.vl-file-input {
  display: none;
}
</style>
