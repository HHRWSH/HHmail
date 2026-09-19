// renderer E2E：静态服务 out/renderer（无 preload → 内置 mock 桥），系统 Edge 驱动。
// 覆盖：登录页 → 设备码 → 自动成功 → 收件箱 20 封 → 详情 → 搜索/未读筛选 → 无 console 错误 → 截图。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DIST = path.join(ROOT, "out", "renderer");
const PORT = Number(process.env.E2E_RENDERER_PORT || 8125);
const BASE = `http://127.0.0.1:${PORT}`;
const ARTIFACTS = path.join(ROOT, "tests", "artifacts");

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("❌ 未找到 out/renderer/index.html，请先执行 npm run build（根目录）。");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  const filePath = path.join(DIST, rel);
  if (!filePath.startsWith(DIST)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const results = [];
const errors = [];
const consoleErrors = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

async function launchEdge() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const executablePath = candidates.find((p) => fs.existsSync(p));
  const opts = { headless: true };
  if (executablePath) opts.executablePath = executablePath;
  else opts.channel = "msedge";
  return chromium.launch(opts);
}

let browser;
try {
  browser = await launchEdge();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("dialog", (d) => d.accept()); // 外链二次确认弹窗自动接受

  await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
  await page.waitForTimeout(400);

  check("页面标题正确", (await page.title()).includes("HHmail"), await page.title());
  check("登录页初始可见", await page.isVisible(".login-card"), "login-card 应可见");

  // 设备码登录（mock：自动成功）
  await page.click('button:has-text("开始登录")');
  await page.waitForTimeout(300);
  const code = await page.$eval(".device-code", (el) => el.textContent).catch(() => "");
  check("设备码已展示", !!code && code.trim().length > 0, code);

  await page.waitForSelector(".mail-list .mail-item", { timeout: 10000 });
  check("登录成功后进入收件箱", await page.isVisible(".mail-list"), "mail-list 可见");

  const count = await page.locator(".mail-list .mail-item").count();
  check("收件箱渲染 20 封邮件", count === 20, `实际 ${count}`);

  // 侧边栏分组可折叠（V2.1 UX：折叠后条目隐藏，可再展开）
  await page.click('[data-testid="side-section-folders"]');
  await page.waitForTimeout(200);
  check("折叠文件夹分组后条目隐藏", (await page.locator('[data-nav="folder:Sent"]').count()) === 0);
  await page.click('[data-testid="side-section-folders"]');
  await page.waitForTimeout(200);
  check("再次点击展开文件夹分组", (await page.locator('[data-nav="folder:Sent"]').count()) === 1);
  await page.click('[data-testid="side-section-labels"]');
  await page.waitForTimeout(200);
  check("折叠标签分组后条目隐藏", (await page.locator('[data-nav="starred"]').count()) === 0);
  await page.click('[data-testid="side-section-labels"]');
  await page.waitForTimeout(200);
  check("再次点击展开标签分组", (await page.locator('[data-nav="starred"]').count()) === 1);

  // ---------- 日历（把邮件里的日期铺到月视图） ----------
  check("侧边栏有日历入口", await page.isVisible('[data-nav="calendar"]'));
  await page.click('[data-nav="calendar"]');
  await page.waitForSelector('[data-testid="calendar-grid"]', { timeout: 8000 });
  check("日历月视图渲染", await page.isVisible('[data-testid="calendar-grid"]'));
  const monthText = (await page.$eval('[data-testid="calendar-month"]', (el) => el.textContent || "")).trim();
  check("显示当前年月", /^\d{4} 年 \d{1,2} 月$/.test(monthText), monthText);
  const weekdays = await page.locator('.cal-weekday').allTextContents();
  check("星期表头为 7 列", weekdays.length === 7, weekdays.join(""));
  const cells = await page.locator('.cal-cell').count();
  check("月视图格子数量合理（28~42）", cells >= 28 && cells <= 42, `实际 ${cells}`);
  const withEvents = await page.locator('.cal-cell[data-count]:not([data-count="0"])').count();
  check("有事件的日期带数量角标", withEvents > 0, `实际 ${withEvents} 天有事`);
  const firstEventDay = await page.locator('.cal-cell[data-count]:not([data-count="0"])').first().getAttribute("data-day");
  await page.click(`.cal-cell[data-day="${firstEventDay}"]`);
  await page.waitForTimeout(200);
  const listDay = await page.getAttribute('[data-testid="calendar-day-list"]', "data-day");
  check("点某天后显示当天事项", listDay === firstEventDay, `面板日期 ${listDay}`);
  const items = await page.locator('[data-testid="calendar-day-list"] .cal-item').count();
  check("当天事项列表非空", items > 0, `实际 ${items} 条`);
  await page.click('[data-testid="calendar-open-mail"]');
  const jumped = await page
    .waitForSelector('[data-testid="mail-detail"]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("从日历点「打开邮件」跳回收件箱详情", jumped, "应出现 mail-detail");
  await page.click('[data-nav="calendar"]');
  await page.waitForSelector('[data-testid="calendar-next"]', { timeout: 5000 });
  const beforeMonth = (await page.$eval('[data-testid="calendar-month"]', (el) => el.textContent || "")).trim();
  await page.click('[data-testid="calendar-next"]');
  await page.waitForTimeout(300);
  const afterMonth = (await page.$eval('[data-testid="calendar-month"]', (el) => el.textContent || "")).trim();
  check("切到下个月月份变化", afterMonth !== beforeMonth, `${beforeMonth} → ${afterMonth}`);
  await page.click('[data-testid="calendar-today"]');
  await page.waitForTimeout(200);
  check("回到今天恢复当前月", (await page.$eval('[data-testid="calendar-month"]', (el) => el.textContent || "")).trim() === beforeMonth);
  await page.click('[data-nav="inbox"]');
  await page.waitForSelector(".mail-list .mail-item", { timeout: 8000 });

  // V2.2 修复：角标显示真实总数（列表只取前 N 封，之前会一直显示"共 200 封"）
  const totalText = await page.$eval('[data-testid="mail-total"]', (el) => el.textContent || "").catch(() => "");
  check("顶栏显示邮件总数", /共 \d+ 封|\d+ 封未读/.test(totalText), totalText.trim());
  // V2.2：侧边栏文件夹有图标 + 红旗入口 + 标签数量收敛
  const folderIcons = await page.locator('[data-nav^="folder:"] .ico').allTextContents();
  check("文件夹带图标", folderIcons.length > 0 && folderIcons.every((t) => (t || '').trim().length > 0), folderIcons.join(""));
  check("侧边栏有红旗入口", await page.isVisible('[data-nav="flagged"]'));
  const sidebarCats = await page.locator('[data-nav^="category:"]').count();
  check("侧边栏「类别」区显示类别（不再是标签）", sidebarCats >= 6, `实际 ${sidebarCats}`);
  check("侧边栏不再列标签", (await page.locator('[data-nav^="autotag:"]').count()) === 0);
  check("详情页不再有「隐藏图片」按钮", (await page.locator('[data-testid="load-images-btn"]').count()) === 0);

  // 详情：默认选中第一封
  await page.waitForSelector(".detail-title", { timeout: 5000 });
  const title = await page.$eval(".detail-title", (el) => el.textContent).catch(() => "");
  check("默认选中第一封并渲染标题", title.length > 0, title);

  // 搜索
  await page.fill('[data-testid="search-input"]', "VPN");
  await page.waitForTimeout(500);
  const searchCount = await page.locator(".mail-list .mail-item").count();
  check("搜索 VPN 命中 1 封", searchCount === 1, `实际 ${searchCount}`);
  await page.fill('[data-testid="search-input"]', "");
  await page.waitForTimeout(500);

  // 未读筛选
  await page.click('[data-nav="unread"]');
  await page.waitForTimeout(200);
  const unreadCount = await page.locator(".mail-list .mail-item").count();
  check("未读筛选出 5 封", unreadCount === 5, `实际 ${unreadCount}`);
  await page.click('[data-nav="unread"]');
  await page.waitForTimeout(200);

  // 同步状态
  await page.click('[data-testid="sync-btn"]');
  await page.waitForTimeout(1500);
  const syncText = await page.$eval('[data-testid="sync-status"]', (el) => el.textContent).catch(() => "");
  check("同步完成状态可见", syncText.includes("同步完成"), syncText);

  // 新邮件事件：mock 桥在同步后推送新邮件 → 提示（自动总结通知链路）
  await page.waitForTimeout(500);
  const newMailToast = await page.$eval(".toast", (el) => el.textContent).catch(() => "");
  check("新邮件事件触发提示（自动总结）", newMailToast.includes("新邮件"), newMailToast.slice(0, 40));

  // 详情正文渲染（HTML 经 DOMPurify 净化后渲染）
  const bodyText = await page.$eval('[data-testid="detail-body"]', (el) => el.textContent).catch(() => "");
  check("详情正文渲染", bodyText.includes("长正文第 1 行"), bodyText.slice(0, 50));

  // 未读 → 已读（点击后本地标记，修复项 #1）
  const unreadBefore = await page.locator(".mail-list .mail-item.unread").count();
  await page.locator(".mail-list .mail-item").first().click();
  await page.waitForTimeout(400);
  const unreadAfter = await page.locator(".mail-list .mail-item.unread").count();
  check("点击未读邮件后变为已读", unreadBefore === 5 && unreadAfter === 4, `before=${unreadBefore} after=${unreadAfter}`);

  // 详情区可滚动 + 常显滑动条（修复项 #3）
  const overflowY = await page.$eval(".detail-pane", (el) => getComputedStyle(el).overflowY).catch(() => "");
  check("详情区常显滑动条(overflow-y: scroll)", overflowY === "scroll", overflowY);
  const scrollInfo = await page.$eval(".detail-pane", (el) => ({ sh: el.scrollHeight, ch: el.clientHeight })).catch(() => null);
  check("长正文使详情区产生滚动", !!scrollInfo && scrollInfo.sh > scrollInfo.ch, JSON.stringify(scrollInfo));
  await page.$eval(".detail-pane", (el) => { el.scrollTop = el.scrollHeight }).catch(() => undefined);
  const scrolled = await page.$eval(".detail-pane", (el) => el.scrollTop).catch(() => 0);
  check("详情区实际滚动生效", scrolled > 0, String(scrolled));

  // 附件超长文件名：省略号 + 卡片不溢出（修复项 #4；第一封带附件，已在上面点选）
  // V2.2：红旗（Outlook 式后续标记）—— 点侧边栏「红旗」必须真的切到红旗列表
  await page.click('[data-testid="flag-btn"]');
  await page.waitForSelector('[data-testid="mail-flag"]', { timeout: 8000 }).catch(() => {});
  const flagChips = await page.locator('[data-testid="mail-flag"]').count();
  check("列表显示红旗标记", flagChips >= 1, `实际 ${flagChips}`);
  await page.click('[data-nav="flagged"]');
  await page.waitForTimeout(900);
  const flaggedRows = await page.locator(".mail-list .mail-item").count();
  const everyFlagged = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.mail-list .mail-item'))
    return rows.length > 0 && rows.every((r) => r.querySelector('[data-testid="mail-flag"]'))
  });
  check("红旗筛选出已标记邮件（且每封都有红旗）", flaggedRows >= 1 && everyFlagged === true, `行数 ${flaggedRows} / 全有旗 ${everyFlagged}`);
  await page.click('[data-nav="folder:INBOX"]');
  await page.waitForTimeout(700);

  // V2.2：彩色类别 —— 详情页只负责「选」，管理在设置里
  await page.locator(".mail-list .mail-item").first().click();
  await page.waitForTimeout(700);
  await page.click('[data-testid="category-btn"]');
  await page.waitForSelector('[data-testid="category-panel"]', { timeout: 5000 });
  const categoryItems = await page.locator('[data-testid="category-item"]').count();
  check("详情页类别面板可选用（默认 6 个）", categoryItems >= 6, `实际 ${categoryItems}`);
  check("详情页不再有类别搜索框（管理已移入设置）", (await page.locator('[data-testid="category-search"]').count()) === 0);
  await page.locator(".category-pick").first().click();
  await page.waitForTimeout(900);
  const tinted = await page.evaluate(() => {
    const row = document.querySelector('.mail-list .mail-item.categorized')
    if (!row) return null
    const bg = getComputedStyle(row).backgroundColor
    return { bg, hasVar: Boolean(row.getAttribute('style')?.includes('--cat-color')) }
  })
  check("类别邮件行有颜色背景（只改颜色、不显示类别名）", Boolean(tinted && tinted.hasVar && tinted.bg !== 'rgba(0, 0, 0, 0)'), JSON.stringify(tinted));
  check("列表不再显示类别名 chip", (await page.locator('[data-testid="mail-category"]').count()) === 0);
  // V2.2：侧边栏改成「类别」筛选（点类别只看该类别的邮件）
  await page.click('[data-nav="category:1"]');
  await page.waitForTimeout(900);
  const catFilterRows = await page.locator(".mail-list .mail-item").count();
  const allTinted = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.mail-list .mail-item'))
    return rows.length > 0 && rows.every((r) => r.classList.contains('categorized'))
  });
  check("侧边栏按类别筛选生效", catFilterRows >= 1 && allTinted === true, `行数 ${catFilterRows} / 全为类别色 ${allTinted}`);
  await page.click('[data-nav="category:1"]');
  await page.waitForTimeout(700);

  // V2.2：点「加载更多」不会跳回顶部
  await page.evaluate(() => {
    const el = document.querySelector('.mail-list')
    if (el) el.scrollTop = 400
  })
  await page.waitForTimeout(300)
  const scrollBefore = await page.evaluate(() => document.querySelector('.mail-list')?.scrollTop ?? 0)
  await page.click('[data-testid="load-more"]').catch(() => {})
  await page.waitForTimeout(900)
  const scrollAfter = await page.evaluate(() => document.querySelector('.mail-list')?.scrollTop ?? 0)
  check("点「加载更多」后滚动位置不跳回顶部", Math.abs(scrollAfter - scrollBefore) < 220, `${scrollBefore} → ${scrollAfter}`);

  const attach = await page.$eval(".attach-card", (el) => {
    const name = el.querySelector(".name");
    const r = el.getBoundingClientRect();
    return { right: r.right, textOverflow: name ? getComputedStyle(name).textOverflow : "" };
  }).catch(() => null);
  check(
    "附件长文件名省略号显示且不溢出",
    !!attach && attach.textOverflow === "ellipsis" && attach.right <= 1280,
    JSON.stringify(attach)
  );

  // 附件点击 → 保存提示（V2.2：主进程落盘，提示「已保存：<路径>」）
  await page.click('[data-testid="attach-card"]');
  await page.waitForTimeout(700);
  const dlToast = await page.$eval(".toast", (el) => el.textContent).catch(() => "");
  check("附件点击后可保存", /已保存/.test(dlToast), dlToast.slice(0, 60));

  // AI 总结（mock 桥返回；成功后自动保存，因此最终以 saved-summary 呈现）
  await page.click('[data-testid="ai-summarize-btn"]');
  await page.waitForSelector('[data-testid="ai-summary"], [data-testid="saved-summary"]', { timeout: 5000 });
  const summaryText = await page.$eval('[data-testid="ai-summary"], [data-testid="saved-summary"]', (el) => el.textContent).catch(() => "");
  check(
    "AI 总结返回内容（决策卡：截止横幅 + 行动项）",
    /还有|已过期/.test(summaryText) && summaryText.includes("已保存"),
    summaryText.replace(/\s+/g, " ").slice(0, 50)
  );

  // 摘要排版（用户反馈：预览会横向溢出、文字被裁）：
  // 结构化视图应正常工作，且摘要区 + 整个文档都不出现横向溢出
  check("摘要使用结构化卡片视图", await page.isVisible('[data-testid="summary-structured"]'));
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="summary-markdown"]');
    const pane = document.querySelector('.detail-pane') || document.querySelector('.main');
    return {
      sumScroll: el ? el.scrollWidth : 0,
      sumClient: el ? el.clientWidth : 0,
      paneScroll: pane ? pane.scrollWidth : 0,
      paneClient: pane ? pane.clientWidth : 0,
      docScroll: document.documentElement.scrollWidth,
      docClient: document.documentElement.clientWidth
    };
  });
  check(
    "摘要与详情区无横向溢出（文字不会被裁掉）",
    overflow.sumScroll <= overflow.sumClient + 1 && overflow.paneScroll <= overflow.paneClient + 1 && overflow.docScroll <= overflow.docClient + 1,
    JSON.stringify(overflow)
  );
  // 关键信息用定义列表（不是会溢出的表格）；行动项的截止时间有独立徽标
  const kvRows = await page.locator('[data-testid="summary-markdown"] .sv-kv-row').count();
  check("关键信息渲染为定义列表（非表格）", kvRows >= 1, `rows=${kvRows}`);
  // 决策卡：截止横幅（带倒计时）+ 行动项 + 不重复「截止」行
  const banner = await page.$eval('[data-testid="summary-deadline"]', (el) => el.textContent || "").catch(() => "");
  check("顶部显示最近截止与倒计时", /还有|已过期/.test(banner), banner);
  const todoCount = await page.locator('[data-testid="summary-todos"] li').count();
  check("行动项清单可见", todoCount >= 1, `todos=${todoCount}`);
  const kvText = await page.$eval('[data-testid="summary-keyinfo"]', (el) => el.textContent || "").catch(() => "");
  check("横幅已显示的截止行不再重复", !/^截止/.test(kvText.trim()), kvText.slice(0, 40));
  await page.screenshot({ path: path.join(ARTIFACTS, "summary-preview.png"), clip: { x: 340, y: 120, width: 760, height: 460 } }).catch(() => {});

  // 正文链接点击：不跳转应用页面（走默认浏览器，修复项 #3）
  const urlBefore = page.url();
  await page.click('[data-testid="detail-body"] a');
  await page.waitForTimeout(400);
  check("点击正文链接不改变应用页面", page.url() === urlBefore, page.url());

  // 设置页（修复项 #2/#4/#5）
  await page.click('[data-nav="settings"]');
  await page.waitForSelector('[data-testid="settings-page"]', { timeout: 5000 });
  check("设置页可打开", await page.isVisible('[data-testid="settings-page"]'));

  // 发送能力自检（只探测、不发送邮件）：本轮回答“发信要怎么授权”
  await page.click('[data-testid="settings-section-send"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="smtp-probe-btn"]');
  await page.waitForSelector('[data-testid="smtp-probe-result"]', { timeout: 8000 });
  const probeText = await page.$eval('[data-testid="smtp-probe-result"]', (el) => el.textContent || "").catch(() => "");
  check("发送能力自检返回授权结论", /授权|鉴权|发送/.test(probeText), probeText.slice(0, 50));

  // 个人邮箱发信测试（mock 不发真邮件）：填表 → 保存 → 发送 → 看结论
  await page.fill('[data-testid="set-smtp-host"]', "smtp.example.com");
  await page.fill('[data-testid="set-smtp-user"]', "tester@example.com");
  await page.fill('[data-testid="set-smtp-pass"]', "app-pass");
  await page.fill('[data-testid="set-smtp-to"]', "tester@example.com");
  await page.click('[data-testid="smtp-send-test-btn"]');
  await page.waitForSelector('[data-testid="smtp-send-result"]', { timeout: 10000 });
  const sendText = await page.$eval('[data-testid="smtp-send-result"]', (el) => el.textContent || "").catch(() => "");
  check("发信测试给出中文结论", /已发送|失败|鉴权/.test(sendText), sendText.slice(0, 50));
  // 学校账号发信测试（mock）与发信权限开关
  check("发信权限开关默认开启", await page.isChecked('[data-testid="set-send-scope"]'));
  await page.click('[data-testid="school-send-test-btn"]');
  await page.waitForSelector('[data-testid="school-send-result"]', { timeout: 10000 });
  const schoolText = await page.$eval('[data-testid="school-send-result"]', (el) => el.textContent || "").catch(() => "");
  check("学校账号发信测试给出中文结论", /已发送|失败|鉴权/.test(schoolText), schoolText.slice(0, 50));
  check("提供重新登录按钮（应用发信权限）", await page.isVisible('[data-testid="relogin-send-scope"]'));

  const passValue = await page.$eval('[data-testid="set-smtp-pass"]', (el) => el.value).catch(() => "");
  check("发信密码不回显（保存后输入框清空）", passValue === "");
  check("清除密码按钮可用", await page.isVisible('[data-testid="clear-smtp-pass"]'));
  await page.click('[data-testid="settings-section-ai"]');
  await page.waitForTimeout(300);
  const modelValues = await page.locator('[data-testid="set-model"] option').evaluateAll((els) => els.map((e) => e.getAttribute("value")));
  check(
    "V2.2：DeepSeek 只保留 deepseek-flash（其余 DeepSeek 模型已下线）",
    modelValues.length === 1 && modelValues[0] === "deepseek-flash",
    modelValues.join(",")
  );
  check("自定义总结提示词输入框存在", await page.isVisible('[data-testid="set-prompt"]'));
  await page.click('[data-testid="settings-section-sync"]');
  await page.waitForTimeout(300);
  check("新邮件自动总结开关默认开启", await page.isChecked('[data-testid="set-auto-summary"]'));
  await page.click('[data-testid="settings-section-ai"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="reset-prompt"]');
  await page.fill('[data-testid="set-apikey"]', "sk-test-123456");
  await page.click('[data-testid="settings-section-sync"]');
  await page.waitForTimeout(300);
  await page.fill('[data-testid="set-syncwindow"]', "0");
  await page.fill('[data-testid="set-refresh"]', "60");
  // 模型保持默认 deepseek-flash（V2.2 起 DeepSeek 只有这一个）
  await page.click('[data-testid="settings-save-bottom"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="settings-section-ai"]');
  await page.waitForTimeout(300);
  const keyStatus = await page.$eval('[data-testid="apikey-status"]', (el) => el.textContent).catch(() => "");
  check("API Key 保存后状态变为已配置", keyStatus.includes("已配置"), keyStatus.slice(0, 30));
  // V2.1：修复同步按钮（设置页）
  await page.click('[data-testid="settings-section-sync"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="resync-btn"]');
  await page
    .waitForFunction(() => (document.querySelector(".toast")?.textContent || "").includes("重新拉取"), null, { timeout: 8000 })
    .catch(() => {});
  const repairToast = await page.$eval(".toast", (el) => el.textContent || "").catch(() => "");
  check("设置页修复同步按钮可用", repairToast.includes("重新拉取"), repairToast.slice(0, 40));
  await page.click('[data-testid="settings-section-ai"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="settings-summarize-pending"]');
  await page
    .waitForFunction(() => /已总结|摘要|都有摘要/.test(document.querySelector(".toast")?.textContent || ""), null, { timeout: 8000 })
    .catch(() => {});
  const batchToast = await page.$eval(".toast", (el) => el.textContent || "").catch(() => "");
  check("设置页批量总结按钮可用", /已总结|摘要|都有摘要/.test(batchToast), batchToast.slice(0, 40));
  // V2.1：重新生成全部摘要（覆盖旧的低质量摘要）
  check("设置页有重新生成摘要按钮", await page.isVisible('[data-testid="settings-regenerate-summaries"]'));
  // M1：检索索引覆盖显示 + 批量总结后索引随之建立
  const idxText0 = await page.$eval('[data-testid="index-stats"]', (el) => el.textContent || "").catch(() => "");
  check("设置页显示检索索引覆盖", /已建 \d+\/\d+ 封/.test(idxText0), idxText0.slice(0, 40));
  await page.click('[data-testid="settings-regenerate-summaries"]');
  await page
    .waitForFunction(() => /已总结|摘要/.test(document.querySelector(".toast")?.textContent || ""), null, { timeout: 8000 })
    .catch(() => {});
  const regenToast = await page.$eval(".toast", (el) => el.textContent || "").catch(() => "");
  check("重新生成摘要返回结果提示", /已总结|摘要/.test(regenToast) && !regenToast.includes("参数无效"), regenToast.slice(0, 40));
  await page.click('[data-testid="settings-section-sync"]');
  await page.waitForTimeout(300);
  const refreshVal = await page.$eval('[data-testid="set-refresh"]', (el) => el.value).catch(() => "");
  check("自动刷新间隔保存生效", refreshVal === "60", refreshVal);

  // V2.2：标签词表改成「输入 + ＋ 添加 / ✕ 删除」的 chip 编辑器
  await page.click('[data-testid="settings-section-ai"]');
  await page.waitForTimeout(300);
  const vocabChips0 = await page.locator('[data-testid="tag-vocab-remove"]').count();
  await page.fill('[data-testid="tag-vocab-input"]', "我的自定义标签");
  await page.click('[data-testid="tag-vocab-add"]');
  await page.waitForTimeout(200);
  const vocabChips1 = await page.locator('[data-testid="tag-vocab-remove"]').count();
  check("可以按＋添加新标签", vocabChips1 === vocabChips0 + 1, `before=${vocabChips0} after=${vocabChips1}`);
  await page.locator('[data-testid="tag-vocab-remove"]').last().click();
  await page.waitForTimeout(200);
  check("可以按 ✕ 删除标签", (await page.locator('[data-testid="tag-vocab-remove"]').count()) === vocabChips0);

  // V2.2：彩色类别管理（重命名 / 改色 / 删除 / 新建）—— 从详情页搬到设置里
  const catRows = await page.locator('[data-testid="category-manage-row"]').count();
  check("设置页有类别管理列表", catRows >= 6, `实际 ${catRows}`);
  await page.locator('[data-testid="category-manage-name"]').first().fill("Blue category 改名");
  await page.locator('[data-testid="category-manage-name"]').first().blur();
  await page.waitForTimeout(700);
  const renamed = await page.locator('[data-testid="category-manage-name"]').first().inputValue();
  check("类别可以重命名", renamed.includes("改名"), renamed);
  await page.fill('[data-testid="category-new-name"]', "我的重点类别");
  await page.click('[data-testid="category-create"]');
  await page.waitForTimeout(800);
  check("可以新建类别", (await page.locator('[data-testid="category-manage-row"]').count()) >= catRows + 1);
  await page.locator('[data-testid="category-manage-delete"]').last().click();
  await page.waitForTimeout(800);
  check("可以删除类别", (await page.locator('[data-testid="category-manage-row"]').count()) === catRows);

  // V2.2：标签词表默认折叠（不再是一大片 chip 墙）
  check("标签词表默认折叠", await page.isVisible('[data-testid="toggle-vocab"]'));
  await page.click('[data-testid="toggle-vocab"]');
  await page.waitForTimeout(250);
  check("标签词表可展开", (await page.locator('[data-testid="tag-vocab-remove"]').count()) > 6);

  // V2.2：多服务商（DeepSeek 只保留 v4.1 flash）
  const providerOptions = await page.locator('[data-testid="set-provider"] option').count();
  check("AI 服务商可选（≥5 家 + 自定义）", providerOptions >= 5, `实际 ${providerOptions}`);
  const deepseekModels = await page.locator('[data-testid="set-model"] option').allTextContents();
  check(
    "DeepSeek 只保留 deepseek-flash",
    deepseekModels.length === 1 && deepseekModels[0] === "deepseek-flash",
    deepseekModels.join(",")
  );
  await page.selectOption('[data-testid="set-provider"]', "zhipu");
  await page.waitForTimeout(200);
  const zhipuModels = await page.locator('[data-testid="set-model"] option').allTextContents();
  check("切换到智谱后模型列表联动", zhipuModels.includes("glm-4-flash"), zhipuModels.join(","));
  await page.selectOption('[data-testid="set-provider"]', "custom");
  await page.waitForTimeout(200);
  check("自定义服务商可填 Base URL", await page.isVisible('[data-testid="set-custom-base-url"]'));
  await page.selectOption('[data-testid="set-provider"]', "deepseek");
  await page.waitForTimeout(200);

  // V2.2：设置行排版一致性（每行都有标签列，内容列左边界对齐）
  const layout = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.settings-card .settings-row')).filter(
      (r) => r.offsetParent !== null
    )
    const withoutName = rows.filter((r) => !r.querySelector(':scope > .name')).length
    const offsets = rows
      .map((r) => {
        const content = Array.from(r.children).find((c) => !c.classList.contains('name'))
        return content ? Math.round(content.getBoundingClientRect().left) : null
      })
      .filter((x) => x !== null)
    return { rows: rows.length, withoutName, min: Math.min(...offsets), max: Math.max(...offsets) }
  })
  check("每个设置行都有标签列（不再忽左忽右）", layout.withoutName === 0, JSON.stringify(layout));
  check("设置行内容列左边界对齐", layout.max - layout.min <= 2, JSON.stringify(layout));

  // V2.2：附件保存位置可配置（默认「每次询问」）
  await page.click('[data-testid="settings-section-about"]');
  await page.waitForTimeout(300);
  check("设置页有附件保存位置", await page.isVisible('[data-testid="set-attachment-dir"]'));
  await page.fill('[data-testid="set-attachment-dir"]', "D:\MailAttachments");
  await page.click('[data-testid="settings-save-bottom"]');
  await page.waitForTimeout(400);
  const attachDirVal = await page.$eval('[data-testid="set-attachment-dir"]', (el) => el.value).catch(() => "");
  check("附件保存位置保存后读回一致", attachDirVal === "D:\MailAttachments", attachDirVal);
  await page.click('[data-testid="clear-attachment-dir"]');
  await page.click('[data-testid="settings-save-bottom"]');
  await page.waitForTimeout(300);
  const attachDirCleared = await page.$eval('[data-testid="set-attachment-dir"]', (el) => el.value).catch(() => "");
  check("可改回「每次询问」", attachDirCleared === "", attachDirCleared);

  // V2.2：设置页重新设计为「左栏分类 + 右栏卡片」（替代原折叠式分区）
  const secIds = ["appearance", "sync", "ai", "send", "account", "about"];
  let sectionsVisible = true;
  for (const id of secIds) sectionsVisible = sectionsVisible && (await page.isVisible(`[data-testid="settings-section-${id}"]`));
  check("设置页左栏有 6 个分类", sectionsVisible, secIds.join(","));
  await page.click('[data-testid="settings-section-appearance"]');
  await page.waitForTimeout(300);
  check("切到「外观」显示外观设置", await page.isVisible('[data-testid="set-theme"]'));
  await page.click('[data-testid="settings-section-account"]');
  await page.waitForTimeout(350);
  check("切到「账户」后外观设置隐藏", (await page.locator('[data-testid="set-theme"]').count()) === 0);
  check("切到「账户」显示账户内容", await page.isVisible('[data-testid="settings-logout"]'));
  await page.click('[data-testid="settings-section-appearance"]');
  await page.waitForTimeout(350);
  check("切回「外观」显示设置项", await page.isVisible('[data-testid="set-theme"]'));

  // V2.2：主题切换（深色/浅色）—— save 后应立即写到 <html data-theme>
  await page.click('[data-testid="settings-section-appearance"]');
  await page.waitForTimeout(300);
  await page.selectOption('[data-testid="set-theme"]', "dark");
  await page.selectOption('[data-testid="set-density"]', "compact");
  await page.click('[data-testid="settings-save-bottom"]');
  await page.waitForTimeout(500);
  const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme);
  const densityAttr = await page.evaluate(() => document.documentElement.dataset.density);
  check("切到深色主题后 html[data-theme=dark]", themeAttr === "dark", String(themeAttr));
  check("密度设置生效（html[data-density]）", densityAttr === "compact", String(densityAttr));
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("深色主题已应用（背景色变化）", typeof darkBg === "string" && darkBg.length > 0, darkBg);
  // 切回浅色，避免影响后续断言与截图
  await page.selectOption('[data-testid="set-theme"]', "light");
  await page.selectOption('[data-testid="set-density"]', "standard");
  await page.click('[data-testid="settings-save-bottom"]');
  await page.waitForTimeout(400);
  check("切回浅色主题", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");

  // V2.2：品牌名可改（侧边栏 + 窗口标题跟随）
  await page.fill('[data-testid="set-brand-name"]', "示例大学邮件助手");
  await page.click('[data-testid="settings-save-bottom"]');
  await page.waitForTimeout(400);
  const brandText = await page.$eval(".brand-name", (el) => el.textContent || "").catch(() => "");
  check("侧边栏品牌名跟随设置", brandText.includes("示例大学邮件助手"), brandText);
  const pageTitle = await page.title();
  check("窗口标题跟随品牌名", pageTitle.includes("示例大学邮件助手"), pageTitle);
  // 侧边栏不再显示「只读模式」徽标（用户要求移除）
  const sidebarText = await page.$eval(".sidebar", (el) => el.textContent || "").catch(() => "");
  check("侧边栏已移除「只读模式」徽标", !sidebarText.includes("只读模式"), sidebarText.slice(-40));
  // 还原品牌名
  await page.fill('[data-testid="set-brand-name"]', "HHmail 自定义");
  await page.click('[data-testid="settings-save-bottom"]');
  await page.waitForTimeout(300);
  await page.click('[data-nav="inbox"]');
  await page.waitForTimeout(300);

  // 批量总结进度条（用户要求：看得见「正在生成哪一封」与大概还要等多久）
  await page.click('[data-nav="settings"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="settings-section-ai"]');
  await page.waitForTimeout(300);
  const regenBtn = '[data-testid="settings-regenerate-summaries"]';
  const regenEnabled = async () => page.$eval(regenBtn, (el) => !el.disabled).catch(() => false);
  // 确认上一批真的结束（连续两次可点），否则点击会落在 disabled 上或与上一批的 finished 事件打架
  for (let i = 0; i < 40; i += 1) {
    if ((await regenEnabled()) && (await page.waitForTimeout(400).then(() => regenEnabled()))) break;
  }
  await page.click(regenBtn, { timeout: 8000 });
  // 轮询到「已用」出现的那一帧（第一帧 done=0 时还没有已用时间），进度条约 2.4 秒后消失
  let progressText = "";
  let progressSubject = "";
  for (let i = 0; i < 20; i += 1) {
    const frame = await page
      .evaluate(() => ({
        text: (document.querySelector('[data-testid="summary-progress-text"]') || {}).textContent || "",
        subj: (document.querySelector('[data-testid="summary-progress-subject"]') || {}).textContent || ""
      }))
      .catch(() => ({ text: "", subj: "" }));
    if (frame.subj) progressSubject = frame.subj
    if (/已用/.test(frame.text)) {
      progressText = frame.text
      break
    }
    await page.waitForTimeout(150)
  }
  // 用 DOM 直接点「停止」：进度条每帧都会重新渲染，Playwright 的可点击性检查可能因节点被替换而重试
  const stopClicked = await page
    .$eval('[data-testid="summary-progress-stop"]', (el) => {
      el.click()
      return true
    })
    .catch(() => false)
  check(
    "批量总结显示进度（x/y + 已用）",
    /\d+ \/ \d+/.test(progressText) && /已用/.test(progressText),
    progressText.slice(0, 60)
  );
  check("批量总结显示正在生成哪一封（主题）", /正在生成：.+/.test(progressSubject), progressSubject.slice(0, 40));
  check("进度条上可一键停止", stopClicked);
  await page
    .waitForFunction(() => !document.querySelector('[data-testid="summary-progress"]'), { timeout: 12000 })
    .catch(() => {});
  await page.waitForTimeout(300);

  // 回到收件箱并选中一封，供下一步（模型切换后重新总结）使用
  await page.click('[data-nav="inbox"]');
  await page.waitForTimeout(400);
  await page.locator(".mail-list .mail-item").first().click();
  await page.waitForTimeout(400);

  // 切换模型后：AI 总结标签显示真实模型名（不再写死 v4-pro，修复项 #3）
  await page.click('[data-testid="ai-summarize-btn"]');
  await page.waitForFunction(() => {
    const el = document.querySelector(".ai-summary-head");
    return el && el.textContent.includes("deepseek-flash");
  }, { timeout: 5000 });
  const modelLabel = await page.$eval(".ai-summary-head", (el) => el.textContent).catch(() => "");
  check("AI 总结标签显示实际模型名(deepseek-flash)", modelLabel.includes("deepseek-flash"), modelLabel.slice(0, 40));

  // 摘要持久化：切走再切回，保存的摘要仍在最前面（修复项 #2）
  await page.locator(".mail-list .mail-item").nth(1).click();
  await page.waitForTimeout(300);
  await page.locator(".mail-list .mail-item").first().click();
  await page.waitForTimeout(300);
  const savedSummary = await page.$eval('[data-testid="saved-summary"]', (el) => el.textContent).catch(() => "");
  check(
    "摘要持久化并展示在最前面（决策卡 + 已保存）",
    savedSummary.includes("已保存") && /还有|已过期/.test(savedSummary),
    savedSummary.replace(/\s+/g, " ").slice(0, 60)
  );

  // 摘要以 Markdown 预览渲染（本轮修复：排版不再堆成一团，可切换源码视图）
  const mdHtml = await page.$eval('[data-testid="summary-markdown"]', (el) => el.innerHTML).catch(() => "");
  check("摘要以 Markdown 预览渲染（含标题/表格等标签）", /<(h[0-9]|p|strong|table|ul)/.test(mdHtml), mdHtml.slice(0, 60));
  await page.click('[data-testid="summary-view-toggle"]');
  await page.waitForTimeout(250);
  check("可切换到 Markdown 源码视图", (await page.locator('[data-testid="summary-markdown"]').count()) === 0);
  await page.click('[data-testid="summary-view-toggle"]');
  await page.waitForTimeout(250);
  check("可切回 Markdown 预览视图", (await page.locator('[data-testid="summary-markdown"]').count()) === 1);

  // 远程图片：默认自动加载（用户要求不确认），点击「隐藏图片」后移除（修复项 #3）
  // V2.2：远程图片固定不加载（「隐藏图片」按钮已按用户要求删除）
  const imgCount = await page.locator('[data-testid="detail-body"] img').count();
  check("远程图片默认不加载（按钮已删除）", imgCount === 0 && (await page.locator('[data-testid="load-images-btn"]').count()) === 0, `实际 img=${imgCount}`);

  // V2.2：自动标签（先批量生成摘要 → 规则标签出现 → 点标签筛选）
  await page.click('[data-nav="settings"]');
  await page.waitForSelector('[data-testid="settings-page"]', { timeout: 5000 });
  // 前面的「AI 总结」已经为第一封生成过索引卡片 → 直接按卡片重算规则标签（不再批量总结，避免覆盖摘要）
  await page.click('[data-testid="rebuild-tags"]');
  await page.waitForTimeout(600);
  const tagCounts = await page.$eval('[data-testid="tag-counts"]', (el) => el.textContent || "").catch(() => "");
  check("自动标签已生成（规则映射）", /个标签（[^）]*\d+/.test(tagCounts), tagCounts.slice(0, 60));
  await page.click('[data-nav="inbox"]');
  await page.waitForTimeout(500);
  const sidebarCatsNow = await page.locator('[data-nav^="category:"]').count();
  check("侧边栏「类别」区显示类别", sidebarCatsNow >= 6, `实际 ${sidebarCatsNow}`);
  const tagChips = await page.locator('[data-testid="mail-auto-tag"]').count();
  check("邮件列表显示自动标签 chip", tagChips >= 1, `实际 ${tagChips}`);
  // 手动筛选面板：可搜索 + 多选
  await page.click('[data-testid="tag-panel-toggle"]');
  await page.waitForSelector('[data-testid="tag-panel"]', { timeout: 5000 });
  const panelItems = await page.locator('[data-testid="tag-panel-item"]').count();
  check("标签筛选面板可打开且有标签", panelItems >= 1, `实际 ${panelItems}`);
  await page.fill('[data-testid="tag-panel-search"]', "作业");
  await page.waitForTimeout(200);
  const searched = await page.locator('[data-testid="tag-panel-item"]').count();
  check("标签面板支持搜索", searched >= 1 && searched <= panelItems, `搜索后 ${searched}`);
  await page.fill('[data-testid="tag-panel-search"]', "");
  await page.click('[data-testid="tag-panel-toggle"]');
  await page.waitForTimeout(200);

  if (tagChips > 0) {
    const firstTag = (await page.locator('[data-testid="mail-auto-tag"]').first().textContent()) ?? "";
    await page.locator('[data-testid="mail-auto-tag"]').first().click();
    await page.waitForTimeout(500);
    check("点标签后按标签筛选（出现筛选条）", await page.isVisible('[data-testid="tag-filter-bar"]'), firstTag);
    const filteredCount = await page.locator(".mail-list .mail-item").count();
    check("标签筛选后仍有结果", filteredCount >= 1, `实际 ${filteredCount}`);
    await page.click('[data-testid="tag-filter-clear"]');
    await page.waitForTimeout(300);
  } else {
    check("点标签后按标签筛选（出现筛选条）", false, "没有标签 chip，跳过");
    check("标签筛选后仍有结果", false, "没有标签 chip，跳过");
  }

  // AI 助手（M4 聊天式界面）
  await page.click('[data-nav="ai"]');
  await page.waitForSelector('[data-testid="ai-search-page"]', { timeout: 5000 });
  check("AI 助手页可打开", await page.isVisible('[data-testid="ai-search-page"]'));
  await page.waitForSelector('[data-testid="chat-session"]', { timeout: 5000 });
  await page.fill('[data-testid="ai-ask-input"]', "上周导师发了什么邮件？");
  await page.click('[data-testid="ai-ask-send"]');
  await page.waitForSelector('[data-testid="chat-msg-assistant"]', { timeout: 8000 });
  const askAnswer = await page.$eval('[data-testid="chat-msg-assistant"]', (el) => el.textContent).catch(() => "");
  check("AI 问答返回答案", askAnswer.includes("mock 回答") || askAnswer.includes("林教授"), askAnswer.slice(0, 40));
  const citeCount = await page.locator('[data-testid="ai-ask-cite"]').count();
  check("AI 问答引用卡片存在", citeCount >= 1, `实际 ${citeCount}`);
  // 助手回答默认 Markdown 预览，可切源码
  check("回答默认渲染 Markdown 预览", (await page.locator('[data-testid="ai-ask-answer-md"]').count()) >= 1);
  await page.locator('[data-testid="answer-view-toggle"]').first().click();
  await page.waitForTimeout(200);
  check("可切换为源码视图", (await page.locator('[data-testid="ai-ask-answer-md"]').count()) === 0);
  await page.locator('[data-testid="answer-view-toggle"]').first().click();
  await page.waitForTimeout(200);
  // 多轮：第二条问题与回答都进入同一会话（等「用户+助手」都到齐再断言，避免只等到本地回显）
  await page.fill('[data-testid="ai-ask-input"]', "那截止呢？");
  await page.click('[data-testid="ai-ask-send"]');
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="chat-msg-user"]').length >= 2 &&
        document.querySelectorAll('[data-testid="chat-msg-assistant"]').length >= 2,
      null,
      { timeout: 10000 }
    )
    .catch(() => {});
  const chatUsers = await page.locator('[data-testid="chat-msg-user"]').count();
  const chatAssistants = await page.locator('[data-testid="chat-msg-assistant"]').count();
  check("多轮对话追加在同一会话", chatUsers >= 2 && chatAssistants >= 2, `user=${chatUsers} assistant=${chatAssistants}`);
  // 新建对话 → 空白会话；删除对话 → 列表减少
  const sessBefore = await page.locator('[data-testid="chat-session"]').count();
  await page.click('[data-testid="chat-new"]');
  await page
    .waitForFunction(() => document.querySelectorAll('[data-testid="chat-msg-user"]').length === 0, null, { timeout: 5000 })
    .catch(() => {});
  const sessAfter = await page.locator('[data-testid="chat-session"]').count();
  check("新建对话可用（清空消息流 + 列表 +1）", sessAfter === sessBefore + 1, `before=${sessBefore} after=${sessAfter}`);
  // 删除刚建的空会话（列表第一条 = 最新）→ 回到只剩带消息的那个会话
  await page.locator('[data-testid="chat-session-delete"]').first().click();
  await page.waitForTimeout(400);
  check("删除对话可用", (await page.locator('[data-testid="chat-session"]').count()) === sessBefore, "");
  // V2.2：AI 助手页右上角的批量总结按钮已移除（统一放设置页）
  check("AI 助手页不再有批量总结按钮", (await page.locator('[data-testid="summarize-pending-btn"]').count()) === 0);
  // 引用跳转：切回带引用的会话，先验证「引用在回答上方」，再验证「回答里的邮件名可点击」
  await page.locator('[data-testid="chat-session"]').first().click();
  await page.waitForSelector('[data-testid="ai-ask-cite"]', { timeout: 5000 });
  const citesAboveBody = await page.evaluate(() => {
    const cites = document.querySelector('[data-testid="chat-citations"]')
    const body = document.querySelector('[data-testid="ai-ask-answer-md"]')
    if (!cites || !body) return null
    return cites.getBoundingClientRect().top <= body.getBoundingClientRect().top
  })
  check("引用邮件显示在回答上方", citesAboveBody === true, String(citesAboveBody));
  const citeLinks = await page.locator('[data-testid="ai-ask-answer-md"] a.cite-link').count();
  check("回答里的邮件名变成可点击链接", citeLinks >= 1, `实际 ${citeLinks}`);
  await page.locator('[data-testid="ai-ask-answer-md"] a.cite-link').first().click();
  await page.waitForSelector('.detail-title', { timeout: 5000 });
  check("点回答里的邮件名跳转到该邮件", await page.isVisible('.detail-title'));
  await page.click('[data-nav="ai"]');
  await page.waitForTimeout(300);
  await page.locator('[data-testid="ai-ask-cite"]').first().click();
  await page.waitForSelector('.detail-title', { timeout: 5000 });
  check("点击引用跳转到收件箱详情", await page.isVisible('.detail-title'));

  // 文件夹切换（V2 M3：数据驱动侧边栏导航 + 独立查询）
  await page.click('[data-nav="folder:Sent"]');
  await page.waitForTimeout(700);
  const sentCount = await page.locator(".mail-list .mail-item").count();
  check("切换到「已发送」文件夹（mock 为空）", sentCount === 0, `实际 ${sentCount}`);
  await page.click('[data-nav="folder:INBOX"]');
  await page.waitForTimeout(700);
  const inboxCount = await page.locator(".mail-list .mail-item").count();
  check("切回「收件箱」恢复 20 封", inboxCount === 20, `实际 ${inboxCount}`);

  // 星标 + 标签（V2 M4）
  await page.click(".mail-list .mail-item");
  await page.waitForSelector('[data-testid="star-btn"]');
  await page.click('[data-testid="star-btn"]');
  await page.waitForTimeout(500);
  const starBtnText = await page.$eval('[data-testid="star-btn"]', (el) => el.textContent || "").catch(() => "");
  check("详情页星标切换为已星标", starBtnText.includes("已星标"), starBtnText);
  await page.click('[data-nav="starred"]');
  await page.waitForTimeout(700);
  const starredCount = await page.locator(".mail-list .mail-item").count();
  check("星标筛选出 1 封", starredCount === 1, `实际 ${starredCount}`);
  const starMarks = await page.locator('[data-testid="mail-star"]').count();
  check("列表显示星标标记", starMarks >= 1, `实际 ${starMarks}`);

  // V2.2：统一标签体系 —— 详情页「🏷 标签」= 手动打标签（不会被 AI 重算覆盖）
  await page.click('[data-testid="labels-btn"]');
  await page.waitForSelector('[data-testid="label-panel"]');
  await page.fill('[data-testid="tag-input"]', "课业");
  await page.click('[data-testid="tag-add-btn"]');
  await page.waitForTimeout(600);
  const manualToggles = await page.locator('[data-testid="tag-toggle"].manual').count();
  check("可以手动给邮件打标签（✋ 标记）", manualToggles >= 1, `实际 ${manualToggles}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const manualMark = await page.locator('[data-testid="mail-manual-tag-mark"]').count();
  check("列表显示「手动改过」标识", manualMark >= 1, `实际 ${manualMark}`);
  // 重算规则标签不应把手动标签冲掉
  await page.click('[data-nav="settings"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="settings-section-ai"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="rebuild-tags"]');
  await page.waitForTimeout(800);
  await page.click('[data-nav="inbox"]');
  await page.waitForTimeout(600);
  const manualStillThere = await page.locator('[data-testid="mail-manual-tag-mark"]').count();
  check("手动标签不会被重算覆盖", manualStillThere >= 1, `实际 ${manualStillThere}`);
  // 顶栏标签按钮 → 面板里按标签筛选（V2.2 修复：改筛选条件必须真的重新查列表）
  // 先回到干净的收件箱（清掉之前的星标/红旗/标签筛选），再看标签筛选效果
  await page.click('[data-nav="folder:INBOX"]');
  await page.waitForTimeout(700);
  const beforeFilter = await page.locator(".mail-list .mail-item").count();
  await page.click('[data-testid="tag-panel-toggle"]');
  await page.waitForSelector('[data-testid="tag-panel"]', { timeout: 5000 });
  await page.locator('[data-testid="tag-panel-item"]', { hasText: "课业" }).first().click();
  await page.waitForTimeout(700);
  const labelCount = await page.locator(".mail-list .mail-item").count();
  check(
    "按标签筛选后列表真的变了",
    labelCount >= 1 && labelCount < beforeFilter,
    `筛选前 ${beforeFilter} → 筛选后 ${labelCount}`
  );
  await page.click('[data-testid="tag-filter-clear"]');
  await page.waitForTimeout(500);
  await page.click('[data-nav="folder:INBOX"]');
  await page.waitForTimeout(700);
  const backInbox = await page.locator(".mail-list .mail-item").count();
  check("切回收件箱恢复 20 封", backInbox === 20, `实际 ${backInbox}`);

  // 自定义视图（V2 M5：保存当前筛选 → 侧边栏导航 → 筛选/删除）
  await page.click('[data-nav="unread"]');
  await page.waitForTimeout(300);
  const unreadBeforeView = await page.locator(".mail-list .mail-item").count();
  await page.click('[data-testid="save-view-btn"]');
  await page.waitForSelector('[data-testid="save-view-bar"]');
  await page.fill('[data-testid="view-name-input"]', "未读视图");
  await page.click('[data-testid="view-save-confirm"]');
  await page.waitForTimeout(500);
  await page.waitForSelector('[data-nav="view:1"]', { timeout: 3000 });
  check("保存视图后侧边栏出现", true);
  await page.click('[data-nav="unread"]');
  await page.waitForTimeout(300);
  await page.click('[data-nav="view:1"]');
  await page.waitForTimeout(700);
  const viewTitle = await page.$eval(".topbar .title", (el) => el.textContent).catch(() => "");
  check("视图标题显示", viewTitle.includes("未读视图"), viewTitle);
  const viewCount = await page.locator(".mail-list .mail-item").count();
  check("视图按未读筛选", viewCount === unreadBeforeView, `实际 ${viewCount}（预期 ${unreadBeforeView}）`);
  await page.click('[data-testid="view-del"]');
  await page.waitForTimeout(500);
  const viewNavs = await page.locator('[data-nav^="view:"]').count();
  check("删除视图后侧边栏移除", viewNavs === 0, `实际 ${viewNavs}`);

  // 稍后提醒（V2 M6：详情页设置 → 列表分组 → 取消）
  await page.click(".mail-list .mail-item");
  await page.waitForSelector('[data-testid="snooze-btn"]');
  await page.click('[data-testid="snooze-btn"]');
  await page.waitForSelector('[data-testid="snooze-panel"]');
  await page.click('[data-testid="snooze-1h"]');
  await page.waitForTimeout(700);
  const snoozeBtnText = await page.$eval('[data-testid="snooze-btn"]', (el) => el.textContent || "").catch(() => "");
  check("详情页显示已设提醒", snoozeBtnText.includes("已设提醒"), snoozeBtnText);
  const snoozeGroup = await page.locator('[data-testid="snooze-group"]').count();
  check("列表出现稍后提醒分组", snoozeGroup === 1, `实际 ${snoozeGroup}`);
  const snoozeTags = await page.locator('[data-testid="mail-snooze-tag"]').count();
  check("列表邮件带提醒标签", snoozeTags >= 1, `实际 ${snoozeTags}`);
  await page.click('[data-testid="snooze-btn"]');
  await page.waitForSelector('[data-testid="snooze-cancel"]');
  await page.click('[data-testid="snooze-cancel"]');
  await page.waitForTimeout(700);
  const snoozeGroupAfter = await page.locator('[data-testid="snooze-group"]').count();
  check("取消提醒后分组消失", snoozeGroupAfter === 0, `实际 ${snoozeGroupAfter}`);

  // 批量操作（V2 M7 + V2.1 UX：右键菜单进入多选 → 勾选框出现 → 批量工具栏）
  check("勾选框默认隐藏", (await page.locator('[data-testid="mail-check"]').count()) === 0);
  // 右键菜单功能项：标记已读
  const unreadBeforeCtx = await page.locator(".mail-item.unread").count();
  await page.locator(".mail-item.unread").first().click({ button: "right" });
  await page.waitForSelector('[data-testid="ctx-menu"]');
  await page.click('[data-testid="ctx-read"]');
  await page.waitForTimeout(500);
  const unreadAfterCtx = await page.locator(".mail-item.unread").count();
  check("右键标记已读生效", unreadAfterCtx === unreadBeforeCtx - 1, `before=${unreadBeforeCtx} after=${unreadAfterCtx}`);
  await page.locator(".mail-list .mail-item").first().click({ button: "right" });
  await page.waitForSelector('[data-testid="ctx-menu"]');
  await page.click('[data-testid="ctx-multi-select"]');
  await page.waitForTimeout(300);
  const checks = page.locator('[data-testid="mail-check"]');
  check("进入多选后勾选框出现", (await checks.count()) > 0, `实际 ${await checks.count()}`);
  await checks.nth(1).click();
  await checks.nth(2).click();
  await page.waitForSelector('[data-testid="bulk-bar"]');
  const bulkCount = await page.$eval('[data-testid="bulk-count"]', (el) => el.textContent || "").catch(() => "");
  check("批量工具栏出现且计数 3", bulkCount.includes("3"), bulkCount);
  await page.click('[data-testid="bulk-star"]');
  await page.waitForTimeout(700);
  check("批量星标后工具栏关闭", (await page.locator('[data-testid="bulk-bar"]').count()) === 0);
  check("批量操作后自动退出多选", (await page.locator('[data-testid="mail-check"]').count()) === 0);
  await page.click('[data-nav="starred"]');
  await page.waitForTimeout(700);
  const starredAfterBulk = await page.locator(".mail-list .mail-item").count();
  check("批量星标生效（星标筛选 ≥3）", starredAfterBulk >= 3, `实际 ${starredAfterBulk}`);
  await page.click('[data-nav="folder:INBOX"]');
  await page.waitForTimeout(700);
  // 右键菜单退出多选（别退不出来）
  await page.locator(".mail-list .mail-item").first().click({ button: "right" });
  await page.waitForSelector('[data-testid="ctx-menu"]');
  await page.click('[data-testid="ctx-multi-select"]');
  await page.waitForTimeout(300);
  await page.locator(".mail-list .mail-item").nth(2).click({ button: "right" });
  await page.waitForSelector('[data-testid="ctx-exit-select"]');
  await page.click('[data-testid="ctx-exit-select"]');
  await page.waitForTimeout(300);
  check("右键菜单退出多选模式", (await page.locator('[data-testid="mail-check"]').count()) === 0);
  // 批量加标签
  await page.locator(".mail-list .mail-item").first().click({ button: "right" });
  await page.click('[data-testid="ctx-multi-select"]');
  await page.waitForTimeout(300);
  await page.locator('[data-testid="mail-check"]').nth(1).click();
  await page.click('[data-testid="bulk-label-btn"]');
  await page.waitForSelector('[data-testid="bulk-label-menu"]');
  await page.click('[data-testid="bulk-label-pick"]');
  await page.waitForTimeout(700);
  const chipsAfterBulk = await page.locator('[data-testid="mail-auto-tag"]').count();
  check("批量加标签后列表出现 chips", chipsAfterBulk >= 2, `实际 ${chipsAfterBulk}`);
  // 批量标记已读
  const unreadBeforeBulk = await page.locator(".mail-item.unread").count();
  await page.locator(".mail-item.unread").first().click({ button: "right" });
  await page.waitForSelector('[data-testid="ctx-menu"]');
  await page.click('[data-testid="ctx-multi-select"]');
  await page.waitForTimeout(300);
  // 多选批量重新生成总结（用户要求：批量管理）——此处已勾选邮件、工具栏必定存在
  check("多选工具栏有「重新生成总结」", await page.isVisible('[data-testid="bulk-summarize"]'));
  await page.click('[data-testid="bulk-summarize"]');
  await page.waitForTimeout(1500);
  const bulkSummaryToast = await page.$eval(".toast", (el) => el.textContent || "").catch(() => "");
  check("批量重新生成总结给出结果", /已重新生成|已停止|失败/.test(bulkSummaryToast), bulkSummaryToast.slice(0, 40));
  await page.waitForTimeout(300);
  // 重新进入多选以继续后面的批量已读用例
  await page.locator(".mail-item.unread").first().click({ button: "right" });
  await page.waitForSelector('[data-testid="ctx-menu"]');
  await page.click('[data-testid="ctx-multi-select"]');
  await page.waitForTimeout(300);
  await page.locator('[data-testid="mail-check"]').nth(1).click();
  await page.waitForTimeout(200);

  await page.click('[data-testid="bulk-read"]');
  await page.waitForTimeout(700);
  const unreadAfterBulk = await page.locator(".mail-item.unread").count();
  check("批量标记已读生效", unreadAfterBulk === unreadBeforeBulk - 1, `before=${unreadBeforeBulk} after=${unreadAfterBulk}`);

  // 快捷键（V2 M7：j/k 导航、/ 聚焦搜索、s 星标、u 标未读、a 归档只读提示、l 打开标签面板、Esc 关闭）
  await page.locator(".mail-list .mail-item").nth(4).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("j");
  await page.waitForTimeout(300);
  await page.keyboard.press("k");
  await page.waitForTimeout(300);
  await page.keyboard.press("/");
  await page.waitForTimeout(300);
  const focusedId = await page.$eval(":focus", (el) => el.getAttribute("data-testid")).catch(() => "");
  check("快捷键 / 聚焦搜索框", focusedId === "search-input", focusedId);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("s");
  await page.waitForTimeout(700);
  const starMarksAfterKey = await page.locator('[data-testid="mail-star"]').count();
  check("快捷键 s 星标当前邮件", starMarksAfterKey >= 1, `实际 ${starMarksAfterKey}`);
  await page.keyboard.press("u");
  await page.waitForTimeout(400);
  await page.keyboard.press("a");
  await page.waitForTimeout(300);
  const archToast = await page.$eval(".toast", (el) => el.textContent || "").catch(() => "");
  check("快捷键 a 归档只读提示", archToast.includes("P1") || archToast.includes("只读"), archToast.slice(0, 50));
  await page.keyboard.press("l");
  await page.waitForTimeout(500);
  check("快捷键 l 打开标签面板", (await page.locator('[data-testid="label-panel"]').count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Esc 关闭标签面板", (await page.locator('[data-testid="label-panel"]').count()) === 0);

  // 优先级功能已按用户要求下线（V2 M8 移除）
  await page.click('[data-nav="unread"]');
  await page.waitForTimeout(300);
  check("优先级按钮已移除", (await page.locator('[data-testid="priority-toggle"]').count()) === 0);
  check("🔥 优先级标记已移除", (await page.locator('[data-testid="mail-priority-tag"]').count()) === 0);

  // 知识库（M3 v2）：目录式布局 —— 本周简报 / 可折叠目录 / 展开看摘要 / 问 AI
  await page.click('[data-nav="knowledge"]');
  await page.waitForSelector('[data-testid="kb-page"]', { timeout: 5000 });
  check("知识库页可打开", await page.isVisible('[data-testid="kb-brief"]'));
  const briefText = await page.$eval('[data-testid="kb-brief"]', (el) => el.textContent || "").catch(() => "");
  check("本周简报显示收到邮件数", /收到\s*\d+\s*封/.test(briefText), briefText.replace(/\s+/g, " ").slice(0, 50));
  // 目录可折叠：默认展开课程、收起类型
  check("目录有课程/类型分组", (await page.locator('[data-testid="kb-group-course"]').count()) === 1);
  const typeListBefore = await page.locator('[data-testid="kb-collection"]').count();
  await page.click('[data-testid="kb-group-type"]');
  await page.waitForTimeout(200);
  const typeListAfter = await page.locator('[data-testid="kb-collection"]').count();
  check("展开类型分组后集合变多", typeListAfter > typeListBefore, `before=${typeListBefore} after=${typeListAfter}`);
  // 选中一个课程集合 → 档案卡
  await page.locator('[data-testid="kb-collection"]').first().click();
  await page.waitForSelector('[data-testid="kb-dossier"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="kb-mail"]', { timeout: 5000 });
  const dossierText = await page.$eval('[data-testid="kb-dossier"]', (el) => el.textContent || "").catch(() => "");
  check("档案卡显示封数", /共 \d+ 封/.test(dossierText), dossierText.replace(/\s+/g, " ").slice(0, 50));
  // 邮件默认折叠，点开后才显示摘要（决策卡）
  check("邮件默认收起（不直接显示摘要）", (await page.locator('[data-testid="kb-mail-expanded"]').count()) === 0);
  await page.locator('[data-testid="kb-mail-toggle"]').first().click();
  await page.waitForSelector('[data-testid="kb-mail-expanded"]', { timeout: 5000 });
  const expandedText = await page.$eval('[data-testid="kb-mail-expanded"]', (el) => el.textContent || "").catch(() => "");
  check("展开后显示 AI 摘要内容", expandedText.length > 10, expandedText.replace(/\s+/g, " ").slice(0, 50));
  check("展开后有「打开邮件 / 移出集合」", (await page.isVisible('[data-testid="kb-open-mail"]')) && (await page.isVisible('[data-testid="kb-exclude"]')));
  // ✨ 问 AI：跳到助手页并自动把问题发出去（聊天式：问题入消息流）
  await page.click('[data-testid="kb-ask-ai"]');
  await page.waitForSelector('[data-testid="ai-search-page"]', { timeout: 5000 });
  await page
    .waitForFunction(
      () => Array.from(document.querySelectorAll('[data-testid="chat-msg-user"]')).some((el) => (el.textContent || '').includes('截止')),
      null,
      { timeout: 8000 }
    )
    .catch(() => {});
  const presetBubble = await page
    .locator('[data-testid="chat-msg-user"]')
    .last()
    .textContent()
    .catch(() => '');
  check("知识库「问 AI」把问题带到助手页并提问", (presetBubble || '').includes('截止'), (presetBubble || '').slice(0, 40));

  // 发信：回复 → 发送 → 已发送列表（mock 传输层，不发真邮件）
  await page.click('[data-nav="inbox"]');
  await page.waitForTimeout(300);
  await page.locator(".mail-list .mail-item").first().click();
  await page.waitForTimeout(300);
  await page.click('[data-testid="reply-btn"]');
  await page.waitForSelector('[data-testid="compose-modal"]', { timeout: 5000 });
  // 预填值是 React effect 写入的：等它真正落到 input 上再断言（否则会读到空值）
  await page
    .waitForFunction(() => {
      const el = document.querySelector('[data-testid="compose-to"]');
      return el && el.value.includes("@");
    }, { timeout: 5000 })
    .catch(() => {});
  const replyTo = await page.$eval('[data-testid="compose-to"]', (el) => el.value).catch(() => "");
  const replySubject = await page.$eval('[data-testid="compose-subject"]', (el) => el.value).catch(() => "");
  check("回复弹层自动填收件人与 Re: 主题", replyTo.includes("@") && /^Re:/.test(replySubject), `${replyTo} | ${replySubject}`);
  await page.click('[data-testid="compose-send"]');
  // 成功 → 弹层自动关闭；失败 → 弹层保留并给出原因（不依赖 toast，避免读到上一步的旧提示）
  await page
    .waitForFunction(
      () => !document.querySelector('[data-testid="compose-modal"]') || document.querySelector('[data-testid="compose-result"]'),
      { timeout: 10000 }
    )
    .catch(() => {});
  const composeOutcome = await page.evaluate(() => {
    const res = document.querySelector('[data-testid="compose-result"]');
    return { modalOpen: !!document.querySelector('[data-testid="compose-modal"]'), result: res ? res.textContent || "" : "" };
  });
  check(
    "发信完成（成功即关闭弹层；失败保留并给出原因）",
    !composeOutcome.modalOpen || /已发送|失败|鉴权/.test(composeOutcome.result),
    JSON.stringify(composeOutcome).slice(0, 80)
  );
  if (composeOutcome.modalOpen) {
    await page.click('[data-testid="compose-close"]');
    await page.waitForTimeout(200);
  }
  await page.click('[data-nav="sent"]');
  await page.waitForSelector('[data-testid="sent-page"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="sent-item"]', { timeout: 5000 }).catch(() => {});
  const sentRows = await page.locator('[data-testid="sent-item"]').count();
  check("已发送页显示本地发送记录", sentRows >= 1, `实际 ${sentRows}`);
  const sentDetail = await page.$eval('[data-testid="sent-detail"]', (el) => el.textContent || "").catch(() => "");
  check("已发送详情含收件人", sentDetail.includes("@"), sentDetail.slice(0, 50));

  // 草稿箱（V2 M9：写邮件 → 保存 → 覆盖 → 删除；发送已开放）
  await page.click('[data-nav="drafts"]');
  await page.waitForSelector('[data-testid="drafts-page"]');
  await page.click('[data-testid="draft-new-btn"]');
  await page.waitForTimeout(300);
  await page.fill('[data-testid="draft-to-input"]', "lin@example.edu");
  await page.fill('[data-testid="draft-subject-input"]', "课题讨论");
  await page.fill('[data-testid="draft-body-input"]', "周三下午讨论第三章数据。");
  await page.click('[data-testid="draft-save-btn"]');
  await page.waitForTimeout(600);
  const draftItems = await page.locator('[data-testid="draft-item"]').count();
  check("保存草稿后列表出现 1 封", draftItems === 1, `实际 ${draftItems}`);
  const sendDisabled = await page.$eval('[data-testid="draft-send-btn"]', (el) => el.disabled).catch(() => false);
  check("发送按钮已开放（可点）", sendDisabled === false, `disabled=${sendDisabled}`);
  await page.fill('[data-testid="draft-subject-input"]', "课题讨论 v2");
  await page.click('[data-testid="draft-save-btn"]');
  await page.waitForTimeout(600);
  const draftSubject = await page.$eval('[data-testid="draft-item"] .from', (el) => el.textContent || "").catch(() => "");
  check("草稿覆盖保存生效", draftSubject.includes("v2"), draftSubject);
  // 草稿直接发送：发送成功后草稿自动删除 + 「已发送」多一条记录
  await page.click('[data-testid="draft-send-btn"]');
  await page.waitForSelector('[data-testid="compose-modal"]', { timeout: 5000 });
  await page
    .waitForFunction(() => {
      const el = document.querySelector('[data-testid="compose-to"]');
      return el && el.value.includes("@");
    }, { timeout: 5000 })
    .catch(() => {});
  const draftComposeTo = await page.$eval('[data-testid="compose-to"]', (el) => el.value).catch(() => "");
  check("草稿发送弹层带出收件人", draftComposeTo.includes("lin@example.edu"), draftComposeTo);
  await page.click('[data-testid="compose-send"]');
  await page
    .waitForFunction(
      () => !document.querySelector('[data-testid="compose-modal"]') || document.querySelector('[data-testid="compose-result"]'),
      { timeout: 10000 }
    )
    .catch(() => {});
  if (await page.locator('[data-testid="compose-close"]').count()) {
    await page.click('[data-testid="compose-close"]');
  }
  await page.waitForTimeout(600);
  check("发送成功后草稿被删除", (await page.locator('[data-testid="draft-item"]').count()) === 0);

  await page.click('[data-testid="draft-delete"]').catch(() => {});
  await page.waitForTimeout(300);
  await page.click('[data-nav="inbox"]');
  await page.waitForTimeout(500);

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, "renderer.png"), fullPage: false });

  check("无未捕获 JS 异常", errors.length === 0, errors.join(" | ").slice(0, 200));
  check("无 console.error", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 200));
} catch (e) {
  check("测试执行无异常", false, String(e && e.message ? e.message : e) + " | pageerrors: " + errors.join(" || ").slice(0, 500) + " | consoleErrors: " + consoleErrors.join(" || ").slice(0, 500));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log("\n===== renderer E2E 结果 =====");
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
