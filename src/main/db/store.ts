/**
 * MessageStore —— 存储抽象（规范 §14.3）。
 * 隔离 better-sqlite3；换存储（Meilisearch 等）时上层无感。
 */
import type { CalendarSourceMail } from '../../shared/calendar'
import type {
  ChatMessage,
  ChatSession,
  CollectionMail,
  CollectionSummary,
  MailDetail,
  MailDraft,
  MailLabel,
  MailListItem,
  SavedView,
  SentItem,
  ViewFilter,
  ViewSort,
  WeeklyBrief
} from '../../shared/types'

import type { WeightedTerm } from '../../shared/retrievalQuery'

export type { ChatMessage, ChatSession, CollectionMail, CollectionSummary, WeeklyBrief }
import type { ParsedMessage } from '../mail/types'
import type { ThreadIndexEntry } from '../mail/thread'

/** 入库消息 = 解析结果 + 本地线程 id（+ 所属文件夹，V2 M3 缺省 INBOX）。 */
export type IncomingMessage = ParsedMessage & { threadId: string; folder?: string }

export interface QueryParams {
  limit: number
  offset: number
  unreadOnly?: boolean
  /** 文件夹过滤（V2 M3；缺省 INBOX） */
  folder?: string
  /** 标签过滤（V2 M4）：任一命中即包含 */
  labelIds?: number[]
  /** 自动标签过滤（V2.2）：多标签 OR（只看，不做硬过滤/删除） */
  autoTags?: string[]
  /** 只看星标（V2 M4） */
  starredOnly?: boolean
  /** 只看红旗（V2.2） */
  flaggedOnly?: boolean
  /** 按彩色类别筛选（V2.2） */
  categoryId?: number
  /** 视图过滤（V2 M5，条件 AND） */
  filter?: ViewFilter
  /** 视图排序（V2 M5；缺省 date desc） */
  sort?: ViewSort
}

export interface SearchHit {
  id: number
  uid: number
  threadId: string
  subject: string
  fromName: string
  fromAddr: string
  dateTs: number
  snippet: string
}

export interface SyncStateRecord {
  uidValidity: number
  lastUid: number
  /** 「同步全部历史邮件」模式是否已完成过全量同步（老数据升级后为 false → 触发重新全量）。 */
  fullHistory?: boolean
  /** 所属文件夹（V2 M3；缺省 INBOX） */
  folder?: string
}

export interface SavedSummary {
  text: string
  model: string
  createdAtMs: number
}

/** 索引卡片检索命中（M1：给 AI 用的结构化卡片，比摘要信息密度高、带可过滤字段） */
export interface IndexSearchHit {
  id: number
  uid: number
  threadId: string
  subject: string
  fromName: string
  fromAddr: string
  dateTs: number
  card: string
  type: string | null
  course: string | null
  dueTs: number | null
  /** 命中来源：关键词 / 结构化过滤 */
  via: 'keyword' | 'filter'
}

/** 结构化过滤条件（由 shared/indexCard.ts 的 parseQueryIntent 产出） */
export interface IndexFilterQuery {
  type?: string
  course?: string
  dueAfter?: number
  dueBefore?: number
  hasDue?: boolean
}

/** 已生成摘要的检索命中（V2.1：AI 问答优先走摘要，省 token 且更稳） */
export interface SummarySearchHit {
  id: number
  uid: number
  threadId: string
  subject: string
  fromName: string
  fromAddr: string
  dateTs: number
  summary: string
}

