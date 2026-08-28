<template>
  <div class="pairing-settings">
    <!-- ============ 已配对设备 ============ -->
    <div class="group">
      <div class="group-title">
        <Smartphone :size="13" />
        {{ t("pairing.devices") }}
      </div>
      <div v-if="loading" class="pairing-tip">{{ t("pairing.loading") }}</div>
      <template v-else-if="devices.length">
        <div v-for="d in devices" :key="`${d.server_id}/${d.device_id}`" class="pairing-row">
          <component :is="deviceIcon(d.device_type)" :size="16" class="pairing-row-icon" />
          <div class="pairing-row-main">
            <div class="pairing-row-name">
              {{ displayName(d) }}
            </div>
            <div class="pairing-row-meta">
              <span>{{ t("pairing.pairedAt", { time: fmtTime(d.created_at) }) }}</span>
              <span class="pairing-dot">·</span>
              <span>{{ t("pairing.lastActive", { time: fmtLastActive(d.last_seen_at) }) }}</span>
            </div>
          </div>
          <button
            class="pairing-icon-btn"
            :title="t('pairing.editNote')"
            :disabled="busy"
            @click="openNote(d)"
          >
            <Pencil :size="14" />
          </button>
          <button
            class="pairing-icon-btn danger"
            :title="t('pairing.delete')"
            :disabled="busy"
            @click="askDelete(d)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </template>
      <div v-else class="pairing-empty">
        <div class="pairing-empty-title">{{ t("pairing.emptyDevices") }}</div>
        <div class="pairing-empty-desc">{{ t("pairing.emptyDevicesDesc") }}</div>
      </div>
    </div>

    <!-- ============ 待确认请求（只读，仅可拒绝；批准走 PairingConfirmModal 弹窗） ============ -->
    <div class="group">
      <div class="group-title">
        <Clock :size="13" />
        {{ t("pairing.pendingRequests") }}
      </div>
      <div v-if="loading" class="pairing-tip">{{ t("pairing.loading") }}</div>
      <template v-else-if="pending.length">
        <div v-for="r in pending" :key="r.request_id" class="pairing-row">
          <component :is="deviceIcon(r.device_type)" :size="16" class="pairing-row-icon" />
          <div class="pairing-row-main">
            <div class="pairing-row-name">
              {{
                r.device_name && String(r.device_name).trim()
                  ? r.device_name
                  : t("pairing.deviceUnknown")
              }}
            </div>
            <div class="pairing-row-meta">
              {{ t("pairing.requestTime") }}：{{ fmtTime(r.created_at) }}
            </div>
          </div>
          <button
            class="pairing-icon-btn danger"
            :title="t('pairing.delete')"
            :disabled="busy"
            @click="rejectRequest(r)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </template>
      <div v-else class="pairing-empty">
        <div class="pairing-empty-title">{{ t("pairing.emptyPending") }}</div>
      </div>
    </div>

    <!-- 撤销配对确认弹窗 -->
    <Teleport to="body">
      <div v-if="confirmTarget" class="pairing-mask" @click.self="closeConfirm">
        <div
          class="pairing-dialog"
          role="alertdialog"
          :aria-label="t('pairing.confirmDeleteTitle')"
        >
          <h3 class="pairing-dialog-title">{{ t("pairing.confirmDeleteTitle") }}</h3>
          <p class="pairing-dialog-text">
            {{ t("pairing.confirmDelete", { name: confirmName }) }}
          </p>
          <div class="pairing-dialog-btns">
            <button class="pairing-dialog-btn" :disabled="busy" @click="closeConfirm">
              {{ t("common.cancel") }}
            </button>
            <button class="pairing-dialog-btn danger" :disabled="busy" @click="confirmDelete">
              {{ busy ? t("pairing.processing") : t("common.confirm") }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 备注编辑弹窗 -->
    <Teleport to="body">
      <div v-if="noteTarget" class="pairing-mask" @click.self="closeNote">
        <div class="pairing-dialog" role="dialog" :aria-label="t('pairing.editNote')">
          <h3 class="pairing-dialog-title">{{ t("pairing.editNote") }}</h3>
          <input
            v-model="noteDraft"
            class="pairing-note-input"
            :placeholder="t('pairing.notePlaceholder')"
            maxlength="50"
            spellcheck="false"
            @keyup.enter="saveNote"
          />
          <div class="pairing-dialog-btns">
            <button class="pairing-dialog-btn" :disabled="busy" @click="closeNote">
              {{ t("common.cancel") }}
            </button>
            <button class="pairing-dialog-btn primary" :disabled="busy" @click="saveNote">
              {{ busy ? t("pairing.processing") : t("common.save") }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Smartphone, Tablet, Monitor, Pencil, Trash2, Clock } from "@lucide/vue";
import { apiGet, apiDelete, apiPatch, apiPost } from "../utils/apiClient.js";
import { showToast, toastError } from "../composables/useToast.js";

const { t } = useI18n();

/** 已配对设备条目（GET /api/pairing/devices → devices[]） */
interface PairingDevice {
  server_id: string;
  device_id: string;
  device_type?: string;
  device_name?: string;
  note?: string;
  created_at?: string;
  last_seen_at?: string;
}

/** 待确认配对请求（GET /api/pairing/pending → requests[]） */
interface PairingRequest {
  request_id: string;
  device_type?: string;
  device_name?: string;
  created_at?: string;
}

const loading = ref(true); // 首次加载中
const busy = ref(false); // 删除/拒绝/保存请求中（防重复提交）
const devices = ref<PairingDevice[]>([]);
const pending = ref<PairingRequest[]>([]);
const confirmTarget = ref<PairingDevice | null>(null); // 待撤销的配对设备
const noteTarget = ref<PairingDevice | null>(null); // 正在编辑备注的设备
const noteDraft = ref("");

/** 设备类型 → 图标：iphone→手机 / ipad→平板 / macos·desktop→桌面 / 其他→手机兜底 */
function deviceIcon(type?: string) {
  const ty = String(type || "").toLowerCase();
  if (ty.includes("iphone")) return Smartphone;
  if (ty.includes("ipad")) return Tablet;
  if (ty.includes("mac") || ty.includes("desktop") || ty.includes("windows") || ty.includes("pc"))
    return Monitor;
  return Smartphone;
}

/** 时间人性化（配对时间/请求时间）：今天 → HH:mm；跨天 → MM-DD HH:mm；解析失败原样 */
function fmtTime(iso?: string | null) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** 最后活跃人性化：今天 → HH:mm；昨天 → 昨天；更早 → MM-DD；解析失败原样 */
function fmtLastActive(iso?: string | null) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (diffDays <= 0) return hm;
  if (diffDays === 1) return t("pairing.yesterday");
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function load() {
  loading.value = true;
  const [dr, pr] = await Promise.all([
    apiGet("/api/pairing/devices"),
    apiGet("/api/pairing/pending"),
  ]);
  loading.value = false;
  if (dr.ok && dr.data && Array.isArray(dr.data.devices)) {
    devices.value = dr.data.devices;
  } else {
    devices.value = [];
  }
  if (pr.ok && pr.data && Array.isArray(pr.data.requests)) {
    pending.value = pr.data.requests;
  } else {
    pending.value = [];
  }
  if (!dr.ok || !pr.ok) toastError(t("pairing.loadFailed"));
}

// ---- 删除（撤销配对） ----
function askDelete(d: PairingDevice) {
  confirmTarget.value = d;
}
function closeConfirm() {
  if (busy.value) return;
  confirmTarget.value = null;
}
const confirmName = computed(() => {
  const d = confirmTarget.value;
  return d ? displayName(d) : t("pairing.deviceUnknown");
});

/// 展示名：有备注用备注（用户可区分同名设备），无备注用设备名
function displayName(d: PairingDevice | null) {
  if (d && d.note && String(d.note).trim()) return String(d.note).trim();
  return d && d.device_name ? d.device_name : t("pairing.deviceUnknown");
}
async function confirmDelete() {
  const d = confirmTarget.value;
  if (!d || busy.value) return;
  busy.value = true;
  const r = await apiDelete(
    `/api/pairing/devices/${encodeURIComponent(d.server_id)}/${encodeURIComponent(d.device_id)}`,
  );
  busy.value = false;
  if (r.ok) {
    confirmTarget.value = null;
    showToast(t("pairing.deleted"));
    load();
  } else {
    toastError(t("pairing.actionFailed"));
  }
}

// ---- 备注编辑 ----
function openNote(d: PairingDevice) {
  noteDraft.value = d.note || "";
  noteTarget.value = d;
}
function closeNote() {
  if (busy.value) return;
  noteTarget.value = null;
}
async function saveNote() {
  const d = noteTarget.value;
  if (!d || busy.value) return;
  busy.value = true;
  const r = await apiPatch(
    `/api/pairing/devices/${encodeURIComponent(d.server_id)}/${encodeURIComponent(d.device_id)}`,
    { note: noteDraft.value },
  );
  busy.value = false;
  if (r.ok) {
    noteTarget.value = null;
    showToast(t("pairing.noteSaved"));
    load();
  } else {
    toastError(t("pairing.actionFailed"));
  }
}

// ---- 拒绝待确认请求（幂等；无批准入口，批准由桌面弹窗负责） ----
async function rejectRequest(r: PairingRequest) {
  if (!r || busy.value) return;
  busy.value = true;
  const res = await apiPost(`/api/pairing/request/${encodeURIComponent(r.request_id)}/reject`);
  busy.value = false;
  if (res.ok) {
    showToast(t("pairing.rejected"));
    load();
  } else {
    toastError(t("pairing.actionFailed"));
  }
}

onMounted(load);
</script>

<style scoped>
.pairing-tip {
  font-size: 12px;
  color: var(--text3);
  padding: 6px 0;
}
.pairing-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg2);
  margin-bottom: 8px;
}
.pairing-row-icon {
  color: var(--accent);
  flex-shrink: 0;
}
.pairing-row-main {
  flex: 1;
  min-width: 0;
}
.pairing-row-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pairing-row-note {
  font-size: 12px;
  color: var(--text3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pairing-row-meta {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text3);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pairing-dot {
  opacity: 0.6;
}
.pairing-icon-btn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  background: var(--card2);
  border: 1px solid var(--border);
  flex-shrink: 0;
  transition: all 0.15s;
}
.pairing-icon-btn.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 40%, var(--border));
}
@media (hover: hover) {
  .pairing-icon-btn:hover {
    filter: brightness(1.1);
    color: var(--text);
  }
  .pairing-icon-btn.danger:hover {
    background: color-mix(in srgb, var(--red) 12%, transparent);
    color: var(--red);
  }
}
.pairing-icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.pairing-empty {
  padding: 14px 10px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  text-align: center;
}
.pairing-empty-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
}
.pairing-empty-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text3);
}

/* 内层弹窗（高于设置弹窗 100，低于 toast 500） */
.pairing-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.pairing-dialog {
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
.pairing-dialog-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.pairing-dialog-text {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text2);
  word-break: break-all;
}
.pairing-note-input {
  margin-top: 12px;
  width: 100%;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  color: var(--text);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}
.pairing-note-input:focus {
  border-color: var(--accent);
}
.pairing-dialog-btns {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
.pairing-dialog-btn {
  flex: 1;
  height: 38px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  background: var(--card2);
  border: 1px solid var(--border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.pairing-dialog-btn.primary {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  border: none;
}
.pairing-dialog-btn.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 40%, var(--border));
}
.pairing-dialog-btn.danger:not(:disabled):hover {
  background: color-mix(in srgb, var(--red) 12%, transparent);
}
.pairing-dialog-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
