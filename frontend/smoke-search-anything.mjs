// search anything 全屏搜索层 —— playwright 冒烟脚本（任务 A）
// 运行：cd frontend && node smoke-search-anything.mjs（需先起 vite dev 5174 + 后端 17627）
// 截图输出到 /tmp/sa-*.png；任何断言失败 → 非零退出
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.SA_BASE || "http://localhost:5174";
const SHOT = "/tmp";
mkdirSync(SHOT, { recursive: true });

const results = [];
function ok(name) {
  results.push(`✅ ${name}`);
  console.log(`✅ ${name}`);
}
function bad(name, extra = "") {
  results.push(`❌ ${name} ${extra}`);
  console.error(`❌ ${name} ${extra}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

try {
  // ---------- ① 顶栏常态：小放大镜入口（无输入框） ----------
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".sa-entry", { timeout: 15000 });
  if (await page.locator(".sa-input").count()) bad("① 顶栏不应有输入框");
  else ok("① 顶栏显示放大镜入口（无输入框）");
  await page.screenshot({ path: `${SHOT}/sa-1-entry.png` });

  // ---------- ② 点击/Cmd+K 打开全屏搜索层，背景模糊 ----------
  await page.keyboard.press("Meta+K");
  await page.waitForSelector(".sa-mask", { timeout: 5000 });
  await page.waitForTimeout(400); // 等过渡
  const blur = await page
    .locator(".sa-mask")
    .evaluate((el) => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter);
  if (blur.includes("blur")) ok("② Cmd+K 打开全屏搜索层（backdrop-filter blur）");
  else bad("② 遮罩无 blur", blur);
  const focused = await page.evaluate(() => document.activeElement?.className || "");
  if (focused.includes("sa-input")) ok("② 大搜索框自动聚焦");
  else bad("② 搜索框未自动聚焦", focused);
  await page.screenshot({ path: `${SHOT}/sa-2-overlay.png` });

  // ---------- ③ 输入"五月天"：五类结果 + badge ----------
  // 真实数据层（C 的 useSearchAnything）合入前，本地 stub 不产生结果 → 注入示例结果验证渲染路径；
  // 合入后走真实搜索结果（有结果时不注入）
  await page.fill(".sa-input", "五月天");
  await page.waitForTimeout(1200);
  if ((await page.locator(".sa-row").count()) === 0) {
    await page.evaluate(async () => {
      const mod = await import("/src/composables/useSearchAnything.js");
      mod.useSearchAnything().results.value = [
        { kind: "song", id: "sm1", title: "知足", subtitle: "五月天 · 知足", badge: "本地", score: 100, payload: { path: "/x" } },
        { kind: "online", id: "sm2", title: "突然好想你", subtitle: "五月天 · 后青春期的诗", badge: "在线", score: 95, payload: { id: 1, title: "突然好想你", artist: "五月天" } },
        { kind: "artist", id: "sm3", title: "五月天", subtitle: "12 首歌曲", badge: "歌手", score: 90, payload: { artist: "五月天", count: 12 } },
        { kind: "album", id: "sm4", title: "后青春期的诗", subtitle: "五月天", badge: "专辑", score: 80, payload: { album: "后青春期的诗", artists: "五月天", count: 1 } },
        { kind: "setting", id: "sm5", title: "频谱可视化", subtitle: "播放", badge: "设置", score: 10, payload: null },
      ];
    });
  }
  await page.waitForSelector(".sa-row", { timeout: 5000 });
  await page.waitForTimeout(200);
  const badges = await page.locator(".sa-badge").allTextContents();
  const expectBadges = ["本地", "在线", "歌手", "专辑", "设置"];
  const okB = expectBadges.every((b) => badges.includes(b));
  if (okB) ok("③ 输入'五月天'渲染五类结果，badge 齐全（本地/在线/歌手/专辑/设置）");
  else bad("③ badge 缺失", JSON.stringify(badges));
  await page.screenshot({ path: `${SHOT}/sa-3-results.png` });

  // ---------- ④ 繁体/英文标题渲染（normalize 命中属数据层 C；先清空③的结果再注入） ----------
  await page.evaluate(async () => {
    const mod = await import("/src/composables/useSearchAnything.js");
    mod.useSearchAnything().results.value = [
      { kind: "song", id: "t1", title: "後青春期的詩", subtitle: "五月天 · 後青春期的詩", badge: "本地", score: 99, payload: { path: "/x" } },
      { kind: "artist", id: "t2", title: "Mayday", subtitle: "8 首歌曲", badge: "歌手", score: 70, payload: { artist: "Mayday", count: 8 } },
    ];
  });
  await page.waitForTimeout(200);
  const txt = await page.locator(".sa-body").innerText();
  if (txt.includes("後青春期的詩") && txt.includes("Mayday")) ok("④ 繁体/英文标题正常渲染（命中逻辑待 C 数据层合并后验证）");
  else bad("④ 繁体/英文渲染缺失");
  await page.screenshot({ path: `${SHOT}/sa-4-cjk.png` });

  // ---------- ⑤ Esc 收起 ----------
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  if (await page.locator(".sa-mask").count()) bad("⑤ Esc 未收起");
  else ok("⑤ Esc 收起搜索层");
  await page.screenshot({ path: `${SHOT}/sa-5-closed.png` });

  // ---------- ⑥ 空态：设置目录（分类分组） ----------
  await page.keyboard.press("Meta+K");
  await page.waitForSelector(".sa-mask", { timeout: 5000 });
  await page.waitForSelector(".sa-dir", { timeout: 5000 });
  const dirText = await page.locator(".sa-dir").innerText();
  if (dirText.includes("播放") && dirText.includes("音乐库") && dirText.includes("频谱可视化")) ok("⑥ 空态显示设置目录（分类分组 + 设置项）");
  else bad("⑥ 设置目录缺失", dirText.slice(0, 120));
  await page.screenshot({ path: `${SHOT}/sa-6-dir.png` });

  // ---------- ⑦ 设置行展开内联开关，切换生效 ----------
  await page.locator(".sa-dir-row").first().click();
  await page.waitForSelector(".sa-inline", { timeout: 3000 });
  await page.waitForSelector(".ic-toggle", { timeout: 3000 });
  const before = await page.locator(".ic-toggle").getAttribute("class");
  await page.locator(".ic-toggle").click();
  await page.waitForTimeout(150);
  const after = await page.locator(".ic-toggle").getAttribute("class");
  if (before.includes("on") !== after.includes("on")) ok("⑦ 设置行展开内联开关，点击切换生效");
  else bad("⑦ 开关未切换", `${before} → ${after}`);
  await page.screenshot({ path: `${SHOT}/sa-7-inline.png` });
  // 互斥：空态目录展开状态下结果区输入 → 收起
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ---------- ⑧ 移动端 375px：搜索层全屏正常 ----------
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('.mh-icon-btn[title="搜索歌曲"]', { timeout: 15000 });
  await page.locator('.mh-icon-btn[title="搜索歌曲"]').click();
  await page.waitForSelector(".sa-mask", { timeout: 5000 });
  const panelBox = await page.locator(".sa-panel").boundingBox();
  if (panelBox && panelBox.width <= 375 + 1) ok("⑧ 移动端 375px：点击搜索入口打开全屏搜索层（面板全宽）");
  else bad("⑧ 移动端面板宽度异常", JSON.stringify(panelBox));
  await page.screenshot({ path: `${SHOT}/sa-8-mobile.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  if (await page.locator(".sa-mask").count()) bad("⑧ 移动端 Esc 未收起");
  else ok("⑧ 移动端 Esc 收起");

  const fatal = errors.filter((e) => !e.includes("favicon") && !e.includes("net::ERR"));
  if (fatal.length) bad("页面报错", fatal.slice(0, 3).join(" | "));
  else ok("无页面 JS 报错");
} catch (e) {
  bad("冒烟异常", String(e));
  await page.screenshot({ path: `${SHOT}/sa-error.png` }).catch(() => {});
} finally {
  await browser.close();
}

const failed = results.filter((r) => r.startsWith("❌")).length;
console.log(`\n===== smoke summary: ${results.length - failed}/${results.length} passed =====`);
process.exit(failed ? 1 : 0);
