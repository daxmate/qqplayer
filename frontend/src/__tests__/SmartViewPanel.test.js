// SmartViewPanel 组件测试（桌面智能视图面板：渲染/空态/加载/错误/点击播放）
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
}
vi.stubGlobal("Audio", FakeAudio);

const SmartViewPanel = (await import("../components/SmartViewPanel.vue")).default;
const Sidebar = (await import("../components/Sidebar.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { DRAG_SONG_TYPE } = await import("../composables/usePlayer.js");
const { closeSmartView } = await import("../composables/useSmartViews.js");
const { useToast, clearToasts } = await import("../composables/useToast.js");

const lib = [
  { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
  { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" },
  { id: "c", path: "/lib/c.mp3", name: "温柔", artist: "五月天", album: "愛情萬歲" },
];

const wrappers = []; // 统一登记：断言失败也卸载，避免旧实例残留 window 监听（ctx 事件会串到新测试）

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.assign(state, {
    // 拷贝：队列操作（下一首播放/删除）会 splice state.songs，不能污染共享常量
    songs: lib.map((s) => ({ ...s })),
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
  });
  closeSmartView();
  // 模拟桌面布局：播放列表面板作为智能视图的定位锚点
  const main = document.createElement("div");
  main.className = "main";
  main.innerHTML = '<div class="playlist"></div>';
  document.body.appendChild(main);
});

afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  document.body.innerHTML = "";
  delete window.qqplayerNative;
  clearToasts();
  vi.unstubAllGlobals();
});

function mountPanel(kind) {
  const wrapper = mount(SmartViewPanel, {
    props: { kind },
    global: { stubs: { teleport: true } }, // teleport 内容内联渲染，便于断言
  });
  wrappers.push(wrapper);
  return wrapper;
}

function fetchReturning(body) {
  return vi.fn(async () => ({ ok: true, json: async () => body }));
}

// 右键第 index 行 → 浏览器自定义菜单展开（@contextmenu.prevent → openCtxMenu）
async function rclick(wrapper, index, x = 120, y = 180) {
  await wrapper.findAll(".sv-item")[index].trigger("contextmenu", { clientX: x, clientY: y });
  await nextTick();
}

// teleport 被 stub 后菜单内联渲染在 wrapper 内（不在 document.body），用 wrapper 查询
const menuEl = (wrapper) =>
  wrapper.find(".ctx-menu").exists() ? wrapper.find(".ctx-menu").element : null;

function menuItem(wrapper, text) {
  const btns = [...wrapper.findAll(".ctx-item")];
  return btns.find((b) => b.text().trim() === text) || btns.find((b) => b.text().includes(text));
}

// addMenu / dt-modal 同样内联在 wrapper 内
const addMenuEl = (wrapper) =>
  wrapper.find(".add-menu").exists() ? wrapper.find(".add-menu").element : null;
const deleteModalEl = (wrapper) =>
  wrapper.find(".dt-modal").exists() ? wrapper.find(".dt-modal").element : null;

