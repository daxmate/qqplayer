// coverDataURL 工具测试：封面 URL → data: URL（CarPlay 切歌封面即时刷新修复）
//
// 覆盖：小 blob 直接 base64（不解码）、大图 canvas 缩放重编码、fetch 非 ok reject、
// Image 解码失败 reject、fetch 网络失败 reject、canvas toDataURL 空结果 reject。
//
// stub 风格（参考 nativeAudioBridge.test.js）：vi.stubGlobal 替换 fetch/FileReader/Image，
// vi.spyOn 替换 HTMLCanvasElement.prototype 方法；动态 import 拿全新模块实例。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// FileReader stub：readAsDataURL 异步触发 onload（data URL 编码 blob.size 便于断言）
class FakeFileReader {
  static instances = [];
  constructor() {
    this.onload = null;
    this.onerror = null;
    FakeFileReader.instances.push(this);
  }
  readAsDataURL(blob) {
    this._blob = blob;
    // 真实 FileReader 同时写 reader.result 与事件 target.result（代码读 reader.result）
    this.result = "data:image/png;base64," + String(blob.size);
    queueMicrotask(() => {
      if (this.onload) {
        this.onload({ target: { result: this.result } });
      }
    });
  }
}

// Image stub：src 赋值异步触发 onload（按 behavior 配置尺寸）/ onerror（fail=true）
class FakeImage {
  static behavior = { fail: false, naturalWidth: 1600, naturalHeight: 1200 };
  static instances = [];
  constructor() {
    this.onload = null;
    this.onerror = null;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    FakeImage.instances.push(this);
  }
  set src(v) {
    this._src = v;
    const cfg = FakeImage.behavior;
    queueMicrotask(() => {
      if (cfg.fail) {
        this.onerror?.(new Error("decode failed"));
      } else {
        this.naturalWidth = cfg.naturalWidth;
        this.naturalHeight = cfg.naturalHeight;
        this.onload?.();
      }
    });
  }
  get src() {
    return this._src;
  }
}

let getContextSpy;
let toDataURLSpy;
let drawImageMock;

beforeEach(() => {
  FakeFileReader.instances.length = 0;
  FakeImage.instances.length = 0;
  FakeImage.behavior = { fail: false, naturalWidth: 1600, naturalHeight: 1200 };
  drawImageMock = vi.fn();
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ drawImage: drawImageMock });
  toDataURLSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue("data:image/jpeg;base64,xx");
});

afterEach(() => {
  getContextSpy?.mockRestore();
  toDataURLSpy?.mockRestore();
  vi.unstubAllGlobals();
});

/** 构造 fetch stub：ok + blob */
function stubFetchOk(blob) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, blob: async () => blob })),
  );
}

describe("coverToDataURL：小图直接 base64（不解码）", () => {
  it("blob <= directLimit → FileReader.readAsDataURL 直接返回", async () => {
    const blob = new Blob(["x".repeat(100)], { type: "image/png" }); // 100B < 256KB
    stubFetchOk(blob);
    vi.stubGlobal("FileReader", FakeFileReader);
    vi.stubGlobal("Image", FakeImage);

    const m = await import("../utils/coverDataURL.js?t=small" + Date.now());
    const out = await m.coverToDataURL("http://127.0.0.1:17888/api/cover?path=x");

    expect(out).toBe("data:image/png;base64,100");
    expect(FakeFileReader.instances).toHaveLength(1);
    expect(FakeFileReader.instances[0]._blob).toBe(blob);
    // 小图不解码、不缩放：Image 与 canvas 都不参与
    expect(FakeImage.instances).toHaveLength(0);
    expect(drawImageMock).not.toHaveBeenCalled();
    expect(toDataURLSpy).not.toHaveBeenCalled();
  });
});

