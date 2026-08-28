// 跟唱/AB 循环（KaraokePanel.vue / ControlBar.vue 共用）
export default {
  karaoke: {
    abWaitEnd: "AB 循环：起点第 {n} 句，请点击歌词选终点（单击退出）",
    abSet: "AB 循环：第 {a} ~ {b} 句（单击退出）",
    abHint: "单击：单句循环；长按：AB 区间循环（需开启跟唱）",
    // KaraokePanel 面板文案（追加，勿动上方 ControlBar 用 key）
    title: "逐句练习",
    expandLib: "展开音乐库 / 播放列表",
    abProgress: "第 {pos}/{total} 句",
    emptyTitle: "这首歌没有歌词文件",
    emptySub: "可放置同名 .srt / .lrc，或在线搜索 / 上传指定",
    abHintIdle: "点击句子播放 · 播完自动停",
    abHintWaitEnd: "AB 循环：起点第 {n} 句，请点击终点句",
    abHintSet: "AB 循环：第 {a} ~ {b} 句 · 单击退出",
  },
};
