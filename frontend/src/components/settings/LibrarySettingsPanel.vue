<!-- 音乐库设置面板（SettingsModal 拆分 · P3）：库路径 + 扩展名
  注册表条目由 entriesByCategory + pickIds 计算（与拆分前 SettingsModal 一致）；
  路径输入/保存/浏览（原生壳 NSOpenPanel 桥）与扩展名 chips 为面板内部实现；
  保存防抖 saveLib 与库路径保存共用 error（路径保存失败/设置保存失败都显示在此面板）；
  通用样式由 SettingsModal :deep 穿透继承。 -->
<template>
  <div class="group">
    <div class="group-title">
      <FolderOpen :size="13" />
      {{ t("settings.library") }}
    </div>
    <div class="setting-item">
      <div class="setting-label">{{ t("settings.libraryFolder") }}</div>
      <div class="setting-desc">{{ t("settings.libraryFolderDesc") }}</div>
      <div class="setting-control">
        <input
          v-model="libInput"
          class="lib-input"
          placeholder="/Users/xxx/Music"
          @keyup.enter="save"
        />
        <button v-if="isNative" class="btn" @click="browseLibrary">
          {{ t("settings.browse") }}
        </button>
        <button class="btn primary" :disabled="saving" @click="save">
          {{ saving ? t("settings.saving") : t("common.save") }}
        </button>
      </div>
      <div v-if="error" class="setting-error">{{ error }}</div>
    </div>
  </div>

  <div class="group">
    <div class="group-title">
      <FileAudio :size="13" />
      {{ t("settings.fileTypes") }}
    </div>
    <template v-for="e in libraryFiles" :key="e.id">
      <SettingRow v-if="!e.render" :entry="e" />
      <!-- 音频格式多选 chips（audioExts 数组，至少保留一种） -->
      <div v-else-if="e.id === 'audioExts'" class="setting-item">
        <div class="setting-desc">{{ t("settings.fileTypesDesc") }}</div>
        <div v-if="librarySettings" class="ext-grid">
          <button
            v-for="ext in audioExtOptions"
            :key="ext"
            class="ext-chip"
            :class="{ on: librarySettings.audioExts.includes(ext) }"
            @click="toggleExt(ext)"
          >
            {{ ext.slice(1).toUpperCase() }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { useShellBridge } from "../../composables/useShellBridge.js";
import { FolderOpen, FileAudio } from "@lucide/vue";
import {
  state,
  setLibrary,
  loadLibrary,
  loadLibrarySettings,
  saveLibrarySettings,
} from "../../composables/usePlayer.js";
import SettingRow from "../SettingRow.vue";
import { entriesByCategory, type SettingEntry } from "../../settingsIndex";

const { t } = useI18n();
const emit = defineEmits(["close"]);

const libInput = ref("");
const saving = ref(false);
const error = ref("");

// 原生壳环境（Swift 主窗口 WKWebView 注入 window.qqplayerNative）：切库走 NSOpenPanel 桥
// （WKWebView 沙箱不支持 <input webkitdirectory>，浏览按钮只在桌面版显示）
const isNative = typeof window !== "undefined" && !!(window as any).qqplayerNative;

function browseLibrary() {
  useShellBridge().pickLibrary();
}

// 原生壳切库完成 → 同步输入框与当前库路径（Swift POST /api/library 后派发 CustomEvent）
function onNativeLibrary(e: any) {
  const p = e?.detail?.path;
  if (!p) return;
  libInput.value = p;
  loadLibrary();
}

// 音乐库设置（后端持久化）：模板里用 computed 解包，null=还没加载
const librarySettings = computed<any>(() => state.librarySettings);
const audioExtOptions = [".mp3", ".flac", ".m4a", ".wav", ".ogg", ".aac", ".opus"];
// 保存防抖：连续点开关/格式时合并成一次请求（patch 累积不丢）
let libSaveTimer: ReturnType<typeof setTimeout> | null = null;
let libPatch = {};

function saveLib(patch: Record<string, unknown>) {
  error.value = "";
  Object.assign(libPatch, patch);
  if (libSaveTimer) clearTimeout(libSaveTimer);
  libSaveTimer = setTimeout(async () => {
    const p = libPatch;
    libPatch = {};
    try {
      await saveLibrarySettings(p);
    } catch (e) {
      error.value = (e as Error).message;
    }
  }, 300);
}

function toggleExt(ext: string) {
  if (!librarySettings.value) return;
  const cur = librarySettings.value.audioExts;
  const next = cur.includes(ext) ? cur.filter((e: string) => e !== ext) : [...cur, ext];
  if (!next.length) return; // 至少保留一种格式，防止扫不出任何歌
  saveLib({ audioExts: next });
}

// 分组：注册表顺序渲染（与拆分前 SettingsModal 一致）；render 标记的复合项按 id 分发手写块
const pickIds = (arr: SettingEntry[], ids: string[]) => arr.filter((e) => ids.includes(e.id));
const libraryEntries = entriesByCategory("library");
const libraryFiles = pickIds(libraryEntries, [
  "audioExts",
  "ignoreHidden",
  "autoRefresh",
  "autoScanOnStart",
]);

async function save() {
  const p = libInput.value.trim();
  if (!p) return;
  saving.value = true;
  error.value = "";
  try {
    await setLibrary(p);
    emit("close");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

// 挂载时同步库路径与音乐库设置（与拆分前容器 watch(open) 语义一致：
// 打开弹窗时拉取；嵌入式常驻实例由 :key 重挂触发）
onMounted(() => {
  loadLibrary().then(() => {
    libInput.value = state.libraryPath;
  });
  loadLibrarySettings();
  window.addEventListener("qqplayer:nativelibrary", onNativeLibrary);
});
onBeforeUnmount(() => {
  window.removeEventListener("qqplayer:nativelibrary", onNativeLibrary);
});
</script>