describe("coverToDataURL：大图 canvas 缩放重编码", () => {
  it("超限大图 → Image 解码 → scale 缩放 → jpeg 输出", async () => {
    const blob = new Blob(["y".repeat(300 * 1024)], { type: "image/jpeg" }); // 300KB > 256KB
    stubFetchOk(blob);
    vi.stubGlobal("FileReader", FakeFileReader);
    vi.stubGlobal("Image", FakeImage);
    // 1600x1200 → maxSize 800 → scale 0.5 → 800x600

    const m = await import("../utils/coverDataURL.js?t=big" + Date.now());
    const out = await m.coverToDataURL("http://127.0.0.1:17888/api/cover?path=x", {
      maxSize: 800,
      quality: 0.82,
    });

    expect(out).toBe("data:image/jpeg;base64,xx");
    expect(FakeImage.instances).toHaveLength(1);
    expect(FakeImage.instances[0]._src).toBe("data:image/png;base64," + String(blob.size));
    const canvas = getContextSpy.mock.instances[0];
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(drawImageMock).toHaveBeenCalledWith(FakeImage.instances[0], 0, 0, 800, 600);
    expect(toDataURLSpy).toHaveBeenCalledWith("image/jpeg", 0.82);
  });

  it("大图但尺寸未超限（scale>=1）：不重编码，保留原 data URL", async () => {
    const blob = new Blob(["z".repeat(300 * 1024)], { type: "image/png" });
    stubFetchOk(blob);
    vi.stubGlobal("FileReader", FakeFileReader);
    vi.stubGlobal("Image", FakeImage);
    FakeImage.behavior = { fail: false, naturalWidth: 400, naturalHeight: 300 }; // 已小于 maxSize

    const m = await import("../utils/coverDataURL.js?t=noscale" + Date.now());
    const out = await m.coverToDataURL("http://127.0.0.1:17888/api/cover?path=x");

    expect(out).toBe("data:image/png;base64," + String(blob.size));
    expect(drawImageMock).not.toHaveBeenCalled(); // 原样返回
    expect(toDataURLSpy).not.toHaveBeenCalled();
  });
});

describe("coverToDataURL：失败路径全部 reject", () => {
  it("fetch 非 ok → reject", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found" })),
    );
    const m = await import("../utils/coverDataURL.js?t=notok" + Date.now());
    await expect(m.coverToDataURL("http://127.0.0.1:17888/api/cover?path=x")).rejects.toThrow(
      "cover fetch failed: 404",
    );
  });

  it("fetch 网络失败 → reject", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    );
    const m = await import("../utils/coverDataURL.js?t=netfail" + Date.now());
    await expect(m.coverToDataURL("http://127.0.0.1:17888/api/cover?path=x")).rejects.toThrow(
      "network down",
    );
  });

  it("Image 解码失败（坏图）→ reject", async () => {
    const blob = new Blob(["w".repeat(300 * 1024)], { type: "image/jpeg" }); // 走解码路径
    stubFetchOk(blob);
    vi.stubGlobal("FileReader", FakeFileReader);
    vi.stubGlobal("Image", FakeImage);
    FakeImage.behavior.fail = true;

    const m = await import("../utils/coverDataURL.js?t=badimg" + Date.now());
    await expect(m.coverToDataURL("http://127.0.0.1:17888/api/cover?path=x")).rejects.toThrow(
      "image decode failed",
    );
  });

  it("canvas toDataURL 返回空（环境不支持）→ reject", async () => {
    const blob = new Blob(["v".repeat(300 * 1024)], { type: "image/jpeg" });
    stubFetchOk(blob);
    vi.stubGlobal("FileReader", FakeFileReader);
    vi.stubGlobal("Image", FakeImage);
    toDataURLSpy.mockReturnValue("data:,");

    const m = await import("../utils/coverDataURL.js?t=noctx" + Date.now());
    await expect(m.coverToDataURL("http://127.0.0.1:17888/api/cover?path=x")).rejects.toThrow(
      "canvas toDataURL failed",
    );
  });
});
