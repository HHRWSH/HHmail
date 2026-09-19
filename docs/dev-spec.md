# HHmail 开发实现规格

> **说明（现状）**：本文是早期（P0/只读阶段）的设计与调研文档，当时只做只读收信；
> 当前版本已支持**发信**（回复 / 转发 / 新写 / 草稿，SMTP + XOAUTH2 或个人邮箱 SMTP），
> 收信侧仍保持只读（不改动服务端邮件）。功能现状以 README 与使用说明为准。

> 说明：本文是开发过程记录，早期按「V2 / V2.1 / V2.2」分阶段命名；
> 对外发布的版本号从 **1.0.0** 起（见 package.json），文中出现的 V2.x 只是历史阶段代号。

> 已确认范围：**V2.0**（AI 搜索问答 M7 + 附件下载 UI + 多文件夹只读）与 **V2.1**（自定义视图、标签/星标、稍后提醒、批量操作、快捷键、优先级收件箱）。
> 写信/发送：**先只做草稿/编辑器**，真正发送待 学校 授权确认（见 §8）。
> 目标读者：在 `program/` 中执行开发、跑测试、提交 git 的 AI/工程师。请严格遵守 `AGENTS.md`（每次改动 commit + 测试通过）。

---

## 0. 现有架构扩展点（先读，改造用）

| 层 | 关键文件 | 扩展方式 |
|---|---|---|
| 跨进程 DTO | `src/shared/types.ts` | 新增 `MailLabel` / `SavedView` / `SnoozeItem` / `AiAskResult` / `MailFolder` / `AttachmentDownload` 等类型 |
| IPC 契约 | `src/shared/ipc-contract.ts` | 新增 channel 常量 + 请求/响应类型 |
| IPC zod | `src/shared/ipc-schemas.ts` | 为每个新 channel 加 schema |
| window.api 白名单 | `src/shared/api.ts` + `src/preload/index.ts` | 在 `WindowApi` 与 preload 实现同步加方法 |
| 渲染端 API | `src/renderer/src/bridge.ts` / `mockBridge.ts` | 加对应 mock 方法（E2E mock 走这里） |
| 存储抽象 | `src/main/db/store.ts` + `sqlite.ts` | 加标签/视图/稍后提醒/文件夹的接口与实现 |
| schema 迁移 | `src/main/db/schema.ts` | 追加 `SCHEMA_MIGRATIONS`（只增不改，规范 §14） |
| AI 服务 | `src/main/ai/service.ts` + `provider.ts` + `deepseek.ts` | `MailAiService` 加 `askInbox(...)` / `extractActions(...)` 等方法 |
| 邮件后端 | `src/main/mail/provider.ts` + `imap.ts` + `sync.ts` | 加"按文件夹只读打开/同步"，新增 `openFolder` / 文件夹列表 |
| IPC handlers | `src/main/ipc.ts` | 注册新 channel，走 `wrap(ctx, schema, fn)` |
| 渲染端 | `src/renderer/src/pages/*` + `registry.tsx` | 新增 `AISearch` / `Views` 页面，`Inbox` 支持多选/标签/视图 |
| 通知 | `src/main/notifications.ts` | 复用现有 `Notification` 弹窗做稍后提醒 |

> 依赖倒置红线（`safety.test.ts` 强制）：sync/搜索/AI 业务/UI 不得 import `imapflow`/`better-sqlite3`/`openai`。新增实现必须继续遵守。

---

## 1. V2.0 — AI 搜索问答（M7，最高优先级）

### 1.1 目标
自然语言问收件箱，如「上周导师发了什么邮件」「这封邮件有什么行动项」，返回答案 + 可跳转的引用邮件。

### 1.2 后端
- `src/main/ai/service.ts` 新增：
  ```ts
  interface AskInboxResult { answer: string; citations: { id: number; subject: string; fromName: string; dateTs: number }[] }
  askInbox(question: string, opts: { topK?: number; systemPrompt?: string }): Promise<AskInboxResult>
  ```
  实现：`store.search(question, topK)` 或按时间/发件人漏斗 → 对每条命中 `store.getMessage(id)` 取正文 → 截断 → 拼接 prompt（含系统规则：找不到就承认未找到，**不要编造**；末尾附引用列表）→ DeepSeek 回答 → 解析出引用。
- `src/main/db/store.ts` / `sqlite.ts`：已具备 `search` + `getMessage`，无需新建；可加 `searchByQuery(filter)` 供视图复用。
- `src/main/db/search.ts`：可加 `ragCandidates(question, topK)` 返回正文摘要列表（不含邮件正文日志）。

### 1.3 契约
- `ipc-contract.ts`：`AI_ASK_INBOX: 'ai:ask-inbox'`，`AskInboxArgs { question: string }`。
- `ipc-schemas.ts`：`askInboxSchema`（`question` 非空字符串，长度 ≤ 2000）。
- `types.ts`：`AiAskResult { answer: string; citations: { id: number; subject: string; fromName: string; dateTs: number }[]; model: string }`。
- `api.ts` / `preload/index.ts`：`askInbox(question)`。

### 1.4 渲染端
- 新增 `src/renderer/src/pages/AISearch.tsx`，注册进 `registry.tsx`（数据驱动导航，放到「AI」组或收件箱顶栏「🔍 问 AI」）。
- 复用现有 AI 抽屉/对话样式；回答下方渲染引用卡片，点击 `onOpenMail(id)` 跳转详情。

### 1.5 测试
- `service.test.ts`：用 `FakeAiProvider` 验证 prompt 中含引用、无正文泄漏、找不到时输出「未找到」。
- `ipc-schemas.test.ts`：`askInboxSchema` 校验。
- L2/L3：mockBridge 加 `askInbox`，E2E 走 MVP 假数据问「上周导师」断言回答与引用存在。

