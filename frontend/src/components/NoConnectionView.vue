<template>
  <div class="no-connection-view">
    <div class="nc-card">
      <div class="nc-icon">
        <WifiOff :size="44" />
      </div>
      <h1 class="nc-title">{{ t("pairing.unpaired.title") }}</h1>
      <p class="nc-desc">{{ t("pairing.unpaired.desc") }}</p>
      <p class="nc-hint">{{ t("pairing.unpaired.manualHint") }}</p>
    </div>
    <div class="nc-footer">{{ t("pairing.unpaired.localOk") }}</div>
  </div>
</template>

<script setup lang="ts">
import { WifiOff } from "@lucide/vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
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
