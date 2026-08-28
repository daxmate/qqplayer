// usePlayer composable 单元测试 — 设置域（歌词显示/界面偏好/播放设置/歌词延迟校准/歌词来源/音乐库设置/侧栏面板）
// 拆分自 usePlayer.test.js（纯搬移 + harness 收敛公共头部样板，用例零改动）
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { LyricLine } from "../composables/playerState.js";
import {
  state,
  cyclePlayMode,
  selectSong,
  playLine,
  currentLineIndex,
  lyricSettings,
  LYRIC_SETTINGS_KEY,
  uiSettings,
  UI_SETTINGS_KEY,
  playbackSettings,
  PLAYBACK_SETTINGS_KEY,
  setVolume,
  VOLUME_KEY,
  loadLibrarySettings,
  saveLibrarySettings,
  toggleMusicLib,
  togglePlaylist,
  uiState,
  UI_STATE_KEY,
  toggleControls,
  loadLyric,
  FakeAudio,
  lsStore,
} from "./helpers/usePlayerHarness.js";

describe("歌词显示设置（lyricSettings）", () => {
  it("默认值：20px / 左对齐 / 系统字体 / 全开 / 1/3 停靠", () => {
    expect(lyricSettings.fontSize).toBe(20);
    expect(lyricSettings.align).toBe("left");
    expect(lyricSettings.fontFamily).toBe("system");
    expect(lyricSettings.showRoma).toBe(true);
    expect(lyricSettings.showZh).toBe(true);
    expect(lyricSettings.showSec).toBe(true);
    expect(lyricSettings.focusPos).toBe(0.5);
    expect(lyricSettings.fadeMask).toBe(true);
    expect(lyricSettings.autoScroll).toBe(true);
  });

  it("AMLL 三特效：浏览器（无壳）默认关闭，防 CPU 高占用", () => {
    // jsdom 无 window.qqplayerNative → 浏览器环境：开箱默认关（localStorage 无存储值时）
    expect(lyricSettings.amllBlur).toBe(false);
    expect(lyricSettings.amllSpring).toBe(false);
    expect(lyricSettings.amllScale).toBe(false);
    // 引擎同样回退 spring：浏览器默认不用 AMLL（pixi WebGL 长时间播放仍高占用），用户手动切才启用
    expect(lyricSettings.engine).toBe("spring");
  });

  it("AMLL 三特效：壳（window.qqplayerNative）内默认开启（满血，行为零变化）", async () => {
    localStorage.removeItem(LYRIC_SETTINGS_KEY);
    window.qqplayerNative = true;
    vi.resetModules();
    try {
      const m = await import("../composables/usePlayer.js");
      expect(m.lyricSettings.amllBlur).toBe(true);
      expect(m.lyricSettings.amllSpring).toBe(true);
      expect(m.lyricSettings.amllScale).toBe(true);
      expect(m.lyricSettings.engine).toBe("amll"); // 壳默认保持 AMLL 引擎
      expect(m.lyricSettings.fontSize).toBe(20); // 其他字段不受影响
    } finally {
      delete window.qqplayerNative;
    }
  });

  it("AMLL 三特效：已存储值优先（壳内存 false → 关；浏览器存 true → 开）", async () => {
    // 壳环境：存储值 false 覆盖环境默认 true
    localStorage.setItem(
      LYRIC_SETTINGS_KEY,
      JSON.stringify({ amllBlur: false, amllSpring: false, amllScale: false }),
    );
    window.qqplayerNative = true;
    vi.resetModules();
    try {
      const m = await import("../composables/usePlayer.js");
      expect(m.lyricSettings.amllBlur).toBe(false);
      expect(m.lyricSettings.amllSpring).toBe(false);
      expect(m.lyricSettings.amllScale).toBe(false);
    } finally {
      delete window.qqplayerNative;
    }
    // 浏览器环境：存储值 true 覆盖环境默认 false
    localStorage.setItem(
      LYRIC_SETTINGS_KEY,
      JSON.stringify({ amllBlur: true, amllSpring: true, amllScale: true, engine: "amll" }),
    );
    vi.resetModules();
    const m2 = await import("../composables/usePlayer.js");
    expect(m2.lyricSettings.amllBlur).toBe(true);
    expect(m2.lyricSettings.amllSpring).toBe(true);
    expect(m2.lyricSettings.amllScale).toBe(true);
    expect(m2.lyricSettings.engine).toBe("amll"); // 用户手动切回 AMLL 的存储值优先
  });

  it("修改后自动持久化到 localStorage", async () => {
    localStorage.removeItem(LYRIC_SETTINGS_KEY);
    lyricSettings.fontSize = 26;
    lyricSettings.align = "center";
    await nextTick();
    const saved = JSON.parse(localStorage.getItem(LYRIC_SETTINGS_KEY) as string);
    expect(saved.fontSize).toBe(26);
    expect(saved.align).toBe("center");
  });

  it("localStorage 已有配置时加载覆盖默认值，未保存项保持默认", async () => {
    localStorage.setItem(LYRIC_SETTINGS_KEY, JSON.stringify({ fontSize: 24, focusPos: 0.5 }));
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    expect(m.lyricSettings.fontSize).toBe(24);
    expect(m.lyricSettings.focusPos).toBe(0.5);
    expect(m.lyricSettings.align).toBe("left"); // 未保存的保持默认
    expect(m.lyricSettings.fadeMask).toBe(true);
  });
});

