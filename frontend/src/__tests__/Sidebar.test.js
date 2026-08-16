// Sidebar 删除歌单 → toast + 撤销流程测试
// 覆盖：点击删除 → toast 出现（带撤销）→ 点撤销 → 恢复 API 被调用 → 歌单回到列表；
//      不点撤销 → duration 后消失不恢复；删除失败 → toastError 不弹撤销
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

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

const Sidebar = (await import("../components/Sidebar.vue")).default;
const ToastContainer = (await import("../components/ToastContainer.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { clearToasts } = await import("../composables/useToast.js");

const PLAYLIST = {
  id: "pl1",
  name: "旅行",
  songPaths: ["/a.mp3", "/b.mp3"],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

// fetch mock：DELETE 成功；POST /api/playlists 返回新歌单；POST songs 成功
function stubFetch() {
  const calls = [];
  const fn = vi.fn(async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body });
    if (url === "/api/playlists" && opts.method === "POST") {
      const name = JSON.parse(opts.body).name;
      return {
        ok: true,
        json: async () => ({
          id: "new123",
          name,
          songPaths: [],
          createdAt: "2026-08-16T00:00:00Z",
          updatedAt: "2026-08-16T00:00:00Z",
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function mountAll() {
  const sidebar = mount(Sidebar);
  // 共享同一单例 toast 状态，stub Teleport 后内容在 wrapper 内可查询
  const toasts = mount(ToastContainer, {
    global: { stubs: { teleport: true } },
  });
  return { sidebar, toasts };
}

async function flush() {
  await flushPromises();
}

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    playlists: [JSON.parse(JSON.stringify(PLAYLIST))],
    activePlaylistId: null,
    favorites: [],
  });
  clearToasts();
  vi.useRealTimers();
});

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Sidebar 删除歌单（toast + 撤销）", () => {
  it("点击删除 → 歌单移除 + toast 出现（带撤销按钮）", async () => {
    stubFetch();
    const { sidebar, toasts } = mountAll();

    await sidebar.find(".sb-act.danger").trigger("click");
    await flush();

    // 歌单已删除
    expect(state.playlists).toHaveLength(0);
    // toast 出现，带撤销按钮
    const item = toasts.find(".toast-item");
    expect(item.exists()).toBe(true);
    expect(item.text()).toContain("已删除歌单「旅行」");
    expect(item.find(".toast-action").text()).toBe("撤销");
  });

  it("点撤销 → 恢复 API 被调用（重建 + 批量加歌）→ 歌单回到列表 → 提示已恢复", async () => {
    const { calls } = stubFetch();
    const { sidebar, toasts } = mountAll();

    await sidebar.find(".sb-act.danger").trigger("click");
    await flush();
    expect(state.playlists).toHaveLength(0);

    await toasts.find(".toast-action").trigger("click");
    await flush();

    // 恢复 API：POST /api/playlists（重建）+ 每首歌 POST songs
    const createCalls = calls.filter((c) => c.url === "/api/playlists" && c.method === "POST");
    expect(createCalls).toHaveLength(1);
    expect(JSON.parse(createCalls[0].body)).toEqual({ name: "旅行" });
    const songCalls = calls.filter((c) => c.method === "POST" && c.url.includes("/songs"));
    expect(songCalls.map((c) => c.url)).toEqual([
      "/api/playlists/new123/songs",
      "/api/playlists/new123/songs",
    ]);

    // 歌单回到列表，歌曲完整
    expect(state.playlists).toHaveLength(1);
    expect(state.playlists[0].name).toBe("旅行");
    expect(state.playlists[0].songPaths).toEqual(["/a.mp3", "/b.mp3"]);
    // 撤销 toast 消失，出现"已恢复"提示
    expect(toasts.find(".toast-action").exists()).toBe(false);
    expect(toasts.find(".toast-item").text()).toContain("已恢复歌单「旅行」");
  });

  it("不点撤销 → duration（5s）后 toast 消失，歌单不恢复", async () => {
    vi.useFakeTimers();
    const { fn, calls } = stubFetch();
    const { sidebar, toasts } = mountAll();

    await sidebar.find(".sb-act.danger").trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(toasts.find(".toast-action").exists()).toBe(true);
    expect(state.playlists).toHaveLength(0);

    // 5s 撤销窗口期（模拟 4.9s 仍在）
    await vi.advanceTimersByTimeAsync(4900);
    expect(toasts.find(".toast-action").exists()).toBe(true);

    // 过期 → toast 消失，无恢复调用
    await vi.advanceTimersByTimeAsync(100);
    expect(toasts.find(".toast-item").exists()).toBe(false);
    expect(state.playlists).toHaveLength(0);
    expect(calls.filter((c) => c.url === "/api/playlists" && c.method === "POST")).toHaveLength(0);
    expect(fn).toHaveBeenCalledWith(
      "/api/playlists/pl1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("删除失败（API 报错）→ toastError，不弹撤销", async () => {
    // useLibrary.deletePlaylist 对非 2xx 统一抛 "删除失败"（不转发后端 detail）
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ detail: "歌单不存在" }) })),
    );
    const { sidebar, toasts } = mountAll();

    await sidebar.find(".sb-act.danger").trigger("click");
    await flush();

    // 歌单还在（useLibrary 回滚）
    expect(state.playlists).toHaveLength(1);
    // error toast，无撤销按钮
    const item = toasts.find(".toast-item");
    expect(item.exists()).toBe(true);
    expect(item.classes()).toContain("toast-error");
    expect(item.text()).toContain("删除失败");
    expect(item.find(".toast-action").exists()).toBe(false);
  });
});
