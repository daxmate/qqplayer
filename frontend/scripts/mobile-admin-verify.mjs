// QQPlayer 移动端管理功能验证（A-2：设置弹窗/搜索/歌单拖拽/hover 收尾/平板竖屏）
// 用 chromium 模拟 375x812 / 768x1024 / 1280x800：
//   - 设置弹窗全屏化 + 分类 tab 切换 + AB 循环小节可见 + 返回关闭
//   - 搜索入口（首页顶栏 → 列表自动聚焦过滤）
//   - 歌单拖拽（触摸模拟，CDP dispatchTouchEvent；拖后校验顺序变化，测试后还原）
//   - 指定歌词弹窗（跟唱页打开，窄屏布局）
//   - 无横向滚动 / 无重叠
//   - 桌面 1280：设置/搜索/歌单与改造前一致（居中弹窗 + 左侧导航 + 鼠标拖拽可用）
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "/tmp/qqplayer-mobile-shots";
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const BASE = "http://localhost:5173/";

function push(label, ok, extra = "") {
  const line = `${label}: ${ok ? "✓" : "✗"}${extra ? " " + extra : ""}`;
  results.push(line);
  console.log(line);
  return ok;
}

async function checkNoHScroll(page, label) {
  const { sw, iw, bodySw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    bodySw: document.body.scrollWidth,
  }));
  return push(
    label,
    sw <= iw + 1 && bodySw <= iw + 1,
    `(scrollW=${sw}, innerW=${iw}, body=${bodySw})`,
  );
}

// 元素间无重叠（a 的底部 <= b 的顶部）
async function checkNoOverlap(page, label, selA, selB) {
  const a = await page.locator(selA).boundingBox();
  const b = await page.locator(selB).boundingBox();
  if (!a || !b) return push(label, false, `locator missing: ${selA}=${!!a} ${selB}=${!!b}`);
  return push(
    label,
    a.y + a.height <= b.y + 1,
    `head.bottom=${(a.y + a.height).toFixed(1)} nav.top=${b.y.toFixed(1)}`,
  );
}

// 触摸拖拽（CDP）：from → to，中间可截图
async function touchDrag(cdp, page, from, to, steps = 14) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y }],
  });
  await page.waitForTimeout(120);
  let last = null;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    last = { x, y };
    await page.waitForTimeout(28);
  }
  return last;
}

async function collectPageErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console.error: " + m.text());
  });
  return errors;
}

