// 设置弹窗全局开关（模块级单例，零依赖）
//
// 独立成模块的原因：playerCore.js（SHORTCUTS 配置表里 openSettings 快捷键 handler）
// 要写 isSettingsOpen，App.vue（齿轮按钮/MobileShell）要读写它——若 playerCore 直接
// import useSettings 或 App 相关模块，会形成循环依赖。抽成零依赖模块后各条 import 链
// 都干净（同 searchState.js 模式，parallel-dev 知识库"watch/顶层求值"坑）。
import { ref } from "vue";

export const isSettingsOpen = ref<boolean>(false);
