// Electron 冒烟（L3）：真实启动主进程（HHMAIL_MOCK=1，不碰真实凭据/网络）。
// 覆盖：窗口启动 → preload 白名单（window.api 存在且无 Node 能力泄漏）→
//       登录态 → 同步（FakeMailProvider → 真实 mailparser → 真实 SQLite）→ 收件箱 20 封 → 详情 → 截图。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const ARTIFACTS = path.join(ROOT, "tests", "artifacts");
const require = createRequire(import.meta.url);

const results = [];
const consoleErrors = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

const outMain = path.join(ROOT, "out", "main", "index.js");
if (!fs.existsSync(outMain)) {
  console.error("❌ 未找到 out/main/index.js，请先执行 npm run build（根目录）。");
  process.exit(1);
}

let electronPath;
try {
  electronPath = require("electron");
} catch {
  electronPath = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
}

let app;
try {
  // 注意：若外部环境带 ELECTRON_RUN_AS_NODE=1，Electron 会退化成纯 Node 启动导致 launch 失败，这里强制剔除
  // 独立临时 userData：避免读到用户真实 profile 的 localStorage（侧边栏折叠状态会让断言随机失败），
  // 也避免与用户正在运行的 HHmail 抢单实例锁。mock 模式下数据库本来就在临时目录。
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hhmail-e2e-"));
  const launchEnv = {
    ...process.env,
    HHMAIL_MOCK: "1",
    HHMAIL_USERDATA: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
  };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  // 环境 GPU 不稳定时 Electron 启动阶段会 FATAL（"GPU process isn't usable. Goodbye."）：
  // 用 in-process-gpu 规避，并做 3 次启动重试，避免环境抖动被误判成应用回归。
  const launchArgs = [outMain, "--in-process-gpu", "--disable-gpu-compositing", "--disable-software-rasterizer"];
  let lastError;
  for (let attempt = 1; attempt <= 3 && !app; attempt++) {
    try {
      app = await electron.launch({ executablePath: electronPath, args: launchArgs, env: launchEnv });
      await app.firstWindow({ timeout: 25000 });
    } catch (e) {
      lastError = e;
      console.log(`⚠️ Electron 启动尝试 ${attempt}/3 失败：${String(e && e.message).slice(0, 120)}`);
      await app?.close().catch(() => {});
      app = undefined;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!app) throw lastError ?? new Error("Electron 启动失败");

  const window = await app.firstWindow({ timeout: 20000 });
  await window.waitForLoadState("domcontentloaded");
  check("主窗口启动且标题正确", (await window.title()).includes("HHmail"), await window.title());

  // preload 白名单：window.api 存在；renderer 拿不到 Node 能力
  const apiKeys = await window.evaluate(() => {
    const api = window.api;
    return {
      hasApi: !!api,
      keys: api ? Object.keys(api).sort() : [],
      hasRequire: typeof window.require !== "undefined",
      hasProcess: typeof window.process !== "undefined",
      hasIpcRenderer: !!api && "ipcRenderer" in api
    };
  });
  const expected = [
    "askInbox", "bulkAddLabels", "bulkMarkRead", "cancelSnooze", "createLabel", "deleteDraft", "deleteLabel",
    "deleteView", "downloadAttachment", "getAuthStatus", "getMail", "getSettings", "listDrafts", "listFolders",
    "listLabels", "listMails", "listViews", "logout", "markMailRead", "onDeviceCodeEvent", "onNewMail",
    "onSummaryProgress", "onSyncProgress", "openExternal", "probeSendCapability", "resyncMail", "saveDraft",
    "cancelSummarize", "collectionMails", "indexStats", "listCollections", "setCollectionExcluded", "weeklyBrief", "listSentItems", "deleteSentItem", "saveSettings", "saveView", "sendMail", "sendTestMail",
    "searchMail", "setMailLabels", "snoozeMail", "startDeviceCode", "summarizeMail", "summarizePending", "syncMail",
    "toggleStar",
    // M4 聊天式 AI 助手
    "chatAsk", "chatMessages", "chatSessions", "deleteChatSession", "newChatSession", "renameChatSession",
    // V2.2：附件保存到指定目录 + 目录选择/打开 + 自动标签
    "saveAttachment", "pickDirectory", "openPath",
    "tagCounts", "tagExamples", "setTagExample", "rebuildTags", "setMailTagManual",
    // V2.2：红旗 + 真实总数 + 彩色类别
    "setFlagged", "countMails", "listCategories", "categoryCounts", "createCategory", "updateCategory",
    "deleteCategory", "setMailCategory"
  ].sort();
  check("window.api 白名单齐全", apiKeys.hasApi && JSON.stringify(apiKeys.keys) === JSON.stringify(expected), apiKeys.keys.join(","));
  check("renderer 无 Node 能力泄漏", !apiKeys.hasRequire && !apiKeys.hasProcess && !apiKeys.hasIpcRenderer);

  window.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  // mock 模式：已登录 → 直接收件箱；等待真实同步（mailparser + SQLite）完成
  await window.waitForSelector(".mail-list .mail-item", { timeout: 30000 });
  const count = await window.locator(".mail-list .mail-item").count();
  check("收件箱渲染 20 封邮件", count === 20, `实际 ${count}`);

  // 同步状态
  const syncText = await window.$eval('[data-testid="sync-status"]', (el) => el.textContent).catch(() => "");
  check("同步完成状态", syncText.includes("同步完成"), syncText);

  // 详情
  await window.locator(".mail-list .mail-item").first().click();
  await window.waitForSelector(".detail-title", { timeout: 5000 });
  const title = await window.$eval(".detail-title", (el) => el.textContent).catch(() => "");
  check("详情标题渲染", title.length > 0, title);

  // 未读 → 已读（真实 IPC + SQLite 本地标记）
  await window.waitForTimeout(400);
  const unreadAfterClick = await window.locator(".mail-list .mail-item.unread").count();
  check("点击未读邮件后本地标记已读", unreadAfterClick === 19, `实际 ${unreadAfterClick}`);

  // 附件下载（V2 M2：真实 IPC → mock provider 返回内容 → 渲染端触发下载）
  await window.click('[data-testid="attach-card"]');
  await window.waitForTimeout(700);
  const dlToast = await window.$eval(".toast", (el) => el.textContent).catch(() => "");
  // V2.2：附件改由主进程落盘（mock 模式落到临时目录），提示变成「已保存：<路径>」
  check("附件点击后可保存（真实 IPC）", /已保存|保存/.test(dlToast) && !/不存在|失败/.test(dlToast), dlToast.slice(0, 60));

  // 长正文详情区真实可滚动（修复项 #3）
  const scrollInfo = await window.$eval(".detail-pane", (el) => ({ sh: el.scrollHeight, ch: el.clientHeight })).catch(() => null);
  check("长正文使详情区产生滚动", !!scrollInfo && scrollInfo.sh > scrollInfo.ch, JSON.stringify(scrollInfo));
  await window.$eval(".detail-pane", (el) => { el.scrollTop = el.scrollHeight }).catch(() => undefined);
  const scrolled = await window.$eval(".detail-pane", (el) => el.scrollTop).catch(() => 0);
  check("详情区实际滚动生效", scrolled > 0, String(scrolled));
  const body = await window.$eval('[data-testid="detail-body"]', (el) => el.textContent).catch(() => "");
  check("详情正文渲染（真实 mailparser 链路）", body.includes("邮箱助手自测") && !body.includes("MIME-Version"), body.slice(0, 40));

  // AI 总结（mock MailAiService 走真实 IPC + 组合根链路）
  await window.click('[data-testid="ai-summarize-btn"]');
  await window.waitForSelector('[data-testid="ai-summary"], [data-testid="saved-summary"]', { timeout: 5000 });
  const summaryText = await window.$eval('.ai-summary-head, .ai-summary', (el) => el.textContent).catch(() => "");
  check("AI 总结经真实 IPC 链路返回", summaryText.includes("mock"), summaryText.slice(0, 40));

  // 摘要持久化（SQLite）：切走再切回仍显示「已保存」摘要
  await window.locator(".mail-list .mail-item").nth(1).click();
  await window.waitForTimeout(300);
  await window.locator(".mail-list .mail-item").first().click();
  await window.waitForTimeout(300);
  const saved = await window.$eval('[data-testid="saved-summary"]', (el) => el.textContent).catch(() => "");
  check("摘要持久化并展示在最前面", saved.includes("（mock）") && saved.includes("已保存"), saved.slice(0, 40));
  const mdHtml = await window.$eval('[data-testid="summary-markdown"]', (el) => el.innerHTML).catch(() => "");
  check(
    "摘要结构化预览渲染（真实 IPC 链路）",
    mdHtml.includes("summary-view") && mdHtml.includes("sv-kv-row") && !mdHtml.includes("<table"),
    mdHtml.slice(0, 60)
  );

  // 设置页（组合根 → IPC → 加密设置存储）
  await window.click('[data-nav="settings"]');
  await window.waitForSelector('[data-testid="settings-page"]', { timeout: 5000 });
  check("设置页可打开", await window.isVisible('[data-testid="settings-page"]'));
  // M1：检索索引卡片覆盖情况（设置页显示）
  await window.click('[data-testid="settings-section-ai"]');
  await window.waitForTimeout(300);
  const indexStatsText = await window.$eval('[data-testid="index-stats"]', (el) => el.textContent || "").catch(() => "");
  check("设置页显示检索索引覆盖", /已建 \d+\/\d+ 封/.test(indexStatsText), indexStatsText.slice(0, 40));

  // 发送能力自检（真实 IPC，mock 模式下主进程直接返回结论，不发信）
  await window.click('[data-testid="settings-section-send"]');
  await window.waitForTimeout(300);
  await window.click('[data-testid="smtp-probe-btn"]');
  await window.waitForSelector('[data-testid="smtp-probe-result"]', { timeout: 10000 });
  const probeText = await window.$eval('[data-testid="smtp-probe-result"]', (el) => el.textContent || "").catch(() => "");
  check("发送能力自检返回授权结论（真实 IPC）", /授权|鉴权|发送/.test(probeText), probeText.slice(0, 50));

  // 个人邮箱发信测试：真实 IPC + 加密设置存储（mock 模式下不联网）
  await window.fill('[data-testid="set-smtp-user"]', "tester@example.com");
  await window.fill('[data-testid="set-smtp-pass"]', "app-pass");
  await window.fill('[data-testid="set-smtp-to"]', "tester@example.com");
  await window.click('[data-testid="smtp-send-test-btn"]');
  await window.waitForSelector('[data-testid="smtp-send-result"]', { timeout: 15000 });
  const sendText = await window.$eval('[data-testid="smtp-send-result"]', (el) => el.textContent || "").catch(() => "");
  check("发信测试经真实 IPC 返回中文结论", /已发送|失败|鉴权/.test(sendText), sendText.slice(0, 50));
  // 学校账号发信测试（真实 IPC + mock 传输层）
  await window.click('[data-testid="school-send-test-btn"]');
  await window.waitForSelector('[data-testid="school-send-result"]', { timeout: 15000 });
  const schoolText = await window.$eval('[data-testid="school-send-result"]', (el) => el.textContent || "").catch(() => "");
  check("学校账号发信测试经真实 IPC 返回结论", /已发送|失败|鉴权/.test(schoolText), schoolText.slice(0, 50));

  // V2.2 设置目录化 + 外观设置（真实 IPC：保存 → 读回 → 写到 html[data-theme]）
  const secOk =
    (await window.isVisible('[data-testid="settings-section-appearance"]')) &&
    (await window.isVisible('[data-testid="settings-section-about"]'));
  check("设置页分类目录可见（外观/关于）", secOk);
  await window.click('[data-testid="settings-section-appearance"]');
  await window.waitForTimeout(300);
  await window.selectOption('[data-testid="set-theme"]', "dark");
  await window.click('[data-testid="settings-save-bottom"]');
  await window.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, { timeout: 5000 }).catch(() => {});
  check("深色主题经真实 IPC 保存并生效", (await window.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await window.selectOption('[data-testid="set-theme"]', "light");
  await window.click('[data-testid="settings-save-bottom"]');
  await window.waitForTimeout(300);
  // V2.2：自动标签（开关 + 词表 + 规则标签重算）
  await window.click('[data-testid="settings-section-ai"]');
  await window.waitForTimeout(300);
  check("设置页有自动标签开关", await window.isVisible('[data-testid="set-auto-tag"]'));
  await window.fill('[data-testid="tag-vocab-input"]', '讲座');
  await window.click('[data-testid="tag-vocab-add"]');
  await window.click('[data-testid="settings-save-bottom"]');
  await window.waitForTimeout(400);
  const tagVocab = await window.evaluate(async () => (await window.api.getSettings()).tagVocabulary);
  check("标签词表可保存并读回（chip 编辑器）", tagVocab.includes('讲座') && tagVocab.includes('实习'), String(tagVocab).slice(0, 60));
  const providerSettings = await window.evaluate(async () => {
    const s = await window.api.getSettings();
    return { provider: s.aiProvider, model: s.aiModel, baseUrl: s.aiBaseUrl }
  });
  check(
    "AI 服务商默认 DeepSeek + deepseek-flash",
    providerSettings.provider === 'deepseek' && providerSettings.model === 'deepseek-flash',
    JSON.stringify(providerSettings)
  );
  await window.click('[data-testid="rebuild-tags"]');
  await window.waitForTimeout(800);
  const tagCountsText = await window.$eval('[data-testid="tag-counts"]', (el) => el.textContent || '').catch(() => '');
  check("规则标签重算后有标签（真实 IPC）", tagCountsText.length > 0 && !tagCountsText.includes('还没有标签'), tagCountsText.slice(0, 60));

  // V2.2：附件保存位置可配置（选择目录 → 保存 → 读回）
  await window.click('[data-testid="settings-section-about"]');
  await window.waitForTimeout(300);
  const hasAttachDir = await window.isVisible('[data-testid="set-attachment-dir"]');
  check("设置页有附件保存位置", hasAttachDir);
  await window.fill('[data-testid="set-attachment-dir"]', 'D:\HHmail-Attachments');
  await window.click('[data-testid="settings-save-bottom"]');
  await window.waitForTimeout(400);
  const attachStored = await window.evaluate(async () => (await window.api.getSettings()).attachmentDir);
  check("附件保存位置可保存并读回", attachStored === 'D:\HHmail-Attachments', String(attachStored));
  await window.fill('[data-testid="set-attachment-dir"]', '');
  await window.click('[data-testid="settings-save-bottom"]');
  await window.waitForTimeout(300);

  const brandName = await window.evaluate(() => document.querySelector(".brand-name")?.textContent || "");
  check("侧边栏显示设置里的品牌名", brandName.length > 0, brandName);
  const sidebarHasReadonly = await window.evaluate(() => (document.querySelector(".sidebar")?.textContent || "").includes("只读模式"));
  check("侧边栏已移除「只读模式」徽标", sidebarHasReadonly === false);

  const stored = await window.evaluate(async () => {
    const s = await window.api.getSettings();
    return { hasSmtpPass: s.hasSmtpPass, smtpUser: s.smtpUser, sendScope: s.sendScope, theme: s.theme, brandName: s.brandName };
  });
  check("发信密码已加密保存且不回传明文", stored.hasSmtpPass === true && !JSON.stringify(stored).includes("app-pass"), JSON.stringify(stored));
  // V2.1：修复同步（游标回退到本地最大 UID 后重拉）
  // V2.1：重新生成全部摘要（force 模式，真实 IPC）
  await window.click('[data-testid="settings-section-ai"]');
  await window.waitForTimeout(300);
  await window.click('[data-testid="settings-regenerate-summaries"]');
  await window
    .waitForFunction(() => /已总结|摘要/.test(document.querySelector(".toast")?.textContent || ""), null, { timeout: 30000 })
    .catch(() => {});
  const regenToast = await window.$eval(".toast", (el) => el.textContent || "").catch(() => "");
  check("重新生成摘要可用（真实 IPC）", /已总结|摘要/.test(regenToast) && !regenToast.includes("参数无效"), regenToast.slice(0, 40));
  await window.click('[data-testid="settings-section-sync"]');
  await window.waitForTimeout(300);
  await window.click('[data-testid="resync-btn"]');
  await window
    .waitForFunction(() => (document.querySelector(".toast")?.textContent || "").includes("重新拉取"), null, { timeout: 20000 })
    .catch(() => {});
  const repairToast = await window.$eval(".toast", (el) => el.textContent || "").catch(() => "");
  check("修复同步按钮可用（真实 IPC）", repairToast.includes("重新拉取"), repairToast.slice(0, 40));
  await window.click('[data-nav="inbox"]');
  await window.waitForTimeout(300);

  // AI 助手（M4 聊天式，真实 IPC：本地 FTS 检索 + mock AI + 多轮会话 + 引用跳转）
  await window.click('[data-nav="ai"]');
  await window.waitForSelector('[data-testid="ai-search-page"]', { timeout: 5000 });
  check("AI 助手页可打开", await window.isVisible('[data-testid="ai-search-page"]'));
  // 进入页面自动建会话（聊天式界面：随时能打字）
  await window.waitForSelector('[data-testid="chat-session"]', { timeout: 5000 });
  await window.fill('[data-testid="ai-ask-input"]', "测试邮件");
  await window.click('[data-testid="ai-ask-send"]');
  await window.waitForSelector('[data-testid="chat-msg-assistant"]', { timeout: 15000 });
  const askText = await window.$eval('[data-testid="chat-msg-assistant"]', (el) => el.textContent).catch(() => "");
  check("AI 问答经真实 IPC 返回", askText.includes("（mock）"), askText.slice(0, 40));
  const citeCount = await window.locator('[data-testid="ai-ask-cite"]').count();
  check("AI 问答引用卡片存在", citeCount >= 1, `实际 ${citeCount}`);
  // 多轮：第二轮提问会带上一轮上下文（服务端 history），两条用户消息 + 两条回答都在消息流里
  await window.fill('[data-testid="ai-ask-input"]', "那截止呢？");
  await window.click('[data-testid="ai-ask-send"]');
  await window
    .waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="chat-msg-user"]').length >= 2 &&
        document.querySelectorAll('[data-testid="chat-msg-assistant"]').length >= 2,
      null,
      { timeout: 20000 }
    )
    .catch(() => {});
  const userMsgs = await window.locator('[data-testid="chat-msg-user"]').count();
  const assistantMsgs = await window.locator('[data-testid="chat-msg-assistant"]').count();
  check("多轮对话消息都在同一会话里", userMsgs >= 2 && assistantMsgs >= 2, `user=${userMsgs} assistant=${assistantMsgs}`);
  // 新建对话 → 消息流清空、会话列表 +1
  const sessionsBefore = await window.locator('[data-testid="chat-session"]').count();
  await window.click('[data-testid="chat-new"]');
  await window
    .waitForFunction(() => document.querySelectorAll('[data-testid="chat-msg-user"]').length === 0, null, { timeout: 5000 })
    .catch(() => {});
  const sessionsAfter = await window.locator('[data-testid="chat-session"]').count();
  check("新建对话清空消息流且会话列表增加", sessionsAfter === sessionsBefore + 1, `before=${sessionsBefore} after=${sessionsAfter}`);
  // 删除会话
  await window.locator('[data-testid="chat-session-delete"]').first().click();
  await window
    .waitForFunction((n) => document.querySelectorAll('[data-testid="chat-session"]').length === n - 1, sessionsAfter, { timeout: 5000 })
    .catch(() => {});
  const sessionsAfterDelete = await window.locator('[data-testid="chat-session"]').count();
  check("删除对话后列表减少", sessionsAfterDelete === sessionsAfter - 1, `实际 ${sessionsAfterDelete}`);
  // 切回第一个会话：历史消息从本地 SQLite 读回来（持久化）
  await window.locator('[data-testid="chat-session"]').first().click();
  await window.waitForSelector('[data-testid="chat-msg-user"]', { timeout: 5000 });
  check("切换会话读回历史消息", (await window.locator('[data-testid="ai-ask-cite"]').count()) >= 1);
  // V2.2：批量总结按钮统一放设置页（AI 助手页右上角那个已移除）
  check("AI 助手页不再有批量总结按钮", (await window.locator('[data-testid="summarize-pending-btn"]').count()) === 0);
  // 引用区在回答**上方**，且只列回答里提到的邮件
  const citesAbove = await window.evaluate(() => {
    const cites = document.querySelector('[data-testid="chat-citations"]')
    const body = document.querySelector('[data-testid="ai-ask-answer-md"]')
    if (!cites || !body) return null
    return cites.getBoundingClientRect().top <= body.getBoundingClientRect().top
  })
  check("引用邮件显示在回答上方", citesAbove === true, String(citesAbove));
  await window.locator('[data-testid="ai-ask-cite"]').first().click();
  await window.waitForSelector(".detail-title", { timeout: 5000 });
  check("引用跳转到收件箱详情", await window.isVisible(".detail-title"));

  // 文件夹切换（V2 M3：真实 IPC listFolders + 每文件夹独立同步状态）
  await window.click('[data-nav="folder:Sent"]');
  await window.waitForTimeout(1200);
  const sentCount = await window.locator(".mail-list .mail-item").count();
  check("切换到「Sent」文件夹（mock 为空）", sentCount === 0, `实际 ${sentCount}`);
  await window.click('[data-nav="folder:INBOX"]');
  await window.waitForTimeout(1200);
  const inboxCount = await window.locator(".mail-list .mail-item").count();
  check("切回「收件箱」恢复 20 封", inboxCount === 20, `实际 ${inboxCount}`);

  // 星标 + 标签（V2 M4：真实 IPC → SQLite labels/message_labels/starred）
  await window.click(".mail-list .mail-item");
  await window.waitForSelector('[data-testid="star-btn"]');
  await window.click('[data-testid="star-btn"]');
  await window.waitForTimeout(600);
  const starBtnText = await window.$eval('[data-testid="star-btn"]', (el) => el.textContent || "").catch(() => "");
  check("详情页星标切换为已星标", starBtnText.includes("已星标"), starBtnText);
  await window.click('[data-nav="starred"]');
  await window.waitForTimeout(1000);
  const starredCount = await window.locator(".mail-list .mail-item").count();
  check("星标筛选出 1 封（真实 store）", starredCount === 1, `实际 ${starredCount}`);
  const starMarks = await window.locator('[data-testid="mail-star"]').count();
  check("列表显示星标标记", starMarks >= 1, `实际 ${starMarks}`);

  // V2.2：红旗 —— 真实 store + IPC（用户反馈"点了侧边栏红旗不切换"）
  {
    // 先回到完整收件箱，拿"全部"的行数做基准（前面的星标测试会留下 1 行的筛选态）
    await window.click('[data-nav="folder:INBOX"]')
    await window.waitForTimeout(900)
    const beforeFlagRows = await window.locator(".mail-list .mail-item").count()
    await window.locator(".mail-list .mail-item").first().click()
    await window.waitForSelector('[data-testid="flag-btn"]', { timeout: 5000 })
    await window.click('[data-testid="flag-btn"]')
    await window.waitForTimeout(900)
    const flagMarks = await window.locator('[data-testid="mail-flag"]').count()
    check("标红旗后列表出现红旗标记（真实 store）", flagMarks >= 1, `实际 ${flagMarks}`)
    await window.click('[data-nav="flagged"]')
    await window.waitForTimeout(1000)
    const flaggedRows = await window.locator(".mail-list .mail-item").count()
    check(
      "点侧边栏「红旗」后列表切到红旗邮件（真实 store）",
      flaggedRows >= 1 && flaggedRows < beforeFlagRows,
      `红旗 ${flaggedRows} / 全部 ${beforeFlagRows}`
    )
    const allFlagged = await window.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.mail-list .mail-item'))
      return rows.length > 0 && rows.every((r) => r.querySelector('[data-testid="mail-flag"]'))
    })
    check("红旗列表里每封都有红旗标记", allFlagged === true, String(allFlagged))
    // 还原：取消红旗并回到收件箱
    await window.locator(".mail-list .mail-item").first().click()
    await window.waitForTimeout(600)
    await window.click('[data-testid="flag-btn"]')
    await window.waitForTimeout(600)
    await window.click('[data-nav="folder:INBOX"]')
    await window.waitForTimeout(700)
  }

  // V2.2：统一标签体系 —— 手动打标签（写入 source=manual，重算不会覆盖）
  await window.click('[data-testid="labels-btn"]');
  await window.waitForSelector('[data-testid="label-panel"]');
  await window.fill('[data-testid="tag-input"]', "课业");
  await window.click('[data-testid="tag-add-btn"]');
  await window.waitForTimeout(900);
  const manualToggles = await window.locator('[data-testid="tag-toggle"].manual').count();
  check("手动给邮件打标签（真实 store）", manualToggles >= 1, `实际 ${manualToggles}`);
  await window.keyboard.press("Escape");
  await window.waitForTimeout(600);
  const manualMark = await window.locator('[data-testid="mail-manual-tag-mark"]').count();
  check("列表显示「手动改过」标识（真实 store）", manualMark >= 1, `实际 ${manualMark}`);
  // 重算规则标签不会把手动标签冲掉（真实 store）
  await window.click('[data-nav="settings"]');
  await window.waitForTimeout(300);
  await window.click('[data-testid="settings-section-ai"]');
  await window.waitForTimeout(300);
  await window.click('[data-testid="rebuild-tags"]');
  await window.waitForTimeout(1200);
  await window.click('[data-nav="inbox"]');
  await window.waitForTimeout(900);
  const manualStill = await window.locator('[data-testid="mail-manual-tag-mark"]').count();
  check("手动标签不会被重算覆盖（真实 store）", manualStill >= 1, `实际 ${manualStill}`);
  await window.click('[data-testid="tag-panel-toggle"]');
  await window.waitForSelector('[data-testid="tag-panel"]', { timeout: 5000 });
  await window.locator('[data-testid="tag-panel-item"]', { hasText: "课业" }).first().click();
  await window.waitForTimeout(900);
  const labelCount = await window.locator(".mail-list .mail-item").count();
  check("按标签筛选出 1 封（真实 store）", labelCount === 1, `实际 ${labelCount}`);
  await window.click('[data-testid="tag-filter-clear"]');
  await window.waitForTimeout(500);
  await window.click('[data-nav="folder:INBOX"]');
  await window.waitForTimeout(1200);
  const backInbox = await window.locator(".mail-list .mail-item").count();
  check("回到收件箱恢复 20 封", backInbox === 20, `实际 ${backInbox}`);

  // 自定义视图（V2 M5：真实 IPC → SQLite views 表 + filter/sort 查询）
  await window.click('[data-nav="unread"]');
  await window.waitForTimeout(500);
  await window.click('[data-testid="save-view-btn"]');
  await window.waitForSelector('[data-testid="save-view-bar"]');
  await window.fill('[data-testid="view-name-input"]', "未读视图");
  await window.click('[data-testid="view-save-confirm"]');
  await window.waitForTimeout(800);
  await window.waitForSelector('[data-nav="view:1"]', { timeout: 3000 });
  check("保存视图后侧边栏出现（真实 store）", true);
  await window.click('[data-nav="view:1"]');
  await window.waitForTimeout(1000);
  const viewTitle = await window.$eval(".topbar .title", (el) => el.textContent).catch(() => "");
  check("视图标题显示", viewTitle.includes("未读视图"), viewTitle);
  const viewCount = await window.locator(".mail-list .mail-item").count();
  check("视图按未读筛选（真实 store）", viewCount >= 1, `实际 ${viewCount}`);
  await window.click('[data-testid="view-del"]');
  await window.waitForTimeout(800);
  const viewNavs = await window.locator('[data-nav^="view:"]').count();
  check("删除视图后侧边栏移除", viewNavs === 0, `实际 ${viewNavs}`);

  // 稍后提醒（V2 M6：真实 IPC → SQLite snoozes 表）；先切回「全部」避免已读过滤干扰
  await window.click('[data-nav="unread"]');
  await window.waitForTimeout(500);
  await window.click(".mail-list .mail-item");
  await window.waitForSelector('[data-testid="snooze-btn"]');
  await window.click('[data-testid="snooze-btn"]');
  await window.waitForSelector('[data-testid="snooze-panel"]');
  await window.click('[data-testid="snooze-1h"]');
  await window.waitForTimeout(900);
  const snoozeBtnText = await window.$eval('[data-testid="snooze-btn"]', (el) => el.textContent || "").catch(() => "");
  check("详情页显示已设提醒（真实 store）", snoozeBtnText.includes("已设提醒"), snoozeBtnText);
  const snoozeGroup = await window.locator('[data-testid="snooze-group"]').count();
  check("列表稍后提醒分组（真实 store）", snoozeGroup === 1, `实际 ${snoozeGroup}`);
  const snoozeTags = await window.locator('[data-testid="mail-snooze-tag"]').count();
  check("列表邮件带提醒标签", snoozeTags >= 1, `实际 ${snoozeTags}`);
  await window.click('[data-testid="snooze-btn"]');
  await window.waitForSelector('[data-testid="snooze-cancel"]');
  await window.click('[data-testid="snooze-cancel"]');
  await window.waitForTimeout(900);
  const snoozeGroupAfter = await window.locator('[data-testid="snooze-group"]').count();
  check("取消提醒后分组消失", snoozeGroupAfter === 0, `实际 ${snoozeGroupAfter}`);

  // 批量操作（V2 M7 + V2.1 UX：右键菜单进入多选 → 勾选框出现 → 批量工具栏）
  check("勾选框默认隐藏", (await window.locator('[data-testid="mail-check"]').count()) === 0);
  await window.locator(".mail-list .mail-item").first().click({ button: "right" });
  await window.waitForSelector('[data-testid="ctx-menu"]');
  await window.click('[data-testid="ctx-multi-select"]');
  await window.waitForTimeout(400);
  const checks = window.locator('[data-testid="mail-check"]');
  check("进入多选后勾选框出现（真实 store）", (await checks.count()) > 0, `实际 ${await checks.count()}`);
  await checks.nth(1).click();
  await checks.nth(2).click();
  await window.waitForSelector('[data-testid="bulk-bar"]');
  const bulkCount = await window.$eval('[data-testid="bulk-count"]', (el) => el.textContent || "").catch(() => "");
  check("批量工具栏出现且计数 3（真实 store）", bulkCount.includes("3"), bulkCount);
  await window.click('[data-testid="bulk-star"]');
  await window.waitForTimeout(900);
  check("批量星标后自动退出多选", (await window.locator('[data-testid="mail-check"]').count()) === 0);
  await window.click('[data-nav="starred"]');
  await window.waitForTimeout(1000);
  const starredAfterBulk = await window.locator(".mail-list .mail-item").count();
  check("批量星标生效（星标筛选 ≥3）", starredAfterBulk >= 3, `实际 ${starredAfterBulk}`);
  await window.click('[data-nav="folder:INBOX"]');
  await window.waitForTimeout(1000);
  // 右键菜单退出多选
  await window.locator(".mail-list .mail-item").first().click({ button: "right" });
  await window.waitForSelector('[data-testid="ctx-menu"]');
  await window.click('[data-testid="ctx-multi-select"]');
  await window.waitForTimeout(400);
  await window.locator(".mail-list .mail-item").nth(2).click({ button: "right" });
  await window.waitForSelector('[data-testid="ctx-exit-select"]');
  await window.click('[data-testid="ctx-exit-select"]');
  await window.waitForTimeout(400);
  check("右键菜单退出多选模式", (await window.locator('[data-testid="mail-check"]').count()) === 0);
  // 批量加标签
  await window.locator(".mail-list .mail-item").first().click({ button: "right" });
  await window.click('[data-testid="ctx-multi-select"]');
  await window.waitForTimeout(400);
  await window.locator('[data-testid="mail-check"]').nth(1).click();
  await window.click('[data-testid="bulk-label-btn"]');
  await window.waitForSelector('[data-testid="bulk-label-menu"]');
  await window.click('[data-testid="bulk-label-pick"]');
  await window.waitForTimeout(900);
  const chipsAfterBulk = await window.locator('[data-testid="mail-auto-tag"]').count();
  check("批量加标签 chips ≥1（真实 store）", chipsAfterBulk >= 1, `实际 ${chipsAfterBulk}`);

  // 快捷键（V2 M7：/ 聚焦搜索、s 星标、a 归档只读提示、l 打开标签面板、Esc 关闭）
  await window.locator(".mail-list .mail-item").nth(4).click();
  await window.waitForTimeout(400);
  await window.keyboard.press("/");
  await window.waitForTimeout(400);
  const focusedId = await window.$eval(":focus", (el) => el.getAttribute("data-testid")).catch(() => "");
  check("快捷键 / 聚焦搜索框", focusedId === "search-input", focusedId);
  await window.keyboard.press("Escape");
  await window.waitForTimeout(200);
  await window.keyboard.press("s");
  await window.waitForTimeout(900);
  const starMarksAfterKey = await window.locator('[data-testid="mail-star"]').count();
  check("快捷键 s 星标当前邮件", starMarksAfterKey >= 1, `实际 ${starMarksAfterKey}`);
  await window.keyboard.press("a");
  await window.waitForTimeout(400);
  const archToast = await window.$eval(".toast", (el) => el.textContent || "").catch(() => "");
  check("快捷键 a 归档只读提示", archToast.includes("P1") || archToast.includes("只读"), archToast.slice(0, 50));
  await window.keyboard.press("l");
  await window.waitForTimeout(600);
  check("快捷键 l 打开标签面板", (await window.locator('[data-testid="label-panel"]').count()) === 1);
  await window.keyboard.press("Escape");
  await window.waitForTimeout(400);
  check("Esc 关闭标签面板", (await window.locator('[data-testid="label-panel"]').count()) === 0);

  // 优先级功能已按用户要求下线（V2 M8 移除）
  await window.click('[data-nav="unread"]');
  await window.waitForTimeout(500);
  check("优先级按钮已移除", (await window.locator('[data-testid="priority-toggle"]').count()) === 0);
  check("🔥 优先级标记已移除", (await window.locator('[data-testid="mail-priority-tag"]').count()) === 0);

  // 发信：回复 → 真实 IPC（mock 传输层）→ SQLite sent_items → 已发送页
  await window.click('[data-nav="inbox"]');
  await window.waitForTimeout(500);
  await window.locator(".mail-list .mail-item").first().click();
  await window.waitForTimeout(400);
  await window.click('[data-testid="reply-btn"]');
  await window.waitForSelector('[data-testid="compose-modal"]', { timeout: 5000 });
  await window.click('[data-testid="compose-send"]');
  await window
    .waitForFunction(
      () => !document.querySelector('[data-testid="compose-modal"]') || document.querySelector('[data-testid="compose-result"]'),
      { timeout: 15000 }
    )
    .catch(() => {});
  const composeOutcome = await window.evaluate(() => {
    const res = document.querySelector('[data-testid="compose-result"]');
    return { modalOpen: !!document.querySelector('[data-testid="compose-modal"]'), result: res ? res.textContent || "" : "" };
  });
  check(
    "发信经真实 IPC 完成（成功即关闭弹层）",
    !composeOutcome.modalOpen || /已发送|失败|鉴权/.test(composeOutcome.result),
    JSON.stringify(composeOutcome).slice(0, 80)
  );
  if (composeOutcome.modalOpen) {
    await window.click('[data-testid="compose-close"]');
    await window.waitForTimeout(300);
  }
  await window.click('[data-nav="sent"]');
  await window.waitForSelector('[data-testid="sent-page"]', { timeout: 5000 });
  await window.waitForSelector('[data-testid="sent-item"]', { timeout: 5000 }).catch(() => {});
  const sentRows = await window.locator('[data-testid="sent-item"]').count();
  check("已发送页读到本地发送记录（SQLite）", sentRows >= 1, `实际 ${sentRows}`);

  // 批量总结进度（真实 IPC）：mock 模式下每封都秒回，UI 进度条一闪而过，
  // 因此直接在页面里订阅事件，验证主进程「开始前推 current+subject、结束后推 done」的契约
  const progressEvents = await window.evaluate(async () => {
    const events = []
    const off = window.api.onSummaryProgress((p) => events.push(p))
    const list = await window.api.listMails({ limit: 3, folder: "INBOX" })
    const ids = list.map((m) => m.id)
    await window.api.summarizePending(ids.length, true, ids)
    // 主进程 invoke 返回时，末尾的 finished 事件可能还在 IPC 投递路上，
    // 立刻 off() 会偶发漏掉它（真机跑出过一次 flake）→ 等一下再退订
    await new Promise((r) => setTimeout(r, 300))
    off()
    return events
  });
  const currentEvents = progressEvents.filter((e) => e.current === true && e.subject)
  check(
    "批量总结进度契约（current + subject + done/total + elapsedMs）",
    currentEvents.length >= 1 && progressEvents.some((e) => e.finished === true) && typeof currentEvents[0].elapsedMs === "number",
    `事件 ${progressEvents.length} 条，其中 current ${currentEvents.length} 条`
  );
  check("批量总结进度带主题（知道正在生成哪一封）", (currentEvents[0]?.subject ?? "").length > 0, String(currentEvents[0]?.subject).slice(0, 30));

  // 知识库（M3：真实 IPC → 集合由索引卡片派生 + 周报聚合）
  await window.click('[data-nav="knowledge"]');
  await window.waitForSelector('[data-testid="kb-page"]', { timeout: 5000 });
  // 真实 IPC 需要一次往返：等简报区块出现再断言（否则读到的还是空）
  await window.waitForSelector('[data-testid="kb-brief"]', { timeout: 10000 }).catch(() => {});
  const kbBrief = await window.$eval('[data-testid="kb-brief"]', (el) => el.textContent || "").catch(() => "");
  check("知识库本周简报（真实 IPC）", /收到\s*\d+\s*封/.test(kbBrief), kbBrief.replace(/\s+/g, " ").slice(0, 50));
  await window.waitForSelector('[data-testid="kb-collection"]', { timeout: 5000 });
  const kbCols = await window.locator('[data-testid="kb-collection"]').count();
  check("知识库集合来自真实索引卡片", kbCols >= 1, `实际 ${kbCols}`);
  await window.locator('[data-testid="kb-collection"]').first().click();
  await window.waitForSelector('[data-testid="kb-dossier"]', { timeout: 5000 });
  await window.waitForSelector('[data-testid="kb-mail"]', { timeout: 10000 }).catch(() => {});
  const kbMails = await window.locator('[data-testid="kb-mail"]').count();
  check("集合详情读到邮件（含卡片字段）", kbMails >= 1, `实际 ${kbMails}`);
  // 先确保这封有摘要（mock 模式下批量总结很快），再展开看摘要内容
  await window.evaluate(async () => {
    const cols = await window.api.listCollections()
    const first = cols[0]
    if (!first) return
    const list = await window.api.collectionMails(first.kind, first.value, 3)
    const ids = list.slice(0, 2).map((m) => m.id)
    if (ids.length > 0) await window.api.summarizePending(ids.length, true, ids)
  });
  await window.waitForTimeout(500);
  await window.click('[data-testid="kb-refresh"]').catch(() => {});
  await window.locator('[data-testid="kb-collection"]').first().click();
  await window.waitForSelector('[data-testid="kb-mail"]', { timeout: 8000 }).catch(() => {});
  await window.locator('[data-testid="kb-mail-toggle"]').first().click();
  await window.waitForSelector('[data-testid="kb-mail-expanded"]', { timeout: 8000 }).catch(() => {});
  // 摘要要经一次 IPC 往返才渲染出来：等它真的出现再断言
  await window
    .waitForFunction(
      () => /主旨|截止|重要度/.test(document.querySelector('[data-testid="kb-mail-expanded"]')?.textContent || ''),
      { timeout: 8000 }
    )
    .catch(() => {});
  const kbExpanded = await window.$eval('[data-testid="kb-mail-expanded"]', (el) => el.textContent || "").catch(() => "");
  check(
    "知识库展开后显示 AI 摘要（真实 IPC）",
    /主旨|截止|重要度/.test(kbExpanded),
    kbExpanded.replace(/\s+/g, " ").slice(0, 50)
  );

  // 草稿箱（V2 M9：真实 IPC → SQLite drafts 表；发送已开放）
  await window.click('[data-nav="drafts"]');
  await window.waitForSelector('[data-testid="drafts-page"]');
  await window.click('[data-testid="draft-new-btn"]');
  await window.waitForTimeout(400);
  await window.fill('[data-testid="draft-to-input"]', "lin@example.edu");
  await window.fill('[data-testid="draft-subject-input"]', "课题讨论");
  await window.fill('[data-testid="draft-body-input"]', "周三下午讨论第三章数据。");
  await window.click('[data-testid="draft-save-btn"]');
  await window.waitForTimeout(800);
  const draftItems = await window.locator('[data-testid="draft-item"]').count();
  check("保存草稿后列表出现 1 封（真实 store）", draftItems === 1, `实际 ${draftItems}`);
  const sendDisabled = await window.$eval('[data-testid="draft-send-btn"]', (el) => el.disabled).catch(() => false);
  check("发送按钮已开放（可点）", sendDisabled === false, `disabled=${sendDisabled}`);
  await window.fill('[data-testid="draft-subject-input"]', "课题讨论 v2");
  await window.click('[data-testid="draft-save-btn"]');
  await window.waitForTimeout(800);
  const draftSubject = await window.$eval('[data-testid="draft-item"] .from', (el) => el.textContent || "").catch(() => "");
  check("草稿覆盖保存生效（真实 store）", draftSubject.includes("v2"), draftSubject);
  await window.click('[data-testid="draft-delete"]');
  await window.waitForTimeout(800);
  check("删除草稿后列表为空", (await window.locator('[data-testid="draft-item"]').count()) === 0);
  await window.click('[data-nav="inbox"]');
  await window.waitForTimeout(800);

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await window.screenshot({ path: path.join(ARTIFACTS, "electron.png"), fullPage: false });

  check("无 console.error", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 200));
} catch (e) {
  check("Electron 冒烟无异常", false, String(e && e.message ? e.message : e));
} finally {
  if (app) await app.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log("\n===== Electron 冒烟结果 =====");
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
