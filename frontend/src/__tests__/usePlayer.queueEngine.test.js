// usePlayer composable 单元测试 — 队列引擎（收藏/removeFromQueue/歌单/队列拖拽排序）
// 拆分自 usePlayer.test.js（纯搬移 + harness 收敛公共头部样板，用例零改动）
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  state,
  cyclePlayMode,
  nextSong,
  loadSongs,
  loadFavorites,
  toggleFavorite,
  isFavorite,
  removeFromQueue,
  reorderQueue,
  persistQueueOrder,
  loadQueueOrder,
  loadPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  setPlaylistOrder,
  isInPlaylist,
  getPendingOps,
  invalidate,
  useToast,
  clearToasts,
} from "./helpers/usePlayerHarness.js";

describe("收藏", () => {
  it("toggleFavorite：乐观更新 + POST 后端", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await toggleFavorite("/a.mp3");
    expect(state.favorites).toContain("/a.mp3");
    expect(isFavorite("/a.mp3")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/favorites/toggle",
      expect.objectContaining({ method: "POST" }),
    );
    // 再点取消
    await toggleFavorite("/a.mp3");
    expect(state.favorites).not.toContain("/a.mp3");
  });

  it("toggleFavorite：网络失败 → 本地保留 + 进 dirty 队列（本地优先，离线语义）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await toggleFavorite("/a.mp3");
    expect(state.favorites).toEqual(["/a.mp3"]); // 不回滚：离线本地先写
    const ops = await getPendingOps();
    expect(ops.some((o) => o.op.url === "/api/favorites/toggle" && o.op.method === "POST")).toBe(
      true,
    );
    // 取消收藏网络失败也保留
    await toggleFavorite("/a.mp3");
    expect(state.favorites).toEqual([]);
  });

  it("loadFavorites 拉取后端收藏列表", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ paths: ["/a.mp3", "/b.mp3"] }) })),
    );
    await loadFavorites();
    expect(state.favorites).toEqual(["/a.mp3", "/b.mp3"]);
  });
});

describe("removeFromQueue", () => {
  const SONGS = [
    { path: "/a.mp3", name: "A" },
    { path: "/b.mp3", name: "B" },
    { path: "/c.mp3", name: "C" },
  ];

  function stubFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
  }

  it("移除当前歌：切到原位置的新歌", async () => {
    state.songs = [...SONGS];
    state.currentIndex = 1;
    stubFetch();
    removeFromQueue(1); // 移除 B
    expect(state.songs.map((s) => s.name)).toEqual(["A", "C"]);
    expect(state.currentIndex).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentSong.name).toBe("C");
  });

  it("移除最后一首：切到新的最后一首", async () => {
    state.songs = [...SONGS];
    state.currentIndex = 2;
    stubFetch();
    removeFromQueue(2); // 移除 C
    expect(state.songs.map((s) => s.name)).toEqual(["A", "B"]);
    expect(state.currentIndex).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentSong.name).toBe("B");
  });

  it("移除当前歌之前的歌：索引前移", async () => {
    state.songs = [...SONGS];
    state.currentIndex = 2;
    state.currentSong = state.songs[2];
    stubFetch();
    removeFromQueue(0); // 移除 A（当前 C 之前）
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("C");
  });

  it("移除当前歌之后的歌：当前不变", async () => {
    state.songs = [...SONGS];
    state.currentIndex = 1;
    state.currentSong = state.songs[1];
    removeFromQueue(2); // 移除 C（当前 B 之后）
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("B");
  });

  it("移除最后一首歌：清空播放器状态", () => {
    state.songs = [{ path: "/a.mp3", name: "A" }];
    state.currentIndex = 0;
    state.currentSong = state.songs[0];
    removeFromQueue(0);
    expect(state.songs).toEqual([]);
    expect(state.currentIndex).toBe(-1);
    expect(state.currentSong).toBeNull();
    expect(state.isPlaying).toBe(false);
  });

  it("越界索引不动作", () => {
    state.songs = [...SONGS];
    state.currentIndex = 1;
    removeFromQueue(5);
    expect(state.songs).toHaveLength(3);
  });
});

