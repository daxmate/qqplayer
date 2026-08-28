// Playlist.vue 桌面端新功能测试：右键菜单 / 多选批量 / 移到废纸篓
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import type { VueWrapper } from "@vue/test-utils";
import type { Song } from "../composables/usePlayer.js";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, (() => void) | undefined> = {};

  constructor() {
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
  addEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = fn;
  }
  removeAttribute() {}
}
vi.stubGlobal("Audio", FakeAudio);

const Playlist = (await import("../components/Playlist.vue")).default;
const { state, isFavorite } = await import("../composables/usePlayer.js");
const { useToast, clearToasts } = await import("../composables/useToast.js");

const SONG: Song[] = [
  { id: "a", name: "A歌", artist: "五月天", album: "知足", path: "/a.mp3" },
  { id: "b", name: "B歌", artist: "高橋優", album: "開往明天的旅行", path: "/b.mp3" },
  { id: "c", name: "C歌", artist: "", album: "", path: "/c.mp3" },
];

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  // 无论断言成败都卸载挂载的 wrapper（失败时残留挂载会污染后续测试）
  wrappers.splice(0).forEach((w) => w.unmount());
  // 清理 Teleport 到 body 的浮层残留
  document.body
    .querySelectorAll(".ctx-menu, .ctx-backdrop, .add-menu, .am-backdrop, .dt-modal, .dt-backdrop")
    .forEach((el) => el.remove());
});

// 统一登记 wrapper：断言失败也能在 afterEach 卸载
const wrappers: VueWrapper[] = [];

function mountSongs(songs: Song[] = SONG) {
  // 拷贝数组：队列操作（下一首播放/删除）会 splice state.songs，不能污染共享常量
  state.songs = songs.map((s) => ({ ...s }));
  const wrapper = mount(Playlist);
  wrappers.push(wrapper);
  return wrapper;
}

// 右键第 index 行 → 菜单展开
async function rclick(wrapper: VueWrapper, index: number, x = 120, y = 180) {
  await wrapper.findAll(".pl-item")[index].trigger("contextmenu", { clientX: x, clientY: y });
  await nextTick();
}

const menuEl = () => document.body.querySelector<HTMLElement>(".ctx-menu");
const menuText = () => menuEl()?.textContent || "";

function menuItem(text: string): HTMLElement | undefined {
  const btns = [...document.body.querySelectorAll<HTMLElement>(".ctx-item")];
  return (
    btns.find((b) => b.textContent!.trim() === text) ||
    btns.find((b) => b.textContent!.includes(text))
  );
}

function toastText() {
  return useToast()
    .items.map((i) => i.text)
    .join(" ");
}

