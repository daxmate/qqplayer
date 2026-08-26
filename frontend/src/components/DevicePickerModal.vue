<template>
  <Teleport to="body">
    <div v-if="open" class="dp-mask" @mousedown.self="close">
      <div
        class="dp-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('playlist.devicePicker.title')"
      >
        <h3 class="dp-title">
          <Send :size="15" />
          {{ t("playlist.devicePicker.title") }}
        </h3>
        <div v-if="!devices.length" class="dp-empty">{{ t("playlist.devicePicker.empty") }}</div>
        <div v-else class="dp-list">
          <button
            v-for="d in devices"
            :key="d.device_id"
            class="dp-item"
            :class="{ on: pickedId === d.device_id }"
            :data-testid="'dp-device-' + d.device_id"
            @click="pickedId = d.device_id"
          >
            <Smartphone :size="15" class="dp-item-icon" />
            <span class="dp-item-main">
              <span class="dp-item-name">{{ nameOf(d) }}</span>
              <span class="dp-item-meta">
                {{ t("settings.deviceLastSeen") }} {{ fmtLastSeen(d.last_seen) }} ·
                {{ t("settings.deviceTotal") }} {{ formatBytes(d.total) }}
              </span>
            </span>
          </button>
        </div>
        <div class="dp-btns">
          <button class="dp-btn" @click="close">{{ t("common.cancel") }}</button>
          <button class="dp-btn primary" :disabled="!pickedId" @click="confirm">
            {{ t("playlist.devicePicker.confirm") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Send, Smartphone } from "@lucide/vue";
import { formatBytes, formatLastSeen } from "../utils/deviceCommands.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  devices: { type: Array, default: () => [] },
});
const emit = defineEmits(["close", "select"]);

const { t } = useI18n();

// 打开时复位选中（避免上次残留）；devices 变化时若选中项消失则清空
const pickedId = ref("");
watch(
  () => props.open,
  (o) => {
    if (o) pickedId.value = "";
  },
);
watch(
  () => props.devices,
  (list) => {
    if (!list.some((d) => d.device_id === pickedId.value)) pickedId.value = "";
  },
);

// 展示名：device_name 非空用设备名，空则取 device_id 前 8 位
function nameOf(d) {
  if (d && d.device_name && String(d.device_name).trim()) return String(d.device_name).trim();
  return d && d.device_id ? String(d.device_id).slice(0, 8) : t("settings.noDevices");
}

function fmtLastSeen(iso) {
  return formatLastSeen(iso, {
    justNow: t("settings.deviceJustNow"),
    minutesAgo: (n) => t("settings.deviceMinutesAgo", { n }),
    yesterday: t("settings.deviceYesterday"),
  });
}

function close() {
  emit("close");
}

function confirm() {
  const d = props.devices.find((x) => x.device_id === pickedId.value);
  if (!d) return;
  emit("select", d);
  pickedId.value = "";
}
</script>

<style scoped>
.dp-mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 120;
}
.dp-dialog {
  width: min(400px, calc(100vw - 40px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 20px 60px var(--shadow-strong);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: min(480px, calc(100vh - 60px));
}
.dp-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
}
.dp-title svg {
  color: var(--accent);
}
.dp-empty {
  font-size: 12.5px;
  color: var(--text3);
  padding: 20px 0;
  text-align: center;
}
.dp-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  min-height: 0;
}
.dp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: var(--card2);
  text-align: left;
  transition: all 0.15s;
}
.dp-item-icon {
  color: var(--text2);
  flex-shrink: 0;
}
.dp-item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dp-item-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.dp-item-meta {
  font-size: 11.5px;
  color: var(--text3);
}
@media (hover: hover) {
  .dp-item:hover {
    border-color: var(--border);
  }
}
.dp-item.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--card2));
}
.dp-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dp-btn {
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  background: var(--card2);
  transition: all 0.15s;
}
@media (hover: hover) {
  .dp-btn:hover {
    color: var(--text);
  }
}
.dp-btn.primary {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.dp-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