---

## 2. V2.0 — 附件下载 UI

### 2.1 现状
`MailProvider.fetchAttachment(uid, partId)` 已实现；`store.getMessage` 返回 `attachments: AttachmentMeta[]`（含 `id/filename/contentType/size`），但**缺 partId**，UI 未接。

### 2.2 改动
- `types.ts` `AttachmentMeta` 增加 `partId: string`（本轮迁移后补全老数据）。
- 新增 channel `MAIL_GET_ATTACHMENT: 'mail:get-attachment'`，`GetAttachmentArgs { id: number; partId: string }`。
- `ipc.ts` handler：`ctx.provider.fetchAttachment(uid, partId)` → 返回 `{ filename, contentType, buffer(base64) }`；用 `store.getMessage(id)` 取 uid。
- `api.ts`/preload：`downloadAttachment(id, partId): Promise<{ filename; contentType; dataBase64 }>`。
- `MailDetail.tsx`：附件卡片点击 → 调 `downloadAttachment` → 渲染端用 `new Blob([...])` + `<a download>` 触发下载/保存（或经 preload 调用主进程写文件到下载目录）。
- 注意：附件下载仍走 `BODY.PEEK[part]`，只读不标已读。

### 2.3 测试
- `store`：getMessage 附件携带 partId（老数据回填迁移）。
- L2 mock：点击附件卡片出现「已下载/已保存」提示。

---

## 3. V2.0 — 多文件夹只读

### 3.1 目标
除 INBOX 外，只读读取「已发送 / 归档 / 草稿」等文件夹。

### 3.2 后端
- `provider.ts`：新增 `listFolders(): Promise<{ name: string; path: string }[]>`；区分 `openInboxReadOnly()` 与 `openFolderReadOnly(folderPath)`。
- `imap.ts`：实现 `listFolders`（`LIST "" "*"`）与 `openFolderReadOnly`（`mailboxOpen(path, { readOnly: true })`）。
- `sync.ts`：`run` 改为同步**一个文件夹列表**（配置，默认 `['INBOX']`），每个文件夹独立 `uidValidity/uid` state（`sync_state` 表加 `folder` 列或独立表）。
- `SyncStateRecord` 增加 `folder: string`。

### 3.3 契约
- `types.ts`：`MailFolder { path: string; name: string; hierarchyDelimiter?: string }`；`SyncResult.folders?: string[]`。
- `api.ts`/preload：`listFolders(): Promise<MailFolder[]>`；`syncMail` 支持可选 `folders?: string[]`。

### 3.4 渲染端
- 侧边栏新增「文件夹」导航（数据驱动，来自 `listFolders`），点击切换查询文件夹；`Inbox` 查询参数带 `folder`。
- `store.query` 增加 `folder` 过滤参数；`messages` 表加 `folder` 列（迁移）。

### 3.5 测试
- `imap.test.ts`：`LIST` 解析、打开非 INBOX 文件夹仍 `readOnly`。
- `sync.test.ts`：多文件夹状态机独立、不互相污染。
- `sqlite.test.ts`：`folder` 列迁移与查询。

---

## 4. V2.1 — 自定义视图 / 保存视图

### 4.1 目标
像 Notion 数据库：按「发件人 / 日期 / 未读 / 标签 / 关键字」筛选 + 排序，并**命名保存**到侧边栏。

### 4.2 数据模型
- `SavedView { id: number; name: string; filter: ViewFilter; sort: ViewSort; createdAt: number }`。
- `ViewFilter`（JSON 列）：`{ from?: string; unread?: boolean; hasAttachment?: boolean; labelIds?: number[]; dateFrom?: number; dateTo?: number; text?: string }`。
- `ViewSort`：`{ by: 'date'|'from'|'subject'; dir: 'asc'|'desc' }`。
- `sqlite`：`views` 表 + `SCHEMA_MIGRATIONS`。

### 4.3 契约
- channel：`VIEWS_LIST` / `VIEWS_SAVE` / `VIEWS_DELETE`。
- `store` 增加 `listViews() / saveView(v) / deleteView(id)`。
- `api.ts`/preload：`listViews() / saveView(v) / deleteView(id)`。

### 4.4 渲染端
- 侧边栏「视图」组（数据驱动）；顶栏「保存为视图」按钮。
- `Inbox` 查询支持视图筛选（`store.query` 增加 `filter/sort` 参数）。

### 4.5 测试
- 纯函数 `filterMatches(view, mail)`（新 `renderer` 或 `shared` 单测）+ `store` 视图 CRUD。

---

## 5. V2.1 — 本地标签 / 星标

### 5.1 模型
- `labels` 表：`{ id, name, color, isStar? }`。
- `message_labels` 关联表：`(message_id, label_id)`。
- `Star` 用内置标签 `__star__` 或 `messages.starred` 列（推荐独立 `starred` 列，简单）。

### 5.2 契约
- `LABELS_LIST` / `LABELS_CREATE` / `LABELS_DELETE` / `MAIL_SET_LABELS` / `MAIL_TOGGLE_STAR`。
- `MailListItem` / `MailDetail` 增加 `labels: { id/name/color }[]` 与 `starred: boolean`。
- `QueryParams` 增加 `labelIds?: number[]`、`starredOnly?: boolean`。

### 5.3 渲染端
- 列表项标签 chips；详情页加「加标签 / 星标」；侧边栏按标签筛选。

### 5.4 测试
- `store` 关联表 CRUD + 查询过滤；`sqlite.test.ts` 迁移。

---

## 6. V2.1 — 稍后提醒（Snooze）

