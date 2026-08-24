// PairingSettings 组件测试（设置弹窗「配对」Tab）
// 覆盖：已配对设备列表渲染（名称/备注/时间）/ 删除确认流程（DELETE + 刷新）/
//       备注编辑（PATCH 参数 + 空串清除）/ 待确认请求只读列表（reject 且无批准按钮）/
//       空状态 / 加载中
// 注意：组件根节点不在 document.body（仅 Teleport 的弹窗在 body），列表断言用 wrapper.text()
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import { clearToasts } from "../composables/useToast.js";

// ---------- mock：apiClient（归一化返回 {ok, status, data}） ----------
const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
}));
vi.mock("../utils/apiClient.js", () => apiMock);

const PairingSettings = (await import("../components/PairingSettings.vue")).default;

/** 已配对设备：created_at = 两天前 14:32（跨天 → MM-DD）；last_seen_at = 昨天 09:05 */
const device = (over = {}) => {
  const created = new Date();
  created.setDate(created.getDate() - 2);
  created.setHours(14, 32, 0, 0);
  const lastSeen = new Date();
  lastSeen.setDate(lastSeen.getDate() - 1);
  lastSeen.setHours(9, 5, 0, 0);
  return {
    server_id: "srv1",
    device_id: "dev1",
    device_name: "iPhone 15",
    device_type: "iphone",
    created_at: created.toISOString(),
    last_seen_at: lastSeen.toISOString(),
    note: "",
    ...over,
  };
};

const request = (id = "r1", over = {}) => {
  const created = new Date();
  created.setHours(8, 20, 0, 0); // 今天 → 显示 HH:mm
  return {
    request_id: id,
    device_name: "iPad mini",
    device_type: "ipad",
    created_at: created.toISOString(),
    ...over,
  };
};

const ok = (data) => ({ ok: true, status: 200, data });

/** 按 URL 路由 apiGet：/devices → {devices}，/pending → {requests} */
function routeGet({ devices = [], requests = [] } = {}) {
  apiMock.apiGet.mockImplementation((url) => {
    if (url === "/api/pairing/devices") return Promise.resolve(ok({ devices }));
    if (url === "/api/pairing/pending") return Promise.resolve(ok({ requests }));
    return Promise.resolve(ok({}));
  });
}

async function mountSettings() {
  const w = mount(PairingSettings);
  await flushPromises();
  return w;
}

/** Teleport 到 body 的弹窗内按钮（按索引：0=取消/次要，末位=确认/主操作） */
function dialogButtons() {
  return [...document.body.querySelectorAll(".pairing-dialog .pairing-dialog-btn")];
}
const confirmDangerBtn = () =>
  document.body.querySelector(".pairing-dialog .pairing-dialog-btn.danger");
const confirmPrimaryBtn = () =>
  document.body.querySelector(".pairing-dialog .pairing-dialog-btn.primary");

/** 备注输入框（原生 DOM；v-model 需手动派发 input 事件） */
async function setNoteInput(value) {
  const el = document.body.querySelector(".pairing-note-input");
  el.value = value;
  el.dispatchEvent(new Event("input"));
  await nextTick();
}

beforeEach(() => {
  apiMock.apiGet.mockReset();
  apiMock.apiDelete.mockReset();
  apiMock.apiPatch.mockReset();
  apiMock.apiPost.mockReset();
  clearToasts();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PairingSettings 已配对设备列表", () => {
  it("渲染设备名 / 备注 / 配对时间 / 最后活跃", async () => {
    routeGet({ devices: [device({ note: "书房 iPad" })] });
    const w = await mountSettings();
    const text = w.text();
    // 展示名：有备注用备注（备注优先），设备名不重复渲染
    expect(text).not.toContain("iPhone 15");
    expect(text).toContain("书房 iPad");
    // 配对时间：跨天 → MM-DD HH:mm（两天前的 14:32）
    const created = new Date();
    created.setDate(created.getDate() - 2);
    created.setHours(14, 32, 0, 0);
    const md = `${String(created.getMonth() + 1).padStart(2, "0")}-${String(
      created.getDate(),
    ).padStart(2, "0")}`;
    expect(text).toContain(`${md} 14:32`);
    // 最后活跃：昨天
    expect(text).toContain("最后活跃 昨天");
    w.unmount();
  });

  it("无 note 的设备不显示备注行", async () => {
    routeGet({ devices: [device()] });
    const w = await mountSettings();
    expect(w.find(".pairing-row-note").exists()).toBe(false);
    w.unmount();
  });

  it("空列表 → 显示「暂无配对设备」+ 引导文案", async () => {
    routeGet();
    const w = await mountSettings();
    const text = w.text();
    expect(text).toContain("暂无配对设备");
    expect(text).toContain("设置 → 配对");
    w.unmount();
  });

  it("加载中 → 显示加载提示", () => {
    apiMock.apiGet.mockReturnValue(new Promise(() => {}));
    const w = mount(PairingSettings);
    expect(w.text()).toContain("加载中");
    w.unmount();
  });

  it("删除流程：点删除 → 确认弹窗 → DELETE 正确 URL → 成功后刷新列表", async () => {
    routeGet({ devices: [device()] });
    const w = await mountSettings();
    // 点行内删除按钮（危险图标按钮）
    w.find(".pairing-row .pairing-icon-btn.danger").trigger("click");
    await flushPromises();
    const dialog = document.body.querySelector(".pairing-dialog");
    expect(dialog.textContent).toContain("确定撤销与「iPhone 15」的配对？");
    // 取消不触发请求
    dialogButtons()[0].click();
    await flushPromises();
    expect(apiMock.apiDelete).not.toHaveBeenCalled();
    // 再次点删除并确认
    w.find(".pairing-row .pairing-icon-btn.danger").trigger("click");
    await flushPromises();
    apiMock.apiDelete.mockResolvedValue(ok({}));
    apiMock.apiGet.mockClear();
    routeGet({ devices: [device()] });
    confirmDangerBtn().click();
    await flushPromises();
    expect(apiMock.apiDelete).toHaveBeenCalledWith("/api/pairing/devices/srv1/dev1");
    // 刷新：mount 调用已被 mockClear 清除，此处 devices + pending 各重新请求 1 次
    expect(apiMock.apiGet.mock.calls.filter(([u]) => u === "/api/pairing/devices")).toHaveLength(1);
    expect(apiMock.apiGet.mock.calls.filter(([u]) => u === "/api/pairing/pending")).toHaveLength(1);
    w.unmount();
  });

  it("删除失败 → 不刷新列表", async () => {
    routeGet({ devices: [device()] });
    const w = await mountSettings();
    w.find(".pairing-row .pairing-icon-btn.danger").trigger("click");
    await flushPromises();
    apiMock.apiDelete.mockResolvedValue({ ok: false, status: 500, data: {} });
    apiMock.apiGet.mockClear();
    confirmDangerBtn().click();
    await flushPromises();
    expect(apiMock.apiDelete).toHaveBeenCalledTimes(1);
    expect(apiMock.apiGet).not.toHaveBeenCalled(); // 失败不刷新
    w.unmount();
  });
});

