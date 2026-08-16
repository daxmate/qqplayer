// 图书板块 E2E 冒烟：真实链路验证（导入 → 打开渲染 → 翻页 → 进度保存 → 返回书架）
// 用法: node ui-books-test.mjs  （需服务运行在 http://localhost:17627）
// 背景: 2026-08-16 加载 bug 漏网教训——单测全 mock 测不出真实 epub.js 加载与
//       后端契约断裂，补这条端到端冒烟兜底。
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = "http://localhost:17627";
const EPUB = "/tmp/qqp-e2e-book.epub";
const errors = [];

// ---------- 1. 生成最小合法 EPUB（复用后端测试的构造思路） ----------
const py = `import zipfile
from pathlib import Path
p = Path("${EPUB}")
with zipfile.ZipFile(p, "w") as z:
    z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", '''<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>''')
    z.writestr("content.opf", '''<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>E2E 冒烟测试书</dc:title>
    <dc:creator>测试作者</dc:creator>
  </metadata>
  <manifest>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine>
</package>''')
    z.writestr("toc.ncx", '''<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap><navPoint id="n1" playOrder="1">
    <navLabel><text>第一章</text></navLabel>
    <content src="chap1.xhtml"/>
  </navPoint></navMap>
</ncx>''')
    z.writestr("chap1.xhtml", '''<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head>
<body><h1>第一章</h1><p>这是第一句。这是第二句！</p><p>Hello world. Another sentence.</p></body></html>''')
print("OK")`;
execFileSync("/Users/dax/codes/qqplayer/venv/bin/python", ["-c", py]);
console.log("1. 最小 EPUB 生成 OK");

// ---------- 2. 导入（真实 API） ----------
const form = new FormData();
form.append(
  "file",
  new Blob([await import("node:fs/promises").then((m) => m.readFile(EPUB))], {
    type: "application/epub+zip",
  }),
  "e2e-test.epub",
);
const impRes = await fetch(`${BASE}/api/books/import`, { method: "POST", body: form });
if (!impRes.ok) throw new Error("导入失败: " + impRes.status);
const book = await impRes.json();
console.log("2. 导入 OK:", book.title, "| id:", book.id.slice(0, 8));

// ---------- 3. 浏览器真实打开 ----------
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("response", (r) => {
  // 过滤正常噪音：favicon（未配图标）、/cover（无封面书的 404 是设计内行为，前端 fallback 图标）
  if (r.status() === 404 && !r.url().includes("favicon") && !r.url().includes("/cover"))
    errors.push("404: " + r.url());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.click('button.tab:has-text("图书")');
await page.waitForSelector(".bs-card", { timeout: 15000 });
const t0 = Date.now();
await page.click(".bs-card");
await page.waitForSelector(".reader-status", { state: "detached", timeout: 30000 });
const loadMs = Date.now() - t0;
const frameOk = page.frames().some((f) => f !== page.mainFrame());
console.log(`3. 点开书 → 渲染完成 ${loadMs}ms | epub.js iframe: ${frameOk}`);
if (!frameOk) throw new Error("epub.js iframe 未出现（加载链路异常）");

// 正文文字可见
await page.waitForTimeout(800);
const bodyText = await page
  .frames()
  .find((f) => f !== page.mainFrame())
  ?.locator("body")
  .innerText()
  .catch(() => "");
console.log("   正文包含第一章:", bodyText?.includes("第一章"));

// ---------- 4. 翻页 + 进度保存 ----------
await page.click(".reader-tap.right");
await page.waitForTimeout(1800); // relocated 防抖 1s + 请求余量
const progRes = await fetch(`${BASE}/api/books/${book.id}/progress`);
const prog = await progRes.json();
console.log(
  "4. 翻页后进度已保存:",
  prog ? `cfi=${prog.cfi.slice(0, 30)}… loc=${prog.location}` : "未保存（FAIL）",
);
if (!prog?.cfi) throw new Error("进度未保存");

// ---------- 5. 返回书架 → 进度条出现 ----------
await page.click(".reader-btn:has-text('返回')");
await page.waitForSelector(".bs-card", { timeout: 5000 });
const progressBar = await page.locator(".bs-progress-bar").count();
console.log("5. 返回书架进度条:", progressBar > 0 ? "出现 OK" : "缺失");

// ---------- 6. 清理：删除测试书 ----------
const delRes = await fetch(`${BASE}/api/books/${book.id}`, { method: "DELETE" });
console.log("6. 清理测试书:", delRes.status === 204 ? "OK" : `FAIL ${delRes.status}`);
await browser.close();

if (errors.length) {
  console.log("\n⚠️ 页面 console 错误:\n" + errors.slice(0, 5).join("\n"));
  process.exit(1);
}
console.log("\n✅ E2E 冒烟全部通过");
