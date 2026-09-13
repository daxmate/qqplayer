// coverResolutionContract.test.js —— 封面解析收敛契约测试（契约 docs/cover-resolution.md）
//
// 三组断言：
//   1. 静态扫描（防裸调）：components/** 与 composables/* 不允许出现手写 path→/api/cover
//      映射（`resolveServerUrl("/api/cover…")` 或裸 `"/api/cover?path=…"`），
//      白名单 = 唯一入口 useCoverURL.ts
//      + 锁屏/媒体键元数据域 mediaSession.ts（契约消费点 #6）。
//      注释剥离后扫描（注释里的契约说明/示例不参与匹配；字符串里的 URL 保留参与匹配）。
//   2. 消费点接入断言：MobilePlayer.vue / Cover.vue / TagEditorModal.vue 必须 import 并调用
//      useCoverURL（新消费点一律走唯一入口，禁止手写）。
//   3. 行为断言（mock sync/apiClient 层）：
//      - 恢复在线重试：错误标记 → onOfflineChange(false) 后清空已解析结果并触发调用方重新 resolve，
//        最终有值（契约新增：恢复后自动补齐，不等切歌）。
//      - 桌面直出回归：非壳环境 resolveCover 同步返回远程 URL（行为零变化）。
import { describe, expect, it, beforeEach, vi } from "vitest";

// 项目未装 @types/node（tsconfig types 仅 ["vite/client"]）→ node: 内置模块以非常量
// specifier 动态导入（TS 不对非常量 specifier 做模块解析）；运行时由 vitest/node 提供，
// 与静态 import 行为一致。引入 @types/node 后可换回静态 import。
const nodeFS = "node:fs";
const { readFileSync, readdirSync, statSync } = (await import(nodeFS)) as unknown as {
  readFileSync(path: string, encoding: string): string;
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean };
};
const nodeURL = "node:url";
const { fileURLToPath } = (await import(nodeURL)) as unknown as {
  fileURLToPath(url: string | URL): string;
};
const nodePath = "node:path";
const path = (await import(nodePath)) as unknown as {
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
  dirname(path: string): string;
};

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(testDir, "..");

// ================= 静态扫描 =================

/** 递归收集目录下 .vue/.js/.ts 文件 */
function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) collectFiles(p, acc);
    else if (/\.(vue|js|ts)$/.test(name)) acc.push(p);
  }
  return acc;
}

