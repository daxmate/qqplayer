// useDragImport 测试：拖入计数增减/归零隐藏、drop 过滤非音频、无音频 toastError、上传成功/失败 toast
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  AUDIO_EXTENSIONS,
  isAudioFile,
  filterAudioFiles,
  isFileDrag,
  handleDragEnter,
  handleDragLeave,
  handleDragOver,
  handleDrop,
  importFiles,
  setupDragImport,
  resetDragState,
  dragVisible,
  dragUploading,
} from "../composables/useDragImport.js";
import { clearToasts, useToast } from "../composables/useToast.js";

beforeEach(() => {
  resetDragState();
  clearToasts();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 构造带 dataTransfer 的 window 事件（jsdom 的 DragEvent 不支持 dataTransfer 赋值）
function fireEvent(type: string, dataTransfer: unknown) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
  window.dispatchEvent(ev);
  return ev;
}

describe("isAudioFile / filterAudioFiles 白名单", () => {
  it("白名单扩展名大小写不敏感", () => {
    for (const ext of AUDIO_EXTENSIONS) {
      expect(isAudioFile({ name: `song.${ext}` })).toBe(true);
      expect(isAudioFile({ name: `song.${ext.toUpperCase()}` })).toBe(true);
    }
  });

  it("非音频 / 无扩展名 / 空名字排除", () => {
    expect(isAudioFile({ name: "note.txt" })).toBe(false);
    expect(isAudioFile({ name: "song" })).toBe(false);
    expect(isAudioFile({ name: "song.mp3." })).toBe(false);
    expect(isAudioFile(null)).toBe(false);
    expect(isAudioFile({})).toBe(false);
  });

  it("filterAudioFiles 只保留音频", () => {
    const files = [
      new File(["a"], "a.mp3"),
      new File(["b"], "b.txt"),
      new File(["c"], "c.FLAC"),
      new File(["d"], "d.jpg"),
    ];
    const got = filterAudioFiles(files);
    expect(got.map((f) => f.name)).toEqual(["a.mp3", "c.FLAC"]);
  });
});

describe("isFileDrag", () => {
  it("types 含 Files 视为文件拖拽", () => {
    expect(isFileDrag({ dataTransfer: { types: ["Files"] } } as unknown as DragEvent)).toBe(true);
    expect(isFileDrag({ dataTransfer: { types: ["text/plain"] } } as unknown as DragEvent)).toBe(
      false,
    );
    expect(isFileDrag({ dataTransfer: {} } as unknown as DragEvent)).toBe(false);
    expect(isFileDrag(null)).toBe(false);
  });
});

describe("拖拽计数与遮罩显隐", () => {
  it("dragenter +1，dragleave -1，归零才隐藏", () => {
    expect(dragVisible.value).toBe(false);
    handleDragEnter();
    handleDragEnter();
    expect(dragVisible.value).toBe(true);
    handleDragLeave();
    expect(dragVisible.value).toBe(true); // 计数未归零仍显示
    handleDragLeave();
    expect(dragVisible.value).toBe(false);
  });

  it("dragleave 多于 dragenter 时计数不为负", () => {
    handleDragLeave();
    handleDragLeave();
    expect(dragVisible.value).toBe(false);
  });

  it("dragover 必须 preventDefault（否则浏览器默认打开文件）", () => {
    const e = { preventDefault: vi.fn() };
    handleDragOver(e as unknown as DragEvent);
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

describe("drop 处理", () => {
  it("drop 混合文件：只上传音频，成功 toast「已导入 n 首；跳过 m 首」", async () => {
    const fetchMock = vi.fn(async (url: string, opts: { method?: string; body?: FormData }) => ({
      ok: true,
      json: async () => ({ imported: 2, skipped: 1, errors: 0 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const preventDefault = vi.fn();
    await handleDrop({
      preventDefault,
      dataTransfer: {
        files: [new File(["a"], "a.mp3"), new File(["b"], "b.flac"), new File(["c"], "c.txt")],
      },
    } as unknown as DragEvent);
    expect(preventDefault).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/import");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeInstanceOf(FormData);
    expect(opts.body!.getAll("files").map((f) => (f as File).name)).toEqual(["a.mp3", "b.flac"]);
    const { items } = useToast();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("success");
    expect(items[0].text).toBe("已导入 2 首；跳过 1 首");
  });

  it("drop 全非音频：toastError，不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await handleDrop({
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(["x"], "a.txt"), new File(["y"], "b.jpg")] },
    } as unknown as DragEvent);
    expect(fetchMock).not.toHaveBeenCalled();
    const { items } = useToast();
    expect(items[0].type).toBe("error");
    expect(items[0].text).toBe("没有可导入的音频文件");
  });

  it("drop 后计数归零（遮罩隐藏）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ imported: 1, skipped: 0, errors: 0 }) })),
    );
    handleDragEnter();
    expect(dragVisible.value).toBe(true);
    await handleDrop({
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(["a"], "a.mp3")] },
    } as unknown as DragEvent);
    expect(dragVisible.value).toBe(false);
  });

  it("上传期间 dragUploading 置真，完成后复位", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ imported: 1 }) })),
    );
    const p = handleDrop({
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(["a"], "a.mp3")] },
    } as unknown as DragEvent);
    expect(dragUploading.value).toBe(true);
    await p;
    expect(dragUploading.value).toBe(false);
  });
});

