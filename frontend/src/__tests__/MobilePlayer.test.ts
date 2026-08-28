// MobilePlayer 测试：移动端全屏播放器（Apple Music 三段式重构）
// 结构：封面区（下拉返回手势）→ 小歌词区 → 歌名/歌手行（❤️➕🎤）→ 进度条 → 底部控制区
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, (() => void) | undefined> = {};
  play() {
    this.paused = false;
    this.listeners["play"]?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const MobilePlayer = (await import("../components/mobile/MobilePlayer.vue")).default;
const { state, uiSettings } = await import("../composables/usePlayer.js");
const { _resetSleepTimer, sleepTimer } = await import("../composables/useSleepTimer.js");

const song = { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" };
const playlist = { id: "p1", name: "日语精选", songPaths: [], createdAt: 0, updatedAt: 0 };

beforeEach(() => {
  Object.assign(state, {
    songs: [song],
    currentIndex: 0,
    currentSong: song,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
    mode: "continuous",
    lyric: [],
    playMode: "order",
  });
  uiSettings.glassCover = true;
  _resetSleepTimer();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

afterEach(() => {
  _resetSleepTimer();
  vi.unstubAllGlobals();
});

describe("MobilePlayer 三段式布局（continuous）", () => {
  it("渲染封面/歌词/歌名行/进度条/控制区；无顶栏与频谱", () => {
    state.duration = 240;
    const wrapper = mount(MobilePlayer);
    // ① 封面区（正方形圆角封面）
    expect(wrapper.find(".mp-cover-area .mp-cover-box").exists()).toBe(true);
    // ② 小歌词区：复用 KaraokePanel（headless）
    expect(wrapper.find(".mp-lyric-area .karaoke-panel").exists()).toBe(true);
    // ③ 歌名/歌手行
    expect(wrapper.find(".mp-song-name").text()).toBe("雪の華");
    expect(wrapper.find(".mp-song-artist").text()).toContain("中島美嘉");
    expect(wrapper.find(".mp-song-artist").text()).toContain("雪の華"); // 专辑
    // ④ 进度条
    expect(wrapper.find(".mp-progress-row .mp-progress").exists()).toBe(true);
    // ⑤ 底部控制区（新移动端专用控制条，不再复用 ControlBar）
    expect(wrapper.find(".mp-controls-row").exists()).toBe(true);
    expect(wrapper.find(".mp-controls-row .mp-play").exists()).toBe(true);
    expect(wrapper.find(".mp-controls-row .mp-mode-btn").exists()).toBe(true);
    expect(wrapper.find(".mp-controls-row .mp-queue-btn").exists()).toBe(true);
    expect(wrapper.find(".mp-controls-row .mp-moon-btn").exists()).toBe(true);
    // 顶栏删除 / 频谱删除 / ControlBar 不再渲染（连播模式）
    expect(wrapper.find(".mp-head").exists()).toBe(false);
    expect(wrapper.find(".visualizer").exists()).toBe(false);
    expect(wrapper.find(".controls").exists()).toBe(false);
  });

  it("歌名行右侧三个描边圆钮：❤️ ➕ 🎤", () => {
    const wrapper = mount(MobilePlayer);
    const orbs = wrapper.findAll(".mp-song-actions .mp-orb");
    expect(orbs.length).toBe(3);
    expect(wrapper.find(".mp-fav-btn").exists()).toBe(true);
    expect(wrapper.find(".mp-add-btn").exists()).toBe(true);
    expect(wrapper.find(".mp-karaoke-btn").exists()).toBe(true);
  });

  it("continuous 模式显示滚动歌词（复用 KaraokePanel headless）", () => {
    state.lyric = [
      { type: "line", s: 0, e: 10, text: ["第一句"] },
      { type: "line", s: 10, e: 20, text: ["第二句"] },
    ];
    const wrapper = mount(MobilePlayer);
    const klines = wrapper.findAll(".mp-lyric-area .kline");
    expect(klines.length).toBe(2);
    expect(klines[0].text()).toContain("第一句");
    expect(klines[1].text()).toContain("第二句");
    // headless：不显示跟唱面板头
    expect(wrapper.find(".mp-lyric-area .kp-head").exists()).toBe(false);
  });

  it("continuous 模式当前句高亮（跟随播放进度）", () => {
    state.lyric = [
      { type: "line", s: 0, e: 10, text: ["第一句"] },
      { type: "line", s: 10, e: 20, text: ["第二句"] },
    ];
    state.currentTime = 12; // 落在第二句 [10, 20)
    const wrapper = mount(MobilePlayer);
    const active = wrapper.find(".mp-lyric-area .kline.active");
    expect(active.exists()).toBe(true);
    expect(active.text()).toContain("第二句");
  });

  it("continuous 模式无歌词时显示占位（kp-empty）", () => {
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-lyric-area .kp-empty").exists()).toBe(true);
  });
});

describe("MobilePlayer 下拉返回手势", () => {
  it("下拉超过阈值（100px）→ emit back", async () => {
    const wrapper = mount(MobilePlayer);
    const area = wrapper.find(".mp-cover-area");
    await area.trigger("touchstart", { touches: [{ clientX: 100, clientY: 60 }] });
    await area.trigger("touchmove", { touches: [{ clientX: 100, clientY: 200 }] }); // dy=140
    await area.trigger("touchend", { changedTouches: [{ clientX: 100, clientY: 200 }] });
    expect(wrapper.emitted("back")).toBeTruthy();
  });

  it("下拉不足阈值 → 回弹，不 emit back", async () => {
    const wrapper = mount(MobilePlayer);
    const area = wrapper.find(".mp-cover-area");
    await area.trigger("touchstart", { touches: [{ clientX: 100, clientY: 60 }] });
    await area.trigger("touchmove", { touches: [{ clientX: 100, clientY: 100 }] }); // dy=40
    await area.trigger("touchend", { changedTouches: [{ clientX: 100, clientY: 100 }] });
    expect(wrapper.emitted("back")).toBeFalsy();
    // 回弹：位移清 0
    expect(wrapper.find(".mobile-player").attributes("style")).not.toContain("translateY");
  });

  it("上滑（歌词区方向）不响应下拉", async () => {
    const wrapper = mount(MobilePlayer);
    const area = wrapper.find(".mp-cover-area");
    await area.trigger("touchstart", { touches: [{ clientX: 100, clientY: 200 }] });
    await area.trigger("touchmove", { touches: [{ clientX: 100, clientY: 120 }] }); // dy=-80
    await area.trigger("touchend", { changedTouches: [{ clientX: 100, clientY: 120 }] });
    expect(wrapper.emitted("back")).toBeFalsy();
  });
});

describe("MobilePlayer 歌名行按钮", () => {
  it("❤️ 点击收藏：乐观更新 + 调后端接口", async () => {
    const wrapper = mount(MobilePlayer);
    const heartBtn = wrapper.find(".mp-fav-btn");
    expect(heartBtn.find("svg").exists()).toBe(true);
    await heartBtn.trigger("click");
    expect(state.favorites).toContain(song.path);
    const fetchCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      fetchCalls.some(([url, opt]) => url === "/api/favorites/toggle" && opt.method === "POST"),
    ).toBe(true);
  });

  it("已收藏歌曲：❤️ 点亮", () => {
    state.favorites = [song.path];
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-fav-btn").classes()).toContain("on");
  });

  it("无歌时：歌名占位，❤️ ➕ 禁用", () => {
    state.currentIndex = -1;
    state.currentSong = null;
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-song-name").text()).toBe("未选择歌曲");
    expect(wrapper.find(".mp-fav-btn").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".mp-add-btn").attributes("disabled")).toBeDefined();
  });

  it("🎤 进入跟唱模式；跟唱页保持现状（全屏 KaraokePanel + karaoke 控制条）", async () => {
    const wrapper = mount(MobilePlayer);
    expect(state.mode).toBe("continuous");
    await wrapper.find(".mp-karaoke-btn").trigger("click");
    expect(state.mode).toBe("karaoke");
    expect(wrapper.find(".mp-karaoke").exists()).toBe(true);
    expect(wrapper.find(".mp-karaoke .karaoke-panel").exists()).toBe(true);
    expect(wrapper.find(".controls.karaoke").exists()).toBe(true);
  });
});

describe("MobilePlayer ➕ 加到歌单面板", () => {
  it("打开面板：列出歌单 + 点击加入（toast + 后端调用 + 勾选态）", async () => {
    state.playlists = [playlist];
    const wrapper = mount(MobilePlayer);
    await wrapper.find(".mp-add-btn").trigger("click");
    expect(wrapper.find(".mp-sheet").exists()).toBe(true);
    expect(wrapper.find(".mp-pl-row").text()).toContain("日语精选");

    await wrapper.find(".mp-pl-row").trigger("click");
    await flushPromises();
    expect(playlist.songPaths).toContain(song.path); // 乐观更新
    expect(wrapper.find(".mp-pl-row").classes()).toContain("checked"); // 勾选态
    const fetchCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      fetchCalls.some(([url, opt]) => url === "/api/playlists/p1/songs" && opt.method === "POST"),
    ).toBe(true);
  });

  it("已在歌单：点击移除", async () => {
    state.playlists = [{ ...playlist, songPaths: [song.path] }];
    const wrapper = mount(MobilePlayer);
    await wrapper.find(".mp-add-btn").trigger("click");
    expect(wrapper.find(".mp-pl-row").classes()).toContain("checked");
    await wrapper.find(".mp-pl-row").trigger("click");
    await flushPromises();
    expect(state.playlists[0].songPaths).not.toContain(song.path);
    const fetchCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      fetchCalls.some(
        ([url, opt]) =>
          url === `/api/playlists/p1/songs/${encodeURIComponent(song.path)}` &&
          opt.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("新建歌单并自动加入当前歌曲", async () => {
    state.playlists = [];
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url, opt) => {
      if (url === "/api/playlists" && opt?.method === "POST") {
        return { ok: true, json: async () => ({ id: "p-new", name: "新歌单", songPaths: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    const wrapper = mount(MobilePlayer);
    await wrapper.find(".mp-add-btn").trigger("click");
    expect(wrapper.find(".mp-sheet-empty").text()).toContain("还没有歌单");
    await wrapper.find(".mp-pl-input").setValue("新歌单");
    await wrapper.find(".mp-pl-create-btn").trigger("click");
    await flushPromises();
    const created = state.playlists.find((p) => p.id === "p-new");
    expect(created).toBeTruthy();
    expect(created!.songPaths).toContain(song.path);
    expect(wrapper.find(".mp-sheet").exists()).toBe(false); // 面板关闭
  });
});

describe("MobilePlayer 歌单键面板（播放队列）", () => {
  it("打开：显示当前播放队列（当前曲目高亮）+ 关闭按钮", async () => {
    const wrapper = mount(MobilePlayer);
    await wrapper.find(".mp-queue-btn").trigger("click");
    expect(wrapper.find(".mp-sheet-title").text()).toContain("播放队列");
    const row = wrapper.find(".mp-queue-row");
    expect(row.exists()).toBe(true);
    expect(row.text()).toContain("雪の華");
    expect(row.classes()).toContain("current");
    // 关闭
    await wrapper.find(".mp-sheet-close").trigger("click");
    expect(wrapper.find(".mp-sheet").exists()).toBe(false);
  });

  it("下半部分快捷入口：收藏 → emit open-list（favorites）", async () => {
    const wrapper = mount(MobilePlayer);
    await wrapper.find(".mp-queue-btn").trigger("click");
    const quicks = wrapper.findAll(".mp-quick");
    expect(quicks.length).toBe(2);
    await quicks[0].trigger("click");
    expect(wrapper.emitted("open-list")).toBeTruthy();
    expect(wrapper.emitted("open-list")![0][0]).toMatchObject({ name: "list", kind: "favorites" });
  });

  it("快捷入口：歌单库 → emit open-list（playlists）", async () => {
    const wrapper = mount(MobilePlayer);
    await wrapper.find(".mp-queue-btn").trigger("click");
    const quicks = wrapper.findAll(".mp-quick");
    await quicks[1].trigger("click");
    expect(wrapper.emitted("open-list")![0][0]).toMatchObject({ name: "list", kind: "playlists" });
  });
});

describe("MobilePlayer 月亮键（睡眠定时器）", () => {
  it("打开面板：关闭 + 5 档时长选项", async () => {
    const wrapper = mount(MobilePlayer);
    await wrapper.find(".mp-moon-btn").trigger("click");
    expect(wrapper.find(".mp-sheet-title").text()).toContain("睡眠定时器");
    const opts = wrapper.findAll(".mp-sleep-opt");
    expect(opts.length).toBe(6); // 关闭 + 15/30/45/60/90
    expect(opts[0].text()).toContain("关闭");
    expect(opts[1].text()).toContain("15");
  });

  it("选择 15 分钟 → 选中即激活倒计时；月亮高亮 + 附近小字", async () => {
    const wrapper = mount(MobilePlayer);
    await wrapper.find(".mp-moon-btn").trigger("click");
    const opts = wrapper.findAll(".mp-sleep-opt");
    await opts[1].trigger("click"); // 15 分钟
    await nextTick();
    expect(sleepTimer.active).toBe(true);
    expect(sleepTimer.remaining).toBeGreaterThanOrEqual(15 * 60 - 2);
    expect(wrapper.find(".mp-moon-btn").classes()).toContain("on");
    expect(wrapper.find(".mp-sleep-timer").exists()).toBe(true);
    expect(wrapper.find(".mp-sleep-timer").text()).toContain("睡眠定时器");
  });

  it("选择 关闭 → 取消倒计时", async () => {
    const { toggleSleepTimer } = await import("../composables/useSleepTimer.js");
    toggleSleepTimer(); // 先激活
    const wrapper = mount(MobilePlayer);
    await wrapper.find(".mp-moon-btn").trigger("click");
    const opts = wrapper.findAll(".mp-sleep-opt");
    await opts[0].trigger("click"); // 关闭
    await nextTick();
    expect(sleepTimer.active).toBe(false);
    expect(wrapper.find(".mp-sleep-timer").exists()).toBe(false);
  });

  it("定时器激活时（外部开关）月亮高亮 + 显示倒计时", async () => {
    const { toggleSleepTimer } = await import("../composables/useSleepTimer.js");
    toggleSleepTimer();
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-moon-btn").classes()).toContain("on");
    expect(wrapper.find(".mp-sleep-timer").exists()).toBe(true);
    expect(wrapper.find(".mp-sleep-timer").text()).toContain("睡眠定时器");
  });
});

describe("MobilePlayer 毛玻璃背景", () => {
  it("glassCover 开启（默认 true）→ 渲染毛玻璃背景层", () => {
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-glass").exists()).toBe(true);
    expect(wrapper.find(".mp-glass .mp-glass-img").exists()).toBe(true);
  });

  it("glassCover 关闭 → 无毛玻璃（回退渐变）", () => {
    uiSettings.glassCover = false;
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-glass").exists()).toBe(false);
    expect(wrapper.find(".mp-gradient").exists()).toBe(true);
  });

  it("glassCover 未定义（契约兼容）→ 默认开启", () => {
    delete (uiSettings as { glassCover?: boolean }).glassCover;
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-glass").exists()).toBe(true);
  });
});

describe("MobilePlayer 跟唱模式（karaoke）", () => {
  it("直接渲染歌词面板 + karaoke 控制条", () => {
    state.mode = "karaoke";
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-karaoke").exists()).toBe(true);
    expect(wrapper.find(".mp-karaoke .karaoke-panel").exists()).toBe(true);
    expect(wrapper.find(".controls.karaoke").exists()).toBe(true);
  });

  it("面板头默认显示（headless 仅连播模式启用）", () => {
    state.mode = "karaoke";
    state.lyric = [{ type: "line", s: 0, e: 10, text: ["第一句"] }];
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-karaoke .kp-head").exists()).toBe(true);
  });

  it("跟唱界面提供返回音乐按钮（←）", () => {
    state.mode = "karaoke";
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find('.controls .btn[title="返回音乐"]').exists()).toBe(true);
  });
});

describe("MobilePlayer 进度条与杂项", () => {
  it("进度条拖动 → seek 更新播放时间", async () => {
    state.duration = 240;
    const { audio } = await import("../composables/usePlayer.js");
    audio.src = "file:///x.mp3"; // seek 前置条件：有源才可 seek
    const wrapper = mount(MobilePlayer);
    const bar = wrapper.find(".mp-progress");
    await bar.setValue("120");
    expect(state.currentTime).toBe(120);
  });

  it("挂载时置 window.__qqpPlayerOpen，卸载时清除", () => {
    const wrapper = mount(MobilePlayer);
    expect((window as Window & { __qqpPlayerOpen?: boolean }).__qqpPlayerOpen).toBe(true);
    wrapper.unmount();
    expect((window as Window & { __qqpPlayerOpen?: boolean }).__qqpPlayerOpen).toBe(false);
  });
});

describe("MobilePlayer showCover 开关（播放页封面是核心 UI，隐藏封面图但保留手势区）", () => {
  it("showCover=false：封面图隐藏，但 mp-cover-area 手势区保留（下拉返回/横滑切歌不失效）", () => {
    uiSettings.showCover = false;
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-cover-area").exists()).toBe(true);
    expect(wrapper.find(".mp-cover-box").exists()).toBe(false);
    // 歌词区仍渲染（flex 自动上移占满）
    expect(wrapper.find(".mp-lyric-area .karaoke-panel").exists()).toBe(true);
    uiSettings.showCover = true;
  });

  it("showCover=true：封面图正常渲染（回归）", () => {
    uiSettings.showCover = true;
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-cover-area .mp-cover-box").exists()).toBe(true);
    expect(wrapper.find(".mp-cover-img").exists()).toBe(true);
  });
});
