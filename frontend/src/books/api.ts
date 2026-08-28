/**
 * 电子书阅读器 - 后端 API 封装
 *
 * 数据层定案 ②：全部请求走 apiClient 统一出口（baseURL + Bearer token + 声明式缓存）。
 * 读接口（书架列表 / 上次打开书）标 60s + 离线兜底缓存；写操作成功后失效对应缓存。
 * 阅读进度保存走写路径 dirty 队列（本地先写，离线积累、回网重放）。
 */
import { api, invalidate, writeLocal } from "../utils/apiClient.js";
import type { BookView, BookMeta, BookProgress, ImportBookResult } from "./types";

async function request<T>(
  url: string,
  init?: RequestInit,
  opts?: { cache?: { ttl?: number; offline?: boolean } },
): Promise<T> {
  let body: unknown = init?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = undefined;
    }
  }
  const r = await api({
    url,
    method: (init?.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | undefined) || "GET",
    body: body as BodyInit | undefined,
    headers: init?.headers as Record<string, string> | undefined,
    cache: opts?.cache,
  });
  if (!r.ok) {
    const detail = (r.data as { detail?: string } | null)?.detail || r.message;
    throw new Error(detail || `请求失败 (${r.status})`);
  }
  if (r.status === 204) return undefined as T;
  return r.data as T;
}

/** 后端返回的书架条目 → 前端视图（拼 fileUrl/coverUrl 派生字段） */
function toView(meta: BookMeta): BookView {
  return {
    ...meta,
    fileUrl: `/api/books/${meta.id}/file`,
    coverUrl: `/api/books/${meta.id}/cover`,
  };
}

/** 书架列表（含进度）：60s + 离线兜底；导入/删除/进度保存后失效 */
export async function fetchBooks(): Promise<BookView[]> {
  const list = await request<BookMeta[]>("/api/books", undefined, {
    cache: { ttl: 60, offline: true },
  });
  return (Array.isArray(list) ? list : []).map(toView);
}

/** 导入 EPUB（multipart 上传） */
export async function importBook(file: File): Promise<ImportBookResult> {
  const form = new FormData();
  form.append("file", file);
  const meta = await request<BookMeta>("/api/books/import", {
    method: "POST",
    body: form,
  });
  invalidate("/api/books");
  return toView(meta);
}

/**
 * 保存阅读进度：写路径本地优先（入 dirty 队列 → 立即同步）。
 * 网络失败保留队列（离线积累、回网重放）；HTTP 拒绝清队（服务端为准）。
 * 返回 resolved Promise（调用方静默失败处理不变）。
 */
export async function saveBookProgress(id: string, progress: BookProgress): Promise<void> {
  // writeLocal（JS 模块 JSDoc @returns）被 TS 推断为直接返回 union 而非 Promise → 显式包一层
  const result = await Promise.resolve(
    writeLocal({
      url: `/api/books/${id}/progress`,
      method: "PUT",
      body: progress,
    }),
  );
  if (result === "ok") invalidate("/api/books");
}

/** 删除书籍 */
export async function deleteBook(id: string): Promise<void> {
  await request<void>(`/api/books/${id}`, { method: "DELETE" });
  invalidate("/api/books");
}

/** 读取上次打开的书 id（统一 Settings 层 books.lastReadId；无/异常返回空串）
 * 不标缓存：BooksView 每次挂载读一次，保持与后端实时一致（读书记录常变） */
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
  })
    .then(() => {
      invalidate("/api/settings");
    })
    .catch(() => undefined);
}
