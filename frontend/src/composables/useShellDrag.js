// 壳内歌曲行拖拽（Pointer Events 模拟，替代 HTML5 DnD）
//
// 背景：Swift 壳（WKWebView）里 HTML5 draggable 相关事件不派发，SortableJS（歌单内排序）和
// 拖到侧栏歌单（dataTransfer drop）全部失效；文件拖入导入（useDragImport 的 drop）正常，不受影响。
// 壳内（window.qqplayerNative 存在时）改用手柄 .pl-drag 的 pointerdown/pointermove/pointerup 模拟：
//   - 列表内拖动：行中心交叉模型算插入索引（与 SortableJS onEnd 语义一致）→ 回调 onQueueReorder / onPlaylistReorder
//   - 拖到侧边栏歌单（.sb-item[data-playlist-id] 几何命中）：加 sb-drop 高亮 + 派发
//     qqplayer:shell-drag-drop 事件，Sidebar.vue 监听并复用 onPlaylistDrop 同一套幂等加歌逻辑
// 浏览器（无 window.qqplayerNative）setupShellRowDrag 直接返回 null，不挂任何监听，HTML5 DnD 行为零影响。

const DRAG_THRESHOLD = 5; // 按下移动超过该像素才进入拖拽态（阈值内 = 普通行点击）

/** 是否运行在 Swift 原生壳内（壳注入 window.qqplayerNative；浏览器没有） */
export function inNativeShell() {
  return typeof window !== "undefined" && !!window.qqplayerNative;
}

/**
 * 壳内行拖拽（Playlist.vue 在 canDrag 且壳内时调用，返回清理函数）
 * @param {object} opts
 * @param {HTMLElement} opts.listEl .pl-list 滚动容器（pointerdown 委托挂在这里）
 * @param {() => boolean} opts.getCanDrag 拖拽启用条件（搜索/排序/收藏/分组过滤时 false）
 * @param {() => boolean} opts.isPlaylistView 歌单视图（true = setPlaylistOrder，false = reorderQueue）
 * @param {(from: number, to: number) => void} opts.onQueueReorder 全部歌曲视图重排（reorderQueue + persistQueueOrder）
 * @param {(paths: string[]) => void} opts.onPlaylistReorder 歌单视图重排（setPlaylistOrder）
 */
