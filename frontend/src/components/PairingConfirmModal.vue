<template>
  <Teleport to="body">
    <div
      v-if="open && request"
      class="pair-mask"
      role="alertdialog"
      aria-modal="true"
      :aria-label="t('pairing.confirmTitle')"
    >
      <div class="pair-card">
        <div class="pair-icon">
          <Smartphone :size="24" />
        </div>
        <h2 class="pair-title">{{ t("pairing.confirmTitle") }}</h2>
        <p class="pair-sub">{{ t("pairing.confirmText", { name: deviceName }) }}</p>
        <div class="pair-info">
          <div class="pair-row">
            <span class="pair-label">{{ t("pairing.deviceName") }}</span>
            <span class="pair-value">{{ deviceName }}</span>
          </div>
          <div class="pair-row">
            <span class="pair-label">{{ t("pairing.deviceType") }}</span>
            <span class="pair-value">{{ deviceType }}</span>
          </div>
          <div class="pair-row">
            <span class="pair-label">{{ t("pairing.requestTime") }}</span>
            <span class="pair-value">{{ requestTime }}</span>
          </div>
        </div>
        <div class="pair-btns">
          <button class="pair-btn pair-reject" :disabled="busy" @click="$emit('reject')">
            {{ t("pairing.reject") }}
          </button>
          <button class="pair-btn pair-approve" :disabled="busy" @click="$emit('approve')">
            {{ busy ? t("pairing.processing") : t("pairing.approve") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Smartphone } from "@lucide/vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  request: { type: Object, default: null },
  busy: { type: Boolean, default: false },
});
defineEmits(["approve", "reject"]);

const { t } = useI18n();

const deviceName = computed(() => {
  const n = props.request && props.request.device_name;
  return n && String(n).trim() ? String(n).trim() : t("pairing.deviceUnknown");
});

const deviceType = computed(() => {
  const ty = props.request && props.request.device_type;
  return ty && String(ty).trim() && ty !== "unknown"
    ? String(ty).trim()
    : t("pairing.deviceUnknown");
});

// 请求时间人性化：今天 → HH:mm；跨天 → MM-DD HH:mm；解析失败原样显示
const requestTime = computed(() => {
  const iso = props.request && props.request.created_at;
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
});
</script>

<style scoped>
/* 配对确认遮罩：样式对齐现有弹层体系（SettingsModal .modal-mask / mobile .ml-confirm-mask） */
.pair-mask {
  position: fixed;
  inset: 0;
  z-index: 300; /* 高于设置弹窗(100)/搜索层(200)/拖拽遮罩(250)，低于 toast(500) */
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
}
.pair-card {
  width: 100%;
  max-width: 360px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 22px 20px 16px;
  box-shadow:
    0 24px 80px var(--shadow-strong),
    0 4px 16px var(--shadow-sm);
}
.pair-icon {
  width: 44px;
  height: 44px;
  margin: 0 auto;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.pair-title {
  margin-top: 12px;
  font-size: 17px;
  font-weight: 700;
  text-align: center;
}
.pair-sub {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text2);
  text-align: center;
  word-break: break-all;
}
.pair-info {
  margin-top: 14px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 4px 12px;
}
.pair-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 7px 0;
  font-size: 13px;
}
.pair-row + .pair-row {
  border-top: 1px solid var(--border);
}
.pair-label {
  color: var(--text3);
  flex-shrink: 0;
}
.pair-value {
  color: var(--text);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pair-btns {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
.pair-btn {
  flex: 1;
  height: 42px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  touch-action: manipulation;
  transition: opacity 0.15s;
}
.pair-btn:active {
  opacity: 0.85;
}
.pair-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 拒绝：危险红色（与 .btn.danger / mobile .ml-confirm-ok 同语义） */
.pair-reject {
  background: var(--card2);
  color: var(--red);
  border: 1px solid color-mix(in srgb, var(--red) 40%, var(--border));
}
.pair-reject:not(:disabled):hover {
  background: var(--red-soft);
}
/* 批准：主色渐变（与顶栏激活 tab 一致） */
.pair-approve {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  border: none;
}
</style>
