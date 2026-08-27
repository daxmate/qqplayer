<template>
  <!-- 嵌入式模式（iOS 壳负一屏设置区）：无 Teleport、无 modal 外壳/遮罩/侧边导航，仅渲染当前 tab 面板内容区 -->
  <Teleport to="body" :disabled="embedded">
    <div v-if="open" class="modal-mask" :class="{ embedded }" @click.self="onMaskClick">
      <div class="modal" :class="{ embedded }">
        <!-- 头部（嵌入式隐藏：头部由 MobileSettings 提供） -->
        <div v-if="!embedded" class="modal-head">
          <button v-if="isMobile" class="modal-back" :title="t('settings.back')" @click="close">
            <ChevronDown :size="18" />
          </button>
          <Settings :size="16" />
          {{ t("settings.title") }}
          <span class="head-sub">QQ Player v{{ version }}</span>
          <button class="modal-close" :title="t('common.close')" @click="close">
            <X :size="16" />
          </button>
        </div>

        <!-- 主体：左导航 + 右内容（嵌入式隐藏左导航） -->
        <div class="modal-body" :class="{ embedded }">
          <nav v-if="!embedded" class="side-nav">
            <button
              v-for="c in categories"
              :key="c.key"
              class="nav-item"
              :class="{ on: tab === c.key }"
              @click="tab = c.key"
            >
              <component :is="c.icon" :size="15" />
              {{ t(c.labelKey) }}
            </button>
          </nav>

          <div class="content">
            <!-- ============ 播放（面板组件：SettingsModal 拆分 · P3） ============ -->
            <section v-if="tab === 'playback'" class="settings-scroll">
              <PlaybackSettingsPanel />
            </section>

            <!-- ============ 音乐库 ============ -->
            <section v-else-if="tab === 'library'" class="settings-scroll">
              <LibrarySettingsPanel @close="close" />
            </section>

            <!-- ============ 视频 ============ -->
            <section v-else-if="tab === 'video'" class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <Video :size="13" />
                  {{ t("settings.video") }}
                </div>
                <template v-for="e in videoEntries" :key="e.id">
                  <SettingRow v-if="!e.render" :entry="e" />
                  <!-- 浏览器 Cookie 来源：原生 select（照抄原模板） -->
                  <div v-else-if="e.id === 'cookiesFromBrowser'" class="setting-item">
                    <div class="setting-label">{{ t("settings.cookiesFromBrowser") }}</div>
                    <div class="setting-desc">{{ t("settings.cookiesFromBrowserDesc") }}</div>
                    <div class="setting-control">
                      <select v-model="videoSettings.cookiesFromBrowser" class="lib-input">
                        <option value="">{{ t("settings.cookiesFromBrowserNone") }}</option>
                        <option value="vivaldi">Vivaldi</option>
                        <option value="chrome">Chrome</option>
                        <option value="safari">Safari</option>
                        <option value="edge">Edge</option>
                        <option value="firefox">Firefox</option>
                        <option value="brave">Brave</option>
                      </select>
                    </div>
                  </div>
                </template>
              </div>
            </section>

            <!-- ============ 下载 ============ -->
            <section v-else-if="tab === 'download'" class="settings-scroll">
              <DownloadSettingsPanel />
            </section>

            <!-- ============ 同步（iOS 壳 → 负一屏同步中心入口；非 iOS 保留现状） ============ -->
            <section v-else-if="tab === 'sync'" class="settings-scroll">
              <SyncSettingsPanel :embedded="embedded" @open-sync="onOpenSync" />
            </section>

            <!-- ============ 刮削 ============ -->
            <section v-else-if="tab === 'scrape'" class="settings-scroll">
              <ScrapeSettingsPanel />
            </section>

            <!-- ============ 歌词 ============ -->
            <section v-else-if="tab === 'lyric'" class="settings-scroll">
              <!-- 子 tab：APP 歌词 / 桌面歌词（桌面歌词是桌面壳功能，移动端隐藏子 tab——审计 L1） -->
              <div class="lyric-subtabs">
                <button
                  class="seg-btn"
                  :class="{ on: lyricSubTab === 'app' }"
                  @click="lyricSubTab = 'app'"
                >
                  {{ t("settings.lyricApp") }}
                </button>
                <button
                  v-if="!isMobile"
                  class="seg-btn"
                  :class="{ on: lyricSubTab === 'desktop' }"
                  @click="lyricSubTab = 'desktop'"
                >
                  {{ t("settings.lyricDesktop") }}
                </button>
              </div>

              <LyricSettingsPanel v-if="lyricSubTab === 'app'" />

              <!-- ============ 桌面歌词（子 tab；移动端不可达：子 tab 按钮已隐藏，此处显式守卫防未来代码直达） ============ -->
              <DesktopSettingsPanel v-else-if="lyricSubTab === 'desktop' && !isMobile" />
            </section>

            <!-- ============ 界面 ============ -->
            <section v-else-if="tab === 'ui'" class="settings-scroll">
              <AppearanceSettingsPanel />
            </section>

            <!-- ============ 快捷键 ============ -->
            <section v-else-if="tab === 'shortcuts'" class="settings-scroll">
              <ShortcutsSettingsPanel />
            </section>

            <!-- ============ 配对（iOS 壳隐藏） ============ -->
            <section v-else-if="tab === 'pairing'" class="settings-scroll">
              <PairingSettings />
            </section>

            <!-- ============ 关于 ============ -->
            <section v-else class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <Info :size="13" />
                  {{ t("settings.about") }}
                </div>
                <div class="about-author">
                  <img
                    class="about-logo"
                    src="https://github.com/daxmate.png?size=96"
                    alt="daxmate"
                  />
                  <div class="about-author-info">
                    <div class="about-name">daxmate</div>
                    <div class="about-tagline">{{ t("settings.aboutTagline") }}</div>
                  </div>
                </div>
                <div class="about-item">
                  <span class="about-label">{{ t("settings.version") }}</span>
                  <span class="about-value about-version" @click="onVersionClick"
                    >v{{ version }}</span
                  >
                </div>
                <div class="about-item">
                  <span class="about-label">{{ t("settings.dataDir") }}</span>
                  <span class="about-value mono">{{ dataDir }}</span>
                </div>
                <div class="about-item">
                  <span class="about-label">{{ t("settings.localAccess") }}</span>
                  <a class="about-value mono link" :href="localUrl" target="_blank">{{
                    localUrl
                  }}</a>
                </div>
                <div class="about-item">
                  <span class="about-label">{{ t("settings.repoHome") }}</span>
                  <a class="about-value mono link" :href="repoUrl" target="_blank"
                    >github.com/daxmate/qqplayer</a
                  >
                </div>
                <p class="about-desc">
                  {{ t("settings.aboutDesc") }}
                </p>
                <p v-if="eggVisible" class="about-easter-egg">🐘</p>
              </div>
            </section>
          </div>
        </div>

        <!-- 底部操作栏 -->
        <div class="modal-foot">
          <button class="reset-btn" :title="t('settings.resetAllTitle')" @click="resetAll">
            <RotateCcw :size="13" />
            {{ t("settings.resetAll") }}
          </button>
          <button class="btn primary" @click="close">{{ t("settings.done") }}</button>
        </div>
      </div>
      <!-- 批量刮削结果面板（多选批量 / 一键整库共用） -->
      <ScrapeResultModal />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Settings, X, ChevronDown, Info, RotateCcw, Video } from "@lucide/vue";
