// TagEditorModal 组件测试（歌曲信息编辑弹窗 / 标签刮削器）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
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

const TagEditorModal = (await import("../components/TagEditorModal.vue")).default;
const ToastContainer = (await import("../components/ToastContainer.vue")).default;
const { state, audio } = await import("../composables/usePlayer.js");
const { resetTagEditorSettings } = await import("../composables/tagEditorSettings.js");
const { clearToasts, useToast } = await import("../composables/useToast.js");
const toastItems = useToast().items; // 全局 toast 单例状态（reactive）

const SONG = { path: "/music/安静.mp3", name: "安静", artist: "周杰伦", album: "范特西" };

/** DOM 查询辅助（测试内 querySelector 可空 → 非空断言 + 元素类型化；运行时行为不变） */
function q<T extends Element = HTMLElement>(root: Element, sel: string): T {
  return root.querySelector(sel) as T;
}
function qa(root: Element, sel: string): HTMLElement[] {
  return [...root.querySelectorAll(sel)] as HTMLElement[];
}

// 契约 mock（后端 /api/tags* 并行开发中，联调待合并后验证）
const SCRAPE_RES = {
  query: "安静 周杰伦",
  netease: [
    {
      id: "123",
      title: "安静 (Live)",
      artist: "周杰伦",
      album: "无与伦比 演唱会",
      cover: "https://p1.music.126.net/cover1.jpg",
      duration: "04:30",
    },
    { id: "456", title: "安静", artist: "周杰伦", album: "范特西", cover: null, duration: "04:20" },
  ],
  musicbrainz: [
    {
      title: "安静",
      artist: "周杰伦",
      album: "范特西",
      cover: "https://coverartarchive.org/abc.jpg",
      year: 2001,
      genre: "流行",
      track: 3,
      album_artist: "周杰伦",
      mbid: "mbid-1",
    },
  ],
};

const SAVE_RES = {
  path: "/music/安静 (Live).mp3",
  name: "安静 (Live)",
  artist: "周杰伦",
  album: "无与伦比 演唱会",
  renamed: true,
  newPath: "/music/安静 (Live).mp3",
};

