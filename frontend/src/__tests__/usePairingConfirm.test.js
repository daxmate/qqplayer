// usePairingConfirm composable 单元测试（壳内配对确认弹窗）
// 覆盖：新请求触发弹窗 / 已见请求不重复弹 / 队列逐个弹 / approve 成功关闭 /
//       reject 成功关闭 / 轮询失败不崩 / approve 失败保留可重试 / 404 过期自动关闭 /
//       busy 防重复提交 / iOS 壳不启用 / 定时器启动与卸载清理
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { clearToasts } from "../composables/useToast.js";

// ---------- mock：apiClient（归一化返回 {ok, status, data}） ----------
const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
vi.mock("../utils/apiClient.js", () => apiMock);

const {
  usePairingConfirm,
  approvePairing,
  rejectPairing,
  startPolling,
  stopPolling,
  isPairingEnabled,
  _pollOnce,
  _pairingUiState,
  _resetPairingConfirm,
} = await import("../composables/usePairingConfirm.js");

/** 构造配对请求对象 */
const req = (id, extra = {}) => ({
  request_id: id,
  device_name: "iPhone 15",
  device_type: "iPhone",
  created_at: "2026-08-23T14:32:00Z",
  ...extra,
});

/** apiGet 归一化成功响应 */
const pendingResponse = (...requests) => ({ ok: true, status: 200, data: { requests } });

beforeEach(() => {
  apiMock.apiGet.mockReset();
  apiMock.apiPost.mockReset();
  clearToasts();
  delete window.qqplayerIosBridge;
  _resetPairingConfirm();
});

afterEach(() => {
  stopPolling();
  delete window.qqplayerIosBridge;
  vi.useRealTimers();
});

describe("轮询发现新请求", () => {
  it("新请求出现 → 触发弹窗（visible=true，current=该请求）", async () => {
    apiMock.apiGet.mockResolvedValue(pendingResponse(req("r1")));
    await _pollOnce();
    const s = _pairingUiState();
    expect(s.visible).toBe(true);
    expect(s.current.request_id).toBe("r1");
    expect(s.current.device_name).toBe("iPhone 15");
  });

  it("已见请求不重复弹：同请求持续出现在 pending 不重新触发", async () => {
    apiMock.apiGet.mockResolvedValue(pendingResponse(req("r1")));
    await _pollOnce(); // 第一次：弹出 r1
    await _pollOnce(); // 第二次：仍是 r1，已在 seenIds → 不重复入队/弹窗
    expect(apiMock.apiGet).toHaveBeenCalledTimes(2);
    expect(_pairingUiState().visible).toBe(true);
    // approve 关闭后，若 r1 仍在 pending（服务端未清理）→ 也不重新弹
    apiMock.apiPost.mockResolvedValue({ ok: true, status: 200, data: {} });
    await approvePairing();
    expect(_pairingUiState().visible).toBe(false);
    await _pollOnce();
    expect(_pairingUiState().visible).toBe(false);
  });

  it("多个新请求 → 队列逐个弹：处理完一台再弹下一台", async () => {
    apiMock.apiGet.mockResolvedValue(pendingResponse(req("r1"), req("r2")));
    await _pollOnce();
    expect(_pairingUiState().current.request_id).toBe("r1"); // 先弹第一台
    apiMock.apiPost.mockResolvedValue({ ok: true, status: 200, data: {} });
    await approvePairing();
    const s = _pairingUiState();
    expect(s.visible).toBe(true);
    expect(s.current.request_id).toBe("r2"); // 接着弹第二台
  });
});

