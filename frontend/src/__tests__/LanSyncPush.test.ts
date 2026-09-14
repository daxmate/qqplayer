// 推送面板测试（LanSyncPushPanel.vue + useLanSyncPush + useLanSyncRun）
// 覆盖：三级选择切换 / 歌单勾选载荷 / 单曲来源切换与来源内顺序 / 分页按钮 /
//       起跑 POST 载荷 / 运行视图计数与进度 / 取消动作 / 启动失败错误展示与 toast
// fetch 一律 mock（不依赖真后端）；定时器用 fake timers 驱动轮询
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { clearToasts, useToast } from "../composables/useToast.js";

const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock("../utils/apiClient.js", () => apiMock);

const LanSyncPushPanel = (await import("../components/settings/LanSyncPushPanel.vue")).default;
const { RUN_POLL_INTERVAL_MS } = await import("../composables/useLanSyncRun.js");

const ok = (data: unknown) => ({ ok: true, status: 200, data });
const fail = (status: number, message: string) => ({ ok: false, status, message });

/** flush：fake timers 下推进 1ms（setImmediate/setTimeout(0) 回调 + 微任务都跑完） */
const flush = async () => {
  await vi.advanceTimersByTimeAsync(1);
};

const SONGS = [
  { path: "/lib/03.mp3", name: "Golf", artist: "G", album: "X" },
  { path: "/lib/01.mp3", name: "Echo", artist: "E", album: "X" },
  { path: "/lib/02.mp3", name: "Delta", artist: "D", album: "X" },
  { path: null, name: "网络歌", type: "stream", streamId: "s1" },
];
const PLAYLISTS = [
  { id: "road", name: "Road Trip", songPaths: ["/lib/02.mp3", "/lib/01.mp3"] },
  { id: "fav", name: "空的", songPaths: [] },
];

let pushStatus: Record<string, unknown>;

function routeGet() {
  apiMock.apiGet.mockImplementation((url: string) => {
    if (url.startsWith("/api/songs")) return Promise.resolve(ok(SONGS));
    if (url.startsWith("/api/favorites")) return Promise.resolve(ok({ paths: ["/lib/01.mp3"] }));
    if (url.startsWith("/api/playlists")) return Promise.resolve(ok({ playlists: PLAYLISTS }));
    if (url.startsWith("/api/playback/stats")) return Promise.resolve(ok({ songs: [] }));
    if (url.startsWith("/api/playback")) return Promise.resolve(ok({ records: [] }));
    if (url.startsWith("/api/lansync/push/")) return Promise.resolve(ok(pushStatus));
    return Promise.resolve(ok({}));
  });
}

async function mountPanel(props: Record<string, unknown> = {}) {
  const w = mount(LanSyncPushPanel, {
    props: { peerId: "peer-1", deviceOnline: true, ...props },
  });
  await flush();
  return w;
}

beforeEach(() => {
  vi.useFakeTimers();
  pushStatus = { run_id: "run-1", peer_id: "peer-1", state: "pushing" };
  routeGet();
  apiMock.apiPost.mockResolvedValue(ok({ run_id: "run-1" }));
});

afterEach(() => {
  vi.useRealTimers();
  clearToasts();
  vi.clearAllMocks();
});

describe("LanSyncPushPanel 选择集", () => {
  it("默认「全部曲库」：说明里带可推送曲目数（不含网络歌），可以直接起跑", async () => {
    const w = await mountPanel();
    expect(w.get('[data-testid="lansync-push-all-desc"]').text()).toContain("3 首");
    expect(w.get('[data-testid="lansync-push-start"]').attributes("disabled")).toBeUndefined();
    w.unmount();
  });

  it("歌单与收藏：渲染收藏 + 真实歌单行，勾选后起跑载荷是 kind=playlists", async () => {
    const w = await mountPanel();
    await w.get('[data-testid="lansync-push-kind-playlists"]').trigger("click");
    await flush();

    expect(w.text()).toContain("收藏");
    expect(w.text()).toContain("Road Trip");
    expect(w.get('[data-testid="lansync-push-start"]').attributes("disabled")).toBeDefined();

    await w.get('[data-testid="lansync-push-playlist-road"]').find("input").setValue(true);
    await flush();
    expect(w.get('[data-testid="lansync-push-selected-sources"]').text()).toContain("1");

    await w.get('[data-testid="lansync-push-start"]').trigger("click");
    await flush();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/lansync/push", {
      peer_id: "peer-1",
      selection: { kind: "playlists", ids: ["road"] },
    });
    w.unmount();
  });

  it("单曲：来源下拉含全部曲库 / 收藏 / 真实歌单 / 自动歌单，列表按来源自身顺序", async () => {
    const w = await mountPanel();
    await w.get('[data-testid="lansync-push-kind-tracks"]').trigger("click");
    await flush();

    const options = w.get('[data-testid="lansync-push-source"]').findAll("option");
    expect(options.map((o) => o.text())).toEqual([
      "全部曲库",
      "收藏",
      "Road Trip",
      "空的",
      "最近添加",
      "最近播放",
      "常听排行",
    ]);

    // 切到歌单来源：成员序 = 歌单自身顺序（Delta 在 Echo 前）
    await w.get('[data-testid="lansync-push-source"]').setValue("road");
    await flush();
    const names = w
      .findAll('[data-testid="lansync-push-track"] .lansync-row-name')
      .map((n) => n.text());
    expect(names).toEqual(["Delta", "Echo"]);

    // 勾选一首 → 起跑载荷是 kind=tracks + 绝对路径
    await w.findAll('[data-testid="lansync-push-track"] input')[1].setValue(true);
    await flush();
    expect(w.get('[data-testid="lansync-push-selected"]').text()).toContain("1");
    await w.get('[data-testid="lansync-push-start"]').trigger("click");
    await flush();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/lansync/push", {
      peer_id: "peer-1",
      selection: { kind: "tracks", ids: ["/lib/01.mp3"] },
    });
    w.unmount();
  });

  it("单曲：搜索只过滤不重排；全选本页 / 取消本页", async () => {
    const w = await mountPanel();
    await w.get('[data-testid="lansync-push-kind-tracks"]').trigger("click");
    await flush();

    await w.get('[data-testid="lansync-push-search"]').setValue("golf");
    await flush();
    expect(
      w.findAll('[data-testid="lansync-push-track"] .lansync-row-name').map((n) => n.text()),
    ).toEqual(["Golf"]);

    await w.get('[data-testid="lansync-push-search"]').setValue("");
    await flush();
    await w.get('[data-testid="lansync-push-select-page"]').trigger("click");
    await flush();
    expect(w.get('[data-testid="lansync-push-selected"]').text()).toContain("3");

    await w.get('[data-testid="lansync-push-unselect-page"]').trigger("click");
    await flush();
    expect(w.get('[data-testid="lansync-push-selected"]').text()).toContain("0");
    w.unmount();
  });

  it("设备离线：起跑按钮禁用并提示", async () => {
    const w = await mountPanel({ deviceOnline: false });
    expect(w.get('[data-testid="lansync-push-start"]').attributes("disabled")).toBeDefined();
    expect(w.text()).toContain("离线");
    w.unmount();
  });
});

