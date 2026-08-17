/**
 * 视频模块 - 前后端契约类型
 *
 * 与后端 app/routers/videos.py 对应（本地视频库 + 字幕接口）。
 * V1 只做本地视频列表 + 字幕跟唱；在线源 / AI 转写后续迭代。
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

/** 播放器输入：库里视频或本地加载文件（二选一） */
export type VideoSource = VideoItem | LocalVideo;

/** 字幕条目（GET /api/videos/subtitle 返回 { items: [...] }；start/end 秒浮点） */
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