describe("approve / reject", () => {
  it("approve 成功 → 调用 /approve 端点并关闭弹窗", async () => {
    apiMock.apiGet.mockResolvedValue(pendingResponse(req("r1")));
    await _pollOnce();
    apiMock.apiPost.mockResolvedValue({ ok: true, status: 200, data: {} });
    const ok = await approvePairing();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/pairing/request/r1/approve");
    expect(ok).toBe(true);
    const s = _pairingUiState();
    expect(s.visible).toBe(false);
    expect(s.current).toBe(null);
    expect(s.busy).toBe(false);
  });

  it("reject 成功 → 调用 /reject 端点并关闭弹窗", async () => {
    apiMock.apiGet.mockResolvedValue(pendingResponse(req("r1")));
    await _pollOnce();
    apiMock.apiPost.mockResolvedValue({ ok: true, status: 200, data: {} });
    const ok = await rejectPairing();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/pairing/request/r1/reject");
    expect(ok).toBe(true);
    expect(_pairingUiState().visible).toBe(false);
  });

  it("处理中（busy）防重复提交：请求未返回时再次点按钮被忽略", async () => {
    apiMock.apiGet.mockResolvedValue(pendingResponse(req("r1")));
    await _pollOnce();
    let resolvePost;
    apiMock.apiPost.mockReturnValue(
      new Promise((res) => {
        resolvePost = res;
      }),
    );
    const p1 = approvePairing();
    const p2 = approvePairing(); // busy 中 → 直接返回 false，不再发请求
    expect(await p2).toBe(false);
    expect(apiMock.apiPost).toHaveBeenCalledTimes(1);
    resolvePost({ ok: true, status: 200, data: {} });
    expect(await p1).toBe(true);
    expect(_pairingUiState().visible).toBe(false);
  });
});

describe("失败处理不崩", () => {
  it("轮询失败（网络错误/404）→ 静默跳过，不弹窗不抛错", async () => {
    apiMock.apiGet.mockResolvedValue({
      ok: false,
      status: 0,
      message: "网络连接失败",
      network: true,
    });
    await expect(_pollOnce()).resolves.toBeUndefined();
    expect(_pairingUiState().visible).toBe(false);
    // 404（如接口未部署）同样静默
    apiMock.apiGet.mockResolvedValue({ ok: false, status: 404, data: null, message: "Not Found" });
    await expect(_pollOnce()).resolves.toBeUndefined();
    expect(_pairingUiState().visible).toBe(false);
  });

  it("approve 失败（500）→ 弹窗保留可重试，不崩", async () => {
    apiMock.apiGet.mockResolvedValue(pendingResponse(req("r1")));
    await _pollOnce();
    apiMock.apiPost.mockResolvedValue({ ok: false, status: 500, data: null, message: "boom" });
    const ok = await approvePairing();
    expect(ok).toBe(false);
    const s = _pairingUiState();
    expect(s.visible).toBe(true); // 保留弹窗供重试
    expect(s.busy).toBe(false);
    expect(s.current.request_id).toBe("r1");
  });

  it("approve 404（请求已过期）→ 自动关闭弹窗，不崩", async () => {
    apiMock.apiGet.mockResolvedValue(pendingResponse(req("r1")));
    await _pollOnce();
    apiMock.apiPost.mockResolvedValue({ ok: false, status: 404, data: null, message: "过期" });
    const ok = await approvePairing();
    expect(ok).toBe(false);
    expect(_pairingUiState().visible).toBe(false);
  });
});

describe("环境与生命周期", () => {
  it("iOS 壳（window.qqplayerIosBridge 存在）→ 不启用轮询", () => {
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    expect(isPairingEnabled()).toBe(false);
    startPolling();
    expect(apiMock.apiGet).not.toHaveBeenCalled(); // 立即查询也不发
  });

  it("非 iOS（无桥）→ 启用；startPolling 立即查一次 + 每 2s 轮询", async () => {
    vi.useFakeTimers();
    expect(isPairingEnabled()).toBe(true);
    apiMock.apiGet.mockResolvedValue(pendingResponse());
    startPolling();
    expect(apiMock.apiGet).toHaveBeenCalledTimes(1); // 启动即查
    await vi.advanceTimersByTimeAsync(2000);
    expect(apiMock.apiGet).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(apiMock.apiGet).toHaveBeenCalledTimes(3);
    stopPolling();
    await vi.advanceTimersByTimeAsync(6000);
    expect(apiMock.apiGet).toHaveBeenCalledTimes(3); // 停止后不再轮询
  });

  it("组件卸载 → 自动停止轮询（onBeforeUnmount 清理定时器）", async () => {
    vi.useFakeTimers();
    apiMock.apiGet.mockResolvedValue(pendingResponse());
    const Wrapper = {
      setup() {
        usePairingConfirm();
        return () => null;
      },
    };
    const wrapper = mount(Wrapper, { attachTo: document.body });
    expect(apiMock.apiGet).toHaveBeenCalledTimes(1); // 挂载即开始轮询
    wrapper.unmount();
    const callsAfterUnmount = apiMock.apiGet.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(apiMock.apiGet.mock.calls.length).toBe(callsAfterUnmount); // 卸载后不再轮询
    wrapper.unmount(); // 幂等
  });
});
