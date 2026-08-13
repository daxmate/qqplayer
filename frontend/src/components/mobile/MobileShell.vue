<template>
  <div class="mobile-shell">
    <!-- 页面栈视图：home / list（底部迷你播放条之上） -->
    <Transition name="mp-push" mode="out-in">
      <MobileHome
        v-if="top.name === 'home'"
        key="home"
        @open="push"
        @open-settings="$emit('open-settings')"
      />
      <MobileList
        v-else-if="top.name === 'list'"
        :key="'list-' + stack.length"
        :kind="top.kind"
        :title="top.title"
        :payload="top.payload"
        @back="pop"
        @play="playFromList"
        @open="push"
      />
      <div v-else key="void" class="mp-void"></div>
    </Transition>

    <!-- 全屏播放器：页面栈顶层（fixed 覆盖迷你条） -->
    <Transition name="mp-sheet">
      <MobilePlayer v-if="top.name === 'player'" @back="pop" />
    </Transition>

    <!-- 底部常驻迷你播放条（播放器打开时隐藏） -->
    <MiniPlayerBar v-if="top.name !== 'player'" @open-player="openPlayer" />
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { selectSong, play, state } from "../../composables/usePlayer.js";
import MobileHome from "./MobileHome.vue";
import MobileList from "./MobileList.vue";
import MobilePlayer from "./MobilePlayer.vue";
import MiniPlayerBar from "./MiniPlayerBar.vue";

defineEmits(["open-settings"]);

// ============ 页面栈（Apple Music 式导航） ============
// 栈底固定为 home；list 支持嵌套下钻（播放列表 → 歌单歌曲等）；player 为栈顶全屏层
const stack = ref([{ name: "home" }]);
const top = computed(() => stack.value[stack.value.length - 1]);

function push(view) {
  // 同页去重：连续点同一列表不重复入栈
  const last = stack.value[stack.value.length - 1];
  if (
    last.name === view.name &&
    last.kind === view.kind &&
    last.title === view.title &&
    last.payload === view.payload
  ) {
    return;
  }
  stack.value.push(view);
}

function pop() {
  if (stack.value.length > 1) stack.value.pop();
}

function openPlayer() {
  if (top.value.name !== "player") stack.value.push({ name: "player" });
}

// 列表点击歌曲：开始播放并进入全屏播放器
async function playFromList(song) {
  const idx = state.songs.findIndex((s) => s.path === song.path);
  if (idx < 0) return;
  await selectSong(idx);
  play();
  openPlayer();
}
</script>

<style scoped>
.mobile-shell {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.mp-void {
  display: none;
}
/* 页面栈切换动画：左右推入（transform 不影响布局，视图保持 flex:1 占位） */
.mp-push-enter-active,
.mp-push-leave-active {
  transition:
    transform 0.24s ease,
    opacity 0.2s ease;
}
.mp-push-enter-from {
  transform: translateX(24%);
  opacity: 0;
}
.mp-push-leave-to {
  transform: translateX(-12%);
  opacity: 0;
}
/* 播放器：底部滑入全屏 */
.mp-sheet-enter-active,
.mp-sheet-leave-active {
  transition: transform 0.28s ease;
}
.mp-sheet-enter-from,
.mp-sheet-leave-to {
  transform: translateY(100%);
}
</style>
