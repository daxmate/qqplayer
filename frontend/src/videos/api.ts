/**
 * 视频模块 - 后端 API 封装（仿 books/api.ts）
 *
 * 契约（写死，后端按此实现）：
 *   GET /api/videos                       → { items: [{path, name, size, mtime}] }
 *   GET /api/videos/subtitle?path=<enc>   → { items: [{start, end, text, translation?}] }
 *   GET /api/videos/stream?path=<enc>     → 视频流（<video> src 直接用，Range 由浏览器自动发）
 */
import type { VideoItem, SubtitleCue } from "./types";

async function request<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* 非 JSON 响应，用 statusText */
    }
    throw new Error(detail || `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/** 视频库列表 */
export async function fetchVideos(): Promise<VideoItem[]> {
  const data = await request<{ items: VideoItem[] }>("/api/videos");
  return data.items ?? [];
}

/** 视频字幕（无字幕时 items 为空数组） */
export async function fetchSubtitles(path: string): Promise<SubtitleCue[]> {
  const data = await request<{ items: SubtitleCue[] }>(
    `/api/videos/subtitle?path=${encodeURIComponent(path)}`,
  );
  return data.items ?? [];
}

/** 视频流地址（<video> src；Range/206 由浏览器与后端处理） */
export function streamUrl(path: string): string {
  return `/api/videos/stream?path=${encodeURIComponent(path)}`;
}

/** 本地加载的文件是否为库内视频条目 */
export function isLibraryVideo(source: { path?: string; localUrl?: string }): boolean {
  return typeof source.path === "string" && source.path.length > 0;
}
