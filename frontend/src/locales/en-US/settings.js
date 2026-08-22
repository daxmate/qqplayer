// 设置模块（英文包；其余命名空间回退 zh-CN fallbackLocale）
export default {
  settings: {
    cookiesFromBrowser: "Cookie source browser",
    cookiesFromBrowserDesc:
      "Read login cookies from the selected browser for online video (yt-dlp --cookies-from-browser)",
    cookiesFromBrowserNone: "None",
    amllBlur: "AMLL Blur Effect",
    amllBlurDesc:
      "WebGL Gaussian blur on lyric lines (most performance-heavy; off by default in browser)",
    amllSpring: "AMLL Spring Animation",
    amllSpringDesc: "Spring physics for lyric scrolling (needs a strong machine)",
    amllScale: "AMLL Scale Effect",
    amllScaleDesc: "Scale-up animation for the active line (amll engine only)",
    amllEffects: "AMLL Effects",
    amllPerfHint:
      "These three AMLL effects are performance-heavy; turning them off can significantly reduce CPU usage (especially in the browser).",
    // Sync (iOS shell)
    sync: "Sync",
    syncNow: "Sync Now",
    syncNowDesc: "Pull the latest manifest from the desktop and cache library metadata",
    syncing: "Syncing…",
    syncLastTime: "Last sync",
    syncLastTimeNever: "Not synced yet",
    syncPending: "Pending downloads",
    syncProgress: "Download progress",
    syncFailed: "Sync failed: {msg}",
    syncMobileOnly: "Mobile only",
    syncMobileOnlyDesc:
      "Sync and offline asset downloads require the iOS shell (QQPlayer companion)",
  },
};