### 6.1 模型
- `snoozes` 表：`{ id, message_id, snooze_until, note?, created_at, notified_at? }`。
- 每封邮件唯一一条未送达 snooze。

### 6.2 行为
- 用户「稍后提醒」→ 写入表；到点由主进程定时器（复用 `refreshIntervalSec` 调度）检查 `snooze_until <= now && notified_at is null` → 弹 Windows 通知（复用 `notifications.ts`）→ 置 `notified_at`。
- UI：邮件若处于 snooze，列表按「稍后提醒」分组展示；详情页可取消。

### 6.3 契约
- channel：`SNOOZE_SET` / `SNOOZE_CANCEL` / `SNOOZE_LIST`。
- `store` 增加对应方法。

### 6.4 测试
- 纯函数 `dueSnoozes(now, rows)`；定时器用可注入 clock。

---

## 7. V2.1 — 批量操作 / 快捷键

### 7.1 批量
- `Inbox` 列表支持 `Ctrl/Cmd` 多选 / 全选；顶栏出现批量 toolbar：`标记已读 / 加标签 / 星标 / 稍后提醒 / 删除本地 / 导出`。
- 契约：`MAIL_BULK: 'mail:bulk-read'`（`{ ids: number[]; read?: boolean }`）、`MAIL_BULK_LABEL`。
- `store` 加 `bulkMarkRead` / `bulkSetLabels`。

### 7.2 快捷键
- `Inbox`/`MailDetail` 增加全局 `keydown`：
  - `j/k` 上/下；`Enter` 打开；`s` 星标；`l` 加标签；`/` 聚焦搜索；`u` 标未读；`a` 归档入口（只读提示）；`Esc` 关闭弹层。
- 纯函数 `shortcutMap`（可单测）。

---

## 8. V2.1 — 优先级收件箱 / 置顶

### 8.1 目的
把重要邮件（学术/截止日期/导师/教务）置顶，减少干扰。

