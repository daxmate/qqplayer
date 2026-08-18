<template>
  <!-- 阅读设置抽屉内容（遮罩/过渡在 Reader.vue，与目录抽屉同模式） -->
  <aside class="reader-settings">
    <header class="reader-settings-head">
      <h3 class="reader-settings-title">{{ t("books.settings") }}</h3>
      <button class="reader-btn icon" :title="t('books.close')" @click="emit('close')">
        <X :size="18" />
      </button>
    </header>

    <div class="reader-settings-scroll">
      <!-- 排版预设（iBooks 式顶部一排；只含 字体+字号+行距+边距，颜色走下方独立主题切换） -->
      <section class="reader-settings-group">
        <p class="reader-settings-label">{{ t("books.presets") }}</p>
        <div class="reader-settings-presets">
          <button
            v-for="p in TYPOGRAPHY_PRESETS"
            :key="p.key"
            class="reader-settings-preset"
            :class="{ on: isPresetActive(p) }"
            @click="applyPreset(p)"
          >
            {{ t(p.labelKey) }}
          </button>
        </div>
      </section>

      <!-- 字体族（iBooks 式：每项用自身字形渲染 "Aa" 预览 + 选中打勾） -->
      <section class="reader-settings-group">
        <p class="reader-settings-label">{{ t("books.fontFamily") }}</p>
        <div class="reader-settings-fonts">
          <button
            v-for="opt in READER_FONT_OPTIONS"
            :key="opt.key"
            class="reader-settings-font"
            :class="{ on: settings.fontFamily === opt.key }"
            @click="emit('patch', { fontFamily: opt.key })"
          >
            <span
              class="reader-settings-font-aa"
              :style="opt.fontFamily ? { fontFamily: opt.fontFamily } : undefined"
              >Aa</span
            >
            <span class="reader-settings-font-name">{{ t(opt.labelKey) }}</span>
            <Check
              v-if="settings.fontFamily === opt.key"
              :size="14"
              class="reader-settings-font-check"
            />
          </button>
        </div>
      </section>

      <!-- 粗体开关（iOS 风格，只覆盖正文 body 字重，不影响 EPUB 自带 heading 样式） -->
      <section class="reader-settings-group">
        <div class="reader-settings-toggle-row">
          <span class="reader-settings-label no-margin">{{ t("books.boldText") }}</span>
          <button
            class="reader-settings-switch"
            :class="{ on: settings.bold }"
            role="switch"
            :aria-checked="settings.bold"
            :title="t('books.boldText')"
            @click="emit('patch', { bold: !settings.bold })"
          >
            <span class="reader-settings-switch-knob" />
          </button>
        </div>
      </section>

      <!-- 字号 -->
      <section class="reader-settings-group">
        <p class="reader-settings-label">{{ t("books.fontSize") }}</p>
        <div class="reader-settings-row">
          <button class="reader-btn icon" :title="t('books.decrease')" @click="bumpFontSize(-10)">
            <Minus :size="15" />
          </button>
          <span class="reader-settings-value">{{ settings.fontSize }}%</span>
          <button class="reader-btn icon" :title="t('books.increase')" @click="bumpFontSize(10)">
            <Plus :size="15" />
          </button>
        </div>
      </section>

      <!-- 行距 -->
      <section class="reader-settings-group">
        <p class="reader-settings-label">
          {{ t("books.lineHeight") }}
          <span class="reader-settings-value inline">{{ settings.lineHeight.toFixed(1) }}</span>
        </p>
        <input
          class="reader-settings-range"
          type="range"
          min="1.0"
          max="2.0"
          step="0.1"
          :value="settings.lineHeight"
          @input="onLineHeightInput"
        />
      </section>

      <!-- 页边距 -->
      <section class="reader-settings-group">
        <p class="reader-settings-label">
          {{ t("books.margin") }}
          <span class="reader-settings-value inline">{{ settings.margin }}px</span>
        </p>
        <input
          class="reader-settings-range"
          type="range"
          min="0"
          max="15"
          step="1"
          :value="settings.margin"
          @input="onMarginInput"
        />
      </section>

      <!-- 主题 -->
      <section class="reader-settings-group">
        <p class="reader-settings-label">{{ t("books.theme") }}</p>
        <div class="reader-settings-themes">
          <button
            v-for="opt in THEME_OPTIONS"
            :key="opt.key"
            class="reader-settings-theme"
            :class="{ on: settings.theme === opt.key }"
            :title="t(opt.labelKey)"
            @click="emit('patch', { theme: opt.key })"
          >
            <span class="reader-settings-theme-swatch" :style="opt.swatchStyle">
              <span class="reader-settings-theme-swatch-a">A</span>
            </span>
            <span class="reader-settings-theme-name">{{ t(opt.labelKey) }}</span>
          </button>
        </div>
      </section>

      <!-- 颜色（自定义覆盖主题默认） -->
      <section class="reader-settings-group">
        <p class="reader-settings-label">{{ t("books.colors") }}</p>
        <div class="reader-settings-row">
          <label class="reader-settings-color">
            <span>{{ t("books.textColor") }}</span>
            <input type="color" :value="displayColors.text" @input="onTextColorInput" />
          </label>
          <label class="reader-settings-color">
            <span>{{ t("books.bgColor") }}</span>
            <input type="color" :value="displayColors.bg" @input="onBgColorInput" />
          </label>
        </div>
        <button
          class="reader-settings-chip reset"
          :disabled="!settings.textColor && !settings.bgColor"
          @click="emit('patch', { textColor: '', bgColor: '' })"
        >
          {{ t("books.restoreThemeColors") }}
        </button>
      </section>

      <!-- 还原所有设置（一键回默认并保存） -->
      <button class="reader-settings-reset-all" @click="emit('reset')">
        {{ t("books.resetAll") }}
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Minus, Plus, X } from "@lucide/vue";
import type { ReaderSettings } from "./types";
import {
  READER_FONT_OPTIONS,
  READER_THEME_PRESETS,
  TYPOGRAPHY_PRESETS,
  type TypographyPreset,
  resolveReaderThemeColors,
} from "./settings";

