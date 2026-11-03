# HHmail

**本地优先的学校邮箱客户端 + AI 助手**：用微软账号登录你的学校邮箱（Microsoft 365 / Outlook），
**只读收信**（不改动服务端邮件）+ **发信**（回复 / 转发 / 新写 / 草稿，SMTP）+ AI 摘要 + AI 检索问答 + 自动标签 / 彩色类别。
不绑定任何一所学校 —— 显示名称、标签词表、AI 服务商、类别都能自己改。

> Windows 版开箱可用；**macOS 版**由仓库内的 GitHub Actions 自动构建（产出 dmg/zip，未签名需手动放行），
> 也可以在有 Mac 的机器上执行 `npm run pack:mac` 自己打包。详见下文「持续集成 / macOS」。

## 功能

- **只读收信**：IMAP + OAuth 设备码登录，多文件夹；`SELECT` 始终 readonly、正文用 `BODY.PEEK`，不删除/移动/标记服务端已读；本地 SQLite + FTS5 全文检索
- **AI 摘要（决策卡）**：主旨 / 关键信息 / 截止与行动项 / 分类 / 可信度，30 秒看清一封邮件
- **AI 助手（聊天式）**：多轮对话、新建/删除会话；回答带**可点击引用**（点邮件名跳回原文）
- **检索索引卡片**：与人类摘要分开的第二份产物（类型 / 课程号 / 截止 / 别名），支撑中英 + 简繁跨语言检索
- **待办**：把索引卡片的 [DUE] 与摘要里的「行动项」自动汇成任务清单（今天/本周/全部/已完成），
  逾期红色、可勾选完成、可手动新增/编辑/删除，点标题跳回原邮件；
- **自绘标题栏**：无边框窗口，顶栏集成 返回 / 全局搜索 / 全部已读 / 同步 / 设置 + 最小化/最大化/关闭（按钮无圆角、仅 hover 有反馈）；
  侧边栏与顶栏图标统一为线性 SVG；
- **拦截发件人（本地黑名单 + 折叠）**：邮件详情「🚫 拦截发件人」或设置里加规则；被拦截的邮件仍只读入库，
  但不进收件箱列表、不计未读/角标/不弹通知，折叠到列表底部「已拦截」（随时可解除，服务器不动）；
- **5 套视觉风格可切换**：设置 → 外观 → 视觉风格（Apple 原生 / Linear 工具 / Notion 暖白 / 纸张编辑 / 玻璃拟态），
  亮色与暗色主题各有一套，切换即时生效、布局不变；
- **自动更新**：安装版（NSIS）内置检查更新（启动 30 秒后自动检查，也可手动点「检查更新」），
  发现新版本后由用户确认下载、显示进度，下载完可「重启并安装」；便携版只提示手动下载；
- **自定义模型 / 自动拉取**：设置 → AI 可「🔍 获取最新模型」（调服务商 /models），
  也可直接手填任意模型 ID（如 deepseek-v3.2），保存即生效；
- **一键已读**：收件箱工具栏「✓ 全部已读」（只改本地库，二次确认）；
- **新邮件轰炸保护**：一次到达超过 5 封时静默系统通知（界面/未读/角标照常更新）；
- **开机自动启动**：设置 → 关于与数据 可开启（隐藏启动，驻留托盘）；
- **一键退订**：识别邮件里的 List-Unsubscribe（RFC 8058 一键 POST / https 页面 / mailto），
  详情页一键退订（只允许 https 与 mailto、必须二次确认、不跟随任意链接），结果只记本地；
- **未读角标**：Windows 任务栏显示未读数（1–9 / 9+），托盘提示「品牌名 · N 封未读」，macOS 显示 dock 角标；
- **免打扰**：设置一个时间窗（支持跨午夜），窗内不弹系统通知，仍照常同步与计未读；
- **日历**：把邮件里解析出的时间铺到月视图 —— 截止（红点）与卡片里提到的日期（蓝点）分开标记，
  有事件的日子显示数量角标；点某天列出当天事项，可直接跳回那封邮件
- **知识库**：本周简报 + 按课程/类型自动归集的集合档案卡
- **自动标签**：规则（类型 / 课程号 / 平台 / 紧急度）+ AI 主题标签（词表可改、可挑示例邮件给 AI 当参考）+ **手动标签**（永不被重算覆盖）
- **彩色类别**：一封邮件一个类别，列表里用对应颜色标出（类别可在设置里改名 / 改色 / 新增 / 删除）
- **红旗 / 星标 / 稍后提醒 / 批量操作**
- **发信**：回复 / 转发 / 新写 / 草稿；学校账号走 SMTP + XOAUTH2（登录时勾选 `SMTP.Send` 授权），或改用个人邮箱 SMTP；本地「已发送」记录
- **本地优先**：邮件、摘要、索引、对话全在本机；只有调用 AI 时才把相关邮件内容发给你自己配置的服务商
- **多 AI 服务商**：DeepSeek / 阿里云百炼 / Kimi / 智谱 GLM / OpenAI / 自定义 OpenAI 兼容地址（如本地 Ollama）

