// 封面 → data: URL 转换（CarPlay 切歌封面即时刷新修复，2026-08-25）
//
// 背景：切歌时原生 AVPlayerBridge.applyMetadata 的同步发布窗口里 artwork 是旧歌封面
// （8-25 为防空白加的"保留旧封面兜底"），新封面靠异步 loadArtwork 补——锁屏会刷新，
// CarPlay 车机不刷新异步补的图 → 封面停在上一首。
// 方案：前端把封面转成 data:image/... base64 再传原生，原生对 data: 走同步解码路径，
// CarPlay 即时刷新。页面跑在 http://127.0.0.1:17888（同源，fetch 无 CORS 问题）。

/** coverToDataURL 选项：maxSize 缩放上限（px）/ quality jpeg 质量 / directLimit 直出阈值（字节） */
interface CoverToDataURLOptions {
  maxSize?: number;
  quality?: number;
  directLimit?: number;
}

/**
 * 把封面 URL 转成 data: URL（小图直接 base64 不解码，大图 canvas 缩放到 maxSize 内）。
 * @param url 封面 URL（http(s)/相对路径，页面同源）
 * @returns data:image/... base64
 * @throws fetch 失败 / 非 ok / FileReader 失败 / Image 解码失败 / canvas 环境不支持
 */
export async function coverToDataURL(
  url: string,
  { maxSize = 800, quality = 0.82, directLimit = 256 * 1024 }: CoverToDataURLOptions = {},
): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`cover fetch failed: ${resp.status} ${resp.statusText}`);
  const blob = await resp.blob();
  if (blob.size <= directLimit) {
    // 小图不解码，直接 base64（快）
    return blobToDataURL(blob);
  }
  // 大图：解码 → 超限才缩放重编码（jpeg）
  const dataUrl = await blobToDataURL(blob);
  const img = await loadImage(dataUrl);
  const naturalMax = Math.max(img.naturalWidth || 1, img.naturalHeight || 1);
  const scale = Math.min(1, maxSize / naturalMax);
  if (scale >= 1) return dataUrl; // 尺寸未超限：保留原格式，不重编码
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL("image/jpeg", quality);
  if (!out || out === "data:,") throw new Error("canvas toDataURL failed");
  return out;
}

/** Blob → data URL（FileReader，Promise 化） */
function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

/** 解码图片（new Image()，onload/onerror Promise 化） */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}
