<template>
  <div class="videos-view">
    <!-- 播放器 ↔ 视频库/在线切换（仿 books：BooksView 的 Reader/Bookshelf 切换） -->
    <VideoPlayer v-if="active" :key="activeKey" :video="active" @close="onClose" />
    <template v-else>
      <!-- 在线源地址栏（videos tab 顶部常驻）：粘贴链接 → 解析 -->
      <div class="vo-bar">
        <Link2 :size="14" class="vo-bar-icon" />
        <input
          v-model="url"
          class="vo-url-input"
          type="text"
          :placeholder="t('videos.onlinePlaceholder')"
          spellcheck="false"
          @keyup.enter="resolve"
        />
        <button class="vo-resolve-btn" :disabled="resolving || !url.trim()" @click="resolve">
          <Loader2 v-if="resolving" :size="14" class="spin" />
          {{ resolving ? t("videos.resolving") : t("videos.resolve") }}
        </button>
      </div>

      <!-- 本地库 / 在线 子视图切换 -->
      <div class="vo-seg">
        <button class="vo-seg-btn" :class="{ on: tab === 'local' }" @click="tab = 'local'">
          <Library :size="13" />
          {{ t("videos.localTab") }}
        </button>
        <button class="vo-seg-btn" :class="{ on: tab === 'online' }" @click="tab = 'online'">
          <Globe :size="13" />
          {{ t("videos.onlineTab") }}
        </button>
      </div>

      <!-- 内容区：本地视频库 / 在线解析结果 -->
      <VideoLibrary v-if="tab === 'local'" @open="onOpen" />
      <VideoOnline
        v-else
        :resolving="resolving"
        :result="result"
        :error="resolveError"
        @play="onOpen"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { Link2, Loader2, Library, Globe } from "@lucide/vue";
import VideoLibrary from "./VideoLibrary.vue";
import VideoOnline from "./VideoOnline.vue";
import VideoPlayer from "./VideoPlayer.vue";
import type { OnlineVideo, VideoSource } from "./types";
import { resolveOnline } from "./api";

const { t } = useI18n();

const active = ref<VideoSource | null>(null);
// 每开一个新视频重建播放器（重置状态 + 重新拉字幕）
const activeKey = ref(0);

// ============ 在线源地址栏状态 ============
const url = ref("");
const resolving = ref(false);
const result = ref<OnlineVideo | null>(null);
const resolveError = ref("");
// 子视图：'local' 本地库（默认，零回归） | 'online' 在线解析
const tab = ref<"local" | "online">("local");

const HTTP_URL_RE = /^https?:\/\//i;

async function resolve() {
  const u = url.value.trim();
  if (!u || resolving.value) return;
  if (!HTTP_URL_RE.test(u)) {
    resolveError.value = t("videos.invalidUrl");
    result.value = null;
    tab.value = "online";
    return;
  }
  resolving.value = true;
  resolveError.value = "";
  try {
    result.value = await resolveOnline(u);
    tab.value = "online";
  } catch (e) {
    // 后端 400 带 detail（如「解析失败: …」）直接展示
    resolveError.value = e instanceof Error ? e.message : String(e);
    result.value = null;
    tab.value = "online";
  } finally {
    resolving.value = false;
  }
}

function onOpen(video: VideoSource) {
  active.value = video;
  activeKey.value += 1;
}

function onClose() {
  active.value = null;
}

// 本地加载的 object URL 生命周期由 VideoPlayer 卸载时释放；这里兜底（如组件被销毁）
onUnmounted(() => {
  const a = active.value;
  if (a && "localUrl" in a) URL.revokeObjectURL(a.localUrl);
});
</script>

<style scoped>
.videos-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* 在线源地址栏：常驻顶部（videos tab 下方） */
.vo-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 2px;
}
.vo-bar-icon {
  flex-shrink: 0;
  color: var(--text3);
}
.vo-url-input {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}
.vo-url-input:focus {
  border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
}
.vo-url-input::placeholder {
  color: var(--text3);
}
.vo-resolve-btn {
  flex-shrink: 0;
  height: 36px;
  padding: 0 18px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s;
}
.vo-resolve-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}
.vo-resolve-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.vo-resolve-btn .spin {
  animation: vo-btn-spin 0.9s linear infinite;
}
@keyframes vo-btn-spin {
  to {
    transform: rotate(360deg);
  }
}
/* 本地库 / 在线 子视图切换 */
.vo-seg {
  flex-shrink: 0;
  display: inline-flex;
  align-self: flex-start;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: var(--card2);
  border: 1px solid var(--border);
  margin-bottom: 10px;
}
.vo-seg-btn {
  height: 28px;
  padding: 0 14px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text2);
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.15s;
}
.vo-seg-btn:hover {
  color: var(--text);
}
.vo-seg-btn.on {
  background: var(--card);
  color: var(--accent-text);
  box-shadow: 0 1px 4px var(--shadow-sm);
}
</style>
