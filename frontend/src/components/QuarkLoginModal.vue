<template>
  <Teleport to="body">
    <div v-if="open" class="qlm-mask" @click.self="close">
      <div class="qlm">
        <!-- 头部 -->
        <div class="qlm-head">
          <QrCode :size="16" />
          {{ t("online.quarkLoginTitle") }}
          <button class="qlm-close" :title="t('online.close')" @click="close">
            <X :size="15" />
          </button>
        </div>

        <!-- 二维码 + 状态 -->
        <div class="qlm-body">
          <div class="qlm-qr-wrap">
            <img v-if="qrImage" :src="qrImage" alt="QR" class="qlm-qr" />
            <Loader2 v-else :size="26" class="spin" />
          </div>
          <p class="qlm-hint">{{ t("online.quarkScanHint") }}</p>
          <p class="qlm-countdown" :class="{ warn: secondsLeft <= 30 }">
            {{ t("online.quarkCountdown", { s: secondsLeft }) }}
          </p>
          <p v-if="errorText" class="qlm-status err">{{ errorText }}</p>
          <p v-else-if="refreshing" class="qlm-status">{{ t("online.quarkRefreshing") }}</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { QrCode, X, Loader2 } from "@lucide/vue";

const props = defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(["success", "close"]);

const { t } = useI18n();

// 状态机：open → 拉二维码 → 1s 倒计时 + 2s 轮询 status
//   waiting: 继续轮询；ok: emit success；expired: 自动重新拉二维码；error: 停轮询显示错误
const qrImage = ref("");
const qrId = ref("");
const secondsLeft = ref(0);
const refreshing = ref(false); // 二维码过期 → 正在刷新（占位文案）
const errorText = ref("");

const POLL_MS = 2000;
const DEFAULT_TTL = 150;

let countdownTimer = null;
let pollTimer = null;
let active = false; // 当前会话有效标志：关闭/换码后旧轮询回调不得写入新会话

function clearTimers() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// 拉取新二维码（首次打开 / 过期刷新共用）：成功后启动倒计时 + 轮询
async function fetchQr() {
  errorText.value = "";
  refreshing.value = false;
  qrImage.value = "";
  active = true;
  try {
    const res = await fetch("/api/quark/login/qrcode", { method: "POST", cache: "no-store" });
    if (!active) return;
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (!active) return;
    qrImage.value = data.qr_image || "";
    qrId.value = data.qr_id || "";
    secondsLeft.value = Number(data.expires_in) || DEFAULT_TTL;
    startTimers();
  } catch {
    if (active) errorText.value = t("online.quarkError");
  }
}

function startTimers() {
  clearTimers();
  countdownTimer = setInterval(() => {
    secondsLeft.value--;
    // 倒计时归零 = 二维码过期，自动刷新
    if (secondsLeft.value <= 0) refreshQr();
  }, 1000);
  pollTimer = setInterval(pollStatus, POLL_MS);
}

// 过期刷新：停旧计时 → 占位文案 → 重新拉码
function refreshQr() {
  clearTimers();
  refreshing.value = true;
  fetchQr();
}

async function pollStatus() {
  if (!qrId.value || !active) return;
  try {
    const res = await fetch(`/api/quark/login/status?qr_id=${encodeURIComponent(qrId.value)}`, {
      cache: "no-store",
    });
    if (!active) return;
    if (!res.ok) return; // 网络抖动：下一轮重试
    const data = await res.json();
    if (!active) return;
    if (data.status === "ok") {
      clearTimers();
      active = false;
      emit("success");
    } else if (data.status === "expired") {
      refreshQr();
    } else if (data.status === "error") {
      clearTimers();
      errorText.value = t("online.quarkError");
    }
    // waiting → 继续轮询
  } catch {
    /* 网络抖动：下一轮重试 */
  }
}

function start() {
  active = true;
  qrId.value = "";
  secondsLeft.value = 0;
  refreshing.value = false;
  errorText.value = "";
  qrImage.value = "";
  clearTimers();
  fetchQr();
}

function stop() {
  active = false;
  clearTimers();
}

// 用户主动关闭（✕ / 点遮罩）
function close() {
  stop();
  emit("close");
}

watch(
  () => props.open,
  (o) => {
    if (o) start();
    else stop();
  },
);

onMounted(() => {
  if (props.open) start();
});
onBeforeUnmount(stop);
</script>

<style scoped>
/* 悬浮在 SettingsModal(z-index:100) 之上 */
.qlm-mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.qlm {
  width: min(320px, calc(100vw - 40px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow:
    0 24px 80px var(--shadow-strong),
    0 4px 16px var(--shadow-sm);
  overflow: hidden;
}
.qlm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 13px 16px;
  font-size: 14px;
  font-weight: 700;
  border-bottom: 1px solid var(--border);
}
.qlm-head svg {
  color: var(--accent);
}
.qlm-close {
  margin-left: auto;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  transition: all 0.15s;
}
@media (hover: hover) {
  .qlm-close:hover {
    background: var(--card2);
    color: var(--text);
  }
}
.qlm-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 22px 22px;
}
.qlm-qr-wrap {
  width: 190px;
  height: 190px;
  border-radius: 12px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--text3);
}
.qlm-qr {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.qlm-hint {
  font-size: 12.5px;
  color: var(--text2);
  margin-top: 12px;
}
.qlm-countdown {
  font-size: 11.5px;
  color: var(--text3);
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
.qlm-countdown.warn {
  color: #ffb84d;
}
.qlm-status {
  font-size: 12px;
  color: var(--accent2);
  margin-top: 8px;
}
.qlm-status.err {
  color: #ff6b6b;
}
.spin {
  animation: qlm-spin 0.9s linear infinite;
}
@keyframes qlm-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
