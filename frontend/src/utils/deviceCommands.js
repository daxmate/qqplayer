// 设备指令工具（桌面端管理端：设备指令队列 + iOS 资产清单）
//
// 纯函数 + apiClient 封装；不依赖 sync.js（T2 维护，避免冲突）。
// 后端契约（T1，形状已定死）：
//   GET /api/sync/devices   → {devices:[{device_id, device_name, server_id, last_seen,
//                                        assets:[{path,sha256,size}], assets_count, total, byType, assets_updated_at}]}
//   GET /api/sync/commands  → {commands:[{id,type,payload,status,device_id,created_at,
//                                         picked_at,ack_at,ack_by,error}]}（id 降序）
//   POST /api/sync/commands {type,payload,device_id} → {id,type,status,created_at}
//     pushDownload  payload: {items:[{path,sha256,size}]}（path = 曲库歌曲路径）
//     remoteDelete payload: {paths:["audio/<hash>.m4a", ...]}（设备本地资产路径）
//   GET /api/sync/manifest → {version, songs:[{path,sha256,size,...}], ...}
import { apiGet, apiPost } from "./apiClient.js";

/**
 * 字节 → 人类可读（B/KB/MB/GB；B 取整，KB 及以上保留 1 位小数）。
 * 纯函数：0/负/非数字 → "0 B"；1024 → "1.0 KB"；1572864(1.5MB) → "1.5 MB"。
 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let val = v;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return (i === 0 ? String(Math.round(val)) : val.toFixed(1)) + " " + units[i];
}

/**
 * 最后在线人性化（纯函数，文案由调用方经 labels 注入以支持 i18n）：
 *   <1 分钟 → labels.justNow；<60 分钟 → labels.minutesAgo(n)；今天 → HH:mm；
 *   昨天 → labels.yesterday；更早 → MM-DD；解析失败原样返回。
 * @param {string} [iso] ISO 时间串
 * @param {{justNow?:string, minutesAgo?:(n:number)=>string, yesterday?:string}} [labels]
 */
export function formatLastSeen(iso, labels = {}) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs >= 0 && diffMs < 60000) return labels.justNow || "just now";
  if (diffMs >= 0 && diffMs < 3600000) {
    const m = Math.max(1, Math.floor(diffMs / 60000));
    return typeof labels.minutesAgo === "function" ? labels.minutesAgo(m) : `${m}m`;
  }
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (diffDays <= 0) return hm;
  if (diffDays === 1) return labels.yesterday || "yesterday";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 拉取已配对设备清单 → {ok, devices, error?}（失败返回空数组 + error） */
export async function fetchDevices() {
  const r = await apiGet("/api/sync/devices");
  if (!r.ok) return { ok: false, devices: [], error: r.message };
  return { ok: true, devices: Array.isArray(r.data?.devices) ? r.data.devices : [] };
}

/**
 * 拉取指令历史（id 降序）。
 * @param {{status?:string, device_id?:string}} [filter] 可选过滤
 * → {ok, commands, error?}
 */
export async function fetchCommandHistory(filter = {}) {
  const params = new URLSearchParams();
  if (filter?.status) params.set("status", filter.status);
  if (filter?.device_id) params.set("device_id", filter.device_id);
  const qs = params.toString();
  const r = await apiGet("/api/sync/commands" + (qs ? `?${qs}` : ""));
  if (!r.ok) return { ok: false, commands: [], error: r.message };
  return { ok: true, commands: Array.isArray(r.data?.commands) ? r.data.commands : [] };
}

/**
 * 推送曲库歌曲到设备离线下载。
 * 流程：GET /api/sync/manifest → 按 songs[].path 匹配 manifest.songs 取 sha256/size
 *       （匹配不到 / 无 path（流媒体）的项跳过）→ POST pushDownload 指令。
 * items 为空 → 不发请求。
 * @param {Array<{path?:string}|null|undefined>} songs 曲库歌曲对象数组（含 path）
 * @param {string} deviceId 目标设备 id
 * @returns {Promise<{ok:boolean, id?:string|number, reason?:string, skipped:string[], error?:string}>}
 *   skipped = 被跳过的 path 列表（无 path / manifest 匹配不到 / 发送失败时全部）
 */
export async function pushSongsToDevice(songs, deviceId) {
  const valid = (Array.isArray(songs) ? songs : []).filter(
    (s) => s && typeof s.path === "string" && s.path.length > 0,
  );
  const allPaths = valid.map((s) => s.path);
  if (!allPaths.length) return { ok: false, reason: "no_valid_items", skipped: allPaths };

  const mr = await apiGet("/api/sync/manifest");
  if (!mr.ok || !mr.data) {
    return { ok: false, reason: "manifest_failed", skipped: allPaths, error: mr.message };
  }
  const byPath = new Map(
    (Array.isArray(mr.data.songs) ? mr.data.songs : [])
      .filter((m) => m && typeof m.path === "string")
      .map((m) => [m.path, m]),
  );
  const items = [];
  const skipped = [];
  for (const s of valid) {
    const m = byPath.get(s.path);
    if (!m) {
      skipped.push(s.path);
      continue;
    }
    items.push({ path: s.path, sha256: m.sha256 || "", size: m.size || 0 });
  }
  if (!items.length) return { ok: false, reason: "no_valid_items", skipped };

  const r = await apiPost("/api/sync/commands", {
    type: "pushDownload",
    payload: { items },
    device_id: deviceId,
  });
  if (!r.ok) return { ok: false, reason: "send_failed", skipped, error: r.message };
  return { ok: true, id: r.data?.id, skipped };
}

/**
 * 远程删除设备本地资产 → POST remoteDelete 指令。
 * @param {string} deviceId 目标设备 id
 * @param {string[]} paths 设备本地资产路径（如 audio/<hash>.m4a）
 * @returns {Promise<{ok:boolean, id?:string|number, reason?:string, error?:string}>}
 */
export async function deleteAssetsFromDevice(deviceId, paths) {
  const list = (Array.isArray(paths) ? paths : []).filter(
    (p) => typeof p === "string" && p.length > 0,
  );
  if (!list.length) return { ok: false, reason: "no_paths" };
  const r = await apiPost("/api/sync/commands", {
    type: "remoteDelete",
    payload: { paths: list },
    device_id: deviceId,
  });
  if (!r.ok) return { ok: false, reason: "send_failed", error: r.message };
  return { ok: true, id: r.data?.id };
}
