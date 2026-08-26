// 播放列表右键菜单 + 批量操作（英文包；其余 playlist key 由 fallbackLocale zh-CN 兜底）
export default {
  playlist: {
    ctx: {
      play: "Play",
      playNext: "Play Next",
      fav: "Favorite",
      unfav: "Unfavorite",
      addToPlaylist: "Add to Playlist",
      goArtist: "Go to Artist",
      goAlbum: "Go to Album",
      editTags: "Edit Tags / Scrape",
      deleteToTrash: "Move to Trash",
    },
    pushToDevice: "Push to Device",
    noDevicesToast: "No paired devices",
    pushSuccess: "Pushed {n} songs",
    pushFailed: "Push failed",
    pushFailedReason: "Push failed: {reason}",
    devicePicker: {
      title: "Select Device",
      confirm: "Push",
      empty: "No paired devices",
    },
    multi: {
      scrape: "Scrape Tags",
      scraping: "Scraping {n}…",
    },
  },
};