import {
  saveLibrarySettings,
  uiSettings,
  playbackSettings,
  downloadSettings,
  DOWNLOAD_SETTINGS_DEFAULTS,
  videoSettings,
  VIDEO_SETTINGS_DEFAULTS,
  resetLyricSettingsToDefaults,
  UI_SETTINGS_DEFAULTS,
  PLAYBACK_SETTINGS_DEFAULTS,
} from "../composables/usePlayer.js";
import { getSettingsCategories } from "../composables/useSettingsCategories.js";
import { isMobile } from "../composables/useMobileViewport.js";
import PairingSettings from "./PairingSettings.vue";
import ScrapeResultModal from "./ScrapeResultModal.vue";
import SettingRow from "./SettingRow.vue";
import PlaybackSettingsPanel from "./settings/PlaybackSettingsPanel.vue";
import LyricSettingsPanel from "./settings/LyricSettingsPanel.vue";
import DesktopSettingsPanel from "./settings/DesktopSettingsPanel.vue";
import AppearanceSettingsPanel from "./settings/AppearanceSettingsPanel.vue";
import DownloadSettingsPanel from "./settings/DownloadSettingsPanel.vue";
import ShortcutsSettingsPanel from "./settings/ShortcutsSettingsPanel.vue";
import SyncSettingsPanel from "./settings/SyncSettingsPanel.vue";
import ScrapeSettingsPanel from "./settings/ScrapeSettingsPanel.vue";
import LibrarySettingsPanel from "./settings/LibrarySettingsPanel.vue";
import { entriesByCategory } from "../settingsIndex";
import pkg from "../../package.json";

