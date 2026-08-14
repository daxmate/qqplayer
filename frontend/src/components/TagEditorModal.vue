<template>
  <Teleport to="body">
    <!-- 弹窗：遮罩 + 面板（结构沿用 SettingsModal/LyricSpecModal，移动端全屏化由 mobile.css 统一处理） -->
    <div v-if="open" class="modal-mask" @click.self="close">
      <div class="modal tag-modal">
        <div class="modal-head">
          <Tags :size="16" />
          <span class="tag-title">{{ t("tags.editTitle") }}</span>
          <span class="head-sub">{{ songName }}</span>
          <button class="modal-close" :title="t('common.close')" @click="close">
            <X :size="16" />
          </button>
        </div>

        <div class="tag-body">
          <!-- 封面预览 + 表单 -->
          <div class="tag-main">
            <div class="cover-preview" data-testid="cover-preview">
              <img
                v-if="previewUrl"
                :src="previewUrl"
                :alt="t('tags.coverAlt')"
                @error="previewBroken = true"
              />
              <Music v-else :size="42" />
            </div>
            <div class="form-area">
              <label class="field">
                <span class="field-label">{{ t("tags.fieldTitle") }}</span>
                <input v-model="form.title" class="field-input" type="text" spellcheck="false" />
              </label>
              <label class="field">
                <span class="field-label">{{ t("tags.fieldArtist") }}</span>
                <input v-model="form.artist" class="field-input" type="text" spellcheck="false" />
              </label>
              <label class="field">
                <span class="field-label">{{ t("tags.fieldAlbum") }}</span>
                <input v-model="form.album" class="field-input" type="text" spellcheck="false" />
              </label>
            </div>
          </div>

          <!-- 自动刮削 -->
          <div class="scrape-row">
            <button
              class="scrape-btn"
              :disabled="scraping || !song"
              data-testid="scrape-btn"
              @click="scrape"
            >
              <Loader2 v-if="scraping" :size="14" class="spin" />
              <Sparkles v-else :size="14" />
              {{ scraping ? t("tags.scraping") : t("tags.scrapeBtn") }}
            </button>
            <span v-if="scrapeError" class="scrape-error">{{ scrapeError }}</span>
            <span v-else-if="scrapeQuery" class="scrape-query">{{
              t("tags.scrapeQuery", { query: scrapeQuery })
            }}</span>
            <span v-else class="scrape-hint">{{ t("tags.scrapeHint") }}</span>
          </div>

          <!-- 候选区：网易云 / MusicBrainz 两组 -->
          <div class="candidates">
            <div class="cand-group">
              <div class="cand-group-title">{{ t("tags.groupNetease") }}</div>
              <div v-if="scraping" class="cand-loading">
                <Loader2 :size="13" class="spin" />
                {{ t("tags.scraping") }}
              </div>
              <template v-else>
                <button
                  v-for="(item, i) in netease"
                  :key="'ne' + i"
                  class="cand-item"
                  data-testid="cand-netease"
                  @click="pick(item)"
                >
                  <span class="cand-cover">
                    <img v-if="item.cover" :src="item.cover" alt="" loading="lazy" />
                    <Music v-else :size="14" />
                  </span>
                  <span class="cand-info">
                    <span class="cand-name">{{ item.title }}</span>
                    <span class="cand-sub">
                      {{ item.artist }}<template v-if="item.album"> · {{ item.album }}</template
                      ><template v-if="item.duration"> · {{ item.duration }}</template>
                    </span>
                  </span>
                </button>
                <div
                  v-if="scraped && !netease.length"
                  class="cand-empty"
                  data-testid="cand-empty-netease"
                >
                  {{ t("tags.emptyResult") }}
                </div>
              </template>
            </div>

            <div class="cand-group">
              <div class="cand-group-title">{{ t("tags.groupMusicBrainz") }}</div>
              <div v-if="scraping" class="cand-loading">
                <Loader2 :size="13" class="spin" />
                {{ t("tags.scraping") }}
              </div>
              <template v-else>
                <button
                  v-for="(item, i) in musicbrainz"
                  :key="'mb' + i"
                  class="cand-item"
                  data-testid="cand-musicbrainz"
                  @click="pick(item)"
                >
                  <span class="cand-cover">
                    <img v-if="item.cover" :src="item.cover" alt="" loading="lazy" />
                    <Music v-else :size="14" />
                  </span>
                  <span class="cand-info">
                    <span class="cand-name">{{ item.title }}</span>
                    <span class="cand-sub">
                      {{ item.artist }}<template v-if="item.album"> · {{ item.album }}</template>
                    </span>
                  </span>
                </button>
                <div
                  v-if="scraped && !musicbrainz.length"
                  class="cand-empty"
                  data-testid="cand-empty-musicbrainz"
                >
                  {{ t("tags.emptyResult") }}
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- 底部操作栏 -->
        <div class="modal-foot">
          <button class="btn" data-testid="cancel-btn" @click="close">
            {{ t("common.cancel") }}
          </button>
          <button
            class="btn primary"
            :disabled="saving || !song"
            data-testid="save-btn"
            @click="save"
          >
            <Loader2 v-if="saving" :size="14" class="spin" />
            {{ t("common.save") }}
          </button>
        </div>
      </div>
    </div>

    <!-- toast 独立于弹窗（Teleport body）：保存成功后弹窗先关，toast 仍可见 -->
    <Transition name="tag-toast">
      <div v-if="toast" class="tag-toast" :class="{ err: toastErr }" data-testid="tag-toast">
        {{ toast }}
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, reactive, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Music, Sparkles, Tags, X } from "@lucide/vue";
import { state, loadSongs } from "../composables/usePlayer.js";

