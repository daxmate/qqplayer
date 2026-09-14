// 取回面板测试（LanSyncPullPanel.vue + useLanSyncPull + useLanSyncRun，经 LanSyncSettingsPanel 集成挂载）
// 覆盖：内容同步分段与设备选择 / 浏览设备内容的 preview 请求载荷 / 异步清单经事件回执渲染 /
//       歌单与曲目范围切换 / 分页 / 搜索去抖 / 勾选与「取回入库」载荷 / 运行视图（拉取键映射）/ 回执错误与超时
// fetch 一律 mock；事件回执走 lansync 事件轮询（模块级事件总线），定时器 fake timers 驱动
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { clearToasts } from "../composables/useToast.js";

const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock("../utils/apiClient.js", () => apiMock);

const LanSyncSettingsPanel = (await import("../components/settings/LanSyncSettingsPanel.vue"))
  .default;
const { POLL_INTERVAL_MS } = await import("../composables/useLanSync.js");
const { PEER_SEARCH_DEBOUNCE_MS, PEER_PREVIEW_TIMEOUT_MS } =
  await import("../composables/useLanSyncPull.js");
const { RUN_POLL_INTERVAL_MS } = await import("../composables/useLanSyncRun.js");

const ok = (data: unknown) => ({ ok: true, status: 200, data });
const fail = (status: number, message: string) => ({ ok: false, status, message });

const flush = async () => {
  await vi.advanceTimersByTimeAsync(1);
};

const PEER_ID = "peer-1";

const deviceFixture = (over: Record<string, unknown> = {}) => ({
  peer_id: PEER_ID,
  display_name: "我的 iPhone",
  online: true,
  last_seen_at: 1700000000,
  ...over,
});

const PLAYLIST_ITEMS = [
  { kind: "playlist", playlist: { id: "p1", name: "Road Trip", trackCount: 12 } },
  { kind: "playlist", playlist: { id: "@favorites", name: "收藏", trackCount: 3 } },
];
const TRACK_ITEMS = [
  {
    kind: "track",
    track: {
      relativePath: "Albums/a.mp3",
      title: "Alpha",
      artistName: "A",
      sizeBytes: 1024,
      contentHash: "h1",
    },
  },
  {
    kind: "track",
    track: {
      relativePath: "Albums/b.mp3",
      title: "Beta",
      artistName: "B",
      sizeBytes: 2048,
      contentHash: "h2",
    },
  },
];

// ---- mock 状态 ----
let devices: unknown[] = [deviceFixture()];
let running = true;
let previewSeq = 0;
let lastRequestId = "";
let previewItems: unknown[] = PLAYLIST_ITEMS;
let previewTotal = 2;
let previewHasMore = false;
let previewError: string | null = null;
let previewRequestError: { status: number; message: string } | null = null;
let pullStatus: Record<string, unknown>;
let previewCalls: Array<Record<string, unknown>> = [];

function previewEvent(): unknown[] {
  if (!lastRequestId || previewError === null || previewRequestError) return [];
  return [
    {
      type: "pull",
      action: "preview",
      requestID: lastRequestId,
      scope: "tracks",
      offset: 0,
      limit: 100,
      total: previewTotal,
      items: previewItems,
      hasMore: previewHasMore,
      libraryTrackCount: 42,
      librarySizeBytes: 1024 * 1024 * 3,
      truncated: false,
      playlistCount: 5,
      trackCount: 42,
    },
  ];
}

function routeApi() {
  apiMock.apiGet.mockImplementation((url: string) => {
    if (url.startsWith("/api/lansync/status")) {
      return Promise.resolve(
        ok({ available: true, running, port: 51234, device_name: "Mac", protocol_version: 1 }),
      );
    }
    if (url.startsWith("/api/lansync/identity")) {
      return Promise.resolve(ok({ device_id: "ID", device_id_formatted: "ID", public_key: "k" }));
    }
    if (url.startsWith("/api/lansync/pairing/pending"))
      return Promise.resolve(ok({ requests: [] }));
    if (url.startsWith("/api/lansync/devices")) return Promise.resolve(ok({ devices }));
    if (url.startsWith("/api/lansync/events")) {
      return Promise.resolve(ok({ cursor: 1, events: previewEvent() }));
    }
    if (url.startsWith("/api/lansync/pull/")) return Promise.resolve(ok(pullStatus));
    if (url.startsWith("/api/songs")) return Promise.resolve(ok([]));
    if (url.startsWith("/api/favorites")) return Promise.resolve(ok({ paths: [] }));
    if (url.startsWith("/api/playlists")) return Promise.resolve(ok({ playlists: [] }));
    if (url.startsWith("/api/playback")) return Promise.resolve(ok({ records: [], songs: [] }));
    return Promise.resolve(ok({}));
  });

  apiMock.apiPost.mockImplementation((url: string, body?: Record<string, unknown>) => {
    if (url === "/api/lansync/pull/preview") {
      previewCalls.push(body || {});
      if (previewRequestError) {
        return Promise.resolve(fail(previewRequestError.status, previewRequestError.message));
      }
      previewSeq += 1;
      lastRequestId = `req-${previewSeq}`;
      return Promise.resolve(
        ok({ request_id: lastRequestId, scope: body?.scope, offset: body?.offset, limit: 100 }),
      );
    }
    if (url === "/api/lansync/pull") return Promise.resolve(ok({ run_id: "run-pull-1" }));
    if (url.endsWith("/cancel")) return Promise.resolve(ok({ cancelled: true }));
    return Promise.resolve(ok({}));
  });
}

