/**
 * 主进程 / 渲染进程共享的 DTO 类型。
 * 只放"跨进程传输"的数据形状；领域内部类型放在各自模块（mail/types.ts 等）。
 */

export interface AuthStatus {
  loggedIn: boolean
  email: string | null
}

export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type DeviceCodeEvent =
  | { type: 'started' }
  | { type: 'polling'; attempts: number }
  | { type: 'success'; email: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'expired' }
  | { type: 'cancelled' }

export type SyncPhase = 'connecting' | 'full' | 'incremental' | 'done' | 'error'

export interface SyncProgress {
  phase: SyncPhase
  done: number
  total: number
  message?: string
  errorCode?: string
}

export interface SyncResult {
  synced: number
  mode: 'full' | 'incremental' | 'uptodate'
  durationMs: number
  /** 增量模式下本次新拉取的 UID（用于新邮件自动总结 + 通知） */
  newUids: number[]
  /** 本次实际同步的文件夹（V2 M3） */
  folders: string[]
}

/** 邮箱文件夹（V2 M3） */
export interface MailFolder {
  path: string
  name: string
}

/** 彩色类别（V2.2，Gmail 风格；一封邮件最多一个，列表用其淡色背景常亮标出） */
export interface MailCategory {
  id: number
  name: string
  color: string
}

/** 本地标签（V2 M4；星标是独立的 starred 字段，不属于标签） */
export interface MailLabel {
  id: number
  name: string
  color: string
}

// ---- V2 M5：自定义视图 ----

/** 视图过滤条件（全部可选，命中 = AND） */
export interface ViewFilter {
  /** 发件人（姓名或地址，子串匹配） */
  from?: string
  /** 只看未读 */
  unread?: boolean
  /** 只看带附件 */
  hasAttachment?: boolean
  /** 任一命中即包含 */
  labelIds?: number[]
  /** 起始时间（含，ms 时间戳） */
  dateFrom?: number
  /** 结束时间（含，ms 时间戳） */
  dateTo?: number
  /** 关键字（主题/正文/发件人） */
  text?: string
}

export interface ViewSort {
  by: 'date' | 'from' | 'subject'
  dir: 'asc' | 'desc'
}

export interface SavedView {
  id: number
  name: string
  filter: ViewFilter
  sort: ViewSort
  createdAt: number
}

// ---- M3 知识库：集合（由索引卡片派生）+ 周报 ----

/** 集合（课程 / 类型）：值 + 数量 + 最近截止，全部来自索引卡片的结构化字段 */
export interface CollectionSummary {
  kind: 'course' | 'type'
  value: string
  count: number
  /** 最近一个「还没过期」的截止时间（ms；没有则 null） */
  nextDue: number | null
  /** 集合里最新一封邮件的时间 */
  lastAt: number
}

/** 集合里的一封邮件（含卡片字段，用于档案卡） */
export interface CollectionMail {
  id: number
  subject: string
  fromName: string
  fromAddr: string
  dateTs: number
  dueTs: number | null
  type: string | null
  course: string | null
  entities: string[]
  aliases: string[]
}

/** 本周简报（全部由索引卡片 + 邮件元数据聚合，不调用大模型） */
export interface WeeklyBrief {
  fromTs: number
  toTs: number
  /** 本周收到的邮件数 */
  newMails: number
  /** 本周内到期的截止（按时间升序） */
  dueItems: Array<{ id: number; subject: string; dueTs: number; course: string | null }>
  /** 本周邮件按类型分布 */
  byType: Array<{ type: string; count: number }>
  /** 本周邮件涉及的课程 */
  courses: Array<{ course: string; count: number }>
  /** 没有索引卡片的邮件数（提示用户补跑） */
  missingCards: number
}

// ---- AI 助手聊天（多轮会话，本地留存） ----

export interface ChatSession {
  id: number
  title: string
  createdAt: number
  updatedAt: number
  /** 会话里的消息条数（列表展示用） */
  messageCount: number
}

export interface ChatMessage {
  id: number
  sessionId: number
  role: 'user' | 'assistant'
  content: string
  /** 助手消息的引用邮件（点引用可跳回原邮件） */
  citations: Array<{ id: number; subject: string; fromName: string; dateTs: number }>
  createdAt: number
}

// ---- 发信（SMTP + OAuth）：本地「已发送」记录 ----

