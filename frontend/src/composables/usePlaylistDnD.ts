// Playlist 拖拽/排序 + 定位当前播放 composable（从 Playlist.vue 拆出，行为零变化重构）
//
// 职责：
//   - 歌单拖拽排序：浏览器 = sortablejs（仅无过滤时可排）；壳内（WKWebView 无 HTML5 DnD）=
//     useShellDrag 的 pointer 模拟（任何视图可拖出加歌单，getCanReorder 控制列表内排序放行）
//   - 拖拽到侧栏歌单数据源：行手柄 dragstart 写入自定义 MIME（DRAG_SONG_TYPE）
//   - 定位当前播放：滚动 .pl-list 到当前行 + 临时高亮闪烁
//
// 生命周期自管：watch([activePlaylist, canReorder]) → nextTick 重建、onMounted 初始化、
// onBeforeUnmount 清理（sortablejs / 壳拖拽 / locate 定时器）。
// 依赖注入：canReorder / canDragOut / visible（主组件 computed），state 直接导入。

import { ref, watch, onMounted, onBeforeUnmount, nextTick, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import Sortable from "sortablejs";
import {
  state,
  activePlaylist,
  reorderQueue,
  setPlaylistOrder,
  persistQueueOrder,
  DRAG_SONG_TYPE,
} from "./usePlayer.js";
import { inNativeShell, setupShellRowDrag } from "./useShellDrag.js";
import { showToast, toastError } from "./useToast.js";

interface DndDeps {
  /** 列表内排序启用条件（无搜索/排序/收藏/分组过滤时 = 可见集全量，排序不丢歌） */
  canReorder: Ref<boolean>;
  /** 拖出手柄显示（恒真：所有视图行手柄始终可用，拖出到侧栏歌单） */
  canDragOut: Ref<boolean>;
  /** 当前可见列表（过滤/排序后视图行，{ song, i } 结构；定位当前播放按 i 找行） */
  visible: Ref<Array<{ song: { path: string | null; [k: string]: unknown }; i: number }>>;
}

export function usePlaylistDnD(deps: DndDeps) {
  const { t } = useI18n();
  const listEl = ref<HTMLElement | null>(null);
  let sortable: Sortable | null = null;
  let shellDragCleanup: (() => void) | null = null; // 壳内拖拽清理函数（useShellDrag）
  let locateTimer: ReturnType<typeof setTimeout> | null = null;

  function setupSortable() {
    sortable?.destroy();
    sortable = null;
    shellDragCleanup?.();
    shellDragCleanup = null;
    if (!listEl.value) return;
    const list = listEl.value;
    if (inNativeShell()) {
      // 壳内（WKWebView 无 HTML5 DnD）：手柄 pointer 事件模拟排序 + 拖到侧栏歌单；
      // 任何视图都挂（canDragOut 恒真），getCanReorder 控制列表内排序是否放行（过滤时禁）
      shellDragCleanup = setupShellRowDrag({
        listEl: list,
        getCanDrag: () => deps.canDragOut.value,
        getCanReorder: () => deps.canReorder.value,
        isPlaylistView: () => !!state.activePlaylistId,
        onQueueReorder: (from, to) => {
          reorderQueue(from, to);
          persistQueueOrder().catch((e) => toastError(e.message));
        },
        onPlaylistReorder: (paths) => {
          setPlaylistOrder(state.activePlaylistId, paths).catch((e) => toastError(e.message));
        },
      });
      return;
    }
    // 浏览器：列表内排序只在无过滤时初始化 SortableJS（过滤时排序禁，但行手柄仍可 HTML5 DnD 拖出加歌单）
    if (!deps.canReorder.value) return;
    sortable = Sortable.create(list, {
      handle: ".pl-drag",
      animation: 150,
      ghostClass: "pl-ghost",
      supportPointer: true, // pointer 事件统一鼠标/触控笔/触摸（触屏可拖拽排序）
      onEnd: ({ oldIndex, newIndex }) => {
        if (oldIndex === newIndex) return;
        // Sortable 保证 onEnd 两者同时存在；防御 undefined（与旧行为等价，正常路径不触发）
        if (oldIndex == null || newIndex == null) return;
        if (state.activePlaylistId) {
          // 歌单视图：重排歌单内歌曲顺序
          const paths = [...list.querySelectorAll<HTMLElement>(".pl-item")].map(
            (el) => el.dataset.path,
          );
          setPlaylistOrder(state.activePlaylistId, paths).catch((e) => toastError(e.message));
        } else {
          // 全部歌曲视图：重排播放队列顺序并持久化（后端 /api/queue/order，刷新后恢复）
          reorderQueue(oldIndex, newIndex);
          persistQueueOrder().catch((e) => toastError(e.message));
        }
      },
    });
  }

  watch([activePlaylist, deps.canReorder], () => nextTick(setupSortable));
  onMounted(() => nextTick(setupSortable));
  onBeforeUnmount(() => {
    sortable?.destroy();
    shellDragCleanup?.();
    clearTimeout(locateTimer ?? undefined);
  });

  // 拖拽到侧栏歌单（HTML5 DnD：歌曲行手柄 → Sidebar 歌单项）
  // 与 sortablejs 同源共用手柄：sortablejs 用 pointerdown + 原生 dragstart 驱动列表内排序，
  // 我们只附加 dataTransfer 元数据，drop 目标只有 Sidebar 歌单，两套语义互不干扰。
  function onRowDragStart(e: DragEvent, path: string | null) {
    if (!path) {
      // 网络歌（path=null）不能加入歌单
      e.preventDefault();
      return;
    }
    const dt = e.dataTransfer;
    if (!dt) return;
    dt.setData(DRAG_SONG_TYPE, path);
    dt.effectAllowed = "copy";
  }

  // 滚动 .pl-list 让行可见：行在视口内不动，否则滚到行顶（带内边距留白）
  function scrollRowIntoList(list: HTMLElement, rowEl: HTMLElement) {
    const pad = 6;
    const listRect = list.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    const relTop = rowRect.top - listRect.top + list.scrollTop;
    const relBottom = relTop + rowRect.height;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    if (relTop < viewTop || relBottom > viewBottom) {
      const top = Math.max(0, relTop - pad);
      if (typeof list.scrollTo === "function") {
        list.scrollTo({ top, behavior: "smooth" });
      } else {
        list.scrollTop = top;
      }
    }
  }

  // 定位当前播放（工具条按钮 / EQ 标记点击）
  function locateCurrent() {
    const idx = state.currentIndex;
    if (idx < 0 || !listEl.value) return;
    const domIdx = deps.visible.value.findIndex((v) => v.i === idx);
    if (domIdx < 0) {
      // 搜索/过滤中当前播放行不可见 → 提示
      showToast(t("playlist.locate.notVisible"));
      return;
    }
    const rowEl = listEl.value.querySelectorAll<HTMLElement>(".pl-item")[domIdx];
    if (!rowEl) return;
    scrollRowIntoList(listEl.value, rowEl);
    // 临时高亮闪烁
    rowEl.classList.add("pl-locate");
    clearTimeout(locateTimer ?? undefined);
    locateTimer = setTimeout(() => rowEl.classList.remove("pl-locate"), 1500);
  }

  return { listEl, onRowDragStart, locateCurrent };
}
