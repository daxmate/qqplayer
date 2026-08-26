// 桌面外壳（App.vue / ActivityBar.vue / Cover.vue）
export default {
  app: {
    // 模式切换
    mode: {
      continuous: "音乐",
      karaoke: "跟唱",
      books: "图书",
      videos: "视频",
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
    // 数据层（apiClient 离线降级 / 配对失效提示）
    offlineMode: "离线模式 · 播放已缓存内容",
    backOnline: "已恢复在线",
    repairRequired: "连接已失效，请重新配对",
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
  // 壳内配对确认（usePairingConfirm.js / PairingConfirmModal.vue）：桌面壳轮询到新配对请求时弹确认框
  pairing: {
    confirmTitle: "配对确认",
    confirmText: "「{name}」请求与此设备配对",
    deviceName: "设备名称",
    deviceType: "设备类型",
    requestTime: "请求时间",
    approve: "批准配对",
    reject: "拒绝",
    processing: "处理中…",
    approved: "配对成功",
    rejected: "已拒绝该设备的配对请求",
    actionFailed: "操作失败，请重试",
    deviceUnknown: "未知设备",
    // 设置页配对管理（SettingsModal → PairingSettings.vue）
    tabTitle: "配对",
    devices: "已配对设备",
    pendingRequests: "待确认请求",
    emptyDevices: "暂无配对设备",
    emptyDevicesDesc: "在 iPhone/iPad 上打开 QQPlayer，进入「设置 → 配对」发起请求，即可在此管理。",
    emptyPending: "暂无待确认请求",
    pairedAt: "配对于 {time}",
    lastActive: "最后活跃 {time}",
    yesterday: "昨天",
    loading: "加载中…",
    loadFailed: "加载失败，请重试",
    delete: "删除",
    editNote: "备注",
    notePlaceholder: "给这台设备加个备注",
    confirmDeleteTitle: "撤销配对",
    confirmDelete: "确定撤销与「{name}」的配对？",
    noteSaved: "备注已保存",
    deleted: "已撤销配对",
    // iOS 壳未连接引导页（NoConnectionView.vue）：壳内无 server 时全屏覆盖
    unpaired: {
      title: "未连接桌面端",
      desc: "连接桌面端 QQPlayer 后，即可同步音乐、歌词与阅读进度",
      pairNow: "去配对",
      manualHint: "若自动发现失败，可在配对页手动输入 IP",
      localOk: "本机内容不受影响",
    },
  },
};
