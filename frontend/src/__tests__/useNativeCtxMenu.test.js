// useNativeCtxMenu 壳桥接测试：模拟 Swift 壳环境（window.qqplayerNative + webkit 消息桥）
// 验证链路：右键 mousedown → ctxState 上报（去重）→ 壳注入菜单点击 → __qqCtxMenu.* → 事件 →
// Playlist.vue / Sidebar.vue 复用浏览器右键菜单同一套实现（播放/收藏/加歌单/废纸篓/改名/删除）
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

const { initNativeCtxMenu, resetNativeCtxMenu } =
  await import("../composables/useNativeCtxMenu.js");
const { state, isFavorite } = await import("../composables/usePlayer.js");
const { useToast, clearToasts } = await import("../composables/useToast.js");
const { closeSmartView } = await import("../composables/useSmartViews.js");
const Playlist = (await import("../components/Playlist.vue")).default;
const Sidebar = (await import("../components/Sidebar.vue")).default;
const SmartViewPanel = (await import("../components/SmartViewPanel.vue")).default;

const SONG = [
  { id: "a", name: "A歌", artist: "五月天", album: "知足", path: "/a.mp3" },
  { id: "b", name: "B歌", artist: "高橋優", album: "開往明天的旅行", path: "/b.mp3" },
  { id: "c", name: "C歌", artist: "", album: "", path: "/c.mp3" },
];

let postMock;

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
  closeSmartView(); // 重置智能视图状态（mount SmartViewPanel 会写 smartViewState）
  // 模拟壳环境：window.qqplayerNative 标记 + webkit 消息桥
  window.qqplayerNative = true;
  postMock = vi.fn();
  window.webkit = { messageHandlers: { native: { postMessage: postMock } } };
  resetNativeCtxMenu();
  initNativeCtxMenu();
});

afterEach(() => {
  delete window.qqplayerNative;
  delete window.webkit;
  vi.unstubAllGlobals();
  clearToasts();
  wrappers.splice(0).forEach((w) => w.unmount());
  document.body
    .querySelectorAll(".ctx-menu, .ctx-backdrop, .add-menu, .am-backdrop, .dt-modal, .dt-backdrop")
    .forEach((el) => el.remove());
  document.body.querySelectorAll(".main").forEach((el) => el.remove()); // 智能面板定位锚点
  // 注意：不删 window.__qqCtxMenu（init 幂等，删了不会重装）
});

const wrappers = [];

function mountPlaylist(songs = SONG) {
  state.songs = songs.map((s) => ({ ...s }));
  const wrapper = mount(Playlist, { attachTo: document.body }); // attachTo：壳桥监听挂在 document 上，必须进真实 DOM 树
  wrappers.push(wrapper);
  return wrapper;
}

function mountSidebar() {
  const wrapper = mount(Sidebar, { attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}

// 智能视图面板：需要 ResizeObserver stub + .main .playlist 定位锚点（与 SmartViewPanel.test.js 同套路）
// recentAdded 视图纯前端计算（mapRecentAdded(state.songs)），不发请求，适合壳桥测试
async function mountSmartPanel(songs = SONG) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  state.songs = songs.map((s) => ({ ...s }));
  const main = document.createElement("div");
  main.className = "main";
  main.innerHTML = '<div class="playlist"></div>';
  document.body.appendChild(main);
  const wrapper = mount(SmartViewPanel, {
    props: { kind: "recentAdded" },
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  });
  wrappers.push(wrapper);
  await nextTick(); // onMounted 里 measure() 后才渲染 .sv-panel，须等一帧
  return wrapper;
}

// 在目标元素上触发右键 mousedown（WKWebView 里 contextmenu 被吞，只剩 mousedown(button=2)）
async function rclick(el, x = 120, y = 180) {
  const node = el.element || el; // 兼容 DOMWrapper / 原生元素
  node.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, button: 2, clientX: x, clientY: y }),
  );
  await nextTick();
}

const lastCtxPost = () => {
  const calls = postMock.mock.calls.map(([m]) => m);
  return calls[calls.length - 1];
};
const ctxPosts = () => postMock.mock.calls.map(([m]) => m);

function toastText() {
  return useToast()
    .items.map((i) => i.text)
    .join(" ");
}

