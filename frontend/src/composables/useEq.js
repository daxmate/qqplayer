import { playbackSettings, applyEqToGraph } from "./playerCore.js";

// ============ 均衡器（Web Audio API）============
// 10 段经典频点（foobar2000/网易云同款），±12dB
// 技术要点：createMediaElementSource 一个 audio 元素只能接管一次，
// 所以音频图常驻（首次播放懒创建），开关关闭 = 增益全 0（0dB peaking 近似直通），不做动态路由切换。
// 音频图生命周期（ensureAudioGraph/applyEqToGraph/eqFilters）在 playerCore.js（audio 强耦合）。
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS = {
  flat: { labelKey: "eq.preset.flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  pop: { labelKey: "eq.preset.pop", gains: [-1, 0, 1.5, 2.5, 3, 2.5, 1.5, 0, -0.5, -1] },
  rock: { labelKey: "eq.preset.rock", gains: [4, 3, 1.5, 0, -1, 0, 1.5, 3, 3.5, 4] },
  jazz: { labelKey: "eq.preset.jazz", gains: [3, 2, 1, 1, -0.5, -1, 0, 1, 2, 3] },
  classical: { labelKey: "eq.preset.classical", gains: [3, 2, 1, -0.5, -1, -1, -0.5, 1, 2, 3] },
  bass: { labelKey: "eq.preset.bass", gains: [6, 4.5, 3, 1.5, 0, 0, 0, 0, 0, 0] },
  vocal: { labelKey: "eq.preset.vocal", gains: [-1.5, -1, 0, 1, 2.5, 3.5, 3, 1.5, 0, -1] },
  custom: { labelKey: "eq.preset.custom", gains: null }, // gains 由 eqGains 决定
};

// 应用预设（值同步进 eqGains，作为切回自定义的基点）
export function setEqPreset(key) {
  const preset = EQ_PRESETS[key];
  if (!preset) return;
  playbackSettings.eqPreset = key;
  if (preset.gains) playbackSettings.eqGains = [...preset.gains];
  applyEqToGraph(); // 同步应用（watch 兜底开关路径，这里保证即时生效）
}

// 调整自定义增益（拖滑杆）：自动切到自定义预设
export function setEqGain(index, v) {
  if (index < 0 || index >= EQ_BANDS.length) return;
  const g = Math.min(12, Math.max(-12, Number(v) || 0));
  playbackSettings.eqGains[index] = g;
  playbackSettings.eqPreset = "custom";
  applyEqToGraph(); // 同步应用（拖滑杆实时生效）
}

// eqPreset 非法值回落 flat（由 playerCore 在播放设置加载后调用；EQ_PRESETS 定义后执行）
export function _normalizeEqPreset() {
  if (!(playbackSettings.eqPreset in EQ_PRESETS)) playbackSettings.eqPreset = "flat";
}
