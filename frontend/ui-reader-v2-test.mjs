// 阅读器 V2/V4 标注 E2E 冒烟：真实链路验证（选中 → 查词 → 高亮/下划线 → 点击高亮弹菜单 → 书签 → 笔记 → 生词本 → 导出）
// 用法: BASE_URL=http://localhost:17629 node ui-reader-v2-test.mjs （需服务运行，默认 http://localhost:17627）
// 背景: 单测全 mock 测不出真实 epub.js 选中/annotations API 契约，补这条端到端兜底（参照 ui-books-test.mjs）。
// V4（2026-08-18）: 选中工具栏改 iBooks 式（顶行五色点+U 下划线，下方功能列表）；点击已有高亮弹小菜单（换色/U 切换/移除/笔记）。
//   - 换色用绿色（旧后端白名单内）保证两版后端都能持久化断言；紫色/下划线持久化依赖 V4 后端（style 字段），
//     旧后端会把 red 回落 yellow 且丢 style → 下划线持久化断言做版本自适应（DOM 渲染断言始终生效）。
// 说明: 词典用用户已配置的真实词典（LDOCE6++ 等）验证查词；测试书/生词/标注全部清理。
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE_URL || "http://localhost:17627";
const EPUB = "/tmp/qqp-e2e-anno.epub";
const errors = [];
const book = {};
const createdVocabIds = [];

function api(path, opts) {
  return fetch(`${BASE}${path}`, opts);
}