// 注意：用 vi.stubGlobal（不用 vi.spyOn）——spyOn 的 mock 不会被 unstubAllGlobals 还原，
// 同一文件内多次 mockFetch 会串测试（旧 mock 的 calls 污染后续断言）
function mockFetch(
  opts: {
    scrape?: () => Promise<unknown>;
    save?: () => Promise<unknown>;
    albumYear?: () => Promise<unknown>;
    songs?: unknown;
    settings?: (() => Promise<unknown>) | Record<string, unknown>;
  } = {},
) {
  const { scrape, save, songs, settings, albumYear } = opts;
  // 第二参不注解（保持 calls 元素为宽松类型；测试侧用 mock.calls[i][1].body 直取 JSON）
  const mock = vi.fn(async (url: string, optsReq) => {
    const u = String(url);
    if (u.includes("/api/tags/scrape") && optsReq?.method === "POST") {
      return scrape ? scrape() : Promise.resolve({ ok: true, json: async () => SCRAPE_RES });
    }
    if (u.includes("/api/tags/album-year") && optsReq?.method === "POST") {
      // 默认 {year: null}：不改变表单（存量测试点选网易云候选后 year 仍为空）
      return albumYear
        ? albumYear()
        : Promise.resolve({ ok: true, json: async () => ({ year: null }) });
    }
    if (u.includes("/api/tags") && optsReq?.method === "POST") {
      return save ? save() : Promise.resolve({ ok: true, json: async () => SAVE_RES });
    }
    if (u.includes("/api/library/settings")) {
      return typeof settings === "function"
        ? settings()
        : Promise.resolve({
            ok: true,
            json: async () =>
              settings ?? {
                settings: { scraping: { enabled_fields: [] } },
                library: {},
                playback: {},
              },
          });
    }
    if (u.includes("/api/songs")) {
      return Promise.resolve({
        ok: true,
        json: async () =>
          songs || [
            { ...SONG, path: SAVE_RES.newPath, name: SAVE_RES.name, album: SAVE_RES.album },
          ],
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 10));

beforeEach(() => {
  Object.assign(state, {
    songs: [{ ...SONG }],
    currentIndex: 0,
    currentSong: { ...SONG },
  });
  audio.src = ""; // 记录基线：验证保存改名不触碰 audio.src（播放不中断）
  resetTagEditorSettings(); // enabled_fields 模块级缓存隔离
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts(); // 全局 toast 单例清理（ToastContainer 共享同一份 items）
  document.body.querySelectorAll(".modal-mask").forEach((n) => n.remove());
});

describe("TagEditorModal 渲染", () => {
  it("打开时展示当前歌曲信息（封面 / 歌名 / 歌手 / 专辑）", async () => {
    mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal")!;
    expect(root).toBeTruthy();
    const inputs = root.querySelectorAll<HTMLInputElement>(".field-input");
    expect(inputs[0].value).toBe("安静");
    expect(inputs[1].value).toBe("周杰伦");
    expect(inputs[2].value).toBe("范特西");
    // 未选候选时封面预览 = 本地 /api/cover
    const img = q(root, ".cover-preview img");
    expect(img.getAttribute("src")).toBe("/api/cover?path=" + encodeURIComponent(SONG.path));
    w.unmount();
  });
});

describe("TagEditorModal 自动刮削", () => {
  it("点击「自动刮削」POST /api/tags/scrape 并渲染网易云/MusicBrainz 两组候选", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    let root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal")!;
    // 请求体：{ path: 当前歌曲绝对路径 }
    const scrapeCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/tags/scrape"))!;
    expect(scrapeCall).toBeTruthy();
    expect(JSON.parse(scrapeCall[1].body)).toEqual({ path: SONG.path });
    // 两组候选渲染：网易云 2 条（含时长）+ MusicBrainz 1 条
    expect(root.querySelectorAll('[data-testid="cand-netease"]').length).toBe(2);
    expect(root.querySelectorAll('[data-testid="cand-musicbrainz"]').length).toBe(1);
    expect(root.textContent).toContain("安静 (Live)");
    expect(root.textContent).toContain("04:30");
    w.unmount();
  });

  it("网易云与 MusicBrainz 两组候选各自独立容器渲染、互不串组（重叠修复回归）", async () => {
    mockFetch({
      scrape: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            query: "安静 周杰伦",
            netease: [
              {
                id: "1",
                title: "安静 (Live)",
                artist: "周杰伦",
                album: "演唱会",
                cover: null,
                duration: "04:30",
              },
              {
                id: "2",
                title: "安静",
                artist: "周杰伦",
                album: "范特西",
                cover: null,
                duration: "04:20",
              },
            ],
            musicbrainz: [
              { title: "安静", artist: "周杰伦", album: "范特西", cover: null, mbid: "m1" },
            ],
          }),
        }),
    });
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    let root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal")!;
    // 两个独立分组容器（并列兄弟），每组标题 + 自己的行
    const groups = root.querySelectorAll(".candidates > .cand-group");
    expect(groups.length).toBe(2);
    expect(q(groups[0], ".cand-group-title").textContent).toBe("网易云");
    expect(groups[0].querySelectorAll('[data-testid="cand-netease"]').length).toBe(2);
    expect(groups[0].querySelectorAll('[data-testid="cand-musicbrainz"]').length).toBe(0);
    expect(q(groups[1], ".cand-group-title").textContent).toBe("MusicBrainz");
    expect(groups[1].querySelectorAll('[data-testid="cand-musicbrainz"]').length).toBe(1);
    expect(groups[1].querySelectorAll('[data-testid="cand-netease"]').length).toBe(0);
    // 全量行数与分组内一致（不重复渲染）
    expect(root.querySelectorAll('[data-testid="cand-netease"]').length).toBe(2);
    expect(root.querySelectorAll('[data-testid="cand-musicbrainz"]').length).toBe(1);
    // 两组标题都渲染，行内容归属正确
    expect(root.querySelectorAll(".cand-group-title")[0].textContent).toBe("网易云");
    expect(root.querySelectorAll(".cand-group-title")[1].textContent).toBe("MusicBrainz");
    w.unmount();
  });

  it("两组都搜不到时显示空态文案（搜不到是正常）", async () => {
    mockFetch({
      scrape: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({ query: "x", netease: [], musicbrainz: [] }),
        }),
    });
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    let root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal")!;
    expect(root.querySelector('[data-testid="cand-empty-netease"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="cand-empty-musicbrainz"]')).toBeTruthy();
    w.unmount();
  });
});

