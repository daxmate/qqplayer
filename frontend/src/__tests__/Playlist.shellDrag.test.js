// Playlist.vue 壳内拖拽测试（任务 B）：WKWebView 无 HTML5 DnD → Pointer Events 模拟
// 覆盖：全部歌曲视图排序（reorderQueue + persistQueueOrder）、歌单视图排序（setPlaylistOrder）、
//      拖到侧栏歌单（sb-drop 高亮 + addToPlaylist + toast「已加入/已在」）、网络歌可排序不可加歌单、
//      阈值内单击不触发（行点击播放照常）、拖拽后 click 被吞（不误播放）、canDrag=false 禁用、
//      拖出列表外不排序、卸载清理、拖拽中源行跟随指针
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  static instances = [];
  constructor() {
    this.src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
    FakeAudio.instances.push(this);
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
  removeAttribute() {}
}
vi.stubGlobal("Audio", FakeAudio);

const Playlist = (await import("../components/Playlist.vue")).default;
const Sidebar = (await import("../components/Sidebar.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { useToast, clearToasts } = await import("../composables/useToast.js");

const SONGS = [
  { id: "a", name: "A歌", artist: "五月天", path: "/a.mp3" },
  { id: "b", name: "B歌", artist: "高橋優", path: "/b.mp3" },
  { id: "c", name: "C歌", artist: "五月天", path: "/c.mp3" },
];
const PLAYLISTS = [
  {
    id: "p1",
    name: "旅行",
    songPaths: ["/a.mp3", "/b.mp3", "/c.mp3"],
    createdAt: "",
    updatedAt: "",
  },
];

// —— 几何 stub：jsdom 的 getBoundingClientRect 恒为 0，且无 elementFromPoint，
// —— 拖拽命中（列表/行/歌单项）全靠几何判断，测试按元素注入假 rect ——
const realRect = Element.prototype.getBoundingClientRect;
const rectMap = new WeakMap();
Element.prototype.getBoundingClientRect = function () {
  const r = rectMap.get(this);
  return r || realRect.call(this);
};
function setRect(el, r) {
  rectMap.set(el, { x: r.left, y: r.top, width: r.width, height: r.height, ...r });
}

const ROW_H = 40; // 行高（行中心 = top + 20）
const ROW_W = 400;

// 给 .pl-item 与 .pl-list 注入纵向堆叠 rect（行中心 120/160/200…）
function layoutRows(wrapper, top = 100) {
  const rows = wrapper.findAll(".pl-item");
  rows.forEach((row, i) => {
    setRect(row.element, {
      top: top + i * ROW_H,
      bottom: top + (i + 1) * ROW_H,
      left: 0,
      right: ROW_W,
      height: ROW_H,
      width: ROW_W,
    });
  });
  const list = wrapper.find(".pl-list");
  if (list.exists()) {
    setRect(list.element, {
      top,
      bottom: top + rows.length * ROW_H + 12,
      left: 0,
      right: ROW_W,
      height: rows.length * ROW_H + 12,
      width: ROW_W,
    });
  }
  return rows;
}

// 给侧边栏歌单项注入右侧 rect（左缘 420，避开列表右缘 400）
function layoutSidebar(wrapper, top = 100, left = 420) {
  const items = wrapper.findAll(".sb-item[data-playlist-id]");
  items.forEach((item, i) => {
    setRect(item.element, {
      top: top + i * 44,
      bottom: top + (i + 1) * 44,
      left,
      right: left + 200,
      height: 44,
      width: 200,
    });
  });
  return items;
}

const wrappers = [];

function mountBoth() {
  const pw = mount(Playlist, { attachTo: document.body });
  const sw = mount(Sidebar, { attachTo: document.body });
  wrappers.push(pw, sw);
  return { pw, sw };
}

function toastText() {
  return useToast()
    .items.map((i) => i.text)
    .join(" ");
}

// pointer 事件工厂（主指针 id=1，左键）；坐标支持 (x, y) 或数组 [x, y]
function ptr(type, x, y, over = {}) {
  if (Array.isArray(x)) [x, y] = x;
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    ...over,
  });
}

