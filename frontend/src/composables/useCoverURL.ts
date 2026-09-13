// 封面 URL 异步解析 composable
//
// 用法（MobileList / MobileSmartList 共用，避免两处重复）：
//   const { coverSrc, coverOk, markCoverError, resolveCover } = useCoverURL();
//   <img v-if="coverSrc(path) && coverOk(path)" :src="coverSrc(path)"
//        loading="lazy" @error="markCoverError(path)" />
//   watch(可见行, (rows) => rows.forEach((r, i) => resolveCover(r.path, { download: i < N })));
//   watch(() => state.currentSong?.path, (p) => p && resolveCover(p, { download: true }));
//
// 节流取舍：同一 path 解析一次（已解析出 URL 后幂等跳过）；download 选项仅为保持调用方签名。

import { ref, type Ref } from "vue";
import { resolveServerUrl, onOfflineChange } from "../utils/apiClient.js";

/** 列表前 N 行封面后台缓存（行号超出只查不下载） */
export const COVER_CACHE_FIRST_N = 30;

/** useCoverURL() 选项 */
export interface UseCoverURLOptions {
  /** 恢复在线（offline→online）时清空本实例已解析结果/错误标记后触发；
   *  调用方传入「对当前歌曲/可见行重新 resolveCover」的逻辑
   *  （2026-08-27 契约：断网期间解析为空/失败标记的封面恢复后自动补齐，不等切歌）。 */
  onOnlineRefresh?: () => void;
}

/** useCoverURL() 返回结构（每组件实例一份；coverErrors 语义同原组件内实现） */
export interface UseCoverURLReturn {
  coverSrc: (path: string) => string;
  coverOk: (path: string) => boolean;
  markCoverError: (path: string) => void;
  resolveCover: (path: string, opts?: { download?: boolean }) => void;
  dispose: () => void;
}

export function useCoverURL({ onOnlineRefresh }: UseCoverURLOptions = {}): UseCoverURLReturn {
  const coverErrors = ref<Set<string>>(new Set());
  const urlMap = new Map<string, Ref<string>>(); // path → ref(url)；ref 在模板渲染期被读取 → 异步填充后自动重渲染

  function refFor(path: string): Ref<string> {
    let r = urlMap.get(path);
    if (!r) {
      r = ref("");
      urlMap.set(path, r);
    }
    return r;
  }

  /** 远程封面 URL（桌面同源原样返回；iOS 壳转服务器绝对 URL + token） */
  function remoteURL(path: string): string {
    return resolveServerUrl("/api/cover?path=" + encodeURIComponent(path));
  }

  /** 模板绑定值：未解析完成前返回 ""（配合 v-if 隐藏 <img>，避免空 src 闪烁/坏图） */
  function coverSrc(path: string): string {
    if (!path) return "";
    return refFor(path).value;
  }

  /** 封面是否可显示（未被 markCoverError 标记失败） */
  function coverOk(path: string): boolean {
    return !coverErrors.value.has(path);
  }

  /** 封面加载失败标记（远程 404 / 断网时回退占位图）。 */
  function markCoverError(path: string) {
    coverErrors.value.add(path);
  }

  /**
   * 异步解析封面 URL（本地优先 + 按需后台缓存）。同一 path 幂等。
   * @param path 歌曲 path
   * @param opts download:true → 未命中时后台缓存（调用方节流）
   */
  function resolveCover(path: string, _opts: { download?: boolean } = {}) {
    if (!path) return;
    const r = refFor(path);
    if (r.value) return; // 已解析，跳过
    r.value = remoteURL(path);
  }

  // 恢复在线重试（契约 2026-08-27）：offline→online 时清空本实例解析结果 + 错误标记，
  // 并通知调用方重新解析（当前歌曲/可见行）。断网时解析为空（无缓存且无内嵌）的 path
  // 保持空且无标记（见 resolveCover 断网分支），必须由本回调重新 resolve 才能补上。
  // 桌面/非壳：resolveCover 同步远程直出，重解析结果 URL 相同，行为零变化。
  const dispose: () => void = onOfflineChange((offline: boolean) => {
    if (offline) return; // 只处理「恢复在线」方向
    urlMap.clear();
    coverErrors.value.clear();
    onOnlineRefresh?.();
  });

  return { coverSrc, coverOk, markCoverError, resolveCover, dispose };
}
