// LyricSpecModal 组件测试（手动指定歌词弹窗）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
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

const LyricSpecModal = (await import("../components/LyricSpecModal.vue")).default;
const { state } = await import("../composables/usePlayer.js");

const SONG = {
  path: "/music/夜に駆ける.mp3",
  name: "夜に駆ける",
  artist: "YOASOBI",
};

// 默认 fetch mock：GET manual 返回未指定
function mockFetch(routes = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((url, opts) => {
    const u = String(url);
    if (u.includes("/api/lyric/search")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ results: routes.search || [] }),
      });
    }
    if (u.includes("/api/lyric/manual") && opts?.method === "PUT") {
      return routes.put
        ? routes.put()
        : Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (u.includes("/api/lyric/manual") && opts?.method === "DELETE") {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    // GET /api/lyric/manual
    return Promise.resolve({
      ok: true,
      json: async () => routes.manual || { specified: false },
    });
  });
}

const tick = () => new Promise((r) => setTimeout(r, 10));

async function openModal() {
  const w = mount(LyricSpecModal, { attachTo: document.body });
  state.specLyricOpen = true; // mount 后触发 watch（非 immediate）
  await nextTick();
  await tick(); // 等 fetchManualLyric 完成
  await nextTick();
  return w;
}

beforeEach(() => {
  state.specLyricOpen = false;
  state.currentSong = { ...SONG };
});

afterEach(() => {
  state.specLyricOpen = false;
  state.currentSong = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LyricSpecModal 基础渲染", () => {
  it("打开时显示歌名与三个 tab", async () => {
    mockFetch();
    const w = await openModal();
    expect(w.text()).toContain("夜に駆ける");
    expect(w.text()).toContain("上传文件");
    expect(w.text()).toContain("在线搜索");
    expect(w.text()).toContain("粘贴文本");
    w.unmount();
  });

  it("未指定时显示「自动获取」，保存按钮禁用", async () => {
    mockFetch();
    const w = await openModal();
    expect(w.text()).toContain("自动获取");
    expect(w.find(".btn-primary").attributes("disabled")).toBeDefined();
    w.unmount();
  });

  it("已指定时显示手动标识与清除按钮", async () => {
    mockFetch({
      manual: { specified: true, format: "lrc", source: "粘贴", text: "[00:01.00]x" },
    });
    const w = await openModal();
    expect(w.text()).toContain("已手动指定");
    expect(w.text()).toContain("粘贴");
    expect(w.text()).toContain("清除指定");
    w.unmount();
  });
});

describe("LyricSpecModal 上传文件", () => {
  it("选择 LRC 文件 → 检测格式 → 保存按钮可用 → 提交保存", async () => {
    const fetchMock = mockFetch();
    const w = await openModal();

    // 模拟选择 .lrc 文件（FileReader 读文本）
    const input = w.find('input[type="file"]');
    const file = new File(["[00:01.00]一行歌词\n[00:05.00]二行歌词"], "test.lrc", {
      type: "text/plain",
    });
    Object.defineProperty(input.element, "files", { value: [file] });
    await input.trigger("change");
    await tick(); // 等 FileReader.onload
    await nextTick();

    expect(w.text()).toContain("test.lrc");
    expect(w.text()).toContain("LRC");
    const saveBtn = w.find(".btn-primary");
    expect(saveBtn.attributes("disabled")).toBeUndefined();
    await saveBtn.trigger("click");
    await nextTick();
    await nextTick();

    const putCall = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT");
    expect(putCall).toBeTruthy();
    const body = JSON.parse(putCall[1].body);
    expect(body.path).toBe(SONG.path);
    expect(body.format).toBe("lrc");
    expect(body.text).toContain("一行歌词");
    expect(body.source).toContain("test.lrc");
    w.unmount();
  });
});

