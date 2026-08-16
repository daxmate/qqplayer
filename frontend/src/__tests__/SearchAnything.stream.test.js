// SearchAnything 流媒体按钮测试（任务 B）
// 覆盖：在线结果行三按钮布局（试听 / 添加到曲库 / 下载）/
// 试听 → playPreview 取直链 / 添加到曲库 POST /api/network-songs（幂等 409 → 已在曲库）/
// 歌曲海源隐藏试听/添加（只有下载）
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
    this.ended = false;
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
  removeAttribute() {}
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const SearchAnything = (await import("../components/SearchAnything.vue")).default;
const { useSearchAnything } = await import("../composables/useSearchAnything.js");
const { state, playbackSettings } = await import("../composables/usePlayer.js");

const { query, results, loading, isSearchOpen, onlineSource } = useSearchAnything();

// 网易云在线结果（SearchAnything 的 online 条目形态）
function onlineItem(over = {}) {
  return {
    kind: "online",
    id: "online-1001",
    title: "晴天",
    subtitle: "周杰伦 · 叶惠美",
    badge: "在线",
    score: 60,
    payload: {
      id: "1001",
      title: "晴天",
      artist: "周杰伦",
      album: "叶惠美",
      cover: "http://img.example.com/1001.jpg",
      duration: "4:29",
      quality: "exhigh",
    },
    ...over,
  };
}

