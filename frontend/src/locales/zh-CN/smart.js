// 智能视图（useSmartViews 视图定义 + SmartViewPanel/MobileSmartList 组件文案 + 副信息格式化）
export default {
  smart: {
    recentAdded: {
      title: "最近添加",
      empty: "暂无歌曲",
    },
    recentPlayed: {
      title: "最近播放",
      empty: "暂无播放记录",
    },
    topPlayed: {
      title: "常听排行",
      empty: "暂无播放记录",
    },
    playedTimes: "播放 {n} 次",
    seconds: "{n} 秒",
    minutes: "{n} 分钟",
    hours: "{n} 小时",
    back: "返回",
    loading: "加载中…",
    playing: "播放中",
    count: "{n} 首",
    // 年代视图（useSmartViews DECADE_BUCKETS；侧边栏入口 + 面板标题/空态）
    decades: {
      title: "年代",
      empty: "该年代暂无歌曲，可用刮削补充年份",
    },
    decadeEarly: "50年代及更早",
    decadeLabel: "{n}0年代",
    decade2000s: "00年代",
    decade2010s: "10年代",
    decade2020s: "20年代",
    decadeUnknown: "未知年代",
  },
};
