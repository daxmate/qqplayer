// settingsIndex 结构校验 + get/set 行为校验
// 注意：settingsIndex 经 usePlayer（playerCore）模块加载，playerCore 在模块作用域
// `new Audio()` —— 必须在 import 被测模块【前】stub Audio 与 matchMedia。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { installMatchMedia } from "./helpers/matchMedia.js";
import type { SettingEntry } from "../settingsIndex.js";

class FakeAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, (() => void) | undefined> = {};
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);
installMatchMedia();

const { SETTING_CATEGORIES, CATEGORY_KEYS, settingsIndex } = await import("../settingsIndex");
const zhCN = (await import("../locales/zh-CN/index.js")).default;
const {
  state,
  playbackSettings,
  lyricSettings,
  uiSettings,
  desktopLyricSettings,
  downloadSettings,
  videoSettings,
  PLAYBACK_SETTINGS_DEFAULTS,
  LYRIC_SETTINGS_DEFAULTS,
  UI_SETTINGS_DEFAULTS,
  DESKTOP_LYRIC_DEFAULTS,
  DOWNLOAD_SETTINGS_DEFAULTS,
  VIDEO_SETTINGS_DEFAULTS,
} = await import("../composables/usePlayer.js");

const VALID_TYPES = ["toggle", "slider", "select", "text", "custom"];
const VALID_SUBTABS = ["app", "desktop"];

// 语言包 key 解析（点路径逐级下钻）
function resolveKey(pack: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((o, k) => {
    if (o && typeof o === "object") return (o as Record<string, unknown>)[k];
    return undefined;
  }, pack);
}

// 音乐库后端回显 stub（saveLibrarySettings 成功后回写 state.librarySettings）
const LIB_DEFAULTS = {
  audioExts: [".mp3"],
  ignoreHidden: true,
  autoRefresh: true,
  autoScanOnStart: true,
};