describe("Playlist 右键菜单", () => {
  it("右键歌曲行 → 显示菜单（播放/下一首/收藏/加歌单/进歌手/进专辑/编辑标签/移到废纸篓）", async () => {
    const wrapper = mountSongs();
    await rclick(wrapper, 0);
    expect(menuEl()).toBeTruthy();
    expect(menuText()).toContain("播放");
    expect(menuText()).toContain("下一首播放");
    expect(menuText()).toContain("收藏");
    expect(menuText()).toContain("加歌单");
    expect(menuText()).toContain("进歌手");
    expect(menuText()).toContain("进专辑");
    expect(menuText()).toContain("编辑标签/刮削");
    expect(menuText()).toContain("移到废纸篓");
  });

  it("无歌手/专辑的歌 → 不显示进歌手/进专辑", async () => {
    const wrapper = mountSongs([{ id: "c", name: "C歌", artist: "", album: "", path: "/c.mp3" }]);
    await rclick(wrapper, 0);
    expect(menuText()).not.toContain("进歌手");
    expect(menuText()).not.toContain("进专辑");
    expect(menuText()).toContain("移到废纸篓");
  });

  it("网络歌（path=null）→ 不显示移到废纸篓，也不显示编辑标签/刮削", async () => {
    const wrapper = mountSongs([
      { id: "s", name: "网歌", artist: "x", album: "y", type: "stream", streamId: "1", path: null },
    ]);
    await rclick(wrapper, 0);
    expect(menuText()).not.toContain("移到废纸篓");
    expect(menuText()).not.toContain("编辑标签/刮削");
  });

  it("菜单项：编辑标签/刮削 → 打开 TagEditorModal（autoScrape 自动刮削被右键的歌曲，不切换播放）", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/tags/scrape") && opts?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            query: "B歌",
            netease: [
              { id: "1", title: "B歌", artist: "高橋優", album: "開往明天的旅行", cover: null },
            ],
            musicbrainz: [],
          }),
        };
      }
      if (u.includes("/api/tags") && opts?.method === "POST") {
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes("/api/library/settings")) {
        return { ok: true, json: async () => ({ settings: {} }) };
      }
      if (u.includes("/api/songs")) return { ok: true, json: async () => SONG };
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mountSongs();
    await wrapper.findAll(".pl-item")[0].trigger("click"); // 播 A
    await nextTick();
    expect(state.currentSong!.name).toBe("A歌");
    await rclick(wrapper, 1); // 右键 B歌
    await menuItem("编辑标签/刮削")!.click();
    await nextTick();
    await flushPromises(); // autoScrape 的 fetch 链路
    // 弹窗打开，编辑目标 = 被右键的 B歌（不是当前播放的 A歌）
    const modal = document.body.querySelector<HTMLElement>(".modal.tag-modal")!;
    expect(modal).toBeTruthy();
    const inputs = modal.querySelectorAll(".field-input");
    expect((inputs[0] as HTMLInputElement).value).toBe("B歌");
    expect((inputs[1] as HTMLInputElement).value).toBe("高橋優");
    // autoScrape：打开即 POST /api/tags/scrape，body 带 B歌 path
    const scrapeCall = fetchMock.mock.calls.find(
      ([u, o]) =>
        String(u).includes("/api/tags/scrape") && (o as RequestInit | undefined)?.method === "POST",
    );
    expect(scrapeCall).toBeTruthy();
    expect(JSON.parse((scrapeCall![1] as RequestInit).body as string)).toEqual({ path: "/b.mp3" });
    // 候选已渲染
    expect(modal.querySelectorAll('[data-testid="cand-netease"]').length).toBe(1);
    // 播放未被打断（当前仍是 A）
    expect(state.currentSong!.name).toBe("A歌");
  });

  it("菜单项：播放 → 选中并播放该歌", async () => {
    const wrapper = mountSongs();
    await rclick(wrapper, 1); // B歌
    await menuItem("播放")!.click();
    await nextTick();
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong!.name).toBe("B歌");
    expect(state.isPlaying).toBe(true);
    expect(menuEl()).toBeNull(); // 菜单关闭
  });

  it("菜单项：下一首播放 → 挪到当前歌之后并播放（队列无重复）", async () => {
    const wrapper = mountSongs();
    await wrapper.findAll(".pl-item")[0].trigger("click"); // 播 A
    await nextTick();
    expect(state.currentSong!.name).toBe("A歌");
    await rclick(wrapper, 2); // 右键 C
    await menuItem("下一首播放")!.click();
    await nextTick();
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "C歌", "B歌"]);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong!.name).toBe("C歌");
  });

  it("菜单项：收藏/取消收藏（按当前状态切换）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const wrapper = mountSongs();
    await rclick(wrapper, 0);
    await menuItem("收藏")!.click();
    expect(isFavorite("/a.mp3")).toBe(true);
    // 已收藏 → 菜单显示取消收藏
    await rclick(wrapper, 0);
    expect(menuText()).toContain("取消收藏");
    await menuItem("取消收藏")!.click();
    expect(isFavorite("/a.mp3")).toBe(false);
  });

  it("菜单项：加歌单 → 复用加歌浮层（含该歌路径）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: [] }];
    const wrapper = mountSongs();
    await rclick(wrapper, 0);
    await menuItem("加歌单")!.click();
    await nextTick();
    expect(menuEl()).toBeNull(); // 右键菜单关闭
    const am = document.body.querySelector<HTMLElement>(".add-menu")!;
    expect(am).toBeTruthy();
    await am.querySelector<HTMLElement>(".am-item")!.click();
    await nextTick();
    expect(state.playlists[0].songPaths).toEqual(["/a.mp3"]);
  });

  it("菜单项：进歌手 → 列表过滤到该歌手", async () => {
    const wrapper = mountSongs();
    await rclick(wrapper, 0); // A歌（五月天）
    await menuItem("进歌手")!.click();
    await nextTick();
    const items = wrapper.findAll(".pl-item");
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain("A歌");
  });

  it("已在该歌手分组视图内 → 不显示进歌手（仍显示进专辑）", async () => {
    const wrapper = mountSongs();
    await wrapper.findAll(".pb-tab")[1].trigger("click"); // 歌手 tab
    const wy = wrapper.findAll(".gr-card").find((c) => c.find(".gr-name").text() === "五月天")!;
    await wy.trigger("click");
    await rclick(wrapper, 0); // A歌
    expect(menuText()).not.toContain("进歌手");
    expect(menuText()).toContain("进专辑");
  });

  it("点击 backdrop 关闭菜单", async () => {
    const wrapper = mountSongs();
    await rclick(wrapper, 0);
    expect(menuEl()).toBeTruthy();
    document.body
      .querySelector<HTMLElement>(".ctx-backdrop")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await nextTick();
    expect(menuEl()).toBeNull();
  });

  it("Esc 关闭菜单", async () => {
    const wrapper = mountSongs();
    await rclick(wrapper, 0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(menuEl()).toBeNull();
  });
});

