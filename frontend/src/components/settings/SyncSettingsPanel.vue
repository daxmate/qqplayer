<!-- 同步设备面板（SettingsModal 拆分 · P3）：iOS 壳负一屏同步中心入口 + 桌面端设备管理面板
  整段由容器 sync section 搬入（含 open-sync 分支与设备/指令历史区块、删除资产确认弹窗）；
  embedded prop 由容器透传（嵌入式负一屏模式显示设备管理面板）；面板挂载时拉取
  设备清单 + 指令历史（与拆分前容器 watch(tab) 语义一致）；sync-* 专属样式 scoped。 -->
<template>
  <template v-if="!embedded && isNative && isMobile">
    <div class="group">
      <div class="group-title">
        <RefreshCw :size="13" />
        {{ t("settings.sync") }}
      </div>
      <div class="setting-item">
        <div class="setting-label">{{ t("settings.openSyncCenter") }}</div>
        <div class="setting-desc">{{ t("settings.openSyncCenterDesc") }}</div>
        <div class="setting-control">
          <button class="btn primary" @click="$emit('open-sync')">
            {{ t("settings.openSyncCenterGo") }}
          </button>
        </div>
      </div>
    </div>
  </template>
  <div v-else class="group">
    <div class="group-title">
      <MonitorSmartphone :size="13" />
      {{ t("settings.devicePanelTitle") }}
    </div>
    <div class="setting-item">
      <div class="setting-desc">{{ t("settings.devicePanelDesc") }}</div>
    </div>

    <!-- 加载失败兑底（后端未启动等） -->
    <div v-if="syncPanelError" class="setting-item">
      <div class="setting-desc sync-error">{{ syncPanelError }}</div>
      <div class="setting-control">
        <button class="btn" @click="loadDevicePanel">
          {{ t("settings.refresh") }}
        </button>
      </div>
    </div>
    <div v-else-if="syncPanelLoading" class="setting-item">
      <div class="setting-desc">{{ t("settings.devicePanelLoading") }}</div>
    </div>
    <template v-else>
      <!-- ============ 设备区块 ============ -->
      <div v-if="!syncDevices.length" class="setting-item">
        <div class="setting-label">{{ t("settings.noDevices") }}</div>
        <div class="setting-desc">{{ t("settings.noDevicesHint") }}</div>
      </div>
      <div
        v-for="d in syncDevices"
        :key="d.device_id"
        class="sync-device"
        :data-testid="'sync-device-' + d.device_id"
      >
        <div class="sync-device-head" @click="toggleDeviceAssets(d)">
          <ChevronRight :size="14" class="sync-chevron" :class="{ open: deviceExpanded(d) }" />
          <Smartphone :size="14" class="sync-device-icon" />
          <span class="sync-device-name">{{ deviceName(d) }}</span>
          <span class="sync-device-meta">
            {{ t("settings.deviceLastSeen") }} {{ fmtLastSeen(d.last_seen) }}
          </span>
        </div>
        <div class="sync-device-stats">
          <span class="sync-stat">
            {{ t("settings.deviceTotal") }}：{{ formatBytes(d.total) }} ·
            {{ t("settings.deviceFiles", { n: assetCount(d) }) }}
          </span>
          <span v-for="(n, k) in byTypeEntries(d)" :key="k" class="sync-type-chip">
            {{ t("settings.deviceType." + k) }} {{ n }}
          </span>
        </div>
        <!-- 资产列表（懒渲染：展开时才挂 DOM） -->
        <div v-if="deviceExpanded(d)" class="sync-assets">
          <div v-if="!assetList(d).length" class="setting-desc">
            {{ t("settings.deviceNoAssets") }}
          </div>
          <label v-for="a in assetList(d)" :key="a.path" class="sync-asset-row">
            <input
              type="checkbox"
              :checked="assetSelected(d.device_id, a.path)"
              @change="toggleAsset(d.device_id, a.path)"
            />
            <span class="sync-asset-path" :title="a.path">{{ a.path }}</span>
            <span class="sync-asset-size">{{ formatBytes(a.size) }}</span>
          </label>
          <div v-if="selectedAssetCount(d.device_id)" class="sync-asset-actions">
            <button class="btn danger" :disabled="syncDeleting" @click="askDeleteAssets(d)">
              {{ t("settings.deleteAssets") }} ({{ selectedAssetCount(d.device_id) }})
            </button>
          </div>
        </div>
      </div>

      <!-- ============ 指令历史区块 ============ -->
      <div class="sync-cmd-head">
        <span class="sync-cmd-title">
          <RefreshCw :size="12" />
          {{ t("settings.commandHistory") }}
        </span>
        <button class="mini-btn" :disabled="syncPanelLoading" @click="loadDevicePanel">
          {{ t("settings.refresh") }}
        </button>
      </div>
      <div v-if="!syncCommands.length" class="setting-desc">
        {{ t("settings.commandHistoryEmpty") }}
      </div>
      <table v-else class="sync-cmds">
        <thead>
          <tr>
            <th>{{ t("settings.commandColType") }}</th>
            <th>{{ t("settings.commandColStatus") }}</th>
            <th>{{ t("settings.commandColTarget") }}</th>
            <th>{{ t("settings.commandColCreated") }}</th>
            <th>{{ t("settings.commandColAck") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in syncCommands" :key="c.id" :data-testid="'sync-cmd-' + c.id">
            <td>{{ commandTypeLabel(c.type) }}</td>
            <td>
              <span class="sync-status" :class="'st-' + String(c.status || 'unknown')">
                {{ commandStatusLabel(c.status) }}
              </span>
            </td>
            <td class="sync-cmd-target">
              {{ c.device_id ? c.device_id : t("settings.commandTarget.all") }}
            </td>
            <td>{{ fmtTime(c.created_at) }}</td>
            <td>{{ fmtTime(c.ack_at) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>

  <!-- 删除选中资产确认弹窗（桌面端设备管理面板） -->
  <Teleport to="body">
    <div v-if="deleteConfirm" class="sync-mask" @mousedown.self="cancelDeleteAssets">
      <div class="sync-dialog" role="alertdialog" :aria-label="t('settings.deleteAssetsConfirm')">
        <h3 class="sync-dialog-title">
          <Trash2 :size="15" />
          {{ t("settings.deleteAssetsConfirm") }}
        </h3>
        <p class="sync-dialog-text">
          {{ t("settings.deleteAssetsConfirmDesc", { n: deleteConfirm.paths.length }) }}
        </p>
        <div class="sync-dialog-btns">
          <button class="sync-dialog-btn" :disabled="syncDeleting" @click="cancelDeleteAssets">
            {{ t("common.cancel") }}
          </button>
          <button
            class="sync-dialog-btn danger"
            :disabled="syncDeleting"
            @click="confirmDeleteAssets"
          >
            {{ syncDeleting ? t("settings.devicePanelLoading") : t("common.confirm") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, MonitorSmartphone, ChevronRight, Smartphone, Trash2 } from "@lucide/vue";
import {
  fetchDevices,
  fetchCommandHistory,
  deleteAssetsFromDevice,
  formatBytes,
  formatLastSeen,
} from "../../utils/deviceCommands.js";
import { showToast } from "../../composables/useToast.js";
import { isMobile } from "../../composables/useMobileViewport.js";

defineProps({
  // 嵌入式面板模式（iOS 壳负一屏）：显示设备管理面板；弹窗模式 + 原生 iOS 壳显示同步中心入口
  embedded: { type: Boolean, default: false },
});
defineEmits(["open-sync"]);

const { t } = useI18n();

// 原生壳环境（Swift 主窗口 WKWebView 注入 window.qqplayerNative）
const isNative = typeof window !== "undefined" && !!(window as any).qqplayerNative;

// ============ 设备管理面板（sync tab · 桌面端管理端） ============
// 设备指令队列（写指令让 iOS 推送下载/远程删除）+ 可见 iOS 资产清单。
const syncDevices = ref<any[]>([]);
const syncCommands = ref<any[]>([]);
const syncPanelLoading = ref(true);
const syncPanelError = ref("");
const expandedDeviceIds = ref<string[]>([]); // 已展开资产列表的设备 id
const assetSelection = ref<Record<string, Record<string, boolean>>>({}); // { [device_id]: { [path]: true } }
const deleteConfirm = ref<{ device: any; paths: string[] } | null>(null); // {device, paths} | null（确认弹窗目标）
const syncDeleting = ref(false);

// 进入 sync tab / 刷新：并行拉设备清单 + 指令历史（失败兑底文案，不阻塞其他 tab）
async function loadDevicePanel() {
  syncPanelLoading.value = true;
  syncPanelError.value = "";
  const [dr, cr] = await Promise.all([fetchDevices(), fetchCommandHistory()]);
  syncPanelLoading.value = false;
  if (dr.ok) {
    syncDevices.value = dr.devices;
  } else {
    syncDevices.value = [];
    syncPanelError.value = t("settings.syncFetchFailed");
  }
  syncCommands.value = cr.ok ? cr.commands : [];
  // 刷新后清空展开态与勾选（设备列表可能已变化）
  expandedDeviceIds.value = [];
  assetSelection.value = {};
}

// 展示名：device_name 非空用设备名，空则取 device_id 前 8 位
function deviceName(d: any) {
  if (d && d.device_name && String(d.device_name).trim()) return String(d.device_name).trim();
  return d && d.device_id ? String(d.device_id).slice(0, 8) : t("settings.noDevices");
}

function assetList(d: any) {
  return Array.isArray(d && d.assets) ? d.assets : [];
}

function assetCount(d: any) {
  if (d && typeof d.assets_count === "number") return d.assets_count;
  return assetList(d).length;
}

// byType 细分（音频/封面/图书/词典）：按已知键顺序展示，未知键忽略
const TYPE_ORDER = ["audio", "cover", "books", "dicts"];
function byTypeEntries(d: any) {
  const by = (d && d.byType) || {};
  const out: Record<string, unknown> = {};
  for (const k of TYPE_ORDER) {
    if (Number(by[k]) > 0) out[k] = by[k];
  }
  return out;
}

function deviceExpanded(d: any) {
  return expandedDeviceIds.value.includes(d.device_id);
}

// 展开/收起资产列表（懒渲染：仅展开时挂 DOM；收起时清空勾选）
function toggleDeviceAssets(d: any) {
  const id = d.device_id;
  const i = expandedDeviceIds.value.indexOf(id);
  if (i >= 0) {
    expandedDeviceIds.value.splice(i, 1);
    const sel = assetSelection.value;
    if (sel[id]) delete sel[id];
    assetSelection.value = { ...sel };
  } else {
    expandedDeviceIds.value.push(id);
  }
}

function assetSelected(deviceId: string, path: string) {
  return !!(assetSelection.value[deviceId] && assetSelection.value[deviceId][path]);
}

function toggleAsset(deviceId: string, path: string) {
  const sel = assetSelection.value[deviceId] || {};
  const next = { ...sel };
  if (next[path]) delete next[path];
  else next[path] = true;
  assetSelection.value = { ...assetSelection.value, [deviceId]: next };
}

function selectedAssetCount(deviceId: string) {
  const sel = assetSelection.value[deviceId];
  return sel ? Object.keys(sel).length : 0;
}

function askDeleteAssets(d: any) {
  const sel = assetSelection.value[d.device_id] || {};
  const paths = Object.keys(sel);
  if (!paths.length) return;
  deleteConfirm.value = { device: d, paths };
}

function cancelDeleteAssets() {
  if (syncDeleting.value) return;
  deleteConfirm.value = null;
}

// 确认删除：发 remoteDelete 指令 → toast → 刷新面板
async function confirmDeleteAssets() {
  const target = deleteConfirm.value;
  if (!target || syncDeleting.value) return;
  syncDeleting.value = true;
  const r = await deleteAssetsFromDevice(target.device.device_id, target.paths);
  syncDeleting.value = false;
  deleteConfirm.value = null;
  if (r.ok) {
    showToast(t("settings.deleteAssetsDone"));
  } else {
    showToast(t("settings.deleteAssetsFailed"), { type: "error" });
  }
  await loadDevicePanel();
}

// 最后在线人性化（x 分钟前/日期，文案走 i18n）
function fmtLastSeen(iso: string) {
  return formatLastSeen(iso, {
    justNow: t("settings.deviceJustNow"),
    minutesAgo: (n) => t("settings.deviceMinutesAgo", { n }),
    yesterday: t("settings.deviceYesterday"),
  });
}

// 时间：今天 → HH:mm；跨天 → MM-DD HH:mm；解析失败原样
function fmtTime(iso: string) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

// 指令类型/状态 → i18n label（未知值原样兑底）
function commandTypeLabel(type: string) {
  const key = `settings.commandType.${type}`;
  return t(key) !== key ? t(key) : String(type || "-");
}

function commandStatusLabel(status: string) {
  const key = `settings.commandStatus.${status}`;
  return t(key) !== key ? t(key) : String(status || "-");
}

onMounted(loadDevicePanel);
</script>

<style scoped>
.sync-error {
  color: #ff6b6b;
}
.sync-device {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: var(--card);
}
.sync-device-head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.sync-chevron {
  color: var(--text3);
  transition: transform 0.15s;
  flex-shrink: 0;
}
.sync-chevron.open {
  transform: rotate(90deg);
}
.sync-device-icon {
  color: var(--accent);
  flex-shrink: 0;
}
.sync-device-name {
  font-size: 13.5px;
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-device-meta {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text3);
  white-space: nowrap;
  flex-shrink: 0;
}
.sync-device-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding-left: 22px;
}
.sync-stat {
  font-size: 12px;
  color: var(--text2);
}
.sync-type-chip {
  font-size: 11px;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 1px 8px;
}
.sync-assets {
  margin-top: 8px;
  padding-left: 22px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sync-asset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
  cursor: pointer;
}
.sync-asset-row input {
  accent-color: var(--accent);
  flex-shrink: 0;
}
.sync-asset-path {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text2);
}
.sync-asset-size {
  color: var(--text3);
  white-space: nowrap;
  flex-shrink: 0;
}
.sync-asset-actions {
  margin-top: 6px;
}
.sync-cmd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 6px 0 4px;
}
.sync-cmd-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--accent2);
  letter-spacing: 1.5px;
}
.sync-cmds {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.sync-cmds th {
  text-align: left;
  font-weight: 600;
  color: var(--text3);
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.sync-cmds td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  color: var(--text2);
  white-space: nowrap;
}
.sync-cmd-target {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sync-status {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  border-radius: 20px;
  padding: 1px 8px;
}
.sync-status.st-pending {
  background: color-mix(in srgb, #f5a623 15%, transparent);
  color: #f5a623;
}
.sync-status.st-executing {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
}
.sync-status.st-done {
  background: color-mix(in srgb, #34c759 15%, transparent);
  color: #34c759;
}
.sync-status.st-failed {
  background: color-mix(in srgb, #ff6b6b 15%, transparent);
  color: #ff6b6b;
}
.sync-status.st-unknown {
  background: var(--bg2);
  color: var(--text3);
}
/* 删除资产确认弹窗 */
.sync-mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 130;
}
.sync-dialog {
  width: min(360px, calc(100vw - 40px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 20px 60px var(--shadow-strong);
  padding: 16px;
}
.sync-dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 8px;
}
.sync-dialog-title svg {
  color: #ff6b6b;
}
.sync-dialog-text {
  font-size: 12.5px;
  color: var(--text3);
  line-height: 1.6;
  margin-bottom: 14px;
}
.sync-dialog-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.sync-dialog-btn {
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  background: var(--card2);
  transition: all 0.15s;
}
@media (hover: hover) {
  .sync-dialog-btn:hover {
    color: var(--text);
  }
}
.sync-dialog-btn.danger {
  color: #ff6b6b;
}
.sync-dialog-btn.danger:hover {
  background: color-mix(in srgb, #ff6b6b 12%, transparent);
}
.sync-dialog-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
