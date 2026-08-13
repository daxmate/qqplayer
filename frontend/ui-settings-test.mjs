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
const flacOn = await page
  .locator(".ext-chip:has-text('FLAC')")
  .evaluate((el) => el.classList.contains("on"));
console.log("点击 FLAC 后选中态:", flacOn);
await page.screenshot({ path: "/tmp/qqp-settings-library-2.png" });

// 恢复默认按钮 → 设置回全选
await page.locator(".reset-btn").click();
await page.waitForTimeout(1000);
const flacBack = await page
  .locator(".ext-chip:has-text('FLAC')")
  .evaluate((el) => el.classList.contains("on"));
console.log("恢复默认后 FLAC 选中态:", flacBack);
const mp3On = await page
  .locator(".ext-chip:has-text('MP3')")
  .evaluate((el) => el.classList.contains("on"));
console.log("MP3 选中态:", mp3On);

// 切到播放分类确认无 JS 错误
await page.locator(".nav-item:has-text('播放')").click();
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/qqp-settings-playback.png" });

// ============ 第四批：界面分类 ============
await page.locator(".nav-item:has-text('界面')").click();
await page.waitForTimeout(400);

// 主题 seg 三选项
const segBtns = await page.locator(".settings-scroll .seg .seg-btn").allTextContents();
console.log("主题选项:", segBtns.join("/"));
// 强调色 swatch 数量
const swatches = await page.locator(".accent-swatch").count();
console.log("强调色 swatch:", swatches);
// 封面模糊/紧凑开关
const blurToggle = await page.locator(".toggle-row:has-text('封面模糊')").count();
const compactToggle = await page.locator(".toggle-row:has-text('紧凑')").count();
console.log("封面模糊开关:", blurToggle, "紧凑开关:", compactToggle);
await page.screenshot({ path: "/tmp/qqp-settings-ui.png" });

// 切浅色主题 → html data-theme
await page.locator(".seg-btn:has-text('浅色')").click();
await page.waitForTimeout(300);
let theme = await page.evaluate(() => document.documentElement.dataset.theme);
console.log("浅色主题 → data-theme =", theme);
await page.screenshot({ path: "/tmp/qqp-settings-light.png" });

// 换强调色 → data-accent
await page.locator(".accent-swatch[title='blue']").click();
await page.waitForTimeout(300);
const accent = await page.evaluate(() => document.documentElement.dataset.accent);
console.log("强调色 blue → data-accent =", accent);

// 开封面模糊 + 紧凑 → data-blur / data-compact
await page.locator(".toggle-row:has-text('封面模糊')").click();
await page.locator(".toggle-row:has-text('紧凑')").click();
await page.waitForTimeout(400);
const blur = await page.evaluate(() => document.documentElement.dataset.blur);
const compact = await page.evaluate(() => document.documentElement.dataset.compact);
console.log("封面模糊 → data-blur =", blur, "紧凑 → data-compact =", compact);
await page.screenshot({ path: "/tmp/qqp-settings-blur-compact.png" });

// 恢复默认 → 主题回深色 / 强调色回 orange / 开关关闭
await page.locator(".reset-btn").click();
await page.waitForTimeout(500);
theme = await page.evaluate(() => document.documentElement.dataset.theme);
const accentBack = await page.evaluate(() => document.documentElement.dataset.accent);
const blurBack = await page.evaluate(() => document.documentElement.dataset.blur);
const compactBack = await page.evaluate(() => document.documentElement.dataset.compact);
console.log(
  "恢复默认 → theme =",
  theme,
  "accent =",
  accentBack,
  "blur =",
  blurBack,
  "compact =",
  compactBack,
);

console.log("JS 错误:", errors.length ? errors : "无");
await browser.close();