describe("壳右键上下文上报（ctxState）", () => {
  it("右键歌曲行 → 上报 ctxState(kind=song, path/索引/歌名/标志)", async () => {
    const wrapper = mountPlaylist();
    await rclick(wrapper.findAll(".pl-item")[1]); // B歌
    expect(postMock).toHaveBeenCalledTimes(1);
    const msg = lastCtxPost();
    expect(msg.type).toBe("ctxState");
    expect(msg.kind).toBe("song");
    expect(msg.path).toBe("/b.mp3");
    expect(msg.songIndex).toBe(1);
    expect(msg.songName).toBe("B歌");
    expect(msg.hasPath).toBe(true);
    expect(msg.canGoArtist).toBe(true);
    expect(msg.canGoAlbum).toBe(true);
    expect(msg.isFav).toBe(false);
  });

  it("无歌手/专辑的歌 → canGoArtist/canGoAlbum 为 false", async () => {
    const wrapper = mountPlaylist([SONG[2]]); // C歌 无歌手无专辑
    await rclick(wrapper.findAll(".pl-item")[0]);
    const msg = lastCtxPost();
    expect(msg.kind).toBe("song");
    expect(msg.canGoArtist).toBe(false);
    expect(msg.canGoAlbum).toBe(false);
  });

  it("网络歌（path=null，无 data-path 属性）→ 不命中，上报清空上下文", async () => {
    const wrapper = mountPlaylist([
      { id: "s", name: "网歌", artist: "x", album: "y", type: "stream", streamId: "1", path: null },
    ]);
    await rclick(wrapper.findAll(".pl-item")[0]);
    const msg = lastCtxPost();
    expect(msg.type).toBe("ctxState");
    expect(msg.kind).toBe(null);
  });

  it("空白区右键 → 上报 kind=null 清空壳缓存", async () => {
    mountPlaylist();
    await rclick(document.body);
    const msg = lastCtxPost();
    expect(msg.type).toBe("ctxState");
    expect(msg.kind).toBe(null);
  });

  it("去重：同一行重复右键只上报一次；换行才再次上报", async () => {
    const wrapper = mountPlaylist();
    await rclick(wrapper.findAll(".pl-item")[0]);
    await rclick(wrapper.findAll(".pl-item")[0]); // 同上下文 → 去重
    expect(ctxPosts().filter((m) => m.kind === "song")).toHaveLength(1);
    await rclick(wrapper.findAll(".pl-item")[1]); // 不同行 → 重新上报
    expect(ctxPosts().filter((m) => m.kind === "song")).toHaveLength(2);
  });

  it("收藏状态变化后再次右键同一行 → isFav 重新上报", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const wrapper = mountPlaylist();
    await rclick(wrapper.findAll(".pl-item")[0]);
    expect(lastCtxPost().isFav).toBe(false);
    // 浏览器菜单收藏（同一数据源）→ 状态变化
    await wrapper.findAll(".pl-item")[0].trigger("contextmenu", { clientX: 100, clientY: 100 });
    const favBtn = [...document.body.querySelectorAll(".ctx-item")].find((b) =>
      b.textContent.includes("收藏"),
    );
    favBtn.click();
    await nextTick();
    expect(isFavorite("/a.mp3")).toBe(true);
    await rclick(wrapper.findAll(".pl-item")[0]);
    expect(lastCtxPost().isFav).toBe(true);
  });

  it("右键侧边栏歌单 → 上报 ctxState(kind=playlist, id/名称/数量)", async () => {
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: ["/b.mp3"] }];
    const wrapper = mountSidebar();
    const row = wrapper.find(".sb-item[data-playlist-id]");
    expect(row.exists()).toBe(true);
    await rclick(row.element);
    const msg = lastCtxPost();
    expect(msg.type).toBe("ctxState");
    expect(msg.kind).toBe("playlist");
    expect(msg.playlistId).toBe("p1");
    expect(msg.playlistName).toBe("日语歌");
  });

  it("右键侧边栏「全部歌曲」（无 data-playlist-id）→ 不命中，清空上下文", async () => {
    const wrapper = mountSidebar();
    const row = wrapper.find(".sb-item");
    expect(row.attributes("data-playlist-id")).toBeUndefined();
    await rclick(row.element);
    expect(lastCtxPost().kind).toBe(null);
  });

  it("右键智能视图行（.sv-item[data-path]）→ 上报 ctxState(kind=song, 索引正确)", async () => {
    const wrapper = await mountSmartPanel(); // SONG 全量 → 最近添加前三行
    const items = wrapper.findAll(".sv-item");
    expect(items.length).toBeGreaterThan(0);
    await rclick(items[1]); // B歌
    expect(postMock).toHaveBeenCalledTimes(1);
    const msg = lastCtxPost();
    expect(msg.type).toBe("ctxState");
    expect(msg.kind).toBe("song");
    expect(msg.path).toBe("/b.mp3");
    expect(msg.songIndex).toBe(1); // 全库索引（智能视图是 state.songs 的过滤视图）
    expect(msg.songName).toBe("B歌");
    expect(msg.hasPath).toBe(true);
    expect(msg.canGoArtist).toBe(true);
    expect(msg.canGoAlbum).toBe(true);
    expect(msg.isFav).toBe(false);
  });

  it("右键智能视图行后壳菜单动作：__qqCtxMenu.play → 事件 → SmartViewPanel 播放", async () => {
    const wrapper = await mountSmartPanel();
    const items = wrapper.findAll(".sv-item");
    await rclick(items[1]); // 右键 B
    window.__qqCtxMenu.play();
    await nextTick();
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("B歌");
    expect(state.isPlaying).toBe(true);
  });

  it("智能视图行右键去重：同行重复右键只上报一次；Playlist 与智能视图行共享 ctxState 去重", async () => {
    const wrapper = await mountSmartPanel();
    const items = wrapper.findAll(".sv-item");
    await rclick(items[0]);
    await rclick(items[0]); // 同上下文 → 去重
    expect(ctxPosts().filter((m) => m.kind === "song")).toHaveLength(1);
    await rclick(items[1]); // 不同行 → 重新上报
    expect(ctxPosts().filter((m) => m.kind === "song")).toHaveLength(2);
  });

  it("智能视图行右键 → 壳菜单动作 addPlaylist/remove/goArtist/goAlbum 派发对应事件", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const wrapper = await mountSmartPanel();
    const items = wrapper.findAll(".sv-item");
    const events = [];
    for (const name of [
      "qqplayer:ctx-addplaylist",
      "qqplayer:ctx-deletesong",
      "qqplayer:ctx-goartist",
      "qqplayer:ctx-goalbum",
    ]) {
      window.addEventListener(name, (e) => events.push([name, e.detail]));
    }
    await rclick(items[0], 300, 200); // 右键 A
    window.__qqCtxMenu.addPlaylist();
    window.__qqCtxMenu.remove();
    window.__qqCtxMenu.goArtist();
    window.__qqCtxMenu.goAlbum();
    await nextTick();
    expect(events.map(([n]) => n)).toEqual([
      "qqplayer:ctx-addplaylist",
      "qqplayer:ctx-deletesong",
      "qqplayer:ctx-goartist",
      "qqplayer:ctx-goalbum",
    ]);
    const add = events.find(([n]) => n === "qqplayer:ctx-addplaylist");
    expect(add[1]).toMatchObject({ path: "/a.mp3", x: 300, y: 200 });
    expect(events.find(([n]) => n === "qqplayer:ctx-deletesong")[1]).toEqual({ path: "/a.mp3" });
    expect(events.find(([n]) => n === "qqplayer:ctx-goartist")[1]).toEqual({ path: "/a.mp3" });
  });
});