// 完整拖拽序列：handle 上按下 → 分步 move（超过 5px 阈值）→ 松手
async function dragHandle(handle, from, to, steps = 5) {
  handle.dispatchEvent(ptr("pointerdown", from[0], from[1]));
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    document.body.dispatchEvent(ptr("pointermove", x, y));
  }
  document.body.dispatchEvent(ptr("pointerup", to[0], to[1]));
  await nextTick();
}

const okFetch = () => vi.fn(async () => ({ ok: true, json: async () => ({}) }));

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    loading: false,
    error: "",
    favorites: [],
    playlists: [],
    activePlaylistId: null,
  });
  state.songs = SONGS.map((s) => ({ ...s }));
  // 模拟壳环境（setupSortable 在 mount 时判断，需先于 mount 设置）
  window.qqplayerNative = true;
});

afterEach(() => {
  delete window.qqplayerNative;
  vi.unstubAllGlobals();
  clearToasts();
  wrappers.splice(0).forEach((w) => w.unmount());
  // 注意：不恢复 Element.prototype.getBoundingClientRect（文件级 stub，恢复了后续测试 rect 全零）
  document.body.innerHTML = "";
});

describe("壳内拖拽排序", () => {
  it("全部歌曲视图：拖行越过相邻行中心 → reorderQueue + persistQueueOrder", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    // A(中心120) 拖到 B(160) 与 C(200) 之间（dc=175）→ [B, A, C]
    await dragHandle(pw.findAll(".pl-drag")[0].element, [10, 120], [10, 175]);
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "A歌", "C歌"]);
    const put = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/queue/order"));
    expect(put).toBeTruthy();
    expect(JSON.parse(put[1].body).paths).toEqual(["/b.mp3", "/a.mp3", "/c.mp3"]);
  });

  it("全部歌曲视图：往下拖越过多行 → 插到末尾", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    // A(120) 拖到 C 之下（dc=230，越过 B160/C200）→ [B, C, A]
    await dragHandle(pw.findAll(".pl-drag")[0].element, [10, 120], [10, 230]);
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "C歌", "A歌"]);
  });

  it("全部歌曲视图：往上拖 → 插到顶部", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    // C(200) 拖到 A(120) 之上且仍在列表内（dc=110 < A 中心 120）→ [C, A, B]
    // 注意：列表 top=100，拖到 y<100 会触发“拖出列表外不排序”语义，故用 y=110
    await dragHandle(pw.findAll(".pl-drag")[2].element, [10, 200], [10, 110]);
    expect(state.songs.map((s) => s.name)).toEqual(["C歌", "A歌", "B歌"]);
  });

  it("歌单视图：拖行 → setPlaylistOrder 新顺序（fetch /api/playlists/p1/order）", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    state.playlists = PLAYLISTS.map((p) => ({ ...p, songPaths: [...p.songPaths] }));
    state.activePlaylistId = "p1";
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    // C(200) 拖到 A(120) 与 B(160) 之间（dc=135）→ [A, C, B]
    await dragHandle(pw.findAll(".pl-drag")[2].element, [10, 200], [10, 135]);
    expect(state.playlists[0].songPaths).toEqual(["/a.mp3", "/c.mp3", "/b.mp3"]);
    const put = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/playlists/p1/order"));
    expect(put).toBeTruthy();
    expect(JSON.parse(put[1].body).paths).toEqual(["/a.mp3", "/c.mp3", "/b.mp3"]);
  });

  it("拖拽中源行跟随指针（transform 随位移更新，松手还原）", async () => {
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    const handle = pw.findAll(".pl-drag")[0].element;
    const row0 = pw.findAll(".pl-item")[0].element;
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [10, 145])); // 25px > 阈值
    expect(row0.classList.contains("pl-drag-source")).toBe(true);
    expect(row0.style.transform).toBe("translateY(25px)");
    document.body.dispatchEvent(ptr("pointermove", [10, 170]));
    expect(row0.style.transform).toBe("translateY(50px)");
    document.body.dispatchEvent(ptr("pointerup", [10, 170]));
    await nextTick();
    expect(row0.style.transform).toBe("");
    expect(row0.classList.contains("pl-drag-source")).toBe(false);
  });

  it("拖出列表外松手 → 不排序", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    // 拖到列表下方空白（y=300 超出列表 bottom=232）且不在歌单上
    await dragHandle(pw.findAll(".pl-drag")[0].element, [10, 120], [10, 300]);
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌", "C歌"]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/queue/order"))).toBe(false);
  });
});

