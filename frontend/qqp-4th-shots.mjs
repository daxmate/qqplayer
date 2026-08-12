// 第四批视觉效果截图：主题/强调色/封面模糊/紧凑模式
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

async function setSettings(obj) {
  await page.evaluate((o) => {
    localStorage.setItem("qqplayer.uiSettings.v1", JSON.stringify(o));
  }, obj);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  // 选第一首歌（让封面/歌词就位）
  const row = page.locator(".song-row").first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(1800);
  }
}

await page.goto("http://localhost:17627/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await setSettings({});
await page.screenshot({ path: "/tmp/qqp-4th-dark-default.png" });

await setSettings({ theme: "light" });
await page.screenshot({ path: "/tmp/qqp-4th-light.png" });

await setSettings({ theme: "light", accent: "blue" });
await page.screenshot({ path: "/tmp/qqp-4th-light-blue.png" });

await setSettings({ theme: "dark", coverBlur: true });
await page.screenshot({ path: "/tmp/qqp-4th-blur.png" });

await setSettings({ theme: "dark", compact: true });
await page.screenshot({ path: "/tmp/qqp-4th-compact.png" });

// 跟唱模式 + 浅色（歌词面板关键场景）
await setSettings({ theme: "light" });
await page.locator(".mode-tabs .tab:has-text('跟唱')").click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/qqp-4th-karaoke-light.png" });

console.log("截图完成");
await browser.close();
