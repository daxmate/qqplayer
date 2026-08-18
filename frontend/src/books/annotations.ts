/**
 * 阅读器 V2 标注 API 封装：annotations（高亮/书签/笔记）+ vocab（生词本）+ dict（词典）。
 *
 * 契约：docs/reader-v2/01-contract-backend-core.md + 02-contract-backend-dict.md。
 * 所有写操作失败抛 Error（detail 透出），调用方负责 toast。
 */
import type {
  BookAnnotations,
  BookSearchResponse,
  DictConfig,
  DictQueryResult,
  DictScanCandidate,
  DictSettings,
  HighlightColor,
  HighlightStyle,
  NoteAnnotation,
  VocabEntry,
} from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
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
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ============ annotations ============

/** 某本书全部标注（无标注返回空结构） */
export function fetchAnnotations(bookId: string): Promise<BookAnnotations> {
  return request<BookAnnotations>(`/api/books/${bookId}/annotations`);
}

/** 创建高亮 {cfi,text,color,style?} → {id}；style 缺省 "highlight"（V4） */
export function createHighlight(
  bookId: string,
  payload: {
    cfi: string;
    text: string;
    color: HighlightColor | "red";
    style?: HighlightStyle;
  },
): Promise<{ id: string }> {
  return request<{ id: string }>(
    `/api/books/${bookId}/annotations/highlights`,
    jsonInit("PUT", payload),
  );
}

export function deleteHighlight(bookId: string, id: string): Promise<void> {
  return request<void>(`/api/books/${bookId}/annotations/highlights/${id}`, { method: "DELETE" });
}

/** 创建书签 {cfi,text} → {id} */
export function createBookmark(
  bookId: string,
  payload: { cfi: string; text: string },
): Promise<{ id: string }> {
  return request<{ id: string }>(
    `/api/books/${bookId}/annotations/bookmarks`,
    jsonInit("PUT", payload),
  );
}

export function deleteBookmark(bookId: string, id: string): Promise<void> {
  return request<void>(`/api/books/${bookId}/annotations/bookmarks/${id}`, { method: "DELETE" });
}

/** 创建笔记 {cfi,excerpt,text} → {id}；text 允许空串（只读摘录） */
export function createNote(
  bookId: string,
  payload: { cfi: string; excerpt: string; text: string },
): Promise<{ id: string }> {
  return request<{ id: string }>(
    `/api/books/${bookId}/annotations/notes`,
    jsonInit("PUT", payload),
  );
}

/** 更新笔记正文（PATCH，返回更新后的笔记） */
export function updateNote(bookId: string, id: string, text: string): Promise<NoteAnnotation> {
  return request<NoteAnnotation>(
    `/api/books/${bookId}/annotations/notes/${id}`,
    jsonInit("PATCH", { text }),
  );
}

export function deleteNote(bookId: string, id: string): Promise<void> {
  return request<void>(`/api/books/${bookId}/annotations/notes/${id}`, { method: "DELETE" });
}

// ============ vocab ============

/** 生词列表（addedAt 倒序） */
export function fetchVocab(): Promise<VocabEntry[]> {
  return request<VocabEntry[]>("/api/vocab");
}

/** 添加生词 {word,context,bookId,bookTitle,cfi} → {id} */
export function addVocab(entry: {
  word: string;
  context: string;
  bookId: string;
  bookTitle: string;
  cfi: string;
}): Promise<{ id: string }> {
  return request<{ id: string }>("/api/vocab", jsonInit("POST", entry));
}

export function deleteVocab(id: string): Promise<void> {
  return request<void>(`/api/vocab/${id}`, { method: "DELETE" });
}

/** 生词导出下载地址（text/plain，word\tbookTitle\tcontext） */
export const VOCAB_EXPORT_URL = "/api/vocab/export";

// ============ dict ============

/** 词典配置全量 */
export function fetchDictSettings(): Promise<DictSettings> {
  return request<DictSettings>("/api/dict");
}

/** 扫描路径（文件/目录）中的 .mdx 候选 */
export function scanDictPath(path: string): Promise<DictScanCandidate[]> {
  return request<DictScanCandidate[]>("/api/dict/scan", jsonInit("POST", { path }));
}

/** 添加本地路径词典 → 完整配置项 */
export function addDict(path: string, name?: string): Promise<DictConfig> {
  return request<DictConfig>("/api/dict", jsonInit("POST", { path, name }));
}