/** 只让事件接口吐指定事件，其余走默认 mock（用于手工构造回执时序） */
function mockEventsOnly(events: unknown[]) {
  const base = apiMock.apiGet.getMockImplementation()!;
  apiMock.apiGet.mockImplementation((url: string) => {
    if (url.startsWith("/api/lansync/events")) return Promise.resolve(ok({ cursor: 9, events }));
    return base(url);
  });
}

/** 挂载面板 → 切「内容同步」 → 切「从设备取回」 */
async function openPullTab() {
  const w = mount(LanSyncSettingsPanel);
  await flush();
  await w.get('[data-testid="lansync-section-content"]').trigger("click");
  await flush();
  await w.get('[data-testid="lansync-content-pull-tab"]').trigger("click");
  await flush();
  return w;
}

/** 浏览设备内容并等事件回执落屏 */
async function browse(w: Awaited<ReturnType<typeof openPullTab>>) {
  await w.get('[data-testid="lansync-pull-browse"]').trigger("click");
  await flush();
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
  await flush();
  return w;
}

beforeEach(() => {
  vi.useFakeTimers();
  devices = [deviceFixture()];
  running = true;
  previewSeq = 0;
  lastRequestId = "";
  previewItems = PLAYLIST_ITEMS;
  previewTotal = 2;
  previewHasMore = false;
  previewError = "";
  previewRequestError = null;
  previewCalls = [];
  pullStatus = {
    run_id: "run-pull-1",
    peer_id: PEER_ID,
    state: "fetching",
    requestedCount: 3,
    unchangedCount: 1,
    completedCount: 2,
    failedCount: 0,
    receivedBytes: 50,
    totalBytes: 100,
    failed: [],
  };
  routeApi();
});

afterEach(() => {
  vi.useRealTimers();
  clearToasts();
  vi.clearAllMocks();
});

describe("LanSyncSettingsPanel 内容同步分段", () => {
  it("默认停在「设备与配对」；切到内容同步后显示设备选择与语义提示", async () => {
    const w = mount(LanSyncSettingsPanel);
    await flush();
    // 配对段内容在，内容同步面板还没挂
    expect(w.find('[data-testid="lansync-device-id"]').exists()).toBe(true);
    expect(w.find('[data-testid="lansync-content-device"]').exists()).toBe(false);

    await w.get('[data-testid="lansync-section-content"]').trigger("click");
    await flush();
    expect(w.find('[data-testid="lansync-device-id"]').exists()).toBe(false);
    expect(w.find('[data-testid="lansync-content-device"]').exists()).toBe(true);
    expect(w.text()).toContain("推送 = 把本机选中的内容送到设备");
    w.unmount();
  });

  it("没有已配对设备 / 服务未运行：给出提示，不渲染推送取回子面板", async () => {
    devices = [];
    const w = mount(LanSyncSettingsPanel);
    await flush();
    await w.get('[data-testid="lansync-section-content"]').trigger("click");
    await flush();
    expect(w.get('[data-testid="lansync-content-nodevice"]').text()).toContain("还没有已配对设备");
    expect(w.find('[data-testid="lansync-content-push-tab"]').exists()).toBe(false);
    w.unmount();
  });
});