describe("壳菜单动作（__qqCtxMenu → 事件 → Playlist 复用浏览器实现）", () => {
  it("播放 → selectSong + play（与浏览器右键菜单同行为）", async () => {
    const wrapper = mountPlaylist();
    await rclick(wrapper.findAll(".pl-item")[1]); // 右键 B
    window.__qqCtxMenu.play();
    await nextTick();
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("B歌");
    expect(state.isPlaying).toBe(true);
  });

  it("下一首播放 → 挪到当前歌之后并播放（队列无重复）", async () => {
    const wrapper = mountPlaylist();
    await wrapper.findAll(".pl-item")[0].trigger("click"); // 播 A
    await nextTick();
    await rclick(wrapper.findAll(".pl-item")[2]); // 右键 C
    window.__qqCtxMenu.playNext();
    await nextTick();
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "C歌", "B歌"]);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("C歌");
  });

  it("收藏/取消收藏（按当前状态切换，与浏览器菜单一致）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const wrapper = mountPlaylist();
    await rclick(wrapper.findAll(".pl-item")[0]);
    window.__qqCtxMenu.toggleFav();
    await nextTick();
    expect(isFavorite("/a.mp3")).toBe(true);
    await rclick(wrapper.findAll(".pl-item")[0]); // 上下文 isFav 刷新
    window.__qqCtxMenu.toggleFav();
    await nextTick();
    expect(isFavorite("/a.mp3")).toBe(false);
  });

  it("添加到歌单… → 复用加歌浮层（含该歌路径，锚定右键坐标）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: [] }];
    const wrapper = mountPlaylist();
    await rclick(wrapper.findAll(".pl-item")[0], 300, 200);
    window.__qqCtxMenu.addPlaylist();
    await nextTick();
    const am = document.body.querySelector(".add-menu");
    expect(am).toBeTruthy();
    await am.querySelector(".am-item").click();
    await nextTick();
    expect(state.playlists[0].songPaths).toEqual(["/a.mp3"]);
  });

  it("移到废纸篓 → 同一确认弹窗链路 → DELETE", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/api/library/songs")) {
        return { ok: true, json: async () => ({ deleted: 1, missing: [], errors: [] }) };
      }
      if (u.includes("/api/songs")) return { ok: true, json: async () => SONG };
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mountPlaylist();
    await rclick(wrapper.findAll(".pl-item")[1]); // 右键 B
    window.__qqCtxMenu.remove();
    await nextTick();
    const modal = document.body.querySelector(".dt-modal");
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain("将删除 1 首歌");
    await modal.querySelector(".dt-btn.danger").click();
    await flushPromises();
    const delCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/library/songs"));
    expect(JSON.parse(delCall[1].body).paths).toEqual(["/b.mp3"]);
  });

  it("进歌手 → 列表过滤到该歌手", async () => {
    const wrapper = mountPlaylist();
    await rclick(wrapper.findAll(".pl-item")[0]); // 右键 A（五月天）
    window.__qqCtxMenu.goArtist();
    await nextTick();
    const items = wrapper.findAll(".pl-item");
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain("A歌");
  });

  it("进专辑 → 列表过滤到该专辑", async () => {
    const wrapper = mountPlaylist();
    await rclick(wrapper.findAll(".pl-item")[0]); // 右键 A（知足）
    window.__qqCtxMenu.goAlbum();
    await nextTick();
    const items = wrapper.findAll(".pl-item");
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain("A歌");
  });

  it("编辑标签/刮削 → 派发 qqplayer:ctx-edittags（带右键歌曲 path）→ Playlist 打开 TagEditorModal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/api/tags/scrape")) {
          return { ok: true, json: async () => ({ query: "", netease: [], musicbrainz: [] }) };
        }
        if (u.includes("/api/library/settings")) {
          return { ok: true, json: async () => ({ settings: {} }) };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    const wrapper = mountPlaylist();
    const events = [];
    window.addEventListener("qqplayer:ctx-edittags", (e) => events.push(e.detail));
    await rclick(wrapper.findAll(".pl-item")[1]); // 右键 B
    window.__qqCtxMenu.editTags();
    await nextTick();
    // 事件派发带被右键歌曲 path
    expect(events).toEqual([{ path: "/b.mp3" }]);
    // Playlist 监听到 → 打开 TagEditorModal（autoScrape 自动刮削 B）
    const modal = document.body.querySelector(".modal.tag-modal");
    expect(modal).toBeTruthy();
    expect(modal.querySelectorAll(".field-input")[0].value).toBe("B歌");
    window.removeEventListener("qqplayer:ctx-edittags", () => {});
  });
});

