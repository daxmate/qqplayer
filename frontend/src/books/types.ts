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

/** 阅读选中信息（Reader 内部，选中工具栏/查词/笔记共用） */
export interface ReaderSelection {
  /** epub.js CFI 范围（如 epubcfi(/6/8!/4/2/2/1:0,1:10)） */
  cfi: string;
  /** 选中的纯文本 */
  text: string;
  /** 选中所在句子（生词本 context 用） */
  context: string;
}

/**
 * 阅读字体 key（iBooks 式字体列表，V3 扩展）。
 * 保留 V2 的 default/serif/sans/rounded 四个 key 兼容旧设置：
 * serif=Georgia、sans=Helvetica Neue、rounded=Avenir Next Rounded，新字体再扩展 key。
 */
export type ReaderFontKey =
  | "default"
  | "serif"
  | "sans"
  | "rounded"
  | "palatino"
  | "charter"
  | "new-york"
  | "songti-sc"
  | "avenir-next"
  | "pingfang-sc"
  | "kaiti-sc";

/**
 * 阅读设置（后端 settings.json books namespace，V2 追加 7 字段，V3 追加 bold + 字体扩展）。
 * 持久化在后端（GET/PUT /api/settings 深合并），localStorage 只读不写。
 */
export interface ReaderSettings {
  /** 字体族：见 ReaderFontKey（default 跟随 EPUB 默认） */
  fontFamily: ReaderFontKey;
  /** 字号百分比 70~200，默认 100 */
  fontSize: number;
  /** 行距 1.0~2.0，默认 1.6 */
  lineHeight: number;
  /** 页边距 px 0~15，默认 4 */
  margin: number;
  /** 粗体开关（V3）：false 不覆盖字重，true 正文加粗（不影响 EPUB 自带 heading 样式） */
  bold: boolean;
  /** 主题：light 浅色 | sepia 米黄 | dark 深色 | auto 跟随 App 主题 */
  theme: "light" | "sepia" | "dark" | "auto";
  /** 正文颜色（#rrggbb），空 = 主题默认 */
  textColor: string;
  /** 背景颜色（#rrggbb），空 = 主题默认 */
  bgColor: string;
}

/**
 * 高亮颜色（V4 标注：iBooks 式五色；下划线固定红色不入此类型）
 */
export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";

/** 标注样式：高亮底色 / 下划线（V4 扩展） */
export type HighlightStyle = "highlight" | "underline";

/** 高亮条目（annotations.json highlights[]）；V4 加 style，旧数据无该字段由后端 GET 规范化补 "highlight" */
export interface HighlightAnnotation {
  id: string;
  cfi: string;
  text: string;
  /** 高亮五色；style=underline 时固定 "red"（前端渲染固定色） */
  color: HighlightColor | "red";
  style: HighlightStyle;
  createdAt: number;
}

/** 书内搜索单条结果（GET /api/books/{bid}/search，V4 新增） */
export interface BookSearchResult {
  /** 章节文件（spine href），跳转用 */
  href: string;
  /** 章节标题（index.json chapters[].title） */
  chapterTitle: string;
  /** 命中的句子全文（index.json 句子粒度） */
  sentence: string;
  /** 句子起始 CFI（epub.js display 可直接定位），后端解析 XHTML 生成 */
  cfi: string;
  /** 命中词在 sentence 内的起始偏移（字符），前端临时高亮用 */
  matchStart: number;
  /** 命中词在 sentence 内的结束偏移（字符） */
  matchEnd: number;
}

/** 书内搜索响应 */
export interface BookSearchResponse {
  query: string;
  results: BookSearchResult[];
}

/** 书签条目（annotations.json bookmarks[]） */
export interface BookmarkAnnotation {
  id: string;
  cfi: string;
  text: string;
  createdAt: number;
}

/** 笔记条目（annotations.json notes[]） */
export interface NoteAnnotation {
  id: string;
  cfi: string;
  excerpt: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** 单本书的完整标注对象（GET /api/books/{bid}/annotations） */
export interface BookAnnotations {
  highlights: HighlightAnnotation[];
  bookmarks: BookmarkAnnotation[];
  notes: NoteAnnotation[];
}

/** 生词条目（vocab.json，全局跨书） */
export interface VocabEntry {
  id: string;
  word: string;
  context: string;
  bookId: string;
  bookTitle: string;
  cfi: string;
  addedAt: number;
}

/** 词典配置项（settings dict.dictionaries[]） */
export interface DictConfig {
  id: string;
  name: string;
  path: string;
  kind: "local" | "uploaded";
  role: "define" | "frequency";
  enabled: boolean;
  addedAt: number;
}

/** 词典设置（GET /api/dict） */
export interface DictSettings {
  dictionaries: DictConfig[];
  activeDictId: string;
}

/** 扫描候选（POST /api/dict/scan） */
export interface DictScanCandidate {
  path: string;
  name: string;
  size: number;
  mddExists: boolean;
}

/** 词频信息（查词响应 frequency / GET /api/dict/frequency） */
export interface WordFrequency {
  rank: number | null;
  total: number | null;
}

/** 查词结果（GET /api/dict/query） */
export interface DictQueryResult {
  word: string;
  found: boolean;
  html: string;
  source: string;
  audio: { label: string; url: string }[];
  frequency: WordFrequency | null;
  error?: string;
}
