<!-- 通用设置行（SettingsModal 普通设置 tab 注册表驱动渲染）
  entry 来自 settingsIndex.ts 注册表；控件按 entry.type 分发，DOM 结构/类名与改造前
  SettingsModal 手写模板保持一致（compactCss 契约 + SettingsModal.*.test.js 依赖）：
    toggle → .toggle-row + .switch（整行可点切换）
    select → .seg/.seg-btn（entry.chips==='ext' 时 .ext-grid/.ext-chip；opt.css 字体预览）
    slider → .slider 滑杆（valueSuffix 值徽标内嵌 label 或 label 后独立 div）
    text/custom → .setting-control > input.lib-input（inputType:"number" 时数字提交）
  样式不重复定义：由 SettingsModal 的 scoped 样式 :deep 穿透继承（本组件无 style 块）。
  可选展示字段（注册表，见 settingsIndex.ts 顶部注释）：render/descKey/descAfter/marginTop/
  chips/valueSuffix/badge/mobileOnly/inputType/min/max/step/placeholder。 -->
<template>
  <div v-if="!entry.mobileOnly || mobile" class="setting-item">
    <!-- toggle：整行可点（保持 .toggle-row + .switch 结构，点击切换 entry） -->
    <div v-if="entry.type === 'toggle'" class="toggle-row" @click="entry.set(!current)">
      <div>
        <div class="setting-label">{{ t(entry.labelKey) }}</div>
        <div v-if="descKey" class="setting-desc">{{ t(descKey) }}</div>
      </div>
      <span class="switch" :class="{ on: current }"><i /></span>
    </div>

    <!-- 其余类型：label（+值徽标）+ desc + 控件 -->
    <template v-else>
      <div class="setting-label">
        {{ t(entry.labelKey) }}
        <span v-if="entry.valueSuffix && entry.badge !== 'block'" class="val-badge"
          >{{ current }}{{ entry.valueSuffix }}</span
        >
      </div>
      <div v-if="entry.valueSuffix && entry.badge === 'block'" class="val-badge">
        {{ current }}{{ entry.valueSuffix }}
      </div>
      <div v-if="descKey && !entry.descAfter" class="setting-desc">{{ t(descKey) }}</div>

      <!-- select：seg chips（默认）/ ext-grid（entry.chips==='ext'）；opt.css 字体预览 -->
      <div
        v-if="entry.type === 'select'"
        :class="entry.chips === 'ext' ? 'ext-grid' : 'seg'"
        :style="entry.marginTop != null ? { marginTop: entry.marginTop + 'px' } : undefined"
      >
        <button
          v-for="opt in entry.options"
          :key="opt.value"
          :class="[
            entry.chips === 'ext' ? 'ext-chip' : 'seg-btn',
            { on: String(current) === String(opt.value) },
          ]"
          :style="opt.css ? { fontFamily: opt.css } : undefined"
          @click="entry.set(opt.value)"
        >
          {{ t(opt.labelKey) }}
        </button>
      </div>

      <!-- slider -->
      <input
        v-else-if="entry.type === 'slider'"
        v-model="sliderVal"
        class="slider"
        type="range"
        :min="entry.min ?? 0"
        :max="entry.max ?? 100"
        :step="entry.step ?? 1"
      />

      <!-- text / custom：输入框（number 提交时转数字，与改造前 v-model.number 一致） -->
      <div v-else class="setting-control">
        <input
          v-model="textVal"
          class="lib-input"
          :type="entry.inputType || 'text'"
          :min="entry.min"
          :max="entry.max"
          :step="entry.step"
          :placeholder="entry.placeholder ? t(entry.placeholder) : ''"
          spellcheck="false"
          autocomplete="off"
        />
      </div>

      <div v-if="descKey && entry.descAfter" class="setting-desc">{{ t(descKey) }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { SettingEntry } from "../settingsIndex";

const props = defineProps<{
  entry: SettingEntry;
  // 说明文案语言包 key（可选覆盖；缺省取 entry.descKey，再回落 settings.<id>Desc）
  descKey?: string;
  // 移动端标记：entry.mobileOnly 时桌面端不渲染（毛玻璃封面等仅移动端设置）
  mobile?: boolean;
}>();

const { t, te } = useI18n();

// 当前值由 entry.get() 驱动（读的是 settings reactive，天然响应式）
const current = computed(() => props.entry.get());

const descKey = computed(() => {
  if (props.descKey) return props.descKey;
  if (props.entry.descKey) return props.entry.descKey;
  const fallback = `settings.${props.entry.id}Desc`;
  return te(fallback) ? fallback : null;
});

// slider：数字双向绑定，写回 entry.set
const sliderVal = computed({
  get: () => current.value,
  set: (v) => props.entry.set(Number(v)),
});

// text：v-model 直写（与改造前 v-model 语义一致；number 输入提交时转数字）
const textVal = computed({
  get: () => current.value,
  set: (v) => props.entry.set(props.entry.inputType === "number" ? Number(v) : v),
});
</script>
