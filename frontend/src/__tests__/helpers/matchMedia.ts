// matchMedia mock helper（移动端断点测试基础设施）
//
// 用法（必须在 import 被测模块【前】调用，因为 useMobileViewport 在模块加载时
// 就读取 matchMedia 并注册 change 监听）：
//
//   import { installMatchMedia } from "./helpers/matchMedia.js";
//   const mq = installMatchMedia(false);   // 初始桌面布局
//   const App = (await import("../App.vue")).default;  // 之后才能 import
//
// 切换布局：mq.set(true) → 触发 change 事件 → isMobile ref 响应式更新
// （useMobileViewport 兼容 addEventListener / addListener 两种监听方式，helper 两者都支持）

import { vi } from "vitest";

/** change 事件负载（useMobileViewport 传递的是 { matches, media }） */
interface MatchMediaChangeEvent {
  matches: boolean;
  media: string;
}

type MatchMediaListener = (ev: MatchMediaChangeEvent) => void;

/** matchMedia 返回的 MQL 兼容对象（mq 本体 + 每个 query 的派生副本） */
interface MediaQueryListLike {
  readonly matches: boolean;
  media: string;
  addEventListener(ev: string, fn: MatchMediaListener): void;
  removeEventListener(ev: string, fn: MatchMediaListener): void;
  addListener(fn: MatchMediaListener): void;
  removeListener(fn: MatchMediaListener): void;
  dispatchEvent(): boolean;
}

/** installMatchMedia 的返回值：mq 可切换布局，matchMedia/calls 供断言 */
export interface MatchMediaHelper {
  mq: MediaQueryListLike;
  matchMedia: ReturnType<typeof vi.fn>;
  calls: string[];
  set(v: boolean): void;
}

export function installMatchMedia(initialMatches = false): MatchMediaHelper {
  let matches = initialMatches;
  const listeners = new Set<MatchMediaListener>();

  const mq: MediaQueryListLike = {
    get matches() {
      return matches;
    },
    media: "(max-width: 1023.98px)",
    addEventListener(ev, fn) {
      if (ev === "change") listeners.add(fn);
    },
    removeEventListener(ev, fn) {
      if (ev === "change") listeners.delete(fn);
    },
    addListener(fn) {
      listeners.add(fn);
    },
    removeListener(fn) {
      listeners.delete(fn);
    },
    dispatchEvent() {
      return true;
    },
  };

  const calls: string[] = [];
  const matchMedia = vi.fn((query: string) => {
    calls.push(query);
    return {
      ...mq,
      media: query,
    };
  });
  vi.stubGlobal("matchMedia", matchMedia);

  return {
    mq,
    matchMedia,
    calls,
    set(v) {
      matches = v;
      for (const fn of [...listeners]) fn({ matches: v, media: mq.media });
    },
  };
}