let wrapper = null;
let neteaseCalls = 0;

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    mode: "continuous",
    playMode: "order",
    lyric: [],
    lyricFormat: null,
    lyricSource: null,
  });
  playbackSettings.searchKey = "Meta+K";
  query.value = "";
  results.value = [];
  loading.value = false;
  isSearchOpen.value = false;
  onlineSource.value = "netease";
  neteaseCalls = 0;
  const a = FakeAudio.instances[0];
  if (a) {
    a.src = "";
    a.paused = true;
    a.currentTime = 0;
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const u = String(url);
      if (u.startsWith("/api/stream/url")) {
        neteaseCalls++;
        return {
          ok: true,
          json: async () => ({ url: "http://stream.example.com/1001.mp3", level: "exhigh" }),
        };
      }
      if (u.startsWith("/api/lyric/search")) {
        return { ok: true, json: async () => ({ results: [] }) };
      }
      if (u === "/api/network-songs" && init?.method === "POST") {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (u === "/api/network-songs" && init?.method === "DELETE") {
        return { ok: true, json: async () => [] };
      }
      if (u === "/api/online/download" || u === "/api/gequhai/download") {
        return { ok: true, json: async () => ({ ok: true, path: "/lib/x.mp3" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  isSearchOpen.value = false;
  query.value = "";
  results.value = [];
  vi.unstubAllGlobals();
});

function mountOverlay() {
  wrapper = mount(SearchAnything, { attachTo: document.body });
  return wrapper;
}

// 渲染带一条在线结果的搜索层
async function renderWithOnline(item) {
  mountOverlay();
  isSearchOpen.value = true;
  results.value = [onlineItem(item)];
  query.value = "晴天";
  await nextTick();
  return wrapper;
}

describe("SearchAnything 在线结果三按钮布局（试听 / 添加 / 下载）", () => {
  it("网易云源：在线行渲染 试听 / 添加到曲库 / 下载 三个动作按钮", async () => {
    await renderWithOnline();
    const acts = wrapper.findAll(".sa-act");
    expect(acts.length).toBe(3);
    expect(acts[0].attributes("title")).toBe("试听");
    expect(acts[1].attributes("title")).toBe("添加到曲库");
    expect(acts[2].attributes("title")).toBe("下载");
  });

  it("试听按钮：实时取直链 → playPreview（currentSong 置为试听歌，不改队列）", async () => {
    await renderWithOnline();
    await wrapper.findAll(".sa-act")[0].trigger("click");
    await flushPromises();
    expect(neteaseCalls).toBe(1); // GET /api/stream/url
    expect(state.currentSong.type).toBe("preview");
    expect(state.currentSong.name).toBe("晴天");
    expect(state.currentSong.streamId).toBe("1001");
    expect(FakeAudio.instances[0].src).toBe("http://stream.example.com/1001.mp3");
    // 试听成功 toast
    expect(wrapper.find(".sa-toast").text()).toContain("正在试听");
    // 搜索层不收起（试听 = 边听边逛）
    expect(isSearchOpen.value).toBe(true);
  });

  it("添加到曲库按钮：POST /api/network-songs（带 id/title/artist/album/coverUrl/duration）", async () => {
    let posted = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = String(url);
        if (u === "/api/network-songs" && init?.method === "POST") {
          posted = JSON.parse(init.body);
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (u.startsWith("/api/stream/url")) {
          return { ok: true, json: async () => ({ url: "http://s/1.mp3" }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    await renderWithOnline();
    await wrapper.findAll(".sa-act")[1].trigger("click");
    await flushPromises();
    expect(posted).toEqual({
      id: "1001",
      title: "晴天",
      artist: "周杰伦",
      album: "叶惠美",
      coverUrl: "http://img.example.com/1001.jpg",
      duration: "4:29",
    });
    expect(wrapper.find(".sa-toast").text()).toContain("已添加到曲库");
  });

  it("重复添加（后端 409 幂等）→ 提示已在曲库", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = String(url);
        if (u === "/api/network-songs" && init?.method === "POST") {
          return { status: 409, ok: false, json: async () => ({ detail: "已存在" }) };
        }
        if (u.startsWith("/api/stream/url")) {
          return { ok: true, json: async () => ({ url: "http://s/1.mp3" }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    await renderWithOnline();
    await wrapper.findAll(".sa-act")[1].trigger("click");
    await flushPromises();
    expect(wrapper.find(".sa-toast").text()).toContain("已在曲库");
    expect(wrapper.find(".sa-toast").classes()).toContain("err");
  });

  it("响应携带 alreadyExists 标记 → 提示已在曲库", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = String(url);
        if (u === "/api/network-songs" && init?.method === "POST") {
          return { ok: true, json: async () => ({ ok: true, alreadyExists: true }) };
        }
        if (u.startsWith("/api/stream/url")) {
          return { ok: true, json: async () => ({ url: "http://s/1.mp3" }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    await renderWithOnline();
    await wrapper.findAll(".sa-act")[1].trigger("click");
    await flushPromises();
    expect(wrapper.find(".sa-toast").text()).toContain("已在曲库");
  });

  it("下载按钮：走现有下载链路（POST /api/online/download）", async () => {
    let dl = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = String(url);
        if (u === "/api/online/download" && init?.method === "POST") {
          dl++;
          return { ok: true, json: async () => ({ ok: true, path: "/lib/晴天.mp3" }) };
        }
        if (u.startsWith("/api/stream/url")) {
          return { ok: true, json: async () => ({ url: "http://s/1.mp3" }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    await renderWithOnline();
    await wrapper.findAll(".sa-act")[2].trigger("click");
    await flushPromises();
    expect(dl).toBe(1);
    expect(wrapper.find(".sa-toast").text()).toContain("已开始下载");
  });

  it("行点击（非按钮区域）仍 = 下载（保留现有行为）", async () => {
    let dl = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = String(url);
        if (u === "/api/online/download" && init?.method === "POST") {
          dl++;
          return { ok: true, json: async () => ({ ok: true, path: "/lib/x.mp3" }) };
        }
        if (u.startsWith("/api/stream/url")) {
          return { ok: true, json: async () => ({ url: "http://s/1.mp3" }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    await renderWithOnline();
    await wrapper.find(".sa-row-online").trigger("click");
    await flushPromises();
    expect(dl).toBe(1);
  });

  it("歌曲海源：只显示下载按钮（无试听 / 添加——该源走夸克直链下载）", async () => {
    onlineSource.value = "gequhai";
    await renderWithOnline({ badge: "歌曲海" });
    const acts = wrapper.findAll(".sa-act");
    expect(acts.length).toBe(1);
    expect(acts[0].attributes("title")).toBe("下载");
    onlineSource.value = "netease";
  });
});