export function setupShellRowDrag({
  listEl,
  getCanDrag,
  isPlaylistView,
  onQueueReorder,
  onPlaylistReorder,
}) {
  if (!inNativeShell() || !listEl) return null;

  let dragging = false; // 是否超过阈值进入拖拽态
  let pointerId = null; // 拖拽指针 id（多点触控只跟踪第一个）
  let startX = 0;
  let startY = 0;
  let startScrollTop = 0;
  let sourceEl = null; // 被拖行
  let sourceIndex = -1; // 被拖行在 DOM 中的索引（拖拽期间 DOM 不重排，稳定）
  let sourcePath = null; // 被拖歌曲路径（网络歌 null → 不能加歌单，可排序）
  let sourceBaseCenter = 0; // 被拖行起始中心 Y（行跟随指针 = base + clientY 位移）
  let targetIndex = -1; // 当前插入索引（-1 = 无目标）
  let hoverPlaylistEl = null; // 当前悬停的歌单项（sb-drop 高亮）

  const rows = () => [...listEl.querySelectorAll(".pl-item")];

  // 行中心交叉模型算插入索引：被拖行中心（跟随指针）越过某行中心 → 插到该行之后。
  // 语义与 SortableJS onEnd 的 newIndex 一致（移除源行后的位置）；其他行 rect 每次重取，
  // 列表滚动时中心随内容移动，天然正确。
  function computeTarget(clientY) {
    const dc = sourceBaseCenter + (clientY - startY);
    let t = 0;
    for (const row of rows()) {
      if (row === sourceEl) continue;
      const r = row.getBoundingClientRect();
      if (r.top + r.height / 2 < dc) t++;
    }
    return t;
  }

  // 指针是否在列表容器内（几何命中；rect 随滚动变化）
  function insideList(x, y) {
    const r = listEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  // 几何命中侧边栏歌单项（.sb-item[data-playlist-id]；Sidebar 未挂载时无目标）
  function hitSidebarItem(x, y) {
    for (const el of document.querySelectorAll(".sb-item[data-playlist-id]")) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
    }
    return null;
  }

  // 插入位置指示线：按移除源行后的插入索引 t 反推当前 DOM 行（哪一行前/后）
  function applyIndicator(t) {
    clearIndicator();
    if (t < 0) return;
    const all = rows();
    const n = all.length;
    let rowIdx;
    let side = "after";
    if (t === 0) {
      rowIdx = 0;
      side = "before";
    } else if (t > sourceIndex) {
      rowIdx = Math.min(t, n - 1);
    } else {
      rowIdx = t - 1; // t ≤ sourceIndex：插到 t-1 行后（t === sourceIndex 即回到原位）
    }
    const row = all[rowIdx];
    if (row) row.classList.add(side === "before" ? "pl-drop-before" : "pl-drop-after");
  }

  function clearIndicator() {
    listEl.querySelectorAll(".pl-drop-before, .pl-drop-after").forEach((el) => {
      el.classList.remove("pl-drop-before", "pl-drop-after");
    });
  }

  function setHover(el) {
    if (hoverPlaylistEl === el) return;
    hoverPlaylistEl?.classList.remove("sb-drop");
    hoverPlaylistEl = el;
    hoverPlaylistEl?.classList.add("sb-drop");
  }

  function onPointerDown(e) {
    if (e.button !== 0) return; // 只跟左键（右键是壳菜单）
    if (!getCanDrag()) return;
    const handle = e.target?.closest?.(".pl-drag");
    if (!handle) return;
    const el = handle.closest(".pl-item");
    if (!el) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startScrollTop = listEl.scrollTop || 0;
    sourceEl = el;
    sourceIndex = rows().indexOf(el);
    sourcePath = el.dataset.path ?? null;
    const r = el.getBoundingClientRect();
    sourceBaseCenter = r.top + r.height / 2;
    dragging = false;
    targetIndex = -1;
    hoverPlaylistEl = null;
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("selectstart", onSelectStart, true);
  }

  function onPointerMove(e) {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragging = true;
      sourceEl.classList.add("pl-drag-source");
    }
    // 行跟随指针（仅纵向；扣掉滚动量，列表滚动时行仍贴住指针）
    sourceEl.style.transform = `translateY(${dy - (listEl.scrollTop - startScrollTop)}px)`;
    const sb = hitSidebarItem(e.clientX, e.clientY);
    setHover(sb);
    if (sb) {
      targetIndex = -1; // 歌单悬停：列表内不显示排序指示
    } else if (insideList(e.clientX, e.clientY)) {
      targetIndex = computeTarget(e.clientY);
    } else {
      targetIndex = -1;
    }
    applyIndicator(targetIndex);
  }

  function onPointerUp(e) {
    if (e.pointerId !== pointerId) return;
    const wasDragging = dragging;
    const hover = hoverPlaylistEl;
    const t = targetIndex;
    cleanup();
    if (!wasDragging) return; // 未过阈值 = 单击，不拦截 click（行点击播放照常）
    suppressNextClick(); // 拖拽后的 click 吞掉，防松手落在行上误触发行点击播放
    if (hover && sourcePath != null) {
      // 拖到侧栏歌单：派发给 Sidebar（幂等 + toast 与浏览器 drop 完全一致）
      const pid = hover.getAttribute("data-playlist-id");
      if (pid) {
        window.dispatchEvent(
          new CustomEvent("qqplayer:shell-drag-drop", { detail: { id: pid, path: sourcePath } }),
        );
      }
      return;
    }
    if (t < 0 || t === sourceIndex) return; // 没挪动（含拖出列表外松手）
    if (isPlaylistView()) {
      // 歌单视图：DOM 路径顺序（= 原顺序，拖拽中不重排）移除源行后插到目标位 → setPlaylistOrder
      const paths = rows()
        .map((el) => el.dataset.path)
        .filter((p) => p != null);
      const idx = paths.indexOf(sourcePath);
      if (idx >= 0 && sourcePath != null) {
        paths.splice(idx, 1);
        paths.splice(t, 0, sourcePath);
        onPlaylistReorder(paths);
      }
    } else {
      onQueueReorder(sourceIndex, t);
    }
  }

  function onPointerCancel(e) {
    if (e.pointerId !== pointerId) return;
    cleanup(); // 指针丢失（出窗口/系统打断）：不做任何动作
  }

  function onSelectStart(e) {
    e.preventDefault(); // 拖拽中禁止文本选中
  }

  // 拖拽结束后的 click 会被浏览器照常派发（pointer 拖拽不抑制兼容鼠标事件），
  // 吞掉一次；若环境未派发 click，超时兜底移除，不吞后续无关点击
  let clickCapture = null;
  function suppressNextClick() {
    let done = false;
    const onCapture = (ev) => {
      done = true;
      ev.preventDefault();
      ev.stopPropagation();
      window.removeEventListener("click", onCapture, true);
      clickCapture = null;
    };
    clickCapture = onCapture;
    window.addEventListener("click", onCapture, true);
    setTimeout(() => {
      if (!done && clickCapture === onCapture) {
        window.removeEventListener("click", onCapture, true);
        clickCapture = null;
      }
    }, 0);
  }

  function cleanup() {
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
    window.removeEventListener("selectstart", onSelectStart, true);
    if (clickCapture) {
      window.removeEventListener("click", clickCapture, true);
      clickCapture = null;
    }
    if (sourceEl) {
      sourceEl.classList.remove("pl-drag-source");
      sourceEl.style.transform = "";
    }
    clearIndicator();
    setHover(null);
    pointerId = null;
    dragging = false;
    targetIndex = -1;
    sourceEl = null;
  }

  listEl.addEventListener("pointerdown", onPointerDown);
  return cleanup;
}