describe("removeFromQueue 撤销（toast + 原位恢复）", () => {
  const SONGS = [
    { path: "/a.mp3", name: "A" },
    { path: "/b.mp3", name: "B" },
    { path: "/c.mp3", name: "C" },
    { path: "/d.mp3", name: "D" },
  ];

  beforeEach(() => clearToasts());
  afterEach(() => clearToasts());

  it("移除后 toast 出现（带撤销 action、5s 窗口）；点撤销 → 歌曲回到原位", () => {
    state.songs = [...SONGS];
    state.currentIndex = 1;
    removeFromQueue(1); // 移除 B（当前歌）→ 切到 C
    expect(state.songs.map((s) => s.name)).toEqual(["A", "C", "D"]);
    expect(state.currentIndex).toBe(1);
    const { items } = useToast();
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain("B");
    expect(items[0].duration).toBe(5000);
    expect(items[0].action.label).toBe("撤销");
    items[0].action.onClick();
    expect(state.songs.map((s) => s.name)).toEqual(["A", "B", "C", "D"]);
    expect(state.currentIndex).toBe(2); // C 仍是当前歌（索引顺延）
  });

  it("多首依次移除：各自独立 toast、各自原位撤销", () => {
    state.songs = [...SONGS];
    state.currentIndex = 0;
    removeFromQueue(1); // 移除 B → [A,C,D]
    removeFromQueue(2); // 移除 D → [A,C]
    const { items } = useToast();
    expect(items).toHaveLength(2);
    items[1].action.onClick(); // 撤销 D（原 index 2）→ [A,C,D]
    expect(state.songs.map((s) => s.name)).toEqual(["A", "C", "D"]);
    items[0].action.onClick(); // 撤销 B（原 index 1）→ [A,B,C,D]
    expect(state.songs.map((s) => s.name)).toEqual(["A", "B", "C", "D"]);
  });

  it("原 index 越界（期间又移除其他歌）→ clamp 到末尾，不丢歌", () => {
    state.songs = [...SONGS];
    state.currentIndex = 3;
    removeFromQueue(3); // 移除 D → [A,B,C]
    removeFromQueue(1); // 移除 B → [A,C]
    const { items } = useToast();
    items[1].action.onClick(); // 撤销 B（index 1）→ [A,B,C]
    expect(state.songs.map((s) => s.name)).toEqual(["A", "B", "C"]);
    items[0].action.onClick(); // 撤销 D（原 index 3 越界）→ clamp 到末尾
    expect(state.songs.map((s) => s.name)).toEqual(["A", "B", "C", "D"]);
  });

  it("撤销成功后弹出「已恢复」提示", () => {
    state.songs = [...SONGS];
    state.currentIndex = 0;
    removeFromQueue(0);
    const { items } = useToast();
    items[0].action.onClick();
    const after = useToast().items;
    expect(after).toHaveLength(2); // 移除 toast + 已恢复 toast
    expect(after[1].text).toContain("已恢复");
  });
});

