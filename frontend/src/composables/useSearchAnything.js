// search anything 数据源 + 匹配度打分（模块级单例）
// 五类数据源：本地歌曲 / 在线歌曲（网易云）/ 歌手 / 专辑 / 设置项
// 混合结果按匹配度排序：score 降序 → kindRank 升序 → title localeCompare(zh)
// 单例：模块顶层共享 ref，多次调用 useSearchAnything() 返回同一实例。
import { ref, watch } from "vue";
import { state } from "./usePlayer.js";
import { isSearchOpen } from "./searchState.js";
import { history, loadHistory, addHistory, removeHistory, clearHistory } from "./searchHistory.js";
import { matchScore, kindRank } from "../utils/score.js";
import { apiGet } from "../utils/apiClient.js";
import { settingsIndex, SETTING_CATEGORIES } from "../settingsIndex.js";
import i18n from "../locales/i18n.js";

const DEBOUNCE_MS = 250;
const ONLINE_LIMIT = 20; // 在线接口 limit（契约：与后端一致）
const LIMITS = { song: 8, online: 20, artist: 5, album: 5, setting: 10 };
const NAME_WEIGHT = 20; // 歌曲字段权重：歌名 > 歌手 > 专辑
const ARTIST_WEIGHT = 10;
const ALBUM_WEIGHT = 0;
const ALIAS_BONUS = 10; // 设置项别名命中加成
const UNKNOWN_ARTIST = "未知歌手";
const UNKNOWN_ALBUM = "未知专辑";

const query = ref("");
const results = ref([]);
const loading = ref(false);
// 在线歌曲源：'netease' 网易云（默认，现有行为不变）| 'gequhai' 歌曲海（夸克网盘直链下载）
const onlineSource = ref("netease");

let debounceTimer = null;
let searchSeq = 0; // 请求序列号：过期响应丢弃（快速连续输入时，参照 OnlineSearch.vue）