describe("PairingSettings 备注编辑", () => {
  it("点编辑 → 弹窗预填当前备注 → 保存 PATCH 参数正确 → 刷新", async () => {
    routeGet({ devices: [device({ note: "旧备注" })] });
    const w = await mountSettings();
    w.find(".pairing-row .pairing-icon-btn").trigger("click"); // 第一个图标按钮 = 编辑
    await flushPromises();
    const input = document.body.querySelector(".pairing-note-input");
    expect(input.value).toBe("旧备注");
    await setNoteInput("新备注 abc");
    apiMock.apiPatch.mockResolvedValue(ok({ device: {} }));
    apiMock.apiGet.mockClear();
    routeGet({ devices: [device({ note: "新备注 abc" })] });
    confirmPrimaryBtn().click();
    await flushPromises();
    expect(apiMock.apiPatch).toHaveBeenCalledWith("/api/pairing/devices/srv1/dev1", {
      note: "新备注 abc",
    });
    expect(apiMock.apiGet.mock.calls.filter(([u]) => u === "/api/pairing/devices")).toHaveLength(1);
    w.unmount();
  });

  it('输入空串 = 清除备注（PATCH note: ""）', async () => {
    routeGet({ devices: [device({ note: "旧备注" })] });
    const w = await mountSettings();
    w.find(".pairing-row .pairing-icon-btn").trigger("click");
    await flushPromises();
    await setNoteInput("");
    apiMock.apiPatch.mockResolvedValue(ok({ device: {} }));
    confirmPrimaryBtn().click();
    await flushPromises();
    expect(apiMock.apiPatch).toHaveBeenCalledWith("/api/pairing/devices/srv1/dev1", { note: "" });
    w.unmount();
  });

  it("备注输入框 maxlength=50", async () => {
    routeGet({ devices: [device()] });
    const w = await mountSettings();
    w.find(".pairing-row .pairing-icon-btn").trigger("click");
    await flushPromises();
    expect(document.body.querySelector(".pairing-note-input").getAttribute("maxlength")).toBe("50");
    w.unmount();
  });
});

describe("PairingSettings 待确认请求（只读）", () => {
  it("渲染请求：设备名 + 请求时间；删除按钮调 reject（幂等）", async () => {
    routeGet({ requests: [request("r1")] });
    const w = await mountSettings();
    const text = w.text();
    expect(text).toContain("iPad mini");
    expect(text).toContain("08:20");
    apiMock.apiPost.mockResolvedValue(ok({}));
    apiMock.apiGet.mockClear();
    routeGet({ requests: [] });
    const rows = w.findAll(".pairing-row");
    const rejectBtn = rows
      .find((r) => r.text().includes("iPad mini"))
      .find(".pairing-icon-btn.danger");
    await rejectBtn.trigger("click");
    await flushPromises();
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/pairing/request/r1/reject");
    // 刷新：mount 调用已被 mockClear 清除，此处 pending 重新请求 1 次
    expect(apiMock.apiGet.mock.calls.filter(([u]) => u === "/api/pairing/pending")).toHaveLength(1);
    w.unmount();
  });

  it("绝无批准按钮：不渲染 approve 入口，也不调用 approve 接口", async () => {
    routeGet({ requests: [request("r1")] });
    const w = await mountSettings();
    const btns = [...w.findAll("button"), ...document.body.querySelectorAll("button")];
    expect(btns.some((b) => /批准|Approve|approve/i.test(b.textContent || b.title))).toBe(false);
    expect(apiMock.apiPost).not.toHaveBeenCalled();
    w.unmount();
  });

  it("无待确认请求 → 显示「暂无待确认请求」", async () => {
    routeGet();
    const w = await mountSettings();
    expect(w.text()).toContain("暂无待确认请求");
    w.unmount();
  });
});
