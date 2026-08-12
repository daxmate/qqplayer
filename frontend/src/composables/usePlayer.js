import { reactive, computed, watch } from "vue";

// 全局唯一 audio 元素
const audio = new Audio();
audio.preload = "auto";

export const state = reactive({
  songs: [],
  currentIndex: -1,
  currentSong: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  mode: "continuous", // 'continuous' 连播 | 'karaoke' 跟唱
  playMode: "order", // 连播播放模式：'order' 列表循环 | 'shuffle' 随机 | 'repeatOne' 单曲循环
  karaokeOn: true, // 跟唱开关：开=每句播完自动停
  karaokeLoop: false, // 单句循环：跟唱开启时生效，句末自动回到句首重播
  abLoop: null, // AB 区间循环：null 关闭 | { a, b } 起点/终点（行索引，b 为 null 表示等选终点）
  speed: 1.0,
  zhVisible: true,
  lyric: [], // [{type:'sec',name} | {type:'line',s,e,text:[jp,roma,zh]}]
  lyricFormat: null, // 'srt' | 'lrc' | null
  libraryPath: "",
  loading: false,
  error: "",
  volume: 1.0, // 音量 0~1
  muted: false,
  favorites: [], // 收藏歌曲 path 列表（后端持久化）
});

// ============ 歌词显示设置（localStorage 持久化）============
export const LYRIC_SETTINGS_KEY = "qqplayer.lyricSettings.v1";

export const lyricSettings = reactive({
  fontFamily: "system", // 'system' 系统默认 | 'serif' 衬线 | 'rounded' 圆体
  fontSize: 20, // 当前句基准字号（px），其他层级按比例缩放
  align: "left", // 'left' | 'center' | 'right'
  showRoma: true, // 显示罗马音
  showZh: true, // 显示中文翻译
  showSec: true, // 显示段落标题
  focusPos: 0.33, // 焦点句停靠位置（可视区高度比例）：0.33 | 0.5
  fadeMask: true, // 上下渐隐遮罩
  autoScroll: true, // 切句自动跟随滚动
});

