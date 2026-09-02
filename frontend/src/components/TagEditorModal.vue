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
                v-if="previewUrl && !previewFailed"
                :src="previewUrl"
                :alt="t('tags.coverAlt')"
                @error="onPreviewError"
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
              <!-- 扩展字段：year/genre/track/album_artist（两列 grid，保持弹窗宽度合理） -->
              <div class="form-grid">
                <label class="field">
                  <span class="field-label">{{ t("tags.fieldYear") }}</span>
                  <input
                    v-model.number="form.year"
                    class="field-input"
                    type="number"
                    data-testid="field-year"
                    placeholder="1995"
                  />
                </label>
                <label class="field">
                  <span class="field-label">{{ t("tags.fieldGenre") }}</span>
                  <input
                    v-model="form.genre"
                    class="field-input"
                    type="text"
                    data-testid="field-genre"
                    spellcheck="false"
                  />
                </label>
                <label class="field">
                  <span class="field-label">{{ t("tags.fieldTrack") }}</span>
                  <input
                    v-model.number="form.track"
                    class="field-input"
                    type="number"
                    data-testid="field-track"
                    placeholder="3"
                  />
                </label>
                <label class="field">
                  <span class="field-label">{{ t("tags.fieldAlbumArtist") }}</span>
                  <input
                    v-model="form.albumArtist"
                    class="field-input"
                    type="text"
                    data-testid="field-albumartist"
                    spellcheck="false"
                  />
                </label>
              </div>
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
                  @click="pick(item, 'netease')"
                >
                  <span class="cand-cover">
                    <img v-if="item.cover" :src="item.cover" alt="" loading="lazy" />
                    <Music v-else :size="14" />
                  </span>
                  <span class="cand-info">
                    <span class="cand-name">{{ item.title }}</span>
                    <span class="cand-sub">
                      {{ item.artist }}<template v-if="item.album"> · {{ item.album }}</template
                      ><template v-if="item.year"> · {{ item.year }}</template
                      ><template v-if="item.genre"> · {{ item.genre }}</template
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
                  @click="pick(item, 'musicbrainz')"
                >
                  <span class="cand-cover">
                    <img v-if="item.cover" :src="item.cover" alt="" loading="lazy" />
                    <Music v-else :size="14" />
                  </span>
                  <span class="cand-info">
                    <span class="cand-name">{{ item.title }}</span>
                    <span class="cand-sub">
                      {{ item.artist }}<template v-if="item.album"> · {{ item.album }}</template
                      ><template v-if="item.year"> · {{ item.year }}</template
                      ><template v-if="item.genre"> · {{ item.genre }}</template>
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
  </Teleport>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, onMounted, onBeforeUnmount, type PropType } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Music, Sparkles, Tags, X } from "@lucide/vue";
import { state, loadSongs, type Song } from "../composables/usePlayer.js";
import { apiPost } from "../utils/apiClient.js";
import { useCoverURL } from "../composables/useCoverURL.js";
import { loadEnabledFields, getEnabledFields } from "../composables/tagEditorSettings.js";
import { showToast, toastError } from "../composables/useToast.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  // 指定编辑目标歌曲；null = 编辑当前播放歌曲（控制栏入口）。
  // 右键菜单入口传被右键的歌曲（不切换播放），保存/刮削都以它为准。
  song: { type: Object as PropType<Song | null>, default: null },
  // 打开弹窗时自动触发一次刮削（右键菜单入口用）
  autoScrape: { type: Boolean, default: false },
});
const emit = defineEmits(["close"]);

const { t } = useI18n();

// 表单（title/artist/album 允许空串，全空时前端拦截；year/track 数字输入允许空）
const form = reactive({
  title: "",
  artist: "",
  album: "",
  year: "",
  genre: "",
  track: "",
  albumArtist: "",
});
// cover_url：候选封面（null = 不写封面，沿用文件现有封面）
const remoteCover = ref<string | null>(null);
const previewBroken = ref(false); // 预览图加载失败 → 占位
const scraping = ref(false);
const scraped = ref(false); // 是否完成过至少一次刮削（控制空态文案）
const scrapeQuery = ref("");
const scrapeError = ref("");
const netease = ref<ScrapeCandidate[]>([]);
const musicbrainz = ref<ScrapeCandidate[]>([]);
const saving = ref(false);

/** 刮削候选条目（/api/tags/scrape → netease[] / musicbrainz[]；宽松视图，字段缺省回落空） */
interface ScrapeCandidate {
  id?: string | number;
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  duration?: string;
  track?: string;
  album_artist?: string;
  cover?: string | null;
}

const song = computed(() => props.song || state.currentSong);
const songName = computed(() =>
  song.value ? song.value.name + (song.value.artist ? " · " + song.value.artist : "") : "",
);