describe("Playlist 多选批量", () => {
  it("⌘/Ctrl+点选进入多选态 → 批量条显示 N 首已选", async () => {
    const wrapper = mountSongs();
    expect(wrapper.find(".pl-multi").exists()).toBe(false);
    await wrapper.findAll(".pl-item")[0].trigger("click", { metaKey: true });
    await nextTick();
    expect(wrapper.find(".pl-multi").exists()).toBe(true);
    expect(wrapper.find(".pl-multi-count").text()).toContain("1 首已选");
    await wrapper.findAll(".pl-item")[1].trigger("click", { ctrlKey: true });
    await nextTick();
    expect(wrapper.find(".pl-multi-count").text()).toContain("2 首已选");
    // 选中的行有 selected class
    expect(wrapper.findAll(".pl-item")[0].classes()).toContain("selected");
    expect(wrapper.findAll(".pl-item")[1].classes()).toContain("selected");
  });

  it("多选态：普通行点击 = 切换选中（不播放）", async () => {
    const wrapper = mountSongs();
    await wrapper.findAll(".pl-item")[0].trigger("click", { metaKey: true });
    await wrapper.findAll(".pl-item")[1].trigger("click", { metaKey: true });
    expect(wrapper.find(".pl-multi-count").text()).toContain("2 首已选");
    // 点击已选行 → 取消选中
    await wrapper.findAll(".pl-item")[0].trigger("click");
    await nextTick();
    expect(wrapper.find(".pl-multi-count").text()).toContain("1 首已选");
    expect(wrapper.findAll(".pl-item")[0].classes()).not.toContain("selected");
    expect(state.isPlaying).toBe(false); // 未触发行播放
  });

  it("网络歌：⌘/Ctrl+点选不进入多选", async () => {
    const wrapper = mountSongs([
      { id: "s", name: "网歌", artist: "", type: "stream", streamId: "1", path: null },
      { id: "a", name: "A歌", artist: "", path: "/a.mp3" },
    ]);
    await wrapper.findAll(".pl-item")[0].trigger("click", { metaKey: true });
    await nextTick();
    expect(wrapper.find(".pl-multi").exists()).toBe(false);
    // 本地歌正常进入
    await wrapper.findAll(".pl-item")[1].trigger("click", { ctrlKey: true });
    await nextTick();
    expect(wrapper.find(".pl-multi").exists()).toBe(true);
  });

  it("批量收藏：新增未收藏的歌，toast 已收藏 N 首", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    state.favorites = ["/b.mp3"];
    const wrapper = mountSongs();
    await wrapper.findAll(".pl-item")[0].trigger("click", { metaKey: true });
    await wrapper.findAll(".pl-item")[1].trigger("click", { metaKey: true });
    await wrapper.findAll(".pl-multi-btn")[0].trigger("click"); // 批量收藏
    await flushPromises(); // 本地优先写：每首歌入队→同步→清队，多跳微任务后 toast
    expect(isFavorite("/a.mp3")).toBe(true); // 新增
    expect(isFavorite("/b.mp3")).toBe(true); // 原有不变
    expect(toastText()).toContain("已收藏 1 首");
  });

  it("批量加歌单：一次把选中歌全加进歌单", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: [] }];
    const wrapper = mountSongs();
    await wrapper.findAll(".pl-item")[0].trigger("click", { metaKey: true });
    await wrapper.findAll(".pl-item")[1].trigger("click", { metaKey: true });
    await wrapper.findAll(".pl-multi-btn")[1].trigger("click"); // 批量加歌单
    await nextTick();
    const am = document.body.querySelector<HTMLElement>(".add-menu")!;
    expect(am).toBeTruthy();
    await am.querySelector<HTMLElement>(".am-item")!.click();
    await flushPromises(); // 本地优先写：每首歌入队→同步→清队，多跳微任务后完成
    expect(state.playlists[0].songPaths.sort()).toEqual(["/a.mp3", "/b.mp3"]);
  });

  it("清空选择 → 退出多选态", async () => {
    const wrapper = mountSongs();
    await wrapper.findAll(".pl-item")[0].trigger("click", { metaKey: true });
    expect(wrapper.find(".pl-multi").exists()).toBe(true);
    await wrapper.findAll(".pl-multi-btn")[3].trigger("click"); // 清空选择
    await nextTick();
    expect(wrapper.find(".pl-multi").exists()).toBe(false);
  });

  it("Esc 退出多选态", async () => {
    const wrapper = mountSongs();
    await wrapper.findAll(".pl-item")[0].trigger("click", { metaKey: true });
    expect(wrapper.find(".pl-multi").exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper.find(".pl-multi").exists()).toBe(false);
  });
});