const props = defineProps({
  open: { type: Boolean, default: false },
  // 嵌入式面板模式（iOS 壳负一屏设置区）：无 modal 外壳/遮罩/导航，仅渲染当前 tab 面板；
  // 配合 initialTab（进入时定位面板）使用；桌面弹窗行为不变。
  embedded: { type: Boolean, default: false },
  initialTab: { type: String, default: "ui" },
});
const emit = defineEmits(["close", "open-sync"]);

const { t } = useI18n();

const version = pkg.version;

// ---- 关于页彩蛋：连点版本号 5 次 → 🐘 ----
const eggVisible = ref(false);
let eggClicks = 0;
let eggTimer: number | null = null;
function onVersionClick() {
  eggClicks++;
  clearTimeout(eggTimer ?? undefined);
  eggTimer = setTimeout(() => (eggClicks = 0), 1500);
  if (eggClicks >= 5) {
    eggClicks = 0;
    eggVisible.value = true;
    setTimeout(() => (eggVisible.value = false), 3200);
    window.alert(t("settings.aboutEasterEggText"));
  }
}

const dataDir = "~/Library/Application Support/qqplayer";
const localUrl = "http://localhost:17627";
const repoUrl = "https://github.com/daxmate/qqplayer";

const tab = ref(props.initialTab);
const lyricSubTab = ref("app"); // 歌词 tab 子页：'app' APP 歌词 | 'desktop' 桌面歌词
// 分类导航：与移动端设置区抽屉共用（useSettingsCategories，避免双份维护）
// 每次实例创建时求值（isPairingEnabled 非响应式，模块级缓存会过期）
const categories = computed(() => getSettingsCategories());

// ============ 注册表驱动渲染（P0-2）：普通设置 tab 的项来自 settingsIndex 注册表 ============
// 分组保留手写结构，组内按注册表顺序渲染：纯简单项走 SettingRow，特殊交互项按 id 分发手写块
// （render 标记的非宿主项（如 eqPreset/ambientEnabled 等块内成员）自然落空不渲染）。
const videoEntries = entriesByCategory("video");
// 恢复默认：重置全部设置为出厂值（watch 自动持久化；音乐库设置走后端）
function resetAll() {
  Object.assign(playbackSettings, PLAYBACK_SETTINGS_DEFAULTS);
  resetLyricSettingsToDefaults(); // 歌词：AMLL 三特效按环境差异化（壳满血 / 浏览器默认关）
  Object.assign(uiSettings, UI_SETTINGS_DEFAULTS);
  Object.assign(downloadSettings, DOWNLOAD_SETTINGS_DEFAULTS);
  Object.assign(videoSettings, VIDEO_SETTINGS_DEFAULTS);
  // 音乐库设置走后端（与 settingsIndex 库项 set() 同款直调；拆分后面板 saveLib 自带防抖，
  // 重置为一次性动作无需防抖）
  saveLibrarySettings({
    audioExts: [".mp3", ".flac", ".m4a", ".wav", ".ogg", ".aac", ".opus"],
    ignoreHidden: true,
    autoRefresh: true,
    autoScanOnStart: true,
  }).catch(() => {
    /* 忽略：库设置保存失败不阻塞其余设置重置 */
  });
}

// 每次打开时复位到 initialTab（嵌入式常驻实例由 :key 重挂，面板按需加载由各面板 onMounted 负责）
watch(
  () => props.open,
  (o) => {
    if (o) {
      tab.value = props.initialTab;
    }
  },
);