// 封面预览（契约 2026-08-27）：useCoverURL 唯一入口——点选候选后优先显示远端封面；
// 未选封面（cover_url=null）时本地歌封面走 useCoverURL（本地 covers 缓存 → 内嵌 APIC（断网）
// → 远程 /api/cover，对齐列表/播放页兑底顺序；跟随 song.path，改名后自动指向新路径封面）。
// 弹窗一次性场景不传 download（只查不后台缓存）。
const { coverSrc, coverOk, markCoverError, resolveCover, dispose } = useCoverURL();

const previewUrl = computed(() => {
  if (previewBroken.value) return "";
  if (remoteCover.value) return remoteCover.value;
  return song.value?.path ? coverSrc(song.value.path) : "";
});
const previewFailed = computed(() => {
  if (previewBroken.value) return true;
  if (remoteCover.value) return false;
  return song.value?.path ? !coverOk(song.value.path) : false;
});

watch(
  () => song.value?.path || "",
  (p) => {
    if (p) resolveCover(p);
  },
  { immediate: true },
);

function onPreviewError() {
  if (remoteCover.value) {
    previewBroken.value = true;
    return;
  }
  if (song.value?.path) markCoverError(song.value.path);
}

// 每次打开：从目标歌曲同步表单 + 清空上次刮削结果 + 拉一次字段选择设置（模块级缓存）
// （immediate：直接以 open=true 挂载（测试/特殊场景）也能同步）
function syncForm() {
  const s = song.value;
  form.title = s?.name || "";
  form.artist = s?.artist || "";
  form.album = s?.album || "";
  form.year = String(s?.year ?? "");
  form.genre = String(s?.genre ?? "");
  form.track = String(s?.track ?? "");
  form.albumArtist = String(s?.album_artist ?? "");
  remoteCover.value = null;
  previewBroken.value = false;
  scraping.value = false;
  scraped.value = false;
  scrapeQuery.value = "";
  scrapeError.value = "";
  netease.value = [];
  musicbrainz.value = [];
}

// 打开时：同步表单 → 拉 enabled_fields（fire-and-forget，不阻塞）→ autoScrape 自动刮削一次
function onOpen() {
  syncForm();
  loadEnabledFields();
  if (props.autoScrape && !scraping.value && !scraped.value) scrape();
}

watch(
  () => props.open,
  (o) => {
    if (o) onOpen();
  },
  { immediate: true },
);

// 弹窗打开期间目标歌曲变化（自动连播/手动切歌/右键另一首）：编辑对象变了 → 重新同步，避免误改上一首
watch(
  () => song.value?.path,
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
    // 刮削是多源同步请求（网易云 + MusicBrainz 降级链 + 封面 fallback，实测 15s+），
    // 默认 10s 超时会误报“刮削失败”——显式给 120s
    const res = await apiPost("/api/tags/scrape", { path: song.value.path }, { timeout: 120000 });
    if (!res.ok) throw new Error(t("tags.scrapeFailed"));
    const data = res.data || {};
    scrapeQuery.value = data.query || "";
    netease.value = Array.isArray(data.netease) ? data.netease : [];
    musicbrainz.value = Array.isArray(data.musicbrainz) ? data.musicbrainz : [];
    scraped.value = true;
  } catch (e) {
    scrapeError.value = e instanceof Error ? e.message : t("tags.scrapeFailed");
  } finally {
    scraping.value = false;
  }
}

// 点选候选：填充表单 + 记录封面（条目 cover 为 null 则不换封面）
// 新字段 item 有值才填，null/undefined 置空（网易云候选缺省 → 自动清空）
// 网易云候选：cloudsearch 不返回发行时间 → 表单 year 为空时有 id 则惰性调 album-year 补年份
// （异步 + 静默失败：不 toast、不阻塞点选、无 loading 态）
function pick(item: ScrapeCandidate, source: string) {
  if (!item) return;
  form.title = item.title || "";
  form.artist = item.artist || "";
  form.album = item.album || "";
  form.year = item.year ?? "";
  form.genre = item.genre ?? "";
  form.track = item.track ?? "";
  form.albumArtist = item.album_artist ?? "";
  remoteCover.value = item.cover || null;
  previewBroken.value = false;
  if (source === "netease" && item.id && !form.year) {
    fetchAlbumYear(item.id);
  }
}

// 惰性补年份：POST /api/tags/album-year → {year: int|null}
// 成功且 year 非空 → 填表单（String）；失败/无数据 → 静默忽略（catch 不报错）
async function fetchAlbumYear(songId: string | number) {
  try {
    const res = await apiPost("/api/tags/album-year", { song_id: songId }, { timeout: 30000 });
    if (!res.ok) return;
    const year = res.data && res.data.year;
    if (year) form.year = String(year);
  } catch {
    /* 静默失败：不 toast、不阻塞点选 */
  }
}