const props = defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);

const { t } = useI18n();

// 表单（title/artist/album 允许空串，全空时前端拦截）
const form = reactive({ title: "", artist: "", album: "" });
// cover_url：候选封面（null = 不写封面，沿用文件现有封面）
const remoteCover = ref(null);
const previewBroken = ref(false); // 预览图加载失败 → 占位
const scraping = ref(false);
const scraped = ref(false); // 是否完成过至少一次刮削（控制空态文案）
const scrapeQuery = ref("");
const scrapeError = ref("");
const netease = ref([]);
const musicbrainz = ref([]);
const saving = ref(false);
const toast = ref("");
const toastErr = ref(false);

let toastTimer = null;

const song = computed(() => state.currentSong);
const songName = computed(() =>
  song.value ? song.value.name + (song.value.artist ? " · " + song.value.artist : "") : "",
);

// 封面预览：点选候选后优先显示远端封面；未选封面（cover_url=null）则显示本地 /api/cover
// （跟随 currentSong.path，改名后自动指向新路径的封面）
const previewUrl = computed(() => {
  if (previewBroken.value) return "";
  if (remoteCover.value) return remoteCover.value;
  return song.value ? "/api/cover?path=" + encodeURIComponent(song.value.path) : "";
});

// 每次打开：从当前歌曲同步表单 + 清空上次刮削结果
// （immediate：直接以 open=true 挂载（测试/特殊场景）也能同步）
function syncForm() {
  const s = state.currentSong;
  form.title = s?.name || "";
  form.artist = s?.artist || "";
  form.album = s?.album || "";
  remoteCover.value = null;
  previewBroken.value = false;
  scraping.value = false;
  scraped.value = false;
  scrapeQuery.value = "";
  scrapeError.value = "";
  netease.value = [];
  musicbrainz.value = [];
}

watch(
  () => props.open,
  (o) => {
    if (o) syncForm();
  },
  { immediate: true },
);

// 弹窗打开期间切歌（自动连播/手动切歌）：编辑对象变了 → 重新同步，避免误改上一首
watch(
  () => state.currentSong?.path,
  () => {
    if (props.open) syncForm();
  },
);

// 自动刮削：POST /api/tags/scrape（契约见 TASK.md；后端未合并前测试用 mock fetch）
async function scrape() {
  if (!song.value || scraping.value) return;
  scraping.value = true;
  scrapeError.value = "";
  scraped.value = false;
  netease.value = [];
  musicbrainz.value = [];
  try {
    const res = await fetch("/api/tags/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: song.value.path }),
    });
    if (!res.ok) throw new Error(t("tags.scrapeFailed"));
    const data = await res.json();
    scrapeQuery.value = data.query || "";
    netease.value = Array.isArray(data.netease) ? data.netease : [];
    musicbrainz.value = Array.isArray(data.musicbrainz) ? data.musicbrainz : [];
    scraped.value = true;
  } catch (e) {
    scrapeError.value = e.message || t("tags.scrapeFailed");
  } finally {
    scraping.value = false;
  }
}

// 点选候选：填充表单 + 记录封面（条目 cover 为 null 则不换封面）
function pick(item) {
  if (!item) return;
  form.title = item.title || "";
  form.artist = item.artist || "";
  form.album = item.album || "";
  remoteCover.value = item.cover || null;
  previewBroken.value = false;
}

// 保存：POST /api/tags；成功 → toast + loadSongs 刷新 + 改名时更新 currentSong.path（不中断播放）
async function save() {
  if (!song.value || saving.value) return;
  const title = form.title.trim();
  const artist = form.artist.trim();
  const album = form.album.trim();
  if (!title && !artist && !album) {
    showToast(t("tags.saveFailed", { msg: t("tags.emptyAll") }), true);
    return;
  }
  saving.value = true;
  const path = song.value.path;
  try {
    const res = await fetch("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, title, artist, album, cover_url: remoteCover.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || data.detail || t("tags.saveFailed", { msg: "" }));
    }
    const data = await res.json();
    // 当前播放的这首歌被改名：更新 path/name/artist/album，audio.src 不动 → 播放不中断
    const cur = state.currentSong;
    if (cur && data.newPath && data.newPath !== path) {
      cur.path = data.newPath;
      if (typeof data.name === "string") cur.name = data.name;
      if (typeof data.artist === "string") cur.artist = data.artist;
      if (typeof data.album === "string") cur.album = data.album;
    }
    await loadSongs(); // 刷新列表（loadSongs 按 path 保持当前选中/播放）
    showToast(t("tags.saveSuccess"), false);
    emit("close");
  } catch (e) {
    showToast(e.message || t("tags.saveFailed", { msg: "" }), true); // 错误：toast 提示，弹窗不关
  } finally {
    saving.value = false;
  }
}

