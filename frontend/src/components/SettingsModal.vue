<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="close">
      <div class="modal">
        <!-- 头部 -->
        <div class="modal-head">
          <Settings :size="16" />
          设置
          <span class="head-sub">QQ Player v{{ version }}</span>
          <button class="modal-close" title="关闭" @click="close">
            <X :size="16" />
          </button>
        </div>

        <!-- 主体：左导航 + 右内容 -->
        <div class="modal-body">
          <nav class="side-nav">
            <button
              v-for="c in categories"
              :key="c.key"
              class="nav-item"
              :class="{ on: tab === c.key }"
              @click="tab = c.key"
            >
              <component :is="c.icon" :size="15" />
              {{ c.label }}
            </button>
          </nav>

          <div class="content">
            <!-- ============ 播放 ============ -->
            <section v-if="tab === 'playback'" class="settings-scroll">
              <div class="group">
                <div class="setting-item">
                  <div class="setting-label">播放模式</div>
                  <div class="setting-desc">启动时恢复上次选择的模式</div>
                  <div class="seg">
                    <button
                      v-for="m in playModeOptions"
                      :key="m.value"
                      class="seg-btn"
                      :class="{ on: playbackSettings.playMode === m.value }"
                      @click="playbackSettings.playMode = m.value"
                    >
                      {{ m.label }}
                    </button>
                  </div>
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="playbackSettings.resumeLast = !playbackSettings.resumeLast"
                  >
                    <div>
                      <div class="setting-label">启动时恢复上次播放</div>
                      <div class="setting-desc">恢复上次的歌曲与进度</div>
                    </div>
                    <span class="switch" :class="{ on: playbackSettings.resumeLast }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="playbackSettings.rememberVolume = !playbackSettings.rememberVolume"
                  >
                    <div>
                      <div class="setting-label">记住音量</div>
                      <div class="setting-desc">关闭后每次启动回到默认音量</div>
                    </div>
                    <span class="switch" :class="{ on: playbackSettings.rememberVolume }"
                      ><i
                    /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="toggleFade">
                    <div>
                      <div class="setting-label">切歌淡入淡出</div>
                      <div class="setting-desc">切歌时旧歌渐弱、新歌渐强</div>
                    </div>
                    <span class="switch" :class="{ on: playbackSettings.fadeSec > 0 }"><i /></span>
                  </div>
                  <div v-if="playbackSettings.fadeSec > 0" class="fade-row">
                    <span class="setting-desc">时长</span>
                    <input
                      v-model.number="playbackSettings.fadeSec"
                      class="slider"
                      type="range"
                      min="0.5"
                      max="5"
                      step="0.5"
                    />
                    <span class="val-badge">{{ playbackSettings.fadeSec }}s</span>
                  </div>
                </div>
              </div>
            </section>

            <!-- ============ 音乐库 ============ -->
            <section v-else-if="tab === 'library'" class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <FolderOpen :size="13" />
                  音乐库
                </div>
                <div class="setting-item">
                  <div class="setting-label">歌曲库文件夹</div>
                  <div class="setting-desc">本地文件夹路径（扫描 mp3/flac/m4a/wav 等）</div>
                  <div class="setting-control">
                    <input
                      v-model="libInput"
                      class="lib-input"
                      placeholder="/Users/xxx/Music"
                      @keyup.enter="save"
                    />
                    <button class="btn primary" :disabled="saving" @click="save">
                      {{ saving ? "保存中…" : "保存" }}
                    </button>
                  </div>
                  <div v-if="error" class="setting-error">{{ error }}</div>
                </div>
              </div>
            </section>

            <!-- ============ 歌词 ============ -->
            <section v-else-if="tab === 'lyric'" class="settings-scroll">
              <!-- 外观排版 -->
              <div class="group">
                <div class="group-title">
                  <Type :size="13" />
                  外观排版
                </div>
                <div class="setting-item">
                  <div class="setting-label">歌词字体</div>
                  <div class="seg">
                    <button
                      v-for="f in fontOptions"
                      :key="f.value"
                      class="seg-btn"
                      :class="{ on: lyricSettings.fontFamily === f.value }"
                      :style="{ fontFamily: f.css }"
                      @click="lyricSettings.fontFamily = f.value"
                    >
                      {{ f.label }}
                    </button>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="setting-label">
                    字号
                    <span class="val-badge">{{ lyricSettings.fontSize }}px</span>
                  </div>
                  <div class="setting-desc">当前句基准大小，其他层级按比例缩放</div>
                  <input
                    v-model.number="lyricSettings.fontSize"
                    class="slider"
                    type="range"
                    min="14"
                    max="30"
                    step="1"
                  />
                </div>
                <div class="setting-item">
                  <div class="setting-label">对齐方式</div>
                  <div class="seg">
                    <button
                      v-for="a in alignOptions"
                      :key="a.value"
                      class="seg-btn"
                      :class="{ on: lyricSettings.align === a.value }"
                      @click="lyricSettings.align = a.value"
                    >
                      {{ a.label }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- 显示内容 -->
              <div class="group">
                <div class="group-title">
                  <Eye :size="13" />
                  显示内容
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="lyricSettings.showRoma = !lyricSettings.showRoma">
                    <div>
                      <div class="setting-label">显示罗马音</div>
                      <div class="setting-desc">原文下方的罗马音标注行</div>
                    </div>
                    <span class="switch" :class="{ on: lyricSettings.showRoma }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="lyricSettings.showZh = !lyricSettings.showZh">
                    <div>
                      <div class="setting-label">显示中文翻译</div>
                      <div class="setting-desc">连播与跟唱面板同时生效</div>
                    </div>
                    <span class="switch" :class="{ on: lyricSettings.showZh }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="lyricSettings.showSec = !lyricSettings.showSec">
                    <div>
                      <div class="setting-label">显示段落标题</div>
                      <div class="setting-desc">副歌 / 主歌等小节标题</div>
                    </div>
                    <span class="switch" :class="{ on: lyricSettings.showSec }"><i /></span>
                  </div>
                </div>
              </div>

              <!-- 效果行为 -->
              <div class="group">
                <div class="group-title">
                  <Sparkles :size="13" />
                  效果行为
                </div>
                <div class="setting-item">
                  <div class="setting-label">焦点句停靠位置</div>
                  <div class="seg">
                    <button
                      v-for="p in focusOptions"
                      :key="p.value"
                      class="seg-btn"
                      :class="{ on: lyricSettings.focusPos === p.value }"
                      @click="lyricSettings.focusPos = p.value"
                    >
                      {{ p.label }}
                    </button>
                  </div>
                </div>
                <div class="setting-item">
                  <div class="toggle-row" @click="lyricSettings.fadeMask = !lyricSettings.fadeMask">
                    <div>
                      <div class="setting-label">上下渐隐</div>
                      <div class="setting-desc">歌词列表顶部/底部淡出过渡</div>
                    </div>
                    <span class="switch" :class="{ on: lyricSettings.fadeMask }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="lyricSettings.autoScroll = !lyricSettings.autoScroll"
                  >
                    <div>
                      <div class="setting-label">自动跟随滚动</div>
                      <div class="setting-desc">切句时自动滚动到焦点句</div>
                    </div>
                    <span class="switch" :class="{ on: lyricSettings.autoScroll }"><i /></span>
                  </div>
                </div>
              </div>
            </section>

            <!-- ============ 界面 ============ -->
            <section v-else-if="tab === 'ui'" class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <LayoutGrid :size="13" />
                  界面偏好
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="uiSettings.showSongInfo = !uiSettings.showSongInfo"
                  >
                    <div>
                      <div class="setting-label">显示当前歌曲信息</div>
                      <div class="setting-desc">跟唱模式歌词面板顶部显示歌名 / 歌手</div>
                    </div>
                    <span class="switch" :class="{ on: uiSettings.showSongInfo }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="uiSettings.karaokeShowTime = !uiSettings.karaokeShowTime"
                  >
                    <div>
                      <div class="setting-label">跟唱显示每句时间戳</div>
                      <div class="setting-desc">跟唱模式每句歌词右侧显示起止时间</div>
                    </div>
                    <span class="switch" :class="{ on: uiSettings.karaokeShowTime }"><i /></span>
                  </div>
                </div>
                <div class="setting-item">
                  <div
                    class="toggle-row"
                    @click="uiSettings.karaokeShowNum = !uiSettings.karaokeShowNum"
                  >
                    <div>
                      <div class="setting-label">跟唱显示行号</div>
                      <div class="setting-desc">跟唱模式每句歌词左侧显示句子序号</div>
                    </div>
                    <span class="switch" :class="{ on: uiSettings.karaokeShowNum }"><i /></span>
                  </div>
                </div>
              </div>
            </section>

            <!-- ============ 快捷键 ============ -->
            <section v-else-if="tab === 'shortcuts'" class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <Keyboard :size="13" />
                  键盘快捷键
                </div>
                <div v-for="s in shortcuts" :key="s.desc" class="shortcut-item">
                  <span class="shortcut-desc">{{ s.desc }}</span>
                  <span class="shortcut-keys">
                    <kbd v-for="k in s.keys" :key="k">{{ k }}</kbd>
                  </span>
                </div>
              </div>
              <div class="group">
                <div class="group-title">
                  <MonitorPlay :size="13" />
                  系统媒体键
                </div>
                <div class="shortcut-item">
                  <span class="shortcut-desc">Mac 键盘媒体键 / 控制中心 / 锁屏</span>
                  <span class="shortcut-keys">
                    <kbd>播放/暂停</kbd>
                    <kbd>上一首</kbd>
                    <kbd>下一首</kbd>
                    <kbd>停止</kbd>
                  </span>
                </div>
                <div class="setting-desc hint">
                  媒体键同时驱动系统控制中心与锁屏的播放信息（歌名/歌手/封面/进度）。
                </div>
              </div>
            </section>

            <!-- ============ 关于 ============ -->
            <section v-else class="settings-scroll">
              <div class="group">
                <div class="group-title">
                  <Info :size="13" />
                  关于 QQ Player
                </div>
                <div class="about-item">
                  <span class="about-label">版本</span>
                  <span class="about-value">v{{ version }}</span>
                </div>
                <div class="about-item">
                  <span class="about-label">数据目录</span>
                  <span class="about-value mono">{{ dataDir }}</span>
                </div>
                <div class="about-item">
                  <span class="about-label">本地访问</span>
                  <a class="about-value mono link" :href="localUrl" target="_blank">{{
                    localUrl
                  }}</a>
                </div>
                <div class="about-item">
                  <span class="about-label">项目主页</span>
                  <a class="about-value mono link" :href="repoUrl" target="_blank"
                    >github.com/daxmate/qqplayer</a
                  >
                </div>
                <p class="about-desc">
                  QQ Player —— 本地音乐播放器 · AB 循环复读机 · 有声书同步阅读器。
                </p>
              </div>
            </section>
          </div>
        </div>

        <!-- 底部操作栏 -->
        <div class="modal-foot">
          <button class="reset-btn" title="重置所有设置为默认值" @click="resetAll">
            <RotateCcw :size="13" />
            恢复默认
          </button>
          <button class="btn primary" @click="close">完成</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import {
  Settings,
  X,
  FolderOpen,
  Music2,
  Type,
  Eye,
  Sparkles,
  LayoutGrid,
  ListMusic,
  Keyboard,
  Info,
  RotateCcw,
  MonitorPlay,
} from "@lucide/vue";
import {
  state,
  setLibrary,
  loadLibrary,
  lyricSettings,
  uiSettings,
  playbackSettings,
  LYRIC_SETTINGS_DEFAULTS,
  UI_SETTINGS_DEFAULTS,
  PLAYBACK_SETTINGS_DEFAULTS,
} from "../composables/usePlayer.js";
import pkg from "../../package.json";

const props = defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);

