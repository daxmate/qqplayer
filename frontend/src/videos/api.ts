/**
 * 视频模块 - 后端 API 封装（仿 books/api.ts）
 *
 * 契约（写死，后端按此实现）：
 *   本地库：
 *     GET /api/videos                       → { items: [{path, name, size, mtime}] }
 *     GET /api/videos/subtitle?path=<enc>   → { items: [{start, end, text, translation?}] }
 *     GET /api/videos/stream?path=<enc>     → 视频流（<video> src 直接用，Range 由浏览器自动发）
 *   在线源：
 *     POST /api/video-online/resolve {url}  → {title, url, provider, duration, subtitles:[{lang, name}]}
 *                                            （返回 url 是直链有时效，播放必须走 stream 代理）
 *     GET /api/video-online/stream?url=<enc> → 视频流（防盗链代理，<video> src 直接用）
 *     GET /api/video-online/subtitles?url=<enc>&lang=<lang> → {items: [{start, end, text, translation}]}
 */
import type { OnlineVideo, SubtitleCue, VideoItem, VideoSource } from "./types";

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

/** 本地加载的文件是否为库内视频条目（type guard） */
export function isLibraryVideo(source: VideoSource): source is VideoItem {
  return "path" in source && source.path.length > 0;
}

// ============ 在线源 ============

/**
 * 粘贴链接解析（失败 400 带后端 detail）。
 * 后端返回的 url 是直链（有时效，播放必须走 stream 代理，且 stream/subtitles 接口
 * 都要原始视频页链接）→ 这里直接用入参页面链接覆盖直链，播放链路拿到的始终是页面链接。
 */
export async function resolveOnline(url: string): Promise<OnlineVideo> {
  const res = await fetch("/api/video-online/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      /* 非 JSON 响应，用 statusText */
    }
    throw new Error(detail || `解析失败 (${res.status})`);
  }
  const data = (await res.json()) as OnlineVideo;
  return { ...data, url };
}

/** 在线视频流地址（<video> src；防盗链代理，url = 原始视频页链接，Range 透传） */
export function onlineStreamUrl(url: string): string {
  return `/api/video-online/stream?url=${encodeURIComponent(url)}`;
}

/** 在线字幕内容（url = 原始视频页链接；lang = resolve 返回的字幕 lang，空则跳过拉取） */
export async function fetchOnlineSubtitles(url: string, lang?: string): Promise<SubtitleCue[]> {
  if (!lang) return [];
  const data = await request<{ items: SubtitleCue[] }>(
    `/api/video-online/subtitles?url=${encodeURIComponent(url)}&lang=${encodeURIComponent(lang)}`,
  );
  return data.items ?? [];
}

/** 在线视频判定（OnlineVideo 独有 provider 字段；type guard，注意先 isLibraryVideo 再此） */
export function isOnlineVideo(source: VideoSource): source is OnlineVideo {
  return "provider" in source;
}