describe("壳菜单动作（侧边栏歌单）", () => {
  it("播放 → 打开歌单视图并播第一首", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    state.songs = SONG.map((s) => ({ ...s }));
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: ["/b.mp3"] }];
    const wrapper = mountSidebar();
    const row = wrapper.find(".sb-item[data-playlist-id]");
    await rclick(row.element);
    expect(lastCtxPost().kind).toBe("playlist");
    window.__qqCtxMenu.play();
    await nextTick();
    expect(state.activePlaylistId).toBe("p1");
    expect(state.currentSong.name).toBe("B歌");
  });

  it("重命名 → 行内输入框出现（startRename）", async () => {
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: [] }];
    const wrapper = mountSidebar();
    const row = wrapper.find(".sb-item[data-playlist-id]");
    await rclick(row.element);
    window.__qqCtxMenu.rename();
    await nextTick();
    expect(wrapper.find(".sb-input").exists()).toBe(true);
    expect(wrapper.find(".sb-input").element.value).toBe("日语歌");
  });

  it("删除 → deletePlaylist + 撤销 toast", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/api/playlists")) return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: [] }];
    const wrapper = mountSidebar();
    const row = wrapper.find(".sb-item[data-playlist-id]");
    await rclick(row.element);
    window.__qqCtxMenu.delete();
    await flushPromises();
    expect(state.playlists).toEqual([]);
    expect(toastText()).toContain("已删除歌单");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/playlists/p1"))).toBe(true);
  });

  it("未命中歌单时动作静默（无上下文 → no-op）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    mountSidebar();
    expect(() => window.__qqCtxMenu.play()).not.toThrow();
    expect(() => window.__qqCtxMenu.rename()).not.toThrow();
    expect(() => window.__qqCtxMenu.delete()).not.toThrow();
    expect(state.activePlaylistId).toBeNull();
  });
});