describe("LanSyncPushPanel 运行视图", () => {
  it("起跑后轮询状态：渲染计划 / 已完成 / 跳过 / 失败计数与进度", async () => {
    pushStatus = {
      run_id: "run-1",
      peer_id: "peer-1",
      state: "pushing",
      sentBytes: 1024,
      totalBytes: 2048,
      plannedCount: 4,
      skippedCount: 1,
      completedCount: 2,
      failedCount: 1,
      failed: [{ relativePath: "a/b.mp3", reason: "send_failed" }],
    };
    const w = await mountPanel();
    await w.get('[data-testid="lansync-push-start"]').trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS + 1);

    expect(apiMock.apiGet).toHaveBeenCalledWith("/api/lansync/push/run-1");
    expect(w.get('[data-testid="lansync-run-planned"]').text()).toContain("4");
    expect(w.get('[data-testid="lansync-run-completed"]').text()).toContain("2");
    expect(w.get('[data-testid="lansync-run-skipped"]').text()).toContain("1");
    expect(w.get('[data-testid="lansync-run-failed"]').text()).toContain("1");
    expect(w.get('[data-testid="lansync-run-state"]').text()).toBe("推送中");
    expect(w.get('[data-testid="lansync-run-bar"]').attributes("aria-valuenow")).toBe("50");

    // 失败明细：格式化的原因 + 原始 reason
    await w.get('[data-testid="lansync-run-failures"]').trigger("click");
    await flush();
    const failure = w.get('[data-testid="lansync-run-failure"]').text();
    expect(failure).toContain("a/b.mp3");
    expect(failure).toContain("发送失败（设备未确认）");
    w.unmount();
  });

  it("取消：POST cancel 并刷新状态；终态后不再显示取消按钮", async () => {
    const w = await mountPanel();
    await w.get('[data-testid="lansync-push-start"]').trigger("click");
    await flush();

    apiMock.apiPost.mockResolvedValue(ok({ cancelled: true }));
    pushStatus = { run_id: "run-1", state: "failed", error: "已取消", failedCount: 0 };
    await w.get('[data-testid="lansync-run-cancel"]').trigger("click");
    await flush();

    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/lansync/push/run-1/cancel");
    expect(w.find('[data-testid="lansync-run-cancel"]').exists()).toBe(false);
    expect(w.text()).toContain("已取消");
    w.unmount();
  });

  it("启动失败（503 服务未运行）：显示后端 detail + 错误 toast，不产生运行视图", async () => {
    apiMock.apiPost.mockResolvedValue(fail(503, "局域网同步服务未运行"));
    const w = await mountPanel();
    await w.get('[data-testid="lansync-push-start"]').trigger("click");
    await flush();

    expect(w.find('[data-testid="lansync-run"]').exists()).toBe(false);
    const toasts = useToast().items as Array<{ type: string; text: string }>;
    expect(toasts.at(-1)?.type).toBe("error");
    expect(toasts.at(-1)?.text).toContain("局域网同步服务未运行");
    w.unmount();
  });

  it("正常结束：终态显示「全部完成」并 toast", async () => {
    pushStatus = {
      run_id: "run-1",
      state: "done",
      sentBytes: 10,
      totalBytes: 10,
      plannedCount: 2,
      completedCount: 2,
      skippedCount: 0,
      failedCount: 0,
    };
    const w = await mountPanel();
    await w.get('[data-testid="lansync-push-start"]').trigger("click");
    await flush();
    await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS + 1);

    expect(w.get('[data-testid="lansync-run-summary"]').text()).toContain("全部完成");
    expect(w.find('[data-testid="lansync-run-cancel"]').exists()).toBe(false);
    const toasts = useToast().items as Array<{ text: string }>;
    expect(toasts.at(-1)?.text).toContain("推送完成");
    w.unmount();
  });
});
