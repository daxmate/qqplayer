<template>
  <div class="pl-grid">
    <button
      v-for="g in gridGroups"
      :key="gridKey(g)"
      class="gr-card"
      :class="{ album: browseMode === 'albums' }"
      @click="emit('enter-group', g)"
    >
      <template v-if="browseMode === 'artists'">
        <span class="gr-avatar" :style="{ background: hashBg(g.name) }">{{ g.name[0] }}</span>
        <span class="gr-meta">
          <span class="gr-name">{{ g.name }}</span>
          <span class="gr-count">{{ t("playlist.songsCount", { n: g.count }) }}</span>
        </span>
      </template>
      <template v-else>
        <span v-if="coverVisible('list')" class="gr-cover">
          <img
            v-if="g.coverPath && props.coverSrc(g.coverPath) && props.coverOk(g.coverPath)"
            :src="props.coverSrc(g.coverPath)"
            alt=""
            loading="lazy"
            @error="props.markCoverError(g.coverPath)"
          />
          <Music v-else :size="20" />
        </span>
        <span class="gr-meta">
          <span class="gr-name">{{ g.album }}</span>
          <span class="gr-count"
            >{{ g.artist }} · {{ t("playlist.songsCount", { n: g.count }) }}</span
          >
        </span>
      </template>
    </button>
    <div v-if="!gridGroups.length" class="pl-empty">
      {{
        loading
          ? t("playlist.empty.scanning")
          : browseMode === "artists"
            ? t("playlist.empty.noMatchArtist")
            : t("playlist.empty.noMatchAlbum")
      }}
    </div>
  </div>
</template>

<script setup>
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Music } from "@lucide/vue";
import { state } from "../composables/usePlayer.js";
import { coverVisible } from "../composables/useCoverGuard.ts";
import { normalizeQuery, normalizeText } from "../utils/searchNormalize.js";

const props = defineProps({
  browseMode: { type: String, required: true },
  query: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  coverSrc: { type: Function, required: true },
  coverOk: { type: Function, required: true },
  markCoverError: { type: Function, required: true },
  resolveCover: { type: Function, required: true },
});

const emit = defineEmits(["enter-group"]);

const { t } = useI18n();

const UNKNOWN_ARTIST = t("playlist.unknownArtist");
const UNKNOWN_ALBUM = t("playlist.unknownAlbum");
const norm = (v, fallback) => (v && v.trim ? v.trim() : "") || fallback;

// 歌手分组聚合（名称 → 歌曲数）
const artistGroups = computed(() => {
  const m = new Map();
  for (const s of state.songs) {
    const name = norm(s.artist, UNKNOWN_ARTIST);
    m.set(name, (m.get(name) || 0) + 1);
  }
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
});

// 专辑分组聚合（按专辑名，歌手去重显示，取代表歌封面）
const albumGroups = computed(() => {
  const m = new Map();
  for (const s of state.songs) {
    const album = norm(s.album, UNKNOWN_ALBUM);
    const artist = norm(s.artist, UNKNOWN_ARTIST);
    const cur = m.get(album);
    if (cur) {
      cur.count++;
      if (!cur.artists.has(artist)) cur.artists.add(artist);
    } else {
      m.set(album, {
        album,
        artists: new Set([artist]),
        count: 1,
        coverPath: s.path, // 代表歌 path；渲染时 coverSrc(coverPath) 取 URL（契约 2026-08-27：不手写 path→/api/cover 映射）
      });
    }
  }
  return [...m.values()]
    .map((g) => {
      const list = [...g.artists];
      return {
        ...g,
        artist:
          list.length > 2 ? list.slice(0, 2).join(" / ") + t("playlist.etc") : list.join(" / "),
      };
    })
    .sort((a, b) => a.album.localeCompare(b.album, "zh"));
});

// 网格视图当前分组列表（支持搜索过滤卡片）
const gridGroups = computed(() => {
  const groups = props.browseMode === "artists" ? artistGroups.value : albumGroups.value;
  const q = normalizeQuery(props.query);
  if (!q) return groups;
  return groups.filter((g) => {
    const text = props.browseMode === "artists" ? g.name : g.album + " " + g.artist;
    return normalizeText(text).includes(q);
  });
});

const gridKey = (g) =>
  props.browseMode === "artists" ? "a:" + g.name : "l:" + g.album + ":" + g.artist;

// 专辑分组代表歌封面：useCoverURL 统一解析（resolveCover 幂等；只查不下载，专辑数远小于行数）
watch(
  () => albumGroups.value.map((g) => g.coverPath).filter(Boolean),
  (paths) => {
    for (const p of paths) props.resolveCover(p);
  },
  { immediate: true },
);

// 歌手首字母色块：名字哈希 → 渐变背景
function hashBg(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue} 48% 52%), hsl(${(hue + 42) % 360} 45% 40%))`;
}
</script>

<style scoped>
/* 歌手/专辑网格 */
.pl-grid {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  align-content: start;
}
.gr-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 12px 6px 10px;
  border-radius: 12px;
  background: var(--card);
  border: 1px solid transparent;
  transition: all 0.12s;
  text-align: center;
}
@media (hover: hover) {
  .gr-card:hover {
    background: var(--card2);
    border-color: var(--border);
    transform: translateY(-1px);
  }
  .gr-card.album:hover {
    transform: none;
  }
}
/* 专辑卡：1 列横排（封面在左，信息在右） */
.gr-card.album {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  text-align: left;
}
.gr-card.album .gr-cover {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  flex-shrink: 0;
}
.gr-card.album .gr-meta {
  flex: 1;
}
.gr-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 19px;
  font-weight: 700;
  box-shadow: 0 3px 10px var(--shadow-sm);
  flex-shrink: 0;
}
.gr-cover {
  width: 58px;
  height: 58px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--card2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  box-shadow: 0 3px 10px var(--shadow-sm);
  flex-shrink: 0;
}
.gr-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gr-meta {
  min-width: 0;
  width: 100%;
}
.gr-name {
  display: block;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gr-count {
  display: block;
  font-size: 10.5px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  padding: 30px 0;
}
</style>
