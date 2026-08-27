<!-- 快捷键设置面板（SettingsModal 拆分 · P3）：快捷键 + 录制交互 + 媒体键说明
  录制按键监听（capture 阶段）在面板挂载/卸载时绑定/解绑（进入快捷键 tab 才监听，
  与拆分前容器常驻监听等价——录制状态仅快捷键 tab 内可达）；通用样式由
  SettingsModal :deep 继承（.hint），shortcut-* 专属样式 scoped。 -->
<template>
  <div class="group">
    <div class="group-title">
      <Keyboard :size="13" />
      {{ t("settings.keyboardShortcuts") }}
    </div>
    <div v-for="cat in SHORTCUT_CATEGORIES" :key="cat.key" class="shortcut-cat">
      <div class="group-title sub-title">
        {{ t(cat.labelKey) }}
        <span class="sub-note">{{ t("settings.clickToRecord") }}</span>
      </div>
      <div
        v-for="s in shortcutsOf(cat.key)"
        :key="s.id"
        class="shortcut-item editable"
        :class="{ recording: recording === s.id }"
        :title="t('settings.clickToSetKey')"
        @click="startRecord(s.id)"
      >
        <span class="shortcut-desc">{{ t(s.labelKey) }}</span>
        <span class="shortcut-keys">
          <kbd v-if="recording === s.id" class="recording-kbd">{{ t("settings.pressNewKey") }}</kbd>
          <kbd v-else>{{ fmtSetting(s) }}</kbd>
        </span>
      </div>
    </div>
    <div class="setting-desc hint">{{ t("settings.recordHintAll") }}</div>
  </div>
  <div class="group">
    <div class="group-title">
      <MonitorPlay :size="13" />
      {{ t("settings.mediaKeys") }}
    </div>
    <div class="shortcut-item">
      <span class="shortcut-desc">{{ t("settings.mediaKeysDesc") }}</span>
      <span class="shortcut-keys">
        <kbd>{{ t("settings.mediaPlayPause") }}</kbd>
        <kbd>{{ t("settings.mediaPrev") }}</kbd>
        <kbd>{{ t("settings.mediaNext") }}</kbd>
        <kbd>{{ t("settings.mediaStop") }}</kbd>
      </span>
    </div>
    <div class="setting-desc hint">
      {{ t("settings.mediaKeysHint") }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Keyboard, MonitorPlay } from "@lucide/vue";
import {
  playbackSettings,
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  fmtShortcutKey,
  parseShortcutCombo,
} from "../../composables/usePlayer.js";
import { showToast } from "../../composables/useToast.js";

const { t } = useI18n();

// 快捷键 tab：配置表驱动（SHORTCUTS/SHORTCUT_CATEGORIES 来自 playerCore；全部行可录制）
const recording = ref<string | null>(null); // 正在录制的快捷键 id（null = 未录制）

function startRecord(id: string) {
  recording.value = id;
}

// 当前组合显示（录制值 → 展示文本；⌘ 组合显示 ⌘← 等）
function fmtSetting(s: any) {
  return fmtShortcutKey((playbackSettings as any)[s.settingKey] || s.defaultCode);
}

function shortcutsOf(catKey: string) {
  return SHORTCUTS.filter((s) => s.category === catKey);
}

// capture 阶段拦截：录制时按键不触发播放快捷键（stopImmediatePropagation 挡住 bubble 阶段的 SHORTCUT_HANDLER）
function onRecordKeydown(e: KeyboardEvent) {
  if (!recording.value) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  if (e.key === "Escape" || e.key === "Enter") {
    recording.value = null; // 取消录制，保留原键
    return;
  }
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(e.key)) return; // 纯修饰键不绑定（e.key 匹配 MetaLeft/ControlLeft 等）
  const target = SHORTCUTS.find((s) => s.id === recording.value);
  if (!target) {
    recording.value = null;
    return;
  }
  const combo = (e.metaKey ? "Meta+" : "") + e.code;
  // 冲突检测：组合已绑定其他快捷键 → toast 拒绝保存（“Meta+K”与“Meta+KeyK”视作同一组合）
  const conflict = SHORTCUTS.find((s) => {
    if (s.id === target.id) return false;
    return comboEq(combo, (playbackSettings as any)[s.settingKey] || s.defaultCode);
  });
  if (conflict) {
    showToast(t("settings.shortcutConflict", { name: t(conflict.labelKey) }), { type: "error" });
    recording.value = null;
    return;
  }
  (playbackSettings as any)[target.settingKey] = combo;
  recording.value = null;
}

// 组合等价比较（parseShortcutCombo 归一化，兼容历史 "Meta+K" 格式）
function comboEq(a: string, b: string) {
  const pa = parseShortcutCombo(a);
  const pb = parseShortcutCombo(b);
  if (!pa || !pb) return a === b;
  return pa.meta === pb.meta && pa.code === pb.code;
}

onMounted(() => {
  window.addEventListener("keydown", onRecordKeydown, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onRecordKeydown, true);
});
</script>

<style scoped>
/* 快捷键 */
.shortcut-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.shortcut-item:last-of-type {
  border-bottom: none;
}
.sub-title {
  margin-top: 14px;
}
.shortcut-cat + .shortcut-cat {
  margin-top: 10px;
}
.sub-note {
  margin-left: auto;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text2);
}
.shortcut-item.editable {
  cursor: pointer;
  border-radius: 8px;
  padding: 9px 8px;
  margin: 0 -8px;
  transition: background 0.15s;
  border-bottom-color: transparent;
}
@media (hover: hover) {
  .shortcut-item.editable:hover {
    background: rgba(127, 127, 127, 0.08);
  }
}
.shortcut-item.editable.recording {
  background: rgba(255, 107, 107, 0.1);
}
.recording-kbd {
  color: #ff6b6b;
  animation: kbd-blink 1s ease-in-out infinite;
}
@keyframes kbd-blink {
  50% {
    opacity: 0.45;
  }
}
.shortcut-desc {
  font-size: 13px;
  color: var(--text);
}
.shortcut-keys {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
kbd {
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  background: var(--bg2);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 6px;
  padding: 3px 8px;
  min-width: 22px;
  text-align: center;
}
</style>
