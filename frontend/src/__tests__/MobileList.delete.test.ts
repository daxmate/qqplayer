// MobileList 左滑删除测试（任务 C：曲库删除 = 移到废纸篓 + 删磁盘文件）
// 覆盖：左滑露出删除按钮 / 网络歌(path=null)不显示删除 / 点删除弹确认层 / 取消不调接口 /
//       确认后 DELETE /api/library/songs 请求形状正确 / 成功后 toast + loadSongs 刷新 / missing/errors 汇总提示
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Audio stub（loadSongs 刷新链路可能触达 selectSong 相关分支）
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

const MobileList = (await import("../components/mobile/MobileList.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { clearToasts, useToast } = await import("../composables/useToast.js");

const lib = [
  { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
  { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" },
  // 网络歌（path=null）：不显示删除入口
  { id: "s1", path: null, name: "网络神曲", artist: "在线", album: null, type: "stream" },
];

// 路由式 fetch mock：DELETE /api/library/songs → deleteResult；GET /api/songs → 刷新后的曲库
interface DeleteResult {
  deleted: number;
  missing: string[];
  errors: Array<{ path: string; reason: string }>;
}
let deleteResult: DeleteResult = { deleted: 1, missing: [], errors: [] };
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  fetchMock = vi.fn(async (url: string, opt?: RequestInit) => {
    if (url === "/api/library/songs" && opt?.method === "DELETE") {
      return { ok: true, json: async () => deleteResult };
    }
    if (url === "/api/songs") {
      // 模拟后端删除后曲库：按 deleteResult.deleted 的路径去掉 a.mp3（测试内只删这一首）
      const songs = state.songs.filter((s) => s.path !== "/lib/a.mp3");
      return { ok: true, json: async () => songs };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
}

type TouchLike = { clientX: number; clientY: number };
function fireTouch(el: Element, type: string, touches?: TouchLike[], changedTouches?: TouchLike[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  if (touches) Object.defineProperty(ev, "touches", { value: touches, configurable: true });
  if (changedTouches)
    Object.defineProperty(ev, "changedTouches", { value: changedTouches, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

async function swipeRow(rowEl: Element, dx = -130) {
  const startX = 200;
  fireTouch(rowEl, "touchstart", [{ clientX: startX, clientY: 40 }]);
  fireTouch(rowEl, "touchmove", [{ clientX: startX + dx, clientY: 40 }]);
  fireTouch(rowEl, "touchend", [], [{ clientX: startX + dx, clientY: 40 }]);
  await flushPromises();
}

beforeEach(() => {
  Object.assign(state, {
    songs: lib.map((s) => ({ ...s })),
    currentIndex: 0,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
  });
  deleteResult = { deleted: 1, missing: [], errors: [] };
  clearToasts();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountList(props = {}) {
  return mount(MobileList, { props: { kind: "songs", title: "全部歌曲", ...props } });
}

describe("MobileList 左滑删除（移到废纸篓）", () => {
  it("左滑行 → 操作区出现删除按钮（危险样式类 ml-act-danger）", async () => {
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    const firstWrap = wrapper.findAll(".ml-wrap")[0];
    expect(firstWrap.classes()).toContain("open");
    const delBtn = firstWrap.find(".ml-actions .ml-act-danger");
    expect(delBtn.exists()).toBe(true);
    expect(delBtn.attributes("title")).toBe("删除");
    // 收藏/移除按钮仍在（零回归）
    expect(firstWrap.find(".ml-actions .ml-act").exists()).toBe(true);
    expect(firstWrap.find(".ml-actions .ml-act-remove").exists()).toBe(true);
  });

  it("网络歌（path=null）→ 操作区不渲染删除按钮（收藏/移除不受影响）", async () => {
    const wrapper = mountList();
    // 全列表删除按钮数量 = 本地歌数量（3 首歌里 1 首网络歌 → 2 个删除按钮）
    expect(wrapper.findAll(".ml-act-danger").length).toBe(2);
    // 网络歌那行的操作区没有删除按钮
    const wraps = wrapper.findAll(".ml-wrap");
    const streamWrap = wraps[2]; // lib 第三首为网络歌
    expect(streamWrap.find(".ml-actions .ml-act-danger").exists()).toBe(false);
    expect(streamWrap.find(".ml-actions .ml-act-remove").exists()).toBe(true);
  });

  it("点删除 → 弹出确认层（含歌名警告文案），行收起", async () => {
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    await wrapper.findAll(".ml-actions")[0].find(".ml-act-danger").trigger("click");
    await flushPromises();
    const mask = wrapper.find(".ml-confirm-mask");
    expect(mask.exists()).toBe(true);
    expect(mask.text()).toContain("雪の華");
    expect(mask.text()).toContain("废纸篓");
    // 行已收起
    expect(wrapper.findAll(".ml-wrap")[0].classes()).not.toContain("open");
  });

  it("确认层点取消 → 关闭弹层，不调 DELETE 接口", async () => {
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    await wrapper.findAll(".ml-actions")[0].find(".ml-act-danger").trigger("click");
    await wrapper.find(".ml-confirm-cancel").trigger("click");
    await flushPromises();
    expect(wrapper.find(".ml-confirm-mask").exists()).toBe(false);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url]) => url === "/api/library/songs")).toBe(false);
  });

  it("确认删除 → DELETE /api/library/songs（body {paths:[path]}）+ 成功 toast + loadSongs 刷新", async () => {
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    await wrapper.findAll(".ml-actions")[0].find(".ml-act-danger").trigger("click");
    await wrapper.find(".ml-confirm-ok").trigger("click");
    await flushPromises();

    // DELETE 请求形状正确
    const calls = vi.mocked(fetch).mock.calls;
    const delCall = calls.find(
      ([url, opt]) => url === "/api/library/songs" && opt?.method === "DELETE",
    );
    expect(delCall).toBeTruthy();
    expect(JSON.parse(delCall![1]!.body as unknown as string)).toEqual({ paths: ["/lib/a.mp3"] });
    expect((delCall![1]!.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );

    // 成功 toast
    expect(useToast().items[0].text).toBe("已删除《雪の華》");

    // loadSongs 被调（GET /api/songs）→ 曲库已刷新，被删歌曲消失
    expect(calls.some(([url]) => url === "/api/songs")).toBe(true);
    expect(state.songs.map((s) => s.path)).toEqual(["/lib/b.mp3", null]);
    // 弹层已关闭
    expect(wrapper.find(".ml-confirm-mask").exists()).toBe(false);
    // 刷新后列表中删除按钮数 = 剩余本地歌数（1）
    expect(wrapper.findAll(".ml-act-danger").length).toBe(1);
  });

  it("missing 非空 → 汇总 toast（部分删除失败），仍刷新曲库", async () => {
    deleteResult = { deleted: 0, missing: ["/lib/a.mp3"], errors: [] };
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    await wrapper.findAll(".ml-actions")[0].find(".ml-act-danger").trigger("click");
    await wrapper.find(".ml-confirm-ok").trigger("click");
    await flushPromises();
    expect(useToast().items[0].type).toBe("error");
    expect(useToast().items[0].text).toBe("部分歌曲删除失败（1 首）");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/songs")).toBe(true);
  });

  it("errors 非空 → 汇总 toast（部分删除失败）", async () => {
    deleteResult = {
      deleted: 0,
      missing: [],
      errors: [{ path: "/lib/a.mp3", reason: "权限不足" }],
    };
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    await wrapper.findAll(".ml-actions")[0].find(".ml-act-danger").trigger("click");
    await wrapper.find(".ml-confirm-ok").trigger("click");
    await flushPromises();
    expect(useToast().items[0].type).toBe("error");
    expect(useToast().items[0].text).toBe("部分歌曲删除失败（1 首）");
  });

  it("接口失败（HTTP 非 200）→ toastError，弹层关闭，不刷新", async () => {
    fetchMock.mockImplementation(async (url: string, opt?: RequestInit) => {
      if (url === "/api/library/songs" && opt?.method === "DELETE") {
        return { ok: false, status: 500, json: async () => ({ detail: "服务器错误" }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    const wrapper = mountList();
    await swipeRow(wrapper.findAll(".ml-item")[0].element, -130);
    await wrapper.findAll(".ml-actions")[0].find(".ml-act-danger").trigger("click");
    await wrapper.find(".ml-confirm-ok").trigger("click");
    await flushPromises();
    expect(useToast().items[0].type).toBe("error");
    expect(useToast().items[0].text).toBe("服务器错误");
    expect(wrapper.find(".ml-confirm-mask").exists()).toBe(false);
    // 未触发刷新
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/songs")).toBe(false);
  });
});
