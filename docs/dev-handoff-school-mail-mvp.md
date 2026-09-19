# 学校邮箱 AI 助手 — MVP 开发交接文档（供开发 AI 使用）

> **说明（现状）**：本文是早期（P0/只读阶段）的设计与调研文档，当时只做只读收信；
> 当前版本已支持**发信**（回复 / 转发 / 新写 / 草稿，SMTP + XOAUTH2 或个人邮箱 SMTP），
> 收信侧仍保持只读（不改动服务端邮件）。功能现状以 README 与使用说明为准。

> 本文件是**已获用户批准的首期开发范围**，也是本仓库的**技术实现规范（canonical）**。请严格按本文件实现，功能范围外的内容列为后续版本（P1/P2），不要擅自扩展。
>
> 与同目录文档的关系：
> - `Notion-Mail-功能调研与实现评估.md` = **需求/范围/审批文档**（"要做什么、多难、是否要写权限"）。
> - 本文件 = **技术实现文档**（"怎么做、用什么、怎么验收、怎么自测"）。两者冲突时，以本文件为准。
>
> 早期版本曾引用仓库外文件 `Exchange-Online-IMAP-登录技术路径.md`；该文件的**关键常量与硬约束已内联到本文档 §2 / §3**，因此本文件可独立指导开发，无需再依赖外部文件。

---

## 0. 文档更新记录

| 版本 | 变更 |
|---|---|
| v1.1 | ① 内联外部技术路径文档的关键约束与常量，消除悬空引用；② 修复 `SyncState` 字段与 SQL 列名不一致；③ 补充 Electron 安全基线、HTML 正文净化、线程聚合、附件/远程图片策略；④ 新增模型选型（开发期 + 运行时）；⑤ 新增「开发 AI 自测方案」章节与 `tests/` 自测脚本；⑥ 里程碑加入自测门槛；⑦ 修正 DeepSeek 模型名弃用风险。 |
| v1.2 | 新增 §14「扩展性与演进接口」：`MailProvider` / `MessageStore` / `AiProvider` 三个核心接口 + IPC 契约 + 前端功能注册表 + 组合根 + 契约测试 + 演进规则，防止首期完成后无法更新/优化；同步更新 §5 目录结构与 §9 里程碑的接口要求。 |

---

## 1. 已批准范围（P0 / MVP）

用户最终批准的三个决策：

| 决策项 | 批准结果 |
|---|---|
| 功能范围 | **方案三：最小验证** = 登录 + 收件箱 + AI 总结 + AI 搜索问答 |
| AI 模型/API | **DeepSeek API**（OpenAI 兼容协议） |
| 客户端形态 | **Windows 桌面应用** |

### 1.1 P0 必须实现（本次开发）

1. **学校邮箱登录**：设备码 + XOAUTH2 + Mozilla Thunderbird 公共 Client ID，登录 `@your-university.edu` / `@your-university.edu` 等 M365 教育邮箱。
2. **Token 续期**：access_token 过期自动用 refresh_token 刷新；refresh_token 失效回退设备码。
3. **收件箱列表**：拉取并展示邮件列表，支持分页/滚动加载。
4. **增量同步**：UIDVALIDITY + UID 状态机；首次全量窗口（取最近 N 封），后续增量。
5. **邮件阅读**：正文渲染（纯文本优先，HTML 兜底并净化）、中文标题/主题解码、发件人/收件人/时间展示。
6. **本地线程聚合**：基于 `References` / `In-Reply-To` / `Message-ID` / 主题规范化在本地把往来邮件归为一个线程（`thread_id`）。它是第 9 条「会话线程总结」与「按线程阅读」的隐含依赖，故纳入 P0。
7. **附件查看/下载**：附件按需拉取（不在同步时全量下载），点击时按 part 拉取并保存本地。
8. **本地已读状态**：只在本机维护已读/未读，不改服务端标志。
9. **全文搜索**：本地索引支持按主题/正文/发件人搜索。
10. **AI 总结**：对单封邮件或当前会话线程生成中文摘要。
11. **AI 搜索问答**：自然语言提问收件箱，基于本地检索 + DeepSeek 生成带引用来源的回答。
12. **安全基线**：token 用 Windows DPAPI（Electron `safeStorage`）加密存储；邮件正文与 token 不写日志；IMAP 始终 readonly + BODY.PEEK；Electron 开启 contextIsolation/沙箱，HTML 正文渲染前净化。

### 1.2 P1（后续，暂不实现，仅预留设计）

写信/回复/转发、发送邮件（Graph `Mail.Send` / SMTP）、AI 续写、AI 一键回复、AI 生成整封邮件、语气调整/翻译、稍后提醒（Snooze）、归档/删除/星标、自定义视图、AI 智能视图、会议日程集成、通知推送。

### 1.3 P2（远期，暂不考虑）

移动端/Web、多账户、日历读写、端到端加密、群发/邮件合并。

---

## 2. 硬性技术约束（必须遵守）

以下约束来自已被内联的 Exchange Online IMAP 技术路径，违反会导致邮箱被误操作或账号风控：