describe("SmartViewPanel（桌面）", () => {
  it("渲染视图标题与歌曲行（最近播放）", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning({
        records: [
          { path: "/lib/b.mp3", name: "知足", ts: "2026-08-13T10:00:00Z" },
          { path: "/lib/a.mp3", name: "雪の華", ts: "2026-08-13T09:00:00Z" },
        ],
      }),
    );
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    expect(wrapper.find(".sv-title").text()).toBe("最近播放");
    const items = wrapper.findAll(".sv-item");
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain("知足");
    expect(items[0].text()).toContain("五月天");
    expect(items[1].text()).toContain("雪の華");
    expect(wrapper.find(".sv-count").text()).toContain("2");
  });

  it("最近添加：直接用库顺序渲染（不发请求）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    const items = wrapper.findAll(".sv-item");
    expect(items.some((i) => i.text().includes("雪の華"))).toBe(true);
  });

  it("常听排行：显示播放次数副信息", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning({
        songs: [
          { path: "/lib/c.mp3", plays: 11, totalPlayed: 524 },
          { path: "/lib/a.mp3", plays: 2, totalPlayed: 100 },
        ],
      }),
    );
    const wrapper = mountPanel("topPlayed");
    await flushPromises();
    expect(wrapper.findAll(".sv-item")).toHaveLength(2);
    expect(wrapper.find(".sv-item").text()).toContain("播放 11 次");
  });

  it("空态：无播放记录显示提示文案", async () => {
    vi.stubGlobal("fetch", fetchReturning({ records: [] }));
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    expect(wrapper.find(".sv-empty").text()).toBe("暂无播放记录");
  });

  it("加载中显示加载提示", async () => {
    let resolveFetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    expect(wrapper.find(".sv-empty").text()).toBe("加载中…");
    resolveFetch({ ok: true, json: async () => ({ records: [] }) });
    await flushPromises();
  });

  it("接口失败显示错误信息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    expect(wrapper.find(".sv-empty").exists()).toBe(true);
    expect(wrapper.find(".sv-empty").text()).toBeTruthy();
  });

  it("点击行触发播放（selectSong + play）", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning({
        records: [{ path: "/lib/b.mp3", name: "知足", ts: "2026-08-13T10:00:00Z" }],
      }),
    );
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    await wrapper.find(".sv-item").trigger("click");
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("知足");
    expect(state.isPlaying).toBe(true);
  });

  it("当前播放歌曲行高亮 active", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning({
        records: [{ path: "/lib/a.mp3", name: "雪の華", ts: "2026-08-13T10:00:00Z" }],
      }),
    );
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    state.currentSong = lib[0];
    state.currentIndex = 0;
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".sv-item").classes()).toContain("active");
  });

  it("点击返回按钮触发 close 事件", async () => {
    vi.stubGlobal("fetch", fetchReturning({ records: [] }));
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    await wrapper.find(".sv-back").trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();
  });

  it("无定位锚点时面板不渲染（防溢出）", async () => {
    document.body.innerHTML = ""; // 移除 .main .playlist 锚点
    vi.stubGlobal("fetch", fetchReturning({ records: [] }));
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    expect(wrapper.find(".sv-panel").exists()).toBe(false);
  });
});