describe("Playlist 移到废纸篓", () => {
  it("批量删除：确认弹窗 → DELETE → toast 汇总 → 队列清理 + 当前歌切下一首 → loadSongs 刷新", async () => {
    const remaining = [
      { id: "b", name: "B歌", artist: "高橋優", album: "開往明天的旅行", path: "/b.mp3" },
    ];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _opts?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/library/songs")) {
        return { ok: true, json: async () => ({ deleted: 1, missing: ["/c.mp3"], errors: [] }) };
      }
      if (u.includes("/api/songs")) {
        return { ok: true, json: async () => remaining };
      }
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountSongs();
    // 当前播放 A
    await wrapper.findAll(".pl-item")[0].trigger("click");
    await nextTick();
    expect(state.currentSong!.name).toBe("A歌");
    // 多选 A、C
    await wrapper.findAll(".pl-item")[0].trigger("click", { metaKey: true });
    await wrapper.findAll(".pl-item")[2].trigger("click", { metaKey: true });
    // 批量移到废纸篓 → 确认弹窗
    await wrapper.findAll(".pl-multi-btn")[2].trigger("click");
    await nextTick();
    const modal = document.body.querySelector<HTMLElement>(".dt-modal")!;
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain("将删除 2 首歌及其磁盘文件，可到废纸篓恢复");
    // 取消 → 不调 DELETE
    await modal.querySelector<HTMLElement>(".dt-btn")!.click();
    await nextTick();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/library/songs"))).toBe(
      false,
    );
    // 确认 → 调 DELETE（doDelete 有多段 await：fetch → json → loadSongs，需 flush 全部微任务）
    await wrapper.findAll(".pl-multi-btn")[2].trigger("click");
    await nextTick();
    await document.body.querySelector<HTMLElement>(".dt-modal .dt-btn.danger")!.click();
    await flushPromises();
    const delCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/library/songs"));
    expect(delCall).toBeTruthy();
    expect((delCall![1] as RequestInit).method).toBe("DELETE");
    expect(JSON.parse((delCall![1] as RequestInit).body as string).paths).toEqual([
      "/a.mp3",
      "/c.mp3",
    ]);
    // toast 汇总：已删除 + 不在曲库
    expect(toastText()).toContain("已删除 1 首");
    expect(toastText()).toContain("1 首不在曲库");
    // 队列清理：A 删除成功被移除且当前歌自动切下一首（B）；C missing 保留到刷新前
    expect(state.currentSong!.name).toBe("B歌");
    // loadSongs 刷新（刷新后以服务端列表为准）
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/songs"))).toHaveLength(1);
    expect(state.songs.map((s) => s.name)).toEqual(["B歌"]);
    // 多选清空
    expect(wrapper.find(".pl-multi").exists()).toBe(false);
  });

  it("单曲删除：右键菜单 → 确认弹窗 → DELETE 单个 path", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _opts?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/library/songs")) {
        return { ok: true, json: async () => ({ deleted: 1, missing: [], errors: [] }) };
      }
      if (u.includes("/api/songs")) {
        return { ok: true, json: async () => SONG.filter((s) => s.path !== "/b.mp3") };
      }
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mountSongs();
    await rclick(wrapper, 1); // B歌
    await menuItem("移到废纸篓")!.click();
    await nextTick();
    const modal = document.body.querySelector<HTMLElement>(".dt-modal")!;
    expect(modal.textContent).toContain("将删除 1 首歌");
    await modal.querySelector<HTMLElement>(".dt-btn.danger")!.click();
    await flushPromises();
    const delCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/library/songs"));
    expect(JSON.parse((delCall![1] as RequestInit).body as string).paths).toEqual(["/b.mp3"]);
    expect(toastText()).toContain("已删除 1 首");
  });

  it("删除失败（非 200）→ 错误 toast，不刷新曲库", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _opts?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/library/songs")) return { ok: false, json: async () => ({}) };
      if (u.includes("/api/songs")) return { ok: true, json: async () => SONG };
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mountSongs();
    await rclick(wrapper, 0);
    await menuItem("移到废纸篓")!.click();
    await nextTick();
    await document.body.querySelector<HTMLElement>(".dt-modal .dt-btn.danger")!.click();
    await flushPromises();
    expect(toastText()).toContain("删除失败");
    expect(toastText()).not.toContain("已删除");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/songs"))).toHaveLength(0);
  });

  it("删除当前播放歌（无剩余歌）→ 播放器复位", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _opts?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/library/songs")) {
        return { ok: true, json: async () => ({ deleted: 1, missing: [], errors: [] }) };
      }
      if (u.includes("/api/songs")) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mountSongs([{ id: "a", name: "A歌", artist: "", path: "/a.mp3" }]);
    await wrapper.findAll(".pl-item")[0].trigger("click"); // 播 A
    await nextTick();
    expect(state.currentSong!.name).toBe("A歌");
    await rclick(wrapper, 0);
    await menuItem("移到废纸篓")!.click();
    await nextTick();
    await document.body.querySelector<HTMLElement>(".dt-modal .dt-btn.danger")!.click();
    await flushPromises();
    expect(state.songs).toEqual([]);
    expect(state.currentSong).toBeNull();
    expect(state.currentIndex).toBe(-1);
    expect(state.isPlaying).toBe(false);
    expect(toastText()).toContain("已删除 1 首");
  });
});