1. **只读三连**：
   - `IMAP SELECT "INBOX"` 永远带 `readonly=true`。
   - 取正文用 `BODY.PEEK[]` / `BODY.PEEK[HEADER]`，**不要**用不带 PEEK 的 FETCH（会标 `\Seen`）。
   - 绝不发送 `STORE` / `COPY` / `MOVE` / `DELETE` 等写命令。
2. **XOAUTH2 分隔符**：Microsoft 用 `\x01`，不是 Gmail 的逗号。用 `imapflow` 的 `auth.accessToken` 会自动处理；若手写 IMAP 命令必须手拼 `\x01`。
3. **设备码 scope**：只传 `https://outlook.office.com/IMAP.AccessAsUser.All`；不要显式传 `openid/profile/email/offline_access`。
4. **Token 安全**：
   - access_token / refresh_token 不写日志、不写明文文件。
   - 用 Windows DPAPI（Electron `safeStorage.encryptString`）落盘。
   - 每次 refresh 返回的新 refresh_token 必须覆盖旧的。
5. **增量状态**：`UIDVALIDITY` 变化 → 丢弃历史全量重同步；相同 → `UID <last+1>:*` 增量。
6. **附件按需取回**：同步时只记录文件名/大小/Content-Type/part；用户点击下载时才 `FETCH BODY.PEEK[<part>]`。
7. **日志脱敏**：可记录主题/发件人/时间戳；不可记录 token、Account ID、邮件正文。
8. **错误提示**：给中文可行动提示，不把 stack trace 直接展示给用户。
9. **Electron 安全基线**：
   - `BrowserWindow` 一律 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
   - 渲染进程不直接拿 Node 能力；所有主进程能力经 `preload` 用 `contextBridge` 暴露**白名单 API**，IPC channel 用常量集中定义并校验参数。
   - 不开启 `webviewTag`，不用 `shell.openExternal` 打开不可信 URL（先校验协议为 `http(s)` 并提示）。
10. **HTML 正文安全**：
    - 正文 HTML 渲染前必须经 **DOMPurify** 净化（白名单标签/属性），剥离 `<script>`、事件属性、`<iframe>`、`<object>`、`javascript:` 链接。
    - 默认**不加载远程图片**（防跟踪像素）；用户显式点击「加载图片」后再放行。
    - 生产环境渲染页设置严格 CSP（`default-src 'self'; img-src 'self' data: https: cid:` 等）。
11. **外部链接**：邮件中的链接点击后用 `shell.openExternal` 打开前，校验协议并给二次确认提示（防钓鱼）。

---

## 3. 复用的关键常量

```ts
// Mozilla Thunderbird 公共 Client ID（微软已全局预授权 IMAP.AccessAsUser.All）
export const THUNDERBIRD_CLIENT_ID_NEW = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";
export const THUNDERBIRD_CLIENT_ID_OLD = "08162f7c-0fd2-4200-a84a-f25a4db0b584";

export const DEVICE_CODE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode";
export const TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export const IMAP_SCOPES = ["https://outlook.office.com/IMAP.AccessAsUser.All"];

export const IMAP_HOST = "outlook.office365.com";
export const IMAP_PORT = 993;
```

### 3.1 DeepSeek 常量（新增）

```ts
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
// 运行时默认模型（文本/Agent/编码推理最强）
export const DEEPSEEK_MODEL = "deepseek-v4-pro";
// 视觉自测/看图模型（多模态、便宜，只用于开发 AI 自测截图，不进生产关键链路）
export const DEEPSEEK_VISION_MODEL = "deepseek-v4-flash-vision-exp";
```

> ⚠️ 弃用提醒：DeepSeek 旧的模型名 `deepseek-chat` / `deepseek-reasoner` 将在 **2026-07-24 停止使用**（当前阶段它们分别指向 `deepseek-v4-flash` 的非思考/思考模式）。**新代码一律使用 `deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`**，不要再写 `deepseek-chat`。

---

## 4. 推荐技术栈与理由

| 层 | 推荐 | 理由 |
|---|---|---|
| 桌面框架 | **Electron + TypeScript** | 生态成熟、主进程可直接用 Node IMAP/加密/SQLite，最快出 Windows 版本 |
| 前端 | **React + TypeScript + Vite** | 开发效率高，组件生态全 |
| 打包 | **electron-builder** | 一键出 Windows 安装包/便携版 |
| IMAP | **imapflow** | 支持 XOAUTH2、连接池、状态机，比原生 `imap` 更稳 |
| MIME 解析 | **mailparser**（nodemailer 出品） | 处理 multipart、charset、中文主题、附件 |
| 本地库 | **better-sqlite3** | 同步 API 简单、支持 FTS5、性能足够 |
| 全文索引 | **SQLite FTS5（trigram 或 unicode61）** | 内置、无额外服务；中文搜索若效果不足再换 Meilisearch/Typesense |
| HTML 净化 | **DOMPurify** | 邮件正文 HTML 防 XSS，前端事实标准 |
| 加密 | **Electron `safeStorage`** | 底层即 Windows DPAPI |
| AI | **openai npm 包**（指向 DeepSeek base_url） | DeepSeek 兼容 OpenAI 协议；模型名见 §3.1 |
| 网络 | **axios / fetch** | 设备码、token 刷新 |
| 单元测试 | **Vitest** | 与 Vite/TS 同生态，跑纯逻辑无需邮箱/Key |
| E2E 自测 | **playwright-core + 系统 Edge** | 免下载 Chromium，驱动 renderer / Electron 页面做冒烟与截图 |

