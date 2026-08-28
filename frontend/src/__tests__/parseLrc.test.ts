// parseLrcText 过滤规则测试（与后端 parse_lrc 同构）
// 覆盖：空行丢弃 / 信息行（作词作曲等元信息）丢弃 / 超短行丢弃 /
// 保守性（关键词开头但无分隔的正常歌词不误杀）/ 空行导致的时长空洞被跳过。
import { describe, expect, it } from "vitest";
import { parseLrcText } from "../utils/parseLrc.js";
import type { LyricLine } from "../composables/playerState.js";

// parseLrcText 静态返回 LyricLine[]（联合含 sec 章节行），但本模块只产出 line 行；
// 测试断言 s/e/text 属于 line 变体，此处收窄类型（运行时不变）。
type TimedLine = Extract<LyricLine, { type: "line" }>;
function parse(text: string): TimedLine[] {
  return parseLrcText(text) as TimedLine[];
}

function texts(lines: TimedLine[]): string[] {
  return lines.map((ln) => ln.text[0]);
}

describe("parseLrcText 过滤规则（与后端 parse_lrc 同构）", () => {
  it("基本信息行时间轴解析", () => {
    const lines = parse("[00:10.00]第一句\n[00:20.50]第二句\n[00:30.25]第三句\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].s).toBe(10.0);
    expect(lines[1].s).toBe(20.5);
    expect(lines[2].e).toBe(35.25); // 末行默认 +5s
  });

  it("丢弃信息行（作词/作曲等，全角/半角冒号、可带可不带冒号）", () => {
    const lines = parse(
      "[00:01.00]作词：姚谦\n" +
        "[00:02.00]作曲 李宗盛\n" +
        "[00:03.00]编曲:李荣浩\n" +
        "[00:04.00]制作人：陈奕迅\n" +
        "[00:05.00]原唱：周杰伦\n" +
        "[00:06.00]第一句歌词\n" +
        "[00:07.00]第二句\n",
    );
    expect(texts(lines)).toEqual(["第一句歌词", "第二句"]);
  });

  it("丢弃空行，前一行句末跳过空洞接到下一句（くるみ 30s 空行场景）", () => {
    const lines = parse("[00:10.00]第一句\n[00:20.00]\n[00:50.00]第二句\n");
    expect(texts(lines)).toEqual(["第一句", "第二句"]);
    expect(lines[0].e).toBe(50.0); // 空洞被跳过，不再产生 0.3s 怪行
  });

  it("丢弃超短行（duration < 0.3s 且文本 <= 2 字残留碎片，Pretender 0.13s 空行场景）", () => {
    const lines = parse("[00:10.00]第一句\n[00:10.13].\n[00:10.25]~\n[00:10.40]第二句\n");
    expect(texts(lines)).toEqual(["第一句", "第二句"]);
  });

  it("超短但文本 > 2 字的不算碎片，保留（保守规则）", () => {
    const lines = parse("[00:10.00]第一句\n[00:10.20]啊哈哈\n[00:20.00]第二句\n");
    expect(texts(lines)).toEqual(["第一句", "啊哈哈", "第二句"]);
  });

  it("保守性：关键词开头但后面直接粘着字的正常歌词不误杀", () => {
    const lines = parse(
      "[00:01.00]词不达意\n[00:02.00]曲终人散\n[00:03.00]唱吧\n[00:04.00]录音棚里写歌\n",
    );
    expect(texts(lines)).toEqual(["词不达意", "曲终人散", "唱吧", "录音棚里写歌"]);
  });

  it("同一行多时间戳仍展开为多行，过滤同样生效", () => {
    const lines = parse("[00:01.00][00:05.00]一句歌词\n[00:03.00]作词：某人\n[00:06.00]另一句\n");
    expect(texts(lines)).toEqual(["一句歌词", "一句歌词", "另一句"]);
  });
});
