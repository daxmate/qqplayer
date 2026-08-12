import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:17627/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  localStorage.setItem("qqplayer.uiSettings.v1", JSON.stringify({ theme: "dark", coverBlur: true }));
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const row = page.locator(".song-row").first();
if (await row.count()) { await row.click(); await page.waitForTimeout(2000); }
const info = await page.evaluate(() => {
  const blur = document.querySelector(".bg-blur");
  const lyric = document.querySelector(".lyric-panel");
  const cs = getComputedStyle(blur);
  const ls = lyric ? getComputedStyle(lyric) : null;
  return {
    blurExists: !!blur,
    blurBg: blur ? cs.backgroundImage.slice(0, 120) : null,
    blurZ: cs.zIndex,
    blurOpacity: cs.opacity,
    htmlBlur: document.documentElement.dataset.blur,
    currentSong: window.__app ? "?" : null,
    lyricBg: ls ? ls.backgroundColor : null,
    lyricBackdrop: ls ? ls.backdropFilter || ls.webkitBackdropFilter : null,
  };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "/tmp/qqp-blur-debug.png" });
await browser.close();
