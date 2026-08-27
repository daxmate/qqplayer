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

// mock usePlayer 模块：保留全部真实实现，仅替换 alignLyric（组件内点击 AI 对齐用）
vi.mock("../composables/usePlayer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, alignLyric: vi.fn() };
});

const LyricSpecModal = (await import("../components/LyricSpecModal.vue")).default;
const { state, uiState, alignLyric } = await import("../composables/usePlayer.js");
const { useToast, clearToasts } = await import("../composables/useToast.js");

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
      return routes.delete
        ? routes.delete()
        : Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    // GET /api/lyric/manual
    return Promise.resolve({
      ok: true,
      json: async () => routes.manual || { specified: false },
    });
  });
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// jsdom 下 FileReader.onload 是异步任务，全量并行（42 个 worker）时固定 10ms tick 可能不够，
// 导致“文本已更新但按钮 disabled 未刷新”的偶发失败 → 轮询等待渲染完成再断言
function waitFor(fn, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      try {
        if (fn()) return resolve();
      } catch {
        /* 继续等 */
      }
      if (Date.now() - start > timeout) return reject(new Error("waitFor 超时"));
      setTimeout(check, 10);
    };
    check();
  });
}

async function openModal() {
  // teleport stub：Teleport 到 body 后 wrapper 无根节点，stub 让内容原地渲染（测试断言不变）
  const w = mount(LyricSpecModal, {
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  });
  uiState.specLyricOpen = true; // mount 后触发 watch（非 immediate）
  await nextTick();
  await tick(); // 等 fetchManualLyric 完成
  await nextTick();
  return w;
}

beforeEach(() => {
  uiState.specLyricOpen = false;
  state.currentSong = { ...SONG };
  alignLyric.mockReset();
});