const props = defineProps<{ settings: ReaderSettings }>();
const emit = defineEmits<{
  patch: [patch: Partial<ReaderSettings>];
  reset: [];
  close: [];
}>();

const { t } = useI18n();

const THEME_OPTIONS: {
  key: ReaderSettings["theme"];
  labelKey: string;
  swatchStyle: Record<string, string>;
}[] = [
  {
    key: "light",
    labelKey: "books.themeLight",
    swatchStyle: {
      background: READER_THEME_PRESETS.light.bg,
      color: READER_THEME_PRESETS.light.text,
    },
  },
  {
    key: "sepia",
    labelKey: "books.themeSepia",
    swatchStyle: {
      background: READER_THEME_PRESETS.sepia.bg,
      color: READER_THEME_PRESETS.sepia.text,
    },
  },
  {
    key: "dark",
    labelKey: "books.themeDark",
    swatchStyle: {
      background: READER_THEME_PRESETS.dark.bg,
      color: READER_THEME_PRESETS.dark.text,
    },
  },
  {
    key: "auto",
    labelKey: "books.themeAuto",
    // 跟随系统：左右各半预览
    swatchStyle: {
      background: `linear-gradient(90deg, ${READER_THEME_PRESETS.light.bg} 50%, ${READER_THEME_PRESETS.dark.bg} 50%)`,
      color: READER_THEME_PRESETS.dark.text,
    },
  },
];

/** 颜色选择器展示值：未自定义时显示当前主题生效色（输入框要求合法 #rrggbb） */
const displayColors = computed(() => resolveReaderThemeColors(props.settings));

/**
 * 预设命中：字体+字号+行距都相同就算（边距忽略，近似匹配即可）；
 * 这样用户点过预设再微调边距，预设仍保持高亮。
 */
function isPresetActive(p: TypographyPreset): boolean {
  const s = props.settings;
  return (
    s.fontFamily === p.fontFamily && s.fontSize === p.fontSize && s.lineHeight === p.lineHeight
  );
}

/** 点击预设：一次性 patch 字体+字号+行距+边距（不动颜色 theme） */
function applyPreset(p: TypographyPreset) {
  emit("patch", {
    fontFamily: p.fontFamily,
    fontSize: p.fontSize,
    lineHeight: p.lineHeight,
    margin: p.margin,
  });
}

function clampFontSize(v: number): number {
  return Math.min(200, Math.max(70, v));
}

function bumpFontSize(delta: number) {
  const next = clampFontSize(props.settings.fontSize + delta);
  if (next === props.settings.fontSize) return;
  emit("patch", { fontSize: next });
}

