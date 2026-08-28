// 紧凑模式 CSS 契约测试（任务 H2 回归防护）
// 背景：style.css 的 html[data-compact="true"] 规则曾大量使用已改名的旧类名
// （.song-row/.artist-grid/.playlist-header/.nav-item 等），规则全部打空 →
// 用户开紧凑模式界面无变化。本测试保证：紧凑规则里出现的每个类名都必须是
// 当前代码库（.vue 文件）中真实存在的类；黑名单旧类名一旦回退即失败。
import { describe, expect, it } from "vitest";

// 项目未装 @types/node（tsconfig types 仅 ["vite/client"]）→ node: 内置模块以非常量
// specifier 动态导入（TS 不对非常量 specifier 做模块解析）；运行时由 vitest/node 提供，
// 与静态 import 行为一致。引入 @types/node 后可换回静态 import。
const nodeFS = "node:fs";
const { readFileSync, readdirSync } = (await import(nodeFS)) as unknown as {
  readFileSync(path: string, encoding: string): string;
  readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean }>;
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

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const styleCss = readFileSync(path.join(srcDir, "style.css"), "utf8");

// 紧凑模式区块：从注释头到文件尾
const compactSection = styleCss.slice(styleCss.indexOf('紧凑模式（html[data-compact="true"]）'));

// 抽取紧凑规则中使用的所有类名（html[data-compact="true"] 之后的 .xxx）
function collectClassNames(css: string) {
  const names = new Set<string>();
  const re = /html\[data-compact="true"\]\s+([^{]+)\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    for (const cls of m[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      names.add(cls[1]);
    }
  }
  return names;
}

// 代码库中真实存在的类名集合（所有 .vue 文件的 class 属性 + scoped 样式类名）
function collectLiveClassNames() {
  const live = new Set<string>();
  const files: string[] = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".vue")) files.push(p);
    }
  })(srcDir);
  for (const f of files) {
    const content = readFileSync(f, "utf8");
    // 模板 class="..." / :class 字符串里的类名
    for (const cls of content.matchAll(/class="([^"]+)"/g)) {
      for (const c of cls[1].split(/\s+/)) {
        if (/^[a-zA-Z][\w-]*$/.test(c)) live.add(c);
      }
    }
    // scoped 样式选择器里的类名
    for (const cls of content.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      live.add(cls[1]);
    }
  }
  return live;
}

// 已确认失效的旧类名（组件改名前的残留；出现在紧凑规则中即失败）
const DEAD_CLASSES = [
  "song-row",
  "song-cover",
  "row-cover",
  "playlist-header",
  "group-header",
  "nav-item",
  "artist-grid",
  "album-grid",
  "artist-card",
  "album-card",
];

describe("紧凑模式 CSS（style.css html[data-compact]）", () => {
  const compactClasses = collectClassNames(compactSection);
  const liveClasses = collectLiveClassNames();

  it("紧凑规则引用的类名在组件中都真实存在", () => {
    const missing = [...compactClasses].filter((c) => !liveClasses.has(c));
    expect(missing).toEqual([]);
  });

  it("不引用已失效的旧类名", () => {
    const dead = [...compactClasses].filter((c) => DEAD_CLASSES.includes(c));
    expect(dead).toEqual([]);
  });

  it("覆盖主要密度区域（列表行/侧边栏/网格卡片/顶栏/控制区）", () => {
    for (const c of ["pl-item", "sb-item", "gr-card", "pl-grid", "topbar", "controls"]) {
      expect(compactClasses.has(c), `缺少紧凑规则：${c}`).toBe(true);
    }
  });
});