describe("壳内拖到侧栏歌单", () => {
  it("悬停歌单项 → sb-drop 高亮；松手 → addToPlaylist + toast「已加入」+ 高亮清理", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    state.playlists = [{ id: "p2", name: "日语歌", songPaths: [], createdAt: "", updatedAt: "" }];
    const { pw, sw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    const items = layoutSidebar(sw);
    const handle = pw.findAll(".pl-drag")[0].element;
    // 拖到歌单项内（430,120 在 p2 rect 内）
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [430, 120]));
    const p2 = items[0].element;
    expect(p2.classList.contains("sb-drop")).toBe(true);
    document.body.dispatchEvent(ptr("pointerup", [430, 120]));
    await flushPromises();
    expect(state.playlists[0].songPaths).toEqual(["/a.mp3"]);
    expect(toastText()).toContain("已加入歌单「日语歌」");
    expect(p2.classList.contains("sb-drop")).toBe(false);
  });

  it("已在歌单 → toast「已在」，不重复添加", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    state.playlists = [
      { id: "p2", name: "日语歌", songPaths: ["/a.mp3"], createdAt: "", updatedAt: "" },
    ];
    const { pw, sw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    layoutSidebar(sw);
    await dragHandle(pw.findAll(".pl-drag")[0].element, [10, 120], [430, 120]);
    await flushPromises();
    expect(state.playlists[0].songPaths).toEqual(["/a.mp3"]);
    expect(toastText()).toContain("已在歌单「日语歌」中");
    expect(toastText()).not.toContain("已加入");
  });

  it("拖到歌单 → 列表内不排序（歌单语义优先）", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    state.playlists = [{ id: "p2", name: "日语歌", songPaths: [], createdAt: "", updatedAt: "" }];
    const { pw, sw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    layoutSidebar(sw);
    await dragHandle(pw.findAll(".pl-drag")[0].element, [10, 120], [430, 120]);
    await flushPromises();
    // 队列顺序没动（拖到歌单是「加歌」语义，不是「排序」）
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌", "C歌"]);
  });

  it("网络歌（path=null）：可排序，但拖到歌单不添加", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    state.songs = [
      { id: "s", name: "网歌", type: "stream", streamId: "1", path: null },
      { id: "a", name: "A歌", path: "/a.mp3" },
    ];
    state.playlists = [{ id: "p2", name: "日语歌", songPaths: [], createdAt: "", updatedAt: "" }];
    const { pw, sw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    layoutSidebar(sw);
    // 排序：网歌(中心120) 拖过 A(160) → [A, 网歌]
    await dragHandle(pw.findAll(".pl-drag")[0].element, [10, 120], [10, 190]);
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "网歌"]);
    // 加歌单：拖到歌单项 → 不派发（path=null 与浏览器 onRowDragStart preventDefault 一致）
    await dragHandle(pw.findAll(".pl-drag")[1].element, [10, 170], [430, 120]);
    await flushPromises();
    expect(state.playlists[0].songPaths).toEqual([]);
    expect(toastText()).toBe("");
  });
});

