/**
 * 电子书阅读器 - 后端 API 封装
 */
import type { BookView, BookProgress, ImportBookResult } from "./types";

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

/** 书架列表（含进度） */
export function fetchBooks(): Promise<BookView[]> {
  return request<BookView[]>("/api/books");
}

/** 导入 EPUB（multipart 上传） */
export async function importBook(file: File): Promise<ImportBookResult> {
  const form = new FormData();
  form.append("file", file);
  return request<ImportBookResult>("/api/books/import", { method: "POST", body: form });
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