describe("TagEditorModal 点选填充", () => {
  it("点选候选条目 → 填充表单 + 封面预览切换为候选封面", async () => {
    mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    let root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal")!;
    // 点第一条网易云（带 cover）
    qa(root, '[data-testid="cand-netease"]')[0].click();
    await nextTick();
    const inputs = root.querySelectorAll<HTMLInputElement>(".field-input");
    expect(inputs[0].value).toBe("安静 (Live)");
    expect(inputs[1].value).toBe("周杰伦");
    expect(inputs[2].value).toBe("无与伦比 演唱会");
    const img = q(root, ".cover-preview img");
    expect(img.getAttribute("src")).toBe("https://p1.music.126.net/cover1.jpg");
    w.unmount();
  });
});

describe("TagEditorModal 网易云候选惰性补年份", () => {
  const clickNetease = async (root: Element) => {
    q(root, '[data-testid="scrape-btn"]').click();
    await tick();
    q(root, '[data-testid="cand-netease"]').click();
    await tick();
    return document.body.querySelector(".modal")!;
  };

  it("点选网易云候选（有 id、表单 year 空）→ 触发 album-year → 成功后 form.year 填入", async () => {
    const fetchMock = mockFetch({
      albumYear: () => Promise.resolve({ ok: true, json: async () => ({ year: 2018 }) }),
    });
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = await clickNetease(document.body.querySelector(".modal")!);
    // 请求体：{ song_id: 候选 id }（第一条网易云候选 id=123）
    const ayCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/tags/album-year"))!;
    expect(ayCall).toBeTruthy();
    expect(JSON.parse(ayCall[1].body)).toEqual({ song_id: "123" });
    // 年份填入表单（String）
    expect(q<HTMLInputElement>(root, '[data-testid="field-year"]').value).toBe("2018");
    w.unmount();
  });

  it("点选网易云候选但请求失败 → 不报错、year 保持空（静默失败）", async () => {
    const fetchMock = mockFetch({
      albumYear: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }),
    });
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = await clickNetease(document.body.querySelector(".modal")!);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/tags/album-year"))).toBe(
      true,
    );
    expect(q<HTMLInputElement>(root, '[data-testid="field-year"]').value).toBe("");
    // 无错误 toast（静默失败；全局 toast 单例为空）
    expect(toastItems.length).toBe(0);
    w.unmount();
  });

  it("album-year 返回 year:null（无数据）→ year 保持空、不报错", async () => {
    mockFetch(); // 默认 album-year 返回 {year: null}
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = await clickNetease(document.body.querySelector(".modal")!);
    expect(q<HTMLInputElement>(root, '[data-testid="field-year"]').value).toBe("");
    // 无 toast（静默失败）
    expect(toastItems.length).toBe(0);
    w.unmount();
  });

  it("点选 MusicBrainz 候选 → 不触发 album-year", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    let root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="cand-musicbrainz"]').click();
    await tick();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/tags/album-year"))).toBe(
      false,
    );
    // MusicBrainz 候选自带 year=2001 → 正常填充
    expect(q<HTMLInputElement>(root, '[data-testid="field-year"]').value).toBe("2001");
    w.unmount();
  });

  it("网易云候选自身带 year（表单 year 非空）→ 不触发 album-year", async () => {
    const fetchMock = mockFetch({
      scrape: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            query: "安静 周杰伦",
            netease: [{ id: "123", title: "安静", artist: "周杰伦", album: "范特西", year: 2001 }],
            musicbrainz: [],
          }),
        }),
    });
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = await clickNetease(document.body.querySelector(".modal")!);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/tags/album-year"))).toBe(
      false,
    );
    expect(q<HTMLInputElement>(root, '[data-testid="field-year"]').value).toBe("2001");
    w.unmount();
  });
});