describe("歌单", () => {
  it("loadPlaylists 拉取歌单列表；激活的歌单被删则退回全部歌曲", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          playlists: [{ id: "p1", name: "日语", songPaths: ["/a.mp3"] }],
        }),
      })),
    );
    state.activePlaylistId = "p1";
    await loadPlaylists();
    expect(state.playlists).toHaveLength(1);
    expect(state.playlists[0].name).toBe("日语");
    expect(state.activePlaylistId).toBe("p1");
    // 歌单没了 → 退回全部歌曲（歌单列表有 60s 声明式缓存，先失效再拉取）
    await invalidate("/api/playlists");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ playlists: [] }) })),
    );
    await loadPlaylists();
    expect(state.activePlaylistId).toBeNull();
  });

  it("createPlaylist 创建并加入列表；空名报错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ id: "p9", name: "新歌单", songPaths: [] }),
      })),
    );
    const p = await createPlaylist("新歌单");
    expect(state.playlists).toContainEqual(p);
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists",
      expect.objectContaining({ method: "POST" }),
    );
    // 后端拒绝
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ detail: "歌单名称不能为空" }),
      })),
    );
    await expect(createPlaylist("")).rejects.toThrow("歌单名称不能为空");
  });

  it("renamePlaylist 乐观改名；失败回滚", async () => {
    state.playlists = [{ id: "p1", name: "旧名", songPaths: [] }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await renamePlaylist("p1", "新名");
    expect(state.playlists[0].name).toBe("新名");
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists/p1",
      expect.objectContaining({ method: "PATCH" }),
    );
    // 失败回滚
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(renamePlaylist("p1", "再改")).rejects.toThrow("改名失败");
    expect(state.playlists[0].name).toBe("新名");
  });

  it("deletePlaylist 删除并退回全部歌曲；失败回滚", async () => {
    state.playlists = [
      { id: "p1", name: "A", songPaths: [] },
      { id: "p2", name: "B", songPaths: [] },
    ];
    state.activePlaylistId = "p1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await deletePlaylist("p1");
    expect(state.playlists.map((p) => p.id)).toEqual(["p2"]);
    expect(state.activePlaylistId).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists/p1",
      expect.objectContaining({ method: "DELETE" }),
    );
    // 失败回滚
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(deletePlaylist("p2")).rejects.toThrow("删除失败");
    expect(state.playlists.map((p) => p.id)).toEqual(["p2"]);
  });

  it("addToPlaylist 加歌（去重）并 POST 后端", async () => {
    state.playlists = [{ id: "p1", name: "A", songPaths: [] }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await addToPlaylist("p1", "/a.mp3");
    expect(isInPlaylist("p1", "/a.mp3")).toBe(true);
    // 已在歌单 → 不发请求（去重）
    const before = fetch.mock.calls.length;
    await addToPlaylist("p1", "/a.mp3");
    expect(fetch.mock.calls.length).toBe(before);
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists/p1/songs",
      expect.objectContaining({ method: "POST" }),
    );
    // 失败回滚
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(addToPlaylist("p1", "/b.mp3")).rejects.toThrow("加入歌单失败");
    expect(isInPlaylist("p1", "/b.mp3")).toBe(false);
  });

  it("removeFromPlaylist 移出并 DELETE（path 编码）；失败回滚", async () => {
    state.playlists = [{ id: "p1", name: "A", songPaths: ["/a.mp3"] }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await removeFromPlaylist("p1", "/a.mp3");
    expect(isInPlaylist("p1", "/a.mp3")).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists/p1/songs/" + encodeURIComponent("/a.mp3"),
      expect.objectContaining({ method: "DELETE" }),
    );
    // 失败回滚
    state.playlists[0].songPaths = ["/b.mp3"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(removeFromPlaylist("p1", "/b.mp3")).rejects.toThrow("移出歌单失败");
    expect(isInPlaylist("p1", "/b.mp3")).toBe(true);
  });

  it("removeFromPlaylist 移除成功弹 toast（带撤销）；点撤销 → POST 加回歌单末尾", async () => {
    state.playlists = [{ id: "p1", name: "旅行", songPaths: ["/a.mp3"] }];
    state.songs = [{ path: "/a.mp3", name: "A歌" }];
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    clearToasts();
    await removeFromPlaylist("p1", "/a.mp3");
    expect(isInPlaylist("p1", "/a.mp3")).toBe(false);
    const { items } = useToast();
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain("A歌");
    expect(items[0].duration).toBe(5000);
    expect(items[0].action).toBeTruthy();
    // 点撤销 → POST /api/playlists/p1/songs 加回
    items[0].action.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(isInPlaylist("p1", "/a.mp3")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/playlists/p1/songs",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "/a.mp3" }) }),
    );
    clearToasts();
  });

  it("setPlaylistOrder 提交新顺序；失败回滚", async () => {
    state.playlists = [{ id: "p1", name: "A", songPaths: ["/a.mp3", "/b.mp3"] }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await setPlaylistOrder("p1", ["/b.mp3", "/a.mp3"]);
    expect(state.playlists[0].songPaths).toEqual(["/b.mp3", "/a.mp3"]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists/p1/order",
      expect.objectContaining({ method: "PUT" }),
    );
    // 失败回滚
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(setPlaylistOrder("p1", ["/a.mp3"])).rejects.toThrow("排序保存失败");
    expect(state.playlists[0].songPaths).toEqual(["/b.mp3", "/a.mp3"]);
  });
});