### 8.2 实现
- 轻量：规则打分（发件人域名 `school` 加分、带附件加分、`!!重要!!`/`DDL`/`截止` 关键词加分）。
- 可选 AI：用 `MailAiService.classify()` 打 `priority` 标签（成本较高，默认规则，AI 作为后续开关）。
- `messages` 加 `priority_score`（0–100）列；`QueryParams```sort` 支持 `priority`；顶栏「优先级」开关。

### 8.3 测试
- `priority.test.ts` 规则打分纯函数。

---

## 9. P1（待授权，仅预留）：写信 / 发送 · 草稿/编辑器

> 真正发送需 学校 Graph `Mail.Send` 或 SMTP AUTH。**本轮只做「草稿 + 编辑器」本地功能**，不碰发送。

- `provider.ts` 已有 `OutgoingDraft` 与 `send?`（P0 抛 UnsupportedOperation）。
- 本地草稿：`drafts` 表 `{ id, to[], subject, body, created_at, updated_at }`；编辑/保存/列表/删除。
- channel：`DRAFTS_LIST` / `DRAFTS_SAVE` / `DRAFTS_DELETE`。
- UI：顶栏「✎ 写邮件」→ 草稿编辑器面板（React），保存本地；「发送」按钮先禁用/提示「待 学校 授权」。

---

## 10. 建议实现顺序（一次一个可提交单元）

1. **M0**：脚手架 —— 新增 channel/类型/schema/preload 占位 + 测试（不改行为，纯增量，跑通再往下）。
2. **M1**：AI 搜索问答（§1）。
3. **M2**：附件下载 UI（§2）。
4. **M3**：多文件夹只读（§3）。
5. **M4**：标签/星标（§5） + 数据模型迁移。
6. **M5**：自定义视图（§4）。
7. **M6**：稍后提醒（§6）。
8. **M7**：批量 + 快捷键（§7）。
9. **M8**：优先级收件箱（§8）。
10. **M9**：草稿编辑器（§9，发送禁用）。

每步：`npm run typecheck` + `npm test` + `cd tests && npm test` 全绿后再 `git commit`。

---

## 11. 验证命令（交付前必须全绿）

```bash
cd program
npm run typecheck
npm test
cd tests && npm install && npm test
npm run test:all
```

---

## 12. 风险提示

- **数据库迁移**：`SCHEMA_MIGRATIONS` 只增不改；老用户升级需兼容（`fullHistory` 已是一例）。
- **多文件夹**：会改变 `SyncEngine` 主循环与 `sync_state` 表结构，务必用 `sqlite.test.ts` 覆盖升级与回退。
- **AI 搜索问答**：引用解析要稳；RAG 上下文字符数要设上限，防 token 溢出。
- **附件下载**：老数据 `partId` 可能为空，需回填或提示重新同步该邮件。
- **不能发信**：发送按钮明确置灰并提示「待 学校 授权」，不要给用户可发送的假入口。

---

## 13. 真机迭代补充（均已实现，2026-09 批次）

### 13.1 双份摘要：给人看的「决策卡」 + 给 AI 检索的「索引卡片」

- 用户反馈「摘要很水」的真因是**输入污染**（HTML 邮件的 `<style>` CSS 被当正文入库、UTC 时间与本地时间不一致），
  不是模型问题：提示词改为固定字段模板（一句话主旨/时间/地点/金额/截止/行动项/分类/可信度 + 「原文未提供」禁编造），
  并在解析层 `cleanMailText` 清洗正文（`src/shared/text.ts`），启动时 `db/repair.ts` 清洗存量。
- `mail_summaries`（人类摘要）与 `mail_index_docs`（检索卡片 `[TYPE]/[COURSE]/[TERM]/[DUE]/[FROM]/[ORG]/[ENTITIES]/[ALIASES]/[FACTS]/[QUESTIONS]/[QUOTE]`）
  分两次调用生成；`listUnsummarized` 把「缺摘要或缺索引卡片」都算待处理。
- 检索评测（`docs/检索评测.md`，20 题标注集）：Recall@5 87.5%、集合覆盖率 95.2% → **结论：不需要引入向量检索**。

### 13.2 知识库（📚）：集合由索引卡片派生

- 集合 = 卡片里的 COURSE / TYPE 字段（多标签，一封邮件可属多个集合），另有 `collection_overrides` 支持手动移出。
- 只用于**浏览与汇总**（周报、档案卡），不做硬过滤；`weeklyBrief` 全部本地聚合、不调模型 → 不会编造。
- 集合页可「✨ 问 AI」把问题带到助手页。

### 13.4 检索质量：跨语言 / 简繁 / 「第一条就命中」（第 3 轮评测）

- **跨语言**：`src/shared/bilingual.ts` 维护 60+ 组校园邮件中英概念（图书馆↔library、学费↔tuition/fees、
  宿舍↔hostel/accommodation、实习↔internship、考试↔exam…），命中一侧就补另一侧；
  `wordLevelVariants` 处理字级不敢收的歧义字（注册→註冊、回复→回覆、平台→平臺）。
- **简繁**：`src/shared/zhTw.ts` 只收高置信度无歧义字对（学→學、费→費、图→圖、馆→館），
  查询与语料各写一种时不再 0 命中；`zhVariants/toTraditional/toSimplified` 都是纯函数。
- **检索词**：`src/shared/retrievalQuery.ts` → `buildRetrievalQuery(question, keywords)`：
  清洗泛化词（邮件/相关）、按「或/和/与」拆并列短语、加简繁变体与跨语言同义词、中文切 3/2 字滑窗、
  英文长词补 5 字前缀（GraderScope↔Gradescope），并按 原词3 / 变体3 / 同义词2 / 滑窗1 加权。
  `hasContent=false`（纯时间/类型问题）时**不做相关性重排**，保持集合视图的截止时间序。
- **排序**：`src/shared/retrievalRank.ts` → `rankByTerms`：
  主题命中 > 卡片命中、英文按词边界（fee 不命中 coffee）、重叠词只算一次（避免 notif/notification/notifications 刷分）、
  **全库 IDF**（`SqliteMessageStore.indexRarity`，高频词 course/program/notification 降权）、
  汇总类标题（Daily Notifications / Weekly Highlights）降权。
- **召回**：`searchIndexDocs` 增加 ≥2 字词的 LIKE 兜底并连带 `m.subject`（trigram 对 2 字中文无效）；
  结构化过滤路 `searchIndexByFilter` **刻意不重排**（集合视图按「未来最近截止优先」列举）。
- 评测结论（`docs/检索评测.md`）：Recall@1 25% → 100%、Recall@5 87.5% → 100%、集合覆盖率 95.2% → 100%，
  「最近兜底」命中数降到 0 → **仍然不需要向量检索**。
- 调试入口：`node scripts/run-eval.mjs --dbg` → `tests/eval/dbg.md`（每题候选、得分、命中词、卡片全文；gitignored）。

### 13.5 聊天式 AI 助手（M4）

- 迁移 v14：`chat_sessions` / `chat_messages`（`citations` 存 JSON 数组，读回必须用 `parseCitations`，
  **不能用 `safeJsonArray`**——它会把对象 `String()` 化成 `[object Object]` 导致引用丢失）。
- 契约：`ai:chat-sessions|messages|new|delete|rename|ask`；`ai:chat-ask` 先落用户消息，
  再把最近 8 条作为 `history` 交给 `askInbox`，回答与引用一起入库后返回完整消息。
- 追问扩展：`expandFollowUp(question, prevUserQuestion)`（`src/shared/askIntent.ts`）；
  注意 `history` 里最后一条用户消息就是当前问题，取「上一轮」时必须跳过它。
- 能力路由：`classifyAsk` 分 `capability|smalltalk|mail`；只有 `mail` 才检索。
  判定顺序 = 寒暄 → **邮件内容标记（截止/导师/课程号…）优先判 mail** → 能力正则（防止
  「你能帮我查一下这周的截止吗」被误判成能力类而只回一段说明）。
- 渲染端：左栏会话列表（＋新建 / 删除 / 切换），右栏消息流（用户右侧、助手左侧，Markdown 预览可切源码、
  引用可点击跳转），Enter 发送；回答返回后**以服务端消息列表整体刷新**（只 append 会把用户自己那条吃掉）。

---

## 14. V2.2 通用化（去学校绑定 + 设置目录化 + 主题）

目标：让非 学校 的学生也能直接用，同时把「可调项」交还给用户。

### 14.1 去学校绑定

- 产品名不再硬编码：`AppSettings.brandName` / `brandSubtitle`（默认「HHmail」/「收信只读 · 支持发信 · AI 摘要」；旧默认「本地只读 · AI 摘要」会在启动时一次性升级），
  侧边栏、窗口标题、托盘提示都跟随设置；`DEFAULT_BRAND_NAME` 在 `shared/defaults.ts`。
- 应用标识：`package.json` name `hhmail`、version `1.0.0`、productName `HHmail`、appId `app.hhmail.desktop`，
  exe/安装包变成 `HHmail 1.0.0.exe` / `HHmail Setup 1.0.0.exe`。
- 图标：`scripts/make-icon.mjs`（纯 Node，无依赖）生成中性的「信封 + AI 星芒」`resources/icon.ico`
  与 `src/main/trayIcon.ts`（托盘 32×32 data URL）；不再使用字母 "C" 的单色图标。
- 数据目录迁移：老版本 userData 是 `%APPDATA%\legacy-mail-app`，新版是 `%APPDATA%\mail-ai-assistant`（改名 HHmail 后仍继续使用该目录，避免老用户数据丢失）；
  `migrateLegacyUserData()` 在首次启动时整体复制（数据库/加密登录态/设置），用户无需重新登录。
  数据库文件名 `mail-ai.db`，`resolveDbPath()` 兼容旧的 `legacy-mail.db`。
- 环境变量前缀 `HHMAIL_*`（`HHMAIL_MOCK` / `HHMAIL_USERDATA` / `HHMAIL_DISABLE_GPU`），旧 `MAILAI_*` / `LEGACY_MAIL_*` 仍兼容（E2E 已切到新名）。
- 发信通道的 `mode` 由 `'school'` 改为 `'school'`；测试邮件文案、提示词（`DEFAULT_SUMMARY_PROMPT` / `DEFAULT_ASK_PROMPT` / `QA_SYSTEM`）
  全部改为不绑定学校；仍在使用「学校 版」默认提示词的用户由 `ai.prompt_migrated_generic` 一次性迁移。
- 侧边栏左下角的「只读模式」徽标移除（**行为不变**：仍然只读，说明挪到 设置 → 关于与数据）。

### 14.2 设置：目录式折叠 + 新增可调项

- 6 个可折叠分类：外观 / 同步与通知 / AI 总结与问答 / 发信 / 账户 / 关于与数据
  （`settings-section-<id>`，默认全部展开，折叠状态存 `localStorage: mail-ai-settings-open`）。
- 新增设置（`AppSettings` / `SetSettingsArgs` / zod schema / 设置存储 / mock 存储同步更新）：
  | 键 | 默认 | 作用 |
  | --- | --- | --- |
  | `ui.theme` | system | 主题：跟随系统 / 浅色 / 深色（`shared/theme.ts` 解析，写到 `html[data-theme]`） |
  | `ui.density` | standard | 界面密度（`--row-h` / `--row-pad-y` / `--app-font-size`） |
  | `ui.brand_name` | HHmail | 侧边栏/窗口标题显示名 |
  | `ui.brand_subtitle` | 收信只读 · 支持发信 · AI 摘要 | 侧边栏副标题（空 = 不显示；旧值「本地只读 · AI 摘要」自动升级） |
  | `ui.list_page_size` | 20 | 列表一次显示多少封 |
  | `ui.relative_time` | true | 时间显示：相对（刚刚/N 分钟前）或绝对（YYYY-MM-DD HH:mm） |
  | `mail.open_marks_read` | true | 打开邮件时本地标记已读 |
  | `sync.on_startup` | false | 启动后自动同步一次 |
  | `mail.confirm_send` | false | 发送前二次确认 |
  | `ai.ask_topk` | 5 | AI 问答引用邮件条数（3-12） |
- 渲染端用 `SettingsContext` 下发（避免层层传参）；`App` 负责把主题/密度写到 `<html>` 并在 `main.tsx` 里先套用缓存主题防闪烁。
- 深色主题只覆盖设计令牌；邮件正文在深色下仍保持浅底深字（HTML 邮件多按浅色设计），见 `styles.css` 末尾。

### 14.3 真机反馈修复（附件 / 深色可读性 / 设置排版 / 进度文案）

- **附件下载（严重 bug，之前完全用不了）**：`ImapMailProvider.fetchAttachment` 原来调用
  `msg.attachment(partId)` —— imapflow 1.x 的 `FetchMessageObject` 根本没有这个方法，
  所以每次都抛「附件不存在或已被删除」。改为 ① `downloadMany([uid], [partId], { uid: true })`
  （一步拿到 Buffer + meta），② 兜底 `fetchOne(..., { bodyParts: [partId] })` 读 `bodyParts` Map，
  ③ 都没有才报错并给出可操作提示；加 30s 超时。**新增 4 个单测**（含「客户端没有旧 API 也要成功」的回归用例）。
- **附件保存位置可配置**：新设置 `mail.attachment_dir`（空 = 每次弹系统保存对话框）；
  新 IPC `mail:attachment-save`（主进程落盘：固定目录时自动 ` (1)(2)` 去重、mock 模式落临时目录避免阻塞 E2E）、
  `shell:pick-directory`、`shell:open-path`；渲染端点击附件改为调用 `saveAttachment`，提示「已保存：<路径>」。
- **深色可读性**：把散落的深色硬编码（`#d70015` / `#b25000` / `#c0392b` / `#c77c00` / `#7a78e6` 等）
  收敛为语义变量 `--danger-strong / --warn-strong / --ok-strong / --md-strong / --tag-attach-fg / --star-fg / --snooze-fg`，
  深色主题给一套高亮版本；toast 用 `--toast-bg/--toast-fg` 反色（原来 `background: var(--text)` + 白字，
  深色下变成白底白字，完全看不见）；表单控件/下拉/Markdown 代码块在深色下显式覆盖底色。
