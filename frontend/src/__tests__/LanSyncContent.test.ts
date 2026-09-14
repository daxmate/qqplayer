// 局域网同步内容选择 / 运行状态的纯逻辑单测（lanSyncContent.ts）
// 覆盖：来源目录顺序与计数 / 来源内顺序（不重排）/ 搜索只过滤 / 分页 / 选择集载荷 /
//       推送·拉取状态字典归一（两套键名）/ 失败原因 i18n 映射 / 进度与字节格式化
import { describe, it, expect } from "vitest";
import {
  buildSourceCatalog,
  canSubmitSelection,
  emptyFacts,
  failureLabelKey,
  filterTracks,
  formatBytes,
  isTerminalState,
  localSongs,
  normalizeRunStatus,
  paginate,
  runPercent,
  selectionPayload,
  sourceLabelKey,
  sourceTracks,
  SOURCE_FAVORITES,
  SOURCE_LIBRARY,
  SMART_SOURCES,
  songsByPath,
  type LocalContentFacts,
} from "../composables/lanSyncContent.js";
import type { Playlist, Song } from "../composables/playerState.js";

const song = (path: string, name: string, extra: Partial<Song> = {}): Song => ({
  path,
  name,
  artist: `${name}-artist`,
  album: `${name}-album`,
  ...extra,
});

// 曲库顺序故意与收藏 / 歌单 / mtime 顺序都不同，用来证明「来源内顺序 = 来源自身顺序」
const SONGS: Song[] = [
  song("/lib/03.mp3", "Golf", { mtime: 300 }),
  song("/lib/01.mp3", "Echo", { mtime: 100 }),
  song("/lib/02.mp3", "Delta", { mtime: 200 }),
  { path: null, name: "网络歌", type: "stream", streamId: "s1" },
];

const PLAYLISTS: Playlist[] = [
  { id: "road", name: "Road Trip", songPaths: ["/lib/02.mp3", "/lib/01.mp3"] },
  { id: "@legacy", name: "非法标识", songPaths: ["/lib/03.mp3"] },
  { id: "empty", name: "空的", songPaths: ["/lib/不存在.mp3"] },
];

const FACTS: LocalContentFacts = {
  songs: SONGS,
  favorites: ["/lib/01.mp3", "/lib/03.mp3"],
  playlists: PLAYLISTS,
  smartTracks: {
    [SMART_SOURCES[0]]: [SONGS[2], SONGS[0]],
    [SMART_SOURCES[1]]: [SONGS[1]],
    [SMART_SOURCES[2]]: [SONGS[0], SONGS[1], SONGS[2]],
  },
};

describe("lanSyncContent 来源目录", () => {
  it("顺序冻结：全部曲库 → 收藏 → 真实歌单 → 自动歌单；跳过 @ 开头的非法歌单标识", () => {
    const rows = buildSourceCatalog(FACTS);
    expect(rows.map((r) => r.id)).toEqual([
      SOURCE_LIBRARY,
      SOURCE_FAVORITES,
      "road",
      "empty",
      ...SMART_SOURCES,
    ]);
    expect(rows.filter((r) => r.smart).map((r) => r.id)).toEqual([...SMART_SOURCES]);
  });

  it("计数口径：不含网络歌、不含不在库内的成员", () => {
    const rows = buildSourceCatalog(FACTS);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(SOURCE_LIBRARY)?.trackCount).toBe(3); // 网络歌不算
    expect(byId.get(SOURCE_FAVORITES)?.trackCount).toBe(2);
    expect(byId.get("road")?.trackCount).toBe(2);
    expect(byId.get("empty")?.trackCount).toBe(0);
    expect(byId.get(SMART_SOURCES[2])?.trackCount).toBe(3);
  });

  it("空事实：只有全部曲库 + 收藏 + 三个自动歌单行，计数全 0", () => {
    const rows = buildSourceCatalog(emptyFacts());
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.trackCount === 0)).toBe(true);
  });

  it("来源标识 → i18n key（真实歌单返回 null = 用后端歌单名）", () => {
    expect(sourceLabelKey(SOURCE_LIBRARY)).toBe("lansync.source.library");
    expect(sourceLabelKey(SOURCE_FAVORITES)).toBe("lansync.source.favorites");
    expect(sourceLabelKey(SMART_SOURCES[0])).toBe("lansync.source.recentAdded");
    expect(sourceLabelKey(SMART_SOURCES[2])).toBe("lansync.source.topPlayed");
    expect(sourceLabelKey("road")).toBeNull();
  });
});

