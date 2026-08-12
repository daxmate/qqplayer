import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto("http://localhost:17627/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// 打开设置
await page.locator(".gear-btn").click();
await page.waitForTimeout(600);

// 音乐库分类
await page.locator(".nav-item:has-text('音乐库')").click();
await page.waitForTimeout(800); // 等 loadLibrarySettings 返回

// 截图：音乐库设置页
await page.screenshot({ path: "/tmp/qqp-settings-library.png" });

// 文件类型 chip 数量与选中态
const chips = await page.locator(".ext-chip").count();
const onChips = await page.locator(".ext-chip.on").count();
console.log("格式 chip:", chips, "选中:", onChips);

// 开关数量与状态
const switches = await page.locator(".toggle-row .switch").count();
const onSwitches = await page.locator(".toggle-row .switch.on").count();
console.log("开关:", switches, "开启:", onSwitches);

// 交互：点掉 FLAC chip → 应触发保存（后端 audioExts 少一个）
await page.locator(".ext-chip:has-text('FLAC')").click();
await page.waitForTimeout(1000);
const flacOn = await page.locator(".ext-chip:has-text('FLAC')").evaluate((el) => el.classList.contains("on"));
console.log("点击 FLAC 后选中态:", flacOn);
await page.screenshot({ path: "/tmp/qqp-settings-library-2.png" });

// 恢复默认按钮 → 设置回全选
await page.locator(".reset-btn").click();
await page.waitForTimeout(1000);
const flacBack = await page.locator(".ext-chip:has-text('FLAC')").evaluate((el) => el.classList.contains("on"));
console.log("恢复默认后 FLAC 选中态:", flacBack);
const mp3On = await page.locator(".ext-chip:has-text('MP3')").evaluate((el) => el.classList.contains("on"));
console.log("MP3 选中态:", mp3On);

// 切到播放分类确认无 JS 错误
await page.locator(".nav-item:has-text('播放')").click();
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/qqp-settings-playback.png" });

console.log("JS 错误:", errors.length ? errors : "无");
await browser.close();