afterEach(() => {
  uiState.specLyricOpen = false;
  state.currentSong = null;
  clearToasts();
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
    // 等 FileReader.onload + 渲染：.spec-preview 仅在检测到格式后渲染（
    // 不能用 includes("LRC")——错误提示文案里也含 LRC，会在解析完成前误匹配）
    await waitFor(() => w.find(".spec-preview").exists());
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
    expect(uiState.specLyricOpen).toBe(false); // 保存后关闭
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
    // .spec-preview 仅在检测到格式后渲染（"JSON" 会匹配错误提示文案里的“JSON 需包含 lrc 字段”）
    await waitFor(() => w.find(".spec-preview").exists());
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
    // 等解析完成：格式标签“格式：未识别”（错误提示文案“可用歌词格式：LRC…”不含此串）
    await waitFor(() => w.text().includes("格式：未识别"));
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

describe("LyricSpecModal AI 对齐（粘贴 tab）", () => {
  it("渲染 AI 对齐按钮，纯文本为空时禁用，有内容后可点", async () => {
    mockFetch();
    const w = await openModal();
    await w.findAll(".spec-tab")[2].trigger("click");
    await nextTick();
    const btn = w.find(".align-btn");
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain("AI 对齐");
    expect(btn.attributes("disabled")).toBeDefined();
    await w.find(".paste-area").setValue("一行歌词\n二行歌词");
    await nextTick();
    expect(w.find(".align-btn").attributes("disabled")).toBeUndefined();
    w.unmount();
  });

  it("点击 AI 对齐 → loading（禁用+文案）→ 成功填入 LRC 并识别格式", async () => {
    mockFetch();
    let resolveAlign;
    alignLyric.mockImplementation(() => new Promise((r) => (resolveAlign = r)));
    const w = await openModal();
    await w.findAll(".spec-tab")[2].trigger("click");
    await nextTick();
    await w.find(".paste-area").setValue("一行歌词\n二行歌词");
    await nextTick();
    await w.find(".align-btn").trigger("click");
    await nextTick();

    // loading：按钮禁用 + 文案「AI 对齐中…」，且带当前歌曲 path 调用 API
    expect(alignLyric).toHaveBeenCalledWith({ path: SONG.path, text: "一行歌词\n二行歌词" });
    expect(w.find(".align-btn").attributes("disabled")).toBeDefined();
    expect(w.text()).toContain("AI 对齐中");

    // 成功：LRC 填入 textarea → 检测为 LRC → 保存按钮可用 + 完成 toast
    resolveAlign({ lrc: "[00:01.23]一行歌词\n[00:05.67]二行歌词", lines: 2, duration: 38 });
    await tick();
    await nextTick();
    expect(w.find(".paste-area").element.value).toBe("[00:01.23]一行歌词\n[00:05.67]二行歌词");
    expect(w.text()).toContain("LRC");
    const { items } = useToast();
    expect(items.some((i) => i.type === "success" && i.text.includes("AI 对齐完成"))).toBe(true);
    expect(w.find(".btn-primary").attributes("disabled")).toBeUndefined();
    expect(w.find(".align-btn").attributes("disabled")).toBeUndefined(); // 按钮恢复
    w.unmount();
  });

  it("对齐失败 → error toast（带 detail），按钮恢复", async () => {
    mockFetch();
    alignLyric.mockRejectedValue(new Error("AI 对齐失败，请检查音频文件与歌词内容"));
    const w = await openModal();
    await w.findAll(".spec-tab")[2].trigger("click");
    await nextTick();
    await w.find(".paste-area").setValue("一行歌词");
    await nextTick();
    await w.find(".align-btn").trigger("click");
    await tick();
    await nextTick();
    const { items } = useToast();
    expect(items.some((i) => i.type === "error" && i.text.includes("AI 对齐失败"))).toBe(true);
    expect(w.find(".align-btn").attributes("disabled")).toBeUndefined();
    expect(w.find(".paste-area").element.value).toBe("一行歌词"); // 原文本保留
    w.unmount();
  });

  it("无粘贴文本时，自动用当前已加载歌词（state.lyric）对齐", async () => {
    mockFetch();
    let resolveAlign;
    alignLyric.mockImplementation(() => new Promise((r) => (resolveAlign = r)));
    // 模拟当前歌曲已加载歌词（在线拉取/本地文件）
    state.lyric = [
      { type: "line", s: 1, e: 5, text: ["夜に駆ける", "", ""] },
      { type: "line", s: 6, e: 9, text: ["君と見た景色", "", ""] },
    ];
    const w = await openModal();
    await nextTick();
    // 不切粘贴 tab、不输入任何内容：按钮可直接点（foot 区通用按钮）
    await waitFor(() => !w.find(".align-btn").attributes("disabled"));
    await w.find(".align-btn").trigger("click");
    await nextTick();
    // 用当前歌词纯文本（日文原文拼接）调用 API
    expect(alignLyric).toHaveBeenCalledWith({
      path: SONG.path,
      text: "夜に駆ける\n君と見た景色",
    });
    resolveAlign({ lrc: "[00:01.00]夜に駆ける\n[00:06.00]君と見た景色", lines: 2, duration: 30 });
    await tick();
    await nextTick();
    // 自动切回粘贴 tab，结果填入粘贴区，可保存
    expect(w.find(".paste-area").element.value).toContain("[00:01.00]夜に駆ける");
    expect(w.find(".btn-primary").attributes("disabled")).toBeUndefined();
    state.lyric = [];
    w.unmount();
  });

  it("既无粘贴文本也无现有歌词 → 按钮禁用（无法对齐）", async () => {
    mockFetch();
    state.lyric = [];
    const w = await openModal();
    await nextTick();
    await w.findAll(".spec-tab")[2].trigger("click"); // 切到粘贴 tab 也保持禁用
    await nextTick();
    expect(w.find(".align-btn").attributes("disabled")).toBeDefined();
    w.unmount();
  });
});

describe("LyricSpecModal 清除指定歌词（toast + 撤销）", () => {
  it("清除 → toast 出现（带撤销）→ 点撤销 → PUT 恢复被调用、手动标识恢复", async () => {
    const fetchMock = mockFetch({
      manual: {
        specified: true,
        format: "lrc",
        source: "粘贴",
        text: "[00:01.00]x",
        created_at: 1,
      },
    });
    const w = await openModal();
    expect(w.text()).toContain("已手动指定");
    // 清除指定 → DELETE + toast（带撤销）
    await w.find(".clear-link").trigger("click");
    await tick();
    expect(w.text()).not.toContain("已手动指定");
    const { items } = useToast();
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain("已清除指定歌词");
    expect(items[0].duration).toBe(5000);
    expect(items[0].action).toBeTruthy();
    // 点撤销 → PUT /api/lyric/manual 原样恢复
    items[0].action.onClick();
    await tick();
    const putCall = fetchMock.mock.calls.find(([, opts]) => opts?.method === "PUT");
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall[1].body)).toMatchObject({
      path: SONG.path,
      format: "lrc",
      text: "[00:01.00]x",
      source: "粘贴",
    });
    await nextTick();
    expect(w.text()).toContain("已手动指定"); // 重新拉取 → 手动标识恢复
    w.unmount();
  });

  it("清除失败 → toastError（不弹撤销）", async () => {
    mockFetch({
      manual: {
        specified: true,
        format: "lrc",
        source: "粘贴",
        text: "[00:01.00]x",
      },
      delete: () => Promise.resolve({ ok: false, json: async () => ({ detail: "失败" }) }),
    });
    const w = await openModal();
    await w.find(".clear-link").trigger("click");
    await tick();
    const { items } = useToast();
    expect(items.some((i) => i.type === "error")).toBe(true);
    expect(items.some((i) => i.action)).toBe(false);
    expect(w.text()).toContain("已手动指定"); // 清除失败 → 状态不变
    w.unmount();
  });
});
