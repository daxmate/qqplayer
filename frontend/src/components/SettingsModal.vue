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
        <div class="modal-body">
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
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { Settings, X, FolderOpen } from "@lucide/vue";
import { state, setLibrary, loadLibrary } from "../composables/usePlayer.js";

const props = defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);

const libInput = ref("");
const saving = ref(false);
const error = ref("");

// 每次打开时同步当前歌曲库路径
watch(
  () => props.open,
  async (o) => {
    if (o) {
      error.value = "";
      await loadLibrary();
      libInput.value = state.libraryPath;
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
  width: min(440px, calc(100vw - 40px));
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
.modal-body {
  padding: 18px;
}
.setting-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
</style>