describe("壳内拖拽边界", () => {
  it("阈值内（<5px）松手 → 不拖拽不排序，click 照常触发行点击播放", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    const handle = pw.findAll(".pl-drag")[0].element;
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [12, 122])); // ~2.8px < 5
    document.body.dispatchEvent(ptr("pointerup", [12, 122]));
    await nextTick();
    expect(state.currentIndex).toBe(-1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/queue/order"))).toBe(false);
    // click 未被拦截 → 行点击播放
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong.name).toBe("A歌");
  });

  it("拖拽（超阈值）松手 → 抑制 click，不误触发行点击播放", async () => {
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    const handle = pw.findAll(".pl-drag")[0].element;
    // 拖 12px 后在原行松手（t === sourceIndex，不排序）
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [10, 132]));
    document.body.dispatchEvent(ptr("pointerup", [10, 132]));
    // 浏览器在 mouseup 后会派发 click → 应被抑制
    handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(state.currentIndex).toBe(-1);
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌", "C歌"]);
  });

  it("过滤状态（搜索 五月天）：拖到侧栏歌单仍生效（sb-drop 高亮 + addToPlaylist）", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    state.playlists = [{ id: "p2", name: "日语歌", songPaths: [], createdAt: "", updatedAt: "" }];
    const { pw, sw } = mountBoth();
    await nextTick();
    await pw.find(".pl-search input").setValue("五月天");
    await nextTick();
    await nextTick(); // watch → nextTick(setupSortable) 的二次 tick
    expect(pw.findAll(".pl-drag")).toHaveLength(2); // 过滤后 2 行可见，手柄仍在
    layoutRows(pw);
    const items = layoutSidebar(sw);
    const p2 = items[0].element;
    const handle = pw.findAll(".pl-drag")[0].element;
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [430, 120]));
    expect(p2.classList.contains("sb-drop")).toBe(true); // 歌单悬停高亮照常
    document.body.dispatchEvent(ptr("pointerup", [430, 120]));
    await flushPromises();
    expect(state.playlists[0].songPaths).toEqual(["/a.mp3"]);
    expect(toastText()).toContain("已加入歌单「日语歌」");
    expect(p2.classList.contains("sb-drop")).toBe(false);
  });

  it("过滤状态（搜索 五月天）：列表内拖动不触发 reorder、不显示插入线（getCanReorder=false）", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { pw } = mountBoth();
    await nextTick();
    await pw.find(".pl-search input").setValue("五月天");
    await nextTick();
    await nextTick();
    layoutRows(pw);
    // 拖过 C 行中心（dc=175 > C 中心 160）→ 若允许排序应变为 [C, A]，现在必须不动
    await dragHandle(pw.findAll(".pl-drag")[0].element, [10, 120], [10, 175]);
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌", "C歌"]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/queue/order"))).toBe(false);
  });

  it("过滤状态：列表内拖动不显示插入指示线（悬停歌单时列表内也无指示）", async () => {
    const { pw } = mountBoth();
    await nextTick();
    await pw.find(".pl-search input").setValue("五月天");
    await nextTick();
    await nextTick();
    layoutRows(pw);
    const handle = pw.findAll(".pl-drag")[0].element;
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [10, 175]));
    expect(pw.findAll(".pl-drop-before, .pl-drop-after").length).toBe(0);
    document.body.dispatchEvent(ptr("pointerup", [10, 175]));
    await nextTick();
  });

  it("非过滤状态：列表内拖动显示插入指示线（getCanReorder=true）", async () => {
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    const handle = pw.findAll(".pl-drag")[0].element;
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [10, 175]));
    // t=1 → B 行后插入线（pl-drop-after）
    expect(pw.findAll(".pl-drop-before, .pl-drop-after").length).toBeGreaterThan(0);
    document.body.dispatchEvent(ptr("pointerup", [10, 175]));
    await nextTick();
    expect(pw.findAll(".pl-drop-before, .pl-drop-after").length).toBe(0); // 松手清理
  });

  it("拖拽中 canReorder 变 false（搜索）→ 清理拖拽态，后续事件无动作", async () => {
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    const handle = pw.findAll(".pl-drag")[0].element;
    const row0 = pw.findAll(".pl-item")[0].element;
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [10, 140]));
    expect(row0.style.transform).toBe("translateY(20px)");
    await pw.find(".pl-search input").setValue("x");
    await nextTick();
    await nextTick(); // watch → nextTick(setupSortable) 的二次 tick
    expect(row0.style.transform).toBe("");
    document.body.dispatchEvent(ptr("pointerup", [10, 140])); // 监听已移除
    await nextTick();
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌", "C歌"]);
  });

  it("卸载 → 清理监听与拖拽态（残留事件不产生动作）", async () => {
    const { pw } = mountBoth();
    await nextTick();
    layoutRows(pw);
    const handle = pw.findAll(".pl-drag")[0].element;
    const row0 = pw.findAll(".pl-item")[0].element;
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [10, 140]));
    expect(row0.classList.contains("pl-drag-source")).toBe(true);
    const i = wrappers.indexOf(pw);
    if (i >= 0) wrappers.splice(i, 1);
    pw.unmount();
    expect(row0.style.transform).toBe("");
    expect(row0.classList.contains("pl-drag-source")).toBe(false);
    // 监听已移除：move/up 不产生任何动作
    document.body.dispatchEvent(ptr("pointermove", [10, 220]));
    document.body.dispatchEvent(ptr("pointerup", [10, 220]));
    await nextTick();
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌", "C歌"]);
    expect(state.currentIndex).toBe(-1);
  });
});