describe("lanSyncContent 来源内曲目", () => {
  it("全部曲库 = 后端返回序（不重排），排除网络歌", () => {
    expect(sourceTracks(SOURCE_LIBRARY, FACTS).map((s) => s.name)).toEqual([
      "Golf",
      "Echo",
      "Delta",
    ]);
    expect(localSongs(SONGS)).toHaveLength(3);
  });

  it("收藏 / 歌单 = 成员序（与曲库顺序不同也不重排）", () => {
    expect(sourceTracks(SOURCE_FAVORITES, FACTS).map((s) => s.name)).toEqual(["Echo", "Golf"]);
    expect(sourceTracks("road", FACTS).map((s) => s.name)).toEqual(["Delta", "Echo"]);
  });

  it("自动歌单 = 播放数据序；未知来源 / 未知歌单 → 空表（绝不回落全库）", () => {
    expect(sourceTracks(SMART_SOURCES[0], FACTS).map((s) => s.name)).toEqual(["Delta", "Golf"]);
    expect(sourceTracks("@smart:unknown", FACTS)).toEqual([]);
    expect(sourceTracks("nope", FACTS)).toEqual([]);
    expect(sourceTracks("@legacy", FACTS)).toEqual([]);
  });

  it("搜索只过滤不重排（大小写不敏感，命中曲名 / 歌手 / 专辑）", () => {
    const list = sourceTracks(SMART_SOURCES[2], FACTS);
    expect(filterTracks(list, "golf").map((s) => s.name)).toEqual(["Golf"]);
    expect(filterTracks(list, "ECHO-ARTIST").map((s) => s.name)).toEqual(["Echo"]);
    expect(filterTracks(list, "golf-album").map((s) => s.name)).toEqual(["Golf"]);
    expect(filterTracks(list, "").map((s) => s.name)).toEqual(["Golf", "Echo", "Delta"]);
    expect(filterTracks(list, "zzz")).toEqual([]);
  });

  it("分页：越界 offset 收成合法值，hasMore 正确", () => {
    const items = [1, 2, 3, 4, 5];
    expect(paginate(items, 0, 2)).toMatchObject({ items: [1, 2], hasMore: true, total: 5 });
    expect(paginate(items, 4, 2)).toMatchObject({ items: [5], hasMore: false, total: 5 });
    expect(paginate(items, 99, 2)).toMatchObject({ items: [], hasMore: false, offset: 5 });
    expect(paginate([], 0, 2)).toMatchObject({ items: [], hasMore: false, total: 0 });
  });

  it("songsByPath 跳过网络歌（path=null）", () => {
    const map = songsByPath(SONGS);
    expect(map.size).toBe(3);
    expect([...map.keys()]).toEqual(["/lib/03.mp3", "/lib/01.mp3", "/lib/02.mp3"]);
  });
});

