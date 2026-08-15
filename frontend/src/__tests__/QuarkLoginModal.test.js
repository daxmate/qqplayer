// QuarkLoginModal 状态机测试：拉码 / 倒计时 / 轮询（waiting 不关、ok 触发 success、expired 自动刷新）/ 手动关闭
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

const QuarkLoginModal = (await import("../components/QuarkLoginModal.vue")).default;

let qrCalls = 0;
let statusCalls = 0;
let statuses = []; // 轮询返回队列，取尽后一直 waiting

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (url === "/api/quark/login/qrcode") {
        qrCalls++;
        return {
          ok: true,
          json: async () => ({
            qr_image: "data:image/png;base64,AAAA",
            qr_id: "qr-1",
            expires_in: 170,
          }),
        };
      }
      if (String(url).startsWith("/api/quark/login/status")) {
        statusCalls++;
        const st = statuses.shift() ?? "waiting";
        return { ok: true, json: async () => ({ status: st, nickname: "夸克用户" }) };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  qrCalls = 0;
  statusCalls = 0;
  statuses = [];
  stubFetch();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("QuarkLoginModal 打开与倒计时", () => {
  it("打开 → 拉二维码（data URI）→ 显示图片 + 倒计时", async () => {
    const wrapper = mount(QuarkLoginModal, { props: { open: true } });
    await flushPromises();
    expect(qrCalls).toBe(1);
    const modal = document.body.querySelector(".qlm");
    expect(modal).toBeTruthy();
    expect(modal.querySelector("img").getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(modal.textContent).toContain("二维码有效期");
    expect(modal.textContent).toContain("170");
    wrapper.unmount();
  });

  it("倒计时每秒递减；归零后自动重新拉码（计数 +1）并重置倒计时", async () => {
    const wrapper = mount(QuarkLoginModal, { props: { open: true } });
    await flushPromises();
    const countdownEl = () => document.body.querySelector(".qlm-countdown");
    expect(countdownEl().textContent).toContain("170");
    await vi.advanceTimersByTimeAsync(3000);
    expect(countdownEl().textContent).toContain("167");
    // 倒计时归零（此处拉码 expires_in 仍为 170，需先归零）——用短过期码验证
    wrapper.unmount();
    qrCalls = 0;
    // 重新挂载：expires_in=3 的二维码，3s 后归零 → 自动刷新
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "/api/quark/login/qrcode") {
          qrCalls++;
          return {
            ok: true,
            json: async () => ({
              qr_image: "data:image/png;base64,AAAA",
              qr_id: "qr-2",
              expires_in: 3,
            }),
          };
        }
        if (String(url).startsWith("/api/quark/login/status")) {
          return { ok: true, json: async () => ({ status: "waiting" }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    const w2 = mount(QuarkLoginModal, { props: { open: true } });
    await flushPromises();
    expect(qrCalls).toBe(1);
    expect(document.body.querySelector(".qlm-countdown").textContent).toContain("3");
    await vi.advanceTimersByTimeAsync(3200);
    await flushPromises();
    expect(qrCalls).toBe(2); // 归零 → 自动重新拉码
    expect(document.body.querySelector(".qlm-countdown").textContent).toContain("3"); // 倒计时重置
    w2.unmount();
  });

  it("倒计时 ≤30s 时红色警示样式", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "/api/quark/login/qrcode") {
          return {
            ok: true,
            json: async () => ({
              qr_image: "data:image/png;base64,AAAA",
              qr_id: "qr-1",
              expires_in: 35,
            }),
          };
        }
        return { ok: true, json: async () => ({ status: "waiting" }) };
      }),
    );
    const wrapper = mount(QuarkLoginModal, { props: { open: true } });
    await flushPromises();
    const cd = document.body.querySelector(".qlm-countdown");
    expect(cd.classList.contains("warn")).toBe(false);
    await vi.advanceTimersByTimeAsync(6000); // 35 → 29
    expect(document.body.querySelector(".qlm-countdown").classList.contains("warn")).toBe(true);
    wrapper.unmount();
  });
});

describe("QuarkLoginModal 轮询状态机", () => {
  it("waiting：轮询持续，弹窗不关", async () => {
    statuses = ["waiting", "waiting"];
    const wrapper = mount(QuarkLoginModal, { props: { open: true } });
    await flushPromises();
    expect(qrCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(2100); // 第一轮轮询
    await flushPromises();
    expect(statusCalls).toBeGreaterThanOrEqual(1);
    expect(document.body.querySelector(".qlm")).toBeTruthy();
    expect(wrapper.emitted("success")).toBeFalsy();
    wrapper.unmount();
  });

  it("ok：触发 success 回调", async () => {
    statuses = ["ok"];
    const wrapper = mount(QuarkLoginModal, { props: { open: true } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2100);
    await flushPromises();
    expect(wrapper.emitted("success")).toBeTruthy();
    expect(wrapper.emitted("close")).toBeFalsy();
    wrapper.unmount();
  });

  it("expired：自动重新生成二维码（拉码次数 +1），不触发 success", async () => {
    statuses = ["expired"];
    const wrapper = mount(QuarkLoginModal, { props: { open: true } });
    await flushPromises();
    expect(qrCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(2100);
    await flushPromises();
    expect(qrCalls).toBe(2); // 重新拉码
    expect(wrapper.emitted("success")).toBeFalsy();
    expect(document.body.querySelector(".qlm")).toBeTruthy(); // 弹窗保持
    wrapper.unmount();
  });

  it("error：显示错误文案并停止轮询", async () => {
    statuses = ["error"];
    const wrapper = mount(QuarkLoginModal, { props: { open: true } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2100);
    await flushPromises();
    const modal = document.body.querySelector(".qlm");
    expect(modal.textContent).toContain("登录状态异常");
    const callsAfter = statusCalls;
    await vi.advanceTimersByTimeAsync(5000); // 不再轮询
    expect(statusCalls).toBe(callsAfter);
    wrapper.unmount();
  });
});

describe("QuarkLoginModal 关闭", () => {
  it("点 ✕ → emit close", async () => {
    const wrapper = mount(QuarkLoginModal, { props: { open: true } });
    await flushPromises();
    document.body.querySelector(".qlm-close").click();
    await flushPromises();
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });

  it("点遮罩 → emit close", async () => {
    const wrapper = mount(QuarkLoginModal, { props: { open: true } });
    await flushPromises();
    document.body.querySelector(".qlm-mask").click();
    await flushPromises();
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });

  it("关闭后重新打开：重新拉码（新会话）", async () => {
    const wrapper = mount(QuarkLoginModal, { props: { open: false } });
    expect(document.body.querySelector(".qlm")).toBeFalsy();
    expect(qrCalls).toBe(0); // 关闭状态不拉码
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(qrCalls).toBe(1);
    expect(document.body.querySelector(".qlm")).toBeTruthy();
    await wrapper.setProps({ open: false });
    await flushPromises();
    expect(document.body.querySelector(".qlm")).toBeFalsy();
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(qrCalls).toBe(2); // 重开重新拉码
    wrapper.unmount();
  });
});
