// HHmail —— 前端 demo 冒烟自测（开发 AI 自测用，可反复运行）
// 用法：cd tests && npm install && npm test
// 依赖：系统已安装 Microsoft Edge（Windows 自带）；无需下载 Chromium。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", ".."); // 项目根目录
const PORT = Number(process.env.E2E_PORT || 8124);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- 1. 启动静态服务器（供测试用） ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "demo/index.html" : urlPath.replace(/^\//, "");
  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---------- 2. 启动浏览器（复用系统 Edge） ----------
let browser;
const errors = [];
const consoleErrors = [];
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

async function launch() {
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

try {
  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto(`${BASE}/demo/index.html`, { waitUntil: "load" });
  await page.waitForTimeout(300);

  check("页面标题正确", (await page.title()).includes("HHmail"), await page.title());

  // 登录浮层应初始可见
  const loginVisible = await page.isVisible("#loginOverlay");
  const loginHidden = await page.$eval("#loginOverlay", (el) => el.classList.contains("hidden"));
  check("登录页初始可见", loginVisible && !loginHidden);

  // 进入 demo
  await page.click("#loginBtn");
  await page.waitForTimeout(200);
  check("点击登录后浮层隐藏", await page.$eval("#loginOverlay", (el) => el.classList.contains("hidden")));

  // 邮件列表
  const mailCount = await page.locator("#mailList .mail-item").count();
  check("收件箱渲染 8 封邮件", mailCount === 8, `实际 ${mailCount}`);

  // 默认选中第一封
  const title = await page.$eval(".detail-title", (el) => el.textContent).catch(() => "");
  check("默认选中第一封并渲染标题", title.includes("毕业论文进度"), title);

  // 未读筛选
  await page.click("#segUnread");
  await page.waitForTimeout(100);
  const unreadCount = await page.locator("#mailList .mail-item").count();
  check("未读筛选出 3 封", unreadCount === 3, `实际 ${unreadCount}`);
  await page.click("#segAll");

  // 搜索
  await page.fill("#searchInput", "VPN");
  await page.waitForTimeout(100);
  const searchCount = await page.locator("#mailList .mail-item").count();
  check("搜索 VPN 命中 1 封", searchCount === 1, `实际 ${searchCount}`);
  await page.fill("#searchInput", "");
  await page.waitForTimeout(100);

  // AI 面板
  await page.click("#openAiPanel");
  await page.waitForTimeout(400);
  check("AI 面板可打开", await page.$eval("#aiPanel", (el) => el.classList.contains("open")));

  // AI 总结建议
  await page.click('button:has-text("总结这封邮件")');
  await page.waitForTimeout(1200);
  const aiText = await page.$eval("#aiBody", (el) => el.textContent).catch(() => "");
  check("AI 总结返回内容", aiText.includes("主要内容") || aiText.includes("核心要点"), aiText.slice(0, 60));

  // AI 回复中的换行应保留（pre-wrap），否则多行摘要会挤成一行
  const ws = await page.$eval(".ai-msg.ai .bubble", (el) => getComputedStyle(el).whiteSpace).catch(() => "");
  check("AI 回复保留换行(pre-wrap)", ws === "pre-wrap", ws);

  // 截图存档
  const shotDir = path.join(ROOT, "tests", "artifacts");
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, "smoke.png"), fullPage: false });

  check("无未捕获 JS 异常", errors.length === 0, errors.join(" | ").slice(0, 200));
  check("无 console.error", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 200));

} catch (e) {
  check("测试执行无异常", false, String(e && e.message ? e.message : e));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log("\n===== 自测结果 =====");
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
