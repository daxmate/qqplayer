// 曲库删除歌曲（移到废纸篓，删除磁盘文件）——移动端左滑「删除」入口（任务 C）
// API 契约：DELETE /api/library/songs，body {"paths": ["/abs/path/a.mp3", ...]}
//   → 200: {"deleted": 2, "missing": ["/not/in/library.mp3"], "errors": [{"path": "...", "reason": "..."}]}
// 本模块只负责请求 + 解析（不依赖 i18n / UI），toast 提示与列表刷新由调用方处理。
// 注意：后端接口与桌面任务并行开发中，按上方契约实现，勿依赖尚未落地的字段。
import { apiDelete } from "../utils/apiClient.js";

export async function deleteSongs(paths) {
  const r = await apiDelete("/api/library/songs", { body: { paths } });
  if (!r.ok) {
    const data = r.data || {};
    throw new Error(data.detail || `HTTP ${r.status}`);
  }
  return r.data;
}
