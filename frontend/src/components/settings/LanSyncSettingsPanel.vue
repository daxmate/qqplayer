<!-- 局域网同步面板（S2 · web Host 侧）：本机身份 / 添加设备(二维码) / 待批准 / 已配对设备。
  逻辑在 composables/useLanSync.ts（网络 + 事件游标轮询），本组件只做渲染与交互；
  样式复用全局 .group/.setting-item 约定，仅局域网同步专属块写 scoped 样式。 -->
<template>
  <div class="group">
    <div class="group-title">
      <Wifi :size="13" />
      {{ t("lansync.statusTitle") }}
    </div>
    <div class="setting-item">
      <div class="setting-label">
        <span class="lansync-dot" :class="running ? 'on' : 'off'" />
        {{ running ? t("lansync.running", { port: status?.port ?? 0 }) : t("lansync.notRunning") }}
      </div>
      <div class="setting-desc">{{ t("lansync.statusDesc") }}</div>
      <div v-if="status?.error" class="setting-desc lansync-error">{{ status.error }}</div>
    </div>
  </div>

  <!-- ============ 本机身份 ============ -->
  <div class="group">
    <div class="group-title">
      <ScanLine :size="13" />
      {{ t("lansync.identityTitle") }}
    </div>
    <div class="setting-item">
      <div class="setting-label">{{ t("lansync.deviceName") }}</div>
      <div class="setting-control">
        <span class="lansync-mono" data-testid="lansync-device-name">{{
          status?.device_name || "—"
        }}</span>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-label">{{ t("lansync.deviceId") }}</div>
      <div class="setting-desc">{{ t("lansync.deviceIdDesc") }}</div>
      <div class="lansync-id" data-testid="lansync-device-id">
        <span v-for="(g, i) in idGroups" :key="i" class="lansync-id-group">{{ g }}</span>
      </div>
      <div class="setting-control">
        <button class="btn" :disabled="!identity" @click="copyDeviceId">
          <Copy :size="13" /> {{ t("lansync.copy") }}
        </button>
      </div>
    </div>
  </div>

  <!-- ============ 添加设备 ============ -->
  <div class="group">
    <div class="group-title">
      <QrCode :size="13" />
      {{ t("lansync.addDeviceTitle") }}
    </div>
    <template v-if="qrImage">
      <div class="setting-item">
        <div class="setting-desc">{{ t("lansync.qrHint") }}</div>
        <div class="lansync-qr-wrap">
          <img class="lansync-qr" :src="qrImage" :alt="t('lansync.addDeviceTitle')" />
        </div>
        <div class="setting-desc">{{ t("lansync.addDeviceHint") }}</div>
        <div class="setting-control">
          <button class="btn" data-testid="lansync-stop-qr" :disabled="busy" @click="onStopPairing">
            {{ t("lansync.stopQr") }}
          </button>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="setting-item">
        <div class="setting-desc">{{ t("lansync.addDeviceHint") }}</div>
        <div class="setting-control">
          <button
            class="btn primary"
            data-testid="lansync-show-qr"
            :disabled="!running || busy"
            @click="onStartPairing"
          >
            <QrCode :size="13" /> {{ t("lansync.showQr") }}
          </button>
        </div>
        <div v-if="!running" class="setting-desc lansync-muted">
          {{ t("lansync.unavailableHint") }}
        </div>
      </div>
    </template>
  </div>

  <!-- ============ 待批准设备 ============ -->
  <div class="group">
    <div class="group-title">
      <Clock :size="13" />
      {{ t("lansync.pendingTitle") }}
    </div>
    <template v-if="pending.length">
      <div
        v-for="r in pending"
        :key="r.request_id"
        class="lansync-card"
        :data-testid="'lansync-pending-' + r.request_id"
      >
        <div class="lansync-card-main">
          <div class="lansync-card-name">
            {{ r.display_name || r.suggested_display_name || "—" }}
          </div>
          <div class="lansync-card-meta">{{ shortId(r.device_id, r.device_id_formatted) }}</div>
        </div>
        <button
          class="btn primary lansync-btn-sm"
          :disabled="busy"
          :data-testid="'lansync-approve-' + r.request_id"
          @click="onApprove(r)"
        >
          {{ t("lansync.approve") }}
        </button>
        <button
          class="btn lansync-btn-sm"
          :disabled="busy"
          :data-testid="'lansync-reject-' + r.request_id"
          @click="onReject(r)"
        >
          {{ t("lansync.reject") }}
        </button>
      </div>
    </template>
    <div v-else class="setting-item">
      <div class="setting-desc lansync-muted">{{ t("lansync.pendingEmpty") }}</div>
    </div>
  </div>

  <!-- ============ 已配对设备 ============ -->
  <div class="group">
    <div class="group-title">
      <Smartphone :size="13" />
      {{ t("lansync.devicesTitle") }}
    </div>
    <template v-if="devices.length">
      <div
        v-for="d in devices"
        :key="d.peer_id"
        class="lansync-card"
        :data-testid="'lansync-device-' + d.peer_id"
      >
        <span class="lansync-dot" :class="d.online ? 'on' : 'off'" />
        <div class="lansync-card-main">
          <div class="lansync-card-name">{{ d.display_name || shortId(d.peer_id) }}</div>
          <div class="lansync-card-meta">
            {{ d.online ? t("lansync.online") : t("lansync.offline") }} ·
            {{ t("lansync.lastSeen") }} {{ lastActive(d.last_seen_at) }}
          </div>
        </div>
        <button
          class="btn lansync-btn-sm danger"
          :disabled="busy"
          :data-testid="'lansync-revoke-' + d.peer_id"
          @click="askRevoke(d)"
        >
          {{ t("lansync.revoke") }}
        </button>
      </div>
    </template>
    <div v-else class="setting-item">
      <div class="setting-desc lansync-muted">{{ t("lansync.devicesEmpty") }}</div>
      <div class="setting-desc">{{ t("lansync.devicesEmptyDesc") }}</div>
    </div>
  </div>

  <!-- ============ 同步范围（如实告知：本阶段只做配对 + 连接） ============ -->
  <div class="group">
    <div class="group-title">
      <Link2 :size="13" />
      {{ t("lansync.scopeTitle") }}
    </div>
    <div class="setting-item">
      <div class="setting-desc">{{ t("lansync.scopeDesc") }}</div>
    </div>
  </div>

  <!-- 撤销配对二次确认 -->
  <Teleport to="body">
    <div v-if="revokeTarget" class="lansync-mask" @click.self="closeRevoke">
      <div class="lansync-dialog" role="alertdialog" :aria-label="t('lansync.revokeTitle')">
        <h3 class="lansync-dialog-title">{{ t("lansync.revokeTitle") }}</h3>
        <p class="lansync-dialog-text">
          {{ t("lansync.revokeConfirm", { name: revokeName }) }}
        </p>
        <div class="lansync-dialog-btns">
          <button class="btn" :disabled="busy" @click="closeRevoke">
            {{ t("common.cancel") }}
          </button>
          <button
            class="btn danger"
            data-testid="lansync-revoke-confirm"
            :disabled="busy"
            @click="confirmRevoke"
          >
            {{ t("common.confirm") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Clock, Copy, Link2, QrCode, ScanLine, Smartphone, Wifi } from "@lucide/vue";
import {
  useLanSync,
  type LanSyncDevice,
  type LanSyncPairRequest,
} from "../../composables/useLanSync.js";
import { showToast, toastError } from "../../composables/useToast.js";

const { t } = useI18n();

const {
  status,
  identity,
  pending,
  devices,
  qrImage,
  busy,
  refresh,
  startPairing,
  stopPairing,
  approve,
  reject,
  removeDevice,
  startPolling,
  stopPolling,
} = useLanSync();

const running = computed(() => Boolean(status.value?.running));
/** Device ID 分组展示（缺 groups 时按 7 字符兜底切分） */
const idGroups = computed<string[]>(() => {
  const info = identity.value;
  if (!info) return [];
  if (Array.isArray(info.device_id_groups) && info.device_id_groups.length) {
    return info.device_id_groups;
  }
  return (info.device_id || "").match(/.{1,7}/g) || [];
});

const revokeTarget = ref<LanSyncDevice | null>(null);
const revokeName = computed(() =>
  revokeTarget.value ? revokeTarget.value.display_name || shortId(revokeTarget.value.peer_id) : "",
);

/** ID 短格式：首组…末组（手输核对用），无分组信息时退回首 7 位 */
function shortId(fullId: string, formattedId?: string): string {
  const text = formattedId || fullId || "";
  const groups = text.split("-").filter((g) => g);
  if (groups.length >= 2) return `${groups[0]}…${groups[groups.length - 1]}`;
  return text.slice(0, 7);
}

/** 时间戳（秒；误传毫秒自动降级）→ HH:mm / MM-DD HH:mm */
function fmtEpoch(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** 最近连接人性化：刚刚 / N 分钟前 / 昨天 / MM-DD */
function lastActive(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const d = new Date(seconds > 1e12 ? seconds : seconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (diffDays <= 0) {
    const minutes = Math.floor((now.getTime() - d.getTime()) / 60000);
    if (minutes < 1) return t("lansync.justNow");
    if (minutes < 60) return t("lansync.minutesAgo", { n: minutes });
    return fmtEpoch(seconds);
  }
  if (diffDays === 1) return t("lansync.yesterday");
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 复制 Device ID：优先 Clipboard API（安全上下文），降级 execCommand（LAN http 场景） */
async function copyDeviceId(): Promise<void> {
  const text = identity.value?.device_id || "";
  if (!text) return;
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) ok = legacyCopy(text);
  if (ok) showToast(t("lansync.copied"));
  else toastError(t("lansync.copyFailed"));
}

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

async function onStartPairing(): Promise<void> {
  if (!(await startPairing())) toastError(t("lansync.actionFailed"));
}

async function onStopPairing(): Promise<void> {
  await stopPairing();
}

async function onApprove(r: LanSyncPairRequest): Promise<void> {
  const ok = await approve(r.request_id);
  if (ok) showToast(t("lansync.approved"));
  else toastError(t("lansync.actionFailed"));
}

async function onReject(r: LanSyncPairRequest): Promise<void> {
  const ok = await reject(r.request_id);
  if (ok) showToast(t("lansync.rejected"));
  else toastError(t("lansync.actionFailed"));
}

function askRevoke(d: LanSyncDevice): void {
  revokeTarget.value = d;
}

function closeRevoke(): void {
  if (busy.value) return;
  revokeTarget.value = null;
}

async function confirmRevoke(): Promise<void> {
  const d = revokeTarget.value;
  if (!d || busy.value) return;
  if (await removeDevice(d.peer_id)) {
    revokeTarget.value = null;
    showToast(t("lansync.revoked"));
  } else {
    toastError(t("lansync.actionFailed"));
  }
}

onMounted(async () => {
  await refresh();
  startPolling();
});
onBeforeUnmount(stopPolling);
</script>

<style scoped>
.lansync-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  background: var(--text3);
}
.lansync-dot.on {
  background: var(--accent);
}
.lansync-dot.off {
  background: color-mix(in srgb, var(--text3) 60%, transparent);
}
.lansync-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--text2);
}
/* Device ID 分组展示：等宽、可换行，方便照着手输核对 */
.lansync-id {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 6px 0;
}
.lansync-id-group {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg2);
  color: var(--text2);
}
.lansync-qr-wrap {
  display: flex;
  justify-content: center;
  padding: 10px 0;
}
.lansync-qr {
  width: 220px;
  height: 220px;
  background: #fff;
  padding: 8px;
  border-radius: 12px;
}
.lansync-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg2);
  margin-bottom: 8px;
}
.lansync-card-main {
  flex: 1;
  min-width: 0;
}
.lansync-card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lansync-card-meta {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.lansync-btn-sm {
  flex-shrink: 0;
  font-size: 12px;
  padding: 6px 10px;
}
.lansync-btn-sm.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 40%, var(--border));
}
.lansync-btn-sm:disabled {
  opacity: 0.5;
  cursor: default;
}
.lansync-error {
  color: var(--red);
  word-break: break-all;
}
.lansync-muted {
  color: var(--text3);
}
/* 内层确认弹窗（同 PairingSettings 层级约定：高于设置弹窗 100，低于 toast 500） */
.lansync-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.lansync-dialog {
  width: 100%;
  max-width: 340px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 18px 14px;
  box-shadow:
    0 24px 80px var(--shadow-strong),
    0 4px 16px var(--shadow-sm);
}
.lansync-dialog-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.lansync-dialog-text {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text2);
  word-break: break-all;
}
.lansync-dialog-btns {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
.lansync-dialog-btns .btn {
  flex: 1;
  justify-content: center;
}
</style>
