<template>
  <div class="no-connection-view">
    <div class="nc-card">
      <div class="nc-icon">
        <WifiOff :size="44" />
      </div>
      <h1 class="nc-title">{{ t("pairing.unpaired.title") }}</h1>
      <p class="nc-desc">{{ t("pairing.unpaired.desc") }}</p>
      <button class="nc-pair-btn" @click="goPair">
        <Link2 :size="16" />
        {{ t("pairing.unpaired.pairNow") }}
      </button>
      <p class="nc-hint">{{ t("pairing.unpaired.manualHint") }}</p>
    </div>
    <div class="nc-footer">{{ t("pairing.unpaired.localOk") }}</div>
  </div>
</template>

<script setup lang="ts">
import { WifiOff, Link2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { nativePost } from "../composables/nativeAudioBridge.js";

const { t } = useI18n();

/** 去配对：通知 iOS 壳打开配对页 sheet（配对成功壳注入 server + reload，引导页自然消失） */
function goPair() {
  nativePost({ cmd: "openPairing" });
}
</script>

<style scoped>
/* 全屏定位/层级由 App.vue 的 .no-connection-overlay 规则负责（覆盖 .app > * 通用层）；
   此处只做内容布局与视觉。 */
.no-connection-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 32px;
  padding: 32px 28px calc(24px + env(safe-area-inset-bottom));
  padding-top: calc(32px + env(safe-area-inset-top));
  background: linear-gradient(160deg, var(--bg) 0%, var(--bg2) 100%);
  color: var(--text);
  text-align: center;
  overflow-y: auto;
}
.nc-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  max-width: 340px;
}
.nc-icon {
  width: 92px;
  height: 92px;
  border-radius: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent);
  margin-bottom: 6px;
  box-shadow: 0 10px 30px var(--shadow);
}
.nc-title {
  margin: 0;
  font-size: 21px;
  font-weight: 700;
  letter-spacing: 0.5px;
}
.nc-desc {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text2);
}
.nc-pair-btn {
  margin-top: 10px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 34px;
  border: none;
  border-radius: 14px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 8px 24px var(--accent-glow);
  transition:
    transform 0.15s,
    box-shadow 0.15s,
    opacity 0.15s;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.nc-pair-btn:active {
  transform: scale(0.97);
  opacity: 0.92;
}
.nc-hint {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text3);
}
.nc-footer {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text3);
  opacity: 0.85;
}
</style>