describe("lanSyncContent 选择集载荷", () => {
  it("全库 = ids 空表（= 整个曲库）；选择性集合空 ids = 不选任何文件", () => {
    expect(selectionPayload("all", ["x"], ["y"])).toEqual({ kind: "all", ids: [] });
    expect(selectionPayload("playlists", ["road"], [])).toEqual({
      kind: "playlists",
      ids: ["road"],
    });
    expect(selectionPayload("tracks", [], ["/lib/01.mp3"])).toEqual({
      kind: "tracks",
      ids: ["/lib/01.mp3"],
    });
  });

  it("可提交判定：全库恒可；选择性集合必须至少一项", () => {
    expect(canSubmitSelection({ kind: "all", ids: [] })).toBe(true);
    expect(canSubmitSelection({ kind: "playlists", ids: [] })).toBe(false);
    expect(canSubmitSelection({ kind: "playlists", ids: ["road"] })).toBe(true);
    expect(canSubmitSelection({ kind: "tracks", ids: ["/lib/01.mp3"] })).toBe(true);
    expect(canSubmitSelection(null)).toBe(false);
  });
});

describe("lanSyncContent 运行状态归一", () => {
  it("推送字典：sentBytes/planned|skipped|completed|failedCount", () => {
    const view = normalizeRunStatus("push", {
      run_id: "push-1",
      peer_id: "peer-1",
      state: "pushing",
      selection: { kind: "playlists", ids: ["road"] },
      sentBytes: 512,
      totalBytes: 2048,
      plannedCount: 4,
      skippedCount: 1,
      completedCount: 2,
      failedCount: 1,
      failed: [{ relativePath: "a/b.mp3", reason: "send_failed", detail: "timeout" }],
    });
    expect(view.kind).toBe("push");
    expect(view.runId).toBe("push-1");
    expect(view.counts).toEqual({ planned: 4, completed: 2, skipped: 1, failed: 1 });
    expect(view.transferredBytes).toBe(512);
    expect(view.failures[0]).toEqual({
      path: "a/b.mp3",
      reason: "send_failed",
      detail: "timeout",
    });
    expect(view.selection).toEqual({ kind: "playlists", ids: ["road"] });
    expect(view.terminal).toBe(false);
    expect(runPercent(view)).toBe(25);
  });

  it("拉取字典：receivedBytes/requested|unchanged|completed|failedCount 映射到同一视图", () => {
    const view = normalizeRunStatus("pull", {
      run_id: "pull-1",
      peer_id: "peer-1",
      state: "done",
      requestedCount: 3,
      unchangedCount: 2,
      completedCount: 3,
      failedCount: 0,
      receivedBytes: 100,
      totalBytes: 100,
      failed: [],
    });
    expect(view.counts).toEqual({ planned: 3, completed: 3, skipped: 2, failed: 0 });
    expect(view.terminal).toBe(true);
    expect(view.succeeded).toBe(true);
    expect(runPercent(view)).toBe(100);
  });

  it("失败 / 缺字段容错：非对象、缺计数、怪 failed 一律不崩", () => {
    const view = normalizeRunStatus("push", {
      state: "failed",
      error: "会话已断开",
      failed: [1, {}],
    });
    expect(view.counts).toEqual({ planned: 0, completed: 0, skipped: 0, failed: 0 });
    expect(view.error).toBe("会话已断开");
    expect(view.failures).toEqual([{ path: "", reason: "", detail: "" }]);
    expect(view.succeeded).toBe(false);
    expect(normalizeRunStatus("pull", null).state).toBe("");
  });

  it("终态判定与进度兜底", () => {
    expect(isTerminalState("done")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
    expect(isTerminalState("pushing")).toBe(false);
    expect(runPercent(null)).toBe(0);
    // 总量未知：运行中 0，终态 100
    expect(runPercent(normalizeRunStatus("push", { state: "pushing" }))).toBe(0);
    expect(runPercent(normalizeRunStatus("push", { state: "done" }))).toBe(100);
  });

  it("失败原因 → i18n key（未知原因回落 unknown）", () => {
    expect(failureLabelKey("local_file_unavailable")).toBe(
      "lansync.failure.local_file_unavailable",
    );
    expect(failureLabelKey("send_failed")).toBe("lansync.failure.send_failed");
    expect(failureLabelKey("谁也想不到")).toBe("lansync.failure.unknown");
  });

  it("字节格式化", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB");
  });
});
