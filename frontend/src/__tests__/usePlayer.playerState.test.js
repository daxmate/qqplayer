// usePlayer composable 单元测试 — 播放器状态（cycleSpeed/nextSong/prevSong/连播模式/开关切换/loadSongs/selectSong）
// 拆分自 usePlayer.test.js（纯搬移 + harness 收敛公共头部样板，用例零改动）
import { describe, expect, it, vi } from "vitest";
import {
  state,
  cycleSpeed,
  cyclePlayMode,
  nextSong,
  prevSong,
  toggleKaraoke,
  toggleZh,
  loadSongs,
  findSongIndex,
  selectSong,
  FakeAudio,
} from "./helpers/usePlayerHarness.js";

describe("cycleSpeed", () => {
  it("在 0.75 → 1.0 → 1.25 间循环", () => {
    state.speed = 1.0;
    cycleSpeed();
    expect(state.speed).toBe(1.25);
    cycleSpeed();
    expect(state.speed).toBe(0.75);
    cycleSpeed();
    expect(state.speed).toBe(1.0);
  });
});

describe("nextSong / prevSong", () => {
  it("环绕播放：末尾 next 回到第一首", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 1;
    await nextSong();
    expect(state.currentIndex).toBe(0);
  });

  it("环绕播放：开头 prev 到最后一首", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    await prevSong();
    expect(state.currentIndex).toBe(1);
  });

  it("播放中切歌：继续自动播放（autoPlay 跟随播放状态）", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    await selectSong(0, { autoPlay: true });
    const a = FakeAudio.instances[0];
    a.paused = false; // 播放中
    await nextSong();
    expect(state.currentIndex).toBe(1);
    expect(a.paused).toBe(false); // 切歌后自动播放
  });

  it("暂停中切歌：保持暂停（不自动播放）", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    await selectSong(0, { autoPlay: true });
    const a = FakeAudio.instances[0];
    a.paused = true; // 主动暂停
    await nextSong();
    expect(state.currentIndex).toBe(1);
    expect(a.paused).toBe(true); // 保持暂停
  });

  it("跟唱模式切歌：自动退出跟唱（回音乐模式）并自动播放（句末暂停不阻止）", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    state.mode = "karaoke";
    await selectSong(0, { autoPlay: true });
    const a = FakeAudio.instances[0];
    a.paused = true; // 跟唱句末自动暂停状态
    await nextSong();
    expect(state.currentIndex).toBe(1);
    expect(state.mode).toBe("continuous"); // 自动退出跟唱
    expect(a.paused).toBe(false); // 切歌后自动播放
  });

  it("跟唱模式 prev：同样自动退出跟唱并自动播放", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 1;
    state.mode = "karaoke";
    await selectSong(1, { autoPlay: true });
    const a = FakeAudio.instances[0];
    a.paused = true;
    await prevSong();
    expect(state.currentIndex).toBe(0);
    expect(state.mode).toBe("continuous");
    expect(a.paused).toBe(false);
  });

  it("跟唱模式切歌：显式 autoPlay=false 仍尊重（不自动播放）", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    state.mode = "karaoke";
    await selectSong(0, { autoPlay: true });
    const a = FakeAudio.instances[0];
    a.paused = true;
    await nextSong({ autoPlay: false });
    expect(state.currentIndex).toBe(1);
    expect(state.mode).toBe("continuous"); // 跟唱照样退出
    expect(a.paused).toBe(true); // 显式不播
  });
});