describe("TagEditorModal 保存", () => {
  it("保存请求体包含 path/title/artist/album/cover_url + 新字段（点选网易云候选 → 新字段为空 → null）", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    let root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal")!;
    qa(root, '[data-testid="cand-netease"]')[0].click();
    await nextTick();
    q(root, '[data-testid="save-btn"]').click();
    await tick();
    const saveCall = fetchMock.mock.calls.find(
      ([u, o]) => String(u).endsWith("/api/tags") && o?.method === "POST",
    )!;
    expect(saveCall).toBeTruthy();
    expect(JSON.parse(saveCall[1].body)).toEqual({
      path: SONG.path,
      title: "安静 (Live)",
      artist: "周杰伦",
      album: "无与伦比 演唱会",
      cover_url: "https://p1.music.126.net/cover1.jpg",
      year: null,
      genre: null,
      track: null,
      album_artist: null,
    });
    w.unmount();
  });

  it("手动改文本不动封面 → cover_url 传 null，新字段空值也传 null", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal")!;
    const inputs = root.querySelectorAll<HTMLInputElement>(".field-input");
    inputs[0].value = "我自己改的歌名";
    inputs[0].dispatchEvent(new Event("input"));
    await nextTick();
    q(root, '[data-testid="save-btn"]').click();
    await tick();
    const saveCall = fetchMock.mock.calls.find(
      ([u, o]) => String(u).endsWith("/api/tags") && o?.method === "POST",
    )!;
    expect(JSON.parse(saveCall[1].body)).toEqual({
      path: SONG.path,
      title: "我自己改的歌名",
      artist: "周杰伦",
      album: "范特西",
      cover_url: null,
      year: null,
      genre: null,
      track: null,
      album_artist: null,
    });
    w.unmount();
  });

  it("保存成功（改名）：更新 currentSong.path 不中断播放 + loadSongs 刷新 + toast + 关闭", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="save-btn"]').click();
    await tick();
    // 当前播放歌曲 path/名称更新为新值
    expect(state.currentSong!.path).toBe(SAVE_RES.newPath);
    expect(state.currentSong!.name).toBe("安静 (Live)");
    // audio.src 未被触碰（保持播放不中断）
    expect(audio.src).toBe("");
    // loadSongs 刷新列表（GET /api/songs），并保留当前选中
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/songs"))).toBe(true);
    expect(state.currentIndex).toBe(0);
    // 成功 toast（全局 ToastContainer，与其它组件统一）
    const toasts = mount(ToastContainer, { global: { stubs: { teleport: true } } });
    const toast = toasts.find(".toast-item");
    expect(toast.exists()).toBe(true);
    expect(toast.text()).toBe("歌曲信息已保存");
    expect(toast.classes()).toContain("toast-success");
    // 关闭弹窗
    expect(w.emitted("close")).toBeTruthy();
    w.unmount();
  });

  it("保存失败（400/404/409）：错误 toast，弹窗不关", async () => {
    const fetchMock = mockFetch({
      save: () =>
        Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "参数错误" }) }),
    });
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="save-btn"]').click();
    await tick();
    // 错误 toast（全局 ToastContainer）
    const toasts = mount(ToastContainer, { global: { stubs: { teleport: true } } });
    const toast = toasts.find(".toast-item");
    expect(toast.exists()).toBe(true);
    expect(toast.classes()).toContain("toast-error");
    expect(toast.text()).toContain("参数错误");
    // 弹窗未关闭、状态未动
    expect(w.emitted("close")).toBeFalsy();
    expect(document.body.querySelector(".modal")).toBeTruthy();
    expect(state.currentSong!.path).toBe(SONG.path);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/songs"))).toBe(false);
    w.unmount();
  });
});