## 快速开始（开发）

```bash
npm install
npm run dev            # 开发模式启动 Electron
npm run typecheck      # 类型检查
npm test               # 单元测试（会先把 better-sqlite3 重建到 Node ABI）
```

自测（用系统 Edge / Electron，**不联网、不碰真实账号**）：

```bash
npm --prefix tests install   # 只需一次（playwright 依赖）
npm run verify:ci            # 类型检查 + 单元测试（强制 TZ=UTC，与 CI runner 一致）
npm run verify:ci:full       # 上面全部 + 三层 E2E（demo 冒烟 / 渲染层 / Electron）
```

> 为什么专门跑 `verify:ci`：CI 跑在 UTC 时区，任何「用本地时区构造时间戳、再断言格式化后的字符串」的测试
> 都会在 CI 上失败、本地却通过（踩过一次）。该脚本强制 `TZ=UTC` 跑单测，让本地就能复现 CI 结果。

打包（Windows）：

```bash
npm run pack           # 产出 dist/HHmail <版本>.exe 与安装包；打包前会自动清理历史产物
```

## 架构

```
src/main        Electron 主进程：IMAP/SMTP、SQLite(含 FTS5) 存储、AI 服务、IPC、同步调度
src/preload     上下文隔离的 window.api 桥（白名单）
src/renderer    React 界面：收件箱 / 详情 / AI 助手 / 知识库 / 设置
src/shared      主/渲染共用：类型、IPC 契约、检索与排序、标签/类别、主题
tests           单元测试 + 三层 E2E（demo 冒烟 / 渲染层 / Electron 真实主进程）+ 性能与检索评测工具
```

技术栈：Electron 35 · React 18 · TypeScript · electron-vite · better-sqlite3 · imapflow · Vitest · Playwright

## 性能（真机实测）

邮件正文 HTML 平均 445KB（单封最大 11.6MB），早期版本列表查询 `SELECT m.*` 会把 200 封的整份正文读进内存：

| INBOX 取 200 封 | 修复前 | 修复后 |
| --- | --- | --- |
| 列表查询耗时 | **3270 ms** | **1.3–1.5 ms** |
| 跨进程传输数据量 | **106 MB** | **99 KB** |

做法：列表只取需要的列 + 已存摘要；正文搬到独立表按需读取（迁移 v17 + 一次性 VACUUM）；
渲染层渐进式分块渲染 + 行级 memo + 同步事件合并。复跑工具见
`tests/bench-store.mjs`、`tests/perf.mjs`、`tests/perf-switch.mjs`。

## 隐私

- 不内置任何 API Key / 密码 / 令牌；密钥经系统安全存储加密（Windows DPAPI / macOS Keychain）
- 邮件正文、摘要、索引、对话只在本机 SQLite；`.gitignore` 已排除数据库、日志、构建产物与密钥
- 调用 AI 时只发送「本次相关的少量邮件内容」到你选择的服务商
- 远程图片默认不加载（防跟踪像素）

## 持续集成 / macOS 版本

`.github/workflows/build.yml`：push / PR 时跑 typecheck + 单元测试 + E2E；
矩阵构建 Windows x64、macOS arm64（`macos-14`）、macOS x64（`macos-13`）产物并上传为 artifact；
打 `v*` 标签时创建**草稿** Release。

**没有 Mac 也能拿到 macOS 版**：
1. 打开仓库 **Actions → 最新一次 build → 底部 Artifacts**，下载 `macos-arm64`（Apple 芯片）或 `macos-x64`（Intel）；
2. 解压得到 `HHmail-<版本>-arm64.dmg`（或 `.zip`）；
3. 未签名版本首次打开会被 Gatekeeper 拦下，任选一种放行方式：
   - 右键 App → 「打开」 → 再点「打开」；
   - 或终端执行 `sudo xattr -dr com.apple.quarantine "/Applications/HHmail.app"`；
   - 或「系统设置 → 隐私与安全性 → 仍要打开」。

想自己在本机打包（需 macOS + Xcode 命令行工具）：

```bash
npm ci
npm run pack:mac        # 产出 dist/HHmail-<版本>-<arch>.dmg / .zip
```

签名与公证需要 Apple Developer 账号（$99/年）：在 CI 里配置 Secrets
（`CSC_LINK` + `CSC_KEY_PASSWORD` + 公证用的 `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`）后，
把 `package.json` 里 `build.mac.identity` 的 `null` 去掉即可自动签名+公证。

## 许可

MIT（见 LICENSE）。
