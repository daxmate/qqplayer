// SettingsModal 快捷键 tab（任务 G）：配置表驱动全量渲染 + 全量可录制 + 冲突检测
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  volume = 1;
  listeners: Record<string, (() => void) | undefined> = {};

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
const { playbackSettings, SHORTCUTS, SHORTCUT_CATEGORIES } =
  await import("../composables/usePlayer.js");
const { items, clearToasts } = await import("../composables/useToast.js").then((m) => m.useToast());

beforeEach(() => {
  // 快捷键默认值复位（防用例间录制值残留）
  for (const s of SHORTCUTS) {
    (playbackSettings as Record<string, unknown>)[s.settingKey] = s.defaultCode;
  }
  clearToasts();
  // 弹窗 watch(open) 会触发 loadLibrary / loadLibrarySettings（fetch），stub 掉
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 打开设置弹窗并切到快捷键 tab
async function openShortcutsTab() {
  const w = mount(SettingsModal, { props: { open: true } });
  await nextTick();
  const root = document.body.querySelector<HTMLElement>(".modal")!;
  const nav = [...root.querySelectorAll<HTMLElement>(".nav-item")].find((el) =>
    el.textContent.includes("快捷键"),
  )!;
  nav.click();
  await nextTick();
  return { w, root };
}

// 录制按键：capture 阶段监听在 window 上（onRecordKeydown）
function press(code: string, opts: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent("keydown", {
    code,
    key: opts.key || code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  window.dispatchEvent(ev);
  return ev;
}

function rowOf(root: HTMLElement, label: string): HTMLElement {
  return [...root.querySelectorAll<HTMLElement>(".shortcut-item.editable")].find((el) =>
    el.textContent.includes(label),
  )!;
}

describe("SettingsModal 快捷键 tab（任务 G）", () => {
  it("配置表全列表渲染（22 行），按 6 个分类分组，全部可录制", async () => {
    const { root, w } = await openShortcutsTab();
    const rows = [...root.querySelectorAll<HTMLElement>(".shortcut-item.editable")];
    expect(rows).toHaveLength(SHORTCUTS.length);
    // 每个分类一个 sub-title（分组标题）
    const titles = [...root.querySelectorAll<HTMLElement>(".group-title.sub-title")];
    expect(titles).toHaveLength(SHORTCUT_CATEGORIES.length);
    // 分类标题顺序与配置表一致
    const catLabels = ["播放控制", "曲目", "音量", "跟唱", "搜索", "其他"];
    titles.forEach((el, i) => {
      expect(el.textContent).toContain(catLabels[i]);
    });
    // 每个分类下行的数量与配置表一致
    for (const cat of SHORTCUT_CATEGORIES) {
      const expected = SHORTCUTS.filter((s) => s.category === cat.key).length;
      const catEl = [...root.querySelectorAll<HTMLElement>(".shortcut-cat")].find((el) =>
        el.textContent.includes(
          cat.key === "playback"
            ? "播放控制"
            : cat.key === "track"
              ? "曲目"
              : cat.key === "volume"
                ? "音量"
                : cat.key === "karaoke"
                  ? "跟唱"
                  : cat.key === "search"
                    ? "搜索"
                    : "其他",
        ),
      )!;
      expect(catEl.querySelectorAll(".shortcut-item.editable")).toHaveLength(expected);
    }
    // 行内容覆盖全部 labelKey（通过渲染文本抽查关键新项）
    const text = root.textContent;
    for (const label of [
      "上一首",
      "下一首",
      "静音切换",
      "收藏 / 取消收藏",
      "播放模式切换",
      "打开设置",
    ]) {
      expect(text).toContain(label);
    }
    w.unmount();
  });

  it("默认组合显示：⌘ 组合显示 ⌘ 前缀、普通键显示键名", async () => {
    const { root, w } = await openShortcutsTab();
    const prev = rowOf(root, "上一首");
    expect(prev.querySelector<HTMLElement>("kbd")!.textContent).toBe("⌘←");
    const mute = rowOf(root, "静音切换");
    expect(mute.querySelector<HTMLElement>("kbd")!.textContent).toBe("M");
    const search = rowOf(root, "打开搜索");
    expect(search.querySelector<HTMLElement>("kbd")!.textContent).toBe("⌘K");
    const settings = rowOf(root, "打开设置");
    expect(settings.querySelector<HTMLElement>("kbd")!.textContent).toBe("⌘,");
    w.unmount();
  });

  it("点击行进入录制，按键保存到 playbackSettings 对应字段", async () => {
    const { root, w } = await openShortcutsTab();
    const mute = rowOf(root, "静音切换");
    mute.click();
    await nextTick();
    expect(mute.classList.contains("recording")).toBe(true);
    press("KeyJ", { key: "j" });
    await nextTick();
    expect(playbackSettings.shortcutMute).toBe("KeyJ");
    expect(mute.classList.contains("recording")).toBe(false);
    expect(mute.querySelector<HTMLElement>("kbd")!.textContent).toBe("J"); // 显示更新
    w.unmount();
  });

  it("录制 ⌘ 组合：存储 Meta+<code> 并显示 ⌘ 前缀", async () => {
    const { root, w } = await openShortcutsTab();
    const prev = rowOf(root, "上一首");
    prev.click();
    press("KeyT", { key: "t", metaKey: true });
    await nextTick();
    expect(playbackSettings.shortcutPrevTrack).toBe("Meta+KeyT");
    expect(prev.querySelector<HTMLElement>("kbd")!.textContent).toBe("⌘T");
    w.unmount();
  });

  it("Esc 取消录制，保留原键", async () => {
    const { root, w } = await openShortcutsTab();
    const mute = rowOf(root, "静音切换");
    mute.click();
    await nextTick();
    press("Escape", { key: "Escape" });
    await nextTick();
    expect(playbackSettings.shortcutMute).toBe("KeyM"); // 未保存
    expect(mute.classList.contains("recording")).toBe(false);
    w.unmount();
  });

  it("冲突检测：按键已绑定其他快捷键 → toast 拒绝保存", async () => {
    const { root, w } = await openShortcutsTab();
    // 把「静音切换」录成 KeyF（与「收藏」默认冲突）
    const mute = rowOf(root, "静音切换");
    mute.click();
    press("KeyF", { key: "f" });
    await nextTick();
    expect(playbackSettings.shortcutMute).toBe("KeyM"); // 拒绝保存
    expect(mute.classList.contains("recording")).toBe(false);
    // toast 提示冲突
    expect(items.some((i) => i.type === "error" && i.text.includes("冲突"))).toBe(true);
    // 收藏键未被覆盖
    expect(playbackSettings.shortcutFav).toBe("KeyF");
    w.unmount();
  });

  it("冲突检测：Meta+K 与历史默认 Meta+K（searchKey）视为同一组合", async () => {
    const { root, w } = await openShortcutsTab();
    // 把「跟唱：下一句」录成 Meta+K（⌘K 已绑定搜索）
    const next = rowOf(root, "跟唱：下一句");
    next.click();
    press("KeyK", { key: "k", metaKey: true });
    await nextTick();
    expect(playbackSettings.karaokeNextKey).toBe("KeyN"); // 拒绝保存
    expect(items.some((i) => i.type === "error" && i.text.includes("冲突"))).toBe(true);
    w.unmount();
  });

  it("已有录制值回显（加载场景）", async () => {
    playbackSettings.shortcutFav = "KeyJ";
    const { root, w } = await openShortcutsTab();
    const fav = rowOf(root, "收藏 / 取消收藏");
    expect(fav.querySelector<HTMLElement>("kbd")!.textContent).toBe("J");
    w.unmount();
  });

  it("录制时按纯修饰键（Meta 本身）不绑定，继续等待有效键", async () => {
    const { root, w } = await openShortcutsTab();
    const mute = rowOf(root, "静音切换");
    mute.click();
    press("MetaLeft", { key: "Meta" });
    await nextTick();
    expect(playbackSettings.shortcutMute).toBe("KeyM"); // 未绑定
    expect(mute.classList.contains("recording")).toBe(true); // 仍在录制中
    press("KeyJ", { key: "j" });
    await nextTick();
    expect(playbackSettings.shortcutMute).toBe("KeyJ");
    w.unmount();
  });

  it("搜索快捷键行也可录制（单键）", async () => {
    const { root, w } = await openShortcutsTab();
    const search = rowOf(root, "打开搜索");
    search.click();
    press("KeyQ", { key: "q" });
    await nextTick();
    expect(playbackSettings.searchKey).toBe("KeyQ");
    expect(search.querySelector<HTMLElement>("kbd")!.textContent).toBe("Q");
    w.unmount();
  });

  it("打开设置快捷键（⌘,）渲染与录制", async () => {
    const { root, w } = await openShortcutsTab();
    const settings = rowOf(root, "打开设置");
    // 默认组合显示 ⌘,
    expect(settings.querySelector<HTMLElement>("kbd")!.textContent).toBe("⌘,");
    // 录制 ⌘+逗号 → 存 Meta+Comma，显示 ⌘,
    settings.click();
    await nextTick();
    press("Comma", { key: ",", metaKey: true });
    await nextTick();
    expect(playbackSettings.shortcutOpenSettings).toBe("Meta+Comma");
    expect(settings.querySelector<HTMLElement>("kbd")!.textContent).toBe("⌘,");
    w.unmount();
  });
});
