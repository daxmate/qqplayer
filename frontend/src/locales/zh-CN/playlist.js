// 播放列表（Playlist.vue）
export default {
  playlist: {
    // 头部
    rescan: "重新扫描",
    title: {
      queue: "播放列表",
      playlist: "歌单",
    },
    // 浏览 tab
    browse: {
      allSongs: "全部歌曲",
      artists: "歌手",
      albums: "专辑",
    },
    // 分组返回条
    back: "全部",
    backTitle: "返回全部",
    songsCount: "{n} 首",
    // 搜索占位
    searchPlaceholder: {
      artist: "搜索歌手",
      album: "搜索专辑",
      song: "搜索歌名 / 歌手",
    },
    // 排序
    sort: {
      title: "排序方式",
      default: "默认顺序",
      name: "按标题",
      artist: "按歌手",
      duration: "按时长",
    },
    // 收藏
    fav: {
      only: "只看收藏",
      all: "显示全部",
      faved: "已收藏",
      add: "收藏",
      remove: "取消收藏",
      batchAdded: "已收藏 {n} 首",
    },
    // 右键菜单（桌面）
    ctx: {
      play: "播放",
      playNext: "下一首播放",
      fav: "收藏",
      unfav: "取消收藏",
      addToPlaylist: "加歌单",
      goArtist: "进歌手",
      goAlbum: "进专辑",
      deleteToTrash: "移到废纸篓",
    },
    // 多选批量（桌面）
    multi: {
      selected: "{n} 首已选",
      fav: "批量收藏",
      addToPlaylist: "批量加歌单",
      deleteToTrash: "批量移到废纸篓",
      clear: "清空选择",
    },
    // 移到废纸篓
    deleteToTrash: {
      title: "移到废纸篓",
      confirm: "将删除 {n} 首歌及其磁盘文件，可到废纸篓恢复",
      deleted: "已删除 {n} 首",
      missing: "{n} 首不在曲库",
      failed: "{n} 首删除失败",
    },
    // 未知兜底 / 列表省略
    unknownArtist: "未知歌手",
    unknownAlbum: "未知专辑",
    etc: " 等",
    // 行操作
    dragSort: "拖拽排序",
    hasLyric: "有歌词",
    playing: "播放中",
    // 定位当前播放（工具条按钮 / EQ 标记）
    locate: {
      title: "定位当前播放",
      notVisible: "当前播放歌曲不在此列表",
    },
    removeFromPlaylist: "从歌单移除",
    removeFromQueue: "从队列移除",
    removedFromPlaylist: "已从歌单移除《{name}》",
    restoredToPlaylist: "已恢复《{name}》到歌单末尾",
    // 空态
    empty: {
      scanning: "扫描中…",
      noMatch: "没有匹配的歌曲",
      noMatchArtist: "没有匹配的歌手",
      noMatchAlbum: "没有匹配的专辑",
      noFav: "没有收藏的歌曲",
      noGroupSongs: "该分组没有歌曲",
      emptyPlaylist: "歌单是空的，点击行上的 ＋ 加歌",
      noSongs: "没有歌曲，请设置歌曲库",
    },
    // 加歌浮层
    addMenu: {
      title: "加入歌单",
      noPlaylists: "还没有歌单，点左侧「新建歌单」",
    },
  },
};
