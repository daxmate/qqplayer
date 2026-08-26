<template>
  <div ref="shellEl" class="mobile-shell" :class="{ 'edge-dragging': edge.dragging }">
    <!-- 页面栈视图：home / list / sync（负一屏）/ books / videos（底部迷你播放条之上） -->
    <Transition :name="navTransition" mode="out-in">
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
      <!-- 负一屏同步中心：从左缘右滑进入（动画方向与普通 push 相反） -->
      <MobileSync v-else-if="top.name === 'sync'" :key="'sync-' + stack.length" @back="pop" />
      <MobileBooks v-else-if="top.name === 'books'" :key="'books-' + stack.length" @back="pop" />
      <MobileVideos v-else-if="top.name === 'videos'" :key="'videos-' + stack.length" @back="pop" />
      <div v-else key="void" class="mp-void"></div>
    </Transition>

    <!-- 全屏播放器：页面栈顶层（fixed 覆盖迷你条） -->
    <Transition name="mp-sheet">
      <MobilePlayer v-if="top.name === 'player'" @back="pop" @open-list="push" />
    </Transition>

    <!-- 底部常驻迷你播放条（播放器打开时隐藏） -->
    <MiniPlayerBar v-if="top.name !== 'player'" @open-player="openPlayer" />
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { selectSong, play, findSongIndex } from "../../composables/usePlayer.js";
import { useEdgeSwipe } from "../../composables/useSwipe.js";
import MobileHome from "./MobileHome.vue";
import MobileList from "./MobileList.vue";
import MobilePlayer from "./MobilePlayer.vue";
import MobileSync from "./MobileSync.vue";
import MobileBooks from "../../books/MobileBooks.vue";
import MobileVideos from "../../videos/MobileVideos.vue";
import MiniPlayerBar from "./MiniPlayerBar.vue";

const shellEl = ref(null);

defineEmits(["open-settings"]);

// ============ 页面栈（Apple Music 式导航） ============
// 栈底固定为 home；list 支持嵌套下钻（播放列表 → 歌单歌曲等）；sync 为负一屏；player 为栈顶全屏层
const stack = ref([{ name: "home" }]);
const top = computed(() => stack.value[stack.value.length - 1]);

// 切换动画方向：负一屏（sync）进出与普通 push 相反（从左滑入/向右滑出）
const navTransition = ref("mp-push");

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
  // 本次导航涉及负一屏 → 反向动画（push sync / 从 sync pop 双向生效）
  navTransition.value = view.name === "sync" ? "mp-push-reverse" : "mp-push";
  stack.value.push(view);
}

function pop() {
  const leaving = stack.value[stack.value.length - 1];
  if (leaving && leaving.name === "sync") navTransition.value = "mp-push-reverse";
  else navTransition.value = "mp-push";
  if (stack.value.length > 1) stack.value.pop();
}

// 屏幕左缘右滑（iOS 式边缘滑动）：栈深>1 → pop 返回；栈深=1（首页）→ 打开负一屏同步中心。
// 手势判断逻辑在 useEdgeSwipe（通用），onTrigger 按栈深分流放在这里。
const edge = useEdgeSwipe(shellEl, {
  enabled: () => true, // 首页也响应（打开负一屏），其余页维持返回
  onTrigger: () => {
    if (stack.value.length > 1) pop();
    else push({ name: "sync" });
  },
});

function openPlayer() {
  if (top.value.name !== "player") stack.value.push({ name: "player" });
}

// 列表点击歌曲：开始播放并进入全屏播放器
async function playFromList(song) {
  const idx = findSongIndex(song);
  if (idx < 0) return;
  await selectSong(idx);
  play();
  openPlayer();
}

// 供 App.vue 转发 SettingsModal「打开同步中心」入口
function openSyncCenter() {
  push({ name: "sync" });
}

defineExpose({ push, openSyncCenter });
</script>

<style scoped>
.mobile-shell {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 边缘滑动返回：跟手平移（--edge-shift 由 useEdgeSwipe 写入）+ 左侧投影（--edge-progress 0..1） */
  transform: translateX(var(--edge-shift, 0px));
  transition: transform 0.22s ease;
  box-shadow: -14px 0 32px rgba(0, 0, 0, calc(var(--edge-progress, 0) * 0.35));
  will-change: transform;
}
.mobile-shell.edge-dragging {
  transition: none; /* 跟手时禁用过渡，位移直跟手指 */
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
/* 负一屏（sync）动画方向相反：从左滑入（enter-from -24%）、向右滑出（leave-to +12%） */
.mp-push-reverse-enter-active,
.mp-push-reverse-leave-active {
  transition:
    transform 0.24s ease,
    opacity 0.2s ease;
}
.mp-push-reverse-enter-from {
  transform: translateX(-24%);
  opacity: 0;
}
.mp-push-reverse-leave-to {
  transform: translateX(12%);
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
