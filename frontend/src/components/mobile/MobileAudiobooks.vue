<template>
  <div class="ma-page">
    <!-- 页头：标题（占位页无返回按钮，翻页由分页容器负责） -->
    <header class="ma-head">
      <h1 class="ma-title">{{ t("mobile.audiobooks.title") }}</h1>
      <span class="ma-head-spacer" />
    </header>

    <div class="ma-body">
      <span class="ma-icon"><Headphones :size="52" /></span>
      <h2 class="ma-name">{{ t("mobile.audiobooks.title") }}</h2>
      <p class="ma-desc">{{ t("mobile.audiobooks.comingSoon") }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Headphones } from "@lucide/vue";

const { t } = useI18n();
</script>

<style scoped>
.ma-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.ma-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 12px 4px;
  padding-top: calc(12px + env(safe-area-inset-top));
}
.ma-title {
  flex: 1;
  min-width: 0;
  font-size: 20px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}
.ma-head-spacer {
  width: 38px;
  flex-shrink: 0;
}
.ma-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 0 32px 60px;
  text-align: center;
}
.ma-icon {
  width: 96px;
  height: 96px;
  border-radius: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, #8b5cf6, #a78bfa);
  box-shadow: 0 8px 24px color-mix(in srgb, #8b5cf6 35%, transparent);
}
.ma-name {
  font-size: 20px;
  font-weight: 700;
}
.ma-desc {
  font-size: 13px;
  color: var(--text3);
  line-height: 1.6;
}
</style>