describe("importFiles 上传 + toast", () => {
  it("成功：toast「已导入 n 首」，skipped/errors 非空时合并", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ imported: 3, skipped: 1, errors: 2 }),
      })),
    );
    await importFiles([new File(["a"], "a.mp3")]);
    const { items } = useToast();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("success");
    expect(items[0].text).toBe("已导入 3 首；跳过 1 首；失败 2 首");
  });

  it("成功但三项全 0：兜底提示「已导入 0 首」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ imported: 0, skipped: 0, errors: 0 }) })),
    );
    await importFiles([new File(["a"], "a.mp3")]);
    expect(useToast().items[0].text).toBe("已导入 0 首");
  });

  it("HTTP 失败：toastError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await importFiles([new File(["a"], "a.mp3")]);
    const { items } = useToast();
    expect(items[0].type).toBe("error");
    expect(items[0].text).toBe("导入失败，请重试");
  });

  it("上传中重复调用被忽略（不重复发请求）", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ imported: 1 }) }));
    vi.stubGlobal("fetch", fetchMock);
    const p1 = importFiles([new File(["a"], "a.mp3")]);
    await importFiles([new File(["b"], "b.mp3")]); // uploading 中 → 直接返回
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await p1;
  });
});

describe("setupDragImport 挂载/清理", () => {
  it("挂载后 window 响应文件拖拽；非文件拖拽不计数；清理后不再响应", () => {
    const cleanup = setupDragImport();
    // 文件拖入 → 遮罩显示；离开窗口（计数归零）→ 隐藏
    fireEvent("dragenter", { types: ["Files"], files: [] });
    expect(dragVisible.value).toBe(true);
    fireEvent("dragleave", { types: [], files: [] });
    expect(dragVisible.value).toBe(false);
    // 文本拖入不计数
    fireEvent("dragenter", { types: ["text/plain"], files: [] });
    expect(dragVisible.value).toBe(false);
    cleanup();
    // 清理后 dragenter 不再响应
    fireEvent("dragenter", { types: ["Files"], files: [] });
    expect(dragVisible.value).toBe(false);
  });

  it("dragover 对文件拖拽 preventDefault（非文件不拦截）", () => {
    const cleanup = setupDragImport();
    const fileEv = fireEvent("dragover", { types: ["Files"], files: [] });
    expect(fileEv.defaultPrevented).toBe(true);
    const textEv = fireEvent("dragover", { types: ["text/plain"], files: [] });
    expect(textEv.defaultPrevented).toBe(false);
    cleanup();
  });
});