- **设置排版**：`.settings-row` 统一为「固定 116px 标签列 + 内容列」的 flex 行，
  `padding: 9px 0 / min-height: 44px / border-bottom` 行行一致；`.settings-row-top` 只改对齐不改间距。
- **进度文案**：`formatProgressText` 去掉「预计还需」（用户反馈多余且会跳动），只留「x / y · 已用 xx」；
  `estimateRemainingMs` 保留但界面不再使用。
- **顶部保存按钮**：设置页只保留底部一个（`settings-save-bottom`），顶部那个删除。

### 14.4 真机反馈第二轮（同步可靠性 / AI 界面 / 引用可点 / 提示词隐私）

- **长时间不同步 / 同步不上（怀疑与休眠有关）**：根因是自动刷新原本是**渲染进程**的 `setInterval`——
  窗口隐藏到托盘/最小化后 Chromium 会节流甚至暂停后台定时器，休眠期间彻底不走；唤醒后也不会补偿，
  而休眠期间 IMAP 连接多半已废，旧代码又没有任何看门狗，同步会挂在半死连接上把串行链堵死。
  修法：新增 `src/main/mail/autoSync.ts`（主进程调度：20 秒心跳、按设置的间隔触发、失败 60 秒后重试、
  单次超 2 分钟判卡死并 `provider.close()`、导出 `tick/kick` 便于单测），`index.ts` 里接 `powerMonitor`
  的 `resume`/`unlock-screen` → 先关连接再 `kick` 立即同步；窗口 `backgroundThrottling: false`；
  渲染端删掉那个 `setInterval`（只保留读取间隔用于状态显示）。单测 8 例（间隔/关闭/并发跳过/失败重试/kick/看门狗/stop）。
