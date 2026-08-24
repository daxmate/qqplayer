// 下拉召唤顶部状态条（iOS 壳专用）
//
// 背景：iOS 壳顶部「已连接」状态条是原生浮层，平时完全隐藏（不占视觉、不与页面风格冲突），
// 用户在页面顶部下拉时才浮现（3s 后由原生自动收回）。页面滚动是内层 div（overflow-y:auto），
// 原生 WKWebView 收不到滚动事件，所以由前端检测触摸手势：
//   触摸起点在可滚动容器内 + 该容器在顶部（scrollTop<=0）+ 下拉位移超过阈值
//   → postMessage({cmd:"pullRevealStatusBar"}) 通知原生显示浮层。
// 仅 iOS 壳（window.qqplayerIosBridge 存在）安装；其他环境 no-op 零影响。

const REVEAL_THRESHOLD = 40; // 下拉触发位移（px），对齐系统下拉刷新手感

let touchStartY = null;
let scroller = null; // touchstart 时缓存的滚动容器（同一手势内 target 稳定）
let revealed = false;
let installed = false; // 幂等：重复 install 不叠加监听

/// 最近的可滚动祖先（overflow-y: auto/scroll/overlay），找不到则回退到页面滚动元素。
/// 只判断 overflow 样式——移动端滚动容器固定且内容超高，scrollHeight/clientHeight
/// 在测试环境（jsdom）不可靠，这里不依赖它。
function scrollableAncestor(el) {
  let node = el && el.nodeType === 1 ? el : null;
  while (node && node !== document.body && node !== document.documentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node;
    node = node.parentElement;
  }
  return document.scrollingElement;
}

function onTouchStart(e) {
  const t = e.touches && e.touches[0];
  if (!t) return;
  touchStartY = t.clientY;
  scroller = scrollableAncestor(e.target);
  revealed = false;
}

function onTouchMove(e) {
  if (touchStartY == null || revealed || !scroller) return;
  // 滚动容器不在顶部（已滚出内容）→ 本次手势作废，不再触发
  if (scroller.scrollTop > 0) {
    touchStartY = null;
    return;
  }
  const t = e.touches && e.touches[0];
  if (!t) return;
  const dy = t.clientY - touchStartY; // 下拉为正
  if (dy > REVEAL_THRESHOLD) {
    revealed = true;
    try {
      window.qqplayerIosBridge.postMessage({ cmd: "pullRevealStatusBar" });
    } catch {
      /* 桥异常静默（浏览器控制台测试环境无此对象） */
    }
  }
}

function onTouchEnd() {
  touchStartY = null;
  scroller = null;
}

/// 安装全局下拉监听（幂等）。返回卸载函数（壳内页面常驻，实际很少调用）。
export function installPullRevealStatusBar() {
  if (typeof window === "undefined" || !window.qqplayerIosBridge || installed) return () => {};
  installed = true;
  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: true });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  return () => {
    installed = false;
    document.removeEventListener("touchstart", onTouchStart);
    document.removeEventListener("touchmove", onTouchMove);
    document.removeEventListener("touchend", onTouchEnd);
  };
}
