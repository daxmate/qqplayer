// PairingConfirmModal 渲染测试：设备信息展示 / 按钮点击回调 / busy 禁用 / 未打开不渲染
// 弹窗经 Teleport 到 body（与 SettingsModal/QuarkLoginModal 同构），断言查 document.body
import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import PairingConfirmModal from "../components/PairingConfirmModal.vue";

/** 请求时间用本地时间构造（2026-08-23 本地 14:32），展示断言只依赖 "14:32" 片段 */
const request = {
  request_id: "r1",
  device_name: "iPhone 15",
  device_type: "iPhone",
  created_at: new Date(2026, 7, 23, 14, 32, 0).toISOString(),
};

function mountModal(props = {}) {
  return mount(PairingConfirmModal, {
    props: { open: true, request, busy: false, ...props },
    attachTo: document.body,
  });
}

const card = () => document.body.querySelector(".pair-card");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PairingConfirmModal", () => {
  it("打开 + 有请求 → 显示设备名 / 类型 / 请求时间", () => {
    mountModal();
    const text = card().textContent;
    expect(text).toContain("iPhone 15");
    expect(text).toContain("iPhone");
    expect(text).toContain("14:32");
  });

  it("点击批准 → emit approve；点击拒绝 → emit reject", async () => {
    const w = mountModal();
    card().querySelector(".pair-approve").click();
    expect(w.emitted("approve")).toBeTruthy();
    card().querySelector(".pair-reject").click();
    expect(w.emitted("reject")).toBeTruthy();
  });

  it("busy → 两个按钮均禁用（防重复提交）", () => {
    mountModal({ busy: true });
    expect(card().querySelector(".pair-approve").disabled).toBe(true);
    expect(card().querySelector(".pair-reject").disabled).toBe(true);
  });

  it("open=false 或 request=null → 不渲染弹窗", () => {
    mountModal({ open: false });
    expect(card()).toBe(null);
    document.body.innerHTML = "";
    mountModal({ request: null });
    expect(card()).toBe(null);
  });

  it("device_type 为 unknown/空 → 显示「未知设备」", () => {
    mountModal({ request: { ...request, device_type: "unknown" } });
    expect(card().textContent).toContain("未知设备");
  });
});