// ---------- 1. 生成最小合法 EPUB（多段落，含英文句供选中/查词） ----------
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
    <dc:title>标注E2E测试书</dc:title>
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
<body><h1>第一章</h1><p>这是第一句。这是第二句！</p><p>Hello world. Another sentence.</p><p>The quick brown fox jumps over the lazy dog.</p></body></html>''')
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
  "e2e-anno.epub",
);
const impRes = await api("/api/books/import", { method: "POST", body: form });
if (!impRes.ok) throw new Error("导入失败: " + impRes.status);
Object.assign(book, await impRes.json());
console.log("2. 导入 OK:", book.title, "| id:", book.id.slice(0, 8));

// ---------- 3. 词典：确认已配置（用真实 LDOCE 查词） ----------
const dictRes = await api("/api/dict");
const dictSettings = await dictRes.json();
const defineDicts = dictSettings.dictionaries.filter((d) => d.enabled && d.role === "define");
if (!defineDicts.length)
  throw new Error("E2E 需要至少一个 enabled define 词典（用户已配置 LDOCE6++ 等）");
console.log("3. 词典 OK:", defineDicts.map((d) => d.name).join(" / "));

const q = await (await api(`/api/dict/query?word=hello&dictId=${defineDicts[0].id}`)).json();
if (!q.found) throw new Error("真实词典查 hello 未命中");
console.log("   查词 OK: found=true, source=", q.source, "| audio:", q.audio.length);

// ---------- 4. 浏览器真实打开 ----------
// 记录当前 lastReadId（清理时恢复，不打扰用户阅读位置）
const beforeSettings = await (await api("/api/settings")).json();
const beforeLastRead = beforeSettings.settings?.books?.lastReadId ?? "";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("response", (r) => {
  // 过滤正常噪音：favicon（未配图标）、/cover（无封面书的 404 是设计内行为，前端 fallback 图标）、
  // 词典外置 css（fork 基线 bc42614 缺 bde21a7 修复，main 已修——不视为本任务缺陷）
  const knownCssGap = r.url().includes("/api/dict/resource/") && r.url().endsWith(".css");
  if (
    r.status() === 404 &&
    !r.url().includes("favicon") &&
    !r.url().includes("/cover") &&
    !knownCssGap
  )
    errors.push("404: " + r.url());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.click('button.tab:has-text("图书")');
// 可能自动打开上次阅读的书 → 先返回书架
await page.waitForTimeout(1500);
if (await page.locator('.reader-btn:has-text("返回")').count()) {
  await page.click('.reader-btn:has-text("返回")');
}
await page.waitForSelector(".bs-card", { timeout: 15000 });
// 点测试书（书架里可能还有用户的其它书）
await page.click(`.bs-card:has(.bs-name:text-is("${book.title}"))`);
await page.waitForSelector(".reader-status", { state: "detached", timeout: 30000 });
let frame = page.frames().find((f) => f !== page.mainFrame());
if (!frame) throw new Error("epub.js iframe 未出现");
console.log("4. 打开书 → 渲染完成 OK");

// ---------- 5. 选中文字 → 选中工具栏出现（V4：顶行五色点 + U 常驻） ----------
async function selectInFrame(text) {
  return frame.evaluate((selText) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.textContent.indexOf(selText);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + selText.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        return true;
      }
    }
    return false;
  }, text);
}

await selectInFrame("Hello");
await page.waitForSelector(".hl-menu", { timeout: 6000 });
const dotCount = await page.locator(".hl-menu-dot").count();
if (dotCount !== 5) throw new Error("选中工具栏色点数 != 5: " + dotCount);
if ((await page.locator(".hl-menu-underline").count()) !== 1) throw new Error("U 下划线按钮缺失");
console.log("5. 选中 Hello → 工具栏 OK（5 色点 + U 常驻）");

// ---------- 6. 查词弹窗（真实词典查询 + 资源重写） ----------
await page.click(".hl-menu-action:has-text('查询')");
await page.waitForSelector(".dict-modal", { timeout: 6000 });
await page.waitForSelector(".dict-modal-frame", { timeout: 20000 });
const srcdoc = await page.locator(".dict-modal-frame").getAttribute("srcdoc");
if (!srcdoc.includes("/api/dict/resource/")) throw new Error("词条资源 URL 未重写");
// 词典切换下拉存在（多 define 词典）
const selectCount = await page.locator(".dict-modal-select option").count();
console.log(
  "6. 查词 OK: srcdoc 资源重写 ✓ | 词典下拉选项:",
  selectCount,
  "| 词频徽标:",
  (await page.locator(".dict-modal-freq").count()) > 0 ? "有" : "无",
);
// 重写后的 css 资源可拉取性（fork 基线 bc42614 缺 bde21a7「外置 css 回退」修复，main 已修；404 不阻断）
const cssMatch = srcdoc.match(/\/api\/dict\/resource\/[^"']+\.css/);
if (cssMatch) {
  const cssRes = await api(cssMatch[0]);
  if (cssRes.ok) console.log("   词典 css 资源 200 OK");
  else
    console.log(
      "   ⚠ 词典 css 资源 " +
        cssRes.status +
        "（外置 css 场景，fork 基线缺 bde21a7 修复，main 已修）",
    );
}

// ---------- 7. 加入生词本 ----------
await page.click(".dict-modal-btn.vocab");
await page.waitForFunction(
  () => document.querySelector(".dict-modal-btn.vocab")?.textContent.includes("已加入"),
  null,
  { timeout: 6000 },
);
const vocabRes = await (await api("/api/vocab")).json();
const myVocab = vocabRes.find((v) => v.word === "Hello" && v.bookId === book.id);
if (!myVocab) throw new Error("生词未入库");
createdVocabIds.push(myVocab.id);
console.log("7. 加入生词本 OK:", myVocab.word, "| context:", myVocab.context.slice(0, 24));

// 关弹窗（头部最右侧 X）
await page.locator(".dict-modal-head .dict-modal-btn.icon").last().click();
await page.waitForSelector(".dict-modal", { state: "detached", timeout: 5000 });

// ---------- 8. 高亮（黄色）→ 后端持久化 ----------
await selectInFrame("Hello");
await page.waitForSelector(".hl-menu", { timeout: 6000 });
await page.click(".hl-menu-dot:first-child"); // yellow（色点常驻，无需展开）
await page.waitForTimeout(600); // 等 POST 完成
let ann = await (await api(`/api/books/${book.id}/annotations`)).json();
const hl = ann.highlights.find((h) => h.text === "Hello");
if (!hl || hl.color !== "yellow")
  throw new Error("高亮未持久化: " + JSON.stringify(ann.highlights));
console.log("8. 高亮持久化 OK:", hl.id.slice(0, 10), "color=", hl.color);

// 刷新页面 → 重开书 → 高亮重放无报错
await page.reload({ waitUntil: "domcontentloaded" });
await page.click('button.tab:has-text("图书")');
await page.waitForTimeout(1500);
if (await page.locator('.reader-btn:has-text("返回")').count()) {
  await page.click('.reader-btn:has-text("返回")');
}
await page.waitForSelector(".bs-card", { timeout: 15000 });
await page.click(`.bs-card:has(.bs-name:text-is("${book.title}"))`);
await page.waitForSelector(".reader-status", { state: "detached", timeout: 30000 });
// 重开书后 iframe 是新的 → 重新获取 frame
frame = page.frames().find((f) => f !== page.mainFrame());
if (!frame) throw new Error("重开书 iframe 未出现");
console.log("   刷新重开书 OK（高亮重放无 pageerror）");

// ---------- 8.5 点击已有高亮 → 弹菜单（V4 核心交互） ----------
// 重放的高亮 SVG mark 渲染在父文档 overlay（pointer-events:none），真实点击落在 iframe 内容上；
// Reader 在 contents click 里按坐标反查 .epubjs-hl 命中段 → 弹菜单（不翻页）
async function clickHighlightCenter(sel = ".epubjs-hl") {
  const box = await page.locator(sel).first().boundingBox();
  if (!box) throw new Error("高亮 mark 未渲染: " + sel);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector(".hl-menu", { timeout: 6000 });
}

await clickHighlightCenter();
let menuText = await page.locator(".hl-menu").innerText();
if (!menuText.includes("移除高亮") || !menuText.includes("笔记"))
  throw new Error("点击高亮菜单缺移除/笔记项: " + menuText);
console.log("8.5 点击高亮 → 弹菜单 OK（不翻页）");

// 换色（绿）→ 删除重建 → 后端 color 变 green（旧后端白名单内，两版后端均可断言）
await page.locator(".hl-menu .hl-menu-dot").nth(1).click();
await page.waitForTimeout(700);
ann = await (await api(`/api/books/${book.id}/annotations`)).json();
let hl2 = ann.highlights.find((h) => h.text === "Hello");
if (!hl2 || hl2.color !== "green") throw new Error("换色未持久化: " + JSON.stringify(hl2));
console.log("   换色 OK: color=green（删除重建，菜单保持打开）");

// U 切换下划线：DOM 立即渲染 epubjs-ul + 红色 line（CSS 覆盖 marks-pane 硬编码黑色）；
// 持久化 style=underline/red 依赖 V4 后端（旧后端回落 yellow 且丢 style → 仅警告）
await clickHighlightCenter();
await page.locator(".hl-menu .hl-menu-underline").click();
await page.waitForSelector(".epubjs-ul", { timeout: 6000 });
const stroke = await page
  .locator(".epubjs-ul line")
  .first()
  .evaluate((el) => getComputedStyle(el).stroke);
if (stroke !== "rgb(229, 72, 77)") throw new Error("下划线非红色: " + stroke);
console.log("   U 切换 OK: DOM 渲染 .epubjs-ul，line stroke=", stroke, "（红色）");
ann = await (await api(`/api/books/${book.id}/annotations`)).json();
hl2 = ann.highlights.find((h) => h.text === "Hello");
if (hl2.style === "underline" && hl2.color === "red") {
  console.log("   U 切换持久化 OK（V4 后端）: style=underline color=red");
} else {
  console.log("   ⚠ U 切换持久化未断言（后端非 V4：style/red 回落）——前端 DOM 渲染已真实验证");
}

// U 再切回底色高亮（本地 .epubjs-hl 恢复）
await clickHighlightCenter(".epubjs-ul");
await page.locator(".hl-menu .hl-menu-underline").click();
await page.waitForSelector(".epubjs-hl", { timeout: 6000 });
console.log("   U 再切换回底色高亮 OK");

// 移除：菜单删除 → 后端消失
await clickHighlightCenter();
await page.locator(".hl-menu .hl-menu-action:has-text('移除高亮')").click();
await page.waitForTimeout(700);
ann = await (await api(`/api/books/${book.id}/annotations`)).json();
if (ann.highlights.some((h) => h.text === "Hello"))
  throw new Error("菜单移除失败: " + JSON.stringify(ann.highlights));
console.log("   菜单移除 OK（后端已删）");

// 工具栏移除路径（hasHighlight → 移除项显示 → 删除）：先加高亮，再选中同 cfi
await selectInFrame("Hello");
await page.waitForSelector(".hl-menu", { timeout: 6000 });
await page.click(".hl-menu-dot:first-child"); // 加黄色
await page.waitForTimeout(600);
await selectInFrame("Hello");
await page.waitForSelector(".hl-menu", { timeout: 6000 });
const rmShown = await page.locator(".hl-menu-action:has-text('移除高亮')").count();
if (rmShown !== 1) throw new Error("选中已有高亮 cfi → 移除项应显示");
await page.click(".hl-menu-action:has-text('移除高亮')");
await page.waitForTimeout(600);
ann = await (await api(`/api/books/${book.id}/annotations`)).json();
if (ann.highlights.some((h) => h.text === "Hello")) throw new Error("工具栏移除失败");
console.log("   工具栏移除路径 OK（选中已有高亮 → 移除项 → 删除）");

// 重新加回黄色高亮（供后面标注面板断言用）
await selectInFrame("Hello");
await page.waitForSelector(".hl-menu", { timeout: 6000 });
await page.click(".hl-menu-dot:first-child");
await page.waitForTimeout(600);

// ---------- 9. 书签：加 → 删 → 再加 ----------
const bmBtn = page.locator('.reader-btn[title="书签"]');
await bmBtn.click();
await page.waitForTimeout(400);
ann = await (await api(`/api/books/${book.id}/annotations`)).json();
if (!ann.bookmarks.length) throw new Error("书签未创建");
const bmCfi = ann.bookmarks[0].cfi;
console.log("9. 书签创建 OK:", ann.bookmarks[0].text, "|", bmCfi.slice(0, 26));

await bmBtn.click(); // 再点 → 删除
await page.waitForTimeout(400);
ann = await (await api(`/api/books/${book.id}/annotations`)).json();
if (ann.bookmarks.length !== 0) throw new Error("书签删除失败");
await bmBtn.click(); // 再加回（留一条供面板展示）
await page.waitForTimeout(400);
console.log("   书签删除/重加 OK");

// ---------- 10. 笔记：选中 → 笔记弹窗 → 保存 ----------
await selectInFrame("quick brown fox");
await page.waitForSelector(".hl-menu", { timeout: 6000 });
await page.click(".hl-menu-action:has-text('笔记')");
await page.waitForSelector(".note-modal", { timeout: 6000 });
await page.fill(".note-modal-textarea", "E2E 测试笔记：foobar");
await page.click(".note-modal-btn.primary");
await page.waitForTimeout(500);
ann = await (await api(`/api/books/${book.id}/annotations`)).json();
const note = ann.notes.find((n) => n.text === "E2E 测试笔记：foobar");
if (!note || note.excerpt !== "quick brown fox") throw new Error("笔记未持久化");
console.log("10. 笔记持久化 OK:", note.id.slice(0, 10), "| excerpt:", note.excerpt);

// ---------- 11. 标注侧栏：标注 tab + 生词本 tab + 导出 ----------
await page.locator('.reader-btn[title="标注"]').click();
await page.waitForSelector(".anno-panel", { timeout: 6000 });
const annoText = await page.locator(".anno-panel").innerText();
if (!annoText.includes("Hello") || !annoText.includes("E2E 测试笔记：foobar"))
  throw new Error("标注面板缺少条目");
await page.click(".anno-panel-tab:has-text('生词本')");
const vocabText = await page.locator(".anno-panel").innerText();
if (!vocabText.includes("Hello")) throw new Error("生词本 tab 缺词");
console.log("11. 标注侧栏 OK（标注 + 生词本 tab）");

// 导出（直接校验后端 text/plain 契约）
const exp = await api("/api/vocab/export");
const expText = await exp.text();
if (!exp.headers.get("content-type").includes("text/plain"))
  throw new Error("导出 Content-Type 错误");
const expLine = expText.split("\n").find((l) => l.startsWith("Hello\t"));
if (!expLine) throw new Error("导出内容缺 Hello 行: " + expText.slice(0, 200));
console.log("   导出 OK:", expLine);

// 词典管理入口（书架）：弹窗列表包含已配置词典
await page.click('.reader-btn:has-text("返回")');
await page.waitForSelector(".bs-dict-btn", { timeout: 5000 });
await page.click(".bs-dict-btn");
await page.waitForSelector(".dictmgr", { timeout: 6000 });
const mgrText = await page.locator(".dictmgr").innerText();
if (!mgrText.includes("释义") || !mgrText.includes("默认")) throw new Error("词典管理弹窗缺内容");
console.log("12. 词典管理入口 OK（列表 + 释义徽标 + 默认标记）");
await page.locator(".dictmgr-close").click();

// ---------- 13. 清理 ----------
for (const v of createdVocabIds) await api(`/api/vocab/${v}`, { method: "DELETE" });
for (const h of ann.highlights)
  await api(`/api/books/${book.id}/annotations/highlights/${h.id}`, { method: "DELETE" });
for (const m of ann.bookmarks)
  await api(`/api/books/${book.id}/annotations/bookmarks/${m.id}`, { method: "DELETE" });
for (const n of ann.notes)
  await api(`/api/books/${book.id}/annotations/notes/${n.id}`, { method: "DELETE" });
const delRes = await api(`/api/books/${book.id}`, { method: "DELETE" });
// 恢复用户上次阅读位置
if (beforeLastRead) {
  await api("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ books: { lastReadId: beforeLastRead } }),
  });
}
console.log(
  "13. 清理 OK:",
  delRes.status === 204 ? "书/生词/标注已删，lastReadId 已恢复" : `FAIL ${delRes.status}`,
);
await browser.close();

if (errors.length) {
  console.log("\n⚠️ 页面错误:\n" + errors.slice(0, 5).join("\n"));
  process.exit(1);
}
console.log("\n✅ 阅读器 V2/V4 标注 E2E 全部通过");
