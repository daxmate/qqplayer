// OnlineSearch 组件测试：防抖在线搜索 / 本地+在线分组 / 空结果 / 下载交互（POST + loading + toast）
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

const OnlineSearch = (await import("../components/OnlineSearch.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { downloadSettings } = await import("../composables/useSettings.js");

const lib = [
  { id: "a", path: "/lib/zhou.mp3", name: "晴天", artist: "周杰伦", album: "叶惠美" },
  { id: "b", path: "/lib/yuki.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
];

const onlineItems = [
  {
    id: "1001",
    title: "晴天",
    artist: "周杰伦",
    album: "叶惠美",
    cover: "http://img.example.com/1001.jpg",
    duration: "4:29",
    level: "exhigh",
  },
  {
    id: "1002",
    title: "七里香",
    artist: "周杰伦",
    album: "七里香",
    cover: "",
    duration: "4:58",
    level: "lossless",
  },
];

let searchCalls = []; // { q, limit }
let downloadBodies = [];
let failSearch = false;
let failDownload = false;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, opts = {}) => {
      if (String(url).startsWith("/api/online/search")) {
        const u = new URL(url, "http://localhost");
        searchCalls.push({ q: u.searchParams.get("q"), limit: u.searchParams.get("limit") });
        if (failSearch) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ items: onlineItems }) };
      }
      if (url === "/api/online/download") {
        downloadBodies.push(JSON.parse(opts.body));
        if (failDownload) return { ok: false, json: async () => ({ error: "网络错误" }) };
        return { ok: true, json: async () => ({ ok: true, path: "/dl/1001.mp3" }) };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  Object.assign(state, {
    songs: lib,
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
    mode: "continuous",
  });
  downloadSettings.downloadDir = "";
  downloadSettings.defaultQuality = "exhigh";
  searchCalls = [];
  downloadBodies = [];
  failSearch = false;
  failDownload = false;
  stubFetch();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 输入关键词并等待防抖+请求完成
async function typeAndSearch(wrapper, keyword) {
  await wrapper.find(".os-input").setValue(keyword);
  await vi.advanceTimersByTimeAsync(420); // 防抖 400ms 触发请求
  await flushPromises();
}

describe("OnlineSearch 防抖与在线搜索", () => {
  it("输入防抖 400ms：输入停止后才调 GET /api/online/search（q + limit=20）", async () => {
    const wrapper = mount(OnlineSearch);
    await wrapper.find(".os-input").setValue("周杰伦");
    await vi.advanceTimersByTimeAsync(300);
    expect(searchCalls.length).toBe(0); // 防抖中：未请求
    await vi.advanceTimersByTimeAsync(120);
    await flushPromises();
    expect(searchCalls.length).toBe(1);
    expect(searchCalls[0]).toEqual({ q: "周杰伦", limit: "20" });
    wrapper.unmount();
  });

  it("连续输入只发最后一次请求（旧请求作废）", async () => {
    const wrapper = mount(OnlineSearch);
    await wrapper.find(".os-input").setValue("周");
    await vi.advanceTimersByTimeAsync(100);
    await wrapper.find(".os-input").setValue("周杰");
    await vi.advanceTimersByTimeAsync(100);
    await wrapper.find(".os-input").setValue("周杰伦");
    await vi.advanceTimersByTimeAsync(420);
    await flushPromises();
    expect(searchCalls.length).toBe(1); // 合并成一次
    expect(searchCalls[0].q).toBe("周杰伦");
    wrapper.unmount();
  });

  it("清空输入：取消在途请求，不显示在线结果", async () => {
    const wrapper = mount(OnlineSearch);
    await typeAndSearch(wrapper, "周杰伦");
    expect(wrapper.text()).toContain("晴天");
    await wrapper.find(".os-clear").trigger("mousedown");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(searchCalls.length).toBe(1); // 清空不触发新请求
    expect(wrapper.text()).not.toContain("晴天");
    expect(wrapper.find(".os-online").exists()).toBe(false);
    wrapper.unmount();
  });

  it("加载中显示 loading；请求失败显示错误文案", async () => {
    failSearch = true;
    const wrapper = mount(OnlineSearch);
    await wrapper.find(".os-input").setValue("周杰伦");
    expect(wrapper.text()).toContain("搜索中…"); // 防抖窗口内即 loading
    await vi.advanceTimersByTimeAsync(420);
    await flushPromises();
    expect(wrapper.text()).toContain("在线搜索失败");
    wrapper.unmount();
  });
});

describe("OnlineSearch 分组渲染", () => {
  it("本地 + 在线两组同时渲染（本地按 title/artist/album 模糊匹配）", async () => {
    const wrapper = mount(OnlineSearch);
    await typeAndSearch(wrapper, "周杰伦");
    const text = wrapper.text();
    expect(text).toContain("本地歌曲");
    expect(text).toContain("在线（网易云）");
    // 本地组：晴天（artist 匹配）
    expect(wrapper.findAll(".os-local").length).toBe(1);
    expect(wrapper.find(".os-local .os-name").text()).toBe("晴天");
    // 在线组：两条结果 + 封面降级 icon + 音质标签
    expect(wrapper.findAll(".os-online").length).toBe(2);
    expect(text).toContain("4:29");
    expect(text).toContain("极高 320k"); // defaultQuality=exhigh 对应的中文标签
    // 第二条 cover 为空 → 降级 icon（无 img 元素）
    const secondCover = wrapper.findAll(".os-online")[1].find(".os-cover");
    expect(secondCover.find("img").exists()).toBe(false);
    wrapper.unmount();
  });

  it("本地匹配最多 8 条；含专辑名匹配", async () => {
    state.songs = Array.from({ length: 12 }, (_, i) => ({
      id: "s" + i,
      path: `/lib/s${i}.mp3`,
      name: `歌${i}`,
      artist: "周杰伦",
      album: "叶惠美",
    }));
    const wrapper = mount(OnlineSearch);
    await wrapper.find(".os-input").setValue("叶惠美");
    await vi.advanceTimersByTimeAsync(420);
    await flushPromises();
    expect(wrapper.findAll(".os-local").length).toBe(8); // 封顶 8
    wrapper.unmount();
  });

  it("本地无匹配 → 本地空态；在线空结果 → 未找到文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).startsWith("/api/online/search")) {
          return { ok: true, json: async () => ({ items: [] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    const wrapper = mount(OnlineSearch);
    await typeAndSearch(wrapper, "不存在的歌");
    expect(wrapper.text()).toContain("没有匹配的本地歌曲");
    expect(wrapper.text()).toContain("未找到相关歌曲");
    wrapper.unmount();
  });

  it("空输入聚焦：显示提示文案，不发请求", async () => {
    const wrapper = mount(OnlineSearch);
    await wrapper.find(".os-input").trigger("focus");
    expect(wrapper.find(".os-panel").exists()).toBe(true);
    expect(wrapper.text()).toContain("输入关键词，搜索本地曲库或网易云音乐");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(searchCalls.length).toBe(0);
    wrapper.unmount();
  });

  it("点击组件外 → 面板收起；Esc → 收起", async () => {
    const wrapper = mount(OnlineSearch);
    await wrapper.find(".os-input").trigger("focus");
    expect(wrapper.find(".os-panel").exists()).toBe(true);
    await wrapper.find(".os-input").trigger("keydown", { key: "Escape" });
    expect(wrapper.find(".os-panel").exists()).toBe(false);
    await wrapper.find(".os-input").trigger("focus");
    expect(wrapper.find(".os-panel").exists()).toBe(true);
    document.body.click();
    await nextTick();
    expect(wrapper.find(".os-panel").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("OnlineSearch 本地播放", () => {
  it("点击本地结果：走 selectSong + play，并 emit open-player", async () => {
    const wrapper = mount(OnlineSearch);
    await typeAndSearch(wrapper, "中島美嘉");
    await wrapper.find(".os-local").trigger("click");
    await flushPromises();
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("雪の華");
    expect(state.isPlaying).toBe(true);
    expect(wrapper.emitted("open-player")).toBeTruthy();
    // 播放后面板收起
    expect(wrapper.find(".os-panel").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("OnlineSearch 下载交互", () => {
  it("点下载 → POST /api/online/download {id, level: 默认音质} → 成功 toast", async () => {
    // 可控下载响应：挂起期间验证按钮 loading 态
    let resolveDownload;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts = {}) => {
        if (String(url).startsWith("/api/online/search")) {
          return { ok: true, json: async () => ({ items: onlineItems }) };
        }
        if (url === "/api/online/download") {
          downloadBodies.push(JSON.parse(opts.body));
          return new Promise((res) => {
            resolveDownload = res;
          });
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    const wrapper = mount(OnlineSearch);
    await typeAndSearch(wrapper, "周杰伦");
    await wrapper.findAll(".os-download")[0].trigger("click");
    // 下载中：按钮禁用 + 转圈文案
    expect(wrapper.findAll(".os-download")[0].attributes("disabled")).toBeDefined();
    expect(wrapper.findAll(".os-download")[0].text()).toContain("下载中…");
    // 响应到达：请求体正确 + 成功 toast + 按钮恢复
    resolveDownload({ ok: true, json: async () => ({ ok: true, path: "/dl/1001.mp3" }) });
    await flushPromises();
    expect(downloadBodies.length).toBe(1);
    expect(downloadBodies[0]).toEqual({
      id: "1001",
      level: "exhigh",
      title: "晴天",
      artist: "周杰伦",
    });
    expect(wrapper.find(".os-toast").text()).toContain("已下载：晴天");
    expect(wrapper.findAll(".os-download")[0].attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("下载使用设置里的默认音质（改 defaultQuality 后生效）", async () => {
    downloadSettings.defaultQuality = "lossless";
    const wrapper = mount(OnlineSearch);
    await typeAndSearch(wrapper, "周杰伦");
    await wrapper.findAll(".os-download")[0].trigger("click");
    await flushPromises();
    expect(downloadBodies[0]).toEqual({
      id: "1001",
      level: "lossless",
      title: "晴天",
      artist: "周杰伦",
    });
    expect(wrapper.find(".os-toast").text()).toContain("已下载：晴天");
    wrapper.unmount();
  });

  it("下载失败 → 错误 toast（后端 error 信息）", async () => {
    failDownload = true;
    const wrapper = mount(OnlineSearch);
    await typeAndSearch(wrapper, "周杰伦");
    await wrapper.findAll(".os-download")[0].trigger("click");
    await flushPromises();
    const toast = wrapper.find(".os-toast");
    expect(toast.exists()).toBe(true);
    expect(toast.classes()).toContain("err");
    expect(toast.text()).toContain("下载失败：网络错误");
    wrapper.unmount();
  });

  it("toast 3.2s 后自动消失", async () => {
    const wrapper = mount(OnlineSearch);
    await typeAndSearch(wrapper, "周杰伦");
    await wrapper.findAll(".os-download")[0].trigger("click");
    await flushPromises();
    expect(wrapper.find(".os-toast").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(3300);
    await flushPromises();
    expect(wrapper.find(".os-toast").exists()).toBe(false);
    wrapper.unmount();
  });
});