beforeEach(() => {
  state.librarySettings = { ...LIB_DEFAULTS };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, opts) => {
      const patch = opts?.body ? JSON.parse(opts.body) : {};
      return { ok: true, json: async () => ({ settings: { ...LIB_DEFAULTS, ...patch } }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settingsIndex 结构", () => {
  it("SETTING_CATEGORIES 为 8 分类且 key 唯一", () => {
    expect(SETTING_CATEGORIES).toHaveLength(8);
    const keys = SETTING_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        "playback",
        "library",
        "video",
        "download",
        "lyric",
        "ui",
        "shortcuts",
        "about",
      ]),
    );
  });

  it("仅 lyric 分类有 subTabs=['app','desktop']", () => {
    for (const c of SETTING_CATEGORIES) {
      if (c.key === "lyric") {
        expect(c.subTabs).toEqual(["app", "desktop"]);
      } else {
        expect(c.subTabs).toBeUndefined();
      }
    }
  });

  it("id 唯一", () => {
    const ids = settingsIndex.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("收录 30+ 项", () => {
    expect(settingsIndex.length).toBeGreaterThanOrEqual(30);
  });

  it("视频分类：bilibiliCookie 为 text 项，get/set 读写 videoSettings，语言包 key 齐全", () => {
    const entry = settingsIndex.find((e) => e.id === "bilibiliCookie")!;
    expect(entry).toBeTruthy();
    expect(entry.category).toBe("video");
    expect(entry.type).toBe("text");
    expect(entry.subTab).toBeNull();
    // get/set 读写 videoSettings.bilibiliCookie
    videoSettings.bilibiliCookie = "SESSDATA=abc";
    expect(entry.get()).toBe("SESSDATA=abc");
    entry.set("SESSDATA=xyz");
    expect(videoSettings.bilibiliCookie).toBe("SESSDATA=xyz");
    // 语言包 key 齐全（labelKey + placeholder）
    expect(resolveKey(zhCN, entry.labelKey)).toBeTruthy();
    expect(resolveKey(zhCN, entry.placeholder!)).toBeTruthy();
  });

  it("category 都在 SETTING_CATEGORIES 内", () => {
    for (const e of settingsIndex) {
      expect(CATEGORY_KEYS, `${e.id} category 非法`).toContain(e.category);
    }
  });

  it("lyric 分类 subTab 为 app|desktop，其余分类 subTab 为 null", () => {
    for (const e of settingsIndex) {
      if (e.category === "lyric") {
        expect(VALID_SUBTABS, `${e.id} subTab 非法`).toContain(e.subTab);
      } else {
        expect(e.subTab, `${e.id} 非 lyric 分类 subTab 必须为 null`).toBeNull();
      }
    }
  });

  it("type 合法", () => {
    for (const e of settingsIndex) {
      expect(VALID_TYPES, `${e.id} type 非法`).toContain(e.type);
    }
  });

  it("keywords 为非空字符串数组", () => {
    for (const e of settingsIndex) {
      expect(Array.isArray(e.keywords), `${e.id} keywords 须为数组`).toBe(true);
      expect(e.keywords.length, `${e.id} keywords 非空`).toBeGreaterThan(0);
      for (const k of e.keywords) {
        expect(typeof k, `${e.id} keyword 须为字符串`).toBe("string");
      }
    }
  });

  it("labelKey 在 zh-CN 语言包存在", () => {
    for (const e of settingsIndex) {
      expect(resolveKey(zhCN, e.labelKey), `${e.id} labelKey ${e.labelKey} 缺失`).toBeTruthy();
    }
  });

  it("select 选项的 labelKey 在语言包存在；slider 有 min/max/step", () => {
    for (const e of settingsIndex) {
      if (e.type === "select") {
        expect(
          Array.isArray(e.options) && e.options.length > 0,
          `${e.id} select 须有 options`,
        ).toBe(true);
        for (const o of e.options) {
          expect(o.value, `${e.id} 选项缺 value`).toBeDefined();
          expect(
            resolveKey(zhCN, o.labelKey),
            `${e.id} 选项 labelKey ${o.labelKey} 缺失`,
          ).toBeTruthy();
        }
      }
      if (e.type === "slider") {
        expect(typeof e.min, `${e.id} slider 缺 min`).toBe("number");
        expect(typeof e.max, `${e.id} slider 缺 max`).toBe("number");
        expect(typeof e.step, `${e.id} slider 缺 step`).toBe("number");
        expect(e.min, `${e.id} min <= max`).toBeLessThanOrEqual(e.max);
      }
      if (e.type === "text" && e.placeholder) {
        expect(
          resolveKey(zhCN, e.placeholder),
          `${e.id} placeholder ${e.placeholder} 缺失`,
        ).toBeTruthy();
      }
    }
  });
});

describe("settingsIndex 行为（get/set 往返）", () => {
  it("每项 get() 返回原始类型", () => {
    for (const e of settingsIndex) {
      const v = e.get();
      expect(
        ["boolean", "string", "number"].includes(typeof v),
        `${e.id} get() 返回 ${typeof v}`,
      ).toBe(true);
    }
  });

  it("每项 set(v) 生效，测后恢复原值", async () => {
    for (const e of settingsIndex) {
      const original = e.get();
      let testValue;
      if (e.type === "toggle") {
        testValue = !original;
      } else if (e.type === "slider") {
        // 取一个与当前不同的合法值（到边界则回卷到 min）；min/max/step 由结构校验保证存在
        testValue =
          (original as number) >= e.max!
            ? e.min!
            : Math.min(e.max!, (original as number) + e.step!);
      } else if (e.type === "select") {
        const other = e.options!.find((o) => o.value !== original);
        testValue = other ? other.value : e.options![0].value;
      } else {
        testValue = "test-value";
      }

      e.set(testValue);
      if (e.category === "library") {
        // saveLibrarySettings 异步回写 state.librarySettings，等一个宏任务
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(e.get(), `${e.id} set(${JSON.stringify(testValue)}) 后 get 应生效`).toBe(testValue);

      e.set(original);
      if (e.category === "library") {
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(e.get(), `${e.id} 恢复原值失败`).toBe(original);
    }
  });

  it("AMLL 三特效条目：toggle 类型、get/set 读写 lyricSettings.amll*、关键词含 模糊/弹簧/放大", async () => {
    const en = (await import("../locales/en-US/index.js")).default;
    const entries = ["amllBlur", "amllSpring", "amllScale"].map((id) =>
      settingsIndex.find((e) => e.id === id)!,
    );
    expect(entries.every(Boolean)).toBe(true);
    for (const e of entries) {
      expect(e.category).toBe("lyric");
      expect(e.subTab).toBe("app");
      expect(e.type).toBe("toggle");
      // 语言包齐全（zh 文案 + en 覆盖）
      expect(resolveKey(zhCN, e.labelKey)).toBeTruthy();
      expect(resolveKey(en, e.labelKey)).toBeTruthy();
      // 关键词覆盖用户可能搜的词
      const kw = e.keywords.join(" ");
      expect(kw).toMatch(/模糊|弹簧|放大/);
      expect(kw).toMatch(/amll/i);
      // get/set 往返
      const orig = e.get();
      e.set(!orig);
      expect(e.get()).toBe(!orig);
      e.set(orig);
      expect(e.get()).toBe(orig);
    }
  });

  it("行为测试后各 reactive 恢复默认（未污染共享状态）", () => {
    // sleepTimerOn 恢复走 cancelSleepTimer（清除倒计时 interval），此处兜底断言字段
    expect(playbackSettings.sleepTimerOn).toBe(false);
    expect(playbackSettings.fadeSec).toBe(0);
    expect(lyricSettings.offset).toBe(0);
    expect(lyricSettings.jpColor).toBe("");
    expect(uiSettings.theme).toBe("dark");
    expect(uiSettings.accent).toBe("orange");
    expect(downloadSettings.downloadDir).toBe("");
    expect(desktopLyricSettings.fontSize).toBe(26);
  });
});

describe("settingsIndex ↔ 前端默认值命名空间契约", () => {
  // 注册表 id → 实际字段名推导（与 get() 引用对象一致；id≠字段名的特判集中在这里）
  //   downloadEngine → downloadSettings.engine（注册表 id 与字段名不同）
  //   desktop* → desktopLyricSettings 去前缀首字母小写（desktopShowZh → showZh）
  function resolveField(e: SettingEntry): string {
    if (e.category === "download" && e.id === "downloadEngine") return "engine";
    if (e.category === "lyric" && e.subTab === "desktop") {
      const rest = e.id.slice("desktop".length); // desktopShowZh → ShowZh
      return rest.charAt(0).toLowerCase() + rest.slice(1); // → showZh
    }
    return e.id;
  }

  // 分类(+子 tab) → 命名空间映射（与后端 _SETTINGS_SPEC 归属一致，字段级校验在 pytest）
  interface SettingsNamespace {
    reactive: object | null;
    defaults: object | null;
  }
  const NAMESPACE_OF: Record<string, SettingsNamespace> = {
    playback: { reactive: playbackSettings, defaults: PLAYBACK_SETTINGS_DEFAULTS },
    library: { reactive: null, defaults: null }, // 特判：state.librarySettings（后端 LIBRARY_SETTINGS_DEFAULTS 单一来源）
    video: { reactive: videoSettings, defaults: VIDEO_SETTINGS_DEFAULTS },
    download: { reactive: downloadSettings, defaults: DOWNLOAD_SETTINGS_DEFAULTS },
    "lyric:app": { reactive: lyricSettings, defaults: LYRIC_SETTINGS_DEFAULTS },
    "lyric:desktop": { reactive: desktopLyricSettings, defaults: DESKTOP_LYRIC_DEFAULTS },
    ui: { reactive: uiSettings, defaults: UI_SETTINGS_DEFAULTS },
  };

  function nsKeyOf(e: SettingEntry): string {
    return e.category === "lyric" ? `lyric:${e.subTab}` : e.category;
  }

  // 音乐库字段契约（独立 /api/library/settings API，字段在 state.librarySettings）
  const LIB_FIELDS = new Set(["audioExts", "ignoreHidden", "autoRefresh", "autoScanOnStart"]);

  it("每个 entry.id 落在前端默认值命名空间 keys 并集（library/sleepTimer/别名特判）", () => {
    const union = new Set([
      ...Object.keys(PLAYBACK_SETTINGS_DEFAULTS),
      ...Object.keys(LYRIC_SETTINGS_DEFAULTS),
      ...Object.keys(UI_SETTINGS_DEFAULTS),
      ...Object.keys(DESKTOP_LYRIC_DEFAULTS),
      ...Object.keys(DOWNLOAD_SETTINGS_DEFAULTS),
      ...Object.keys(VIDEO_SETTINGS_DEFAULTS),
    ]);
    for (const e of settingsIndex) {
      if (e.category === "library") {
        expect(LIB_FIELDS.has(e.id), `${e.id} 不在音乐库字段契约 {${[...LIB_FIELDS]}}`).toBe(true);
        continue;
      }
      const field = resolveField(e);
      expect(union.has(field), `${e.id} 字段 ${field} 不在任何前端默认值命名空间`).toBe(true);
    }
  });

  it("每个 entry 引用的字段存在于对应命名空间默认值（字段名拼错/get() undefined 即红）", () => {
    for (const e of settingsIndex) {
      const key = nsKeyOf(e);
      const ns = NAMESPACE_OF[key];
      expect(ns, `${e.id} 分类 ${key} 无契约命名空间映射`).toBeTruthy();
      const field = resolveField(e);
      if (e.category === "library") {
        expect(state.librarySettings, `${e.id} state.librarySettings 未初始化`).toBeTruthy();
        expect(
          field in state.librarySettings!,
          `${e.id} 字段 ${field} 不在 state.librarySettings`,
        ).toBe(true);
      } else {
        expect(field in ns.defaults!, `${e.id} 字段 ${field} 不在 ${key} 默认值常量`).toBe(true);
        expect(field in ns.reactive!, `${e.id} 字段 ${field} 不在 ${key} reactive`).toBe(true);
      }
      expect(typeof e.get(), `${e.id} get() 返回 undefined（字段拼错）`).not.toBe("undefined");
    }
  });

  it("category 与后端命名空间归属一致（playback→playback/player；lyric:desktop→desktopLyric；…）", () => {
    // 与 backend/app/services/settings.py _SETTINGS_SPEC 的 namespace 对齐（字段级校验在后端 pytest）
    const CATEGORY_BACKEND_NS: Record<string, string[]> = {
      playback: ["playback", "player"],
      library: ["library"],
      video: ["video"],
      download: ["download"],
      lyric: ["lyric", "desktopLyric"],
      ui: ["ui"],
      shortcuts: [], // 快捷键无独立后端 namespace（字段在 playback），注册表不收
      about: [], // 关于分类无设置字段
    };
    for (const e of settingsIndex) {
      expect(CATEGORY_BACKEND_NS, `${e.id} 分类 ${e.category} 缺后端映射`).toHaveProperty(
        e.category,
      );
      expect(
        CATEGORY_BACKEND_NS[e.category].length > 0,
        `${e.id} 分类 ${e.category} 后端无对应 namespace（不应有注册表项）`,
      ).toBe(true);
    }
  });

  it("sleepTimer 两条目归属 playbackSettings（与 useSleepTimer 持久化域一致）", () => {
    for (const id of ["sleepTimerOn", "sleepTimerMinutes"]) {
      const e = settingsIndex.find((x) => x.id === id)!;
      expect(e, `${id} 应存在`).toBeTruthy();
      expect(e.category).toBe("playback");
      expect(id in PLAYBACK_SETTINGS_DEFAULTS, `${id} 不在 PLAYBACK_SETTINGS_DEFAULTS`).toBe(true);
    }
  });
});
