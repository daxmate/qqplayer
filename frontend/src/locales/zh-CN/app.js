// 桌面外壳（App.vue / ActivityBar.vue / Cover.vue）
export default {
  app: {
    // 模式切换
    mode: {
      continuous: "连播",
      karaoke: "跟唱",
      books: "图书",
    },
    // 顶栏按钮
    settings: "设置",
    expandPanels: "展开面板",
    expandControls: "展开控制区",
    // 迷你模式
    miniMode: {
      label: "迷你模式",
      running: "迷你模式（运行中，点击置前）",
      standalone: "迷你模式（独立小窗）",
    },
    // 桌面歌词
    desktopLyric: {
      label: "桌面歌词",
      close: "关闭桌面歌词",
      open: "打开桌面歌词",
    },
    // 无歌词占位
    noLyric: "暂无歌词",
    specifyLyric: "指定歌词",
    coverDragHint: "拖动调整封面/歌词区大小",
    // 封面
    coverAlt: "封面",
    // 活动栏（ActivityBar.vue）
    activityBar: {
      label: "面板切换",
      musicLib: "音乐库",
      playlist: "播放列表",
      expandMusicLib: "展开音乐库",
      collapseMusicLib: "收起音乐库",
      expandPlaylist: "展开播放列表",
      collapsePlaylist: "收起播放列表",
    },
  },
};
