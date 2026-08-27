/**
 * 阅读设置（useReaderSettings）——从 Reader.vue 拆出（P3 拆分，行为零变化）。
 *
 * 职责：阅读设置状态（readerSettings）+ 后端 /api/settings books namespace 读写 +
 * 旧字号 localStorage 一次性迁移 + 设置抽屉开合 + 字号增减。
 * 设置应用到 epub.js 由 useReaderStyling 负责（apply 选项晚绑定注入）。
 */
import { computed, reactive, ref } from "vue";
import type { Ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ReaderSettings } from "../books/types";
import {
  READER_SETTINGS_DEFAULTS,
  getReaderSettings,
  saveReaderSettings,
  resolveReaderThemeColors,
} from "../books/settings";
import { showToast } from "./useToast.js";
import { uiSettings } from "./useSettings.js";

export function useReaderSettings(options: {
  /** 目录抽屉开关（Reader 主组件持有） */
  tocOpen: Ref<boolean>;
  /** 标注侧栏开关（useAnnotations 持有） */
  panelOpen: Ref<boolean>;
  /** 设置应用到当前渲染（useReaderStyling.applyReaderSettings；晚绑定，调用时已就绪） */
  apply: () => void;
}) {
  const { tocOpen, panelOpen, apply } = options;
  const { t } = useI18n();

  // ============ 阅读设置（后端 /api/settings books namespace；localStorage 只读不写） ============
  // 旧字号 localStorage 键（V1 遗留，仅一次性迁移读取，迁移成功后清除）
  const LEGACY_FONT_KEY = "qqplayer.books.fontSize";
  const settingsOpen = ref(false);
  const readerSettings = reactive<ReaderSettings>({ ...READER_SETTINGS_DEFAULTS });

  /** 查词弹窗主题色（与阅读器当前生效主题一致；dark 驱动词典 CSS 覆盖层） */
  const dictThemeColors = computed(() => {
    const { text, bg } = resolveReaderThemeColors(readerSettings);
    const theme = readerSettings.theme;
    const dark =
      theme === "dark" ||
      theme === "sepia" ||
      (theme === "auto" &&
        (uiSettings.theme === "dark" ||
          (uiSettings.theme === "auto" &&
            typeof document !== "undefined" &&
            document.documentElement.dataset.theme !== "light")));
    return { text, bg, dark };
  });
  let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** 旧字号：localStorage 读取（70~200 合法才认），读不到返回 null */
  function readLegacyFontSize(): number | null {
    try {
      const saved = Number(localStorage.getItem(LEGACY_FONT_KEY));
      return Number.isFinite(saved) && saved >= 70 && saved <= 200 ? saved : null;
    } catch {
      return null; // 隐私模式等场景 localStorage 不可用
    }
  }

  /** 初始化：读后端设置；若后端 fontSize 仍是默认 100 且 localStorage 有旧值 → 一次性迁移（PUT + 清除） */
  async function loadReaderSettings() {
    const saved = await getReaderSettings();
    const legacy = readLegacyFontSize();
    const migrated =
      legacy !== null && saved.fontSize === READER_SETTINGS_DEFAULTS.fontSize
        ? { ...saved, fontSize: legacy }
        : saved;
    Object.assign(readerSettings, migrated);
    apply();
    if (migrated.fontSize !== saved.fontSize) {
      // 迁移：旧值写回后端，成功后清除 localStorage；失败保留旧值下次再迁
      saveReaderSettings({ fontSize: migrated.fontSize }).then((ok) => {
        if (ok) {
          try {
            localStorage.removeItem(LEGACY_FONT_KEY);
          } catch {
            /* 忽略清除失败 */
          }
        }
      });
    }
  }

  /** 用户改设置：合并进 reactive（watch 即时应用）+ 防抖 300ms 写回后端（深合并） */
  function onSettingsPatch(patch: Partial<ReaderSettings>) {
    Object.assign(readerSettings, patch);
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(() => {
      settingsSaveTimer = null;
      saveReaderSettings({ ...readerSettings });
    }, 300);
  }

  /** 还原所有设置：全部字段回默认 → 即时应用（watch）→ 立即保存（取消未落地的防抖）→ 成功 toast */
  async function onResetSettings() {
    if (settingsSaveTimer) {
      clearTimeout(settingsSaveTimer);
      settingsSaveTimer = null;
    }
    Object.assign(readerSettings, READER_SETTINGS_DEFAULTS);
    const ok = await saveReaderSettings({ ...READER_SETTINGS_DEFAULTS });
    if (ok) showToast(t("books.settingsResetDone"));
  }

  function toggleSettings() {
    settingsOpen.value = !settingsOpen.value;
    if (settingsOpen.value) {
      tocOpen.value = false;
      panelOpen.value = false;
    }
  }

  function toggleToc() {
    tocOpen.value = !tocOpen.value;
    if (tocOpen.value) {
      settingsOpen.value = false;
      panelOpen.value = false;
    }
  }

  function bumpFontSize(delta: number) {
    const next = Math.min(200, Math.max(70, readerSettings.fontSize + delta));
    if (next === readerSettings.fontSize) return;
    onSettingsPatch({ fontSize: next });
  }

  /** teardown 用：取消未落地的防抖写回（与 Reader 原 teardown 清理语义一致） */
  function clearSaveTimer() {
    if (settingsSaveTimer) {
      clearTimeout(settingsSaveTimer);
      settingsSaveTimer = null;
    }
  }

  return {
    settingsOpen,
    readerSettings,
    dictThemeColors,
    loadReaderSettings,
    onSettingsPatch,
    onResetSettings,
    toggleSettings,
    toggleToc,
    bumpFontSize,
    clearSaveTimer,
  };
}
