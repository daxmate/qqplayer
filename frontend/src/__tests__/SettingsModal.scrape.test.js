// SettingsModal 刮削 tab 测试：5 块内容齐全 / 字段 checkbox 切换 + 防抖保存 / 重命名模板实时预览 /
// 源优先级排序 / 批量开关 + 一键整库两段式确认 → POST scrape-batch / 插件占位
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";

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
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

const SettingsModal = (await import("../components/SettingsModal.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { scrapingSettings, SCRAPING_SETTINGS_DEFAULTS } =
  await import("../composables/useScrapingSettings.js");
const { scrapeBatchState } = await import("../composables/useScrapeBatch.js");

let putBodies = [];
let batchBodies = [];

beforeEach(() => {
  Object.assign(scrapingSettings, JSON.parse(JSON.stringify(SCRAPING_SETTINGS_DEFAULTS)));
  putBodies = [];
  batchBodies = [];
  scrapeBatchState.open = false;
  scrapeBatchState.loading = false;
  scrapeBatchState.error = "";
  scrapeBatchState.enabled = true;
  scrapeBatchState.results = [];
  scrapeBatchState.summary = { total: 0, written: 0, skipped: 0, failed: 0 };
  Object.assign(state, {
    songs: [{ id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", year: 2003 }],
    libraryPath: "",
  });
  // 弹窗 watch(open) 会触发 loadLibrary / loadLibrarySettings（fetch），统一 stub
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, opts = {}) => {
      if (opts.method === "PUT") {
        putBodies.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ settings: {} }) };
      }
      if (url === "/api/tags/scrape-batch") {
        batchBodies.push(JSON.parse(opts.body));
        return {
          ok: true,
          json: async () => ({
            enabled: true,
            truncated: false,
            results: [],
            summary: { total: 0, written: 0, skipped: 0, failed: 0 },
          }),
        };
      }
      if (url === "/api/songs") return { ok: true, json: async () => [] };
      if (url === "/api/library") return { ok: true, json: async () => ({ path: "" }) };
      return { ok: true, json: async () => ({ settings: {} }) };
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// 挂载并进入刮削 tab（导航项文字「刮削」）
async function openScrapeTab() {
  const w = mount(SettingsModal, { props: { open: true } });
  await flushPromises();
  const root = document.body.querySelector(".modal");
  const navItem = [...root.querySelectorAll(".nav-item")].find((el) =>
    el.textContent.includes("刮削"),
  );
  expect(navItem).toBeTruthy();
  await navItem.click();
  await nextTick();
  return { w, root };
}

describe("刮削 tab 内容", () => {
  it("5 块内容齐全：字段 / 重命名 / 源优先级 / 批量 / 插件占位", async () => {
    const { w, root } = await openScrapeTab();
    const text = root.textContent;
    expect(text).toContain("刮削字段");
    expect(text).toContain("重命名规则");
    expect(text).toContain("源优先级");
    expect(text).toContain("批量刮削");
    expect(text).toContain("自定义刮削源（插件）开发中");
    // 8 个字段 checkbox 默认全选
    const boxes = [...root.querySelectorAll(".scrape-field input[type=checkbox]")];
    expect(boxes).toHaveLength(8);
    expect(boxes.every((b) => b.checked)).toBe(true);
    // 批量刮削默认关 → 一键补全按钮隐藏
    expect(root.querySelector('[data-testid="batch-library-btn"]')).toBeNull();
    w.unmount();
  });

  it("切换字段 checkbox → enabled_fields 实时更新（去掉 year）", async () => {
    const { w, root } = await openScrapeTab();
    await root
      .querySelector('[data-testid="scrape-field-year"]')
      .dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(scrapingSettings.enabled_fields).not.toContain("year");
    expect(scrapingSettings.enabled_fields).toContain("title");
    w.unmount();
  });

  it("字段切换 → 防抖 300ms 后 PUT {scraping: 全字段}", async () => {
    vi.useFakeTimers();
    const { w, root } = await openScrapeTab();
    await root
      .querySelector('[data-testid="scrape-field-year"]')
      .dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(putBodies).toHaveLength(1);
    expect(putBodies[0].scraping.enabled_fields).not.toContain("year");
    expect(putBodies[0].scraping.rename_template).toBe("{artist} - {title}");
    expect(putBodies[0].scraping.batch_enabled).toBe(false);
    w.unmount();
  });

  it("重命名模板实时预览：取曲库第一首有 artist+title 的歌渲染；无歌显示 —", async () => {
    const { w, root } = await openScrapeTab();
    expect(root.querySelector('[data-testid="rename-preview"]').textContent).toBe(
      "中島美嘉 - 雪の華",
    );
    // 改模板 → 预览实时变化
    scrapingSettings.rename_template = "{year}/{artist} - {title}";
    await nextTick();
    expect(root.querySelector('[data-testid="rename-preview"]').textContent).toBe(
      "2003/中島美嘉 - 雪の華",
    );
    // 无歌时显示 —
    state.songs = [];
    await nextTick();
    expect(root.querySelector('[data-testid="rename-preview"]').textContent).toBe("—");
    w.unmount();
  });

  it("源优先级：默认 网易云→MusicBrainz；上移按钮交换顺序", async () => {
    const { w, root } = await openScrapeTab();
    const names = [...root.querySelectorAll(".source-name")].map((el) => el.textContent.trim());
    expect(names).toEqual(["网易云音乐", "MusicBrainz"]);
    // 第二行（MusicBrainz）上移
    const upBtns = [...root.querySelectorAll('[data-testid="source-up"]')];
    await upBtns[1].click();
    await nextTick();
    expect(scrapingSettings.source_order).toEqual(["musicbrainz", "netease"]);
    const names2 = [...root.querySelectorAll(".source-name")].map((el) => el.textContent.trim());
    expect(names2).toEqual(["MusicBrainz", "网易云音乐"]);
    w.unmount();
  });

  it("批量开关：默认关隐藏一键补全；开启后显示，两段式确认后 POST {mode: library}", async () => {
    const { w, root } = await openScrapeTab();
    expect(root.querySelector('[data-testid="batch-library-btn"]')).toBeNull();
    // 开启
    scrapingSettings.batch_enabled = true;
    await nextTick();
    const btn = root.querySelector('[data-testid="batch-library-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain("立即补全曲库缺失字段");
    // 第一段：确认态
    await btn.click();
    await nextTick();
    expect(root.querySelector('[data-testid="batch-library-btn"]').textContent).toContain(
      "确认补全？",
    );
    expect(batchBodies).toHaveLength(0);
    // 第二段：真正执行
    await root.querySelector('[data-testid="batch-library-btn"]').click();
    await flushPromises();
    expect(batchBodies).toEqual([{ mode: "library" }]);
    expect(scrapeBatchState.open).toBe(true);
    // 结果面板渲染（Teleport 到 body）
    await nextTick();
    expect(document.body.textContent).toContain("批量刮削结果");
    w.unmount();
  });

  it("插件占位不可交互（禁用态）", async () => {
    const { w, root } = await openScrapeTab();
    const item = [...root.querySelectorAll(".setting-item.disabled")][0];
    expect(item.textContent).toContain("自定义刮削源（插件）开发中");
    w.unmount();
  });
});
