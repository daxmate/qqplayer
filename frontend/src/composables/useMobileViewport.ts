import { ref } from "vue";

// 移动端断点：<1024px = 移动布局；≥1024px = 桌面三栏
// 与 CSS 的 @media (max-width: 1023.98px) 保持一致（1024px 整数边界归桌面，避免亚像素差）
const MOBILE_MQ: string = "(max-width: 1023.98px)";

// 是否处于移动布局（响应式，随视口变化自动切换）
// 测试/无 window 环境默认 false（桌面布局，与旧行为一致）
export const isMobile = ref<boolean>(false);

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mq = window.matchMedia(MOBILE_MQ);
  isMobile.value = mq.matches;
  const onChange = (e: MediaQueryListEvent) => {
    isMobile.value = e.matches;
  };
  mq.addEventListener?.("change", onChange);
  // 兼容旧 Safari（removeEventListener 形式监听）
  if (!mq.addEventListener) mq.addListener?.(onChange);
}