describe("SmartViewPanel 拖拽到侧栏歌单", () => {
  it("浏览器：行 dragstart → 写 DRAG_SONG_TYPE + effectAllowed=copy，浮层 pointer-events 放行后恢复", async () => {
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    const panel = wrapper.find(".sv-panel").element;
    const dt = { setData: vi.fn(), effectAllowed: "" };
    await wrapper.findAll(".sv-item")[0].trigger("dragstart", { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith(DRAG_SONG_TYPE, "/lib/a.mp3");
    expect(dt.effectAllowed).toBe("copy");
    // 浮层遮挡：拖拽期间 .sv-panel 不拦截指针（drop 才能到达侧边栏歌单项）
    expect(panel.style.pointerEvents).toBe("none");
    await wrapper.findAll(".sv-item")[0].trigger("dragend");
    expect(panel.style.pointerEvents).toBe("");
  });

  it("浏览器：网络歌（path=null）→ preventDefault，不写数据", async () => {
    state.songs = [{ id: "s", name: "网歌", path: null, artist: "" }];
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    const dt = { setData: vi.fn(), effectAllowed: "" };
    const evt = new Event("dragstart", { bubbles: true, cancelable: true });
    evt.dataTransfer = dt;
    wrapper.findAll(".sv-item")[0].element.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(dt.setData).not.toHaveBeenCalled();
    // 本地歌行正常
    expect(wrapper.findAll(".sv-item")).toHaveLength(1);
  });

  it("壳内：拖 .sv-drag 手柄到歌单项 → sb-drop 高亮 + 派发 shell-drag-drop → 加歌 + toast", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    window.qqplayerNative = true;
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: [], createdAt: "", updatedAt: "" }];
    // 先挂 Sidebar（attachTo body）再挂面板（teleport stub 内联渲染）；顺序反了面板会被真实 teleport 到 body
    const sw = mount(Sidebar, { attachTo: document.body });
    wrappers.push(sw);
    const pv = mountPanel("recentAdded");
    await flushPromises();
    // 行 rect（与 Playlist.shellDrag.test.js 同款几何 stub）
    const rows = pv.findAll(".sv-item");
    rows.forEach((row, i) =>
      setRect(row.element, {
        top: 100 + i * 40,
        bottom: 100 + (i + 1) * 40,
        left: 0,
        right: 400,
        height: 40,
        width: 400,
      }),
    );
    setRect(pv.find(".sv-list").element, {
      top: 100,
      bottom: 100 + rows.length * 40 + 12,
      left: 0,
      right: 400,
      height: rows.length * 40 + 12,
      width: 400,
    });
    const items = sw.findAll(".sb-item[data-playlist-id]");
    items.forEach((item, i) =>
      setRect(item.element, {
        top: 100 + i * 44,
        bottom: 100 + (i + 1) * 44,
        left: 420,
        right: 620,
        height: 44,
        width: 200,
      }),
    );
    expect(pv.findAll(".sv-drag")).toHaveLength(rows.length);
    const handle = pv.findAll(".sv-drag")[0].element;
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [430, 120]));
    expect(items[0].element.classList.contains("sb-drop")).toBe(true);
    document.body.dispatchEvent(ptr("pointerup", [430, 120]));
    await flushPromises();
    expect(state.playlists[0].songPaths).toEqual(["/lib/a.mp3"]);
    expect(
      useToast()
        .items.map((i) => i.text)
        .join(" "),
    ).toContain("已加入歌单「日语歌」");
    expect(items[0].element.classList.contains("sb-drop")).toBe(false);
  });

  it("壳内：拖到列表内松手 → 不排序不派发（自动歌单无排序语义）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    window.qqplayerNative = true;
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: [], createdAt: "", updatedAt: "" }];
    const pv = mountPanel("recentAdded");
    await flushPromises();
    const rows = pv.findAll(".sv-item");
    rows.forEach((row, i) =>
      setRect(row.element, {
        top: 100 + i * 40,
        bottom: 100 + (i + 1) * 40,
        left: 0,
        right: 400,
        height: 40,
        width: 400,
      }),
    );
    setRect(pv.find(".sv-list").element, {
      top: 100,
      bottom: 100 + rows.length * 40 + 12,
      left: 0,
      right: 400,
      height: rows.length * 40 + 12,
      width: 400,
    });
    // 越过第二行中心（dc=175 > 160）→ 列表内无排序回调，歌单不变
    const handle = pv.findAll(".sv-drag")[0].element;
    handle.dispatchEvent(ptr("pointerdown", [10, 120]));
    document.body.dispatchEvent(ptr("pointermove", [10, 175]));
    document.body.dispatchEvent(ptr("pointerup", [10, 175]));
    await flushPromises();
    expect(state.songs.map((s) => s.name)).toEqual(["雪の華", "知足", "温柔"]);
    expect(state.playlists[0].songPaths).toEqual([]);
  });
});

