<!-- 局域网同步（S2 · web）内容同步容器：选目标设备 + 推送 / 取回两个子面板。
     会话语义（设计 §12b）：发起方恒为桌面端；**不传播删除**；**不做全库镜像**（取回 = 点名集合）。 -->
<template>
  <div class="group">
    <div class="group-title">
      <ArrowLeftRight :size="13" />
      {{ t("lansync.contentTitle") }}
    </div>
    <div class="setting-item">
      <div class="setting-label">{{ t("lansync.contentDevice") }}</div>
      <div class="setting-desc">{{ t("lansync.contentDeviceHint") }}</div>
      <div class="setting-control">
        <select
          v-model="selectedPeerId"
          class="lansync-select"
          data-testid="lansync-content-device"
          :disabled="!devices.length"
        >
          <option v-for="d in devices" :key="d.peer_id" :value="d.peer_id">
            {{ d.display_name || d.peer_id }}
            {{ d.online ? `· ${t("lansync.online")}` : `· ${t("lansync.offline")}` }}
          </option>
        </select>
      </div>
      <div
        v-if="!devices.length"
        class="setting-desc lansync-muted"
        data-testid="lansync-content-nodevice"
      >
        {{ t("lansync.contentNoDevice") }}
      </div>
      <div
        v-else-if="!running"
        class="setting-desc lansync-muted"
        data-testid="lansync-content-stopped"
      >
        {{ t("lansync.contentServiceStopped") }}
      </div>
      <div v-else class="setting-desc lansync-muted">{{ t("lansync.contentHint") }}</div>
    </div>
  </div>

  <template v-if="peerId && running">
    <div class="group">
      <div class="setting-item">
        <div class="lansync-seg" role="tablist">
          <button
            class="lansync-seg-btn"
            :class="{ on: mode === 'push' }"
            data-testid="lansync-content-push-tab"
            @click="mode = 'push'"
          >
            {{ t("lansync.contentPushTab") }}
          </button>
          <button
            class="lansync-seg-btn"
            :class="{ on: mode === 'pull' }"
            data-testid="lansync-content-pull-tab"
            @click="mode = 'pull'"
          >
            {{ t("lansync.contentPullTab") }}
          </button>
        </div>
      </div>
    </div>

    <LanSyncPushPanel v-if="mode === 'push'" :peer-id="peerId" :device-online="deviceOnline" />
    <LanSyncPullPanel v-else :peer-id="peerId" :device-online="deviceOnline" />
  </template>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeftRight } from "@lucide/vue";
import LanSyncPushPanel from "./LanSyncPushPanel.vue";
import LanSyncPullPanel from "./LanSyncPullPanel.vue";
import type { LanSyncDevice } from "../../composables/useLanSync.js";

const props = defineProps<{ devices: LanSyncDevice[]; running: boolean }>();

const { t } = useI18n();
const mode = ref<"push" | "pull">("push");
const selectedPeerId = ref("");

/** 默认选在线设备，其次第一台（设备列表刷新时保持用户选择） */
function pickDefault(list: LanSyncDevice[]): string {
  const online = list.find((d) => d.online);
  return (online || list[0])?.peer_id || "";
}

watch(
  () => props.devices.map((d) => d.peer_id).join(","),
  () => {
    const stillThere = props.devices.some((d) => d.peer_id === selectedPeerId.value);
    if (!stillThere) selectedPeerId.value = pickDefault(props.devices);
  },
  { immediate: true },
);

const peerId = computed(() => selectedPeerId.value);
const deviceOnline = computed(
  () => props.devices.find((d) => d.peer_id === selectedPeerId.value)?.online !== false,
);
</script>

<style scoped>
.lansync-seg {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: var(--bg2);
  border: 1px solid var(--border);
}
.lansync-seg-btn {
  flex: 1;
  font-size: 12px;
  padding: 5px 6px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--text2);
  cursor: pointer;
}
.lansync-seg-btn.on {
  background: var(--card);
  color: var(--text);
  font-weight: 600;
}
.lansync-select {
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text);
  width: 100%;
}
.lansync-muted {
  color: var(--text3);
}
</style>