export interface SentItem {
  id: number
  toAddrs: string[]
  ccAddrs: string[]
  subject: string
  body: string
  /** 发信时间（ms） */
  sentAt: number
  status: 'sent' | 'failed'
  /** 失败原因（服务器原文，已裁剪） */
  error: string | null
}

/** 发信参数（回复/转发/草稿发送/新写共用） */
export interface SendMailArgs {
  /** 收件人，支持 `a@x.com, b@y.com` 逗号/分号分隔 */
  to: string
  cc?: string
  subject: string
  body: string
  /** 回复时带上原邮件 Message-ID（写入 In-Reply-To / References） */
  inReplyTo?: string
  /** 草稿 id：发送成功后自动删除草稿 */
  draftId?: number
}

export interface SendMailResult {
  ok: boolean
  /** 失败阶段（connect/auth/mail/rcpt/data…） */
  stage: string
  serverMessage: string
  conclusion: string
  /** 成功时本地「已发送」记录 id */
  sentId?: number
}

// ---- V2 M9：本地草稿 ----

export interface MailDraft {
  id: number
  toAddrs: string[]
  subject: string
  body: string
  createdAt: number
  updatedAt: number
}

/** 新邮件事件（推送）：自动总结 + Windows 通知 + 渲染端提示。 */
export interface NewMailEvent {
  id: number
  uid: number
  subject: string
  fromName: string
  snippet: string
  summary: string | null
  /** 用户点击系统通知时带上，渲染端据此自动打开该邮件 */
  fromClick?: boolean
}

export interface MailListItem {
  id: number
  uid: number
  threadId: string
  subject: string
  fromName: string
  fromAddr: string
  dateTs: number
  dateLabel: string
  snippet: string
  unread: boolean
  hasAttachments: boolean
  /** 本地标签（V2 M4） */
  labels: MailLabel[]
  /** 标签（V2.2：规则 + AI + 手动，统一为一个体系；可筛选） */
  autoTags?: string[]
  /** 其中「手动」打的标签（列表里带 ✋ 标识，且不会被 AI 重算覆盖） */
  manualTags?: string[]
  /** 星标（V2 M4） */
  starred: boolean
  /** 红旗 / 后续标记（V2.2，Outlook 风格；与星标独立） */
  flagged?: boolean
  /** 彩色类别（V2.2；有值时列表行用该颜色淡色背景） */
  category?: MailCategory | null
  /** 待触发的稍后提醒时间（ms 时间戳；null = 无，V2 M6） */
  snoozeUntil: number | null
}

export interface AttachmentMeta {
  id: number
  filename: string
  contentType: string
  size: number
  /** IMAP part 标识（下载用）；旧数据可能为空串，下载时按需回填 */
  partId: string
}

/** 标签示例（用户挑的示例邮件：给 AI 打标签当 few-shot 参考） */
export interface TagExample {
  id: number
  subject: string
  tags: string[]
}

/** 附件保存结果（V2.2：由主进程决定落盘位置并写文件）。 */
export interface AttachmentSaveResult {
  /** false = 用户在保存对话框里取消了 */
  saved: boolean
  /** 落盘的绝对路径（saved=true 时有值） */
  path?: string
  filename: string
}

/** 附件下载结果（经 IPC 传输，内容 base64）。 */
export interface AttachmentDownload {
  filename: string
  contentType: string
  dataBase64: string
}

export interface MailDetail extends MailListItem {
  /** 原始 Message-ID（回复时写入 In-Reply-To，保持会话归并） */
  messageId: string | null
  toAddrs: string[]
  ccAddrs: string[]
  bodyText: string
  bodyHtml: string | null
  attachments: AttachmentMeta[]
  /** 已保存的 AI 总结（长期保留，展示在最前面） */
  savedSummary: string | null
  savedSummaryModel: string | null
  savedSummaryAt: number | null
}

/** 主题：跟随系统 / 浅色 / 深色 */
export type ThemeMode = 'system' | 'light' | 'dark'
/** 界面密度：紧凑 / 标准 / 宽松 */
export type UiDensity = 'compact' | 'standard' | 'relaxed'