function loadLyricSettings() {
  try {
    const raw = localStorage.getItem(LYRIC_SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k of Object.keys(lyricSettings)) {
      if (k in saved) lyricSettings[k] = saved[k];
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadLyricSettings();

watch(
  lyricSettings,
  () => {
    try {
      localStorage.setItem(LYRIC_SETTINGS_KEY, JSON.stringify(lyricSettings));
    } catch {
      /* 忽略写入失败 */
    }
  },
  { deep: true },
);

// ============ 音量（localStorage 持久化）============
export const VOLUME_KEY = "qqplayer.volume.v1";

function loadVolume() {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY));
    if (!isNaN(v) && v >= 0 && v <= 1) {
      state.volume = v;
      audio.volume = v;
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadVolume();

function persistVolume() {
  try {
    localStorage.setItem(VOLUME_KEY, String(state.volume));
  } catch {
    /* 忽略写入失败 */
  }
}

export function setVolume(v) {
  state.volume = Math.min(1, Math.max(0, v));
  state.muted = false; // 手动调音量自动取消静音
  audio.volume = state.volume;
  persistVolume();
}

export function toggleMute() {
  state.muted = !state.muted;
  audio.volume = state.muted ? 0 : state.volume;
}

// ============ 收藏（后端持久化 ~/Library/Application Support/qqplayer）============
export async function loadFavorites() {
  try {
    const res = await fetch("/api/favorites", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      state.favorites = data.paths || [];
    }
  } catch {
    /* 忽略 */
  }
}

export function isFavorite(path) {
  return state.favorites.includes(path);
}

export async function toggleFavorite(path) {
  // 乐观更新：先改 UI，失败回滚
  const wasFav = state.favorites.includes(path);
  if (wasFav) {
    state.favorites.splice(state.favorites.indexOf(path), 1);
  } else {
    state.favorites.push(path);
  }
  try {
    await fetch("/api/favorites/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  } catch {
    // 回滚
    if (wasFav) {
      state.favorites.push(path);
    } else {
      state.favorites.splice(state.favorites.indexOf(path), 1);
    }
  }
}

// ============ 队列操作 ============
export function removeFromQueue(index) {
  if (index < 0 || index >= state.songs.length) return;
  state.songs.splice(index, 1);
  if (index < state.currentIndex) {
    state.currentIndex -= 1;
  } else if (index === state.currentIndex) {
    if (state.songs.length) {
      // 移除当前歌：切到原位置的新歌（索引已自然顺延）
      const next = Math.min(index, state.songs.length - 1);
      selectSong(next);
    } else {
      state.currentIndex = -1;
      state.currentSong = null;
      state.isPlaying = false;
      state.lyric = [];
      state.lyricFormat = null;
      audio.pause();
      audio.removeAttribute("src");
    }
  }
  // 歌曲列表变了：洗牌队列失效，下次自动重建
  _resetPlayMode();
}

// ============ 键盘快捷键 ============
// 空格播放/暂停，←/→ 快退/快进 10s，↑/↓ 音量 ±10%
// 输入框/文本域聚焦时不拦截
const SHORTCUT_HANDLER = (e) => {
  const el = e.target;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
    return;
  }
  switch (e.code) {
    case "Space":
      e.preventDefault();
      togglePlay();
      break;
    case "ArrowLeft":
      e.preventDefault();
      seek(Math.max(0, (audio.currentTime || 0) - 10));
      break;
    case "ArrowRight":
      e.preventDefault();
      seek(Math.min(audio.duration || 0, (audio.currentTime || 0) + 10));
      break;
    case "ArrowUp":
      e.preventDefault();
      setVolume(state.volume + 0.1);
      break;
    case "ArrowDown":
      e.preventDefault();
      setVolume(state.volume - 0.1);
      break;
  }
};

// 安装快捷键监听（App onMounted 调用）；返回卸载函数
export function setupKeyboardShortcuts() {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("keydown", SHORTCUT_HANDLER);
  return () => window.removeEventListener("keydown", SHORTCUT_HANDLER);
}

const SPEEDS = [0.75, 1.0, 1.25];

// ============ 连播播放模式（列表循环/随机/单曲循环）============
let shuffleQueue = []; // 洗牌队列：歌曲索引排列（随机模式用）
let shufflePos = -1; // 当前歌曲在队列中的位置
let playHistory = []; // 播放历史栈（歌曲索引），随机模式"上一首"回退用

// 生成洗牌队列：leader（通常为当前歌）固定队首，其余 Fisher-Yates 随机
function buildShuffleQueue(leader) {
  const n = state.songs.length;
  if (!n) {
    shuffleQueue = [];
    shufflePos = -1;
    return;
  }
  const rest = [];
  for (let i = 0; i < n; i++) if (i !== leader) rest.push(i);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  shuffleQueue = leader >= 0 ? [leader, ...rest] : rest;
  shufflePos = leader >= 0 ? 0 : -1;
}

// 队列失效（歌曲列表变化 / 当前歌不在队列）时重建
function ensureShuffleQueue() {
  if (
    shuffleQueue.length !== state.songs.length ||
    (state.currentIndex >= 0 && !shuffleQueue.includes(state.currentIndex))
  ) {
    buildShuffleQueue(state.currentIndex);
  }
}

// 随机模式下一首：队列顺序推进，一轮播完以当前歌为队首重新洗牌
// opts.autoPlay=true 时（播完自动切歌）切到新歌后继续播放
function nextShuffle(opts = {}) {
  ensureShuffleQueue();
  if (shufflePos >= shuffleQueue.length - 1) {
    buildShuffleQueue(state.currentIndex);
    if (shuffleQueue.length > 1) {
      selectSong(shuffleQueue[1], opts);
      return;
    }
    // 只有一首歌：无法推进 → 重播本首
    if (state.currentIndex >= 0 && audio.src) {
      audio.currentTime = 0;
      state.currentTime = 0;
      if (opts.autoPlay) audio.play().catch(() => {});
    }
    return;
  }
  selectSong(shuffleQueue[shufflePos + 1], opts);
}

// 三态循环：列表循环 → 随机 → 单曲循环 → 列表循环
// 注意与跟唱模式的"单句循环/AB 循环"（歌词行级）区分：这是歌曲级播放模式
export function cyclePlayMode() {
  const order = ["order", "shuffle", "repeatOne"];
  state.playMode = order[(order.indexOf(state.playMode) + 1) % order.length];
  if (state.playMode === "shuffle") ensureShuffleQueue();
}

// 仅供测试：重置播放模式内部状态（洗牌队列/播放历史）
export function _resetPlayMode() {
  shuffleQueue = [];
  shufflePos = -1;
  playHistory = [];
}

// ============ 歌曲列表 ============
export async function loadLibrary() {
  try {
    const res = await fetch("/api/library", { cache: "no-store" });
    const data = await res.json();
    state.libraryPath = data.path;
  } catch {
    /* 忽略 */
  }
}

export async function setLibrary(path) {
  const res = await fetch("/api/library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "设置失败");
  }
  await loadSongs();
}

export async function loadSongs() {
  state.loading = true;
  state.error = "";
  try {
    const res = await fetch("/api/songs", { cache: "no-store" });
    const songs = await res.json();
    state.songs = songs;
    if (songs.length && state.currentIndex < 0) {
      state.currentIndex = 0;
      await selectSong(0);
    } else if (songs.length && state.currentSong) {
      // 刷新后保持当前选中
      const idx = songs.findIndex((s) => s.path === state.currentSong.path);
      if (idx >= 0) state.currentIndex = idx;
    }
  } catch (e) {
    state.error = "加载歌曲列表失败：" + e.message;
  } finally {
    state.loading = false;
  }
}

// ============ 选歌 ============
export async function selectSong(index, opts = {}) {
  if (index < 0 || index >= state.songs.length) return;
  // 播放历史：记录旧歌（随机模式"上一首"回退）；回退本身不记录
  if (opts.record !== false && state.currentIndex >= 0 && state.currentIndex !== index) {
    playHistory.push(state.currentIndex);
    if (playHistory.length > 100) playHistory.shift();
  }
  // 洗牌队列定位：手动选了队列外的歌 → 以它为队首重建队列
  const qIdx = shuffleQueue.indexOf(index);
  if (qIdx >= 0) {
    shufflePos = qIdx;
  } else {
    buildShuffleQueue(index);
  }
  state.currentIndex = index;
  state.currentSong = state.songs[index];
  state.isPlaying = false;
  audio.pause();
  audio.src = "/api/audio?path=" + encodeURIComponent(state.songs[index].path);
  audio.playbackRate = state.speed;
  state.currentTime = 0;
  state.duration = 0;
  state.lyric = [];
  state.lyricFormat = null;
  state.abLoop = null; // 切歌重置 AB 循环
  // 自动播放（播完自动切歌场景）：上一首结束切到新歌后继续播放
  if (opts.autoPlay) {
    audio.play().catch(() => {});
  }
  // 加载歌词
  try {
    const res = await fetch("/api/lyric?path=" + encodeURIComponent(state.songs[index].path), {
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      state.lyric = data.lines || [];
      state.lyricFormat = data.format || null;
    }
  } catch {
    state.lyric = [];
    state.lyricFormat = null;
  }
  // 预取时长
  audio.addEventListener(
    "loadedmetadata",
    () => {
      state.duration = audio.duration || 0;
    },
    { once: true },
  );
}

// ============ 播放控制 ============
export function togglePlay() {
  if (!state.currentSong) return;
  if (audio.paused) {
    play(); // 带跟唱锚点重定位（句末暂停后再播 → 锚定下一句）
  } else {
    audio.pause();
  }
}

export function play() {
  if (!state.currentSong) return;
  // 重新锚定当前时间所在句（-1 = 前奏/间隙，播到下一句时自动锚定）
  karaokeLine = locateLine(audio.currentTime);
  audio.play().catch(() => {});
}

export function pause() {
  audio.pause();
}

export function nextSong(opts = {}) {
  if (state.songs.length === 0) return;
  if (state.playMode === "shuffle") {
    nextShuffle(opts);
    return;
  }
  selectSong((state.currentIndex + 1) % state.songs.length, opts);
}

export function prevSong() {
  if (state.songs.length === 0) return;
  if (state.playMode === "shuffle" && playHistory.length) {
    // 随机模式：按播放历史回退到上一首（不重复记录）
    selectSong(playHistory.pop(), { record: false });
    return;
  }
  selectSong((state.currentIndex - 1 + state.songs.length) % state.songs.length);
}

export function seek(t) {
  if (!audio.src) return;
  audio.currentTime = t;
  state.currentTime = t;
  // 跳转后重定位跟唱锚点，避免旧锚点立刻触发暂停/漏停
  karaokeLine = locateLine(t);
}

export function cycleSpeed() {
  const i = SPEEDS.indexOf(state.speed);
  state.speed = SPEEDS[(i + 1) % SPEEDS.length];
  audio.playbackRate = state.speed;
}

export function toggleKaraoke() {
  state.karaokeOn = !state.karaokeOn;
}

export function toggleKaraokeLoop() {
  state.karaokeLoop = !state.karaokeLoop;
}

// ============ AB 区间循环（长按循环按钮进入，单击退出）============
// 进入：当前句为起点 A，等待点击另一句作为终点 B
// 循环：A→B 区间句子连播，播到 B 句尾自动跳回 A 句首

export function enterAbLoop() {
  if (state.abLoop) return; // 已在 AB 循环中，忽略
  const cur = currentLineIndex.value;
  if (cur < 0) return; // 无当前句（前奏/间隙）→ 忽略
  state.abLoop = { a: cur, b: null }; // b=null 等待选终点
  playLine(cur); // 从起点句开始播
}

export function setAbEnd(lineIndex) {
  if (!state.abLoop) return;
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  if (lineIndex === state.abLoop.a) return; // 点起点本身 → 忽略
  let a = state.abLoop.a;
  let b = lineIndex;
  if (b < a) [a, b] = [b, a]; // 终点在起点前 → 自动交换
  state.abLoop = { a, b };
  playLine(a); // 从区间起点句首开始播
}

export function exitAbLoop() {
  state.abLoop = null;
}

// 歌词点击统一入口（跟唱面板）
// 无 AB → 直接播放该句；等选终点（b=null）→ 点击设为终点；
// 区间内 → 跳到该句播放（区间不变）；区间外 → 退出 AB 循环并播放该句
// （2026-08-12 用户拍板：区间外点击 = 退出 AB + 播放当前句；区间内 = 跳转播放）
export function clickLine(lineIndex) {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const ab = state.abLoop;
  if (!ab) {
    playLine(lineIndex);
    return;
  }
  if (ab.b === null) {
    setAbEnd(lineIndex); // 等选终点：点击 = 设置终点
    return;
  }
  if (lineIndex < ab.a || lineIndex > ab.b) {
    // 区间外：退出 AB 循环，恢复正常跟唱并播放该句
    state.abLoop = null;
    playLine(lineIndex);
    return;
  }
  // 区间内：跳到该句句首播放，AB 区间保持不变
  playLine(lineIndex);
}

export function toggleZh() {
  state.zhVisible = !state.zhVisible;
}

// ============ 跟唱模式：点句跳转 ============
const lineItems = computed(() => state.lyric.filter((x) => x.type === "line"));

// 跟唱模式锚点：正在唱的句子索引（-1 = 未锚定，如前奏/间隙）
// 不靠每次 timeupdate 反推当前句——句末 e 一过 currentLineIndex 就指向下一句，
// "反推"永远判断不出该停，导致一句唱完不停
let karaokeLine = -1;

// 严格区间匹配：t 落在哪一句内（不含间隙/前奏/尾声）
function locateLine(t) {
  const lines = lineItems.value;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].s && t < lines[i].e) return i;
  }
  return -1;
}

// 仅供测试：重置跟唱锚点
export function _resetKaraokeAnchor() {
  karaokeLine = -1;
}

// 跳到某句句首；keepPlaying=true 时若暂停中则继续播
function jumpToLine(lineIndex, keepPlaying) {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  karaokeLine = lineIndex;
  audio.currentTime = lines[lineIndex].s;
  state.currentTime = lines[lineIndex].s;
  if (keepPlaying && audio.paused) audio.play().catch(() => {});
}

export function playLine(lineIndex) {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const ln = lines[lineIndex];
  karaokeLine = lineIndex;
  audio.currentTime = ln.s;
  audio.play().catch(() => {});
}

export function prevLine() {
  const cur = currentLineIndex.value;
  if (cur > 0) playLine(cur - 1);
}

export function nextLine() {
  const lines = lineItems.value;
  const cur = currentLineIndex.value;
  if (cur >= 0 && cur < lines.length - 1) playLine(cur + 1);
}

// 当前高亮句（按时间戳定位）
// 取「最后一条已开始的句子」：句间间隙（上一句 e ~ 下一句 s）中保持上一句，
// 播放结束后保持最后一句；这样跟唱模式 timeupdate 才能识别「该停了」
export const currentLineIndex = computed(() => {
  const lines = lineItems.value;
  if (!lines.length) return -1;
  const t = state.currentTime;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].s) idx = i;
    else break;
  }
  return idx;
});