function onLineHeightInput(e: Event) {
  const v = Number((e.target as HTMLInputElement).value);
  const next = Math.round(Math.min(2.0, Math.max(1.0, v)) * 10) / 10;
  if (next !== props.settings.lineHeight) emit("patch", { lineHeight: next });
}

function onMarginInput(e: Event) {
  const next = Math.round(Number((e.target as HTMLInputElement).value));
  if (next !== props.settings.margin) emit("patch", { margin: next });
}

function onTextColorInput(e: Event) {
  emit("patch", { textColor: (e.target as HTMLInputElement).value });
}

function onBgColorInput(e: Event) {
  emit("patch", { bgColor: (e.target as HTMLInputElement).value });
}
</script>

<style scoped>
.reader-settings {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: min(300px, 88%);
  display: flex;
  flex-direction: column;
  background: var(--card);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
}
.reader-settings-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--border);
}
.reader-settings-title {
  font-size: 15px;
  font-weight: 700;
}
.reader-settings-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 20px;
}
.reader-settings-group {
  margin-bottom: 14px;
}
.reader-settings-label {
  margin-bottom: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
}
.reader-settings-label.no-margin {
  margin-bottom: 0;
}
.reader-settings-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.reader-settings-value {
  min-width: 44px;
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.reader-settings-value.inline {
  min-width: 0;
  margin-left: 6px;
  font-weight: 600;
}
/* 排版预设：顶部一排 */
.reader-settings-presets {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.reader-settings-preset {
  padding: 6px 0;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text2);
  font-size: 12px;
  font-weight: 600;
  transition: all 0.15s;
}
.reader-settings-preset:hover {
  border-color: var(--accent);
  color: var(--text);
}
.reader-settings-preset.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-text);
}
/* 字体列表：iBooks 式两列网格，每项 Aa 自身字形预览 + 名称 + 选中打勾 */
.reader-settings-fonts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.reader-settings-font {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 7px 8px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text2);
  transition: all 0.15s;
}
.reader-settings-font:hover {
  border-color: var(--accent);
  color: var(--text);
}
.reader-settings-font.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-text);
}
.reader-settings-font-aa {
  flex-shrink: 0;
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
}
.reader-settings-font-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.reader-settings-font-check {
  flex-shrink: 0;
  color: var(--accent-text);
}
/* 粗体开关：iOS 风格 switch */
.reader-settings-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0;
}
.reader-settings-switch {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: 11px;
  border: none;
  background: var(--border);
  transition: background 0.15s;
  flex-shrink: 0;
  cursor: pointer;
}
.reader-settings-switch.on {
  background: var(--accent);
}
.reader-settings-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: left 0.15s;
}
.reader-settings-switch.on .reader-settings-switch-knob {
  left: 18px;
}
.reader-settings-chip {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text2);
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.15s;
}
.reader-settings-chip:hover {
  border-color: var(--accent);
  color: var(--text);
}
.reader-settings-chip.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-text);
}
.reader-settings-chip.reset {
  margin-top: 10px;
  display: block;
  width: 100%;
}
.reader-settings-chip.reset:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.reader-settings-range {
  width: 100%;
  accent-color: var(--accent);
}
.reader-settings-themes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.reader-settings-theme {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card2);
  transition: all 0.15s;
}
.reader-settings-theme:hover {
  border-color: var(--accent);
}
.reader-settings-theme.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.reader-settings-theme-swatch {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 38px;
  border-radius: 7px;
  border: 1px solid rgba(128, 128, 128, 0.35);
}
.reader-settings-theme-swatch-a {
  font-size: 15px;
  font-weight: 800;
}
.reader-settings-theme-name {
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text2);
}
.reader-settings-color {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  flex: 1;
  font-size: 12px;
  color: var(--text2);
}
.reader-settings-color input[type="color"] {
  width: 100%;
  height: 34px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card2);
  cursor: pointer;
}
/* 还原所有设置：面板底部，破坏性红色（iBooks 式） */
.reader-settings-reset-all {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 8px 0;
  border-radius: 8px;
  border: 1px solid var(--red-soft);
  background: var(--red-soft);
  color: var(--red);
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.15s;
}
.reader-settings-reset-all:hover {
  border-color: var(--red);
  background: var(--red);
  color: #fff;
}
</style>
