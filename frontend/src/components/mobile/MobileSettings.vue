<template>
  <div class="ms-page">
    <!-- 头部：汉堡（设置分类抽屉）+ 当前面板标题 + 返回（回音乐页） -->
    <header class="ms-head">
      <button
        class="ms-icon-btn ms-burger"
        :title="t('mobile.settingsArea.menu')"
        @click="drawerOpen = true"
      >
        <Menu :size="20" />
      </button>
      <h1 class="ms-title">{{ t(activeLabelKey) }}</h1>
      <button class="ms-icon-btn ms-back" :title="t('mobile.list.back')" @click="$emit('back')">
        <ChevronLeft :size="22" />
      </button>
    </header>

    <!-- 面板区：同步面板复用 MobileSync（embedded 隐藏自身头部）；其余设置面板用 SettingsModal 嵌入式渲染对应 tab -->
    <div class="ms-body">
      <MobileSync v-if="panel === 'sync'" key="ms-panel-sync" embedded />
      <SettingsModal
        v-else
        :key="'ms-panel-' + panel"
        :open="true"
        :embedded="true"
        :initial-tab="panel"
      />
    </div>

    <!-- 侧边抽屉：设置分类导航（左侧滑出 + 遮罩），点击切换面板 -->
    <Transition name="ms-drawer">
      <div v-if="drawerOpen" class="ms-drawer-mask" @click.self="drawerOpen = false">
        <aside class="ms-drawer">
          <p class="ms-drawer-title">{{ t("settings.title") }}</p>
          <button
            v-for="c in categories"
            :key="c.key"
            class="ms-drawer-item"
            :class="{ on: panel === c.key }"
            @click="selectPanel(c.key)"
          >
            <component :is="c.icon" :size="18" />
            <span class="ms-drawer-label">{{ t(c.labelKey) }}</span>
          </button>
        </aside>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Menu, ChevronLeft } from "@lucide/vue";
import { getSettingsCategories } from "../../composables/useSettingsCategories.js";
import MobileSync from "./MobileSync.vue";
import SettingsModal from "../SettingsModal.vue";

defineEmits(["back"]);
const { t } = useI18n();

// 当前面板：'sync'（复用 MobileSync 作为同步面板）| 其余 settings tab key（SettingsModal 嵌入式渲染）
const panel = ref("sync");
const drawerOpen = ref(false);
// 每次实例创建时求值（isPairingEnabled 非响应式，模块级缓存会过期）
const categories = computed(() => getSettingsCategories());

const activeLabelKey = computed(() => {
  const c = categories.value.find((c) => c.key === panel.value);
  return c ? c.labelKey : "settings.category.sync";
});

function selectPanel(key: string) {
  panel.value = key;
  drawerOpen.value = false;
}
</script>

<style scoped>
.ms-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--bg);
}
.ms-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 12px 12px 4px;
  padding-top: calc(12px + env(safe-area-inset-top));
}
.ms-icon-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  background: var(--card);
  border: 1px solid var(--border);
  transition: all 0.15s;
  touch-action: manipulation;
  flex-shrink: 0;
}
.ms-icon-btn:active {
  background: var(--card2);
  color: var(--text);
  transform: scale(0.92);
}
.ms-title {
  flex: 1;
  min-width: 0;
  font-size: 20px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}
.ms-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* ============ 侧边抽屉（左侧滑出 + 遮罩） ============ */
.ms-drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: var(--mask);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: stretch;
}
.ms-drawer {
  width: min(290px, 78vw);
  background: var(--bg2);
  border-right: 1px solid var(--border);
  box-shadow: 12px 0 32px rgba(0, 0, 0, 0.35);
  padding: 14px 12px 22px;
  padding-top: calc(14px + env(safe-area-inset-top));
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ms-drawer-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text3);
  letter-spacing: 1px;
  padding: 4px 10px 10px;
}
.ms-drawer-item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 12px;
  border-radius: 11px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text2);
  background: none;
  border: none;
  text-align: left;
  transition: all 0.15s;
  touch-action: manipulation;
}
.ms-drawer-item svg {
  color: var(--text3);
  flex-shrink: 0;
  transition: color 0.15s;
}
.ms-drawer-item:active {
  background: var(--card2);
  color: var(--text);
}
.ms-drawer-item.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.ms-drawer-item.on svg {
  color: #fff;
}
.ms-drawer-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 抽屉进出：左滑入 + 淡入遮罩 */
.ms-drawer-enter-active,
.ms-drawer-leave-active {
  transition: opacity 0.2s ease;
}
.ms-drawer-enter-active .ms-drawer,
.ms-drawer-leave-active .ms-drawer {
  transition: transform 0.24s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.ms-drawer-enter-from,
.ms-drawer-leave-to {
  opacity: 0;
}
.ms-drawer-enter-from .ms-drawer,
.ms-drawer-leave-to .ms-drawer {
  transform: translateX(-100%);
}
</style>