> 备选：若后续想减小安装包，可迁移到 **Tauri 2 + Rust（async-imap / imap-flow）**，但首期不建议，开发速度优先。

---

## 5. 建议仓库结构

```
legacy-mail-app/
├─ package.json
├─ electron.vite.config.ts
├─ vitest.config.ts              # 单元测试
├─ src/
│  ├─ main/                       # Electron 主进程
│  │  ├─ index.ts                 # 窗口/生命周期
│  │  ├─ ipc.ts                   # IPC handlers（白名单 + 参数校验）
│  │  ├─ auth/
│  │  │  ├─ deviceCode.ts         # 设备码登录、token 刷新
│  │  │  └─ tokenStore.ts         # DPAPI 加密存储
│  │  ├─ mail/                       # 邮件后端抽象（防锁死的关键缝，见 §14）
│  │  │  ├─ provider.ts              # MailProvider 接口 + 能力声明
│  │  │  ├─ imap.ts                  # ImapMailProvider：imapflow 实现（readonly + XOAUTH2）
│  │  │  ├─ sync.ts                  # UIDVALIDITY/UID 增量同步（依赖 MailProvider）
│  │  │  ├─ thread.ts                # 本地线程聚合（References/Message-ID）
│  │  │  └─ fetch.ts                 # 单封正文/附件按需拉取（依赖 MailProvider）
│  │  ├─ db/
│  │  │  ├─ store.ts                 # MessageStore 接口
│  │  │  ├─ sqlite.ts                # better-sqlite3 实现
│  │  │  ├─ schema.ts                # 表结构 + FTS
│  │  │  ├─ migrate.ts               # schema_version 迁移器（只增不改）
│  │  │  ├─ messages.ts              # 邮件 CRUD
│  │  │  └─ search.ts                # FTS 查询
│  │  ├─ ai/
│  │  │  ├─ provider.ts              # AiProvider 接口
│  │  │  ├─ deepseek.ts              # DeepSeek 实现（openai SDK，baseURL deepseek）
│  │  │  ├─ summarize.ts             # 总结（依赖 AiProvider）
│  │  │  └─ searchQA.ts              # RAG 搜索问答（依赖 AiProvider）
│  │  ├─ bootstrap.ts                # 组合根：装配 provider/store/ai → IPC
│  │  └─ logger.ts                   # 脱敏日志
│  ├─ preload/
│  │  └─ index.ts                    # contextBridge 白名单 API
│  ├─ shared/                        # 主/渲染共享类型与 IPC 契约
│  │  └─ ipc-contract.ts             # channel 常量 + 请求/响应类型 + zod schema
│  └─ renderer/
│     ├─ src/
│     │  ├─ App.tsx
│     │  ├─ lib/sanitize.ts       # DOMPurify 净化
│     │  ├─ pages/Login.tsx
│     │  ├─ pages/Inbox.tsx
│     │  ├─ pages/MailDetail.tsx
│     │  ├─ pages/AISearch.tsx
│     │  └─ components/
│     └─ index.html
├─ tests/                         # 开发 AI 自测（本仓库已落地，见 §13）
│  ├─ package.json
│  ├─ e2e/smoke.mjs               # renderer 冒烟（系统 Edge）
│  └─ artifacts/                  # 截图/报告
├─ docs/
└─ resources/                     # 图标等
```

---

## 6. 关键实现方案

### 6.1 设备码登录

用 HTTP 直接实现，避免 MSAL 自动附加 scope 导致 `reserved scope` 报错：

```ts
// 1) 请求设备码
const resp = await axios.post(DEVICE_CODE_URL, new URLSearchParams({
  client_id: THUNDERBIRD_CLIENT_ID_NEW,
  scope: IMAP_SCOPES[0],
}), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

const { device_code, user_code, verification_uri, expires_in, interval } = resp.data;

// 2) 轮询拿 token（间隔 interval 秒，最长 expires_in 秒）
const tokenResp = await axios.post(TOKEN_URL, new URLSearchParams({
  client_id: THUNDERBIRD_CLIENT_ID_NEW,
  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  device_code,
}), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
```

要点：
- 把 `verification_uri` 和 `user_code` 展示给用户；可用 `https://microsoft.com/devicelogin`。
- 返回 `authorization_pending` → 继续轮询；`expired_token` → 重新发起设备码；拿到 `access_token` 即成功。
- 学校 用户 `id_token_claims.preferred_username` 可能缺失，兜底顺序：解码 access_token 的 JWT payload → `upn` / `unique_name` / `email` / `preferred_username`，取到第一个非空值。
- 轮询逻辑要可取消/超时，避免窗口关闭后继续打点。

### 6.2 refresh_token 刷新

```ts
const resp = await axios.post(TOKEN_URL, new URLSearchParams({
  client_id: THUNDERBIRD_CLIENT_ID_NEW,
  grant_type: "refresh_token",
  refresh_token: savedRefreshToken,
  scope: IMAP_SCOPES[0],
}), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
// 用新的 access_token + refresh_token 覆盖旧值
```

