import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto("http://localhost:8765/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// 1. 播放列表
const plItems = await page.locator(".pl-item").count();
console.log("播放列表项:", plItems);
const plText = await page.locator(".pl-item").first().innerText();
console.log("第一项:", plText.replace(/\n/g, " | "));

// 2. 默认选中第一首（yakimochi，有歌词）→ 封面 + 歌词
await page.waitForTimeout(800);
const coverVisible = await page.locator(".cover-img").count();
console.log("封面 img:", coverVisible);
const secCount = await page.locator(".lyric-panel .sec").count();
const lyrCount = await page.locator(".lyric-panel .lyr").count();
console.log("连播歌词 段落:", secCount, "句子:", lyrCount);

// 3. 播放
await page.locator(".btn.play").click();
await page.waitForTimeout(2500);
const playing = await page.locator(".btn.play").innerText();
const curTime = await page.locator(".time").first().innerText();
console.log("播放按钮:", playing, "| 当前时间:", curTime);

// 4. 切跟唱模式
await page.locator(".tab:has-text('跟唱')").click();
await page.waitForTimeout(800);
const kLines = await page.locator(".kline").count();
const kSecs = await page.locator(".karaoke-panel .sec").count();
console.log("跟唱 段落:", kSecs, "句子:", kLines);

// 5. 点第 3 句 → 应跳转播放
await page.locator(".kline").nth(2).click();
await page.waitForTimeout(1500);
const activeText = await page.locator(".kline.active .kline-jp").innerText();
console.log("点击后高亮句:", activeText.slice(0, 30));
const t2 = await page.locator(".time").first().innerText();
console.log("跳转后时间:", t2);

// 6. 变速
const speedBefore = await page.locator(".btn:has-text('x')").innerText();
await page.locator(".btn:has-text('x')").click();
const speedAfter = await page.locator(".btn:has-text('x')").innerText();
console.log("变速:", speedBefore, "->", speedAfter);

// 7. 切无歌词歌曲（知足）
await page.locator(".tab:has-text('连播')").click();
await page.waitForTimeout(400);
await page.locator(".pl-item").nth(1).click();
await page.waitForTimeout(1200);
const noLyric = await page.locator(".no-lyric").innerText();
console.log("无歌词提示:", noLyric.trim());
const cover2 = await page.locator(".cover-img").count();
console.log("知足封面 img:", cover2);

// 8. 跟唱模式无歌词提示
await page.locator(".tab:has-text('跟唱')").click();
await page.waitForTimeout(600);
const empty = await page.locator(".kp-empty").innerText();
console.log("跟唱空态提示:", empty.replace(/\n/g, " / "));

console.log("\nJS 错误:", errors.length ? errors : "无");
await page.screenshot({ path: "/tmp/music-player-karaoke.png", fullPage: false });
await browser.close();