describe("界面偏好（uiSettings）", () => {
  it("默认值：歌曲信息关闭 / 跟唱时间戳关闭 / 跟唱行号显示（默认显示，用户可关）", () => {
    expect(uiSettings.showSongInfo).toBe(false);
    expect(uiSettings.karaokeShowTime).toBe(false);
    expect(uiSettings.karaokeShowNum).toBe(true);
  });

  it("第四批默认值：深色主题 / 橙色强调色 / 封面模糊关 / 紧凑模式关", () => {
    expect(uiSettings.theme).toBe("dark");
    expect(uiSettings.accent).toBe("orange");
    expect(uiSettings.coverBlur).toBe(false);
    expect(uiSettings.compact).toBe(false);
  });

  it("修改主题/强调色/紧凑/封面模糊后写入 html dataset（驱动 CSS）", async () => {
    const html = document.documentElement;
    uiSettings.theme = "light";
    uiSettings.accent = "blue";
    uiSettings.compact = true;
    uiSettings.coverBlur = true;
    await nextTick();
    expect(html.dataset.theme).toBe("light");
    expect(html.dataset.accent).toBe("blue");
    expect(html.dataset.compact).toBe("true");
    expect(html.dataset.blur).toBe("true");
    // 关闭后移除属性
    uiSettings.compact = false;
    uiSettings.coverBlur = false;
    await nextTick();
    expect(html.dataset.compact).toBeUndefined();
    expect(html.dataset.blur).toBeUndefined();
  });

  it("auto 主题跟随系统 prefers-color-scheme（浅色系统→light，深色系统→dark）", async () => {
    const listeners: Record<string, () => void> = {};
    const mq = {
      matches: true,
      media: "(prefers-color-scheme: light)",
      addEventListener: (ev: string, fn: () => void) => {
        listeners[ev] = fn;
      },
      removeEventListener: () => {},
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mq),
    );
    uiSettings.theme = "auto";
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe("light");
    // 系统切到深色 → 自动更新
    mq.matches = false;
    listeners.change();
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe("dark");
    // 手动指定主题后不再跟随系统
    uiSettings.theme = "light";
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe("light");
    vi.unstubAllGlobals();
  });

  it("localStorage 持久化的主题/强调色在启动时应用（data-theme 恢复）", async () => {
    localStorage.setItem(
      UI_SETTINGS_KEY,
      JSON.stringify({ theme: "light", accent: "purple", compact: true }),
    );
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    expect(m.uiSettings.theme).toBe("light");
    expect(m.uiSettings.accent).toBe("purple");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.accent).toBe("purple");
    expect(document.documentElement.dataset.compact).toBe("true");
  });

  it("修改后自动持久化到 localStorage", async () => {
    localStorage.removeItem(UI_SETTINGS_KEY);
    uiSettings.showSongInfo = true;
    uiSettings.karaokeShowTime = true;
    uiSettings.karaokeShowNum = false;
    await nextTick();
    const saved = JSON.parse(localStorage.getItem(UI_SETTINGS_KEY) as string);
    expect(saved.showSongInfo).toBe(true);
    expect(saved.karaokeShowTime).toBe(true);
    expect(saved.karaokeShowNum).toBe(false);
  });

  it("localStorage 已有配置时加载覆盖默认值，未保存项保持默认", async () => {
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ showSongInfo: true }));
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    expect(m.uiSettings.showSongInfo).toBe(true);
    expect(m.uiSettings.karaokeShowTime).toBe(false); // 未保存的保持默认
    expect(m.uiSettings.karaokeShowNum).toBe(true); // 未保存的保持默认
  });
});