- `error=invalid_grant` → refresh_token 失效 → 重新走设备码。
- access_token 有效期约 60–90 分钟；可在每次连接前检查 `expires_in` 或收到认证错误时刷新。
- 刷新操作加互斥锁，防止并发刷新导致新旧 token 竞态覆盖。

### 6.3 IMAP 连接（imapflow + XOAUTH2）

```ts
import { ImapFlow } from "imapflow";

const client = new ImapFlow({
  host: IMAP_HOST,
  port: IMAP_PORT,
  secure: true,
  auth: {
    user: accountEmail,          // UPN，如 xxx@your-university.edu
    accessToken,                 // imapflow 自动拼 XOAUTH2（含 \x01）
  },
  logger: false,                 // 关闭内部日志，避免打印敏感信息
});

await client.connect();
const lock = await client.getMailboxLock("INBOX");
try {
  const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
  // mailbox.uidValidity / mailbox.exists / mailbox.uidNext
} finally {
  lock.release();
}
```

### 6.4 增量同步状态机

```ts
interface SyncState {
  uidValidity: number; // 落库到 sync_state.uid_validity
  lastUid: number;     // 落库到 sync_state.last_uid
}

// 若 state.uidValidity !== mailbox.uidValidity → 全量窗口（最近 N 封）
// 否则 → 拉取 UID 区间 `${state.lastUid + 1}:*`
// 拉取用 fetch('uid', { uid: '123,124,125' }, { source: true }) 或按 chunk 分块
```

- 代码里的驼峰字段 `uidValidity/lastUid` 与 SQL 表的 `uid_validity/last_uid` 是**同一概念**，DAO 层负责映射，避免两处命名漂移（本条已在 v1.1 统一）。
- 批量拉取每批 **10–20 封**，避免超时。
- 取正文用 `BODY.PEEK[]`；imapflow 中对应下载 `envelope` / `bodyParts`，注意不要触发 `\Seen`。
- 同步结束把 `lastUid` 更新为已成功处理的最大 UID；失败批次不推进 `lastUid`，下次重试。
- 首次同步几千封时 UI 显示「已同步 x/y」进度。

### 6.5 MIME 解析与存储

- 用 `mailparser` 的 `simpleParser()` 或流式 `MailParser` 解析：
  - `subject`（中文自动解码）、`from`、`to`、`date`、`messageId`、`references`、`inReplyTo`、`text`、`html`、`attachments`。
  - 附件在同步阶段只存元数据（`filename/contentType/size/partId/contentId`），正文不下载附件。
  - 注意区分 **inline 内嵌图片（`contentDisposition: inline` + `cid:`）** 与**真实附件（`attachment`）**：inline 图片不放入附件下载列表，正文 HTML 中的 `cid:` 引用可替换为本地缓存路径或暂不显示。
- **线程聚合**（§1.1 第 6 条）：
  1. 取 `references`（或 `inReplyTo`）中出现的 `Message-ID`，与本地库匹配到同一 `thread_id`；
  2. 无引用时，用「规范化 subject（去 `Re:/Fwd:/回复:/转发:` 前缀 + trim）」+ 发件人相似度兜底；
  3. 仍无匹配则自成一线程。
- 数据库表（SQLite）：

```sql
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  refresh_token_enc BLOB NOT NULL,
  access_token_enc BLOB,
  access_token_expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sync_state (
  account_id INTEGER PRIMARY KEY,
  uid_validity INTEGER NOT NULL,
  last_uid INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  thread_id TEXT,
  subject TEXT,
  from_name TEXT,
  from_addr TEXT,
  to_addrs TEXT,
  cc_addrs TEXT,
  date_hdr TEXT,
  date_ts INTEGER,
  body_text TEXT,
  body_html TEXT,
  snippet TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  flags_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, uid)
);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  part_id TEXT,
  filename TEXT,
  content_type TEXT,
  size INTEGER,
  local_path TEXT
);

-- FTS5 全文索引（CJK 用 trigram 更友好；若 SQLite 不支持 trigram，回退 unicode61 + 本地兜底扫描）
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_name, from_addr, body_text,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);
```

> 中文分词说明：`unicode61` 对连续中文串不切词，搜索体验差；优先用 `trigram`（SQLite ≥ 3.34）。若 `better-sqlite3` 编译版本不含 trigram，改用应用层「前缀/子串 + 评分」或引入 Meilisearch。

### 6.6 全文搜索

- 搜索入口：`SELECT ... FROM messages_fts WHERE messages_fts MATCH ?`。
- 支持字段过滤：`subject:`、`from:`、`body:` 映射到对应 FTS 列。
- 结果按日期倒序，高亮命中片段（从 `body_text` 截取上下文）。
- 对 FTS 的 `MATCH` 查询串做转义，防止用户输入 `"` `*` 等导致语法错误或全表匹配。

### 6.7 AI 总结（DeepSeek）

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY, // 或经 DPAPI 加密存储
  baseURL: "https://api.deepseek.com",
});

