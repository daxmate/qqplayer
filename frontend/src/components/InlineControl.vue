<!-- 设置项内联控件（search anything · 结果行直接操作）
  按 entry.type 渲染：toggle → 开关 / slider → 滑杆+数值 / select → chips 单选 / text → 输入框（Enter/blur 提交）。
  变更直接调 entry.set(v)（settingsSync watch 自动持久化，见 settingsIndex.js 顶部说明）。
  样式沿用 SettingsModal 的控件视觉（--accent/--bg2/--border 等 CSS 变量）。 -->
<template>
  <div class="inline-control" :class="`ic-${entry.type}`">
    <!-- toggle：开关，点击切换，视觉反映 entry.get() -->
    <button
      v-if="entry.type === 'toggle'"
      class="ic-switch"
      :class="{ on: current }"
      role="switch"
      :aria-checked="current"
      :aria-label="t(entry.labelKey)"
      @click="entry.set(!current)"
    >
      <i />
    </button>

    <!-- slider：滑杆 + 当前值 -->
    <div v-else-if="entry.type === 'slider'" class="ic-slider">
      <input
        class="ic-range"
        type="range"
        :min="entry.min ?? 0"
        :max="entry.max ?? 100"
        :step="entry.step ?? 1"
        :value="current"
        @input="onSlider"
      />
      <span class="ic-value">{{ fmtValue }}</span>
    </div>

    <!-- select：chips 单选（options 渲染，文案 t(option.labelKey)，当前项高亮） -->
    <div v-else-if="entry.type === 'select'" class="ic-select">
      <button
        v-for="opt in entry.options"
        :key="opt.value"
        class="ic-chip"
        :class="{ on: String(current) === String(opt.value) }"
        @click="entry.set(opt.value)"
      >
        {{ t(opt.labelKey) }}
      </button>
    </div>

    <!-- text：输入框，Enter / blur 提交 -->
    <input
      v-else
      v-model="text"
      class="ic-input"
      type="text"
      :placeholder="entry.placeholder ? t(entry.placeholder) : ''"
      spellcheck="false"
      @keydown.enter="commit"
      @blur="commit"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps({
  entry: { type: Object, required: true },
});

const { t } = useI18n();

// 当前值由 entry.get() 驱动（读的是 settings reactive，天然响应式）
const current = computed(() => props.entry.get());

// 滑杆数值显示：整数直显，小数保留 1 位（如 0.5s / -1.2s 的 offset）
const fmtValue = computed(() => {
  const v = current.value;
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
  return String(v ?? "");
});

function onSlider(e) {
  props.entry.set(Number(e.target.value));
}

// text 输入框：本地编辑态，外部值变化时同步
const text = ref("");
watch(current, (v) => {
  text.value = v ?? "";
});

function commit() {
  props.entry.set(text.value);
}
</script>

<style scoped>
.inline-control {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* ============ toggle ============ */
.ic-switch {
  flex-shrink: 0;
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background: var(--card2);
  border: 1px solid var(--border);
  position: relative;
  cursor: pointer;
  transition: background 0.2s;
  padding: 0;
}
.ic-switch i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px var(--shadow-sm);
}
.ic-switch.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border-color: transparent;
}
.ic-switch.on i {
  transform: translateX(20px);
}

/* ============ slider ============ */
.ic-slider {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.ic-range {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  min-width: 90px;
  height: 5px;
  border-radius: 3px;
  background: var(--bg2);
  outline: none;
  margin: 0;
}
.ic-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: pointer;
  transition: transform 0.15s;
}
.ic-range::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}
.ic-range::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: pointer;
}
.ic-value {
  flex-shrink: 0;
  min-width: 34px;
  text-align: center;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px 7px;
  font-variant-numeric: tabular-nums;
}

/* ============ select（chips）============ */
.ic-select {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ic-chip {
  padding: 5px 11px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
  white-space: nowrap;
}
@media (hover: hover) {
  .ic-chip:hover {
    color: var(--text);
    border-color: var(--text3);
  }
}
.ic-chip.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  border-color: transparent;
  box-shadow: 0 2px 8px var(--accent-glow2);
}

/* ============ text ============ */
.ic-input {
  width: 180px;
  max-width: 100%;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  color: var(--text);
  font-size: 12.5px;
  outline: none;
  transition: border-color 0.15s;
}
.ic-text:focus {
  border-color: var(--accent);
}
</style>
