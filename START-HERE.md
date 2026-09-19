# 项目启动提示词（复制整段到新对话使用）

你是开发 AI。当前工作目录应为本仓库根目录（进入后先用 `pwd` 确认）。请在本目录实现「学校邮箱 AI 助手」MVP 的最小闭环。以下是完整要求。

## 第一步：先读这些文件（不要跳过，读完再动手）
1. `AGENTS.md` —— 本目录的工作纪律（**每次改动必须 Git commit；每次改动必须更新测试并在交付前全部通过**），必须遵守。
2. `docs/dev-handoff-school-mail-mvp.md` —— **技术实现规范，唯一权威**。P0 范围、硬性约束、验收标准、自测方案都在里面。
3. `docs/Notion-Mail-功能调研与实现评估.md` —— 需求背景与功能清单，只作理解用。
4. `demo/index.html` —— 已有的前端交互 demo（纯前端 mock），作为 UI 风格与交互参考。
5. `tests/e2e/smoke.mjs` 与 `tests/package.json` —— 已落地的自测脚本，照此模式扩展。

## 目标
在**本目录（program/）**搭建并实现 M0 + M1 + M2 + M3 的最小闭环。docs/、demo/、tests/ 已就绪，在其旁新增 package.json、src/ 等应用代码。

## 范围（只做这些，禁止擅自扩展）
- M0：自测脚手架。复用并扩展 `tests/`，补充 Vitest 单元测试骨架。
- M1：Electron + React + TypeScript + Vite 脚手架、electron-builder、脱敏日志、preload/IPC 白名单、contextIsolation + sandbox。
- M2：设备码登录 + token 用 Windows DPAPI（Electron safeStorage）加密存储 + refresh_token 续期。
- M3：imapflow 连接（readonly + XOAUTH2）、UIDVALIDITY/UID 增量同步、mailparser 解析、SQLite/FTS、本地线程聚合；收件箱列表拉取并显示最近 20 封邮件（主题/发件人/时间）。
- **不做 P1/P2**：写信/发送/回复/归档/删除/星标/通知等一律不实现，只留接口位。

## 硬约束（必须遵守，详见规范 §2）
1. 只读三连：IMAP SELECT 永远 readonly；取正文用 BODY.PEEK；绝不发 STORE/COPY/MOVE/DELETE。
2. XOAUTH2 分隔符是 `\x01`（imapflow 自动处理，手写才需注意）。
3. 设备码 scope 只传 `https://outlook.office.com/IMAP.AccessAsUser.All`。
4. token 不写日志/不写明文文件，DPAPI 落盘，refresh 后新 token 覆盖旧值。
5. 日志脱敏：不记录 token、Account ID、邮件正文。
6. Electron：contextIsolation: true、nodeIntegration: false、sandbox: true，能力经 preload 白名单暴露。
7. HTML 正文渲染前用 DOMPurify 净化；默认不加载远程图片。

## 扩展接口（防锁死，必须从 M1 起建立，详见规范 §14）
- **依赖倒置**：上层只依赖接口，不依赖具体实现；禁止在 sync/搜索/AI 业务/UI 里直接 import `imapflow`、`better-sqlite3`、`openai`。
- **三个核心接口先定义再实现**：`MailProvider`（邮件后端，P0 用 ImapMailProvider，P1 加 Graph/SMTP 时同步代码不动）、`MessageStore`（存储，隔离 SQLite，配 `migrate.ts` 只增不改）、`AiProvider`/`MailAiService`（AI，换模型/加 AI 功能只改实现或加方法）。
- **IPC 契约单一来源**：`shared/ipc-contract.ts` 集中 channel + 类型 + zod；renderer 只走类型化 `window.api`。
- **组合根**：`main/bootstrap.ts` 一个地方装配依赖，禁止到处 new。
- **前端功能注册表**：导航/页面数据驱动，加功能=加注册项，不改布局框架。
- **契约测试**：每个接口配 fake 实现 + 契约测试，保证换实现/重构不破坏行为。

## 模型与 API
- 运行时 AI 用 `deepseek-v4-pro`，baseURL `https://api.deepseek.com`（OpenAI 兼容协议）。
- 视觉自测看图用 `deepseek-v4-flash-vision-exp`（经 `describe_image`；若本会话是多模态模型可 `read_image`）。
- 不要用已弃用的 `deepseek-chat` / `deepseek-reasoner`。
- DeepSeek API Key 从加密配置读取，不写代码仓库、不写日志。

## 自测要求（每次交付前必须执行，且符合 AGENTS.md 第 2 条）
- `cd tests && npm install && npm test` 必须全绿（当前基线 12/12）。
- 新增纯逻辑（设备码/token 解析、UID 状态机、MIME 解析、线程聚合、FTS、RAG prompt、脱敏）要配 Vitest 单测，用 mock，不依赖真实邮箱/Key。
- renderer E2E 用 playwright-core + 系统 Edge（免下载 Chromium）。
- **Electron 冒烟必须用 playwright-core 自带的 `_electron.launch()` 驱动真实应用**（`import { _electron } from "playwright-core"`）：启动应用 → 拿到 `firstWindow()` → 点按/输入/断言/截图，覆盖「登录页→收件箱」闭环；无测试账号时在 `bootstrap.ts` 注入 `FakeMailProvider`/`FakeAiProvider`。这是主测试路径，**不要靠肉眼/截图猜，断言走 DOM/无障碍树**。
- 视觉回归只作补充：把 `_electron` 或 renderer E2E 的截图存到 `tests/artifacts/`，用视觉模型（`describe_image` + `deepseek-v4-flash-vision-exp`）做一次「布局/中文/深浅色」抽查；不把它当主测试。
- 交付时附：① `npm test` 结果；② 至少一张截图（存 `tests/artifacts/`）；③ 改动说明。
- 发现 bug 先修好再交付，不要留「打开才发现」的问题。

## 版本管理（AGENTS.md 第 1 条）
- 每次改动完成（每个逻辑/里程碑/修复）都做一次 `git commit`，提交信息简洁说明改动。
- 交付前确认工作区干净、提交完整。

## 本次任务完成标准（交付物）
1. 可启动的 Electron 桌面应用（写明 `npm run dev` / 打包命令）。
2. 设备码登录链路可用（真实设备码发起，token DPAPI 落盘）。
3. 收件箱列表能拉取并显示最近 20 封邮件（主题/发件人/时间）。
4. 根目录 `README.md`：安装、运行、自测、已知限制。
5. 自测报告（命令 + 结果 + 截图）。

## 阻塞与安全
- 原生模块安装失败 / 缺 DeepSeek Key / 学校 登录被 DUO 拦截 → 暂停并明确报告，不要绕过安全策略。
- docs/ 是只读规范，不要改动已批准的范围。
- 不要向用户展示或写日志：token、Account ID、邮件正文。

## 开始方式
先一句话复述你对范围的理解，然后给出 todo 清单，从 M0/M1 开始推进。
