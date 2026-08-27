// usePlayer composable 单元测试 — 键盘快捷键/快捷键配置表/setupPlayerActions
// 拆分自 usePlayer.test.js（纯搬移 + harness 收敛公共头部样板，用例零改动）
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  state,
  playLine,
  nextLine,
  playbackSettings,
  PLAYBACK_SETTINGS_DEFAULTS,
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  fmtShortcutKey,
  parseShortcutCombo,
  setupKeyboardShortcuts,
  setupPlayerActions,
  stopPlayerActions,
  playerMod,
  FakeAudio,
} from "./helpers/usePlayerHarness.js";

describe("键盘快捷键", () => {
  const audio = () => FakeAudio.instances[0];

  // 捕获 window keydown 监听器
  function captureHandler() {
    const addSpy = vi.spyOn(window, "addEventListener");
    setupKeyboardShortcuts();
    const call = addSpy.mock.calls.find((c) => c[0] === "keydown");
    return call ? call[1] : null;
  }

  function fire(handler, code, target = {}) {
    const ev = { code, target, preventDefault: vi.fn() };
    handler(ev);
    return ev;
  }

  it("空格切换播放/暂停", () => {
    const h = captureHandler();
    expect(h).toBeTruthy();
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.paused = true;
    fire(h, "Space");
    expect(a.paused).toBe(false);
    fire(h, "Space");
    expect(a.paused).toBe(true);
  });

  it("←/→ 快退/快进 10 秒", () => {
    const h = captureHandler();
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    a.currentTime = 30;
    a.duration = 100;
    fire(h, "ArrowLeft");
    expect(a.currentTime).toBe(20);
    fire(h, "ArrowRight");
    expect(a.currentTime).toBe(30);
  });

  it("← 在开头不越过 0", () => {
    const h = captureHandler();
    const a = audio();
    a.src = "/a.mp3";
    a.currentTime = 3;
    a.duration = 100;
    fire(h, "ArrowLeft");
    expect(a.currentTime).toBe(0);
  });

  it("↑/↓ 音量 ±10%", () => {
    const h = captureHandler();
    state.volume = 0.5;
    fire(h, "ArrowUp");
    expect(state.volume).toBe(0.6);
    fire(h, "ArrowDown");
    expect(state.volume).toBe(0.5);
  });

  it("输入框聚焦时不拦截按键", () => {
    const h = captureHandler();
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.paused = true;
    const ev = fire(h, "Space", { tagName: "INPUT" });
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(a.paused).toBe(true); // 没有触发播放
  });

  it("node 环境（无 window）安装安全返回", () => {
    const orig = globalThis.window;
    globalThis.window = undefined;
    try {
      const un = setupKeyboardShortcuts();
      expect(typeof un).toBe("function");
    } finally {
      globalThis.window = orig;
    }
  });

  // 跟唱句跳转（默认 N 下一句 / P 上一句，仅跟唱模式生效，键位可配置）
  const K_LRC = [
    { type: "line", s: 0, e: 10, text: ["第一句"] },
    { type: "line", s: 10, e: 20, text: ["第二句"] },
  ];

  it("跟唱模式：N 下一句 / P 上一句（跳句首并播放）", () => {
    const h = captureHandler();
    state.mode = "karaoke";
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    state.lyric = K_LRC;
    playLine(0);
    fire(h, "KeyN");
    expect(a.currentTime).toBe(10); // 下一句句首
    expect(a.paused).toBe(false);
    fire(h, "KeyP");
    expect(a.currentTime).toBe(0); // 上一句句首
    expect(a.paused).toBe(false);
  });

  it("跟唱快捷键可配置：改键后新键生效、旧键失效", () => {
    const h = captureHandler();
    state.mode = "karaoke";
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    state.lyric = K_LRC;
    playbackSettings.karaokeNextKey = "KeyJ";
    playLine(0);
    fire(h, "KeyN"); // 旧键不再生效
    expect(a.currentTime).toBe(0);
    fire(h, "KeyJ"); // 新键生效
    expect(a.currentTime).toBe(10);
  });

  it("连播模式：N/P 不生效", () => {
    const h = captureHandler();
    state.mode = "continuous";
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    state.lyric = K_LRC;
    playLine(0);
    fire(h, "KeyN");
    expect(a.currentTime).toBe(0); // 没有跳句
  });

  it("边界：第一句按 P、最后一句按 N 不动作", () => {
    const h = captureHandler();
    state.mode = "karaoke";
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    state.lyric = K_LRC;
    playLine(0);
    fire(h, "KeyP"); // 第一句：无上一句
    expect(a.currentTime).toBe(0);
    nextLine(); // 跳到第二句（最后一句）
    fire(h, "KeyN"); // 最后一句：无下一句
    expect(a.currentTime).toBe(10);
  });

  it("输入框聚焦时 N/P 不拦截（可正常打字）", () => {
    const h = captureHandler();
    state.mode = "karaoke";
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    state.lyric = K_LRC;
    playLine(0);
    const ev = fire(h, "KeyN", { tagName: "INPUT" });
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(a.currentTime).toBe(0);
  });
});

