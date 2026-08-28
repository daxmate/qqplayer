<template>
  <Teleport to="body">
    <div class="toast-container">
      <TransitionGroup name="toast">
        <div
          v-for="item in items"
          :key="item.id"
          class="toast-item"
          :class="`toast-${item.type}`"
          role="status"
        >
          <span class="toast-text">{{ item.text }}</span>
          <button v-if="item.action" class="toast-action" type="button" @click="onAction(item.id)">
            {{ item.action.label }}
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useToast } from "../composables/useToast.js";

const { items, handleToastAction } = useToast();

function onAction(id: number) {
  handleToastAction(id);
}
</script>

<style scoped>
/* 全局统一 toast：固定定位右下角堆叠，跟随主题 CSS 变量（--bg/--card/--accent/--red 等） */
.toast-container {
  position: fixed;
  right: 20px;
  bottom: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  z-index: 300;
  pointer-events: none;
}
.toast-item {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: min(420px, calc(100vw - 40px));
  padding: 11px 16px;
  border-radius: 12px;
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  box-shadow: 0 10px 32px var(--shadow-strong);
  pointer-events: auto;
}
.toast-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toast-item.toast-error {
  border-color: color-mix(in srgb, var(--red) 55%, transparent);
  background: color-mix(in srgb, var(--red-soft) 40%, var(--card));
  color: var(--text);
}
.toast-item.toast-error .toast-text {
  color: var(--red);
}
.toast-action {
  flex-shrink: 0;
  padding: 4px 12px;
  border-radius: 8px;
  border: none;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition:
    filter 0.15s,
    transform 0.1s;
}
.toast-action:hover {
  filter: brightness(1.1);
}
.toast-action:active {
  transform: scale(0.96);
}

/* 进出场动画 */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.25s,
    transform 0.25s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
