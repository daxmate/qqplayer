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
  karaokeLoop: false, // 单句循环：跟唱开启时生效，句末自动回到句首重播
  abLoop: null, // AB 区间循环：null 关闭 | { a, b } 起点/终点（行索引，b 为 null 表示等选终点）
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
  state.abLoop = null; // 切歌重置 AB 循环
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

export function nextSong() {
  if (state.songs.length === 0) return;
  selectSong((state.currentIndex + 1) % state.songs.length);
}

export function prevSong() {
  if (state.songs.length === 0) return;
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
  if (state.mode === "continuous") {
    // 连播模式：自动下一首
    nextSong();
  }
});