function close() {
  emit("close");
}

// 同步中心入口（iOS 壳负一屏）：面板内部按钮 → 容器转发给父组件
function onOpenSync() {
  emit("open-sync");
}

// 嵌入式模式遮罩点击不关闭（无遮罩语义）；弹窗模式保持点遮罩关闭
function onMaskClick() {
  if (!props.embedded) close();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  clearTimeout(eggTimer ?? undefined);
});
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
/* 嵌入式面板模式（iOS 壳负一屏设置区）：无遮罩/无弹窗外壳，作为页面内容区渲染 */
.modal-mask.embedded {
  position: static;
  inset: auto;
  width: 100%;
  height: 100%;
  background: none;
  backdrop-filter: none;
  display: block;
  z-index: auto;
}
.modal.embedded {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: none;
  border-radius: 0;
  border: none;
  box-shadow: none;
}
.modal-body.embedded {
  display: flex;
  flex: 1;
  min-height: 0;
}
/* 嵌入式面板内容区：移动端密度（弹窗的 22px 左右内边距偏宽） */
.modal-mask.embedded .settings-scroll {
  padding: 14px 14px 24px;
}
.modal {
  width: min(780px, calc(100vw - 40px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow:
    0 24px 80px var(--shadow-strong),
    0 4px 16px var(--shadow-sm);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: min(640px, calc(100vh - 60px));
}
.modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  font-size: 15px;
  font-weight: 700;
  border-bottom: 1px solid var(--border);
}
.modal-head svg {
  color: var(--accent);
}
.head-sub {
  font-size: 12px;
  font-weight: 500;
  color: var(--text3);
  margin-left: 2px;
}
.modal-close {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  transition: all 0.15s;
}
@media (hover: hover) {
  .modal-close:hover {
    background: var(--card2);
    color: var(--text);
  }
}
/* 移动端返回按钮（仅 <1024px 渲染，桌面不出现） */
.modal-back {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  transition: all 0.15s;
  flex-shrink: 0;
}
.modal-back:active {
  background: var(--card2);
  color: var(--text);
}

/* ============ 主体：左导航 + 右内容 ============ */
.modal-body {
  display: flex;
  min-height: 0;
  flex: 1;
}
.side-nav {
  width: 158px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 10px;
  border-right: 1px solid var(--border);
  background: var(--bg2);
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
  text-align: left;
  position: relative;
}
.nav-item svg {
  color: var(--text3);
  transition: color 0.15s;
}
@media (hover: hover) {
  .nav-item:hover {
    background: var(--card2);
    color: var(--text);
  }
  .nav-item:hover svg {
    color: var(--text2);
  }
}
.nav-item.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.nav-item.on svg {
  color: #fff;
}
/* 选中态：左侧指示条（多层阴影叠加出霓虹感） */
.nav-item.on::before {
  content: "";
  position: absolute;
  left: -10px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--accent), var(--accent2));
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 70%, transparent);
}