const system = "你是邮件助手。请用简体中文给出准确、简洁的总结，不要编造邮件中没有的信息。";
const summary = await client.chat.completions.create({
  model: "deepseek-v4-pro",        // 见 §3.1
  messages: [
    { role: "system", content: system },
    { role: "user", content: `请总结以下邮件线程：\n\n${threadText}` },
  ],
  temperature: 0.2,
  max_tokens: 800,
});
```

- 输入上下文超长时先截断/分段：优先保留主题、发件人、时间、每封正文前 N 字符。
- **不要把正文写入日志**；可记录「已调用总结，输入字符数」。
- API Key 用 `safeStorage` 加密存配置，不写代码仓库、不写日志。
- 可选开启思考模式：复杂线程用 `reasoning_effort: "high"`；日常单封用默认即可（成本权衡见 §11）。

### 6.8 AI 搜索问答（RAG）

流程：
1. 用 FTS5 检索与问题相关 Top-K（建议 5–10 封）。
2. 每封取主题 + 发件人 + 日期 + 正文摘要（截断，控制 token）。
3. 拼 prompt：

```
你是 学校邮箱助手。基于以下检索到的邮件回答问题。
如果邮件中找不到答案，明确说“未找到”，不要编造。
在回答末尾列出引用的邮件（主题 + 发件人 + 日期）。

问题：<question>