describe("TagEditorModal 扩展字段（year/genre/track/album_artist）", () => {
  it("打开时表单渲染 7 个字段（新字段初始值来自歌曲元数据）", async () => {
    mockFetch();
    state.currentSong = {
      ...SONG,
      year: 1999,
      genre: "流行",
      track: 5,
      album_artist: "周杰伦",
    };
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal")!;
    expect(root.querySelectorAll(".field-input").length).toBe(7);
    expect(q<HTMLInputElement>(root, '[data-testid="field-year"]').value).toBe("1999");
    expect(q<HTMLInputElement>(root, '[data-testid="field-genre"]').value).toBe("流行");
    expect(q<HTMLInputElement>(root, '[data-testid="field-track"]').value).toBe("5");
    expect(q<HTMLInputElement>(root, '[data-testid="field-albumartist"]').value).toBe("周杰伦");
    w.unmount();
  });

  it("MusicBrainz 候选展示新字段（artist · album · year · genre），点选填充表单新字段", async () => {
    mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    let root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal")!;
    // 候选副信息：网易云不带 year/genre 不显示；MusicBrainz 带 → · 2001 · 流行
    const mbSub = q(qa(root, '[data-testid="cand-musicbrainz"]')[0], ".cand-sub");
    expect(mbSub.textContent).toContain("· 范特西");
    expect(mbSub.textContent).toContain("· 2001");
    expect(mbSub.textContent).toContain("· 流行");
    const neSub = q(qa(root, '[data-testid="cand-netease"]')[0], ".cand-sub");
    expect(neSub.textContent).not.toContain("2001");
    // 点选 MusicBrainz → 新字段填充（含 track/album_artist）
    q(root, '[data-testid="cand-musicbrainz"]').click();
    await nextTick();
    root = document.body.querySelector(".modal")!;
    expect(q<HTMLInputElement>(root, '[data-testid="field-year"]').value).toBe("2001");
    expect(q<HTMLInputElement>(root, '[data-testid="field-genre"]').value).toBe("流行");
    expect(q<HTMLInputElement>(root, '[data-testid="field-track"]').value).toBe("3");
    expect(q<HTMLInputElement>(root, '[data-testid="field-albumartist"]').value).toBe("周杰伦");
    w.unmount();
  });

  it("点选网易云候选（无新字段）→ 新字段置空", async () => {
    mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    let root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal")!;
    q(root, '[data-testid="cand-netease"]').click();
    await nextTick();
    expect(q<HTMLInputElement>(root, '[data-testid="field-year"]').value).toBe("");
    expect(q<HTMLInputElement>(root, '[data-testid="field-genre"]').value).toBe("");
    expect(q<HTMLInputElement>(root, '[data-testid="field-track"]').value).toBe("");
    expect(q<HTMLInputElement>(root, '[data-testid="field-albumartist"]').value).toBe("");
    w.unmount();
  });

  it("保存：year/track 数字转换、空值 null、genre/album_artist 空串 → null", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal")!;
    q<HTMLInputElement>(root, '[data-testid="field-year"]').value = "1995";
    q<HTMLInputElement>(root, '[data-testid="field-year"]').dispatchEvent(new Event("input"));
    q<HTMLInputElement>(root, '[data-testid="field-track"]').value = "3";
    q<HTMLInputElement>(root, '[data-testid="field-track"]').dispatchEvent(new Event("input"));
    q<HTMLInputElement>(root, '[data-testid="field-genre"]').value = "流行";
    q<HTMLInputElement>(root, '[data-testid="field-genre"]').dispatchEvent(new Event("input"));
    q<HTMLInputElement>(root, '[data-testid="field-albumartist"]').value = "  周杰伦  ";
    q<HTMLInputElement>(root, '[data-testid="field-albumartist"]').dispatchEvent(
      new Event("input"),
    );
    await nextTick();
    q(root, '[data-testid="save-btn"]').click();
    await tick();
    const saveCall = fetchMock.mock.calls.find(
      ([u, o]) => String(u).endsWith("/api/tags") && o?.method === "POST",
    )!;
    const body = JSON.parse(saveCall[1].body);
    expect(body.year).toBe(1995); // 数字类型（非字符串）
    expect(body.track).toBe(3);
    expect(body.genre).toBe("流行");
    expect(body.album_artist).toBe("周杰伦"); // trim
    w.unmount();
  });
});

describe("TagEditorModal 自动刮削（autoScrape prop）", () => {
  it("open + autoScrape → 打开即自动触发一次刮削（无需点按钮）", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true, autoScrape: true } });
    await nextTick();
    await tick();
    const root = document.body.querySelector(".modal")!;
    const scrapeCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/api/tags/scrape"),
    );
    expect(scrapeCalls).toHaveLength(1); // 只自动触发一次
    expect(JSON.parse(scrapeCalls[0][1].body)).toEqual({ path: SONG.path });
    // 候选已渲染（不阻塞表单操作，异步完成后展示）
    expect(root.querySelectorAll('[data-testid="cand-netease"]').length).toBe(2);
    expect(root.querySelectorAll('[data-testid="cand-musicbrainz"]').length).toBe(1);
    w.unmount();
  });

  it("autoScrape=false（默认）→ 打开不自动刮削", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    await tick();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/tags/scrape"))).toBe(false);
    w.unmount();
  });

  it("autoScrape 刮削失败 → 显示 scrapeError，不阻塞表单（弹窗仍可操作）", async () => {
    mockFetch({
      scrape: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }),
    });
    const w = mount(TagEditorModal, { props: { open: true, autoScrape: true } });
    await tick();
    const root = document.body.querySelector(".modal")!;
    expect(root.querySelector(".scrape-error")).toBeTruthy();
    expect(q<HTMLButtonElement>(root, '[data-testid="save-btn"]').disabled).toBe(false);
    w.unmount();
  });

  it("指定目标歌曲（song prop）→ 表单/刮削/保存都以该歌曲为准，不影响当前播放", async () => {
    const fetchMock = mockFetch();
    const target = { ...SONG, path: "/music/别首.mp3", name: "别首" };
    state.currentSong = { ...SONG }; // 当前播放仍是安静
    const w = mount(TagEditorModal, {
      props: { open: true, autoScrape: true, song: target },
    });
    await nextTick();
    const root = document.body.querySelector(".modal")!;
    // 表单显示目标歌曲
    const inputs = root.querySelectorAll<HTMLInputElement>(".field-input");
    expect(inputs[0].value).toBe("别首");
    expect(q(root, ".head-sub").textContent).toContain("别首");
    // 自动刮削用目标 path
    const scrapeCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/tags/scrape"))!;
    expect(JSON.parse(scrapeCall[1].body)).toEqual({ path: "/music/别首.mp3" });
    // 保存用目标 path；改名更新只发生在编辑目标 === 当前播放时（这里不是 → 不动 currentSong）
    q(root, '[data-testid="save-btn"]').click();
    await tick();
    const saveCall = fetchMock.mock.calls.find(
      ([u, o]) => String(u).endsWith("/api/tags") && o?.method === "POST",
    )!;
    expect(JSON.parse(saveCall[1].body).path).toBe("/music/别首.mp3");
    expect(state.currentSong!.path).toBe(SONG.path); // 当前播放未被改写
    w.unmount();
  });
});