.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.settings-scroll {
  padding: 18px 22px 28px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.group-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--accent2);
  letter-spacing: 1.5px;
  margin-bottom: 10px;
}
/* 面板内 group-title（settings/ 面板渲染在 .settings-scroll 内，:deep 穿透） */
:deep(.group-title) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--accent2);
  letter-spacing: 1.5px;
  margin-bottom: 10px;
}
.setting-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.setting-item:last-child {
  margin-bottom: 0;
}
:deep(.setting-item) {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
:deep(.setting-item:last-child) {
  margin-bottom: 0;
}
.setting-label {
  font-size: 14px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.setting-label svg {
  color: var(--text2);
}
.setting-desc {
  font-size: 12px;
  color: var(--text3);
}
.setting-control {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.lib-input {
  flex: 1;
  min-width: 0;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.lib-input:focus {
  border-color: var(--accent);
}
:deep(.setting-label) {
  font-size: 14px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
:deep(.setting-label svg) {
  color: var(--text2);
}
:deep(.setting-desc) {
  font-size: 12px;
  color: var(--text3);
}
:deep(.setting-control) {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
:deep(.lib-input) {
  flex: 1;
  min-width: 0;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
:deep(.lib-input:focus) {
  border-color: var(--accent);
}
.btn {
  border-radius: 10px;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s;
  white-space: nowrap;
  color: var(--text2);
  background: var(--card2);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
@media (hover: hover) {
  .btn:hover {
    filter: brightness(1.1);
    color: var(--text);
  }
}
.btn.primary {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
/* 面板内按钮（settings/ 面板），:deep 穿透 */
:deep(.btn) {
  border-radius: 10px;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s;
  white-space: nowrap;
  color: var(--text2);
  background: var(--card2);
}
:deep(.btn:disabled) {
  opacity: 0.6;
  cursor: not-allowed;
}
@media (hover: hover) {
  :deep(.btn:hover) {
    filter: brightness(1.1);
    color: var(--text);
  }
}
:deep(.btn.primary) {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
:deep(.btn.danger) {
  color: #ff6b6b;
  border-color: color-mix(in srgb, #ff6b6b 40%, var(--border));
}
:deep(.btn.danger:hover) {
  background: color-mix(in srgb, #ff6b6b 12%, transparent);
}
:deep(.setting-error) {
  font-size: 12px;
  color: #ff6b6b;
}
:deep(.mini-btn) {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
  vertical-align: 1px;
}
@media (hover: hover) {
  :deep(.mini-btn:hover) {
    color: var(--text);
    border-color: var(--accent);
  }
}
.setting-error {
  font-size: 12px;
  color: #ff6b6b;
}

.btn.danger {
  color: #ff6b6b;
  border-color: color-mix(in srgb, #ff6b6b 40%, var(--border));
}
.btn.danger:hover {
  background: color-mix(in srgb, #ff6b6b 12%, transparent);
}

/* 行内小按钮（重置等） */
.mini-btn {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
  vertical-align: 1px;
}
@media (hover: hover) {
  .mini-btn:hover {
    color: var(--text);
    border-color: var(--accent);
  }
}

/* 文件类型多选（chip 网格） */
.ext-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.ext-chip {
  min-width: 58px;
  padding: 7px 12px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
}
@media (hover: hover) {
  .ext-chip:hover {
    color: var(--text);
    border-color: var(--text3);
  }
}
.ext-chip.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  border-color: transparent;
  box-shadow: 0 2px 8px var(--accent-glow2);
}
:deep(.ext-grid) {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
:deep(.ext-chip) {
  min-width: 58px;
  padding: 7px 12px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
}
@media (hover: hover) {
  :deep(.ext-chip:hover) {
    color: var(--text);
    border-color: var(--text3);
  }
}
:deep(.ext-chip.on) {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  border-color: transparent;
  box-shadow: 0 2px 8px var(--accent-glow2);
}

/* 歌词 tab 子页切换（APP 歌词 / 桌面歌词） */
.lyric-subtabs {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  padding: 3px;
  background: var(--bg2);
  border-radius: 12px;
  width: fit-content;
}
.lyric-subtabs .seg-btn {
  padding: 7px 18px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
}
.lyric-subtabs .seg-btn.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}

/* 桌面歌词配色方案（双色块 + 名称）：Lyric/Desktop 两面板共用，:deep 穿透继承 */
:deep(.desktop-schemes) {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 8px;
}
:deep(.scheme-swatch) {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 9px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card2);
  cursor: pointer;
  transition: all 0.15s;
}
@media (hover: hover) {
  :deep(.scheme-swatch:hover) {
    border-color: var(--text3);
  }
}
:deep(.scheme-swatch.on) {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
:deep(.scheme-dot) {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.25);
  flex-shrink: 0;
}
:deep(.scheme-name) {
  font-size: 11px;
  color: var(--text2);
  white-space: nowrap;
}

/* 桌面歌词字体颜色（主行/翻译两个色块） */
:deep(.desktop-colors) {
  display: flex;
  gap: 14px;
  margin-top: 8px;
}
:deep(.color-field) {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text2);
}
:deep(.color-input) {
  width: 34px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
}
:deep(.color-input::-webkit-color-swatch-wrapper) {
  padding: 2px;
}
:deep(.color-input::-webkit-color-swatch) {
  border: none;
  border-radius: 4px;
}

/* 分段选择器 */
.seg {
  display: flex;
  gap: 6px;
  background: var(--bg2);
  border-radius: 10px;
  padding: 3px;
}
.seg-btn {
  flex: 1;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
  white-space: nowrap;
}
@media (hover: hover) {
  .seg-btn:hover {
    color: var(--text);
  }
}
.seg-btn.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 2px 8px var(--accent-glow2);
}
:deep(.seg) {
  display: flex;
  gap: 6px;
  background: var(--bg2);
  border-radius: 10px;
  padding: 3px;
}
:deep(.seg-btn) {
  flex: 1;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
  white-space: nowrap;
}
@media (hover: hover) {
  :deep(.seg-btn:hover) {
    color: var(--text);
  }
}
:deep(.seg-btn.on) {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 2px 8px var(--accent-glow2);
}
.val-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 8px;
  border-radius: 8px;
  margin-left: 4px;
  white-space: nowrap;
}
:deep(.val-badge) {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 8px;
  border-radius: 8px;
  margin-left: 4px;
  white-space: nowrap;
}

/* 滑杆 */
.slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: var(--bg2);
  outline: none;
  margin: 6px 0 2px;
}
.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: pointer;
  transition: transform 0.15s;
}
@media (hover: hover) {
  .slider::-webkit-slider-thumb:hover {
    transform: scale(1.15);
  }
}
.slider::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: pointer;
}
:deep(.slider) {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: var(--bg2);
  outline: none;
  margin: 6px 0 2px;
}
:deep(.slider)::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: pointer;
  transition: transform 0.15s;
}
@media (hover: hover) {
  :deep(.slider)::-webkit-slider-thumb:hover {
    transform: scale(1.15);
  }
}
:deep(.slider)::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: 3px solid var(--bg);
  box-shadow: 0 0 0 1px var(--accent);
  cursor: pointer;
}
/* 开关 */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  padding: 2px 0;
}
:deep(.toggle-row) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  padding: 2px 0;
}
/* 开关 */
.switch {
  flex-shrink: 0;
  width: 48px;
  height: 26px;
  border-radius: 13px;
  background: var(--card2);
  position: relative;
  transition: background 0.2s;
  border: 1px solid var(--border);
}
.switch i {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px var(--shadow-sm);
}
.switch.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border-color: transparent;
}
.switch.on i {
  transform: translateX(22px);
}
:deep(.switch) {
  flex-shrink: 0;
  width: 48px;
  height: 26px;
  border-radius: 13px;
  background: var(--card2);
  position: relative;
  transition: background 0.2s;
  border: 1px solid var(--border);
}
:deep(.switch i) {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px var(--shadow-sm);
}
:deep(.switch.on) {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border-color: transparent;
}
:deep(.switch.on i) {
  transform: translateX(22px);
}
:deep(.hint) {
  margin-top: 10px;
  line-height: 1.6;
}

/* 关于 */
.about-author {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 2px 14px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.about-logo {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  flex: none;
}
.about-author-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.about-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.about-tagline {
  font-size: 12px;
  color: var(--text2);
}
.about-version {
  cursor: pointer;
  user-select: none;
  transition: transform 0.1s ease;
}
.about-version:active {
  transform: scale(0.92);
}
.about-easter-egg {
  font-size: 34px;
  text-align: center;
  margin: 12px 0 0;
  animation: about-egg-bounce 0.8s ease infinite;
}
@keyframes about-egg-bounce {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-10px);
  }
}
.about-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 2px;
}
.about-label {
  width: 76px;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text3);
}
.about-value {
  font-size: 13px;
  color: var(--text);
}
.mono {
  font-family: "SF Mono", "Menlo", monospace;
  font-size: 12px;
}
.link {
  color: var(--accent);
  text-decoration: none;
}
@media (hover: hover) {
  .link:hover {
    text-decoration: underline;
  }
}
.about-desc {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text2);
}

/* 底部操作栏 */
.modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg2);
}
.reset-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  border: 1px solid var(--border);
  transition: all 0.15s;
}
@media (hover: hover) {
  .reset-btn:hover {
    background: rgba(255, 107, 107, 0.12);
    border-color: rgba(255, 107, 107, 0.4);
    color: #ff6b6b;
  }
}
</style>