// ============ 音频事件 ============
audio.addEventListener("timeupdate", () => {
  state.currentTime = audio.currentTime;
  // 跟唱模式：每句播完自动停（锚点方案）
  if (state.mode === "karaoke" && state.karaokeOn) {
    const lines = lineItems.value;
    if (!lines.length) return;
    const t = audio.currentTime;
    // 锚点失效（前奏/间隙未锚定，或 seek/回退到锚点句之前）→ 重新定位
    if (karaokeLine < 0 || t < lines[karaokeLine].s) {
      karaokeLine = locateLine(t);
    }
    if (karaokeLine >= 0 && t >= lines[karaokeLine].e) {
      // 循环处理句末：一次跳变可能跨多个短句，逐句推进直到落在句内或触发跳转（guard 防死循环）
      let guard = 0;
      while (karaokeLine >= 0 && t >= lines[karaokeLine].e && guard++ < 20) {
        const ab = state.abLoop;
        if (ab && karaokeLine >= ab.a) {
          if (ab.b !== null && karaokeLine === ab.b) {
            // AB 终点句播完 → 跳回起点句首重播
            jumpToLine(ab.a, true);
            break;
          }
          if (ab.b === null || karaokeLine < ab.b) {
            if (ab.b === null) {
              // 等选终点：起点句循环
              jumpToLine(ab.a, true);
              break;
            }
            // 起点/区间中间句播完 → 锚点推进下一句，继续播放
            karaokeLine += 1;
            continue;
          }
          // seek 跳出区间到终点之后：按单句循环/暂停处理
        }
        if (state.karaokeLoop) {
          // 单句循环：回到句首重播（不暂停）
          jumpToLine(karaokeLine, true);
        } else {
          audio.pause();
        }
        break;
      }
    }
  }
});

audio.addEventListener("play", () => {
  state.isPlaying = true;
});
audio.addEventListener("pause", () => {
  state.isPlaying = false;
});
audio.addEventListener("ended", () => {
  state.isPlaying = false;
  if (state.mode !== "continuous") return;
  if (state.playMode === "repeatOne") {
    // 单曲循环：重播本首
    audio.currentTime = 0;
    state.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (state.playMode === "shuffle") {
    nextShuffle({ autoPlay: true });
    return;
  }
  // 列表循环：顺序下一首并自动播放（连播 bug：只切歌不播放）
  nextSong({ autoPlay: true });
});

// ============ 页面标题 ============
watch(
  () => state.currentSong?.name,
  (name) => {
    document.title = name ? `QQ Player - ${name}` : "🎵 QQ Player";
  },
);
