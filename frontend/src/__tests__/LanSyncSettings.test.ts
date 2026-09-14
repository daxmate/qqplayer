// 局域网同步面板 + useLanSync 测试（设置弹窗「局域网同步」Tab）
// 覆盖：身份分组渲染 / 服务未运行降级（按钮禁用 + 文案）/ 展示二维码与停止展示 /
//       待批准卡批准与拒绝 / 已配对设备撤销（二次确认）/ 服务端错误提示 /
//       事件游标轮询（有新事件才刷新列表、游标随响应推进）
// 注意：面板弹窗走 Teleport（在 document.body），列表断言用 wrapper.text()
import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { clearToasts, useToast } from "../composables/useToast.js";

// ---------- mock：apiClient（归一化返回 {ok, status, data}） ----------
const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock("../utils/apiClient.js", () => apiMock);

const LanSyncSettingsPanel = (await import("../components/settings/LanSyncSettingsPanel.vue"))
  .default;
const { useLanSync, POLL_INTERVAL_MS } = await import("../composables/useLanSync.js");

const ok = (data: unknown) => ({ ok: true, status: 200, data });

/** 设备 ID：52 位 = 7×7 + 3，分组展示 8 组 */
const FULL_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".repeat(2).slice(0, 52);
const ID_GROUPS = FULL_ID.match(/.{1,7}/g) as string[];

const statusFixture = (over: Record<string, unknown> = {}) => ({
  available: true,
  running: true,
  port: 51234,
  device_name: "Mac-Studio",
  protocol_version: 1,
  error: null,
  ...over,
});

const identityFixture = () => ({
  device_id: FULL_ID,
  device_id_formatted: ID_GROUPS.join("-"),
  device_id_groups: ID_GROUPS,
  short_parts: [ID_GROUPS[0], ID_GROUPS[ID_GROUPS.length - 1]],
  public_key: "cHVibGljLWtleQ==",
});

const pendingFixture = (over: Record<string, unknown> = {}) => ({
  request_id: "req-1",
  device_id: FULL_ID,
  device_id_formatted: ID_GROUPS.join("-"),
  display_name: "我的 iPhone",
  suggested_display_name: ID_GROUPS.join("-"),
  received_at: Date.now() / 1000,
  ...over,
});

const deviceFixture = (over: Record<string, unknown> = {}) => ({
  peer_id: FULL_ID,
  display_name: "我的 iPhone",
  role: "client",
  paired_at: Date.now() / 1000 - 600,
  last_seen_at: Date.now() / 1000 - 30,
  online: true,
  phase: "ready",
  ...over,
});

/** 按 URL 路由 apiGet（默认：服务运行中、无待批准、无设备、无新事件） */
function routeGet({
  status = statusFixture(),
  identity = identityFixture(),
  requests = [] as unknown[],
  devices = [] as unknown[],
  events = { cursor: 0, events: [] as unknown[] },
} = {}) {
  apiMock.apiGet.mockImplementation((url: string) => {
    if (url.startsWith("/api/lansync/status")) return Promise.resolve(ok(status));
    if (url.startsWith("/api/lansync/identity")) return Promise.resolve(ok(identity));
    if (url.startsWith("/api/lansync/pairing/pending")) return Promise.resolve(ok({ requests }));
    if (url.startsWith("/api/lansync/devices")) return Promise.resolve(ok({ devices }));
    if (url.startsWith("/api/lansync/events")) return Promise.resolve(ok(events));
    return Promise.resolve(ok({}));
  });
}

async function mountPanel() {
  const w = mount(LanSyncSettingsPanel);
  await flushPromises();
  return w;
}

afterEach(() => {
  vi.useRealTimers();
  clearToasts();
  document.body.innerHTML = "";
});