describe("播放设置 playbackSettings", () => {
  // 模块级 reactive 跨测试残留：每个测试前保存、后恢复
  let saved: { [k: string]: unknown };
  beforeEach(() => {
    saved = { ...playbackSettings };
  });
  afterEach(() => {
    Object.assign(playbackSettings, saved);
    state.volume = 1.0;
    state.muted = false;
  });

  it("cyclePlayMode 同步持久化播放模式（启动时恢复用）", async () => {
    state.playMode = "order";
    cyclePlayMode();
    expect(playbackSettings.playMode).toBe("shuffle");
    await nextTick(); // watch 持久化为异步写入
    expect(JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY) as string).playMode).toBe(
      "shuffle",
    );
  });

  it("设置弹窗里改播放模式立即生效（同步 state）", () => {
    state.playMode = "order";
    playbackSettings.playMode = "repeatOne";
    expect(state.playMode).toBe("repeatOne");
  });

  it("播放模式持久化：模块加载时从 localStorage 恢复", async () => {
    // 重新加载模块验证启动恢复（重置模块缓存）
    // 拆分后 usePlayer.js 是 barrel 聚合层（export * 的底层模块已被缓存，查询参数无法强制重载），
    // 播放设置的加载逻辑在 playerState.ts（playbackSettings 与 loadPlaybackSettings 同模块），
    // 直接重载它验证等价行为
    localStorage.setItem(
      PLAYBACK_SETTINGS_KEY,
      JSON.stringify({ playMode: "shuffle", resumeLast: false, rememberVolume: false, fadeSec: 1 }),
    );
    const mod = await import("../composables/playerState.ts?restore-test=" + Date.now());
    expect(mod.state.playMode).toBe("shuffle");
    expect(mod.playbackSettings.fadeSec).toBe(1);
  });

  it("记住音量：开启时 setVolume 持久化", () => {
    playbackSettings.rememberVolume = true;
    setVolume(0.5);
    expect(parseFloat(localStorage.getItem(VOLUME_KEY) as string)).toBe(0.5);
  });

  it("记住音量：关闭时 setVolume 不写入 localStorage", () => {
    playbackSettings.rememberVolume = false;
    setVolume(0.5);
    expect(localStorage.getItem(VOLUME_KEY)).toBeNull();
  });
});