邮件：
[1] 主题：... 发件人：... 日期：... 正文：...
[2] ...
```

4. DeepSeek 返回答案 + 引用编号，前端渲染成可点击跳转到对应邮件。

- RAG 上下文预算建议：问题 ≤ 200 token，每封邮件 ≤ 400 token，总上下文 ≤ 4000 token，超长按「主题/发件人/日期/正文前 300 字」截断。
- 引用编号必须与检索结果 `uid` 一一对应，前端跳转用 `uid` 而非列表下标，避免排序变化导致跳错。

### 6.9 Electron 安全与 IPC（新增）

```ts
// preload/index.ts —— 只暴露白名单能力
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("api", {
  loginDeviceCode: () => ipcRenderer.invoke("auth:device-code"),
  listMessages: (cursor) => ipcRenderer.invoke("mail:list", cursor),
  getMessage: (id) => ipcRenderer.invoke("mail:get", id),
  summarize: (id) => ipcRenderer.invoke("ai:summarize", id),
  ask: (q) => ipcRenderer.invoke("ai:ask", q),
});
```

- 所有 IPC channel 常量集中在 `src/shared/ipc.ts`；主进程 `ipcMain.handle` 先校验入参（zod），再执行。
- 渲染进程禁 Node、禁 `webviewTag`；`webSecurity` 保持默认开启。
- 正文 HTML 净化（§2 第 10 条）在**渲染前**执行，React 中用 `dangerouslySetInnerHTML` 的地方必须已过 DOMPurify。

### 6.10 错误处理与可观测性（新增）

- 统一错误码：`AUTH_DEVICE_CODE_EXPIRED` / `AUTH_INVALID_GRANT` / `IMAP_TIMEOUT` / `SYNC_UIDVALIDITY_CHANGED` / `AI_RATE_LIMIT` 等；UI 层映射为中文可行动提示。
- 结构化日志字段：`ts`、`level`、`event`、`accountHash`（脱敏）、`durationMs`、`uidRange`、`errorCode`；**永不记录** token、正文、Account ID 明文。
- 至少落 3 个指标：登录延迟、首次同步耗时、增量同步失败率（对应 §8 第 11 条）。

---

## 7. UI 页面清单（MVP）

| 页面 | 关键元素 |
|---|---|
| 登录页 | 设备码、验证链接、轮询状态、错误提示（中文）、重新登录 |
| 收件箱 | 邮件列表（发件人/主题/时间/摘要/未读点）、搜索框、同步进度、刷新、线程视图切换 |
| 邮件详情 | 主题、发件人、收件人、时间、正文渲染、附件下载、AI 总结按钮、加载远程图片按钮 |
| AI 搜索问答 | 提问输入框、回答区、引用邮件列表（可跳转） |
| 设置 | DeepSeek API Key、模型名（默认 `deepseek-v4-pro`）、同步最近 N 封、清除本地数据 |

---

## 8. 验收标准（MUST PASS）

1. **登录链路**：使用 学校 账号，设备码流程能成功拿到 token 并连上 IMAP；错误时给中文提示。
2. **只读不误改**：连接后 `INBOX` 为 readonly，服务端邮件 `\Seen`/`\Recent` 不变化；代码中无任何 `STORE/COPY/MOVE/DELETE`。
3. **同步正确性**：首次同步最近 N 封成功；再次启动增量只拉新邮件；UIDVALIDITY 变化触发全量。
4. **正文渲染**：中文主题/正文不乱码；multipart/alternative 优先 plain；附件不误判 inline 图片；HTML 正文经 DOMPurify 净化。
5. **线程聚合**：同主题往来邮件归入同一 `thread_id`；AI 总结能拿到完整线程上下文。
6. **附件按需**：同步阶段不下载附件；点击后能下载并打开。
7. **搜索**：按主题/正文/发件人能命中中文与英文关键词。
8. **AI 总结**：对一封邮件与一个线程都能生成中文摘要；正文不落日志；模型名用 `deepseek-v4-pro`。
9. **AI 搜索问答**：能回答「上周 X 发了什么」类问题，并给出可跳转引用；找不到时明确说未找到。
10. **Token 安全**：access/refresh token 以 DPAPI 密文落盘；日志/界面不出现明文 token；refresh_token 轮换后旧值被覆盖。
11. **可观测性**：登录延迟、首次同步耗时、增量同步失败率至少落到本地日志。
12. **自动化自测可重复**：`tests/` 下的单元测试与 renderer 冒烟测试可一键跑通且全绿（见 §13）；每次交付前必须执行并附结果。

---

## 9. 里程碑与任务拆分（供开发排期）

| 里程碑 | 任务 | 验收 |
|---|---|---|
| M0 自测脚手架 | 建 `tests/`：Vitest 单测骨架 + Playwright(系统 Edge) renderer 冒烟 | `npm test` 可跑通 |
| M1 工程搭建 | Electron + React + Vite + TS 脚手架、electron-builder、日志、preload/IPC 白名单 | 桌面窗口可启动、IPC 白名单生效 |
| M2 登录 | 设备码登录 + token DPAPI 存储 + 刷新 | 通过验收 1、10 |
| M3 同步 | imapflow 连接、UID 状态机、mailparser、SQLite/FTS、线程聚合 | 通过验收 2、3、4、5 |
| M4 收件箱/阅读 | 列表、详情、附件按需 | 通过验收 6 |
| M5 搜索 | FTS 查询 + 高亮 | 通过验收 7 |
| M6 AI 总结 | DeepSeek 接入（`deepseek-v4-pro`）、单封/线程总结 | 通过验收 8 |
| M7 AI 问答 | RAG 检索 + 引用跳转 | 通过验收 9 |
| M8 打磨 | 进度条、错误处理、脱敏日志、指标、自测补全 | 通过验收 11、12 |

> 每个里程碑合入前必须：① 对应验收项通过；② `tests/` 自测全绿；③ 若改动 UI，附一张自测截图到交付说明。
>
> **扩展接口要求**：§14 的三个核心接口（`MailProvider` / `MessageStore` / `AiProvider`）**从 M1 起就要先把接口定义好**，M2/M3 按接口实现；禁止把 imapflow / better-sqlite3 / openai 的具体类型泄漏到 sync、搜索、AI 业务和 UI 层。这样 P1 加 Graph/SMTP 发信、换 AI 模型、加 AI 功能时才不会重写。

---

## 10. 环境与依赖（开发 AI 可自行安装）

- Node.js ≥ 20，包管理器 `pnpm` 或 `npm`。
- 依赖（首期建议）：`electron`、`electron-builder`、`electron-vite`、`typescript`、`react`、`react-dom`、`vite`、`imapflow`、`mailparser`、`better-sqlite3`、`openai`、`axios`、`zod`（可选校验）、`dompurify`。
- 测试依赖：`vitest`（单测）、`playwright-core`（E2E，配合系统 Edge，免下载 Chromium）。
- 若安装 `better-sqlite3` / `electron` 原生模块失败：可先暂停让用户安装，或换预编译版本。

---

## 11. 风险与待确认事项（不影响 MVP 开发，但需知悉）

1. **写权限（P1 发信）**：需要 学校 的 Graph `Mail.Send` / `Mail.ReadWrite` 管理员同意，或实测 SMTP AUTH 是否放行。MVP 不做，先记录。
2. **DeepSeek API Key**：需用户提供，存储用 DPAPI，不写日志。
3. **CJK 全文搜索质量**：trigram 可能对长中文检索有噪声；必要时升级 Meilisearch/Typesense 或引入 jieba 分词（需原生/WasM）。
4. **学校 账户字段缺失**：`preferred_username` 缺失时按 6.1 兜底顺序解析 JWT。
5. **Windows 防火墙**：首次联网会弹窗，需在 README 说明允许通信。
6. **打包体积与原生模块**：`better-sqlite3` 需要与 Electron ABI 匹配，用 `electron-rebuild` 或 electron-builder 的 rebuild 配置。
7. **DeepSeek 模型名弃用**：`deepseek-chat`/`deepseek-reasoner` 2026-07-24 停用，新代码统一用 v4 系列（§3.1）。
8. **视觉模型为实验版**：`deepseek-v4-flash-vision-exp` 标为 Exp，仅建议用于开发 AI 自测/看图，不作为产品运行时默认模型；产品运行时文本能力用 `deepseek-v4-pro`。
9. **自测边界**：真实 学校 登录/IMAP 需要测试账号或用户手动完成一次授权；无测试账号时，登录链路只能做「mock 协议」级单测 + 真实设备码发起（到 DUO 前的部分），不能替代真实验收。

---

## 12. 立即开始的第一个开发任务

按优先级，开发 AI 应**先做 M0 + M1 + M2 + M3 的最小闭环**：

1. 建 `tests/` 自测脚手架（单测 + renderer 冒烟），并跑通。
2. 搭好 Electron + React + TS 项目（含 preload/IPC 白名单、脱敏日志）。
3. 实现设备码登录，把 token 存进 DPAPI。
4. 用 imapflow 连上 IMAP，readonly 打开 INBOX，拉取最近 20 封邮件并在列表显示主题/发件人/时间。
5. 该闭环跑通后再接 mailparser 全量解析、SQLite、FTS、线程聚合、AI。

> 遇到外部阻塞（如原生模块安装失败、DeepSeek Key 缺失、学校 登录被 DUO 拦截）时，暂停并明确向用户报告，不要自行绕过安全策略。

---

## 13. 开发 AI 自测方案（新增，必读）

用户要求：**开发 AI 必须能自行测试产物，而不是让用户打开后才发现 bug。** 本仓库已落地一套可重复执行的自测，开发 AI 每次交付前必须跑通并附结果。

### 13.1 三层自测

| 层 | 工具 | 覆盖 | 是否需要真实邮箱/Key |
|---|---|---|---|
| L1 单元测试 | Vitest | 设备码/token 解析、UID 状态机、MIME 解析、线程聚合、FTS 查询、RAG prompt 组装、脱敏日志、IPC 参数校验 | 否（mock 输入） |
| L2 renderer E2E | playwright-core + 系统 Edge | 登录浮层、列表渲染、筛选、搜索、详情、AI 面板、无 console 错误 | 否（demo 已支持） |
| L3 Electron 冒烟 | playwright-core 的 `_electron.launch()`（已内置，无需下载浏览器） | 驱动**真实应用**（主进程 + preload + IPC + 渲染进程）：窗口启动、登录页→收件箱闭环、点按/输入/断言/截图 | 部分（真实 IMAP 需测试账号，可注入 mock provider） |
| L3b 视觉回归 | 截图 + 视觉模型（`deepseek-v4-flash-vision-exp` 或 `describe_image`） | 布局、中文乱码、深浅色、附件/引用渲染 | 否 |

### 13.2 已落地的自测（本次交付）

- `tests/package.json`：自测依赖（`playwright-core`），`npm test` 一键跑。
- `tests/e2e/smoke.mjs`：启动本地静态服务 → 用系统 Edge（headless）打开 `demo/index.html` → 断言 12 项（标题、登录、列表 8 封、默认选中、未读筛选 3 封、搜索 VPN 1 封、AI 面板、AI 总结、换行保留、无 JS 异常、无 console.error）→ 截图到 `tests/artifacts/smoke.png`。

运行方式：

```bash
cd tests
npm install        # 已安装过则跳过
npm test           # 期望 12/12 全绿
```

### 13.3 本次自测发现并已修复的问题

1. `demo/index.html` 缺 favicon → 浏览器自动请求 `/favicon.ico` 触发 404 console.error → 已加 `<link rel="icon" href="data:,">`。
2. AI 回复气泡缺 `white-space: pre-wrap` → 多行摘要换行被压成一行 → 已补 `white-space: pre-wrap; word-break: break-word;`。

### 13.4 后续接入真实应用的注意点

- L1 单测放在应用包内（`src/**/*.test.ts`），`vitest` 直接跑，不依赖 Electron 运行时。
- **L3 首选 `playwright-core` 自带的 `_electron.launch()`**（已随 `playwright-core` 内置，无需完整 `playwright` 包、也无需下载 Chromium——Electron 自带 Chromium）：

```js
import { _electron as electron } from "playwright-core";
const app = await electron.launch({ args: ["out/main/index.js"] }); // 或 electron.vite 产物入口
const win = await app.firstWindow();
await win.click("#loginBtn");          // 点按
await win.fill("#searchInput", "VPN"); // 输入
const n = await win.locator(".mail-item").count();
await win.screenshot({ path: "tests/artifacts/electron-smoke.png" });
await app.close();
```

  该方法直接控制真实 Electron 应用（主进程 + preload + IPC + 渲染进程），比"模拟鼠标在屏幕上点"精确得多：断言走 DOM/无障碍树，**不需要视觉模型去猜控件位置**；无测试账号时，在 `bootstrap.ts` 注入 `FakeMailProvider`/`FakeAiProvider`（§14 接口）跑通登录页→收件箱闭环。

- **视觉回归**：L3 截图存盘后用 `describe_image`（视觉模型 `deepseek-v4-flash-vision-exp`）做最终"看起来对不对"检查，或对关键页面做前后两次截图 diff；这是补充，不是主路径。
- **可选：电脑界面级操作（computer-use）插件**（仅当你需要控制应用之外的整个桌面时）：社区有 `qphotoai/dsh-computer-use-windows`、`Aik358/dsh-cua-pre`、`secretxuan/dsh-computer-use-win` 等（截图 + UIA + OCR + 审批门控）。**本项目测 Electron 应用用 `_electron` 更合适、更稳**，这些插件作为兜底，安装前先审源码并固定 commit。
- 无 学校 测试账号时，登录/IMAP 只做 mock 级验证 + 真实设备码发起前的协议级验证；真实验收仍需用户配合一次授权。

---

## 14. 扩展性与演进接口（防「写完改不动」，必须从 M1 起建立）

> 背景：用户明确担心"vibe coding 完成后无法更新/优化"。本节的规则就是为了让首期写完也能持续演进，而不是推倒重来。

**总原则：依赖倒置。** 上层（同步、搜索、AI 业务、IPC、UI）只依赖**接口**，不依赖具体实现；新增能力优先"加接口方法 + 加实现"，不改已有实现主体。

### 14.1 邮件后端抽象 `MailProvider`（最关键）

```ts
// src/main/mail/provider.ts
export interface MailboxInfo { uidValidity: number; exists: number; uidNext: number }

