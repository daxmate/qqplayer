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
  karaokeOn: true, // 跟唱开关：开=每句播完自动停
  speed: 1.0,
  zhVisible: true,
  lyric: [], // [{type:'sec',name} | {type:'line',s,e,text:[jp,roma,zh]}]
  lyricFormat: null, // 'srt' | 'lrc' | null
  libraryPath: "",
  loading: false,
  error: "",
});

const SPEEDS = [0.75, 1.0, 1.25];

// ============ 歌曲列表 ============
export async function loadLibrary() {
  try {
    const res = await fetch("/api/library", { cache: "no-store" });
    const data = await res.json();
    state.libraryPath = data.path;
  } catch (e) {
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
export async function selectSong(index) {
  if (index < 0 || index >= state.songs.length) return;
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
  // 加载歌词
  try {
    const res = await fetch(
      "/api/lyric?path=" + encodeURIComponent(state.songs[index].path),
      { cache: "no-store" }
    );
    if (res.ok) {
      const data = await res.json();
      state.lyric = data.lines || [];
      state.lyricFormat = data.format || null;
    }
  } catch (e) {
    state.lyric = [];
    state.lyricFormat = null;
  }
  // 预取时长
  audio.addEventListener(
    "loadedmetadata",
    () => {
      state.duration = audio.duration || 0;
    },
    { once: true }
  );
}

// ============ 播放控制 ============
export function togglePlay() {
  if (!state.currentSong) return;
  if (audio.paused) {
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
}

export function play() {
  if (!state.currentSong) return;
  audio.play().catch(() => {});
}

export function pause() {
  audio.pause();
}

export function nextSong() {
  if (state.songs.length === 0) return;
  selectSong((state.currentIndex + 1) % state.songs.length);
}

export function prevSong() {
  if (state.songs.length === 0) return;
  selectSong(
    (state.currentIndex - 1 + state.songs.length) % state.songs.length
  );
}

export function seek(t) {
  if (!audio.src) return;
  audio.currentTime = t;
  state.currentTime = t;
}

export function cycleSpeed() {
  const i = SPEEDS.indexOf(state.speed);
  state.speed = SPEEDS[(i + 1) % SPEEDS.length];
  audio.playbackRate = state.speed;
}

export function toggleKaraoke() {
  state.karaokeOn = !state.karaokeOn;
}

export function toggleZh() {
  state.zhVisible = !state.zhVisible;
}

// ============ 跟唱模式：点句跳转 ============
const lineItems = computed(() =>
  state.lyric.filter((x) => x.type === "line")
);

export function playLine(lineIndex) {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const ln = lines[lineIndex];
  audio.currentTime = ln.s;
  play();
}

export function prevLine() {
  const lines = lineItems.value;
  const cur = currentLineIndex.value;
  if (cur > 0) playLine(cur - 1);
}

export function nextLine() {
  const lines = lineItems.value;
  const cur = currentLineIndex.value;
  if (cur >= 0 && cur < lines.length - 1) playLine(cur + 1);
}

// 当前高亮句（按时间戳定位）
export const currentLineIndex = computed(() => {
  const lines = lineItems.value;
  if (!lines.length) return -1;
  const t = state.currentTime;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].s && t < lines[i].e) return i;
  }
  // 播放结束后保持最后一句
  if (t >= lines[lines.length - 1].e) return lines.length - 1;
  return -1;
});

// ============ 音频事件 ============
audio.addEventListener("timeupdate", () => {
  state.currentTime = audio.currentTime;
  // 跟唱模式：每句播完自动停
  if (state.mode === "karaoke" && state.karaokeOn) {
    const lines = lineItems.value;
    const idx = currentLineIndex.value;
    if (idx >= 0 && lines[idx] && audio.currentTime >= lines[idx].e) {
      audio.pause();
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
  if (state.mode === "continuous") {
    // 连播模式：自动下一首
    nextSong();
  }
});