/** 剥离注释（行/块），字符串内容保留（URL 里的 // 不当注释；"/api/cover" 字面量参与匹配） */
function stripComments(code: string): string {
  let out = "";
  let inLine = false;
  let inBlock = false;
  let quote = null; // '"' | "'" | '`'
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (quote) {
      out += c;
      if (c === "\\") {
        if (next) {
          out += next;
          i += 1;
        }
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// 白名单（绝对路径）：唯一入口 + 锁屏/媒体键元数据域
const BARE_CALL_WHITELIST = new Set([
  path.join(srcDir, "composables", "useCoverURL.ts"), // 唯一入口自身（契约）
  path.join(srcDir, "composables", "mediaSession.ts"), // 锁屏/媒体键元数据（自有 URL 构造；iOS 壳退役后 #6 决策链已删）
]);

describe("coverResolutionContract：禁止手写 path→/api/cover 映射（防裸调）", () => {
  const files = [
    ...collectFiles(path.join(srcDir, "components")),
    ...collectFiles(path.join(srcDir, "composables")),
  ].filter((f) => !BARE_CALL_WHITELIST.has(f));

  it('components/composables 无裸 resolveServerUrl("/api/cover…") 调用', () => {
    const offenders = files.filter((f) =>
      /resolveServerUrl\s*\(\s*["'`]\s*\/api\/cover/.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(offenders).toEqual([]);
  });

  it('components/composables 无手写 "/api/cover?path=…" 映射', () => {
    const offenders = files.filter((f) =>
      /\/api\/cover\?path=/.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(offenders).toEqual([]);
  });
});

describe("coverResolutionContract：消费点必须接入 useCoverURL", () => {
  const consumers = [
    {
      file: path.join(srcDir, "components", "mobile", "MobilePlayer.vue"),
      label: "MobilePlayer.vue（播放页大封面 + 毛玻璃背景）",
    },
    {
      file: path.join(srcDir, "components", "Cover.vue"),
      label: "Cover.vue（桌面封面组件）",
    },
    {
      file: path.join(srcDir, "components", "TagEditorModal.vue"),
      label: "TagEditorModal.vue（标签编辑弹窗封面预览）",
    },
  ];

  for (const { file, label } of consumers) {
    it(`${label} import 并调用 useCoverURL`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toMatch(
        /import\s*\{[^}]*\buseCoverURL\b[^}]*\}\s*from\s*["'][^"']*composables\/useCoverURL\.js["']/,
      );
      expect(src).toMatch(/useCoverURL\s*\(/);
    });
  }
});

// ================= 行为断言（mock sync/apiClient 层） =================

// ---------- mock：apiClient（isOffline/onOfflineChange 可控 + resolveServerUrl 桌面式实现） ----------
const apiMock = vi.hoisted(() => {
  const listeners = new Set<(offline: boolean) => void>();
  const state = { offline: false };
  return {
    state,
    listeners,
    setOffline(v: boolean) {
      state.offline = v;
      for (const cb of [...listeners]) cb(v);
    },
    isOffline: () => state.offline,
    onOfflineChange: (cb: (offline: boolean) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    resolveServerUrl: (p: string) =>
      /^https?:\/\//i.test(p) ? p : "http://192.168.1.50:17627" + (p.startsWith("/") ? p : "/" + p),
  };
});

vi.mock("../utils/apiClient.js", () => apiMock);

import { useCoverURL } from "../composables/useCoverURL.js";

const PATH = "/Music/offline-song.mp3";
const REMOTE = "http://192.168.1.50:17627/api/cover?path=" + encodeURIComponent(PATH);

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("coverResolutionContract：useCoverURL 行为", () => {
  beforeEach(() => {
    apiMock.state.offline = false;
    apiMock.listeners.clear();
  });

  it("桌面/非壳：resolveCover 同步远程直出（行为零变化回归）", () => {
    const { coverSrc, resolveCover, dispose } = useCoverURL();
    resolveCover(PATH);
    expect(coverSrc(PATH)).toBe(REMOTE); // 同步可渲染
    dispose();
  });

  it("恢复在线重试：错误标记 → onOfflineChange(false) 清空并触发调用方重新 resolve", async () => {
    let refreshed = 0;
    const { coverSrc, coverOk, markCoverError, resolveCover, dispose } = useCoverURL({
      onOnlineRefresh: () => {
        refreshed += 1;
        resolveCover(PATH); // 调用方对「当前歌曲」重新 resolve
      },
    });
    resolveCover(PATH);
    expect(coverSrc(PATH)).toBe(REMOTE); // 远程直出（加载失败由 @error → markCoverError 处理）
    markCoverError(PATH);
    expect(coverOk(PATH)).toBe(false); // 失败标记
    apiMock.setOffline(true);
    await flush();
    apiMock.setOffline(false); // 恢复在线：清空已解析结果 + 错误标记，触发 onOnlineRefresh
    await flush();
    expect(refreshed).toBe(1);
    expect(coverOk(PATH)).toBe(true); // 错误标记已清
    expect(coverSrc(PATH)).toBe(REMOTE); // 重新解析最终有值（不等切歌）
    dispose();
  });

  it("恢复在线重试：调用方未传 onOnlineRefresh 时只清空状态不抛错", async () => {
    const { coverSrc, markCoverError, resolveCover, dispose } = useCoverURL();
    resolveCover(PATH);
    markCoverError(PATH);
    apiMock.setOffline(true);
    await flush();
    apiMock.setOffline(false); // 无 onOnlineRefresh → 清空后无动作，不抛
    await flush();
    expect(coverSrc(PATH)).toBe(""); // 状态已清空（等调用方重新 resolve）
    dispose();
  });
});
