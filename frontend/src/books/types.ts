/**
 * 电子书阅读器 - 前后端契约类型
 *
 * 与后端 app/routers/books.py 对应（books.json BookStore）。
 * V1 只支持 EPUB；句子索引 index.json 为有声书对齐预留（V1 生成但不展示）。
 */

/** 阅读进度（epub.js CFI 定位） */
export interface BookProgress {
  /** epub.js CFI 字符串，如 "epubcfi(/6/8[chap01]!/4/2/2/1:0)" */
  cfi: string;
  /** 阅读百分比 0~1（可选，书架进度条用） */
  location?: number;
  /** 更新时间戳 ms */
  updatedAt: number;
}

/** 书架条目（books.json 一条记录） */
export interface BookMeta {
  /** uuid，对应后端 books/<id>/ 目录 */
  id: string;
  title: string;
  /** 作者，可能为空字符串 */
  author: string;
  /** 导入时间戳 ms */
  addedAt: number;
  /** 进度，未读过为 null */
  progress: BookProgress | null;
}

/** 前端派生字段（API 返回时拼上 URL） */
export interface BookView extends BookMeta {
  /** /api/books/:id/file —— epub.js 加载用 */
  fileUrl: string;
  /** /api/books/:id/cover */
  coverUrl: string;
}

/** 导入结果 */
export interface ImportBookResult extends BookView {}

/** 章节句子索引（有声书对齐预留，V1 后端生成、前端不消费） */
export interface BookChapterIndex {
  href: string;
  title: string;
  sentences: string[];
}

export interface BookIndex {
  chapters: BookChapterIndex[];
  generatedAt: number;
}
