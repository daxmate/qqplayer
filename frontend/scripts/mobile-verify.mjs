// QQPlayer 移动端响应式布局验证（A-1）
// 用 chromium 模拟 4 个 viewport，走通 首页→列表→播放→全屏播放器→跟唱歌词页 链路并截图
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "/tmp/qqplayer-mobile-shots";
fs.mkdirSync(OUT, { recursive: true });

const results = [];

async function checkNoHScroll(page, label) {
  const { sw, iw, bodySw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    bodySw: document.body.scrollWidth,
  }));
  const ok = sw <= iw + 1 && bodySw <= iw + 1;
  results.push(`${label}: 横向滚动 ${ok ? "无 ✓" : `有 (scrollW=${sw}, innerW=${iw}, body=${bodySw}) ✗`}`);
  return ok;
}

async function runMobileFlow(browser, { width, height, name }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console.error: " + m.text());
  });

  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.waitForSelector(".mh-card", { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector(".mh-card-count")?.textContent.includes("首"),
    { timeout: 15000 },
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}-1-home.png` });
  await checkNoHScroll(page, `${name} home`);

  // 首页卡片数量
  const cardCount = await page.locator(".mh-card").count();
  results.push(`${name}: 首页卡片数=${cardCount} ${cardCount === 6 ? "✓" : "✗"}`);

  // 点“所有歌曲”卡片 → 列表页
  await page.locator(".mh-card").first().click();
  await page.waitForSelector(".ml-item", { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-2-list.png` });
  await checkNoHScroll(page, `${name} list`);

  // 搜索过滤
  await page.fill(".ml-search input", "五月天");
  await page.waitForTimeout(400);
  const songCount = await page.locator(".ml-item").count();
  results.push(`${name}: 列表搜索“五月天” → ${songCount} 条`);
  await page.fill(".ml-search input", "");
  await page.waitForTimeout(300);

  // 点第一首歌 → 全屏播放器（连播模式）
  await page.locator(".ml-item").first().click();
  await page.waitForSelector(".mobile-player", { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}-3-player-continuous.png` });
  await checkNoHScroll(page, `${name} player(连播)`);

  // 跟唱模式：全屏歌词页
  await page.locator(".mp-tab", { hasText: "跟唱" }).click();
  await page.waitForSelector(".karaoke-panel", { timeout: 10000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${name}-4-player-karaoke.png` });
  await checkNoHScroll(page, `${name} player(跟唱)`);

  // 切回连播，收起播放器 → 迷你播放条
  await page.locator(".mp-tab", { hasText: "连播" }).click();
  await page.waitForTimeout(300);
  await page.locator(".mp-head .mp-btn-round").first().click();
  await page.waitForSelector(".mini-player", { timeout: 10000 });
  await page.waitForTimeout(400);
  const mini = await page.locator(".mini-player").boundingBox();
  const miniVisible = mini && mini.y + mini.height <= height + 1 && mini.width > 0;
  results.push(`${name}: 迷你播放条 ${miniVisible ? "常驻底部 ✓" : `位置异常 ✗ y=${mini?.y} h=${mini?.height}`}`);
  await page.screenshot({ path: `${OUT}/${name}-5-minibar.png` });

  // 点迷你播放条 → 重新展开播放器（链路闭环）
  await page.locator(".mini-player").click();
  await page.waitForSelector(".mobile-player", { timeout: 10000 });
  results.push(`${name}: 迷你条→播放器链路 ${(await page.locator(".mobile-player").count()) === 1 ? "✓" : "✗"}`);

  // 列表返回链路：收起播放器 → 列表返回 → 首页
  await page.locator(".mp-head .mp-btn-round").first().click();
  await page.waitForSelector(".ml-page", { timeout: 10000 });
  await page.locator(".ml-back").click();
  await page.waitForSelector(".mh-page", { timeout: 10000 });
  results.push(`${name}: 返回链路（播放器→列表→首页）${(await page.locator(".mh-page").count()) === 1 ? "✓" : "✗"}`);

  results.push(`${name}: JS 错误 ${errors.length ? "✗ " + errors.join(" | ") : "无 ✓"}`);
  await ctx.close();
}

async function runDesktopCheck(browser, { width, height, name }) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.waitForSelector(".main", { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${name}-desktop.png` });
  const desktopTree = await page.evaluate(() => ({
    topbar: !!document.querySelector(".topbar"),
    activity: !!document.querySelector(".activity-bar"),
    sidebar: !!document.querySelector(".sidebar"),
    playlist: !!document.querySelector(".playlist"),
    mobile: !!document.querySelector(".mobile-shell"),
  }));
  const ok = desktopTree.topbar && desktopTree.activity && desktopTree.sidebar && desktopTree.playlist && !desktopTree.mobile;
  results.push(`${name}: 桌面三栏 ${ok ? "✓" : "✗"} ${JSON.stringify(desktopTree)}`);
  await checkNoHScroll(page, `${name} desktop`);
  results.push(`${name}: JS 错误 ${errors.length ? "✗ " + errors.join(" | ") : "无 ✓"}`);
  await ctx.close();
}

const browser = await chromium.launch();
try {
  // 手机竖屏 / 平板
  await runMobileFlow(browser, { width: 375, height: 812, name: "iphone-375x812" });
  await runMobileFlow(browser, { width: 430, height: 932, name: "iphone-430x932" });
  await runMobileFlow(browser, { width: 768, height: 1024, name: "tablet-768x1024" });
  // 桌面
  await runDesktopCheck(browser, { width: 1280, height: 800, name: "desktop-1280x800" });
  await runDesktopCheck(browser, { width: 1440, height: 900, name: "desktop-1440x900" });
} finally {
  await browser.close();
}

console.log("\n===== 验证结果 =====");
for (const r of results) console.log(r);
const fails = results.filter((r) => r.includes("✗"));
console.log(fails.length ? `\n有 ${fails.length} 项失败` : "\n全部通过 ✓");