describe("取回：浏览设备内容", () => {
  it("点「浏览设备内容」发 preview 请求（scope=playlists, offset=0），回执后渲染歌单与摘要", async () => {
    const w = await openPullTab();
    await browse(w);

    expect(previewCalls[0]).toEqual({
      peer_id: PEER_ID,
      scope: "playlists",
      query: "",
      offset: 0,
      limit: 100,
    });
    const rows = w.findAll('[data-testid="lansync-pull-playlist"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("Road Trip");
    expect(rows[0].text()).toContain("12 首");
    expect(w.get('[data-testid="lansync-pull-summary"]').text()).toContain("42");
    expect(w.get('[data-testid="lansync-pull-summary"]').text()).toContain("3.0 MB");
    w.unmount();
  });

  it("切到「设备曲目」→ scope=tracks；勾选一首 → 取回载荷是 relative_paths 点名集合", async () => {
    const w = await openPullTab();
    await browse(w);

    previewItems = TRACK_ITEMS;
    previewTotal = 2;
    await w.get('[data-testid="lansync-pull-scope-tracks"]').trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await flush();
    expect(previewCalls.at(-1)).toMatchObject({ scope: "tracks", offset: 0 });

    const tracks = w.findAll('[data-testid="lansync-pull-track"]');
    expect(tracks).toHaveLength(2);
    expect(tracks[0].text()).toContain("Alpha");
    // 未勾选时不能取回
    expect(w.get('[data-testid="lansync-pull-start"]').attributes("disabled")).toBeDefined();

    await tracks[0].find("input").setValue(true);
    await flush();
    expect(w.get('[data-testid="lansync-pull-selected"]').text()).toContain("1");
    expect(w.get('[data-testid="lansync-pull-start"]').attributes("disabled")).toBeUndefined();

    await w.get('[data-testid="lansync-pull-start"]').trigger("click");
    await flush();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/lansync/pull", {
      peer_id: PEER_ID,
      relative_paths: ["Albums/a.mp3"],
    });
    w.unmount();
  });

  it("分页：hasMore 时下一页按页大小推进 offset，首页上一页禁用", async () => {
    previewHasMore = true;
    previewTotal = 250;
    const w = await openPullTab();
    await browse(w);
    await w.get('[data-testid="lansync-pull-scope-tracks"]').trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await flush();

    expect(w.get('[data-testid="lansync-pull-prev"]').attributes("disabled")).toBeDefined();
    await w.get('[data-testid="lansync-pull-next"]').trigger("click");
    await flush();
    expect(previewCalls.at(-1)).toMatchObject({ scope: "tracks", offset: 100 });
    w.unmount();
  });

  it("搜索：输入后去抖再请求（带 query），不立即发请求", async () => {
    const w = await openPullTab();
    await browse(w);
    const before = previewCalls.length;

    await w.get('[data-testid="lansync-pull-search"]').setValue("road");
    await flush();
    expect(previewCalls).toHaveLength(before); // 去抖期内不请求

    await vi.advanceTimersByTimeAsync(PEER_SEARCH_DEBOUNCE_MS + 1);
    await flush();
    expect(previewCalls.at(-1)).toMatchObject({ query: "road", offset: 0 });
    w.unmount();
  });

  it("回执错误 / 对端超时：展示可读提示且不崩", async () => {
    const w = await openPullTab();

    // 1) preview_error（带文案）：走事件轮询路径把错误回执交给面板
    previewError = null; // 不再自动回 preview 事件
    await w.get('[data-testid="lansync-pull-browse"]').trigger("click");
    await flush();
    const requestId = lastRequestId;
    mockEventsOnly([
      { type: "pull", action: "preview_error", requestID: requestId, message: "对端未准备好" },
    ]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await flush();
    expect(w.text()).toContain("对端未准备好");

    // 2) 一直没有回执 → 超时提示（搜索触发一次新请求）
    routeApi();
    await w.get('[data-testid="lansync-pull-search"]').setValue("x");
    await vi.advanceTimersByTimeAsync(PEER_SEARCH_DEBOUNCE_MS + 1);
    await flush();
    mockEventsOnly([]);
    await vi.advanceTimersByTimeAsync(PEER_PREVIEW_TIMEOUT_MS + 1);
    await flush();
    expect(w.get('[data-testid="lansync-pull-timeout"]').text()).toContain("设备未响应");
    w.unmount();
  });
});

describe("取回：运行视图", () => {
  it("起跑后轮询拉取状态：requested/unchanged/completed/failed 映射到同一套计数；可取消", async () => {
    const w = await openPullTab();
    await browse(w);
    previewItems = TRACK_ITEMS;
    await w.get('[data-testid="lansync-pull-scope-tracks"]').trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await flush();

    await w.findAll('[data-testid="lansync-pull-track"] input')[0].setValue(true);
    await flush();
    await w.get('[data-testid="lansync-pull-start"]').trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS + 1);

    expect(apiMock.apiGet).toHaveBeenCalledWith("/api/lansync/pull/run-pull-1");
    expect(w.get('[data-testid="lansync-run-planned"]').text()).toContain("3"); // requestedCount
    expect(w.get('[data-testid="lansync-run-skipped"]').text()).toContain("1"); // unchangedCount
    expect(w.get('[data-testid="lansync-run-completed"]').text()).toContain("2");
    expect(w.get('[data-testid="lansync-run-state"]').text()).toBe("取回中");

    pullStatus = { ...pullStatus, state: "failed", error: "连接已断开" };
    await w.get('[data-testid="lansync-run-cancel"]').trigger("click");
    await flush();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/lansync/pull/run-pull-1/cancel");
    expect(w.text()).toContain("连接已断开");
    w.unmount();
  });
});