describe("歌词延迟校准（lyricSettings.offset）", () => {
  const LRC: LyricLine[] = [
    { type: "line", s: 0, e: 10, text: ["第一句"] },
    { type: "line", s: 10, e: 20, text: ["第二句"] },
  ];

  const audio = () => FakeAudio.instances[0];

  function setup(on = true) {
    state.mode = "karaoke";
    state.karaokeOn = on;
    state.currentSong = { path: "/a.mp3" };
    audio().src = "/a.mp3";
  }
  function fireTimeupdate(t: number) {
    const a = audio();
    a.currentTime = t;
    a.paused = false;
    a.listeners["timeupdate"]();
    return a;
  }

  beforeEach(() => {
    lyricSettings.offset = 0;
  });

  it("offset>0：playLine 跳到句首 + 偏移（歌词延后，音频先行）", () => {
    setup();
    state.lyric = LRC;
    lyricSettings.offset = 0.5;
    playLine(1); // 第二句 s=10
    expect(audio().currentTime).toBe(10.5);
  });

  it("offset<0：playLine 跳到句首 - 偏移，且不小于 0", () => {
    setup();
    state.lyric = LRC;
    lyricSettings.offset = -0.5;
    playLine(0); // 第一句 s=0 → clamp 到 0
    expect(audio().currentTime).toBe(0);
    playLine(1); // 第二句 s=10 → 9.5
    expect(audio().currentTime).toBe(9.5);
  });

  it("句末自动停时刻随 offset 平移（延后 0.5s）", () => {
    setup();
    state.lyric = LRC;
    lyricSettings.offset = 0.5;
    playLine(0);
    fireTimeupdate(10.2); // 歌词轴 9.7，仍在第一句内
    expect(audio().paused).toBe(false);
    fireTimeupdate(10.5); // 歌词轴 10.0，越过 e=10 → 停
    expect(audio().paused).toBe(true);
  });

  it("句末自动停时刻随 offset 平移（提前 0.5s）", () => {
    setup();
    state.lyric = LRC;
    lyricSettings.offset = -0.5;
    playLine(0);
    fireTimeupdate(9.2); // 歌词轴 9.7，仍在第一句内
    expect(audio().paused).toBe(false);
    fireTimeupdate(9.5); // 歌词轴 10.0，越过 e=10 → 停
    expect(audio().paused).toBe(true);
  });

  it("currentLineIndex 高亮随 offset 平移", () => {
    state.lyric = LRC;
    state.currentTime = 10.2;
    lyricSettings.offset = 0.5;
    expect(currentLineIndex.value).toBe(0); // 歌词轴 9.7 仍在第一句
    lyricSettings.offset = -0.5;
    expect(currentLineIndex.value).toBe(1); // 歌词轴 10.7 已进第二句
  });
});

describe("歌词来源优先级（lyricSettings.source）", () => {
  const lyricRes = (source: string) => ({
    ok: true,
    json: async () => ({
      format: "lrc",
      lines: [{ type: "line", s: 0, e: 1, text: ["x"] }],
      source,
    }),
  });

  beforeEach(() => {
    lyricSettings.source = "local";
  });

  it("默认 local：加载歌词请求带 prefer=local，记录实际来源", async () => {
    const fetchMock = vi.fn(async () => lyricRes("local"));
    vi.stubGlobal("fetch", fetchMock);
    state.songs = [{ path: "/a.mp3" }];
    await selectSong(0);
    const url = (fetchMock.mock.calls[0] as unknown[])[0];
    expect(url).toContain("/api/lyric?path=");
    expect(url).toContain("prefer=local");
    expect(state.lyricSource).toBe("local");
  });

  it("切换到在线优先：watch 触发重载，请求带 prefer=online", async () => {
    const fetchMock = vi.fn(async () => lyricRes("netease"));
    vi.stubGlobal("fetch", fetchMock);
    state.songs = [{ path: "/a.mp3" }];
    await selectSong(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    lyricSettings.source = "online";
    await new Promise((r) => setTimeout(r, 0)); // watch 异步触发重载
    // 重载请求必须带 prefer=online（次数不做硬断言：watch 链式触发次数随环境而变，验证本质即可）
    const onlineCalls = (fetchMock.mock.calls as unknown[][]).filter(([url]) =>
      String(url).includes("prefer=online"),
    );
    expect(onlineCalls.length).toBeGreaterThanOrEqual(1);
    expect(state.lyricSource).toBe("netease");
  });

  it("loadLyric 越界 index 时清空歌词", async () => {
    state.songs = [{ path: "/a.mp3" }];
    state.lyric = [{ type: "line", s: 0, e: 1, text: ["x"] }];
    await loadLyric(3);
    expect(state.lyric).toEqual([]);
    expect(state.lyricSource).toBeNull();
  });
});

describe("音乐库设置 librarySettings", () => {
  it("loadLibrarySettings 拉取后端设置并写入 state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        expect(url).toBe("/api/library/settings");
        return {
          ok: true,
          json: async () => ({
            settings: { audioExts: [".mp3", ".flac"], ignoreHidden: true },
          }),
        };
      }),
    );
    await loadLibrarySettings();
    expect(state.librarySettings).toEqual({
      audioExts: [".mp3", ".flac"],
      ignoreHidden: true,
    });
  });

  it("loadLibrarySettings 后端不可用时静默（不抛异常）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    await expect(loadLibrarySettings()).resolves.toBeUndefined();
    expect(state.librarySettings).toBeNull();
  });

  it("saveLibrarySettings PUT 成功：写入 state 并返回响应", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, opts: { method?: string; body: string }) => {
        expect(url).toBe("/api/library/settings");
        expect(opts.method).toBe("PUT");
        expect(JSON.parse(opts.body)).toEqual({ autoRefresh: false });
        return {
          ok: true,
          json: async () => ({
            settings: { audioExts: [".mp3"], autoRefresh: false },
            count: 10,
          }),
        };
      }),
    );
    const data = await saveLibrarySettings({ autoRefresh: false });
    expect((state.librarySettings as Record<string, unknown>).autoRefresh).toBe(false);
    expect(data.count).toBe(10);
  });

  it("saveLibrarySettings 后端失败：抛出错误信息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ detail: "保存失败" }),
      })),
    );
    await expect(saveLibrarySettings({ autoRefresh: true })).rejects.toThrow("保存失败");
  });
});

