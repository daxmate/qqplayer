// coverResolutionContract.test.js —— 封面解析收敛契约测试（契约 docs/cover-resolution.md）
//
// 三组断言：
//   1. 静态扫描（防裸调）：components/** 与 composables/* 不允许出现手写 path→/api/cover
//      映射（`resolveServerUrl("/api/cover…")` 或裸 `"/api/cover?path=…"`），
//      白名单 = 唯一入口 useCoverURL.js + 原生桥 nativeAudioBridge.ts（resolveCoverURL）
//      + 锁屏/媒体键元数据域 mediaSession.ts（契约消费点 #6，resolveCoverForMetadata 自有兑底链）。
//      注释剥离后扫描（注释里的契约说明/示例不参与匹配；字符串里的 URL 保留参与匹配）。
//   2. 消费点接入断言：MobilePlayer.vue / Cover.vue / TagEditorModal.vue 必须 import 并调用
//      useCoverURL（新消费点一律走唯一入口，禁止手写）。
//   3. 行为断言（mock sync/apiClient 层）：
//      - 恢复在线重试：断网解析为空 + 错误标记 → onOfflineChange(false) 后清空并重新 resolve，
//        最终有值（契约新增：恢复后自动补齐，不等切歌）。
//      - 桌面直出回归：非壳环境 resolveCover 同步返回远程 URL（行为零变化）。
import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(testDir, "..");

// ================= 静态扫描 =================

/** 递归收集目录下 .vue/.js/.ts 文件 */
function collectFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) collectFiles(p, acc);
    else if (/\.(vue|js|ts)$/.test(name)) acc.push(p);
  }
  return acc;
}

/** 剥离注释（行/块），字符串内容保留（URL 里的 // 不当注释；"/api/cover" 字面量参与匹配） */
function stripComments(code) {
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

// 白名单（绝对路径）：唯一入口 + 原生桥 + 锁屏/媒体键元数据域
const BARE_CALL_WHITELIST = new Set([
  path.join(srcDir, "composables", "useCoverURL.js"), // 唯一入口自身（契约）
  path.join(srcDir, "composables", "nativeAudioBridge.ts"), // 原生桥 resolveCoverURL（契约白名单）
  path.join(srcDir, "composables", "mediaSession.ts"), // 锁屏/媒体键元数据（契约消费点 #6 自有兑底链）
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
  const listeners = new Set();
  const state = { offline: false };
  return {
    state,
    listeners,
    setOffline(v) {
      state.offline = v;
      for (const cb of [...listeners]) cb(v);
    },
    isOffline: () => state.offline,
    onOfflineChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    resolveServerUrl: (p) =>
      /^https?:\/\//i.test(p) ? p : "http://192.168.1.50:17627" + (p.startsWith("/") ? p : "/" + p),
  };
});

vi.mock("../utils/apiClient.js", () => apiMock);

// ---------- mock：sync 层（无本地缓存/无内嵌；syncEnabled 可控） ----------
const syncMock = vi.hoisted(() => ({
  enabled: false,
  cachedCoverURL: vi.fn(() => Promise.resolve(null)), // covers 缓存未命中
  cacheCover: vi.fn(),
  getEmbeddedCover: vi.fn(() => Promise.resolve(null)), // 无内嵌 APIC
  assetForSong: vi.fn(() => Promise.resolve(null)),
  syncEnabled: () => syncMock.enabled,
}));

vi.mock("../utils/sync.js", () => syncMock);

import { useCoverURL } from "../composables/useCoverURL.js";

const PATH = "/Music/offline-song.mp3";
const REMOTE = "http://192.168.1.50:17627/api/cover?path=" + encodeURIComponent(PATH);

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("coverResolutionContract：useCoverURL 行为", () => {
  beforeEach(() => {
    syncMock.enabled = false;
    apiMock.state.offline = false;
    apiMock.listeners.clear();
    syncMock.cachedCoverURL.mockClear();
    syncMock.cacheCover.mockClear();
    syncMock.getEmbeddedCover.mockClear();
    syncMock.assetForSong.mockClear();
  });

  it("桌面/非壳：resolveCover 同步远程直出（行为零变化回归）", () => {
    const { coverSrc, resolveCover, dispose } = useCoverURL();
    resolveCover(PATH);
    expect(coverSrc(PATH)).toBe(REMOTE); // 同步可渲染
    expect(syncMock.cachedCoverURL).not.toHaveBeenCalled(); // 非壳不查本地
    dispose();
  });

  it("恢复在线重试：断网解析为空 + 错误标记 → onOfflineChange(false) 后清空并重新 resolve 有值", async () => {
    syncMock.enabled = true;
    apiMock.setOffline(true);
    let refreshed = 0;
    const { coverSrc, coverOk, markCoverError, resolveCover, dispose } = useCoverURL({
      onOnlineRefresh: () => {
        refreshed += 1;
        resolveCover(PATH, { download: true }); // 调用方对「当前歌曲」重新 resolve
      },
    });
    // 断网 + 无本地缓存 + 无内嵌 → 解析为空（保持空、不请求主机）
    resolveCover(PATH, { download: true });
    await flush();
    expect(coverSrc(PATH)).toBe("");
    expect(syncMock.cacheCover).not.toHaveBeenCalled(); // 断网不后台缓存
    markCoverError(PATH);
    expect(coverOk(PATH)).toBe(false); // 失败标记
    // 恢复在线：清空已解析结果 + 错误标记，触发 onOnlineRefresh 重新 resolve
    apiMock.setOffline(false);
    await flush();
    expect(refreshed).toBe(1);
    expect(coverOk(PATH)).toBe(true); // 错误标记已清
    expect(coverSrc(PATH)).toBe(REMOTE); // 重新解析最终有值（不等切歌）
    dispose();
  });

  it("恢复在线重试：调用方未传 onOnlineRefresh 时只清空状态不抛错", async () => {
    syncMock.enabled = true;
    apiMock.setOffline(true);
    const { coverSrc, resolveCover, dispose } = useCoverURL();
    resolveCover(PATH);
    await flush();
    expect(coverSrc(PATH)).toBe("");
    apiMock.setOffline(false); // 无 onOnlineRefresh → 清空后无动作，不抛
    await flush();
    dispose();
  });
});
