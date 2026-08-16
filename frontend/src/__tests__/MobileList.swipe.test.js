// MobileList 左滑操作测试（任务 I-11）
// 覆盖：左滑展开操作区 / 操作区收藏 / 操作区移除（songs=队列、playlist=歌单）/ 互斥展开 / 右滑收起 / 滑动后点击不播放
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Sortable mock（歌单视图启用拖拽）
const sortableMock = vi.hoisted(() => ({
  create: vi.fn((el, opts) => {
    sortableMock.onEnd = opts.onEnd;
    return { destroy: vi.fn() };
  }),
  onEnd: null,
}));
vi.mock("sortablejs", () => ({
  default: { create: sortableMock.create },
}));

// Audio stub
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
    this.listeners["play"]?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const MobileList = (await import("../components/mobile/MobileList.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { clearToasts, useToast } = await import("../composables/useToast.js");

const lib = [
  { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
  { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" },
  { id: "c", path: "/lib/c.mp3", name: "突然好想你", artist: "五月天", album: "后青春期的诗" },
];

const playlist = { id: "p1", name: "我的歌单", songPaths: ["/lib/a.mp3", "/lib/c.mp3"] };

function fireTouch(el, type, touches, changedTouches) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  if (touches) Object.defineProperty(ev, "touches", { value: touches, configurable: true });
  if (changedTouches)
    Object.defineProperty(ev, "changedTouches", { value: changedTouches, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

// 对某一行做横向滑动（dx 负 = 左滑露出操作区，正 = 右滑收起）
async function swipeRow(rowEl, dx = -130) {
  const startX = 200;
  fireTouch(rowEl, "touchstart", [{ clientX: startX, clientY: 40 }]);
  fireTouch(rowEl, "touchmove", [{ clientX: startX + dx, clientY: 40 }]);
  fireTouch(rowEl, "touchend", [], [{ clientX: startX + dx, clientY: 40 }]);
  await flushPromises();
}

function rowTransform(row) {
  return row.attributes("style") || "";
}

beforeEach(() => {
  // 注意：removeFromQueue/removeFromPlaylist 会原地 splice，必须用新数组，否则跨用例污染 lib/playlist
  Object.assign(state, {
    songs: lib.map((s) => ({ ...s })),
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [{ ...playlist, songPaths: [...playlist.songPaths] }],
    activePlaylistId: null,
  });
  clearToasts();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountList(props = {}) {
  return mount(MobileList, { props: { kind: "songs", title: "全部歌曲", ...props } });
}

describe("MobileList 左滑操作（swipe-reveal）", () => {
  it("左滑行 → 露出操作区（行左移 168px）", async () => {
    const wrapper = mountList();
    const rows = wrapper.findAll(".ml-item");
    await swipeRow(rows[0].element, -130);
    expect(wrapper.findAll(".ml-wrap")[0].classes()).toContain("open");
    expect(rowTransform(wrapper.findAll(".ml-item")[0])).toContain("-168px");
    // 操作区按钮已渲染
    expect(wrapper.find(".ml-actions .ml-act").exists()).toBe(true);
    expect(wrapper.find(".ml-actions .ml-act-remove").exists()).toBe(true);
  });

  it("操作区收藏 → toggleFavorite（乐观更新 + 调接口），执行后收起", async () => {
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    await wrapper.find(".ml-actions .ml-act").trigger("click");
    expect(state.favorites).toContain("/lib/a.mp3");
    const fetchCalls = vi.mocked(fetch).mock.calls;
    expect(
      fetchCalls.some(([url, opt]) => url === "/api/favorites/toggle" && opt.method === "POST"),
    ).toBe(true);
    expect(wrapper.findAll(".ml-wrap")[0].classes()).not.toContain("open"); // 收起
  });

  it("操作区移除（songs 视图）→ removeFromQueue（队列缩短）+ toast「已移除」", async () => {
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    await wrapper.find(".ml-actions .ml-act-remove").trigger("click");
    await flushPromises();
    expect(state.songs.map((s) => s.path)).toEqual(["/lib/b.mp3", "/lib/c.mp3"]);
    expect(useToast().items[0].text).toBe("已移除");
    expect(wrapper.findAll(".ml-item").length).toBe(2); // 行已消失
  });

  it("操作区移除（playlist 视图）→ removeFromPlaylist（DELETE /api/playlists/:id/songs）", async () => {
    const wrapper = mountList({
      kind: "playlist",
      title: "我的歌单",
      payload: { playlist: { ...playlist, songPaths: [...playlist.songPaths] } },
    });
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    await wrapper.find(".ml-actions .ml-act-remove").trigger("click");
    await flushPromises();
    expect(state.playlists[0].songPaths).toEqual(["/lib/c.mp3"]);
    const fetchCalls = vi.mocked(fetch).mock.calls;
    expect(
      fetchCalls.some(
        ([url, opt]) =>
          url === "/api/playlists/p1/songs/" + encodeURIComponent("/lib/a.mp3") &&
          opt.method === "DELETE",
      ),
    ).toBe(true);
    expect(useToast().items[0].text).toBe("已移除");
  });

  it("同一时间只展开一行：滑动第二行时第一行收起", async () => {
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    expect(wrapper.findAll(".ml-wrap")[0].classes()).toContain("open");
    await swipeRow(wrapper.findAll(".ml-item")[1].element, -130);
    const wraps = wrapper.findAll(".ml-wrap");
    expect(wraps[0].classes()).not.toContain("open");
    expect(wraps[1].classes()).toContain("open");
  });

  it("右滑已展开的行 → 收起", async () => {
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    expect(wrapper.findAll(".ml-wrap")[0].classes()).toContain("open");
    await swipeRow(wrapper.findAll(".ml-item")[0].element, +130);
    expect(wrapper.findAll(".ml-wrap")[0].classes()).not.toContain("open");
  });

  it("滑动结束后点击行 → 点击被抑制（不播放），行保持展开；再次点击收起", async () => {
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    expect(wrapper.findAll(".ml-wrap")[0].classes()).toContain("open");
    // 第一次点击：滑动伴随的 click 被抑制，不播放、不收起
    await wrapper.findAll(".ml-item")[0].trigger("click");
    expect(wrapper.emitted("play")).toBeFalsy();
    expect(wrapper.findAll(".ml-wrap")[0].classes()).toContain("open");
    // 第二次点击：收起
    await wrapper.findAll(".ml-item")[0].trigger("click");
    expect(wrapper.findAll(".ml-wrap")[0].classes()).not.toContain("open");
    expect(wrapper.emitted("play")).toBeFalsy();
  });

  it("左滑前先轻触另一行 → 之前展开的行收起（点空白/点他行收起）", async () => {
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    expect(wrapper.findAll(".ml-wrap")[0].classes()).toContain("open");
    // 轻触（不滑动）第二行：touchstart + touchend 带 touches
    const row1 = wrapper.findAll(".ml-item")[1].element;
    fireTouch(row1, "touchstart", [{ clientX: 200, clientY: 40 }]);
    fireTouch(row1, "touchend", [], [{ clientX: 200, clientY: 40 }]);
    await flushPromises();
    expect(wrapper.findAll(".ml-wrap")[0].classes()).not.toContain("open");
  });

  it("未滑动时点击行 → 照常触发播放（保留原有行为）", async () => {
    const wrapper = mountList();
    await wrapper.findAll(".ml-item")[1].trigger("click");
    const plays = wrapper.emitted("play");
    expect(plays).toBeTruthy();
    expect(plays[0][0].path).toBe("/lib/b.mp3");
  });
});