const version = pkg.version;
const dataDir = "~/Library/Application Support/qqplayer";
const localUrl = "http://localhost:17627";
const repoUrl = "https://github.com/daxmate/qqplayer";

const tab = ref("playback");
const libInput = ref("");
const saving = ref(false);
const error = ref("");

const categories = [
  { key: "playback", label: "播放", icon: ListMusic },
  { key: "library", label: "音乐库", icon: FolderOpen },
  { key: "lyric", label: "歌词", icon: Music2 },
  { key: "ui", label: "界面", icon: LayoutGrid },
  { key: "shortcuts", label: "快捷键", icon: Keyboard },
  { key: "about", label: "关于", icon: Info },
];

const playModeOptions = [
  { value: "order", label: "列表循环" },
  { value: "shuffle", label: "随机" },
  { value: "repeatOne", label: "单曲循环" },
];
const fontOptions = [
  { value: "system", label: "系统默认", css: "" },
  { value: "serif", label: "衬线", css: '"Songti SC", "SimSun", serif' },
  { value: "rounded", label: "圆体", css: '"Yuanti SC", "PingFang SC", sans-serif' },
];
const alignOptions = [
  { value: "left", label: "左对齐" },
  { value: "center", label: "居中" },
  { value: "right", label: "右对齐" },
];
const focusOptions = [
  { value: 0.33, label: "偏上 1/3" },
  { value: 0.5, label: "正中" },
];
const shortcuts = [
  { keys: ["Space"], desc: "播放 / 暂停" },
  { keys: ["←"], desc: "快退 10 秒" },
  { keys: ["→"], desc: "快进 10 秒" },
  { keys: ["↑"], desc: "音量 +10%" },
  { keys: ["↓"], desc: "音量 -10%" },
];

