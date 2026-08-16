// Playlist 列头点击排序测试
// 覆盖：点列头 → sortKey/sortDir 变化（升序 → 降序 → 回默认三态循环）、方向箭头、
// 切列重置方向、与工具条 select 联动、列头点击不触发行点击
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  constructor() {
    this.src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

const Playlist = (await import("../components/Playlist.vue")).default;
const { state } = await import("../composables/usePlayer.js");

const SONGS = [
  { id: "b", name: "B歌", artist: "Z歌手", duration: 300 },
  { id: "a", name: "A歌", artist: "M歌手", duration: 90 },
  { id: "c", name: "C歌", artist: "A歌手", duration: 200 },
];

const colNames = () => wrapper.findAll(".pl-name").map((n) => n.text());
const colNameBtn = () => wrapper.find('[data-testid="pl-col-name"]');
const colArtistBtn = () => wrapper.find('[data-testid="pl-col-artist"]');
const colDurBtn = () => wrapper.find('[data-testid="pl-col-duration"]');
const arrow = (btn) => btn.find(".pl-col-arrow");
const isOn = (btn) => btn.classes().includes("on");

let wrapper;

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    loading: false,
    error: "",
    favorites: [],
    playlists: [],
    activePlaylistId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  wrapper?.unmount();
  wrapper = null;
});

describe("Playlist 列头点击排序", () => {
  it("初始：无列头激活、无方向箭头，列表保持原始顺序", async () => {
    state.songs = [...SONGS];
    wrapper = mount(Playlist);
    expect(isOn(colNameBtn())).toBe(false);
    expect(isOn(colArtistBtn())).toBe(false);
    expect(isOn(colDurBtn())).toBe(false);
    expect(arrow(colNameBtn()).exists()).toBe(false);
    expect(colNames()).toEqual(["B歌", "A歌", "C歌"]);
  });

  it("点「歌名」→ 按歌名升序 + 列头激活 + 上箭头", async () => {
    state.songs = [...SONGS];
    wrapper = mount(Playlist);
    await colNameBtn().trigger("click");
    expect(colNames()).toEqual(["A歌", "B歌", "C歌"]);
    expect(isOn(colNameBtn())).toBe(true);
    expect(arrow(colNameBtn()).text()).toBe("↑");
  });

  it("再点「歌名」→ 降序 + 下箭头", async () => {
    state.songs = [...SONGS];
    wrapper = mount(Playlist);
    await colNameBtn().trigger("click");
    await colNameBtn().trigger("click");
    expect(colNames()).toEqual(["C歌", "B歌", "A歌"]);
    expect(arrow(colNameBtn()).text()).toBe("↓");
  });

  it("第三次点「歌名」→ 回到默认顺序，列头取消激活", async () => {
    state.songs = [...SONGS];
    wrapper = mount(Playlist);
    await colNameBtn().trigger("click");
    await colNameBtn().trigger("click");
    await colNameBtn().trigger("click");
    expect(colNames()).toEqual(["B歌", "A歌", "C歌"]);
    expect(isOn(colNameBtn())).toBe(false);
    expect(arrow(colNameBtn()).exists()).toBe(false);
    // select 同步回 default
    expect(wrapper.find(".pl-sort").element.value).toBe("default");
  });

  it("点「歌手」→ 按歌手升序；切列后方向重置为升序", async () => {
    state.songs = [...SONGS];
    wrapper = mount(Playlist);
    // 先让「歌名」进入降序
    await colNameBtn().trigger("click");
    await colNameBtn().trigger("click");
    // 切到「歌手」：应重置为升序（A歌手 → M歌手 → Z歌手），歌名列头取消激活
    await colArtistBtn().trigger("click");
    expect(colNames()).toEqual(["C歌", "A歌", "B歌"]);
    expect(isOn(colArtistBtn())).toBe(true);
    expect(isOn(colNameBtn())).toBe(false);
    expect(arrow(colArtistBtn()).text()).toBe("↑");
  });

  it("点「时长」→ 升序；再点 → 降序", async () => {
    state.songs = [...SONGS];
    wrapper = mount(Playlist);
    await colDurBtn().trigger("click");
    expect(colNames()).toEqual(["A歌", "C歌", "B歌"]); // 90 → 200 → 300
    expect(arrow(colDurBtn()).text()).toBe("↑");
    await colDurBtn().trigger("click");
    expect(colNames()).toEqual(["B歌", "C歌", "A歌"]); // 300 → 200 → 90
    expect(arrow(colDurBtn()).text()).toBe("↓");
  });

  it("工具条 select 与列头联动：选歌手 → 列头激活；选默认 → 取消激活", async () => {
    state.songs = [...SONGS];
    wrapper = mount(Playlist);
    await wrapper.find(".pl-sort").setValue("artist");
    expect(isOn(colArtistBtn())).toBe(true);
    expect(arrow(colArtistBtn()).text()).toBe("↑");
    expect(colNames()).toEqual(["C歌", "A歌", "B歌"]);
    await wrapper.find(".pl-sort").setValue("default");
    expect(isOn(colArtistBtn())).toBe(false);
    expect(arrow(colArtistBtn()).exists()).toBe(false);
    expect(colNames()).toEqual(["B歌", "A歌", "C歌"]);
  });

  it("select 切换时重置列头方向（降序 → 升序）", async () => {
    state.songs = [...SONGS];
    wrapper = mount(Playlist);
    await colNameBtn().trigger("click");
    await colNameBtn().trigger("click"); // name 降序
    expect(arrow(colNameBtn()).text()).toBe("↓");
    // 用 select 重新选「按标题」→ 方向重置为升序
    await wrapper.find(".pl-sort").setValue("name");
    expect(arrow(colNameBtn()).text()).toBe("↑");
    expect(colNames()).toEqual(["A歌", "B歌", "C歌"]);
  });

  it("列头点击不触发行点击（不播放）", async () => {
    state.songs = [...SONGS];
    wrapper = mount(Playlist);
    await colNameBtn().trigger("click");
    expect(state.currentIndex).toBe(-1);
    expect(state.currentSong).toBeNull();
  });

  it("排序后列头点击不破坏右键菜单/行点击的原始索引语义", async () => {
    state.songs = [...SONGS];
    wrapper = mount(Playlist);
    await colNameBtn().trigger("click"); // A歌(原索引1) 排到第一
    await wrapper.findAll(".pl-item")[0].trigger("click");
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("A歌");
  });
});