- **AI 助手右上角的「总结所有未生成摘要的邮件」按钮移除**：批量总结统一放设置页（页面上的进度条保留，
  在设置页触发的任务切到 AI 页也能看到进度）。
- **引用找不到正确邮件**：① 服务端新增 `pickMentionedCitations`——只把**回答里真正提到**的邮件作为引用
  （归一化后按主题前 12/后 10 字匹配；都没提及时退回前 3 条），不再把十几条检索命中全塞给用户；
  ② 引用区从回答**下方**移到回答**上方**；③ 新增 `src/shared/citations.ts` 的 `linkifyCitations`：
  把回答里出现的邮件主题变成 `[主题](#mail-<id>)` 锚点（markdown 渲染器放行 `#mail-` 链接），
  渲染端拦截点击 → 直接跳回收件箱那封邮件。
- **提示词里的私人信息**：默认提示词的示例里带着真实联系人邮箱（学校真实联系人邮箱等），
  会被打进安装包。修法：① 示例邮箱全部换成 `*@example.edu`；② 历史默认提示词不再存原文，
  改为 `LEGACY_SUMMARY_PROMPT_HASHES`（只存 `sha256(normalizePromptText(prompt))`），
  迁移判定改为比哈希（`isLegacyDefaultPrompt`），这样旧文案（含私人邮箱）不再进 bundle 且老用户仍能迁移；
  ③ 新增单测断言默认提示词里不含非 example 域名邮箱。

### 14.5 自动标签（V2.2 A+B 方案）

用户选择：**A 规则映射 + B AI 主题标签**，并要求「B 方案可以挑示例邮件让 AI 当参考」。

- 数据（迁移 v15）：`mail_tags(message_id, tag, source, created_at)`（source = rule / ai；与手动 labels 分开存）
  + `tag_examples(message_id, tags, created_at)`（用户挑的示例邮件）。规则标签可整体重算，AI 标签随索引卡片更新。
- 纯函数 `src/shared/tags.ts`：`deriveRuleTags`（类型/课程号/平台/截止状态，最多 4 个、截止只给一个状态）、
  `parseAiTags`（统一到词表写法、最多 3 个）、`buildTagPromptBlock`（词表 + 示例邮件 few-shot）、
  `parseVocabulary` / `normalizeTag` / `mergeTags` / `visibleTags`（列表最多 3 个 + N）。
- B 方案零额外成本：索引卡片提示词新增 `[TAGS]`，标签词表与示例块作为 `## 标签规则` 注入 `buildIndexPrompt`，
  与卡片同一次调用产出；`buildIndexCardFor` 落库时同时写 rule/ai 两类标签（开关 `tags.auto` 关闭则都不写）。
- 用户挑示例：详情页「🏷 设为 AI 标签示例」→ 勾选标签 → `tags:example-set`；
  设置页展示示例列表并可移除；示例只含主题与标签，不含正文。
- 其它通道：`tags:counts`（标签分布）、`tags:examples`、`tags:rebuild`（按现有卡片重算规则标签，零 AI 成本）；
  列表查询新增 `autoTag` 过滤（点标签 chip 触发，只筛不改）。

### 14.6 真机反馈第三轮（同步可靠性 2.0 / 性能 / 多服务商 / 设置排版）

- **同步还要更可靠**：调度器新增两条自愈路径 —— ① 「陈旧自愈」：超过 2 个间隔没有成功同步（休眠、托盘久置、
  漏掉唤醒事件）就无视节流立刻补一次；② 主进程监听 `browser-window-focus` → `kickIfStale`（用户打开窗口就补）。
  同步成功后执行 `afterSync` 钩子：开了「新邮件自动总结」时自动补摘要（每次最多 3 封，失败只记日志）。
- **性能（切收件箱卡顿）**：`attachLabels` / `attachAutoTags` 原来把 1000 个 id 拼成一条 `IN (...)` ——
  占位符又慢又可能撞 SQLite 变量上限。改为 400 一组分块查询；新增回归测试（1200 封列表 < 1.5s）。
- **标签筛选**：`QueryParams.autoTags: string[]`（OR）；列表工具栏「🏷 标签」面板支持搜索与多选；
  侧边栏把手动标签与自动标签放进同一个「标签」分组（交互一致：点一下即筛选）。
- **词表编辑器**：逗号/顿号文本框 → chip + 「＋ 添加」/「✕ 删除」（`normalizeTag` 去重）。
- **设置排版规范化**：`.settings-row` 改 CSS Grid（`--settings-label-w` + 内容列），所有行内容左边界一致；
  每个 `.settings-row` 必须有 `.name` 子元素，并且**加了 E2E 断言**（`withoutName === 0` 且内容列偏移差 ≤ 2px）防止回归。