describe("队列拖拽排序 reorderQueue / persistQueueOrder（任务 A 第三项）", () => {
  const Q = [
    { id: "a", name: "A歌", path: "/a.mp3" },
    { id: "b", name: "B歌", path: "/b.mp3" },
    { id: "c", name: "C歌", path: "/c.mp3" },
    { id: "d", name: "D歌", path: "/d.mp3" },
  ];

  it("reorderQueue：把 from 位置的歌挪到 to（当前歌在移动歌之后 → 索引前移）", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 2; // 播 C
    reorderQueue(0, 2); // A 挪到 C 之后
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "C歌", "A歌", "D歌"]);
    expect(state.currentIndex).toBe(1); // C 2 → 1
  });

  it("reorderQueue：移动的就是当前歌 → 当前索引跟随新位置", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 1;
    reorderQueue(1, 0); // B 挪到开头
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "A歌", "C歌", "D歌"]);
    expect(state.currentIndex).toBe(0);
  });

  it("reorderQueue：向后挪且跨过当前歌 → 当前索引前移", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 2; // C
    reorderQueue(0, 3); // A 挪到末尾（跨过 C）
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "C歌", "D歌", "A歌"]);
    expect(state.currentIndex).toBe(1);
  });

  it("reorderQueue：向前挪且跨过当前歌 → 当前索引后移", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 1; // B
    reorderQueue(3, 0); // D 挪到开头（跨过 B）
    expect(state.songs.map((s) => s.name)).toEqual(["D歌", "A歌", "B歌", "C歌"]);
    expect(state.currentIndex).toBe(2);
  });

  it("reorderQueue：越界 / 相同位置 → 无操作", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 0;
    reorderQueue(0, 0);
    reorderQueue(-1, 2);
    reorderQueue(0, 99);
    reorderQueue(99, 0);
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌", "C歌", "D歌"]);
    expect(state.currentIndex).toBe(0);
  });

  it("reorderQueue：shuffle 模式下不冲突（洗牌队列失效，下次自动重建，不崩）", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 0;
    cyclePlayMode(); // order → shuffle
    expect(state.playMode).toBe("shuffle");
    reorderQueue(0, 2);
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "C歌", "A歌", "D歌"]);
    // 洗牌队列已失效：切歌仍能正常推进（内部 ensureShuffleQueue 重建）
    expect(() => nextSong()).not.toThrow();
  });

  it("persistQueueOrder：PUT /api/queue/order 保存顺序键数组（网络歌用 stream: 前缀）", async () => {
    state.songs = [
      { id: "a", name: "A歌", path: "/a.mp3" },
      { id: "s", name: "网歌", type: "stream", streamId: "9", path: null },
      { id: "b", name: "B歌", path: "/b.mp3" },
    ];
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await persistQueueOrder();
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/queue/order"));
    expect(call).toBeTruthy();
    expect(call[1].method).toBe("PUT");
    expect(JSON.parse(call[1].body).paths).toEqual(["/a.mp3", "stream:9", "/b.mp3"]);
  });

  it("persistQueueOrder：非 200 → 抛错（调用方 toast）", async () => {
    state.songs = [{ id: "a", name: "A歌", path: "/a.mp3" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await expect(persistQueueOrder()).rejects.toThrow();
  });

  it("loadQueueOrder + loadSongs：刷新后按保存顺序恢复（round-trip）", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/api/queue/order")) {
        return { ok: true, json: async () => ({ paths: ["/c.mp3", "/a.mp3", "/b.mp3"] }) };
      }
      if (u.includes("/api/songs")) {
        return {
          ok: true,
          json: async () => [
            { id: "a", name: "A歌", path: "/a.mp3" },
            { id: "b", name: "B歌", path: "/b.mp3" },
            { id: "c", name: "C歌", path: "/c.mp3" },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadQueueOrder();
    state.currentIndex = 0;
    state.currentSong = { id: "a", name: "A歌", path: "/a.mp3" };
    await loadSongs();
    expect(state.songs.map((s) => s.name)).toEqual(["C歌", "A歌", "B歌"]);
    expect(state.currentIndex).toBe(1); // A 现在在位置 1
    expect(state.currentSong.name).toBe("A歌");
  });

  it("loadSongs：保存顺序与曲库无交集（换库/清库）→ 保持默认顺序", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/api/queue/order")) {
        return { ok: true, json: async () => ({ paths: ["/old1.mp3", "/old2.mp3"] }) };
      }
      if (u.includes("/api/songs")) {
        return {
          ok: true,
          json: async () => [
            { id: "a", name: "A歌", path: "/a.mp3" },
            { id: "b", name: "B歌", path: "/b.mp3" },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadQueueOrder();
    state.currentIndex = 0;
    state.currentSong = { id: "a", name: "A歌", path: "/a.mp3" };
    await loadSongs();
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌"]);
    expect(state.currentIndex).toBe(0);
  });

  it("loadSongs：新歌（保存顺序之外）按曲库顺序补在末尾", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/api/queue/order")) {
        return { ok: true, json: async () => ({ paths: ["/b.mp3"] }) };
      }
      if (u.includes("/api/songs")) {
        return {
          ok: true,
          json: async () => [
            { id: "a", name: "A歌", path: "/a.mp3" },
            { id: "b", name: "B歌", path: "/b.mp3" },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadQueueOrder();
    state.currentIndex = 0;
    state.currentSong = { id: "a", name: "A歌", path: "/a.mp3" };
    await loadSongs();
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "A歌"]);
  });

  it("loadSongs：未加载过队列顺序（queueOrder 为 null）→ 不重排", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/api/songs")) {
        return {
          ok: true,
          json: async () => [
            { id: "a", name: "A歌", path: "/a.mp3" },
            { id: "b", name: "B歌", path: "/b.mp3" },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    state.currentIndex = 0;
    state.currentSong = { id: "a", name: "A歌", path: "/a.mp3" };
    await loadSongs();
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌"]);
  });
});
