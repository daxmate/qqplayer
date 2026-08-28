<template>
  <div ref="shellEl" class="mobile-shell" :class="{ 'edge-dragging': edge.dragging }">
    <!-- 页面栈视图：main（分页容器，栈底）/ list / settings（负一屏）/ books / videos（底部迷你播放条之上） -->
    <Transition :name="navTransition" mode="out-in">
      <!-- 分页容器用 KeepAlive 缓存：从列表/播放器/设置返回后保留当前分页与屏内状态（书架滚动等） -->
      <KeepAlive v-if="top.name === 'main'">
        <MobilePager
          key="main"
          :page-index="pagerPage"
          @update:page-index="pagerPage = $event"
          @open="push"
          @open-settings="openSettings"
          @overlay="pagerOverlay = $event"
        />
      </KeepAlive>
      <MobileList
        v-else-if="top.name === 'list'"
        :key="'list-' + stack.length"
        :kind="top.kind || ''"
        :title="top.title"
        :payload="top.payload"
        @back="pop"
        @play="playFromList"
        @open="push"
      />
      <!-- 负一屏设置区：从左缘右滑进入（动画方向与普通 push 相反） -->
      <MobileSettings
        v-else-if="top.name === 'settings'"
        :key="'settings-' + stack.length"
        @back="pop"
      />
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

<script setup lang="ts">
import { ref, computed } from "vue";
import { selectSong, play, findSongIndex, type Song } from "../../composables/usePlayer.js";
import { useEdgeSwipe } from "../../composables/useSwipe.js";
import MobilePager from "./MobilePager.vue";
import MobileList from "./MobileList.vue";
import MobilePlayer from "./MobilePlayer.vue";
import MobileSettings from "./MobileSettings.vue";
import MiniPlayerBar from "./MiniPlayerBar.vue";

const shellEl = ref(null);

// ============ 页面栈（Apple Music 式导航） ============
// 栈底固定为 main（横滑分页容器）；list 支持嵌套下钻；settings 为负一屏；player 为栈顶全屏层
interface View {
  name: string;
  kind?: string;
  title?: string;
  payload?: Record<string, unknown>;
}
const stack = ref<View[]>([{ name: "main" }]);
const top = computed(() => stack.value[stack.value.length - 1]);

// 分页当前下标（壳层持有：左缘右滑翻上一屏用；KeepAlive 重挂载后经 :page-index 恢复）
const pagerPage = ref(0);

// 切换动画方向：负一屏（settings）进出与普通 push 相反（从左滑入/向右滑出）
const navTransition = ref("mp-push");

function push(view: View) {
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
  // 本次导航涉及负一屏 → 反向动画（push settings / 从 settings pop 双向生效）
  navTransition.value = view.name === "settings" ? "mp-push-reverse" : "mp-push";
  stack.value.push(view);
}

function pop() {
  const leaving = stack.value[stack.value.length - 1];
  if (leaving && leaving.name === "settings") navTransition.value = "mp-push-reverse";
  else navTransition.value = "mp-push";
  if (stack.value.length > 1) stack.value.pop();
}

// 音乐页齿轮 / SettingsModal「打开同步中心」→ 负一屏设置区（默认同步面板）
function openSettings() {
  push({ name: "settings" });
}
function openSyncCenter() {
  openSettings();
}

defineExpose({ push, openSyncCenter, openSettings });

// ============ 分页容器（栈底 main） ============
// 分页屏内阅读器/视频播放器浮层开关（pager 上报；浮层打开时禁边缘滑动）
const pagerOverlay = ref(false);

// 屏幕左缘右滑（iOS 式边缘滑动）：
//   栈深 > 1 → pop 返回；栈深 = 1（分页容器）→ 第 0 屏打开负一屏设置区，其余屏翻上一屏。
// 分页屏内全屏浮层（阅读器/视频播放器）打开时禁用（浮层自身处理返回）。
const edge = useEdgeSwipe(shellEl, {
  enabled: () => !(top.value.name === "main" && pagerOverlay.value),
  onTrigger: () => {
    if (stack.value.length > 1) {
      pop();
    } else if (pagerPage.value > 0) {
      pagerPage.value--; // 其余屏左缘右滑 = 翻上一屏
    } else {
      push({ name: "settings" }); // 第 0 屏（音乐）左缘右滑 → 负一屏设置区
    }
  },
});

function openPlayer() {
  if (top.value.name !== "player") stack.value.push({ name: "player" });
}

// 列表点击歌曲：开始播放并进入全屏播放器
async function playFromList(song: Song) {
  const idx = findSongIndex(song);
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
/* 负一屏（settings）动画方向相反：从左滑入（enter-from -24%）、向右滑出（leave-to +12%） */
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