- **多 AI 服务商**：新增 `src/shared/aiProviders.ts`（DeepSeek / 百炼 / Kimi / 智谱 / OpenAI / 自定义 + 校验函数）；
  `AppSettings.aiProvider` + `aiCustomBaseUrl`，API Key 按服务商存 `ai.api_key.<provider>`（旧键位一次性迁移）；
  DeepSeek 只保留 `deepseek-flash`（`ALLOWED_AI_MODELS` 收窄，其余模型名一律拒绝）。
- **问答引用条数**：上限 12 → 40（`MAX_ASK_TOPK`），并按 topK 缩放召回上限；问句含「全部/所有/都有哪些」时自动 ×3。
- **打包产物清理**：新增 `scripts/clean-dist.mjs` 并在 `pack` 前执行（删除历史版本 exe/blockmap 与中间目录）。

### 14.7 真机反馈第四轮（标签统一 / 设置页重设计 / 列表性能 / 头像修复）

- **统一标签体系**（用户要求合并两套标签）：迁移 v16 把旧 `labels` + `message_labels` 整体写入
  `mail_tags(source='manual')`，并新建 `tag_suppressed(message_id, tag)`。
  `setMailTagManual(id, tag, on)`：加上 → 写 manual 并清除同名抑制；去掉 → 删除所有来源同名标签并记一条抑制。
  `saveMailTags(rule|ai)` 会跳过被抑制的标签 → 手动删掉的自动标签不会被重算加回来；手动标签是独立来源，永不被覆盖。
  `listTagCounts()` 统计全部来源（否则侧边栏/标签面板看不到手动标签）。
  UI：详情页「🏷 标签」= 手动打标签（`tag-toggle`），邮件行显示 ✋（`mail-manual-tag-mark`）；批量打标签改用同一套标签。
- **列表性能**：`MailRow` 用 `React.memo` 抽出（回调 useCallback 稳定引用）；`.mail-item { content-visibility: auto;
  contain-intrinsic-size: auto var(--row-h) }`；首屏只取 200 封（`fetchLimitRef`），「加载更多」时上限翻倍（≤2000）。
- **设置页重设计**：`.settings-shell` 左栏导航（`settings-section-<id>`）+ 右栏 `.settings-card` 卡片；
  一次只挂载当前分类（E2E 需先切分类）；排版一致性断言改为只看当前分类的卡片行。
- **头像修复**：`src/shared/avatar.ts`（`avatarInitial` / `avatarColor`）列表与详情共用；详情页原来漏了背景色，
  且 `fromName` 为空时取不到首字 → 现在回退到邮箱首字母。

### 14.8 性能专章：为什么「邮件一多就卡」（真机数据 + 实测）

**症状**：邮件到 200+ 封后，切到收件箱明显卡顿；同步期间更明显。

**定位方法**（可复跑）：
1. 主进程侧：`cd tests && node bench-store.mjs <真库副本>` —— 用真实数据库副本量各查询耗时与返回字节数；
2. 渲染侧：`node perf.mjs 3000 --burst`（3000 封 + 事件风暴）、`node perf-switch.mjs 3000`（逐页切换延迟与长任务）。

**根因（实测）**：真机库里 242 封邮件的 `body_html` 合计 **107.8MB**（平均 445KB，单封最大 11.6MB），
而列表查询写的是 `SELECT m.*` —— 每切一次收件箱就要把 **200 封邮件的整份 HTML（约 106MB）** 从磁盘读进内存、
再序列化：

| 查询（真库副本，INBOX 200 封） | 修复前 | 修复后 |
| --- | --- | --- |
| 列表查询 | **3270 ms** | **1.5 ms** |
| 序列化后的数据量（IPC 传输） | **106 MB** | **99 KB** |
| 标签/摘要/索引卡片回填（含列表查询） | ≈570 ms | ≈3 ms |
| 数据库文件 | 126 MB | 111 MB（VACUUM 后） |

**修复**：
1. **列表查询不再 `SELECT m.*`**（`src/main/db/sqlite.ts` 的 `query()`）—— 只取列表需要的列 + 已存好的 `snippet`；
2. **正文搬出 `messages`**（迁移 v17 `message_bodies`）：`messages` 行变小、页排布紧凑，列表查询只读几页；
   正文只在打开邮件/生成摘要/清洗时按需 JOIN（`getMessage` / `listUnsummarized` / `listNoisyBodies`）；
   迁移后一次性 `VACUUM` 回收空洞（`db.vacuum` 日志）；
3. **`getThread` 只取 id**（原来也是 `SELECT m.*`，线程邮件多时会读整串正文）；
4. 渲染侧：`MailRow` memo + 列表**窗口化**（超过 60 行才启用，只挂载视口 ±8 行）、
   同步进度事件**去抖**（阶段/进度未变就不 setState）、新邮件事件**合并刷新**（尾随 400ms 一次），
   首屏只取 200 封（「加载更多」上限翻倍 ≤2000）。

**修复后实测**：3000 封数据下切页 20–90ms（进收件箱 27ms）、事件风暴下 6 次切换共 3.7s（含脚本等待）、
最长主线程长任务 76ms；DOM 行数恒定 17（不再随列表长度增长）。

### 14.9 真机反馈第五轮（标签筛选 bug / 红旗 / 文件夹图标 / 加载更多 / 彩色类别 / 过渡动画）