export interface MessageStore {
  upsertMessages(msgs: IncomingMessage[]): Promise<void>
  query(params: QueryParams): Promise<MailListItem[]>
  search(term: string, limit?: number, opts?: { retrieval?: boolean; rankTerms?: WeightedTerm[] }): Promise<SearchHit[]>
  getMessage(id: number): Promise<MailDetail | null>
  getThread(threadId: string): Promise<MailDetail[]>
  /** 按文件夹读取同步状态（V2 M3；缺省 INBOX） */
  getSyncState(folder?: string): Promise<SyncStateRecord | null>
  setSyncState(state: SyncStateRecord): Promise<void>
  /** 该文件夹本地已入库的最大 UID（0 = 无）；用于「修复同步」把游标回退到本地实际进度 */
  getMaxUid(folder?: string): Promise<number>
  /** 该文件夹本地已入库的全部 UID（与服务端 UID SEARCH ALL 对账用） */
  listUids(folder?: string): Promise<number[]>
  /** 待 AI 总结的邮件（新→旧）：默认只返回「还没有摘要」的；force=true 时返回全部（重新生成） */
  listUnsummarized(limit: number, force?: boolean): Promise<MailListItem[]>
  /** 正文含 CSS/HTML 噪声的邮件（用于一次性清洗修复；V2.1） */
  listNoisyBodies(limit: number): Promise<{ id: number; bodyText: string; bodyHtml: string | null }[]>
  /** 覆盖正文与摘要片段（同步维护 FTS 索引；V2.1 清洗修复用） */
  updateBodyText(id: number, bodyText: string, snippet: string): Promise<void>
  /** 摘要检索（问题关键词命中摘要或主题/发件人；V2.1 AI 问答优先用摘要） */
  searchSummaries(term: string, limit: number): Promise<SummarySearchHit[]>
  /** 保存/覆盖某封邮件的检索索引卡片（同步维护 FTS） */
  saveIndexDoc(doc: {
    messageId: number
    card: string
    type: string | null
    course: string | null
    term: string | null
    dueTs: number | null
    entities: string[]
    aliases: string[]
    questions: string[]
    model: string
  }): Promise<void>
  /** 索引卡片关键词检索（FTS5 trigram + 短词 LIKE；rankTerms 用于相关度排序） */
  searchIndexDocs(term: string, limit: number, opts?: { rankTerms?: WeightedTerm[] }): Promise<IndexSearchHit[]>
  /** 索引卡片结构化过滤（类型/课程/截止窗口；集合视图，按截止时间列全，不做相关性重排） */
  searchIndexByFilter(filter: IndexFilterQuery, limit: number): Promise<IndexSearchHit[]>
  /** 有摘要但没有索引卡片的邮件数（批量重建时用） */
  countMissingIndexDocs(): Promise<number>
  /** 知识库集合列表（课程 / 类型，按数量倒序；已扣除用户手动移出的邮件） */
  listCollections(): Promise<CollectionSummary[]>
  /** 某个集合里的邮件（含卡片字段，按时间倒序） */
  listCollectionMails(kind: 'course' | 'type', value: string, limit?: number): Promise<CollectionMail[]>
  /** 把某封邮件移出某个集合（手动修正；集合本身不做硬分类） */
  excludeFromCollection(messageId: number, kind: 'course' | 'type', value: string): Promise<void>
  /** 撤销手动移出 */
  includeInCollection(messageId: number, kind: 'course' | 'type', value: string): Promise<void>
  /** 本周简报（聚合，不调模型） */
  weeklyBrief(fromTs: number, toTs: number): Promise<WeeklyBrief>
  /** 每个类别的邮件数（V2.2：侧边栏按类别筛选时显示数量） */
  listCategoryCounts(): Promise<Array<{ id: number; name: string; color: string; count: number }>>
  /** 彩色类别列表（V2.2） */
  listCategories(): Promise<Array<{ id: number; name: string; color: string }>>
  /** 新建类别（名字重复则返回已有项） */
  createCategory(name: string, color: string): Promise<{ id: number; name: string; color: string }>
  /** 重命名/改颜色 */
  updateCategory(id: number, patch: { name?: string; color?: string }): Promise<void>
  /** 删除类别（连带清除邮件上的引用） */
  deleteCategory(id: number): Promise<void>
  /** 给邮件设置类别（null = 清除） */
  setMailCategory(messageId: number, categoryId: number | null): Promise<void>
  /** 设置/取消红旗（V2.2） */
  setFlagged(id: number, flagged: boolean): Promise<void>
  /** 当前筛选条件下的邮件总数（与 query 同一套条件） */
  countMails(params: QueryParams): Promise<number>
  /** 写入某封邮件某来源的标签（覆盖该来源的旧值；rule/ai 会跳过用户手动删除过的标签） */
  saveMailTags(messageId: number, tags: string[], source: 'rule' | 'ai'): Promise<void>
  /** 手动给某封邮件加/去标签（source=manual，永不被自动重算覆盖；去掉自动标签会记入抑制表） */
  setMailTagManual(messageId: number, tag: string, on: boolean): Promise<void>
  /** 批量取标签（列表用；按 messageId 聚合） */
  getMailTags(messageIds: number[]): Promise<Map<number, string[]>>
  /** 各自动标签的邮件数（设置页/筛选用） */
  listTagCounts(): Promise<Array<{ tag: string; count: number; manual?: boolean }>>
  /** 日历：时间范围内可能有事件的邮件（含索引卡片，供上层解析日期） */
  listCalendarSources(from: number, to: number, limit?: number): Promise<CalendarSourceMail[]>
  /** 用现有索引卡片重算全部「规则标签」（A 方案；可随时重跑） */
  rebuildRuleTags(): Promise<number>
  /** 用户挑的示例邮件（给 AI 打标签当 few-shot 参考） */
  listTagExamples(): Promise<Array<{ id: number; subject: string; tags: string[] }>>
  /** 设置/覆盖某封邮件的示例标签（传空数组 = 取消该示例） */
  setTagExample(messageId: number, tags: string[]): Promise<void>
  /** 新建聊天会话，返回会话 id（AI 助手聊天式界面） */
  createChatSession(title: string): Promise<number>
  /** 会话列表（最近更新在前，带消息条数） */
  listChatSessions(limit?: number): Promise<ChatSession[]>
  /** 某会话的历史消息（时间升序） */
  getChatMessages(sessionId: number, limit?: number): Promise<ChatMessage[]>
  /** 追加一条消息（同时更新会话的 updated_at；首条用户消息用作标题） */
  appendChatMessage(
    sessionId: number,
    role: 'user' | 'assistant',
    content: string,
    citations?: ChatMessage['citations']
  ): Promise<number>
  /** 删除会话及其消息 */
  deleteChatSession(sessionId: number): Promise<void>
  /** 重命名会话（用户手动改标题） */
  renameChatSession(sessionId: number, title: string): Promise<void>
  getThreadIndex(): Promise<ThreadIndexEntry[]>
  count(): Promise<number>
  markRead(id: number, read: boolean): Promise<void>
  saveSummary(messageId: number, text: string, model: string): Promise<void>
  getSummary(messageId: number): Promise<SavedSummary | null>
  /** 附件 partId 回填（旧数据下载时按需补全，V2 M2） */
  setAttachmentPartId(messageId: number, filename: string, partId: string): Promise<void>
  /** 本地标签列表（V2 M4） */
  listLabels(): Promise<MailLabel[]>
  /** 新建标签；同名返回已有标签（幂等）。V2 M4 */
  createLabel(name: string, color?: string): Promise<MailLabel>
  /** 删除标签并解除所有邮件关联（V2 M4） */
  deleteLabel(id: number): Promise<void>
  /** 覆盖式设置邮件的标签集合（V2 M4） */
  setMailLabels(messageId: number, labelIds: number[]): Promise<void>
  /** 星标开关（V2 M4） */
  setStarred(messageId: number, starred: boolean): Promise<void>
  /** 已保存视图列表（V2 M5） */
  listViews(): Promise<SavedView[]>
  /** 保存视图（id 存在则覆盖），返回完整记录（V2 M5） */
  saveView(view: { id?: number; name: string; filter: ViewFilter; sort: ViewSort }): Promise<SavedView>
  /** 删除视图（V2 M5） */
  deleteView(id: number): Promise<void>
  /** 设置稍后提醒（覆盖未触发的旧提醒；V2 M6） */
  setSnooze(messageId: number, snoozeUntil: number, note?: string): Promise<void>
  /** 取消未触发的稍后提醒（V2 M6） */
  cancelSnooze(messageId: number): Promise<void>
  /** 到点未通知的提醒（含邮件主题/发件人，用于系统通知；V2 M6） */
  dueSnoozes(now: number): Promise<DueSnooze[]>
  /** 标记提醒已通知（V2 M6） */
  markSnoozeNotified(snoozeId: number): Promise<void>
  /** 批量标记已读/未读（只改本地；V2 M7） */
  bulkMarkRead(ids: number[], read: boolean): Promise<void>
  /** 批量加标签（并入现有标签，非覆盖；V2 M7） */
  bulkAddLabels(ids: number[], labelIds: number[]): Promise<void>
  /** 草稿列表（V2 M9，updated_at 倒序） */
  listDrafts(): Promise<MailDraft[]>
  /** 保存草稿（id 存在则覆盖），返回完整记录（V2 M9） */
  saveDraft(draft: { id?: number; toAddrs: string[]; subject: string; body: string }): Promise<MailDraft>
  /** 删除草稿（V2 M9） */
  deleteDraft(id: number): Promise<void>
  /** 记录一封已发送邮件（本地留存，便于「已发送」页展示与重试） */
  insertSentItem(item: { toAddrs: string[]; ccAddrs: string[]; subject: string; body: string; status: 'sent' | 'failed'; error?: string | null }): Promise<number>
  /** 已发送列表（时间倒序） */
  listSentItems(limit: number): Promise<SentItem[]>
  /** 删除一条已发送记录 */
  deleteSentItem(id: number): Promise<void>
  close(): void
}

/** 稍后提醒记录（V2 M6） */
export interface SnoozeRecord {
  id: number
  messageId: number
  snoozeUntil: number
  note: string | null
  createdAt: number
  notifiedAt: number | null
}

/** 到期提醒 + 通知所需邮件信息（V2 M6） */
export interface DueSnooze extends SnoozeRecord {
  subject: string
  fromName: string
}