function toggleFade() {
  playbackSettings.fadeSec = playbackSettings.fadeSec > 0 ? 0 : 1.5;
}

// 恢复默认：重置全部设置为出厂值（watch 自动持久化）
function resetAll() {
  Object.assign(playbackSettings, PLAYBACK_SETTINGS_DEFAULTS);
  Object.assign(lyricSettings, LYRIC_SETTINGS_DEFAULTS);
  Object.assign(uiSettings, UI_SETTINGS_DEFAULTS);
}

// 每次打开时同步当前歌曲库路径
watch(
  () => props.open,
  (o) => {
    if (o) {
      tab.value = "playback";
      error.value = "";
      loadLibrary().then(() => {
        libInput.value = state.libraryPath;
      });
    }
  },
);

async function save() {
  const p = libInput.value.trim();
  if (!p) return;
  saving.value = true;
  error.value = "";
  try {
    await setLibrary(p);
    emit("close");
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

function close() {
  emit("close");
}

function onKey(e) {
  if (e.key === "Escape") close();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  width: min(780px, calc(100vw - 40px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow:
    0 24px 80px rgba(0, 0, 0, 0.6),
    0 4px 16px rgba(0, 0, 0, 0.35);
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
.modal-close:hover {
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
.nav-item:hover {
  background: var(--card2);
  color: var(--text);
}
.nav-item:hover svg {
  color: var(--text2);
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
  box-shadow: 0 0 8px rgba(255, 126, 95, 0.7);
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
.setting-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.setting-item:last-child {
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
.btn:hover {
  filter: brightness(1.1);
  color: var(--text);
}
.btn.primary {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.setting-error {
  font-size: 12px;
  color: #ff6b6b;
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
.seg-btn:hover {
  color: var(--text);
}
.seg-btn.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 2px 8px rgba(255, 126, 95, 0.35);
}
.val-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: rgba(255, 126, 95, 0.14);
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
.slider::-webkit-slider-thumb:hover {
  transform: scale(1.15);
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
.fade-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
}
.fade-row .slider {
  flex: 1;
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
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
.switch.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border-color: transparent;
}
.switch.on i {
  transform: translateX(22px);
}

/* 快捷键 */
.shortcut-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.shortcut-item:last-of-type {
  border-bottom: none;
}
.shortcut-desc {
  font-size: 13px;
  color: var(--text);
}
.shortcut-keys {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
kbd {
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  background: var(--bg2);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 6px;
  padding: 3px 8px;
  min-width: 22px;
  text-align: center;
}
.hint {
  margin-top: 10px;
  line-height: 1.6;
}

/* 关于 */
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
.link:hover {
  text-decoration: underline;
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
.reset-btn:hover {
  background: rgba(255, 107, 107, 0.12);
  border-color: rgba(255, 107, 107, 0.4);
  color: #ff6b6b;
}
</style>
