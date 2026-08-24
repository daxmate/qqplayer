// 封面 URL 异步解析 composable（阶段 F1：iOS 壳封面离线缓存）
//
// 背景：iOS 壳封面 URL 是纯远程 resolveServerUrl("/api/cover?path=...")，断网加载失败
// → 无封面。本 composable 让封面本地优先：iOS 壳内先查沙盒封面缓存（cachedCoverURL），
// 命中 → 本地 HTTP URL（离线可显示）；未命中 → 远程 URL（现状）+ 后台缓存（cacheCover）。
// 桌面/非壳 → syncEnabled() 为 false，直接远程直出，行为零变化。
//
// 用法（MobileList / MobileSmartList 共用，避免两处重复）：
//   const { coverSrc, coverOk, markCoverError, resolveCover } = useCoverURL();
//   <img v-if="coverSrc(path) && coverOk(path)" :src="coverSrc(path)"
//        loading="lazy" @error="markCoverError(path)" />
//   watch(可见行, (rows) => rows.forEach((r, i) => resolveCover(r.path, { download: i < N })));
//   watch(() => state.currentSong?.path, (p) => p && resolveCover(p, { download: true }));
//
// 节流取舍（几百首封面不能同时灌入原生串行下载队列）：
//   - resolveCover 对每个 path 只做 hasAsset 查询（本地查询零网络、极廉价）——所有可见行都查
//   - 下载只在调用方传入 download:true 时发起：约定「播放中歌曲 + 列表前 COVER_CACHE_FIRST_N 行」
//     （前 N 行 = 用户大概率会看的；滚动后新可见行随 watch 触发，行号 < N 的才下载）
//   - 同一 path 幂等：已解析出 URL 后直接跳过（查询/下载不重复）

import { ref } from "vue";
import { resolveServerUrl } from "../utils/apiClient.js";
import { syncEnabled, cachedCoverURL, cacheCover } from "../utils/sync.js";

/** 列表前 N 行封面后台缓存（行号超出只查不下载） */
export const COVER_CACHE_FIRST_N = 30;

/**
 * 封面 URL 解析状态（每组件实例一份；coverErrors 语义同原组件内实现）。
 * @returns {{coverSrc:function, coverOk:function, markCoverError:function, resolveCover:function}}
 */
export function useCoverURL() {
  const coverErrors = ref(new Set());
  const urlMap = new Map(); // path → ref(url)；ref 在模板渲染期被读取 → 异步填充后自动重渲染

  function refFor(path) {
    let r = urlMap.get(path);
    if (!r) {
      r = ref("");
      urlMap.set(path, r);
    }
    return r;
  }

  /** 远程封面 URL（桌面同源原样返回；iOS 壳转服务器绝对 URL + token） */
  function remoteURL(path) {
    return resolveServerUrl("/api/cover?path=" + encodeURIComponent(path));
  }

  /** 模板绑定值：未解析完成前返回 ""（配合 v-if 隐藏 <img>，避免空 src 闪烁/坏图） */
  function coverSrc(path) {
    if (!path) return "";
    return refFor(path).value;
  }

  /** 封面是否可显示（未被 markCoverError 标记失败） */
  function coverOk(path) {
    return !coverErrors.value.has(path);
  }

  /** 封面加载失败标记（远程 404 / 断网时回退图标，保留原兜底逻辑） */
  function markCoverError(path) {
    coverErrors.value.add(path);
  }

  /**
   * 异步解析封面 URL（本地优先 + 按需后台缓存）。同一 path 幂等。
   * @param {string} path 歌曲 path
   * @param {{download?:boolean}} [opts] download:true → 未命中时后台缓存（调用方节流）
   */
  function resolveCover(path, opts = {}) {
    if (!path) return;
    const r = refFor(path);
    if (r.value) return; // 已解析（本地或远程），跳过
    if (!syncEnabled()) {
      // 桌面/非 iOS 壳：远程直出（现状行为，同步可渲染）
      r.value = remoteURL(path);
      return;
    }
    // iOS 壳：本地优先异步解析
    cachedCoverURL(path)
      .then((local) => {
        const cur = urlMap.get(path);
        if (!cur || cur.value) return; // 已结算（并发解析先到先得）
        if (local) {
          cur.value = local;
        } else {
          cur.value = remoteURL(path);
          if (opts.download) cacheCover(path); // fire-and-forget 后台缓存
        }
      })
      .catch(() => {
        // 查询失败（原生无回执/超时等）：回退远程，不影响封面展示
        const cur = urlMap.get(path);
        if (cur && !cur.value) cur.value = remoteURL(path);
      });
  }

  return { coverSrc, coverOk, markCoverError, resolveCover };
}