// 数字字段转换：空 → null（后端 null = 不写）
function toIntOrNull(v: string | number | null | undefined) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// 保存：POST /api/tags；成功 → toast + loadSongs 刷新 + 改名时更新目标歌曲（不中断播放）
// enabled_fields（设置 scraping.enabled_fields，模块级缓存）存在且非空时：只提交勾选字段，其余置 null 不写；
// 设置未就绪/接口失败 → 提交全部字段（容错）。
async function save() {
  if (!song.value || saving.value) return;
  const title = form.title.trim();
  const artist = form.artist.trim();
  const album = form.album.trim();
  if (!title && !artist && !album) {
    toastError(t("tags.saveFailed", { msg: t("tags.emptyAll") }));
    return;
  }
  saving.value = true;
  const path = song.value.path;
  const body: Record<string, unknown> = {
    path,
    title,
    artist,
    album,
    cover_url: remoteCover.value,
    year: toIntOrNull(form.year),
    genre: form.genre.trim() || null,
    track: toIntOrNull(form.track),
    album_artist: form.albumArtist.trim() || null,
  };
  const enabled = getEnabledFields();
  if (Array.isArray(enabled) && enabled.length) {
    // 只提交勾选字段：未勾选置 null（后端 null = 不写，保留原值）
    for (const key of Object.keys(body)) {
      if (key !== "path" && !enabled.includes(key)) body[key] = null;
    }
  }
  try {
    const res = await apiPost("/api/tags", body);
    if (!res.ok) {
      const data = res.data || {};
      throw new Error(data.error || data.detail || t("tags.saveFailed", { msg: "" }));
    }
    const data = res.data || {};
    // 当前播放的这首歌被改名：更新 path/name/artist/album 及新字段，audio.src 不动 → 播放不中断
    // （仅当编辑目标就是当前播放歌曲时更新 currentSong；右键编辑别的歌不影响播放）
    const cur = state.currentSong;
    if (cur && cur === song.value && data.newPath && data.newPath !== path) {
      cur.path = data.newPath;
      if (typeof data.name === "string") cur.name = data.name;
      if (typeof data.artist === "string") cur.artist = data.artist;
      if (typeof data.album === "string") cur.album = data.album;
      if (data.year !== undefined) cur.year = data.year;
      if (data.genre !== undefined) cur.genre = data.genre;
      if (data.track !== undefined) cur.track = data.track;
      if (data.album_artist !== undefined) cur.album_artist = data.album_artist;
    }
    await loadSongs({ force: true }); // 刷新列表（loadSongs 按 path 保持当前选中/播放）
    showToast(t("tags.saveSuccess"));
    emit("close");
  } catch (e) {
    toastError(e instanceof Error ? e.message : t("tags.saveFailed", { msg: "" })); // 错误：toast 提示，弹窗不关
  } finally {
    saving.value = false;
  }
}

function close() {
  emit("close");
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  dispose(); // 契约：组件卸载取消恢复在线订阅
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
/* 扩展字段两列 grid（year/genre/track/album_artist），弹窗宽度 640px 内每列约 220px */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
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

/* ============ 候选区（限高滚动） ============
   候选可能很多（网易云 20 + MusicBrainz 5），整块限高 + 内部滚动，
   保证最后一条候选始终可通过滚动看到，不会超出弹窗底部被裁切。
   高度：桌面弹窗 max 680px 时正文可视约 534px，去掉封面/表单/刮削行后候选区约 340px；
   矮视口（<740px）跟随弹窗收缩（弹窗 max-height = 100dvh - 60px），
   因此取 min(340px, 100dvh - 400px) 恰好不触发外层 .tag-body 滚动。
   移动端（<1024px 弹窗全屏 100dvh）同样限高可滚动，外层 .tag-body 兜底。

   ⚠️ flex 压缩陷阱（网易云/MusicBrainz 两组重叠根因）：
   .candidates 是 flex column，.cand-group 默认 flex-shrink: 1 + min-height: 0，
   候选多时两组会被压扁，而子项（.cand-item 固定高度）溢出组盒（overflow 默认 visible），
   直接画到下一组/底栏上 → 两组视觉重叠。必须 flex-shrink: 0（且不要 min-height: 0），
   让组保持完整高度，由 .candidates 的 overflow-y: auto 负责滚动。
   .candidates 自身也 flex-shrink: 0：候选少时容器按内容自适应（两组都能完整露出），
   候选多时顶到 max-height 内滚；超出弹窗正文时由外层 .tag-body 滚动兜底。 */
.candidates {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  flex-shrink: 0; /* 防被 .tag-body 压缩（压缩会把下一组挤出可视区） */
  max-height: min(340px, calc(100dvh - 400px));
  overflow-y: auto;
}
.cand-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0; /* 防 flex 压缩：压缩后子项溢出会叠到下一组（重叠根因） */
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
  .form-grid {
    grid-template-columns: 1fr 1fr;
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
