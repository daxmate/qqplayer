// 封面显示守卫（跨端共享语义化入口）
//
// 背景（P2-A 审计）：封面显示判断（「显示封面」showCover /「列表封面」showListCover）
// 在桌面/移动端多处手写 v-if，各写各的。这里收敛为单一语义化入口：
// 调用方只表达「哪个区域的封面」（zone），设置字段映射集中在 zoneMap 一处——
// 将来改字段名 / 新增区域只动这里，调用点零改动。
//
// 设计约束（P2-A 已定案）：
//   - 纯函数：只封装「设置开关 → 是否显示封面图」的判断，不混入交互态
//     （如 useCoverSize 的 dragging —— 调用方在判断后自行叠加，行为零变化）
//   - 环境适配 / 拖拽机制（SortableJS vs useShellDrag）不在此层
//   - 设置注册表（settingsIndex.ts / SettingsModal 的 entry id）不经过这里，
//     那是「设置项建模」，不是「显示守卫」
import { uiSettings } from "./useSettings.js";

/** 封面区域（语义化）：large = 大封面（播放器主区/移动端播放页），list = 列表封面（列表行/卡片缩略图） */
export type CoverZone = "large" | "list";

/** zone → uiSettings 设置字段的唯一映射处（改字段名 / 新增区域只动这里） */
export const zoneMap: Record<CoverZone, "showCover" | "showListCover"> = {
  large: "showCover",
  list: "showListCover",
};

/**
 * 封面显示守卫：该区域的封面图是否显示（纯设置开关判断，无副作用）。
 * @example coverVisible("large") 等价于原 `uiSettings.showCover`
 */
export function coverVisible(zone: CoverZone): boolean {
  return !!uiSettings[zoneMap[zone]];
}
