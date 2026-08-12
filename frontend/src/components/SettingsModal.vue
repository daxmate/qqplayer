<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="close">
      <div class="modal">
        <div class="modal-head">
          <Settings :size="16" />
          设置
          <button class="modal-close" title="关闭" @click="close">
            <X :size="16" />
          </button>
        </div>

        <!-- tab 切换 -->
        <div class="modal-tabs">
          <button class="tab" :class="{ on: tab === 'library' }" @click="tab = 'library'">
            <FolderOpen :size="13" />
            歌曲库
          </button>
          <button class="tab" :class="{ on: tab === 'lyric' }" @click="tab = 'lyric'">
            <Music2 :size="13" />
            歌词
          </button>
        </div>

        <div class="modal-body">
          <!-- 歌曲库 tab -->
          <template v-if="tab === 'library'">
            <div class="setting-item">
              <div class="setting-label">
                <FolderOpen :size="14" />
                歌曲库
              </div>
              <div class="setting-desc">本地文件夹路径（扫描 mp3/flac/m4a/wav 等）</div>
              <div class="setting-control">
                <input
                  v-model="libInput"
                  class="lib-input"
                  placeholder="/Users/xxx/Music"
                  @keyup.enter="save"
                />
                <button class="btn" :disabled="saving" @click="save">
                  {{ saving ? "保存中…" : "保存" }}
                </button>
              </div>
              <div v-if="error" class="setting-error">{{ error }}</div>
            </div>
          </template>

          <!-- 歌词 tab -->
          <template v-else>
            <div class="lyric-settings">
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
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { Settings, X, FolderOpen, Music2, Type, Eye, Sparkles } from "@lucide/vue";
import { state, setLibrary, loadLibrary, lyricSettings } from "../composables/usePlayer.js";

const props = defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);

const tab = ref("library");
const libInput = ref("");
const saving = ref(false);
const error = ref("");

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

// 每次打开时同步当前歌曲库路径
watch(
  () => props.open,
  (o) => {
    if (o) {
      tab.value = "library";
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
  width: min(460px, calc(100vw - 40px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  overflow: hidden;
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
/* tab 切换 */
.modal-tabs {
  display: flex;
  gap: 6px;
  padding: 12px 18px 0;
}
.modal-tabs .tab {
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg2);
}
.modal-tabs .tab.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.modal-body {
  padding: 18px;
  max-height: min(560px, calc(100vh - 180px));
  overflow-y: auto;
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
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  transition: all 0.15s;
  white-space: nowrap;
}
.btn:hover {
  filter: brightness(1.1);
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.setting-error {
  font-size: 12px;
  color: #ff6b6b;
}

/* ============ 歌词设置 ============ */
.lyric-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
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
}
.val-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: rgba(255, 126, 95, 0.14);
  padding: 2px 8px;
  border-radius: 8px;
  margin-left: 4px;
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
  width: 42px;
  height: 24px;
  border-radius: 12px;
  background: var(--card2);
  position: relative;
  transition: background 0.2s;
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
}
.switch.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
}
.switch.on i {
  transform: translateX(18px);
}
</style>