function showToast(msg, isErr) {
  toast.value = msg;
  toastErr.value = isErr;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = "";
  }, 3200);
}

function close() {
  emit("close");
}

function onKey(e) {
  if (e.key === "Escape") close();
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  clearTimeout(toastTimer);
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
.modal {
  width: min(640px, calc(100vw - 40px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow:
    0 24px 80px var(--shadow-strong),
    0 4px 16px var(--shadow-sm);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: min(680px, calc(100vh - 60px));
}
.modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  font-size: 15px;
  font-weight: 700;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.modal-head svg {
  color: var(--accent);
}
.tag-title {
  white-space: nowrap;
  flex-shrink: 0;
}
.head-sub {
  font-size: 12px;
  font-weight: 500;
  color: var(--text2);
  margin-left: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
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
  flex-shrink: 0;
}
@media (hover: hover) {
  .modal-close:hover {
    background: var(--card2);
    color: var(--text);
  }
}

/* ============ 主体 ============ */
.tag-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  overflow-y: auto;
}
/* 封面 + 表单并排（<1024px 由 mobile.css 全屏化 + 本组件断点改上下堆叠） */
.tag-main {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.cover-preview {
  width: 132px;
  height: 132px;
  border-radius: 14px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--card);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
}
.cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.form-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text3);
  letter-spacing: 0.5px;
}
.field-input {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 8px 12px;
  color: var(--text);
  font-size: 13.5px;
  outline: none;
  transition: border-color 0.15s;
}
.field-input:focus {
  border-color: var(--accent);
}

/* ============ 刮削按钮行 ============ */
.scrape-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.scrape-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s;
  flex-shrink: 0;
  white-space: nowrap;
}
.scrape-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.scrape-hint,
.scrape-query {
  font-size: 12px;
  color: var(--text3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scrape-query {
  color: var(--text2);
}
.scrape-error {
  font-size: 12px;
  color: #ff6b6b;
}

/* ============ 候选区（限高滚动） ============ */
.candidates {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cand-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}
.cand-group-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent2);
  letter-spacing: 1.2px;
}
.cand-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--card);
  border: 1px solid var(--border);
  text-align: left;
  transition: all 0.15s;
}
@media (hover: hover) {
  .cand-item:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
}
.cand-cover {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--card2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
}
.cand-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cand-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.cand-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cand-sub {
  font-size: 11px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cand-empty {
  padding: 14px 8px;
  font-size: 12px;
  color: var(--text3);
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: 10px;
}
.cand-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 8px;
  font-size: 12px;
  color: var(--text3);
}
.spin {
  animation: tag-spin 0.9s linear infinite;
}
@keyframes tag-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ============ 底部操作栏 ============ */
.modal-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg2);
  flex-shrink: 0;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 18px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s;
  white-space: nowrap;
  color: var(--text2);
  background: var(--card2);
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

/* ============ toast（独立 Teleport，弹窗关闭后仍可见） ============ */
.tag-toast {
  position: fixed;
  left: 50%;
  bottom: 84px;
  transform: translateX(-50%);
  z-index: 300;
  background: rgba(38, 41, 55, 0.95);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 10px 18px;
  border-radius: 12px;
  font-size: 12.5px;
  box-shadow: 0 10px 32px var(--shadow-strong);
  white-space: nowrap;
  max-width: calc(100vw - 32px);
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag-toast.err {
  border-color: rgba(255, 107, 107, 0.5);
  color: #ffb3b3;
}
.tag-toast-enter-active,
.tag-toast-leave-active {
  transition:
    opacity 0.25s,
    transform 0.25s;
}
.tag-toast-enter-from,
.tag-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

/* ============ 移动端适配（<1024px）：表单堆叠 + 候选列表限高滚动 ============
   弹窗全宽/全屏由 mobile.css 统一处理（.modal-mask/.modal 规则），这里只调内容布局 */
@media (max-width: 1023.98px) {
  .tag-main {
    flex-direction: column;
    align-items: center;
  }
  .cover-preview {
    width: min(52vw, 180px);
    height: min(52vw, 180px);
  }
  .form-area {
    width: 100%;
  }
  .scrape-row {
    flex-wrap: wrap;
  }
  .cand-item {
    padding: 10px;
  }
  .cand-cover {
    width: 40px;
    height: 40px;
  }
}
</style>