export interface AppSettings {
  /** AI 服务商 id（可选值见 shared/aiProviders.ts） */
  aiProvider: string
  aiModel: string
  /** 实际请求的 Base URL（预设服务商由目录给出；自定义时用用户填写的值） */
  aiBaseUrl: string
  /** 自定义服务商的 Base URL（仅 provider=custom 时使用） */
  aiCustomBaseUrl: string
  hasApiKey: boolean
  /** 0 = 同步全部历史邮件；>0 = 最近 N 封 */
  syncWindow: number
  /** 自动刷新间隔（秒）；0 = 关闭 */
  refreshIntervalSec: number
  /** 自定义 AI 总结提示词 */
  summaryPrompt: string
  /** 新邮件自动 AI 总结 + Windows 通知（默认开） */
  autoSummarizeNew: boolean
  /** 个人邮箱发信（SMTP）配置：主机/端口/是否直连 TLS/用户名/默认收件人 */
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpTo: string
  /** 是否已保存密码/应用密码（不回传明文） */
  hasSmtpPass: boolean
  /** 登录时是否申请发信权限（SMTP.Send）；改变后需重新登录一次 */
  sendScope: boolean
  // —— 外观（V2.2 通用化）——
  /** 主题：跟随系统 / 浅色 / 深色 */
  theme: ThemeMode
  /** 界面密度（列表行高与字号） */
  density: UiDensity
  /** 侧边栏与窗口标题显示的产品名（可改成自己学校的名字） */
  brandName: string
  /** 侧边栏副标题（留空则不显示） */
  brandSubtitle: string
  /** 列表一次加载多少封 */
  listPageSize: number
  /** 时间显示：相对时间（3 分钟前）还是绝对时间 */
  relativeTime: boolean
  // —— 行为（V2.2 通用化）——
  /** 打开邮件时在本地标记已读（只改本地库，不动服务器） */
  openMailMarksRead: boolean
  /** 启动时自动同步一次 */
  syncOnStartup: boolean
  /** 发送前二次确认 */
  confirmBeforeSend: boolean
  /** AI 问答最多参考/引用几封邮件（3-40） */
  askTopK: number
  /** 附件保存目录；空串 = 每次弹窗询问（默认），否则直接存到该目录 */
  attachmentDir: string
  // —— 自动标签（V2.2：A 规则映射 + B AI 主题标签）——
  /** 是否自动打标签（默认开） */
  autoTagEnabled: boolean
  /** AI 打标签用的词表（顿号/逗号分隔） */
  tagVocabulary: string
}

export interface AiSummaryResult {
  text: string
  threadId: string
  messageCount: number
  /** 实际使用的模型名（可能被设置页切换） */
  model: string
  savedAtMs: number
  /** true = 模型多次空返回后的元信息兜底（未持久化） */
  degraded?: boolean
}

/** AI 收件箱问答结果（V2 M1）：答案 + 可跳转引用。 */
export interface AiAskResult {
  answer: string
  citations: { id: number; subject: string; fromName: string; dateTs: number }[]
  model: string
}

export interface SetSettingsArgs {
  aiProvider?: string
  aiModel?: string
  aiCustomBaseUrl?: string
  apiKey?: string
  syncWindow?: number
  /** 自动刷新间隔（秒）；0 = 关闭自动刷新 */
  refreshIntervalSec?: number
  /** 自定义 AI 总结提示词；空串 = 恢复默认 */
  summaryPrompt?: string
  /** 新邮件自动 AI 总结 + Windows 通知 */
  autoSummarizeNew?: boolean
  /** 个人邮箱（SMTP）发信配置；密码传空串 = 清除已保存的密码 */
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  smtpUser?: string
  smtpPass?: string
  smtpTo?: string
  /** 登录 scope 是否包含 SMTP.Send（发信权限） */
  sendScope?: boolean
  /** 主题：system / light / dark */
  theme?: ThemeMode
  /** 界面密度：compact / standard / relaxed */
  density?: UiDensity
  /** 产品显示名（1-24 字） */
  brandName?: string
  /** 侧边栏副标题（0-40 字，空串 = 不显示） */
  brandSubtitle?: string
  /** 列表一次加载多少封（5-200） */
  listPageSize?: number
  /** 时间显示：相对 / 绝对 */
  relativeTime?: boolean
  /** 打开邮件时本地标记已读 */
  openMailMarksRead?: boolean
  /** 启动时自动同步 */
  syncOnStartup?: boolean
  /** 发送前二次确认 */
  confirmBeforeSend?: boolean
  /** AI 问答最多参考/引用几封（3-40） */
  askTopK?: number
  /** 附件保存目录（空串 = 每次询问） */
  attachmentDir?: string
  /** 自动标签开关 */
  autoTagEnabled?: boolean
  /** AI 打标签词表（顿号/逗号分隔） */
  tagVocabulary?: string
}

/** 所有 IPC handler 的统一返回形状（preload 解包后再抛 ApiError）。 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
