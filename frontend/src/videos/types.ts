/**
 * 视频模块 - 前后端契约类型
 *
 * 与后端 app/routers/videos.py（本地视频库 + 字幕）、app/routers/video_online.py（在线源）对应。
 * 本地视频库 + 字幕跟唱；在线源 = 粘贴链接解析 → 点播（防盗链代理流 + 双字幕）。
 */

/** 视频库条目（GET /api/videos 返回 { items: [...] }） */
export interface VideoItem {
  /** 视频文件绝对路径（字幕/流接口以它定位） */
  path: string;
  /** 文件名（展示用，不刮削元数据） */
  name: string;
  /** 文件大小字节 */
  size: number;
  /** 修改时间戳 ms */
  mtime: number;
}

/** 前端派生字段：本地 File API 加载的视频（不进库、不传后端，刷新即失） */
export interface LocalVideo {
  /** 文件名 */
  name: string;
  /** URL.createObjectURL(file) 生成的本地播放地址 */
  localUrl: string;
}

/** 在线字幕信息（resolve 返回的可用字幕列表项） */
export interface OnlineSubtitleInfo {
  /** 字幕语言标识（/subtitles 接口 lang 参数用它） */
  lang: string;
  /** 显示名（如「中文（自动生成）」） */
  name: string;
}

/** 在线视频解析结果（POST /api/video-online/resolve → {title, url, provider, duration, subtitles}） */
export interface OnlineVideo {
  /** 标题（resolve 返回，可能为空串） */
  title: string;
  /** 原始视频页链接（stream / subtitles 接口都以它定位；直链有时效，播放必须走代理） */
  url: string;
  /** 站点 provider（bilibili / youtube 等，展示徽标用） */
  provider: string;
  /** 时长（秒；可能未知为 null/0） */
  duration?: number | null;
  /** 可用字幕（播放默认取第一个 lang） */
  subtitles?: OnlineSubtitleInfo[];
}

/** 播放器输入：库里视频 / 本地加载文件 / 在线解析结果（三选一） */
export type VideoSource = VideoItem | LocalVideo | OnlineVideo;

/** 字幕条目（GET /api/videos/subtitle、/api/video-online/subtitles 返回 { items: [...] }；start/end 秒浮点） */
export interface SubtitleCue {
  /** 开始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  /** 原文 */
  text: string;
  /** 翻译（可选；有值则双字幕显示，无值单语种） */
  translation?: string;
}
