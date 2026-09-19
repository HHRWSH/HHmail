import type { CalendarEvent } from './calendar'
/**
 * window.api 白名单契约：preload 通过 contextBridge 暴露的能力全集。
 * renderer 只允许调用这里声明的方法；加能力 = 先在这里加方法，再在 preload 实现。
 */
import type {
  AiAskResult,
  AiSummaryResult,
  AppSettings,
  AttachmentDownload,
  AuthStatus,
  DeviceCodeEvent,
  DeviceCodeInfo,
  MailDetail,
  MailDraft,
  MailFolder,
  MailLabel,
  MailListItem,
  NewMailEvent,
  SavedView,
  SendMailArgs,
  SendMailResult,
  SentItem,
  SetSettingsArgs,
  SyncProgress,
  SyncResult,
  ViewFilter,
  ViewSort
} from './types'

export class ApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

export interface WindowApi {
  getAuthStatus(): Promise<AuthStatus>
  startDeviceCode(): Promise<DeviceCodeInfo>
  onDeviceCodeEvent(cb: (event: DeviceCodeEvent) => void): () => void
  logout(): Promise<void>
  listMails(args?: { limit?: number; offset?: number; folder?: string; labelIds?: number[]; starredOnly?: boolean; filter?: ViewFilter; sort?: ViewSort; autoTags?: string[]; flaggedOnly?: boolean; categoryId?: number }): Promise<MailListItem[]>
  /** 邮箱文件夹列表（V2 M3） */
  listFolders(): Promise<MailFolder[]>
  getMail(id: number): Promise<MailDetail>
  searchMail(term: string): Promise<MailListItem[]>
  markMailRead(id: number, read: boolean): Promise<void>
  /** 附件下载（BODY.PEEK[part]，只读；V2 M2）——返回 base64，由渲染端另存 */
  downloadAttachment(id: number, partId: string): Promise<AttachmentDownload>
  /** 附件保存（V2.2）：主进程按设置决定保存位置并写文件（未设置目录时弹保存对话框） */
  saveAttachment(id: number, partId: string): Promise<import('./types').AttachmentSaveResult>
  /** 彩色类别：列表 / 新建 / 改名改色 / 删除（V2.2） */
  listCategories(): Promise<import('./types').MailCategory[]>
  /** 每个类别的邮件数（侧边栏分类显示） */
  categoryCounts(): Promise<Array<{ id: number; name: string; color: string; count: number }>>
  createCategory(name: string, color: string): Promise<import('./types').MailCategory>
  updateCategory(id: number, patch: { name?: string; color?: string }): Promise<void>
  deleteCategory(id: number): Promise<void>
  /** 给邮件设置彩色类别（null = 清除） */
  setMailCategory(messageId: number, categoryId: number | null): Promise<void>
  /** 红旗：设置/取消（V2.2） */
  setFlagged(id: number, flagged: boolean): Promise<void>
  /** 当前筛选条件下的邮件总数（与 listMails 用同一套条件） */
  countMails(args?: {
    folder?: string
    labelIds?: number[]
    starredOnly?: boolean
    flaggedOnly?: boolean
    unreadOnly?: boolean
    categoryId?: number
    filter?: ViewFilter
    autoTags?: string[]
  }): Promise<number>
  /** 日历：取某时间范围内的事件（截止 + 卡片里提到的日期） */
  listEvents(args: { from: number; to: number }): Promise<CalendarEvent[]>
  /** 自动标签：各标签的邮件数 */
  tagCounts(): Promise<Array<{ tag: string; count: number; manual?: boolean }>>
  /** 自动标签：用户挑的示例邮件（给 AI 当参考） */
  tagExamples(): Promise<import('./types').TagExample[]>
  /** 标签：手动给某封邮件加/去一个标签（手动标签不会被自动重算覆盖） */
  setMailTagManual(messageId: number, tag: string, on: boolean): Promise<void>
  /** 自动标签：设置/取消某封邮件的示例标签（空数组 = 取消） */
  setTagExample(messageId: number, tags: string[]): Promise<void>
  /** 自动标签：用现有索引卡片重算全部规则标签（不花 AI 成本） */
  rebuildTags(): Promise<number>
  /** 选择目录（设置 → 附件保存位置） */
  pickDirectory(defaultPath?: string): Promise<string | null>
  /** 在文件管理器中定位某个文件/目录 */
  openPath(path: string): Promise<void>
  syncMail(args?: { folders?: string[] }): Promise<SyncResult>
  onSyncProgress(cb: (progress: SyncProgress) => void): () => void
  onNewMail(cb: (event: NewMailEvent) => void): () => void
  summarizeMail(id: number): Promise<AiSummaryResult>
  /** 自然语言问收件箱（V2 M1） */
  askInbox(question: string): Promise<AiAskResult>
  /** 聊天会话列表（M4：聊天式界面，最近更新在前） */
  chatSessions(): Promise<import('./types').ChatSession[]>
  /** 某会话的历史消息（时间升序） */
  chatMessages(sessionId: number): Promise<import('./types').ChatMessage[]>
  /** 新建会话，返回会话 id */
  newChatSession(): Promise<number>
  /** 删除会话（连同消息） */
  deleteChatSession(sessionId: number): Promise<void>
  /** 重命名会话 */
  renameChatSession(sessionId: number, title: string): Promise<void>
  /** 在会话里提问（自动带上下文并保存两条消息） */
  chatAsk(sessionId: number, question: string, topK?: number): Promise<import('./types').ChatMessage>
  /** 一键总结未生成摘要的邮件（V2.1）；force=true 时重新生成（覆盖已有）；ids 指定则只跑这几封 */
  summarizePending(
    limit?: number,
    force?: boolean,
    ids?: number[]
  ): Promise<{ total: number; done: number; degraded: number; failed: number; cancelled?: boolean }>
  /** 取消正在进行的批量总结 */
  cancelSummarize(): Promise<void>
  /** 批量总结进度（V2.1）：subject + current 用于显示「正在生成哪一封」 */
  onSummaryProgress(
    cb: (p: {
      done: number
      total: number
      subject: string | null
      /** true = 这条是「正在生成」而不是「已完成」 */
      current?: boolean
      finished?: boolean
      cancelled?: boolean
      /** 已用时间（ms），用于估算剩余时间 */
      elapsedMs?: number
    }) => void
  ): () => void
  /** 修复同步：游标回退到本地最大 UID 后重新拉取缺失邮件（V2.1） */
  resyncMail(folder?: string): Promise<void>
  /** 发送能力自检：探测当前账号能否用 SMTP 发送（只检测，不发送邮件） */
  probeSendCapability(): Promise<{
    reachable: boolean
    startTls: boolean
    authMechanisms: string[]
    authOk: boolean
    serverMessage: string
    guidance: string
    /** 本地数据目录（设置页「关于与数据」展示用） */
    userDataDir?: string
  }>
  /** 个人邮箱发信测试：真的发一封纯文本测试邮件（仅用户自带的 SMTP 账号） */
  sendTestMail(args: {
    /** personal = 个人邮箱（SMTP 密码）；school = 学校账号（OAuth SMTP.Send） */
    mode?: 'personal' | 'school'
    to?: string
    subject?: string
    text?: string
  }): Promise<{ ok: boolean; stage: string; serverMessage: string; conclusion: string }>
  /** 发信（回复/转发/草稿发送/新写）——成功后会写入本地「已发送」记录 */
  sendMail(args: SendMailArgs): Promise<SendMailResult>
  /** 检索索引卡片覆盖情况（M1） */
  indexStats(): Promise<{ total: number; missing: number }>
  /** 知识库集合列表（M3：课程 / 类型，由索引卡片派生；默认只做浏览，不做硬过滤） */
  listCollections(): Promise<import('./types').CollectionSummary[]>
  /** 某个集合里的邮件（M3） */
  collectionMails(kind: 'course' | 'type', value: string, limit?: number): Promise<import('./types').CollectionMail[]>
  /** 把邮件移出/移回集合（手动修正；M3） */
  setCollectionExcluded(messageId: number, kind: 'course' | 'type', value: string, exclude: boolean): Promise<void>
  /** 本周简报（M3：纯聚合，不调用大模型） */
  weeklyBrief(range?: { fromTs?: number; toTs?: number }): Promise<import('./types').WeeklyBrief>
  /** 本地「已发送」列表（时间倒序） */
  listSentItems(limit?: number): Promise<SentItem[]>
  /** 删除一条已发送记录 */
  deleteSentItem(id: number): Promise<void>
  /** 本地标签列表（V2 M4） */
  listLabels(): Promise<MailLabel[]>
  /** 新建标签，返回带 id 的标签（V2 M4） */
  createLabel(name: string, color?: string): Promise<MailLabel>
  /** 删除标签（关联自动解除；V2 M4） */
  deleteLabel(id: number): Promise<void>
  /** 设置邮件的标签集合（V2 M4） */
  setMailLabels(id: number, labelIds: number[]): Promise<void>
  /** 星标开关（V2 M4） */
  toggleStar(id: number, starred: boolean): Promise<void>
  /** 已保存视图列表（V2 M5） */
  listViews(): Promise<SavedView[]>
  /** 保存视图（带 id = 覆盖）；返回含 id 的完整视图（V2 M5） */
  saveView(args: { id?: number; name: string; filter: ViewFilter; sort: ViewSort }): Promise<SavedView>
  /** 删除视图（V2 M5） */
  deleteView(id: number): Promise<void>
  /** 设置稍后提醒（V2 M6；重复设置 = 覆盖未触发的提醒） */
  snoozeMail(id: number, until: number, note?: string): Promise<void>
  /** 取消未触发的稍后提醒（V2 M6） */
  cancelSnooze(id: number): Promise<void>
  /** 批量标记已读/未读（只改本地；V2 M7） */
  bulkMarkRead(ids: number[], read: boolean): Promise<void>
  /** 批量加标签（并入现有标签；V2 M7） */
  bulkAddLabels(ids: number[], labelIds: number[]): Promise<void>
  /** 草稿列表（V2 M9） */
  listDrafts(): Promise<MailDraft[]>
  /** 保存草稿（带 id = 覆盖）；返回完整记录（V2 M9） */
  saveDraft(args: { id?: number; toAddrs: string[]; subject: string; body: string }): Promise<MailDraft>
  /** 删除草稿（V2 M9） */
  deleteDraft(id: number): Promise<void>
  getSettings(): Promise<AppSettings>
  saveSettings(args: SetSettingsArgs): Promise<AppSettings>
  openExternal(url: string): Promise<void>
}

declare global {
  interface Window {
    api?: WindowApi
  }
}
