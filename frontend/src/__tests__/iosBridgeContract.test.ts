// iosBridgeContract.test.js —— iOS 壳双端桥契约测试（前端侧）
//
// 单一事实源：docs/ios-bridge-contract.json（仓库根；本文件向上定位）。
// 扫描 frontend/src 源码里的桥消息字面量，与契约双向覆盖：
//   F1 前端发出的每个 cmd ∈ 契约 webCmd（前端有契约没有 → 红，提示补契约）
//   F2 契约 webCmd 中 sender 标注为前端文件的每个 ∈ 该文件实际发出集合
//     （契约有前端没发 → 红，提示删/核实）
//   F3 前端订阅/消费的每个 event ∈ 契约 nativeEvent
//   F4 契约 nativeEvent 中没有前端消费者的 ∈ 显式白名单（当前 error 事件壳发前端不消费）
//
// 扫描要点：
//   - cmd 字面量提取前先剥离注释与字符串状态机（注释里的契约示例/说明不参与匹配；
//     "cmd:" 出现在 URL 字符串里也不误报）；远端命令 payload.cmd（play/pause/toggle/
//     next/prev/seekto）不是桥命令（是 remoteCommand 事件 payload 值），格式上无
//     `cmd: "xxx"` 字面量，天然排除
//   - 事件消费 = onNativeEvent("xxx") 订阅点 + nativeAudioBridge.js installNativeEventSink
//     的 case "xxx" 分发分支
//   - 兼容 .js/.ts/.vue；__tests__ 目录排除（测试桩里的 cmd 不是前端发出点）
import { describe, expect, it } from "vitest";

// 项目未装 @types/node（tsconfig types 仅 ["vite/client"]）→ node: 内置模块以非常量
// specifier 动态导入（TS 不对非常量 specifier 做模块解析）；运行时由 vitest/node 提供，
// 与静态 import 行为一致。引入 @types/node 后可换回静态 import。
const nodeFS = "node:fs";
const { existsSync, readFileSync, readdirSync } = (await import(nodeFS)) as unknown as {
  existsSync(path: string): boolean;
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
  basename(path: string, suffix?: string): string;
};

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(testDir, "..");

/** 向上定位仓库根 docs/ios-bridge-contract.json（本地/CI 路径一致） */
function findContractPath() {
  let dir = testDir;
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, "docs", "ios-bridge-contract.json");
    if (existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  throw new Error(
    `找不到 docs/ios-bridge-contract.json（从 ${testDir} 向上找了 5 层）；请先确认契约文件存在`,
  );
}

interface BridgeContractDoc {
  webCmd: Array<{ name: string; sender?: string }>;
  nativeEvent: Array<{ name: string }>;
}
const contract = JSON.parse(readFileSync(findContractPath(), "utf8")) as BridgeContractDoc;
const contractCmds = new Set(contract.webCmd.map((c) => c.name));
const contractEvents = new Set(contract.nativeEvent.map((e) => e.name));

/** 剥离注释/字符串后保留代码文本：cmd: "xxx" 只认真实代码字面量 */
function stripCommentsAndStrings(code: string): string {
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
      // 字符串内容原样保留（cmd 的引号值要参与匹配）；转义字符整体跳过
      if (c === "\\") {
        out += c;
        if (next) {
          out += next;
          i += 1;
        }
        i += 1;
        continue;
      }
      out += c;
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

/** 递归收集 src 下（排除 __tests__）的 .js/.ts/.vue 文件 */
function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__") continue;
      walkSourceFiles(p, out);
    } else if (e.name.endsWith(".js") || e.name.endsWith(".ts") || e.name.endsWith(".vue")) {
      out.push(p);
    }
  }
  return out;
}

/** 每文件 cmd 字面量集合（file basename → Set<cmd>） */
function collectSentCmdsByFile(): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const f of walkSourceFiles(srcDir)) {
    const clean = stripCommentsAndStrings(readFileSync(f, "utf8"));
    const set = new Set<string>();
    const re = /cmd\s*:\s*"([a-zA-Z][a-zA-Z0-9]*)"/g;
    for (const m of clean.matchAll(re)) set.add(m[1]);
    if (set.size) byFile.set(path.basename(f), set);
  }
  return byFile;
}

/** 前端事件消费集合：onNativeEvent 订阅 + nativeAudioBridge 分发 case */
function collectConsumedEvents(): Set<string> {
  const consumed = new Set<string>();
  for (const f of walkSourceFiles(srcDir)) {
    const clean = stripCommentsAndStrings(readFileSync(f, "utf8"));
    const base = path.basename(f);
    const subRe = /onNativeEvent\(\s*"([a-zA-Z][a-zA-Z0-9]*)"/g;
    for (const m of clean.matchAll(subRe)) consumed.add(m[1]);
    if (base === "nativeAudioBridge.js" || base === "nativeAudioBridge.ts") {
      const caseRe = /case\s+"([a-zA-Z][a-zA-Z0-9]*)":/g;
      for (const m of clean.matchAll(caseRe)) consumed.add(m[1]);
    }
  }
  return consumed;
}

const sentByFile = collectSentCmdsByFile();
const sentCmds = new Set([...sentByFile.values()].flatMap((s) => [...s]));
const consumedEvents = collectConsumedEvents();

describe("iOS 桥契约（前端侧，docs/ios-bridge-contract.json）", () => {
  it("契约 JSON 结构完整（webCmd/nativeEvent 非空）", () => {
    expect(contractCmds.size).toBeGreaterThan(0);
    expect(contractEvents.size).toBeGreaterThan(0);
  });

  it("F1：前端源码发出的每个 cmd 都在契约 webCmd 里", () => {
    const missing = [...sentCmds].filter((c) => !contractCmds.has(c));
    expect(missing).toEqual([]);
  });

  it("F2：契约 webCmd 中 sender 标注的每个前端文件确实发出了对应 cmd", () => {
    // 后缀无关匹配：sender 写 .js 但文件已转 .ts 时仍能对上（去扩展名比较）
    const norm = (n: string) => n.replace(/\.(js|ts|vue)$/, "");
    const problems = [];
    for (const entry of contract.webCmd) {
      const sender = entry.sender;
      if (!sender) continue; // shellOnly（前端无发送方），不校验
      const fileSet = [...sentByFile.entries()].find(([k]) => norm(k) === norm(sender))?.[1];
      if (!fileSet) {
        problems.push(`契约 sender=${sender}（cmd ${entry.name}）不在前端扫描文件里`);
      } else if (!fileSet.has(entry.name)) {
        problems.push(`契约 cmd ${entry.name} 标注 sender=${sender}，但该文件没有发出它`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("F3：前端订阅/消费的每个 event 都在契约 nativeEvent 里", () => {
    const missing = [...consumedEvents].filter((e) => !contractEvents.has(e));
    expect(missing).toEqual([]);
  });

  it("F4：契约 nativeEvent 中无前端消费者的事件 ∈ 显式白名单", () => {
    // 白名单：error —— 壳 item load 失败推送，前端目前不消费（契约已注明）
    const KNOWN_UNCONSUMED = ["error"];
    const unconsumed = [...contractEvents].filter((e) => !consumedEvents.has(e));
    const unexpected = unconsumed.filter((e) => !KNOWN_UNCONSUMED.includes(e));
    expect(unexpected).toEqual([]);
  });
});
