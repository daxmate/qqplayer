<template>
  <div class="playlist" :class="{ compact }">
    <div class="pl-head">
      <Music :size="13" />
      播放列表 ({{ visible.length }}/{{ state.songs.length }})
      <button
        class="pl-refresh"
        :class="{ spinning: state.loading }"
        title="重新扫描"
        @click="loadSongs()"
      >
        <RefreshCw :size="17" />
      </button>
    </div>

    <!-- 工具条：搜索 / 排序 / 只看收藏 -->
    <div class="pl-tools">
      <div class="pl-search">
        <Search :size="13" />
        <input v-model="query" type="text" placeholder="搜索歌名 / 歌手" spellcheck="false" />
      </div>
      <select v-model="sortKey" class="pl-sort" title="排序方式">
        <option value="default">默认顺序</option>
        <option value="name">按标题</option>
        <option value="artist">按歌手</option>
        <option value="duration">按时长</option>
      </select>
      <button
        class="pl-fav-btn"
        :class="{ on: favOnly }"
        :title="favOnly ? '显示全部' : '只看收藏'"
        @click="favOnly = !favOnly"
      >
        <Heart :size="13" :fill="favOnly ? 'currentColor' : 'none'" />
      </button>
    </div>

    <div class="pl-list">
      <div
        v-for="({ song, i }, vi) in visible"
        :key="song.id"
        class="pl-item"
        :class="{ active: i === state.currentIndex }"
        @click="pick(i)"
      >
        <span class="pl-idx">{{ vi + 1 }}</span>
        <div class="pl-info">
          <div class="pl-name">
            {{ song.name }}
            <span v-if="isFavorite(song.path)" class="pl-fav-mark" title="已收藏">
              <Heart :size="10" fill="currentColor" />
            </span>
          </div>
          <div class="pl-artist">
            {{ song.artist }}
            <span v-if="song.duration" class="pl-dur">{{ fmtDur(song.duration) }}</span>
            <span v-if="song.has_lyric" class="pl-lyric" title="有歌词">
              <Mic :size="11" />
            </span>
          </div>
        </div>
        <span v-if="i === state.currentIndex" class="pl-eq" title="播放中">
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
        </span>
        <button
          class="pl-action heart"
          :class="{ on: isFavorite(song.path) }"
          :title="isFavorite(song.path) ? '取消收藏' : '收藏'"
          @click.stop="toggleFavorite(song.path)"
        >
          <Heart :size="14" :fill="isFavorite(song.path) ? 'currentColor' : 'none'" />
        </button>
        <button class="pl-action remove" title="从队列移除" @click.stop="removeFromQueue(i)">
          <X :size="14" />
        </button>
      </div>
      <div v-if="!visible.length" class="pl-empty">
        {{
          state.loading
            ? "扫描中…"
            : state.songs.length
              ? favOnly
                ? "没有收藏的歌曲"
                : "没有匹配的歌曲"
              : "没有歌曲，请设置歌曲库"
        }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { Music, Mic, RefreshCw, Search, Heart, X } from "@lucide/vue";
import {
  state,
  selectSong,
  loadSongs,
  play,
  isFavorite,
  toggleFavorite,
  removeFromQueue,
} from "../composables/usePlayer.js";

defineProps({
  compact: { type: Boolean, default: false },
});

// ============ 搜索 / 排序 / 收藏过滤 ============
const query = ref("");
const sortKey = ref("default");
const favOnly = ref(false);

// 过滤 + 排序后的可见列表：{ song, i }，i 为在 state.songs 中的原始索引
const visible = computed(() => {
  let list = state.songs.map((song, i) => ({ song, i }));
  if (favOnly.value) {
    list = list.filter(({ song }) => isFavorite(song.path));
  }
  const q = query.value.trim().toLowerCase();
  if (q) {
    list = list.filter(
      ({ song }) =>
        (song.name || "").toLowerCase().includes(q) ||
        (song.artist || "").toLowerCase().includes(q),
    );
  }
  const key = sortKey.value;
  if (key === "name") {
    list.sort((a, b) => (a.song.name || "").localeCompare(b.song.name || ""));
  } else if (key === "artist") {
    list.sort((a, b) => (a.song.artist || "").localeCompare(b.song.artist || ""));
  } else if (key === "duration") {
    list.sort((a, b) => (a.song.duration ?? 0) - (b.song.duration ?? 0));
  }
  return list;
});

function pick(i) {
  selectSong(i);
  play(); // 点击列表直接开始播放
}

function fmtDur(d) {
  const m = Math.floor(d / 60);
  const s = Math.floor(d % 60);
  return m + ":" + String(s).padStart(2, "0");
}
</script>

<style scoped>
.playlist {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.pl-head {
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pl-refresh {
  margin-left: auto;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text2);
  transition: all 0.15s;
  flex-shrink: 0;
}
.pl-refresh:hover {
  background: var(--border);
  color: var(--text);
}
.pl-refresh:active {
  transform: scale(0.92);
}
.pl-refresh.spinning svg {
  animation: refresh-spin 0.9s linear infinite;
}
@keyframes refresh-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
/* 工具条 */
.pl-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.pl-search {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--card2);
  border-radius: 9px;
  padding: 0 9px;
  height: 30px;
  color: var(--text3);
}
.pl-search input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 12.5px;
}
.pl-search input::placeholder {
  color: var(--text3);
}
.pl-sort {
  height: 30px;
  background: var(--card2);
  color: var(--text2);
  border: none;
  border-radius: 9px;
  padding: 0 6px;
  font-size: 12px;
  outline: none;
  cursor: pointer;
  flex-shrink: 0;
}
.pl-sort:hover {
  color: var(--text);
}
.pl-fav-btn {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text3);
  transition: all 0.15s;
  flex-shrink: 0;
}
.pl-fav-btn:hover {
  color: var(--text);
}
.pl-fav-btn.on {
  color: #ff6b81;
  background: rgba(255, 107, 129, 0.15);
}
.pl-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.pl-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.12s;
}
.pl-item:hover {
  background: var(--card2);
}
.pl-item.active {
  background: linear-gradient(135deg, rgba(255, 126, 95, 0.22), rgba(254, 180, 123, 0.12));
}
.pl-idx {
  width: 20px;
  font-size: 12px;
  color: var(--text3);
  text-align: right;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.pl-info {
  flex: 1;
  min-width: 0;
}
.pl-name {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-fav-mark {
  display: inline-flex;
  vertical-align: -1px;
  margin-left: 4px;
  color: #ff6b81;
}
.pl-artist {
  font-size: 11.5px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-dur {
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}
.pl-lyric {
  display: inline-flex;
  vertical-align: -2px;
  margin-left: 4px;
  color: var(--text2);
}
.pl-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
}
.eq-bar {
  width: 3px;
  border-radius: 1.5px;
  background: currentColor;
  height: 100%;
  animation: eq-bounce 1s ease-in-out infinite;
}
.eq-bar:nth-child(2) {
  animation-delay: -0.33s;
}
.eq-bar:nth-child(3) {
  animation-delay: -0.66s;
}
@keyframes eq-bounce {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}
/* 行操作按钮：默认隐藏，hover 显示 */
.pl-action {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  opacity: 0;
  transition: all 0.12s;
  flex-shrink: 0;
}
.pl-item:hover .pl-action {
  opacity: 1;
}
.pl-action:hover {
  background: var(--border);
  color: var(--text);
}
.pl-action.heart.on {
  opacity: 1;
  color: #ff6b81;
}
.pl-action.remove:hover {
  color: #ff6b81;
}
.pl-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  padding: 30px 0;
}
</style>
