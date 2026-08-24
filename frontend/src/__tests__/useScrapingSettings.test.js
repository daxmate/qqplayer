// 刮削设置（useScrapingSettings.js）单元测试
// 覆盖：默认值 / 字段规范化（非法值回落）/ GET 回读应用（含后端未合并容错）/ PUT 保存回读 /
// 保存失败返回值 / 重命名模板预览（纯函数）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const {
  SCRAPING_FIELDS,
  SCRAPING_SOURCES,
  SCRAPING_SETTINGS_DEFAULTS,
  scrapingSettings,
  loadScrapingSettings,
  saveScrapingSettings,
  renderRenamePreview,
} = await import("../composables/useScrapingSettings.js");

function resetDefaults() {
  Object.assign(scrapingSettings, JSON.parse(JSON.stringify(SCRAPING_SETTINGS_DEFAULTS)));
}

beforeEach(() => {
  resetDefaults();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("默认值（契约形状）", () => {
  it("全字段选中 / 模板 {artist} - {title} / 源序 网易云→MusicBrainz / 批量刮削默认关", () => {
    expect(scrapingSettings.enabled_fields).toEqual(SCRAPING_FIELDS);
    expect(scrapingSettings.rename_template).toBe("{artist} - {title}");
    expect(scrapingSettings.source_order).toEqual(SCRAPING_SOURCES);
    expect(scrapingSettings.batch_enabled).toBe(false);
  });
});

describe("loadScrapingSettings（GET /api/library/settings）", () => {
  function stubGet(settings) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ settings }),
      })),
    );
  }

  it("settings.scraping 字段级应用", async () => {
    stubGet({
      scraping: {
        enabled_fields: ["title", "year"],
        rename_template: "{year}/{artist} - {title}",
        source_order: ["musicbrainz"],
        batch_enabled: true,
      },
    });
    await loadScrapingSettings();
    expect(scrapingSettings.enabled_fields).toEqual(["title", "year"]);
    expect(scrapingSettings.rename_template).toBe("{year}/{artist} - {title}");
    expect(scrapingSettings.source_order).toEqual(["musicbrainz"]);
    expect(scrapingSettings.batch_enabled).toBe(true);
  });

  it("后端未返回 scraping（接口未合并）→ 保持默认，不崩", async () => {
    stubGet({ audioExts: [".mp3"] });
    await loadScrapingSettings();
    expect(scrapingSettings.enabled_fields).toEqual(SCRAPING_FIELDS);
    expect(scrapingSettings.batch_enabled).toBe(false);
  });

  it("非法值规范化：未知字段丢弃、白名单固定顺序、布尔非布尔回落默认", async () => {
    stubGet({
      scraping: {
        enabled_fields: ["title", "hack", "year"],
        rename_template: 123,
        source_order: ["bad", "netease"],
        batch_enabled: "yes",
      },
    });
    await loadScrapingSettings();
    expect(scrapingSettings.enabled_fields).toEqual(["title", "year"]);
    expect(scrapingSettings.rename_template).toBe("{artist} - {title}"); // 非字符串回落默认
    expect(scrapingSettings.source_order).toEqual(["netease"]);
    expect(scrapingSettings.batch_enabled).toBe(false);
  });

  it("网络失败 → 静默保持默认（mock 容错）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    await loadScrapingSettings();
    expect(scrapingSettings.batch_enabled).toBe(false);
    expect(scrapingSettings.enabled_fields).toEqual(SCRAPING_FIELDS);
  });
});

describe("saveScrapingSettings（PUT /api/library/settings）", () => {
  it("PUT {scraping: 全字段}，后端回读应用", async () => {
    let putBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts = {}) => {
        if (opts.method === "PUT") {
          putBody = JSON.parse(opts.body);
          return { ok: true, json: async () => ({ settings: { scraping: putBody.scraping } }) };
        }
        return { ok: true, json: async () => ({ settings: {} }) };
      }),
    );
    scrapingSettings.batch_enabled = true;
    const r = await saveScrapingSettings();
    expect(r.ok).toBe(true);
    expect(putBody).toEqual({ scraping: expect.objectContaining({ batch_enabled: true }) });
    expect(putBody.scraping.enabled_fields).toEqual(SCRAPING_FIELDS);
  });

  it("patch 合并进全量提交；后端未回读 → 本地值保留", async () => {
    let putBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts = {}) => {
        if (opts.method === "PUT") {
          putBody = JSON.parse(opts.body);
          return { ok: true, json: async () => ({ settings: {} }) };
        }
        return { ok: true, json: async () => ({ settings: {} }) };
      }),
    );
    const r = await saveScrapingSettings({ rename_template: "{title}" });
    expect(r.ok).toBe(true);
    expect(putBody.scraping.rename_template).toBe("{title}");
    expect(putBody.scraping.batch_enabled).toBe(false);
    expect(putBody.scraping.enabled_fields).toEqual(SCRAPING_FIELDS);
    expect(scrapingSettings.rename_template).toBe("{title}");
  });

  it("HTTP 错误 → {ok:false, error}，本地值保留（不抛）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ detail: "boom" }),
      })),
    );
    const r = await saveScrapingSettings();
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe("renderRenamePreview（重命名模板实时预览）", () => {
  const song = { name: "雪の華", artist: "中島美嘉", album: "雪の華", year: 2003, track: 2 };

  it("替换占位符（artist/title/album/track/year）", () => {
    expect(renderRenamePreview("{artist} - {title}", song)).toBe("中島美嘉 - 雪の華");
    expect(renderRenamePreview("{album}/{artist} - {title}", song)).toBe(
      "雪の華/中島美嘉 - 雪の華",
    );
    expect(renderRenamePreview("{track}. {title} ({year})", song)).toBe("2. 雪の華 (2003)");
  });

  it("缺值占位符 → 空串；/ 保留为目录分隔", () => {
    expect(
      renderRenamePreview("{artist}/{title}/{album}/{year}/{track}", { name: "X", artist: "Y" }),
    ).toBe("Y/X///");
  });

  it("title 缺失回落 name；无模板/无歌曲返回空串", () => {
    expect(renderRenamePreview("{title}", { name: "N" })).toBe("N");
    expect(renderRenamePreview("", song)).toBe("");
    expect(renderRenamePreview(null, song)).toBe("");
    expect(renderRenamePreview("{title}", null)).toBe("");
  });
});
