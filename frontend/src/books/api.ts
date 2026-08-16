/**
 * 电子书阅读器 - 后端 API 封装
 */
import type { BookView, BookMeta, BookProgress, ImportBookResult } from "./types";

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
  return res.json() as Promise<T>;
}

/** 后端返回的书架条目 → 前端视图（拼 fileUrl/coverUrl 派生字段） */
function toView(meta: BookMeta): BookView {
  return {
    ...meta,
    fileUrl: `/api/books/${meta.id}/file`,
    coverUrl: `/api/books/${meta.id}/cover`,
  };
}

/** 书架列表（含进度） */
export async function fetchBooks(): Promise<BookView[]> {
  const list = await request<BookMeta[]>("/api/books");
  return list.map(toView);
}

/** 导入 EPUB（multipart 上传） */
export async function importBook(file: File): Promise<ImportBookResult> {
  const form = new FormData();
  form.append("file", file);
  const meta = await request<BookMeta>("/api/books/import", {
    method: "POST",
    body: form,
  });
  return toView(meta);
}

/** 保存阅读进度 */
export function saveBookProgress(id: string, progress: BookProgress): Promise<void> {
  return request<void>(`/api/books/${id}/progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(progress),
  });
}

/** 删除书籍 */
export function deleteBook(id: string): Promise<void> {
  return request<void>(`/api/books/${id}`, { method: "DELETE" });
}

/** 读取上次打开的书 id（统一 Settings 层 books.lastReadId；无/异常返回空串） */
export async function getLastReadBookId(): Promise<string> {
  try {
    const data = await request<{ settings: { books?: { lastReadId?: string } } }>("/api/settings");
    return data.settings?.books?.lastReadId ?? "";
  } catch {
    return "";
  }
}

/** 记录上次打开的书 id（统一 Settings 层，跨引擎同步；失败静默不影响阅读） */
export function setLastReadBookId(id: string): Promise<void> {
  return request<void>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ books: { lastReadId: id } }),
  }).catch(() => undefined);
}