describe("连播播放模式：随机 / 单曲循环", () => {
  const SONGS5 = [
    { path: "/a.mp3", name: "A" },
    { path: "/b.mp3", name: "B" },
    { path: "/c.mp3", name: "C" },
    { path: "/d.mp3", name: "D" },
    { path: "/e.mp3", name: "E" },
  ];
  const audio = () => FakeAudio.instances[0];

  function stubFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
  }

  function fireEnded() {
    const a = audio();
    a.paused = false;
    a.listeners["ended"]();
    return a;
  }

  // Math.random 固定 0：leader=0 时 rest=[1,2,3,4] 洗牌后为 [2,3,4,1]
  // → 队列 [0,2,3,4,1]
  function stubRandom() {
    vi.spyOn(Math, "random").mockReturnValue(0);
  }

  it("cyclePlayMode：列表循环 → 随机 → 单曲循环 → 列表循环", () => {
    state.playMode = "order";
    cyclePlayMode();
    expect(state.playMode).toBe("shuffle");
    cyclePlayMode();
    expect(state.playMode).toBe("repeatOne");
    cyclePlayMode();
    expect(state.playMode).toBe("order");
  });

  it("单曲循环：播完重播本首（索引不变、从头播、继续播放）", async () => {
    state.songs = SONGS5;
    stubFetch();
    await selectSong(0);
    state.playMode = "repeatOne";
    const a = audio();
    a.currentTime = 120;
    fireEnded();
    expect(state.currentIndex).toBe(0);
    expect(a.currentTime).toBe(0);
    expect(a.paused).toBe(false);
  });

  it("单曲循环：手动下一首正常切歌（模式保持）", async () => {
    state.songs = SONGS5;
    stubFetch();
    await selectSong(0);
    state.playMode = "repeatOne";
    await nextSong();
    expect(state.currentIndex).toBe(1);
    expect(state.playMode).toBe("repeatOne");
  });

  it("随机模式：手动下一首按洗牌队列推进", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    await nextSong();
    expect(state.currentIndex).toBe(2);
    await nextSong();
    expect(state.currentIndex).toBe(3);
    await nextSong();
    expect(state.currentIndex).toBe(4);
    await nextSong();
    expect(state.currentIndex).toBe(1);
  });

  it("随机模式：播完自动随机下一首（不重复相邻）", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    const a = audio();
    a.currentTime = 100;
    fireEnded();
    expect(state.currentIndex).toBe(2);
  });

  it("列表循环：播完自动切下一首并继续播放（连播 bug 回归）", async () => {
    state.songs = SONGS5;
    stubFetch();
    await selectSong(0);
    const a = audio();
    a.currentTime = 100;
    fireEnded();
    expect(state.currentIndex).toBe(1);
    expect(a.paused).toBe(false); // 自动播放
  });

  it("随机模式：播完自动切下一首并继续播放（连播 bug 回归）", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    const a = audio();
    a.currentTime = 100;
    fireEnded();
    expect(state.currentIndex).toBe(2);
    expect(a.paused).toBe(false); // 自动播放
  });

  it("列表循环：只有一首歌时播完重播本首（自动播放）", async () => {
    state.songs = [SONGS5[0]];
    stubFetch();
    await selectSong(0);
    const a = audio();
    a.currentTime = 100;
    fireEnded();
    expect(state.currentIndex).toBe(0);
    expect(a.currentTime).toBe(0);
    expect(a.paused).toBe(false);
  });

  it("图书模式（books）：播完同样自动切下一首（读书放背景音乐不中断）", async () => {
    state.songs = SONGS5;
    stubFetch();
    state.mode = "books";
    await selectSong(0);
    const a = audio();
    a.currentTime = 100;
    fireEnded();
    expect(state.currentIndex).toBe(1);
    expect(a.paused).toBe(false); // 自动播放
  });

  it("selectSong 默认不自动播放（手动选歌由调用方决定是否播放）", async () => {
    state.songs = SONGS5;
    stubFetch();
    await selectSong(0);
    expect(audio().paused).toBe(true);
  });

  it("随机模式：一轮播完自动重新洗牌", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    // 队列 [0,2,3,4,1]：推进到队列末尾
    await nextSong(); // 2
    await nextSong(); // 3
    await nextSong(); // 4
    await nextSong(); // 1（队列末）
    // 再下一首 → 以 1 为队首重新洗牌：rest=[0,2,3,4] → 队列 [1,2,3,4,0] → 下一首 2
    await nextSong();
    expect(state.currentIndex).toBe(2);
  });

  it("随机模式：上一首按播放历史回退", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    await nextSong(); // → 2，历史 [0]
    await nextSong(); // → 3，历史 [0,2]
    await prevSong();
    expect(state.currentIndex).toBe(2);
    await prevSong();
    expect(state.currentIndex).toBe(0);
  });

  it("随机模式：无历史时上一首按顺序回退", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    await prevSong();
    expect(state.currentIndex).toBe(4);
  });

  it("随机模式：手动选歌同步队列位置，继续随机不乱序", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    await nextSong(); // 2（pos 1）
    await selectSong(4); // 手动点 E：队列 [0,2,3,4,1] 中 pos 3
    await nextSong();
    expect(state.currentIndex).toBe(1); // 队列 pos 4
  });
});