export interface MailProviderCapabilities {
  readOnly: true;                 // P0 只读
  send?: false;                   // P1 发信能力，未实现时缺省
  move?: false;                   // P1 归档/移动
}

export interface MailProvider {
  readonly capabilities: MailProviderCapabilities;
  connect(): Promise<void>;
  openInboxReadOnly(): Promise<MailboxInfo>;
  fetchEnvelopeRange(startUid: number, endUid: number): AsyncIterable<RawMessageMeta>;
  fetchBody(uid: number): Promise<RawMessageBody>;       // BODY.PEEK，永不标 \Seen
  fetchAttachment(uid: number, partId: string): Promise<AttachmentPayload>;
  // —— 预留写能力（P0 抛 UnsupportedOperationError，UI 按 capabilities 隐藏按钮）——
  send?(draft: OutgoingDraft): Promise<void>;
  move?(uid: number, folder: string): Promise<void>;
}
```

- P0 提供 `ImapMailProvider`（imapflow，readonly + XOAUTH2）实现该接口；`sync.ts` / `fetch.ts` 只依赖 `MailProvider`。
- P1 做发信/归档时，新增 `GraphMailProvider` 或 `SmtpMailProvider` 实现同一接口，**同步/取信代码一行不改**。

### 14.2 AI 抽象 `AiProvider` / `MailAiService`

```ts
// src/main/ai/provider.ts
export interface AiProvider {
  complete(params: ChatParams): Promise<string>;   // 只负责"补全"，不含业务
}

