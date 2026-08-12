// Playlist 组件测试
import { describe, expect, it, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Playlist from "../components/Playlist.vue";
import { state } from "../composables/usePlayer.js";

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    loading: false,
    error: "",
  });
});

describe("Playlist", () => {
  it("空列表时显示提示", () => {
    const wrapper = mount(Playlist);
    expect(wrapper.text()).toContain("没有歌曲");
  });

  it("扫描中显示扫描提示", () => {
    state.loading = true;
    const wrapper = mount(Playlist);
    expect(wrapper.text()).toContain("扫描中");
  });

  it("渲染歌曲名称和歌手", () => {
    state.songs = [
      { id: "a", name: "ヤキモチ", artist: "高橋優", has_lyric: true },
      { id: "b", name: "知足", artist: "五月天", has_lyric: false },
    ];
    const wrapper = mount(Playlist);
    expect(wrapper.text()).toContain("ヤキモチ");
    expect(wrapper.text()).toContain("高橋優");
    expect(wrapper.text()).toContain("五月天");
  });

  it("有歌词的歌曲显示歌词标记（Mic 图标）", () => {
    state.songs = [{ id: "a", name: "ヤキモチ", artist: "高橋優", has_lyric: true }];
    const wrapper = mount(Playlist);
    expect(wrapper.find(".pl-lyric svg").exists()).toBe(true);
  });

  it("当前播放的歌曲有 active class", () => {
    state.songs = [
      { id: "a", name: "A", artist: "" },
      { id: "b", name: "B", artist: "" },
    ];
    state.currentIndex = 1;
    const wrapper = mount(Playlist);
    const items = wrapper.findAll(".pl-item");
    expect(items[1].classes()).toContain("active");
  });
});