describe("开关切换", () => {
  it("toggleKaraoke / toggleZh", () => {
    state.karaokeOn = true;
    toggleKaraoke();
    expect(state.karaokeOn).toBe(false);

    state.zhVisible = true;
    toggleZh();
    expect(state.zhVisible).toBe(false);
  });
});

describe("loadSongs", () => {
  it("拉取歌曲列表并自动选中第一首", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url) => ({
        ok: true,
        json: async () => [
          { path: "/a.mp3", name: "A" },
          { path: "/b.mp3", name: "B" },
        ],
      })),
    );
    await loadSongs();
    expect(state.songs).toHaveLength(2);
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong.path).toBe("/a.mp3");
    expect(fetch).toHaveBeenCalledWith("/api/songs", expect.anything());
  });

  it("加载失败时设置 error 而不是抛异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await loadSongs();
    expect(state.error).toContain("加载歌曲列表失败");
    expect(state.loading).toBe(false);
  });

  it("刷新后 currentSong 引用同步到新数组（刮削改名/封面后播放界面立即更新）", async () => {
    state.songs = [{ path: "/old.mp3", name: "旧名", artist: "旧歌手" }];
    state.currentIndex = 0;
    state.currentSong = state.songs[0];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [{ path: "/old.mp3", name: "新名", artist: "新歌手" }],
      })),
    );
    await loadSongs();
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong.name).toBe("新名"); // 不再是旧对象
    expect(state.currentSong.artist).toBe("新歌手");
  });

  it("刷新后网络歌按 streamId 保持选中（path 为 null 不误匹配）", async () => {
    state.songs = [
      { path: "/a.mp3", name: "本地A" },
      { type: "stream", streamId: "s1", path: null, name: "网络1" },
      { type: "stream", streamId: "s2", path: null, name: "网络2" },
    ];
    state.currentIndex = 2;
    state.currentSong = state.songs[2]; // 正在播网络2
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { path: "/a.mp3", name: "本地A" },
          { type: "stream", streamId: "s1", path: null, name: "网络1" },
          { type: "stream", streamId: "s2", path: null, name: "网络2" },
        ],
      })),
    );
    await loadSongs();
    expect(state.currentIndex).toBe(2);
    expect(state.currentSong.streamId).toBe("s2");
  });

  it("findSongIndex：本地歌按 path，网络歌按 streamId，空/不存在返回 -1", () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { type: "stream", streamId: "s1", path: null, name: "S1" },
      { type: "stream", streamId: "s2", path: null, name: "S2" },
    ];
    expect(findSongIndex({ path: "/a.mp3" })).toBe(0);
    expect(findSongIndex({ type: "stream", streamId: "s2", path: null })).toBe(2);
    expect(findSongIndex({ type: "stream", streamId: "s1", path: null })).toBe(1); // 不误匹配第一个 stream
    expect(findSongIndex({ path: "/nope.mp3" })).toBe(-1);
    expect(findSongIndex(null)).toBe(-1);
  });
});

describe("selectSong", () => {
  it("越界 index 不动作", async () => {
    state.songs = [{ path: "/a.mp3" }];
    await selectSong(5);
    expect(state.currentSong).toBeNull();
  });
});
