// 设置分类导航（SettingsModal 与移动端设置区侧边抽屉共用，避免双份维护）
// 分类顺序 = 使用频度（界面/歌词/播放靠前，关于殿后）；iOS 壳（发起方）隐藏配对管理，
// 由桌面壳管理配对（与 SettingsModal 原逻辑一致）。
//
// 注意：导出为「函数」而非模块级 computed —— isPairingEnabled() 读取 window.qqplayerIosBridge
// 是非响应式的，模块级 computed 首次求值即缓存，后续壳环境切换（测试/壳初始化）拿不到最新值；
// 由各组件在 setup 里包一层 computed（每次实例创建时求值），与 SettingsModal 原实现语义一致。
import type { Component } from "vue";
import {
  LayoutGrid,
  Music2,
  ListMusic,
  FolderOpen,
  Tags,
  Download,
  RefreshCw,
  Video,
  Keyboard,
  Smartphone,
  Info,
} from "@lucide/vue";
import { isPairingEnabled } from "./usePairingConfirm.js";

/** 设置分类条目（key 为设置面板路由标识；icon 为 lucide 图标组件） */
interface SettingsCategory {
  key: string;
  labelKey: string;
  icon: Component;
}

export function getSettingsCategories(): SettingsCategory[] {
  const list: SettingsCategory[] = [
    { key: "ui", labelKey: "settings.category.ui", icon: LayoutGrid },
    { key: "lyric", labelKey: "settings.category.lyric", icon: Music2 },
    { key: "playback", labelKey: "settings.category.playback", icon: ListMusic },
    { key: "library", labelKey: "settings.category.library", icon: FolderOpen },
    { key: "scrape", labelKey: "settings.category.scrape", icon: Tags },
    { key: "download", labelKey: "settings.category.download", icon: Download },
    { key: "sync", labelKey: "settings.category.sync", icon: RefreshCw },
    { key: "video", labelKey: "settings.category.video", icon: Video },
    { key: "shortcuts", labelKey: "settings.category.shortcuts", icon: Keyboard },
    { key: "pairing", labelKey: "settings.category.pairing", icon: Smartphone },
    { key: "about", labelKey: "settings.category.about", icon: Info },
  ];
  return isPairingEnabled() ? list : list.filter((c) => c.key !== "pairing");
}