// src/main/ai/service.ts
export interface MailAiService {
  summarize(thread: Thread): Promise<Summary>;
  searchQA(question: string, hits: SearchHit[]): Promise<QaAnswer>;
  // 后续 P1 在此加方法：compose / reply / translate / classify，不碰收件箱逻辑
}
```

- `DeepSeekAiProvider` 实现 `AiProvider`（openai SDK 指向 DeepSeek base_url）。
- 换模型/换供应商只改 `deepseek.ts`；加 AI 功能只在 `MailAiService` 加方法。

### 14.3 存储抽象 `MessageStore` + schema 迁移

```ts
// src/main/db/store.ts
export interface MessageStore {
  upsertMessages(msgs: ParsedMessage[]): Promise<void>;
  query(params: Query): Promise<Message[]>;
  search(term: string): Promise<SearchHit[]>;
  getThread(threadId: string): Promise<Thread>;
}
```

- `SqliteMessageStore` 实现该接口，隔离 better-sqlite3。
- 用 `PRAGMA user_version` + `migrate.ts` 做迁移，**schema 只增不改**（新列可空或给默认值、新表追加、FTS 重建写进迁移），保证老数据能升级。
- 换 Meilisearch/Typesense 或改存储时，上层无感。

### 14.4 IPC 契约（单一事实来源）

- `src/shared/ipc-contract.ts` 集中定义：channel 名、请求/响应类型、zod 校验 schema。
- 渲染进程只通过 `preload` 暴露的类型化 `window.api` 调用；**禁止**在 renderer 手写 `ipcRenderer.invoke("字符串")`。
- 主进程 `ipcMain.handle` 统一从契约读 channel 并先 zod 校验入参。

### 14.5 前端功能注册表

- 把 `demo/index.html` 的 `futureFeatures` 数据驱动思想落到正式 app：导航项/页面/快捷命令由注册表驱动。
- 加"日历 / 规则 / 已发送 / 稍后提醒"= 加一个注册项 + 一个页面组件，不改布局框架代码。

### 14.6 组合根 `bootstrap.ts`

- 在 `src/main/bootstrap.ts` 一个地方装配依赖链（`MailProvider → MessageStore → MailAiService → IPC handlers`），禁止到处 `new`。
- 好处：可注入 fake/mock 做单测；替换实现只改这一处。

### 14.7 契约测试

- 每个接口配一组契约测试：用 fake 实现驱动上层逻辑，验证"换实现不破坏行为"。
- 例：`sync.test.ts` 用 `FakeMailProvider` 喂 UID 序列，验证增量/全量/UIDVALIDITY 变化；`searchQA.test.ts` 用 `FakeAiProvider` 验证 RAG 拼装与引用映射。

### 14.8 演进规则（写代码时逐条对照）

1. 上层模块不 import 具体实现（UI/同步/AI 业务里不出现 `imapflow` / `better-sqlite3` / `openai` 的直接引用）。
2. 新能力 = 接口新增方法 + 新增实现，不为新功能改动已有实现主体。
3. 数据库只增不改，走 `migrate.ts`。
4. 每次改动 = 一个 git commit + 测试通过（见 `AGENTS.md`）。