- **标签筛选失效（真 bug）**：`loadList` 的 `useCallback` 依赖里漏了 `tagFilters` —— 它一直闭包着最初的空数组，
  请求里根本没带标签条件。修法：把 `tagFilters`（以及 `unreadOnly`、`settings.listPageSize`）加进依赖，
  并用 `filterKey = viewKey + 标签` 作为「要不要重新查」的判断；侧边栏取消选中时也清筛选。
  新增 E2E 断言：筛选后行数必须真的变化，且每行都带该标签。
- **红旗**（Outlook 式后续标记）：迁移 v18 `messages.flagged` + 索引；`setFlagged`；列表 `🚩` 标记、
  详情页/右键菜单可切换、侧边栏「🚩 红旗」筛选（`QueryParams.flaggedOnly`）。
- **真实总数**：新增 `countMails`（与 `query` 共用 `buildListWhere`）+ `mail:count` 通道，
  顶栏与列表面板显示真实总数；「加载更多」按钮显示服务端剩余量。
- **加载更多不再跳回顶部**：刷新时不清空列表（原来先渲染"正在加载…"，容器高度塌成 0，
  浏览器把 scrollTop 夹回 0）；窗口化（估算行高）改为**渐进式分块渲染**（首屏 40 行 +
  IntersectionObserver 哨兵续渲染 40 行，屏幕外行仍由 `content-visibility: auto` 跳过）。
- **侧边栏（Outlook 风格）**：`src/shared/folderIcons.ts` 按名字/路径识别文件夹类型给图标，
  常用六类常驻、其余收进「更多文件夹」；标签只显示前 5 个。
- **彩色类别（Gmail 风格）**：迁移 v19 `categories` + `message_category`（默认 6 色）；
  `listCategories/createCategory/updateCategory/deleteCategory/setMailCategory` + IPC；
  详情页面板（搜索/新建/管理/色板），列表行用类别色 9% 淡背景常亮（`--cat-color`）。
- **设置页按钮统一**（`.settings-row > .btn { justify-self: start; width: auto }`）+ 页面切换过渡动画
  （`.page-slot-active > * { animation: page-in 180ms }`，尊重 prefers-reduced-motion；删除该 CSS 段即可回退）。

### 14.10 真机反馈第六轮（筛选链路三处断点 / 类别管理搬家 / 未读入口 / 标签降噪）

本轮的关键教训：**"筛选不生效"往往是链路上某一环把条件丢了**，这次一共三处：

1. **渲染层闭包**：`loadList` 的 `useCallback` 依赖漏了 `tagFilters` → 请求里从来没带标签条件；
2. **App 层 memo**：`labelFilter` 的 `useMemo` 条件与依赖都漏了 `activeFlagged` → 点红旗不产生新 props，
   memo 化的收件箱页面根本不重渲染；
3. **主进程 IPC**：`MAIL_LIST` 处理器逐个字段手写透传，漏了 `flaggedOnly / autoTags / categoryId / unreadOnly`
   → 条件到不了 store。改成 `...args` 展开透传，杜绝这类漏字段。
   另外「未读」用 `clearInboxFilters()` + 函数式 toggle 混用，函数式更新拿到的是**已清空的值**，
   导致"退出未读=再次开启未读"；现在统一走 `applyInboxFilter({...})` 显式设置所有筛选项。
   回归测试：renderer E2E 断言"按标签筛选后行数真的变化/每封都带该标签"、electron E2E 断言
   "点侧边栏红旗后列表切到红旗邮件且每封都有旗"。

其他改动：
- 彩色类别管理搬到设置（`category-manage-list`：重命名/改色/删除/新建），详情页只保留选择；
  列表只用类别色 9% 淡背景标出，不再显示类别名 chip；
- 标签降噪：`listTagCounts` 返回 `manual` 标记，标签面板分「主题标签（词表内 + 手动）」与
  「课程与平台等自动标签（默认折叠）」；侧边栏只显示前 5 个；设置里的词表默认折叠两行；
- 未读筛选移到侧边栏文件夹列表（`data-nav="unread"`，显示未读数），工具栏的「全部/未读」与统计串移除；
- 设置页按钮统一（`.settings-card .btn { width:auto; justify-self:start }`，含包在 div 里的按钮）；
- 页面切换动画改挂在 `.page-slot-active`（所有页面都生效）。

### 14.11 真机反馈第七轮（侧边栏改类别筛选 / 按钮行内 / 去冗余按钮）

- **侧边栏「标签」→「类别」**：用户要求侧边栏只做类别筛选、不再罗列标签。新增 `listCategoryCounts()`
  （categories LEFT JOIN message_category GROUP BY）+ `categories:counts` 通道；App 侧边栏改为类别列表
  （色点 + 名称 + 数量，`data-nav="category:<id>"`），点击走统一的 `applyInboxFilter({ categoryId })`；
  `categoryId` 参与 Inbox 的 filterKey / query / countMails。标签仍在顶栏 🏷 面板中按「主题标签 / 课程与平台」分组展示。
- **设置页「提示 + 按钮」同行**：新增 `.row-inline` 容器（flex + 按钮 flex:none width:auto），
  Key 状态/总结提示词/重算标签/恢复默认外观/附件目录等行都改成「文字在前、按钮紧随其后」，
  并给缺标签列的 5 个行补上 `<span class="name" />`（排版一致性 E2E 断言继续生效）。
- **彩色类别管理左对齐**：`.category-manage-row` 左对齐、隐藏多余色块占位、输入框固定宽度。
- **删除「隐藏图片」按钮**：远程图片固定不加载（`sanitizeHtml(..., { allowRemoteImages: false })`），
  去掉 `loadImages` 状态与按钮；E2E 断言改为「无按钮 + 图片数为 0」。
- **删除两段冗余说明**（标签面板与类别面板的说明文字）。