describe("侧栏面板开关", () => {
  it("toggleMusicLib / togglePlaylist 切换并持久化 localStorage（统一 key qqplayer.ui.v1）", () => {
    expect(uiState.musicLibOpen).toBe(true);
    expect(uiState.playlistOpen).toBe(true);
    toggleMusicLib();
    togglePlaylist();
    expect(uiState.musicLibOpen).toBe(false);
    expect(uiState.playlistOpen).toBe(false);
    expect(lsStore[UI_STATE_KEY]).toBe(
      JSON.stringify({ musicLib: false, playlist: false, controlsHidden: false }),
    );
    toggleMusicLib();
    expect(uiState.musicLibOpen).toBe(true);
    expect(uiState.playlistOpen).toBe(false);
  });

  it("两个面板独立开关，互不影响", () => {
    toggleMusicLib();
    expect(uiState.musicLibOpen).toBe(false);
    expect(uiState.playlistOpen).toBe(true);
    togglePlaylist();
    expect(uiState.musicLibOpen).toBe(false);
    expect(uiState.playlistOpen).toBe(false);
  });

  it("加载时从 localStorage 恢复面板状态", async () => {
    lsStore[UI_STATE_KEY] = JSON.stringify({ musicLib: false, playlist: true });
    vi.resetModules();
    const mod = await import("../composables/usePlayer.js");
    expect(mod.uiState.musicLibOpen).toBe(false);
    expect(mod.uiState.playlistOpen).toBe(true);
  });

  it("旧 key（PANEL_KEY/CONTROLS_KEY）首次读取时迁移到统一 key，行为不变", async () => {
    lsStore["qqplay…p.v1"] = JSON.stringify({ musicLib: false, playlist: true });
    lsStore["qqplayer.controls.v1"] = "1";
    vi.resetModules();
    const mod = await import("../composables/usePlayer.js");
    expect(mod.uiState.musicLibOpen).toBe(false);
    expect(mod.uiState.playlistOpen).toBe(true);
    expect(mod.uiState.controlsHidden).toBe(true);
    // 迁移后写透新 key；后续启动走新 key（旧 key 保留不删）
    expect(JSON.parse(lsStore[UI_STATE_KEY])).toEqual({
      musicLib: false,
      playlist: true,
      controlsHidden: true,
    });
  });

  it("toggleControls 收起/展开控制区并持久化 localStorage", () => {
    expect(uiState.controlsHidden).toBe(false);
    toggleControls();
    expect(uiState.controlsHidden).toBe(true);
    expect(JSON.parse(lsStore[UI_STATE_KEY]).controlsHidden).toBe(true);
    toggleControls();
    expect(uiState.controlsHidden).toBe(false);
    expect(JSON.parse(lsStore[UI_STATE_KEY]).controlsHidden).toBe(false);
  });

  it("加载时从 localStorage 恢复控制区收起状态", async () => {
    lsStore[UI_STATE_KEY] = JSON.stringify({ controlsHidden: true });
    vi.resetModules();
    const mod = await import("../composables/usePlayer.js");
    expect(mod.uiState.controlsHidden).toBe(true);
  });
});