describe("LanSyncSettingsPanel", () => {
  it("渲染本机身份：设备名 + Device ID 分组（8 组，供手输核对）", async () => {
    routeGet();
    const w = await mountPanel();
    expect(w.get('[data-testid="lansync-device-name"]').text()).toBe("Mac-Studio");
    expect(w.findAll(".lansync-id-group")).toHaveLength(8);
    expect(w.get('[data-testid="lansync-device-id"]').text().replace(/-/g, "")).toBe(FULL_ID);
    w.unmount();
  });

  it("服务未运行：显示未运行与降级提示，展示二维码按钮禁用", async () => {
    routeGet({ status: statusFixture({ running: false, port: 0 }) });
    const w = await mountPanel();
    expect(w.text()).toContain("未运行");
    const showBtn = w.get('[data-testid="lansync-show-qr"]');
    expect(showBtn.attributes("disabled")).toBeDefined();
    expect(w.text()).toContain("服务未启动");
    w.unmount();
  });

  it("服务初始化失败：status.error 原样展示给用户", async () => {
    routeGet({
      status: statusFixture({ running: false, error: "IdentityStoreError: 身份文件损坏" }),
    });
    const w = await mountPanel();
    expect(w.text()).toContain("身份文件损坏");
    w.unmount();
  });

  it("展示二维码 → POST 并渲染图片；停止展示 → 清除二维码", async () => {
    routeGet();
    apiMock.apiPost.mockResolvedValue(
      ok({ qr_payload: '{"protoVersion":1}', qr_image: "data:image/png;base64,AAAB" }),
    );
    const w = await mountPanel();
    await w.get('[data-testid="lansync-show-qr"]').trigger("click");
    await flushPromises();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/lansync/pairing/start");
    expect(w.get("img.lansync-qr").attributes("src")).toBe("data:image/png;base64,AAAB");

    await w.get("[data-testid='lansync-stop-qr']").trigger("click");
    await flushPromises();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/lansync/pairing/stop");
    expect(w.find("img.lansync-qr").exists()).toBe(false);
    w.unmount();
  });

  it("待批准卡：显示设备名与 ID 短格式，批准走 POST approve", async () => {
    routeGet({ requests: [pendingFixture()] });
    apiMock.apiPost.mockResolvedValue(ok({ ok: true, approved: true }));
    const w = await mountPanel();
    expect(w.text()).toContain("我的 iPhone");
    expect(w.text()).toContain(`${ID_GROUPS[0]}…${ID_GROUPS[7]}`);

    await w.get('[data-testid="lansync-approve-req-1"]').trigger("click");
    await flushPromises();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/lansync/pairing/req-1/approve", {});
    w.unmount();
  });

  it("待批准卡：拒绝走 POST reject；接口失败弹错误提示", async () => {
    routeGet({ requests: [pendingFixture()] });
    apiMock.apiPost.mockResolvedValue({
      ok: false,
      status: 404,
      message: "配对请求不存在或已过期",
    });
    const w = await mountPanel();
    await w.get('[data-testid="lansync-reject-req-1"]').trigger("click");
    await flushPromises();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/lansync/pairing/req-1/reject");
    // 面板本身不挂 ToastContainer（toast DOM 由 App 渲染）→ 断言 toast 队列
    const toasts = useToast().items as Array<{ type: string; text: string }>;
    expect(toasts.at(-1)?.type).toBe("error");
    expect(toasts.at(-1)?.text).toContain("操作失败");
    w.unmount();
  });

  it("已配对设备：在线状态 + 最近连接；撤销需二次确认后 DELETE", async () => {
    routeGet({ devices: [deviceFixture({ online: false })] });
    apiMock.apiDelete.mockResolvedValue(ok({ ok: true }));
    const w = await mountPanel();
    expect(w.text()).toContain("我的 iPhone");
    expect(w.text()).toContain("离线");
    expect(apiMock.apiDelete).not.toHaveBeenCalled();

    await w.get(`[data-testid="lansync-revoke-${FULL_ID}"]`).trigger("click");
    await flushPromises();
    expect(document.body.textContent).toContain("确定撤销");
    await document.body
      .querySelector<HTMLElement>('[data-testid="lansync-revoke-confirm"]')!
      .click();
    await flushPromises();
    expect(apiMock.apiDelete).toHaveBeenCalledWith(`/api/lansync/devices/${FULL_ID}`);
    w.unmount();
  });

  it("同步范围如实告知：配对 + 连接与内容同步都写清，不写已支持全库镜像", async () => {
    routeGet();
    const w = await mountPanel();
    const text = w.text();
    expect(text).toContain("配对 + 连接");
    expect(text).toContain("删除不会跨端传播");
    expect(text).toContain("不做全库镜像");
    expect(text).toContain("随歌同步由后端处理");
    w.unmount();
  });
});

describe("useLanSync 轮询", () => {
  it("事件游标随响应推进，有新事件才重拉列表", async () => {
    vi.useFakeTimers();
    routeGet({ events: { cursor: 0, events: [] } });
    const api = useLanSync();

    await api.refresh();
    const listCalls = () =>
      apiMock.apiGet.mock.calls.filter(
        (c) =>
          c[0].startsWith("/api/lansync/pairing/pending") ||
          c[0].startsWith("/api/lansync/devices"),
      ).length;
    const before = listCalls();

    // 空转：拉到新游标但没有事件 → 不重拉列表
    apiMock.apiGet.mockImplementation((url: string) => {
      if (url === "/api/lansync/events?cursor=0")
        return Promise.resolve(ok({ cursor: 7, events: [] }));
      return Promise.resolve(ok({}));
    });
    await api.pollEvents();
    expect(listCalls()).toBe(before);

    // 有新事件 → 重拉 pending/devices；游标推进到 9，下一次查询用新游标
    const queried: string[] = [];
    apiMock.apiGet.mockImplementation((url: string) => {
      if (url.startsWith("/api/lansync/events")) {
        queried.push(url);
        return Promise.resolve(ok({ cursor: 9, events: [{ type: "device" }] }));
      }
      return Promise.resolve(ok({ requests: [], devices: [] }));
    });
    await api.pollEvents();
    expect(queried).toEqual(["/api/lansync/events?cursor=7"]);
    expect(listCalls()).toBe(before + 2);

    // 定时轮询确实按 POLL_INTERVAL_MS 触发
    api.startPolling();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(queried).toHaveLength(2);
    api.stopPolling();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(queried).toHaveLength(2);
    vi.useRealTimers();
  });
});