describe("LyricSpecModal 在线搜索", () => {
  it("搜索返回候选列表，点选即保存并关闭", async () => {
    const fetchMock = mockFetch({
      search: [
        {
          source: "netease",
          title: "夜に駆ける",
          artist: "YOASOBI",
          text: "[00:01.00]沈む",
          tlyric: "[00:01.00]像是沉溺",
        },
        {
          source: "lrclib",
          title: "夜に駆ける",
          artist: "YOASOBI",
          text: "[00:01.00]走れ",
          tlyric: null,
        },
      ],
    });
    const w = await openModal();

    // 切到搜索 tab
    await w.findAll(".spec-tab")[1].trigger("click");
    await nextTick();
    await w.find(".search-btn").trigger("click");
    await tick();
    await nextTick();

    expect(w.findAll(".result-item").length).toBe(2);
    expect(w.text()).toContain("网易云");
    expect(w.text()).toContain("译"); // 有翻译标记

    await w.findAll(".result-item")[0].trigger("click");
    await tick();
    await nextTick();

    const putCall = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT");
    expect(putCall).toBeTruthy();
    const body = JSON.parse(putCall[1].body);
    expect(body.text).toContain("沈む");
    expect(body.source).toContain("网易云");
    expect(state.specLyricOpen).toBe(false); // 保存后关闭
    w.unmount();
  });
});

describe("LyricSpecModal JSON 歌词", () => {
  it("上传 JSON（lrc + tlyric）→ 检测 JSON → 保存时提取 lrc 并携带 tlyric", async () => {
    const fetchMock = mockFetch();
    const w = await openModal();

    const input = w.find('input[type="file"]');
    const json = JSON.stringify({
      lrc: "[00:01.00]原文行\n[00:05.00]原文二行",
      tlyric: "[00:01.00]翻译行",
      source: "netease",
    });
    const file = new File([json], "song.json", { type: "application/json" });
    Object.defineProperty(input.element, "files", { value: [file] });
    await input.trigger("change");
    await tick();
    await nextTick();

    expect(w.text()).toContain("song.json");
    expect(w.text()).toContain("JSON");
    const saveBtn = w.find(".btn-primary");
    expect(saveBtn.attributes("disabled")).toBeUndefined();
    await saveBtn.trigger("click");
    await nextTick();
    await nextTick();

    const putCall = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT");
    expect(putCall).toBeTruthy();
    const body = JSON.parse(putCall[1].body);
    expect(body.format).toBe("lrc"); // JSON 转成 LRC 保存
    expect(body.text).toBe("[00:01.00]原文行\n[00:05.00]原文二行");
    expect(body.tlyric).toBe("[00:01.00]翻译行");
    expect(body.source).toContain("song.json");
    w.unmount();
  });

  it("上传无 lrc 字段的 JSON → 格式未识别 → 保存禁用", async () => {
    mockFetch();
    const w = await openModal();
    const input = w.find('input[type="file"]');
    const file = new File([JSON.stringify({ foo: "bar" })], "bad.json", {
      type: "application/json",
    });
    Object.defineProperty(input.element, "files", { value: [file] });
    await input.trigger("change");
    await tick();
    await nextTick();
    expect(w.text()).toContain("未识别");
    expect(w.find(".btn-primary").attributes("disabled")).toBeDefined();
    w.unmount();
  });
});

describe("LyricSpecModal 粘贴文本", () => {
  it("粘贴 SRT 文本 → 检测格式 → 保存", async () => {
    const fetchMock = mockFetch();
    const w = await openModal();

    await w.findAll(".spec-tab")[2].trigger("click");
    await nextTick();

    const srt = "1\n00:00:01,000 --> 00:00:05,000\n粘贴的歌词行\n";
    await w.find(".paste-area").setValue(srt);
    await nextTick();

    expect(w.text()).toContain("SRT");
    const saveBtn = w.find(".btn-primary");
    expect(saveBtn.attributes("disabled")).toBeUndefined();
    await saveBtn.trigger("click");
    await nextTick();
    await nextTick();

    const putCall = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT");
    expect(putCall).toBeTruthy();
    const body = JSON.parse(putCall[1].body);
    expect(body.format).toBe("srt");
    expect(body.text).toContain("粘贴的歌词行");
    expect(body.source).toBe("粘贴");
    w.unmount();
  });

  it("粘贴无时间戳文本 → 格式未识别 → 保存禁用", async () => {
    mockFetch();
    const w = await openModal();
    await w.findAll(".spec-tab")[2].trigger("click");
    await nextTick();
    await w.find(".paste-area").setValue("没有时间戳的歌词");
    await nextTick();
    expect(w.text()).toContain("未识别");
    expect(w.find(".btn-primary").attributes("disabled")).toBeDefined();
    w.unmount();
  });
});