// ---------- 本地歌曲 ----------
function collectSongs(q) {
  const out = [];
  for (const song of state.songs) {
    if (!song) continue;
    // 三字段分别 matchScore，取最高分；字段权重：name +20 / artist +10 / album +0
    let best = 0;
    for (const f of [
      { text: song.name, weight: NAME_WEIGHT },
      { text: song.artist, weight: ARTIST_WEIGHT },
      { text: song.album, weight: ALBUM_WEIGHT },
    ]) {
      const s = matchScore(q, f.text);
      if (s > 0) best = Math.max(best, s + f.weight);
    }
    if (!best) continue;
    out.push({
      kind: "song",
      id: song.path || song.id,
      title: song.name,
      subtitle: [song.artist, song.album].filter(Boolean).join(" · "),
      badge: "本地",
      score: best,
      payload: song, // state.songs 条目原样透传（A 任务按 path/name 消费）
    });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh"));
  return out.slice(0, LIMITS.song);
}

// ---------- 在线歌曲（网易云 / 歌曲海）----------
async function fetchOnline(q, seq) {
  try {
    const src = onlineSource.value === "gequhai" ? "gequhai" : "netease";
    // 在线搜索是实时数据，不走缓存（离线时在线组不出现，本地结果照常）
    const r = await apiGet(
      `/api/online/search?q=${encodeURIComponent(q)}&limit=${ONLINE_LIMIT}&source=${src}`,
    );
    if (seq !== searchSeq) return []; // 过期响应丢弃
    if (!r.ok) return [];
    const data = r.data || {};
    if (seq !== searchSeq) return [];
    const items = Array.isArray(data.items) ? data.items : [];
    return items
      .slice(0, LIMITS.online)
      .map((item) => ({
        kind: "online",
        id: "online-" + item.id,
        title: item.title ?? "",
        subtitle: [item.artist, item.album].filter(Boolean).join(" · "),
        badge: src === "gequhai" ? "歌曲海" : "在线",
        score: matchScore(q, item.title),
        payload: {
          id: item.id,
          title: item.title,
          artist: item.artist,
          album: item.album,
          cover: item.cover,
          duration: item.duration,
          quality: item.quality ?? item.level ?? "",
        },
      }))
      .filter((r) => r.score > 0); // 与本地一致：只收有匹配度的条目
  } catch {
    return []; // 失败静默：在线组不出现，不抛错
  }
}

// ---------- 歌手（state.songs 按 artist 聚合计数）----------
function collectArtists(q) {
  const countMap = new Map(); // artist → count
  for (const song of state.songs) {
    if (!song) continue;
    const artist = (song.artist && String(song.artist).trim()) || UNKNOWN_ARTIST;
    countMap.set(artist, (countMap.get(artist) || 0) + 1);
  }
  const scored = [];
  for (const [artist, count] of countMap) {
    const score = matchScore(q, artist);
    if (score > 0) scored.push({ artist, count, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || b.count - a.count || a.artist.localeCompare(b.artist, "zh"),
  );
  return scored.slice(0, LIMITS.artist).map(({ artist, count, score }) => ({
    kind: "artist",
    id: "artist-" + artist,
    title: artist,
    subtitle: `${count} 首`,
    badge: "歌手",
    score,
    payload: { artist, count },
  }));
}

// 专辑 artists 串：去重 >2 显示 "A / B 等"
function formatArtists(list) {
  const uniq = [...new Set(list.filter(Boolean))];
  if (uniq.length > 2) return `${uniq[0]} / ${uniq[1]} 等`;
  return uniq.join(" / ");
}

// ---------- 专辑（state.songs 按 album 聚合计数）----------
function collectAlbums(q) {
  const map = new Map(); // album → { album, artists:Set, count }
  for (const song of state.songs) {
    if (!song) continue;
    const album = (song.album && String(song.album).trim()) || UNKNOWN_ALBUM;
    let rec = map.get(album);
    if (!rec) {
      rec = { album, artists: new Set(), count: 0 };
      map.set(album, rec);
    }
    rec.count++;
    const artist = song.artist && String(song.artist).trim();
    if (artist) rec.artists.add(artist);
  }
  const scored = [];
  for (const rec of map.values()) {
    const score = matchScore(q, rec.album);
    if (score > 0) scored.push({ rec, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.rec.count - a.rec.count ||
      a.rec.album.localeCompare(b.rec.album, "zh"),
  );
  return scored.slice(0, LIMITS.album).map(({ rec, score }) => ({
    kind: "album",
    id: "album-" + rec.album,
    title: rec.album,
    subtitle: formatArtists([...rec.artists]),
    badge: "专辑",
    score,
    payload: { album: rec.album, artists: [...rec.artists], count: rec.count },
  }));
}

// ---------- 设置项 ----------
function collectSettings(q) {
  const out = [];
  for (const entry of settingsIndex) {
    if (!entry) continue;
    const title = i18n.global.t(entry.labelKey); // 翻译文案
    let score = matchScore(q, title);
    if (score === 0 && Array.isArray(entry.keywords)) {
      // 别名命中 +10（仅当文案本身不中时启用，避免双重加分）
      for (const kw of entry.keywords) {
        const s = matchScore(q, kw);
        if (s > 0) {
          score = s + ALIAS_BONUS;
          break;
        }
      }
    }
    if (score === 0) continue;
    out.push({
      kind: "setting",
      id: entry.key || entry.labelKey,
      title,
      subtitle: settingsCategoryLabel(entry.category),
      badge: "设置",
      score,
      payload: entry, // SettingEntry 原样透传
    });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh"));
  return out.slice(0, LIMITS.setting);
}

// 设置项分类名（subtitle）：category key → SETTING_CATEGORIES 的 labelKey 翻译
function settingsCategoryLabel(category) {
  const cat = (SETTING_CATEGORIES || []).find((c) => c.key === category);
  return cat ? i18n.global.t(cat.labelKey) : "";
}

// ---------- 汇总排序 ----------
function sortResults(a, b) {
  return (
    b.score - a.score || kindRank(a.kind) - kindRank(b.kind) || a.title.localeCompare(b.title, "zh")
  );
}

async function runSearch(rawQ) {
  const q = String(rawQ).trim();
  const seq = searchSeq;
  // 本地来源（歌曲/歌手/专辑/设置）同步立即出结果，不等在线
  const local = collectSongs(q)
    .concat(collectArtists(q), collectAlbums(q), collectSettings(q))
    .sort(sortResults);
  if (seq !== searchSeq) return; // 期间又有新输入：本批作废
  results.value = local;
  // 在线结果异步到达后追加到末尾（本地保持先出，不重新全局混排）
  try {
    const online = await fetchOnline(q, seq);
    if (seq !== searchSeq) return;
    results.value = local.concat(online);
  } catch {
    // 在线失败已静默：本地结果保留，不中断
  } finally {
    if (seq === searchSeq) loading.value = false;
  }
}

// 打开时刷新历史（从 localStorage 重载；组件聚焦输入框后即可见）
watch(isSearchOpen, (open) => {
  if (open) loadHistory();
});

// query 变化 → 防抖 250ms；空 → 清空结果但**保持搜索层打开**
// （2026-08-16 修复：之前空输入会 isSearchOpen=false，删光搜索词=自动退出编辑框，
//   用户反馈 bug；收起只走 Esc / 点空白 / Cmd+K / clear()）
watch(query, () => {
  searchSeq++;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const q = query.value;
  if (!q || !q.trim()) {
    results.value = [];
    loading.value = false;
    return;
  }
  isSearchOpen.value = true;
  loading.value = true;
  debounceTimer = setTimeout(() => runSearch(q), DEBOUNCE_MS);
});

/** 切换在线歌曲源；已输入关键词时立即重新搜索 */
function setOnlineSource(src) {
  const next = src === "gequhai" ? "gequhai" : "netease";
  if (next === onlineSource.value) return;
  onlineSource.value = next;
  const q = String(query.value).trim();
  if (q) runSearch(q);
}

/** 清空搜索状态（关闭搜索层时调用） */
function clear() {
  searchSeq++;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  query.value = "";
  results.value = [];
  loading.value = false;
  isSearchOpen.value = false;
}

export function useSearchAnything() {
  return {
    query,
    results,
    loading,
    isSearchOpen,
    onlineSource,
    history,
    setOnlineSource,
    clear,
    loadHistory,
    addHistory,
    removeHistory,
    clearHistory,
  };
}