describe("快捷键配置表（任务 G）", () => {
  const audio = () => FakeAudio.instances[0];

  function captureHandler() {
    const addSpy = vi.spyOn(window, "addEventListener");
    setupKeyboardShortcuts();
    const call = addSpy.mock.calls.find((c) => c[0] === "keydown");
    return call ? call[1] : null;
  }

  // mods：{ metaKey, ctrlKey, altKey, shiftKey } 覆盖默认 false
  function fire(handler, code, target = {}, mods = {}) {
    const ev = {
      code,
      target,
      preventDefault: vi.fn(),
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    };
    handler(ev);
    return ev;
  }

  it("配置表覆盖全部快捷键（22 项），默认值与持久化字段一致", () => {
    expect(SHORTCUTS).toHaveLength(22);
    for (const s of SHORTCUTS) {
      expect(playbackSettings[s.settingKey]).toBe(s.defaultCode);
      expect(s.id && s.labelKey && s.category && s.defaultCode).toBeTruthy();
    }
    // 分类覆盖 6 组（设置弹窗分组渲染顺序）
    expect(SHORTCUT_CATEGORIES.map((c) => c.key)).toEqual([
      "playback",
      "track",
      "volume",
      "karaoke",
      "search",
      "other",
    ]);
    // meta 标记与默认组合一致（⌘ 组合 = "Meta+" 前缀）
    for (const s of SHORTCUTS) {
      expect(s.meta).toBe(s.defaultCode.startsWith("Meta+"));
    }
  });

  it("PLAYBACK_SETTINGS_DEFAULTS 包含全部快捷键字段", () => {
    for (const s of SHORTCUTS) {
      expect(PLAYBACK_SETTINGS_DEFAULTS[s.settingKey]).toBe(s.defaultCode);
    }
  });

  it("⌘→ / ⌘← 下一首 / 上一首（自动播放）", async () => {
    const h = captureHandler();
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    state.currentSong = state.songs[0];
    fire(h, "ArrowRight", {}, { metaKey: true });
    await Promise.resolve(); // selectSong 尾部的 loadLyric fetch 异步收尾
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("B");
    fire(h, "ArrowLeft", {}, { metaKey: true });
    await Promise.resolve();
    expect(state.currentIndex).toBe(0);
  });

  it("M 静音切换", () => {
    const h = captureHandler();
    state.volume = 0.8;
    state.muted = false;
    const a = audio();
    fire(h, "KeyM");
    expect(state.muted).toBe(true);
    expect(a.volume).toBe(0);
    fire(h, "KeyM");
    expect(state.muted).toBe(false);
    expect(a.volume).toBe(0.8);
  });

  it("F 收藏 / 取消收藏当前歌（无当前歌忽略）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const h = captureHandler();
    state.currentSong = { path: "/a.mp3", name: "A" };
    fire(h, "KeyF");
    expect(state.favorites).toContain("/a.mp3");
    fire(h, "KeyF");
    expect(state.favorites).not.toContain("/a.mp3");
    // 无当前歌 / 流媒体歌（path 为 null）：不动作
    state.currentSong = { type: "stream", streamId: "1", path: null, name: "S" };
    fire(h, "KeyF");
    expect(state.favorites).toEqual([]);
  });

  it("R 播放模式三态切换", () => {
    const h = captureHandler();
    state.playMode = "order";
    fire(h, "KeyR");
    expect(state.playMode).toBe("shuffle");
    fire(h, "KeyR");
    expect(state.playMode).toBe("repeatOne");
    fire(h, "KeyR");
    expect(state.playMode).toBe("order");
    expect(playbackSettings.playMode).toBe("order"); // 同步持久化
  });

  it("L 中文翻译显示开关", () => {
    const h = captureHandler();
    state.zhVisible = true;
    fire(h, "KeyL");
    expect(state.zhVisible).toBe(false);
    fire(h, "KeyL");
    expect(state.zhVisible).toBe(true);
  });

  it("G 连播 ↔ 跟唱模式切换", () => {
    const h = captureHandler();
    state.mode = "continuous";
    fire(h, "KeyG");
    expect(state.mode).toBe("karaoke");
    fire(h, "KeyG");
    expect(state.mode).toBe("continuous");
  });

  it("A / B 设 AB 循环起点 / 终点（无 AB 时 B 忽略）", () => {
    const h = captureHandler();
    state.currentSong = { path: "/a.mp3" };
    state.lyric = [
      { type: "line", s: 0, e: 10, text: ["第一句"] },
      { type: "line", s: 10, e: 20, text: ["第二句"] },
    ]; // 两句：0-10 / 10-20
    // B 无 AB 区间：忽略
    fire(h, "KeyB");
    expect(state.abLoop).toBeNull();
    // A：锚定第二句（currentTime=12 → line 1）为起点
    state.currentTime = 12;
    fire(h, "KeyA");
    expect(state.abLoop).toEqual({ a: 1, b: null });
    // B：锚定第一句（currentTime=3 → line 0）为终点 → 自动交换为 {a:0, b:1}
    state.currentTime = 3;
    fire(h, "KeyB");
    expect(state.abLoop).toEqual({ a: 0, b: 1 });
    // 区间完整后 B 再按：忽略
    fire(h, "KeyB");
    expect(state.abLoop).toEqual({ a: 0, b: 1 });
  });

  it("[ / ] 变速步进（0.75 → 1.0 → 1.25，边界不动作）", () => {
    const h = captureHandler();
    state.speed = 1.0;
    fire(h, "BracketLeft");
    expect(state.speed).toBe(0.75);
    expect(playerMod.audio.playbackRate).toBe(0.75); // 变速写入当前活动元素（裸元素）
    fire(h, "BracketLeft"); // 边界：不再变慢
    expect(state.speed).toBe(0.75);
    fire(h, "BracketRight");
    expect(state.speed).toBe(1.0);
    fire(h, "BracketRight");
    expect(state.speed).toBe(1.25);
    expect(playerMod.audio.playbackRate).toBe(1.25);
    fire(h, "BracketRight"); // 边界：不再变快
    expect(state.speed).toBe(1.25);
  });

  it("⌘↑ / ⌘↓ 音量 ±20%（clamp 0~1）", () => {
    const h = captureHandler();
    const a = audio();
    state.volume = 0.5;
    fire(h, "ArrowUp", {}, { metaKey: true });
    expect(state.volume).toBeCloseTo(0.7);
    expect(a.volume).toBeCloseTo(0.7);
    fire(h, "ArrowDown", {}, { metaKey: true });
    expect(state.volume).toBeCloseTo(0.5);
    // clamp 上限
    state.volume = 0.95;
    fire(h, "ArrowUp", {}, { metaKey: true });
    expect(state.volume).toBe(1);
    // clamp 下限
    state.volume = 0.05;
    fire(h, "ArrowDown", {}, { metaKey: true });
    expect(state.volume).toBe(0);
  });

  it("修饰键排除：纯键带 ⌘/Ctrl 不触发，⌘ 组合不带 Meta 不触发", () => {
    const h = captureHandler();
    state.volume = 0.5;
    // Ctrl+↑ 不触发任何音量键（volUp 要求无修饰键；volStepUp 要求 Meta）
    fire(h, "ArrowUp", {}, { ctrlKey: true });
    expect(state.volume).toBe(0.5);
    // Meta+M 不触发静音（M 是纯键）
    state.muted = false;
    fire(h, "KeyM", {}, { metaKey: true });
    expect(state.muted).toBe(false);
    // 纯 M 触发静音
    fire(h, "KeyM");
    expect(state.muted).toBe(true);
    // ⌘→ 不带 Meta：不切歌，走纯键 → 快进 10s
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    state.currentSong = state.songs[0];
    const a = audio();
    a.src = "/a.mp3";
    a.currentTime = 30;
    a.duration = 100;
    fire(h, "ArrowRight"); // 纯 → 快进
    expect(state.currentIndex).toBe(0);
    expect(a.currentTime).toBe(40);
  });

  it("录制保存后按新组合生效（旧组合失效）", () => {
    const h = captureHandler();
    // 把「上一首」录制成 Meta+ArrowRight（与默认 ⌘← 不同）
    playbackSettings.shortcutPrevTrack = "Meta+ArrowRight";
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 1;
    state.currentSong = state.songs[1];
    fire(h, "ArrowRight", {}, { metaKey: true });
    expect(state.currentIndex).toBe(0); // 上一首
    // 默认 ⌘← 已失效：按 ⌘← 不再切歌（⌘← 未绑定任何动作）
    const a = audio();
    a.src = "/b.mp3";
    const ev = fire(h, "ArrowLeft", {}, { metaKey: true });
    expect(state.currentIndex).toBe(0);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("搜索快捷键（⌘K）由搜索层独占：播放器层不拦截", () => {
    const h = captureHandler();
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.paused = true;
    const ev = fire(h, "KeyK", {}, { metaKey: true });
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(a.paused).toBe(true);
  });

  it("⌘, 打开设置（openSettings 快捷键）", async () => {
    const h = captureHandler();
    const { isSettingsOpen } = await import("../composables/settingsState.js");
    isSettingsOpen.value = false;
    fire(h, "Comma", {}, { metaKey: true });
    expect(isSettingsOpen.value).toBe(true);
    // 纯 , 不触发（⌘ 组合要求 metaKey）
    isSettingsOpen.value = false;
    fire(h, "Comma");
    expect(isSettingsOpen.value).toBe(false);
  });

  it("parseShortcutCombo：历史 Meta+K 归一为 KeyK", () => {
    expect(parseShortcutCombo("Meta+K")).toEqual({ meta: true, code: "KeyK" });
    expect(parseShortcutCombo("Meta+KeyK")).toEqual({ meta: true, code: "KeyK" });
    expect(parseShortcutCombo("Meta+ArrowLeft")).toEqual({ meta: true, code: "ArrowLeft" });
    expect(parseShortcutCombo("KeyM")).toEqual({ meta: false, code: "KeyM" });
    expect(parseShortcutCombo(null)).toBeNull();
  });

  it("fmtShortcutKey：⌘ 组合与特殊键显示", () => {
    expect(fmtShortcutKey("Meta+ArrowLeft")).toBe("⌘←");
    expect(fmtShortcutKey("Meta+K")).toBe("⌘K");
    expect(fmtShortcutKey("Meta+ArrowUp")).toBe("⌘↑");
    expect(fmtShortcutKey("Space")).toBe("Space");
    expect(fmtShortcutKey("KeyM")).toBe("M");
    expect(fmtShortcutKey("BracketLeft")).toBe("[");
    expect(fmtShortcutKey("BracketRight")).toBe("]");
    expect(fmtShortcutKey("Meta+Comma")).toBe("⌘,");
    expect(fmtShortcutKey("Comma")).toBe(",");
    expect(fmtShortcutKey("Digit5")).toBe("5");
    expect(fmtShortcutKey("F3")).toBe("F3");
    expect(fmtShortcutKey("")).toBe("—");
  });

  it("录制纯键与 ⌘ 组合均能被配置表匹配（模拟 SettingsModal 存值）", () => {
    const h = captureHandler();
    // 纯键录制：静音改为 KeyJ
    playbackSettings.shortcutMute = "KeyJ";
    state.muted = false;
    fire(h, "KeyJ");
    expect(state.muted).toBe(true);
    fire(h, "KeyM"); // 旧键失效
    expect(state.muted).toBe(true);
    // ⌘ 组合录制：翻译开关改为 Meta+KeyT
    playbackSettings.shortcutZhToggle = "Meta+KeyT";
    state.zhVisible = true;
    fire(h, "KeyT", {}, { metaKey: true });
    expect(state.zhVisible).toBe(false);
    fire(h, "KeyL"); // 旧键失效
    expect(state.zhVisible).toBe(false);
  });
});

describe("setupPlayerActions（迷你窗控制指令消费）", () => {
  afterEach(() => {
    // 先清 timer 再恢复真实 timers：顺序反了 fake interval id 在真实环境 clear 无效，
    // timer 泄漏到下一测试（CI 全量跑偶发多一次 fetch 的 flaky 根因）
    stopPlayerActions();
    vi.useRealTimers();
  });

  function stubActions(actions) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "/api/player/actions") {
          return { ok: true, json: async () => ({ actions }) };
        }
        if (url.startsWith("/api/lyric")) {
          return { ok: true, json: async () => ({ lyric: [], source: null }) };
        }
        if (url === "/api/cover") {
          return { ok: true };
        }
        throw new Error("unexpected url " + url);
      }),
    );
  }

  it("取到指令依次执行：togglePlay / seek / volume / next / prev", async () => {
    // 重置模块级单例 audio 的播放状态（跨测试残留：上一个测试可能停在播放中）
    const fake = FakeAudio.instances[0];
    fake.paused = true;
    fake.currentTime = 0;
    fake.duration = 0;
    state.songs = [
      { path: "/a.mp3", name: "A", artist: "X", duration: 100 },
      { path: "/b.mp3", name: "B", artist: "Y", duration: 100 },
    ];
    state.currentIndex = 0;
    state.currentSong = state.songs[0];
    state.duration = 100;
    vi.useFakeTimers();

    // 第一轮：播放控制类指令（同一轮会同步全部执行，末条状态为准）
    stubActions([
      { action: "togglePlay", value: null },
      { action: "seek", value: 42 },
      { action: "volume", value: 0.3 },
    ]);
    setupPlayerActions(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeAudio.instances[0].paused).toBe(false); // togglePlay
    expect(state.currentTime).toBe(42); // seek
    expect(state.volume).toBe(0.3); // volume

    // 第二轮：next → 切到下一首（selectSong 换源后默认暂停）
    stubActions([{ action: "next", value: null }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("B");

    // 第三轮：prev → 回到上一首
    stubActions([{ action: "prev", value: null }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.currentIndex).toBe(0);
  });

  it("未知指令忽略，不抛错", async () => {
    stubActions([
      { action: "rm -rf /", value: null },
      { action: "seek", value: 10 },
    ]);
    vi.useFakeTimers();
    setupPlayerActions(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.currentTime).toBe(10);
  });

  it("重复调用幂等，不叠加 timer", async () => {
    stubActions([{ action: "volume", value: 0.5 }]);
    vi.useFakeTimers();
    setupPlayerActions(100);
    setupPlayerActions(100);
    setupPlayerActions(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).toHaveBeenCalledTimes(3); // 3 轮 × 1 次（非 3 个 timer × 3 轮）
    expect(state.volume).toBe(0.5);
  });

  it("接口异常时静默，不影响下一轮", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        throw new Error("backend down");
      }),
    );
    vi.useFakeTimers();
    setupPlayerActions(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toBe(3);
  });
});
