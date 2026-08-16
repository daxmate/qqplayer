// TagEditorModal 组件测试（歌曲信息编辑弹窗 / 标签刮削器）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";

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

const TagEditorModal = (await import("../components/TagEditorModal.vue")).default;
const { state, audio } = await import("../composables/usePlayer.js");

const SONG = { path: "/music/安静.mp3", name: "安静", artist: "周杰伦", album: "范特西" };

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
function mockFetch({ scrape, save, songs } = {}) {
  const mock = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.includes("/api/tags/scrape") && opts?.method === "POST") {
      return scrape ? scrape() : Promise.resolve({ ok: true, json: async () => SCRAPE_RES });
    }
    if (u.includes("/api/tags") && opts?.method === "POST") {
      return save ? save() : Promise.resolve({ ok: true, json: async () => SAVE_RES });
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

const tick = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  Object.assign(state, {
    songs: [{ ...SONG }],
    currentIndex: 0,
    currentSong: { ...SONG },
  });
  audio.src = ""; // 记录基线：验证保存改名不触碰 audio.src（播放不中断）
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.querySelectorAll(".modal-mask, .tag-toast").forEach((n) => n.remove());
});

describe("TagEditorModal 渲染", () => {
  it("打开时展示当前歌曲信息（封面 / 歌名 / 歌手 / 专辑）", async () => {
    mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    expect(root).toBeTruthy();
    const inputs = root.querySelectorAll(".field-input");
    expect(inputs[0].value).toBe("安静");
    expect(inputs[1].value).toBe("周杰伦");
    expect(inputs[2].value).toBe("范特西");
    // 未选候选时封面预览 = 本地 /api/cover
    const img = root.querySelector(".cover-preview img");
    expect(img.getAttribute("src")).toBe("/api/cover?path=" + encodeURIComponent(SONG.path));
    w.unmount();
  });
});

describe("TagEditorModal 自动刮削", () => {
  it("点击「自动刮削」POST /api/tags/scrape 并渲染网易云/MusicBrainz 两组候选", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    let root = document.body.querySelector(".modal");
    root.querySelector('[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal");
    // 请求体：{ path: 当前歌曲绝对路径 }
    const scrapeCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/tags/scrape"));
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
    let root = document.body.querySelector(".modal");
    root.querySelector('[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal");
    // 两个独立分组容器（并列兄弟），每组标题 + 自己的行
    const groups = root.querySelectorAll(".candidates > .cand-group");
    expect(groups.length).toBe(2);
    expect(groups[0].querySelector(".cand-group-title").textContent).toBe("网易云");
    expect(groups[0].querySelectorAll('[data-testid="cand-netease"]').length).toBe(2);
    expect(groups[0].querySelectorAll('[data-testid="cand-musicbrainz"]').length).toBe(0);
    expect(groups[1].querySelector(".cand-group-title").textContent).toBe("MusicBrainz");
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
    let root = document.body.querySelector(".modal");
    root.querySelector('[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal");
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
    let root = document.body.querySelector(".modal");
    root.querySelector('[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal");
    // 点第一条网易云（带 cover）
    root.querySelectorAll('[data-testid="cand-netease"]')[0].click();
    await nextTick();
    const inputs = root.querySelectorAll(".field-input");
    expect(inputs[0].value).toBe("安静 (Live)");
    expect(inputs[1].value).toBe("周杰伦");
    expect(inputs[2].value).toBe("无与伦比 演唱会");
    const img = root.querySelector(".cover-preview img");
    expect(img.getAttribute("src")).toBe("https://p1.music.126.net/cover1.jpg");
    w.unmount();
  });
});

describe("TagEditorModal 保存", () => {
  it("保存请求体包含 path/title/artist/album/cover_url（点选候选 → cover_url=候选封面）", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    let root = document.body.querySelector(".modal");
    root.querySelector('[data-testid="scrape-btn"]').click();
    await tick();
    root = document.body.querySelector(".modal");
    root.querySelectorAll('[data-testid="cand-netease"]')[0].click();
    await nextTick();
    root.querySelector('[data-testid="save-btn"]').click();
    await tick();
    const saveCall = fetchMock.mock.calls.find(
      ([u, o]) => String(u).endsWith("/api/tags") && o?.method === "POST",
    );
    expect(saveCall).toBeTruthy();
    expect(JSON.parse(saveCall[1].body)).toEqual({
      path: SONG.path,
      title: "安静 (Live)",
      artist: "周杰伦",
      album: "无与伦比 演唱会",
      cover_url: "https://p1.music.126.net/cover1.jpg",
    });
    w.unmount();
  });

  it("手动改文本不动封面 → cover_url 传 null", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    const inputs = root.querySelectorAll(".field-input");
    inputs[0].value = "我自己改的歌名";
    inputs[0].dispatchEvent(new Event("input"));
    await nextTick();
    root.querySelector('[data-testid="save-btn"]').click();
    await tick();
    const saveCall = fetchMock.mock.calls.find(
      ([u, o]) => String(u).endsWith("/api/tags") && o?.method === "POST",
    );
    expect(JSON.parse(saveCall[1].body)).toEqual({
      path: SONG.path,
      title: "我自己改的歌名",
      artist: "周杰伦",
      album: "范特西",
      cover_url: null,
    });
    w.unmount();
  });

  it("保存成功（改名）：更新 currentSong.path 不中断播放 + loadSongs 刷新 + toast + 关闭", async () => {
    const fetchMock = mockFetch();
    const w = mount(TagEditorModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    root.querySelector('[data-testid="save-btn"]').click();
    await tick();
    // 当前播放歌曲 path/名称更新为新值
    expect(state.currentSong.path).toBe(SAVE_RES.newPath);
    expect(state.currentSong.name).toBe("安静 (Live)");
    // audio.src 未被触碰（保持播放不中断）
    expect(audio.src).toBe("");
    // loadSongs 刷新列表（GET /api/songs），并保留当前选中
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/songs"))).toBe(true);
    expect(state.currentIndex).toBe(0);
    // 成功 toast
    const toast = document.body.querySelector('[data-testid="tag-toast"]');
    expect(toast).toBeTruthy();
    expect(toast.textContent).toBe("歌曲信息已保存");
    expect(toast.classList.contains("err")).toBe(false);
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
    const root = document.body.querySelector(".modal");
    root.querySelector('[data-testid="save-btn"]').click();
    await tick();
    const toast = document.body.querySelector('[data-testid="tag-toast"]');
    expect(toast).toBeTruthy();
    expect(toast.classList.contains("err")).toBe(true);
    expect(toast.textContent).toContain("参数错误");
    // 弹窗未关闭、状态未动
    expect(w.emitted("close")).toBeFalsy();
    expect(document.body.querySelector(".modal")).toBeTruthy();
    expect(state.currentSong.path).toBe(SONG.path);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/songs"))).toBe(false);
    w.unmount();
  });
});