// ============ 移动端流程（设置 / 搜索 / 拖拽 / 指定歌词） ============
async function runMobileFlow(browser, { width, height, name }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const errors = await collectPageErrors(page);
  const cdp = await ctx.newCDPSession(page);

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".mh-card", { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector(".mh-card-count")?.textContent.includes("首"),
    { timeout: 15000 },
  );
  await page.waitForTimeout(400);

  // ---------- 1. 设置弹窗 ----------
  await page.locator('.mh-icon-btn[title="设置"]').click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  await page.waitForTimeout(400);

  // 全屏化：modal 覆盖整个视口
  const modalBox = await page.locator(".modal").boundingBox();
  const fullscreen =
    modalBox && Math.abs(modalBox.width - width) <= 2 && Math.abs(modalBox.height - height) <= 2;
  push(
    `${name} 设置弹窗全屏`,
    fullscreen,
    `modal=${modalBox ? `${modalBox.width}x${modalBox.height}` : "null"}`,
  );
  // 移动端返回按钮可见
  push(`${name} 顶部返回按钮`, (await page.locator(".modal-back").count()) === 1);
  // 分类 tab 横向排布（side-nav 变顶部横条）
  const nav = await page.locator(".side-nav").boundingBox();
  push(`${name} 分类tab顶部横排`, !!nav && nav.height < 70, `nav h=${nav?.height}`);
  const navItems = page.locator(".side-nav .nav-item");
  const first = await navItems.nth(0).boundingBox();
  const second = await navItems.nth(1).boundingBox();
  push(`${name} tab水平排列`, first && second && Math.abs(first.y - second.y) < 3);
  await page.screenshot({ path: `${OUT}/${name}-s1-settings-playback.png` });
  await checkNoHScroll(page, `${name} 设置弹窗`);
  await checkNoOverlap(page, `${name} 弹窗无重叠`, ".modal-head", ".side-nav");

  // 切分类：音乐库 / 歌词 / 界面
  await navItems.filter({ hasText: "音乐库" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-s2-settings-library.png` });
  await navItems.filter({ hasText: "歌词" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-s3-settings-lyric.png` });
  await navItems.filter({ hasText: "播放" }).click();
  await page.waitForTimeout(300);

  // AB 循环小节：滚动到底可见（B 任务内容不破坏）
  const scroll = page.locator(".settings-scroll");
  await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(300);
  const abTitle = page.locator(".group-title", { hasText: "AB 循环" });
  const abVisible = (await abTitle.count()) === 1 && (await abTitle.isVisible());
  push(`${name} AB循环小节可见`, abVisible);
  const abSwitch = await page.locator(".setting-item", { hasText: "区间可视化" }).count();
  push(`${name} AB循环开关存在`, abSwitch >= 1);
  await page.screenshot({ path: `${OUT}/${name}-s4-settings-abloop.png` });

  // 返回按钮关闭
  await page.locator(".modal-back").click();
  await page.waitForTimeout(400);
  push(`${name} 返回关闭弹窗`, (await page.locator(".modal").count()) === 0);

  // ---------- 2. 搜索（首页顶栏 → 自动聚焦过滤） ----------
  await page.locator('.mh-icon-btn[title="搜索歌曲"]').click();
  await page.waitForSelector(".ml-page", { timeout: 10000 });
  await page.waitForTimeout(500);
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return !!el && el.tagName === "INPUT" && !!el.closest(".ml-search");
  });
  push(`${name} 搜索入口自动聚焦`, focused);
  await page.fill(".ml-search input", "雪");
  await page.waitForTimeout(400);
  const n = await page.locator(".ml-item").count();
  push(`${name} 搜索"雪"过滤`, n >= 1, `${n} 条`);
  await page.screenshot({ path: `${OUT}/${name}-s5-search.png` });
  await checkNoHScroll(page, `${name} 搜索列表`);
  await page.fill(".ml-search input", "");
  await page.waitForTimeout(300);

  // ---------- 3. 歌单拖拽（触摸） ----------
  await page.locator(".ml-back").click();
  await page.waitForSelector(".mh-page", { timeout: 10000 });
  await page.locator(".mh-card", { hasText: "播放列表" }).click();
  await page.waitForSelector(".ml-group", { timeout: 10000 });
  await page.locator(".ml-group", { hasText: "日语歌" }).first().click();
  await page.waitForSelector(".ml-drag", { timeout: 10000 });
  await page.waitForTimeout(500);

  const rows = page.locator(".ml-item");
  const before = [];
  for (let i = 0; i < Math.min(4, await rows.count()); i++) {
    before.push(await rows.nth(i).getAttribute("data-path"));
  }
  push(`${name} 歌单行有拖拽柄`, (await page.locator(".ml-drag").count()) >= 2);

  // 触摸拖拽：第一行 → 第三行位置
  const handle1 = await page.locator(".ml-item").nth(0).locator(".ml-drag").boundingBox();
  const target = await page.locator(".ml-item").nth(2).boundingBox();
  const from = { x: handle1.x + handle1.width / 2, y: handle1.y + handle1.height / 2 };
  const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  await touchDrag(cdp, page, from, to);
  await page.screenshot({ path: `${OUT}/${name}-s6-drag-mid.png` }); // 拖拽中截图（ghost 可见）
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(800);

  const after = [];
  for (let i = 0; i < Math.min(4, await rows.count()); i++) {
    after.push(await rows.nth(i).getAttribute("data-path"));
  }
  const moved = before[0] !== after[0];
  push(
    `${name} 触摸拖拽排序生效`,
    moved,
    `前:${before[0]?.split("/").pop()} → 后:${after[0]?.split("/").pop()}`,
  );
  await page.screenshot({ path: `${OUT}/${name}-s7-drag-after.png` });
  await checkNoHScroll(page, `${name} 歌单列表`);
  // 还原顺序（避免污染真实歌单数据）
  try {
    const res = await page.evaluate(async (paths) => {
      const pls = await (await fetch("/api/playlists")).json();
      const pl = pls.playlists[0];
      await fetch(`/api/playlists/${pl.id}/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      return true;
    }, before);
    push(`${name} 拖拽后还原歌单顺序`, !!res);
  } catch (e) {
    push(`${name} 拖拽后还原歌单顺序`, false, e.message);
  }

  // ---------- 4. 指定歌词弹窗（跟唱页入口，窄屏布局） ----------
  // 返回两层（歌单 → 播放列表入口 → 首页）→ 所有歌曲 → 播放第一首 → 跟唱 → 指定歌词
  await page.locator(".ml-back").click();
  await page.waitForSelector(".ml-group", { timeout: 10000 });
  await page.locator(".ml-back").click();
  await page.waitForSelector(".mh-page", { timeout: 10000 });
  await page.locator(".mh-card").first().click();
  await page.waitForSelector(".ml-item", { timeout: 10000 });
  await page.locator(".ml-item").first().click();
  await page.waitForSelector(".mobile-player", { timeout: 10000 });
  await page.locator(".mp-tab", { hasText: "跟唱" }).click();
  await page.waitForSelector(".karaoke-panel", { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.locator(".kp-spec-btn").click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  await page.waitForTimeout(400);
  const specBox = await page.locator(".modal").boundingBox();
  const specFull = specBox && Math.abs(specBox.width - width) <= 2;
  push(`${name} 指定歌词弹窗全屏`, !!specFull);
  await page.screenshot({ path: `${OUT}/${name}-s8-lyricspec.png` });
  await checkNoHScroll(page, `${name} 指定歌词弹窗`);
  await page.locator(".modal-close").click();
  await page.waitForTimeout(300);

  push(`${name} JS错误`, errors.length === 0, errors.length ? errors.join(" | ") : "");
  await ctx.close();
}

// ============ 桌面流程（1280 无回归） ============
async function runDesktopCheck(browser, { width, height, name }) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: false });
  const page = await ctx.newPage();
  const errors = await collectPageErrors(page);

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".main", { timeout: 15000 });
  await page.waitForTimeout(800);

  // 布局树：桌面三栏，无移动端壳
  const tree = await page.evaluate(() => ({
    topbar: !!document.querySelector(".topbar"),
    activity: !!document.querySelector(".activity-bar"),
    sidebar: !!document.querySelector(".sidebar"),
    playlist: !!document.querySelector(".playlist"),
    mobile: !!document.querySelector(".mobile-shell"),
  }));
  push(
    `${name} 桌面三栏`,
    tree.topbar && tree.activity && tree.sidebar && tree.playlist && !tree.mobile,
  );

  // ---------- 设置弹窗：居中 + 左侧导航（与改造前一致） ----------
  await page.locator('.topbar .gear-btn[title="设置"]').click();
  await page.waitForSelector(".modal", { timeout: 10000 });
  await page.waitForTimeout(400);
  const mBox = await page.locator(".modal").boundingBox();
  const centered = mBox && mBox.width < width * 0.9 && mBox.height < height;
  push(
    `${name} 设置弹窗居中非全屏`,
    !!centered,
    `modal=${mBox ? `${mBox.width}x${mBox.height}` : "null"}`,
  );
  push(`${name} 无移动端返回按钮`, (await page.locator(".modal-back").count()) === 0);
  const ni0 = await page.locator(".side-nav .nav-item").nth(0).boundingBox();
  const ni1 = await page.locator(".side-nav .nav-item").nth(1).boundingBox();
  push(`${name} 左侧导航纵向排列`, ni0 && ni1 && Math.abs(ni0.x - ni1.x) < 3);
  await page.screenshot({ path: `${OUT}/${name}-d1-settings.png` });
  // AB 循环小节
  await page.locator(".settings-scroll").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(300);
  push(
    `${name} 桌面AB循环小节可见`,
    await page.locator(".group-title", { hasText: "AB 循环" }).isVisible(),
  );
  await page.screenshot({ path: `${OUT}/${name}-d2-settings-abloop.png` });
  await page.locator(".modal-close").click();
  await page.waitForTimeout(300);

  // ---------- 搜索（播放列表面板内过滤） ----------
  // 打开侧栏 → 点击全部歌曲 → 播放列表面板出现
  if ((await page.locator(".floating-panel-btn").count()) === 1) {
    await page.locator(".floating-panel-btn").click();
    await page.waitForTimeout(300);
  }
  await page.locator(".sidebar .sb-item", { hasText: "全部歌曲" }).first().click();
  await page.waitForSelector(".pl-search input", { timeout: 10000 });
  await page.fill(".pl-search input", "雪");
  await page.waitForTimeout(400);
  const plN = await page.locator(".pl-item").count();
  push(`${name} 桌面搜索过滤`, plN >= 1, `${plN} 条`);
  await page.screenshot({ path: `${OUT}/${name}-d3-search.png` });
  await page.fill(".pl-search input", "");
  await page.waitForTimeout(300);

  // ---------- 歌单鼠标拖拽（桌面行为不变） ----------
  await page.locator(".sidebar .sb-item", { hasText: "日语歌" }).first().click();
  await page.waitForSelector(".pl-drag", { timeout: 10000 });
  await page.waitForTimeout(500);
  const plRows = page.locator(".pl-item");
  const before = [];
  for (let i = 0; i < Math.min(4, await plRows.count()); i++) {
    before.push(await plRows.nth(i).getAttribute("data-path"));
  }
  const dh = await page.locator(".pl-item").nth(0).locator(".pl-drag").boundingBox();
  const dt = await page.locator(".pl-item").nth(2).boundingBox();
  await page.mouse.move(dh.x + dh.width / 2, dh.y + dh.height / 2);
  await page.mouse.down();
  await page.mouse.move(dt.x + dt.width / 2, dt.y + dt.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after = [];
  for (let i = 0; i < Math.min(4, await plRows.count()); i++) {
    after.push(await plRows.nth(i).getAttribute("data-path"));
  }
  push(
    `${name} 桌面鼠标拖拽排序生效`,
    before[0] !== after[0],
    `前:${before[0]?.split("/").pop()} → 后:${after[0]?.split("/").pop()}`,
  );
  await page.screenshot({ path: `${OUT}/${name}-d4-playlist-drag.png` });
  try {
    await page.evaluate(async (paths) => {
      const pls = await (await fetch("/api/playlists")).json();
      const pl = pls.playlists[0];
      await fetch(`/api/playlists/${pl.id}/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
    }, before);
    push(`${name} 桌面拖拽后还原`, true);
  } catch {
    push(`${name} 桌面拖拽后还原`, false);
  }

  await checkNoHScroll(page, `${name} 桌面`);
  push(`${name} JS错误`, errors.length === 0, errors.length ? errors.join(" | ") : "");
  await ctx.close();
}

const browser = await chromium.launch();
try {
  for (const vp of [
    { width: 375, height: 812, name: "iphone-375x812" },
    { width: 768, height: 1024, name: "tablet-768x1024" },
  ]) {
    try {
      await runMobileFlow(browser, vp);
    } catch (e) {
      console.log(`### ${vp.name} 流程中断: ${e.message}`);
      results.push(`${vp.name}: 流程中断 ✗ ${e.message}`);
    }
  }
  try {
    await runDesktopCheck(browser, { width: 1280, height: 800, name: "desktop-1280x800" });
  } catch (e) {
    console.log(`### desktop 流程中断: ${e.message}`);
    results.push(`desktop-1280x800: 流程中断 ✗ ${e.message}`);
  }
} finally {
  await browser.close();
}

console.log("\n===== 验证结果 =====");
for (const r of results) console.log(r);
const fails = results.filter((r) => r.includes("✗"));
console.log(fails.length ? `\n有 ${fails.length} 项失败` : "\n全部通过 ✓");
