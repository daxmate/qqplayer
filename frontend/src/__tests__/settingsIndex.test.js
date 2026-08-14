// settingsIndex 结构校验 + get/set 行为校验
// 注意：settingsIndex 经 usePlayer（playerCore）模块加载，playerCore 在模块作用域
// `new Audio()` —— 必须在 import 被测模块【前】stub Audio 与 matchMedia。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { installMatchMedia } from "./helpers/matchMedia.js";

class FakeAudio {
  constructor() {
    this.src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
  }
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

const { SETTING_CATEGORIES, CATEGORY_KEYS, settingsIndex } = await import("../settingsIndex.js");
const zhCN = (await import("../locales/zh-CN/index.js")).default;
const {
  state,
  playbackSettings,
  lyricSettings,
  uiSettings,
  desktopLyricSettings,
  downloadSettings,
} = await import("../composables/usePlayer.js");

const VALID_TYPES = ["toggle", "slider", "select", "text"];
const VALID_SUBTABS = ["app", "desktop"];

// 语言包 key 解析（点路径逐级下钻）
function resolveKey(pack, key) {
  return key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), pack);
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
  it("SETTING_CATEGORIES 为 7 分类且 key 唯一", () => {
    expect(SETTING_CATEGORIES).toHaveLength(7);
    const keys = SETTING_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        "playback",
        "library",
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
        // 取一个与当前不同的合法值（到边界则回卷到 min）
        testValue = original >= e.max ? e.min : Math.min(e.max, original + e.step);
      } else if (e.type === "select") {
        const other = e.options.find((o) => o.value !== original);
        testValue = other ? other.value : e.options[0].value;
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
