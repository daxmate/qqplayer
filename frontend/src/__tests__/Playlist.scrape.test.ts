// Playlist 批量刮削：按钮显隐（batch_enabled）+ 调用链路（POST /api/tags/scrape-batch → 结果面板 → 刷新+清空多选）
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
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const Playlist = (await import("../components/Playlist.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { scrapingSettings, SCRAPING_SETTINGS_DEFAULTS } =
  await import("../composables/useScrapingSettings.js");
const { scrapeBatchState } = await import("../composables/useScrapeBatch.js");

const lib: Song[] = [
  { id: "a", path: "/lib/a.mp3", name: "A", artist: "X" },
  { id: "b", path: "/lib/b.mp3", name: "B", artist: "Y" },
];

function resetScrapeState() {
  scrapeBatchState.open = false;
  scrapeBatchState.loading = false;
  scrapeBatchState.error = "";
  scrapeBatchState.enabled = true;
  scrapeBatchState.truncated = false;
  scrapeBatchState.results = [];
  scrapeBatchState.summary = { total: 0, written: 0, skipped: 0, failed: 0 };
}

// 默认 fetch stub：scrape-batch 返回成功，/api/songs 返回空数组（loadSongs 刷新用）
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      if (url === "/api/tags/scrape-batch") {
        return {
          ok: true,
          json: async () => ({
            enabled: true,
            truncated: false,
            results: [
              {
                path: "/lib/a.mp3",
                status: "written",
                reason: "",
                written: ["year"],
                candidates: 2,
              },
              {
                path: "/lib/b.mp3",
                status: "failed",
                reason: "写标签失败",
                written: [],
                candidates: 0,
              },
            ],
            summary: { total: 2, written: 1, skipped: 0, failed: 1 },
          }),
        };
      }
      if (url === "/api/songs") return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  Object.assign(state, {
    songs: lib,
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    loading: false,
    error: "",
    favorites: [],
    playlists: [],
    activePlaylistId: null,
  });
  Object.assign(scrapingSettings, JSON.parse(JSON.stringify(SCRAPING_SETTINGS_DEFAULTS)));
  resetScrapeState();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // 清理 Teleport 到 body 的浮层残留（结果面板/加歌浮层）
  document.body
    .querySelectorAll(".modal-mask, .add-menu, .am-backdrop")
    .forEach((el) => el.remove());
});

async function selectRows(wrapper: VueWrapper, indices: number[]) {
  for (const i of indices) {
    await wrapper.findAll(".pl-item")[i].trigger("click", { metaKey: true });
  }
  await nextTick();
}

describe("批量刮削按钮显隐（batch_enabled 控制）", () => {
  it("batch_enabled=false（默认）→ 多选态也不显示批量刮削按钮", async () => {
    const w = mount(Playlist);
    await selectRows(w, [0]);
    expect(w.find(".pl-multi").exists()).toBe(true);
    expect(w.find('[data-testid="pl-multi-scrape"]').exists()).toBe(false);
    w.unmount();
  });

  it("batch_enabled=true → 未多选不显示；多选后显示", async () => {
    scrapingSettings.batch_enabled = true;
    const w = mount(Playlist);
    expect(w.find('[data-testid="pl-multi-scrape"]').exists()).toBe(false);
    await selectRows(w, [0]);
    expect(w.find('[data-testid="pl-multi-scrape"]').exists()).toBe(true);
    expect(w.find('[data-testid="pl-multi-scrape"]').text()).toContain("批量刮削");
    w.unmount();
  });
});

describe("批量刮削调用链路", () => {
  it("点击 → POST /api/tags/scrape-batch {paths: selectedPaths}，结果面板打开，多选清空 + 曲库刷新", async () => {
    scrapingSettings.batch_enabled = true;
    const w = mount(Playlist);
    await selectRows(w, [0, 1]);
    await w.find('[data-testid="pl-multi-scrape"]').trigger("click");
    await flushPromises();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const batchCalls = fetchMock.mock.calls.filter((c) => c[0] === "/api/tags/scrape-batch");
    expect(batchCalls).toHaveLength(1);
    expect(JSON.parse((batchCalls[0][1] as RequestInit).body as string)).toEqual({
      paths: ["/lib/a.mp3", "/lib/b.mp3"],
    });
    // 结果面板打开（Teleport 到 body）
    expect(scrapeBatchState.open).toBe(true);
    await nextTick();
    expect(document.body.textContent).toContain("批量刮削结果");
    expect(document.body.textContent).toContain("成功");
    // 刷新曲库（GET /api/songs force）+ 多选清空
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/songs")).toBe(true);
    expect(w.find(".pl-multi").exists()).toBe(false);
    w.unmount();
  });

  it("loading 态：按钮转圈显示「刮削中 N 首…」", async () => {
    scrapingSettings.batch_enabled = true;
    let resolveBatch!: (value: unknown) => void;
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/tags/scrape-batch") {
        return new Promise((res) => {
          resolveBatch = res;
        });
      }
      if (url === "/api/songs") return Promise.resolve({ ok: true, json: async () => [] });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    const w = mount(Playlist);
    await selectRows(w, [0, 1]);
    await w.find('[data-testid="pl-multi-scrape"]').trigger("click");
    await nextTick();
    expect(w.find('[data-testid="pl-multi-scrape"]').text()).toContain("刮削中 2 首");
    expect(scrapeBatchState.loading).toBe(true);
    resolveBatch({
      ok: true,
      json: async () => ({
        enabled: true,
        truncated: false,
        results: [],
        summary: { total: 0, written: 0, skipped: 0, failed: 0 },
      }),
    });
    await flushPromises();
    expect(scrapeBatchState.loading).toBe(false);
    w.unmount();
  });

  it("后端返回 enabled:false（未开启防御）→ 结果面板提示未启用", async () => {
    scrapingSettings.batch_enabled = true;
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/tags/scrape-batch") {
        return {
          ok: true,
          json: async () => ({
            enabled: false,
            truncated: false,
            results: [],
            summary: { total: 0, written: 0, skipped: 0, failed: 0 },
          }),
        };
      }
      if (url === "/api/songs") return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    });
    const w = mount(Playlist);
    await selectRows(w, [0]);
    await w.find('[data-testid="pl-multi-scrape"]').trigger("click");
    await flushPromises();
    expect(scrapeBatchState.open).toBe(true);
    await nextTick();
    expect(document.body.textContent).toContain("批量刮削未启用");
    w.unmount();
  });
});