describe("TagEditorModal enabled_fields 提交过滤", () => {
  it("设置 scraping.enabled_fields 存在且非空 → 只提交勾选字段，其余置 null", async () => {
    const fetchMock = mockFetch({
      settings: {
        settings: {
          scraping: { enabled_fields: ["title", "artist", "year", "genre"] },
          library: {},
          playback: {},
        },
      },
    });
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    await tick(); // 等 GET /api/library/settings 落缓存（enabled_fields 提交过滤依赖）
    const root = document.body.querySelector(".modal")!;
    q<HTMLInputElement>(root, '[data-testid="field-year"]').value = "1995";
    q<HTMLInputElement>(root, '[data-testid="field-year"]').dispatchEvent(new Event("input"));
    await nextTick();
    q(root, '[data-testid="save-btn"]').click();
    await tick();
    const saveCall = fetchMock.mock.calls.find(
      ([u, o]) => String(u).endsWith("/api/tags") && o?.method === "POST",
    )!;
    const body = JSON.parse(saveCall[1].body);
    expect(body).toEqual({
      path: SONG.path,
      title: "安静", // 勾选 → 提交
      artist: "周杰伦",
      year: 1995,
      genre: null, // 勾选了 genre 但表单为空 → null（不写）
      album: null, // 未勾选 → null（不写）
      cover_url: null,
      track: null,
      album_artist: null,
    });
    w.unmount();
  });

  it("enabled_fields 为空数组 → 提交全部字段（不限制）", async () => {
    const fetchMock = mockFetch(); // 默认 settings.enabled_fields = []
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal")!;
    q<HTMLInputElement>(root, '[data-testid="field-year"]').value = "1995";
    q<HTMLInputElement>(root, '[data-testid="field-year"]').dispatchEvent(new Event("input"));
    await nextTick();
    q(root, '[data-testid="save-btn"]').click();
    await tick();
    const saveCall = fetchMock.mock.calls.find(
      ([u, o]) => String(u).endsWith("/api/tags") && o?.method === "POST",
    )!;
    const body = JSON.parse(saveCall[1].body);
    expect(body.year).toBe(1995);
    expect(body.album).toBe("范特西");
    expect(body.cover_url).toBe(null);
    w.unmount();
  });

  it("设置接口失败（后端未合并）→ 提交全部字段（容错）", async () => {
    const fetchMock = mockFetch({
      settings: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
    });
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal")!;
    q<HTMLInputElement>(root, '[data-testid="field-year"]').value = "1995";
    q<HTMLInputElement>(root, '[data-testid="field-year"]').dispatchEvent(new Event("input"));
    await nextTick();
    q(root, '[data-testid="save-btn"]').click();
    await tick();
    const saveCall = fetchMock.mock.calls.find(
      ([u, o]) => String(u).endsWith("/api/tags") && o?.method === "POST",
    )!;
    const body = JSON.parse(saveCall[1].body);
    expect(body.year).toBe(1995);
    expect(body.album).toBe("范特西"); // 未限制 → 全部提交
    expect(body.track).toBe(null);
    w.unmount();
  });
});
