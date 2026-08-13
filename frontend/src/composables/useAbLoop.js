import { state, audio } from "./playerCore.js";
import {
  currentLineIndex,
  playLine,
  jumpToLine,
  karaokeState,
  lineItems,
  lyricTime,
  locateLine,
} from "./useLyric.js";

// ============ 跟唱开关 ============
export function toggleKaraoke() {
  state.karaokeOn = !state.karaokeOn;
}

export function toggleKaraokeLoop() {
  state.karaokeLoop = !state.karaokeLoop;
}

// ============ AB 区间循环（长按循环按钮进入，单击退出）============
// 进入：当前句为起点 A，等待点击另一句作为终点 B
// 循环：A→B 区间句子连播，播到 B 句尾自动跳回 A 句首

export function enterAbLoop() {
  if (state.abLoop) return; // 已在 AB 循环中，忽略
  const cur = currentLineIndex.value;
  if (cur < 0) return; // 无当前句（前奏/间隙）→ 忽略
  state.abLoop = { a: cur, b: null }; // b=null 等待选终点
  // 不重播当前句：AB 循环设定过程不影响当前播放
}

export function setAbEnd(lineIndex) {
  if (!state.abLoop) return;
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  if (lineIndex === state.abLoop.a) return; // 点起点本身 → 忽略
  let a = state.abLoop.a;
  let b = lineIndex;
  if (b < a) [a, b] = [b, a]; // 终点在起点前 → 自动交换
  state.abLoop = { a, b };
  // 不跳回区间起点重播：AB 循环设定过程不影响当前播放
}

export function exitAbLoop() {
  state.abLoop = null;
}

// 歌词点击统一入口（跟唱面板）
// 无 AB → 直接播放该句；等选终点（b=null）→ 点击设为终点；
// 区间内 → 跳到该句播放（区间不变）；区间外 → 退出 AB 循环并播放该句
// （2026-08-12 用户拍板：区间外点击 = 退出 AB + 播放当前句；区间内 = 跳转播放）
export function clickLine(lineIndex) {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const ab = state.abLoop;
  if (!ab) {
    playLine(lineIndex);
    return;
  }
  if (ab.b === null) {
    setAbEnd(lineIndex); // 等选终点：点击 = 设置终点
    return;
  }
  if (lineIndex < ab.a || lineIndex > ab.b) {
    // 区间外：退出 AB 循环，恢复正常跟唱并播放该句
    state.abLoop = null;
    playLine(lineIndex);
    return;
  }
  // 区间内：跳到该句句首播放，AB 区间保持不变
  playLine(lineIndex);
}

// ============ 跟唱模式句末处理（playerCore 的 audio timeupdate 回调调用）============
// 每句播完自动停（锚点方案）+ AB 区间循环 + 单句循环
export function handleKaraokeTick(t) {
  if (state.mode !== "karaoke" || !state.karaokeOn) return;
  const lines = lineItems.value;
  if (!lines.length) return;
  const lt = lyricTime(t);
  // 锚点失效（前奏/间隙未锚定，或 seek/回退到锚点句之前）→ 重新定位
  if (karaokeState.line < 0 || lt < lines[karaokeState.line].s) {
    karaokeState.line = locateLine(t);
  }
  if (karaokeState.line >= 0 && lt >= lines[karaokeState.line].e) {
    // 循环处理句末：一次跳变可能跨多个短句，逐句推进直到落在句内或触发跳转（guard 防死循环）
    let guard = 0;
    while (karaokeState.line >= 0 && lt >= lines[karaokeState.line].e && guard++ < 20) {
      const ab = state.abLoop;
      if (ab && karaokeState.line >= ab.a) {
        if (ab.b !== null && karaokeState.line === ab.b) {
          // AB 终点句播完 → 跳回起点句首重播
          jumpToLine(ab.a, true);
          break;
        }
        if (ab.b === null || karaokeState.line < ab.b) {
          if (ab.b === null) {
            // 等选终点：起点句循环
            jumpToLine(ab.a, true);
            break;
          }
          // 起点/区间中间句播完 → 锚点推进下一句，继续播放
          karaokeState.line += 1;
          continue;
        }
        // seek 跳出区间到终点之后：按单句循环/暂停处理
      }
      if (state.karaokeLoop) {
        // 单句循环：回到句首重播（不暂停）
        jumpToLine(karaokeState.line, true);
      } else {
        // 句末回句首暂停：指针回到本句开始时间戳，方便反复跟唱本句
        jumpToLine(karaokeState.line, false);
        audio.pause();
      }
      break;
    }
  }
}