// —— 几何 stub（jsdom getBoundingClientRect 恒 0，壳内拖拽命中全靠几何，同 Playlist.shellDrag.test.js 模式）——
const realRect = Element.prototype.getBoundingClientRect;
const rectMap = new WeakMap();
Element.prototype.getBoundingClientRect = function () {
  const r = rectMap.get(this);
  return r || realRect.call(this);
};
function setRect(el, r) {
  rectMap.set(el, { x: r.left, y: r.top, width: r.width, height: r.height, ...r });
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
describe("SmartViewPanel 右键菜单（浏览器 ContextMenu）", () => {
  it("右键歌曲行 → 弹出菜单（播放/下一首/收藏/加歌单/进歌手/进专辑/移到废纸篓）", async () => {
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    await rclick(wrapper, 0);
    expect(menuEl(wrapper)).toBeTruthy();
    const text = menuEl(wrapper).textContent;
    expect(text).toContain("播放");
    expect(text).toContain("下一首播放");
    expect(text).toContain("收藏");
    expect(text).toContain("加歌单");
    expect(text).toContain("进歌手");
    expect(text).toContain("进专辑");
    expect(text).toContain("移到废纸篓");
  });

  it("无歌手/专辑的歌 → 菜单不显示进歌手/进专辑", async () => {
    state.songs = [{ id: "x", path: "/x.mp3", name: "纯音乐", artist: "", album: "" }];
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    await rclick(wrapper, 0);
    expect(menuEl(wrapper).textContent).not.toContain("进歌手");
    expect(menuEl(wrapper).textContent).not.toContain("进专辑");
  });

  it("播放 → selectSong + play（与 Playlist 同行为）", async () => {
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    await rclick(wrapper, 1); // 右键 知足（lib[1]）
    menuItem(wrapper, "播放").trigger("click");
    await nextTick();
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("知足");
    expect(state.isPlaying).toBe(true);
    expect(menuEl(wrapper)).toBeFalsy(); // 菜单已关闭
  });

  it("下一首播放 → 挪到当前歌之后并播放（队列无重复）", async () => {
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    await wrapper.findAll(".sv-item")[0].trigger("click"); // 播 雪の華
    await nextTick();
    await rclick(wrapper, 2); // 右键 温柔
    menuItem(wrapper, "下一首播放").trigger("click");
    await nextTick();
    expect(state.songs.map((s) => s.name)).toEqual(["雪の華", "温柔", "知足"]);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("温柔");
  });

  it("收藏 → toggleFavorite（可再取消）", async () => {
    vi.stubGlobal("fetch", fetchReturning({}));
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    await rclick(wrapper, 0);
    menuItem(wrapper, "收藏").trigger("click");
    await nextTick();
    expect(state.favorites).toContain("/lib/a.mp3");
    // 再右键同一行 → 菜单变「取消收藏」
    await rclick(wrapper, 0);
    menuItem(wrapper, "取消收藏").trigger("click");
    await nextTick();
    expect(state.favorites).not.toContain("/lib/a.mp3");
  });

  it("加歌单 → 弹出歌单浮层，点击歌单加入", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("/api/playlists")) {
          return { ok: true, json: async () => ({ playlists: [] }) };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: [] }];
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    await rclick(wrapper, 0, 300, 200);
    menuItem(wrapper, "加歌单").trigger("click");
    await nextTick();
    const am = addMenuEl(wrapper);
    expect(am).toBeTruthy();
    expect(am.textContent).toContain("日语歌");
    await wrapper.find(".add-menu .am-item").trigger("click");
    await flushPromises();
    expect(state.playlists[0].songPaths).toEqual(["/lib/a.mp3"]);
  });

  it("移到废纸篓 → 确认弹窗 → DELETE → 刷新曲库", async () => {
    const fetchMock = vi.fn(async (url, _opts) => {
      const u = String(url);
      if (u.includes("/api/library/songs")) {
        return { ok: true, json: async () => ({ deleted: 1, missing: [], errors: [] }) };
      }
      if (u.includes("/api/songs")) return { ok: true, json: async () => lib };
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    await rclick(wrapper, 1); // 右键 知足
    menuItem(wrapper, "移到废纸篓").trigger("click");
    await nextTick();
    const modal = deleteModalEl(wrapper);
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain("将删除 1 首歌");
    await wrapper.find(".dt-modal .dt-btn.danger").trigger("click");
    await flushPromises();
    const delCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/library/songs"));
    expect(JSON.parse(delCall[1].body).paths).toEqual(["/lib/b.mp3"]);
    // 刷新曲库：loadSongs 拉 /api/songs
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/songs"))).toBe(true);
  });

  it("进歌手 → 关闭面板 + 派发 qqplayer:open-browse（App 转 Playlist 分组浏览）", async () => {
    const seen = [];
    const onBrowse = (e) => seen.push(e.detail);
    window.addEventListener("qqplayer:open-browse", onBrowse);
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    await rclick(wrapper, 0); // 右键 雪の華（中島美嘉）
    menuItem(wrapper, "进歌手").trigger("click");
    await nextTick();
    expect(seen).toEqual([{ type: "artist", value: "中島美嘉" }]);
    expect(wrapper.emitted("close")).toBeTruthy();
    window.removeEventListener("qqplayer:open-browse", onBrowse);
  });

  it("进专辑 → 派发 qqplayer:open-browse(type=album)", async () => {
    const seen = [];
    const onBrowse = (e) => seen.push(e.detail);
    window.addEventListener("qqplayer:open-browse", onBrowse);
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    await rclick(wrapper, 0);
    menuItem(wrapper, "进专辑").trigger("click");
    await nextTick();
    expect(seen).toEqual([{ type: "album", value: "雪の華" }]);
    window.removeEventListener("qqplayer:open-browse", onBrowse);
  });

  it("壳菜单事件 qqplayer:ctx-play → 播放对应歌", async () => {
    mountPanel("recentAdded");
    await flushPromises();
    window.dispatchEvent(new CustomEvent("qqplayer:ctx-play", { detail: { path: "/lib/c.mp3" } }));
    await nextTick();
    expect(state.currentIndex).toBe(2);
    expect(state.currentSong.name).toBe("温柔");
    expect(state.isPlaying).toBe(true);
  });

  it("壳菜单事件 qqplayer:ctx-deletesong → 弹出确认弹窗", async () => {
    vi.stubGlobal("fetch", fetchReturning({}));
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    window.dispatchEvent(
      new CustomEvent("qqplayer:ctx-deletesong", { detail: { path: "/lib/b.mp3" } }),
    );
    await nextTick();
    const modal = deleteModalEl(wrapper);
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain("将删除 1 首歌");
  });

  it("壳菜单事件 qqplayer:ctx-addplaylist → 弹出加歌浮层（锚定右键坐标）", async () => {
    vi.stubGlobal("fetch", fetchReturning({}));
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: [] }];
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    window.dispatchEvent(
      new CustomEvent("qqplayer:ctx-addplaylist", {
        detail: { path: "/lib/a.mp3", x: 300, y: 200 },
      }),
    );
    await nextTick();
    const am = addMenuEl(wrapper);
    expect(am).toBeTruthy();
    await wrapper.find(".add-menu .am-item").trigger("click");
    await flushPromises();
    expect(state.playlists[0].songPaths).toEqual(["/lib/a.mp3"]);
  });

  it("壳菜单事件 qqplayer:ctx-goartist → 派发 open-browse + 关闭面板", async () => {
    const seen = [];
    const onBrowse = (e) => seen.push(e.detail);
    window.addEventListener("qqplayer:open-browse", onBrowse);
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    window.dispatchEvent(
      new CustomEvent("qqplayer:ctx-goartist", { detail: { path: "/lib/a.mp3" } }),
    );
    await nextTick();
    expect(seen).toEqual([{ type: "artist", value: "中島美嘉" }]);
    expect(wrapper.emitted("close")).toBeTruthy();
    window.removeEventListener("qqplayer:open-browse", onBrowse);
  });

  it("Esc 关闭右键菜单（不关闭面板）", async () => {
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    await rclick(wrapper, 0);
    expect(menuEl(wrapper)).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(menuEl(wrapper)).toBeFalsy();
    expect(wrapper.emitted("close")).toBeFalsy(); // 面板保持打开
  });
});