/** 上传 mdx/mdd（XHR 流式，带进度回调）；返回配置项或 {ok:true} */
export function uploadDictFile(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<DictConfig | { ok: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/dict/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as DictConfig | { ok: boolean });
        } catch {
          reject(new Error("bad response"));
        }
      } else {
        let detail = `HTTP ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body?.detail) detail = body.detail;
        } catch {
          /* 非 JSON */
        }
        reject(new Error(detail));
      }
    };
    xhr.onerror = () => reject(new Error("network"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

/** 设为默认词典 */
export function activateDict(id: string): Promise<void> {
  return request<void>("/api/dict/activate", jsonInit("POST", { id }));
}

/** 启停切换 */
export function setDictEnabled(id: string, enabled: boolean): Promise<void> {
  return request<void>(`/api/dict/${id}`, jsonInit("PATCH", { enabled }));
}

/** 删除词典配置（uploaded 同时删文件） */
export function deleteDict(id: string): Promise<void> {
  return request<void>(`/api/dict/${id}`, { method: "DELETE" });
}

/** 查词：dictId 缺省用 activeDictId / 第一个 enabled define 词典 */
export function queryDict(word: string, dictId?: string): Promise<DictQueryResult> {
  const params = new URLSearchParams({ word });
  if (dictId) params.set("dictId", dictId);
  return request<DictQueryResult>(`/api/dict/query?${params.toString()}`);
}

/**
 * 词典词条 HTML 资源重写（srcdoc iframe 渲染用，纯函数便于单测）：
 * - 相对路径 src/href → /api/dict/resource/<dictId>/<path>
 * - sound://xxx → /api/dict/resource/<dictId>/xxx（含 href="sound://…"，规则 1 负向断言跳过避免双前缀）
 * - entry://#xxx → #xxx（词条内部锚点，srcdoc 同文档跳转）
 * - <script> 整段剔除（sandbox 无脚本权限，显式剥离防意外）
 * - 绝对 URL（http/https/data:/#/javascript:/mailto:/sound:/entry:/协议相对）不动
 */
export function rewriteDictHtml(html: string, dictId: string): string {
  let out = html.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  const resource = (path: string) => `/api/dict/resource/${dictId}/${path}`;
  out = out.replace(
    /(\b(?:src|href)\s*=\s*["'])(?!https?:|data:|#|javascript:|mailto:|sound:|entry:|\/\/)([^"']+)(["'])/gi,
    (_m, pre, path, post) => `${pre}${resource(path)}${post}`,
  );
  out = out.replace(/sound:\/\/([^\s"'<>]+)/gi, (_m, path) => resource(path));
  out = out.replace(/entry:\/\/#/gi, "#");
  return out;
}

/** 书内搜索（V4）：GET /api/books/{bid}/search?q=，句子级全文匹配 */
export function searchBook(bookId: string, query: string): Promise<BookSearchResponse> {
  const params = new URLSearchParams({ q: query });
  return request<BookSearchResponse>(`/api/books/${bookId}/search?${params.toString()}`);
}

// ============ 高亮颜色（epub.js marks pane SVG 属性） ============

/** 五色高亮：marks pane 用 SVG fill + mix-blend-mode（multiply 适合浅色主题） */
export const HIGHLIGHT_COLOR_STYLES: Record<HighlightColor, Record<string, string>> = {
  yellow: { fill: "#f6d32d", "fill-opacity": "0.55", "mix-blend-mode": "multiply" },
  green: { fill: "#7bc47f", "fill-opacity": "0.5", "mix-blend-mode": "multiply" },
  blue: { fill: "#64b5f6", "fill-opacity": "0.5", "mix-blend-mode": "multiply" },
  pink: { fill: "#f28bb0", "fill-opacity": "0.5", "mix-blend-mode": "multiply" },
  purple: { fill: "#b388ff", "fill-opacity": "0.5", "mix-blend-mode": "multiply" },
};

/** 高亮色块 UI 色（工具栏色点 / 面板色点） */
export const HIGHLIGHT_COLOR_HEX: Record<HighlightColor, string> = {
  yellow: "#f6d32d",
  green: "#7bc47f",
  blue: "#64b5f6",
  pink: "#f28bb0",
  purple: "#b388ff",
};

/** 下划线样式（style=underline）：epub.js marks pane 用 stroke；颜色固定，不依赖 blend 模式 */
export const UNDERLINE_COLOR = "red";
export const UNDERLINE_STYLE: Record<string, string> = {
  stroke: "#e5484d",
  "stroke-width": "2",
};

/** 背景色是否深色（决定高亮 blend 模式，深色主题用 screen 否则几乎不可见） */
export function isDarkBackground(bg: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
