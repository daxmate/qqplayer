// search anything 全局开关（模块级单例，零依赖）
//
// 独立成模块的原因：playerCore.js（SHORTCUT_HANDLER 守卫）与 useSearchAnything.js
// 都要读写 isSearchOpen——若 playerCore 直接 import useSearchAnything，会形成
// playerCore → useSearchAnything → usePlayer(barrel) → playerCore 循环依赖，
// 模块求值顺序错乱导致依赖未就绪（实测 settingsIndex 的 EQ_PRESETS undefined）。
// 抽成零依赖模块后两条 import 链都干净（parallel-dev 知识库"watch/顶层求值"坑）。
import { ref } from "vue";

export const isSearchOpen = ref<boolean>(false);
