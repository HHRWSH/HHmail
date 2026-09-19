/**
 * 契约测试共用的 fake 实现（规范 §14.7）：
 * FakeMailProvider / InMemoryMessageStore / FakeHttpClient / FakeSafeStorage / FakeAiProvider。
 * 上层逻辑（sync/thread/AI 业务）只依赖接口，用这些 fake 验证"换实现不破坏行为"。
 */
import type { CalendarSourceMail } from '../../src/shared/calendar'
import type {
  AttachmentPayload,
  MailboxInfo,
  MailProvider,
  MailProviderCapabilities,
  OutgoingDraft,
  RawMessageBody,
  RawMessageMeta,
  unsupportedOperation as UnsupportedOperation
} from '../../src/main/mail/provider'
import { AppError, ErrorCodes } from '../../src/shared/error-codes'
import { deriveRuleTags } from '../../src/shared/tags'
import type { ChatMessage, ChatSession, CollectionMail, CollectionSummary, IncomingMessage, IndexFilterQuery, IndexSearchHit, MessageStore, QueryParams, SavedSummary, SearchHit, SummarySearchHit, SyncStateRecord, DueSnooze, WeeklyBrief } from '../../src/main/db/store'
import type { MailDetail, MailDraft, MailLabel, MailListItem, SavedView, SentItem, ViewFilter, ViewSort } from '../../src/shared/types'
import { filterMatches, sortMails } from '../../src/shared/views'
import type { ThreadIndexEntry } from '../../src/main/mail/thread'
import type { AccountRecord, AccountRepository, SafeStorageLike } from '../../src/main/auth/tokenStore'
import type { AiProvider, ChatParams } from '../../src/main/ai/provider'

export function unsupportedOperation(what: string): AppError {
  return new AppError(ErrorCodes.UNSUPPORTED_OPERATION, `${what} 当前版本不支持`)
}

export class FakeMailProvider implements MailProvider {
  readonly capabilities: MailProviderCapabilities = { readOnly: true, send: false, move: false }
  mailbox: MailboxInfo
  bodies = new Map<number, Buffer>()
  /** 模拟失败的 uid（fetchBody 抛错） */
  failUids = new Set<number>()
  fetchedUids: number[] = []
  connectCount = 0
  /** 其他文件夹的 mailbox 信息（V2 M3） */
  folderMailboxes = new Map<string, MailboxInfo>()
  openedFolders: string[] = []

  constructor(opts: { mailbox?: Partial<MailboxInfo>; bodies?: Map<number, Buffer> } = {}) {
    this.bodies = opts.bodies ?? new Map()
    const maxUid = this.bodies.size > 0 ? Math.max(...this.bodies.keys()) : 0
    this.mailbox = {
      uidValidity: opts.mailbox?.uidValidity ?? 7,
      exists: opts.mailbox?.exists ?? this.bodies.size,
      uidNext: opts.mailbox?.uidNext ?? maxUid + 1
    }
  }

  async connect(): Promise<void> {
    this.connectCount += 1
  }

  async openInboxReadOnly(): Promise<MailboxInfo> {
    return this.mailbox
  }

  async openFolderReadOnly(folderPath: string): Promise<MailboxInfo> {
    this.openedFolders.push(folderPath)
    if (folderPath === 'INBOX') return this.mailbox
    return (
      this.folderMailboxes.get(folderPath) ?? {
        uidValidity: 8,
        exists: 0,
        uidNext: 1
      }
    )
  }

  async listFolders(): Promise<{ name: string; path: string }[]> {
    return [
      { name: '收件箱', path: 'INBOX' },
      ...Array.from(this.folderMailboxes.keys(), (p) => ({ name: p, path: p }))
    ]
  }

  /** 权威 UID 列表（默认 = 内存里所有正文对应的 UID；测试可覆盖） */
  serverUidsOverride: number[] | null = null
  searchAllUidsFails = false

  async searchAllUids(_folder = 'INBOX'): Promise<number[]> {
    if (this.searchAllUidsFails) throw new Error('SEARCH not supported')
    if (this.serverUidsOverride) return [...this.serverUidsOverride].sort((a, b) => a - b)
    return [...this.bodies.keys()].sort((a, b) => a - b)
  }

  async *fetchEnvelopeRange(startUid: number, endUid: number): AsyncIterable<RawMessageMeta> {
    for (const uid of this.bodies.keys()) {
      if (uid >= startUid && uid <= endUid) yield { uid, envelope: { subject: `s${uid}` }, flags: [] }
    }
  }

  async fetchBody(uid: number): Promise<RawMessageBody | null> {
    this.fetchedUids.push(uid)
    if (this.failUids.has(uid)) throw new Error('fetch failed')
    const raw = this.bodies.get(uid)
    return raw ? { uid, raw } : null
  }

  async fetchAttachment(_uid: number, _partId: string): Promise<AttachmentPayload> {
    throw unsupportedOperation('附件下载')
  }

  async send(_draft: OutgoingDraft): Promise<void> {
    throw unsupportedOperation('发送邮件')
  }

  async move(_uid: number, _folder: string): Promise<void> {
    throw unsupportedOperation('移动/归档')
  }

  async close(): Promise<void> {}
}

/** 极简 EML 构造（供 fake provider + 真实 mailparser 组合用）。 */
export function buildSimpleEml(subject: string, body: string, from = 'A <a@example.edu>', opts: { messageId?: string; refs?: string } = {}): Buffer {
  const headers = [
    `From: ${from}`,
    'To: me@link.example.edu',
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'Date: Tue, 07 Oct 2025 08:00:00 +0800',
    'MIME-Version: 1.0'
  ]
  if (opts.messageId) headers.push(`Message-ID: ${opts.messageId}`)
  if (opts.refs) headers.push(`References: ${opts.refs}`)
  const lines = [
    ...headers,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64')
  ]
  return Buffer.from(lines.join('\r\n'), 'utf8')
}

export class InMemoryMessageStore implements MessageStore {
  messages = new Map<number, IncomingMessage>()
  syncStates = new Map<string, SyncStateRecord>()
  summaries = new Map<number, SavedSummary>()
  private nextId = 1
  private idByUid = new Map<number, number>()
  // V2 M4：标签 / 星标内存状态
  labelRecords: MailLabel[] = []
  private nextLabelId = 1
  private mailLabels = new Map<number, number[]>()
  private starred = new Set<number>()
  // V2 M5：视图内存状态
  viewRecords: SavedView[] = []
  private nextViewId = 1
  // V2 M6：稍后提醒内存状态（messageId → 未触发提醒）
  private snoozeRecords = new Map<number, { id: number; until: number; note: string | null; createdAt: number; notifiedAt: number | null }>()
  private nextSnoozeId = 1
  // V2 M9：草稿内存状态
  draftRecords: MailDraft[] = []
  private nextDraftId = 1

  async upsertMessages(msgs: IncomingMessage[]): Promise<void> {
    for (const m of msgs) {
      const existing = this.idByUid.get(m.uid)
      const id = existing ?? this.nextId++
      this.idByUid.set(m.uid, id)
      this.messages.set(id, { ...m })
    }
  }

  private toItem(m: IncomingMessage, id: number): MailListItem {
    return {
      id,
      uid: m.uid,
      threadId: m.threadId,
      subject: m.subject,
      fromName: m.fromName,
      fromAddr: m.fromAddr,
      dateTs: m.dateTs,
      dateLabel: '',
      snippet: m.snippet,
      unread: !m.flags.includes('\\Seen'),
      hasAttachments: m.attachments.length > 0,
      labels: (this.mailLabels.get(id) ?? []).map((lid) => this.labelRecords.find((l) => l.id === lid)!).filter(Boolean),
      starred: this.starred.has(id),
      snoozeUntil: (() => {
        const r = this.snoozeRecords.get(id)
        return r && r.notifiedAt === null ? r.until : null
      })(),
    }
  }

  async query(params: QueryParams): Promise<MailListItem[]> {
    // V2.2：彩色类别筛选（内存版）
    if (params.categoryId !== undefined) {
      const ids = new Set([...this.mailCategory.entries()].filter(([, c]) => c === params.categoryId).map(([m]) => m))
      return this.filteredByCategory(params, ids)
    }
    return this.queryInner(params)
  }

  private async filteredByCategory(params: QueryParams, ids: Set<number>): Promise<MailListItem[]> {
    const all = await this.queryInner({ ...params, limit: 100000, offset: 0 })
    const out = all.filter((m) => ids.has(m.id))
    return out.slice(params.offset, params.offset + params.limit)
  }

  private async queryInner(params: QueryParams): Promise<MailListItem[]> {
    const folder = params.folder ?? 'INBOX'
    const labelIds = params.labelIds ?? []
    let items = [...this.messages.entries()]
      .filter(([, m]) => (m.folder ?? 'INBOX') === folder)
      .map(([id, m]) => this.toItem(m, id))
      .filter((m) => {
        if (params.starredOnly && !this.starred.has(m.id)) return false
        if (labelIds.length > 0) {
          const ids = this.mailLabels.get(m.id) ?? []
          if (!labelIds.some((lid) => ids.includes(lid))) return false
        }
        // 视图过滤（V2 M5，与 sqlite 实现同语义）
        return filterMatches(m, params.filter)
      })
      .filter((m) => (params.unreadOnly ? m.unread : true))
    items = sortMails(items, params.sort)
    return items.slice(params.offset, params.offset + params.limit)
  }

  async search(term: string, limit = 50): Promise<SearchHit[]> {
    const t = term.toLowerCase()
    return [...this.messages.entries()]
      .filter(([, m]) => `${m.subject}${m.bodyText}${m.fromName}${m.fromAddr}`.toLowerCase().includes(t))
      .sort((a, b) => b[1].dateTs - a[1].dateTs)
      .slice(0, limit)
      .map(([id, m]) => ({ id, uid: m.uid, threadId: m.threadId, subject: m.subject, fromName: m.fromName, fromAddr: m.fromAddr, dateTs: m.dateTs, snippet: m.snippet }))
  }

  async getMessage(id: number): Promise<MailDetail | null> {
    const m = this.messages.get(id)
    if (!m) return null
    const summary = this.summaries.get(id) ?? null
    return {
      ...this.toItem(m, id),
      messageId: m.messageId ?? null,
      toAddrs: m.toAddrs,
      ccAddrs: m.ccAddrs,
      bodyText: m.bodyText,
      bodyHtml: m.bodyHtml,
      attachments: m.attachments.map((a, i) => ({
        id: i + 1,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        partId: a.partId ?? ''
      })),
      savedSummary: summary?.text ?? null,
      savedSummaryModel: summary?.model ?? null,
      savedSummaryAt: summary?.createdAtMs ?? null
    }
  }

  async getThread(threadId: string): Promise<MailDetail[]> {
    const out: MailDetail[] = []
    for (const [id, m] of this.messages) {
      if (m.threadId === threadId) {
        const d = await this.getMessage(id)
        if (d) out.push(d)
      }
    }
    return out.sort((a, b) => a.dateTs - b.dateTs)
  }

  async getSyncState(folder: string = 'INBOX'): Promise<SyncStateRecord | null> {
    return this.syncStates.get(folder) ?? null
  }

  async setSyncState(state: SyncStateRecord): Promise<void> {
    this.syncStates.set(state.folder ?? 'INBOX', state)
  }

  async getMaxUid(folder: string = 'INBOX'): Promise<number> {
    let max = 0
    for (const [, m] of this.messages) {
      if ((m.folder ?? 'INBOX') === folder && m.uid > max) max = m.uid
    }
    return max
  }

  async listUids(folder: string = 'INBOX'): Promise<number[]> {
    const uids: number[] = []
    for (const [, m] of this.messages) if ((m.folder ?? 'INBOX') === folder) uids.push(m.uid)
    return uids.sort((a, b) => a - b)
  }

  async listUnsummarized(limit: number, force = false): Promise<MailListItem[]> {
    const items: MailListItem[] = []
    for (const [id, m] of this.messages) {
      if (force || !this.summaries.has(id)) {
        items.push(this.toItem(m, id))
      }
    }
    return items.sort((a, b) => b.dateTs - a.dateTs).slice(0, limit)
  }

  async listNoisyBodies(limit: number): Promise<{ id: number; bodyText: string; bodyHtml: string | null }[]> {
    return [...this.messages.entries()]
      .filter(([, m]) => /[{}]|@media|!important|font-family/i.test(m.bodyText))
      .slice(0, limit)
      .map(([id, m]) => ({ id, bodyText: m.bodyText, bodyHtml: m.bodyHtml }))
  }

  async updateBodyText(id: number, bodyText: string, snippet: string): Promise<void> {
    const m = this.messages.get(id)
    if (!m) return
    this.messages.set(id, { ...m, bodyText, snippet })
  }

  async searchSummaries(term: string, limit: number): Promise<SummarySearchHit[]> {
    const t = term.trim().toLowerCase()
    if (!t) return []
    const out: SummarySearchHit[] = []
    for (const [id, summary] of this.summaries) {
      const m = this.messages.get(id)
      if (!m) continue
      const hay = `${summary.text}
${m.subject}
${m.fromName}
${m.fromAddr}`.toLowerCase()
      if (hay.includes(t)) {
        out.push({
          id,
          uid: m.uid,
          threadId: m.threadId,
          subject: m.subject,
          fromName: m.fromName,
          fromAddr: m.fromAddr,
          dateTs: m.dateTs,
          summary: summary.text
        })
      }
    }
    return out.sort((a, b) => b.dateTs - a.dateTs).slice(0, limit)
  }

  async getThreadIndex(): Promise<ThreadIndexEntry[]> {
    const out: ThreadIndexEntry[] = []
    for (const [, m] of this.messages) {
      out.push({ messageId: m.messageId, threadId: m.threadId, subject: m.subject, fromAddr: m.fromAddr, dateTs: m.dateTs })
    }
    return out.sort((a, b) => b.dateTs - a.dateTs)
  }

  async count(): Promise<number> {
    return this.messages.size
  }

  async markRead(id: number, read: boolean): Promise<void> {
    const m = this.messages.get(id)
    if (m) this.messages.set(id, { ...m, flags: read ? [...m.flags, '\\Seen'] : m.flags })
  }

  async saveSummary(messageId: number, text: string, model: string): Promise<void> {
    this.summaries.set(messageId, { text, model, createdAtMs: Date.now() })
  }

  async getSummary(messageId: number): Promise<SavedSummary | null> {
    return this.summaries.get(messageId) ?? null
  }

  async setAttachmentPartId(messageId: number, filename: string, partId: string): Promise<void> {
    const m = this.messages.get(messageId)
    if (!m) return
    const atts = m.attachments.map((a) => (a.filename === filename ? { ...a, partId } : a))
    this.messages.set(messageId, { ...m, attachments: atts })
  }

  // ---- V2 M4：标签 / 星标 ----

  async listLabels(): Promise<MailLabel[]> {
    return [...this.labelRecords]
  }

  async createLabel(name: string, color?: string): Promise<MailLabel> {
    const existing = this.labelRecords.find((l) => l.name === name)
    if (existing) return existing
    const palette = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#5e5ce6', '#64d2ff', '#bf5af2']
    const label: MailLabel = { id: this.nextLabelId++, name, color: color ?? palette[this.labelRecords.length % palette.length] }
    this.labelRecords.push(label)
    return label
  }

  async deleteLabel(id: number): Promise<void> {
    this.labelRecords = this.labelRecords.filter((l) => l.id !== id)
    for (const [mid, ids] of this.mailLabels) this.mailLabels.set(mid, ids.filter((x) => x !== id))
  }

  async setMailLabels(messageId: number, labelIds: number[]): Promise<void> {
    this.mailLabels.set(messageId, [...new Set(labelIds)])
  }

  async setStarred(messageId: number, starred: boolean): Promise<void> {
    if (starred) this.starred.add(messageId)
    else this.starred.delete(messageId)
  }

  // ---- V2 M5：自定义视图 ----

  async listViews(): Promise<SavedView[]> {
    return [...this.viewRecords]
  }

  async saveView(view: { id?: number; name: string; filter: ViewFilter; sort: ViewSort }): Promise<SavedView> {
    if (view.id !== undefined) {
      const idx = this.viewRecords.findIndex((v) => v.id === view.id)
      if (idx >= 0) {
        const updated: SavedView = { ...this.viewRecords[idx], name: view.name, filter: view.filter, sort: view.sort }
        this.viewRecords = this.viewRecords.map((v) => (v.id === view.id ? updated : v))
        return updated
      }
    }
    const record: SavedView = { id: this.nextViewId++, name: view.name, filter: view.filter, sort: view.sort, createdAt: Date.now() }
    this.viewRecords.push(record)
    return record
  }

  async deleteView(id: number): Promise<void> {
    this.viewRecords = this.viewRecords.filter((v) => v.id !== id)
  }

  // ---- V2 M6：稍后提醒 ----

  async setSnooze(messageId: number, snoozeUntil: number, note?: string): Promise<void> {
    this.snoozeRecords.set(messageId, { id: this.nextSnoozeId++, until: snoozeUntil, note: note ?? null, createdAt: Date.now(), notifiedAt: null })
  }

  async cancelSnooze(messageId: number): Promise<void> {
    this.snoozeRecords.delete(messageId)
  }

  async dueSnoozes(now: number): Promise<DueSnooze[]> {
    const out: DueSnooze[] = []
    for (const [messageId, r] of this.snoozeRecords) {
      if (r.until <= now && r.notifiedAt === null) {
        const m = this.messages.get(messageId)
        out.push({
          id: r.id,
          messageId,
          snoozeUntil: r.until,
          note: r.note,
          createdAt: r.createdAt,
          notifiedAt: r.notifiedAt,
          subject: m?.subject ?? '(无主题)',
          fromName: m?.fromName ?? ''
        })
      }
    }
    return out.sort((a, b) => a.snoozeUntil - b.snoozeUntil)
  }

  async markSnoozeNotified(snoozeId: number): Promise<void> {
    for (const [mid, r] of this.snoozeRecords) {
      if (r.id === snoozeId) this.snoozeRecords.set(mid, { ...r, notifiedAt: Date.now() })
    }
  }

  // ---- V2 M7：批量操作 ----

  async bulkMarkRead(ids: number[], read: boolean): Promise<void> {
    for (const id of ids) {
      const m = this.messages.get(id)
      if (m) this.messages.set(id, { ...m, flags: read ? [...m.flags, '\\Seen'] : m.flags })
    }
  }

  async bulkAddLabels(ids: number[], labelIds: number[]): Promise<void> {
    for (const id of ids) {
      const existing = this.mailLabels.get(id) ?? []
      this.mailLabels.set(id, [...new Set([...existing, ...labelIds])])
    }
  }

  // ---- V2 M9：草稿 ----

  async listDrafts(): Promise<MailDraft[]> {
    return [...this.draftRecords].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async saveDraft(draft: { id?: number; toAddrs: string[]; subject: string; body: string }): Promise<MailDraft> {
    const now = Date.now()
    if (draft.id !== undefined) {
      const idx = this.draftRecords.findIndex((d) => d.id === draft.id)
      if (idx >= 0) {
        const updated: MailDraft = { ...this.draftRecords[idx], toAddrs: [...draft.toAddrs], subject: draft.subject, body: draft.body, updatedAt: now }
        this.draftRecords = this.draftRecords.map((d) => (d.id === draft.id ? updated : d))
        return updated
      }
    }
    const record: MailDraft = { id: this.nextDraftId++, toAddrs: [...draft.toAddrs], subject: draft.subject, body: draft.body, createdAt: now, updatedAt: now }
    this.draftRecords.push(record)
    return record
  }

  /** M1：索引卡片（内存版，供契约测试） */
  indexDocs = new Map<number, { card: string; type: string | null; course: string | null; term: string | null; dueTs: number | null; entities: string[]; aliases: string[]; questions: string[]; model: string }>()

  async saveIndexDoc(doc: {
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
  }): Promise<void> {
    this.indexDocs.set(doc.messageId, { ...doc })
  }

  async searchIndexDocs(term: string, limit: number): Promise<IndexSearchHit[]> {
    const t = (term || '').trim().toLowerCase()
    if (!t) return []
    const out: IndexSearchHit[] = []
    for (const [id, doc] of this.indexDocs) {
      const hay = `${doc.card} ${doc.entities.join(' ')} ${doc.aliases.join(' ')} ${doc.questions.join(' ')}`.toLowerCase()
      if (hay.includes(t)) out.push(this.indexHit(id, doc, 'keyword'))
      if (out.length >= limit) break
    }
    return out
  }

  async searchIndexByFilter(
    filter: { type?: string; course?: string; dueAfter?: number; dueBefore?: number; hasDue?: boolean },
    limit: number
  ): Promise<IndexSearchHit[]> {
    const out: IndexSearchHit[] = []
    for (const [id, doc] of this.indexDocs) {
      if (filter.type && doc.type !== filter.type) continue
      if (filter.course && (doc.course ?? '').replace(/\s+/g, '').toUpperCase() !== filter.course.toUpperCase()) continue
      if (filter.hasDue && doc.dueTs === null) continue
      if (filter.dueAfter !== undefined && (doc.dueTs === null || doc.dueTs < filter.dueAfter)) continue
      if (filter.dueBefore !== undefined && (doc.dueTs === null || doc.dueTs > filter.dueBefore)) continue
      out.push(this.indexHit(id, doc, 'filter'))
      if (out.length >= limit) break
    }
    return out
  }

  /** M3：集合手动排除（内存版） */
  collectionExcludes = new Set<string>()

  async listCollections(): Promise<CollectionSummary[]> {
    const now = Date.now()
    const acc = new Map<string, CollectionSummary>()
    for (const [id, doc] of this.indexDocs) {
      const m = this.messages.get(id)
      for (const [kind, value] of [
        ['course', doc.course],
        ['type', doc.type]
      ] as Array<['course' | 'type', string | null]>) {
        if (!value) continue
        if (this.collectionExcludes.has(`${kind}|${value}|${id}`)) continue
        const key = `${kind}|${value}`
        const cur = acc.get(key) ?? { kind, value, count: 0, nextDue: null, lastAt: 0 }
        cur.count += 1
        if ((m?.dateTs ?? 0) > cur.lastAt) cur.lastAt = m?.dateTs ?? 0
        if (doc.dueTs !== null && doc.dueTs >= now && (cur.nextDue === null || doc.dueTs < cur.nextDue)) cur.nextDue = doc.dueTs
        acc.set(key, cur)
      }
    }
    return [...acc.values()].sort((a, b) => (a.kind === b.kind ? b.count - a.count : a.kind === 'course' ? -1 : 1))
  }

  async listCollectionMails(kind: 'course' | 'type', value: string, limit = 200): Promise<CollectionMail[]> {
    const out: CollectionMail[] = []
    for (const [id, doc] of this.indexDocs) {
      const match = kind === 'course' ? doc.course === value : doc.type === value
      if (!match) continue
      if (this.collectionExcludes.has(`${kind}|${value}|${id}`)) continue
      const m = this.messages.get(id)
      out.push({
        id,
        subject: m?.subject ?? '(无主题)',
        fromName: m?.fromName ?? '',
        fromAddr: m?.fromAddr ?? '',
        dateTs: m?.dateTs ?? 0,
        dueTs: doc.dueTs,
        type: doc.type,
        course: doc.course,
        entities: doc.entities,
        aliases: doc.aliases
      })
      if (out.length >= limit) break
    }
    return out.sort((a, b) => b.dateTs - a.dateTs)
  }

  async excludeFromCollection(messageId: number, kind: 'course' | 'type', value: string): Promise<void> {
    this.collectionExcludes.add(`${kind}|${value}|${messageId}`)
  }

  async includeInCollection(messageId: number, kind: 'course' | 'type', value: string): Promise<void> {
    this.collectionExcludes.delete(`${kind}|${value}|${messageId}`)
  }

  private flaggedIds = new Set<number>()
  private categories = new Map<number, { id: number; name: string; color: string }>()
  private mailCategory = new Map<number, number>()
  private categorySeq = 1

  async listCategories(): Promise<Array<{ id: number; name: string; color: string }>> {
    return [...this.categories.values()]
  }

  async listCategoryCounts(): Promise<Array<{ id: number; name: string; color: string; count: number }>> {
    return [...this.categories.values()].map((c) => ({
      ...c,
      count: [...this.mailCategory.values()].filter((cid) => cid === c.id).length
    }))
  }

  async createCategory(name: string, color: string): Promise<{ id: number; name: string; color: string }> {
    const existing = [...this.categories.values()].find((c) => c.name === name)
    if (existing) return existing
    const cat = { id: this.categorySeq++, name, color }
    this.categories.set(cat.id, cat)
    return cat
  }

  async updateCategory(id: number, patch: { name?: string; color?: string }): Promise<void> {
    const cur = this.categories.get(id)
    if (!cur) return
    this.categories.set(id, { ...cur, ...patch })
  }

  async deleteCategory(id: number): Promise<void> {
    this.categories.delete(id)
    for (const [mid, cid] of this.mailCategory) if (cid === id) this.mailCategory.delete(mid)
  }

  async setMailCategory(messageId: number, categoryId: number | null): Promise<void> {
    if (categoryId === null) this.mailCategory.delete(messageId)
    else this.mailCategory.set(messageId, categoryId)
  }

  async setFlagged(id: number, flagged: boolean): Promise<void> {
    if (flagged) this.flaggedIds.add(id)
    else this.flaggedIds.delete(id)
  }

  async countMails(params: QueryParams): Promise<number> {
    return (await this.query({ ...params, limit: 100000, offset: 0 })).length
  }

  // ---- 自动标签（V2.2）：内存版 ----
  private mailTags = new Map<string, string[]>() // key = `${source}:${messageId}`
  private tagExamples = new Map<number, string[]>()

  async saveMailTags(messageId: number, tags: string[], source: 'rule' | 'ai'): Promise<void> {
    const suppressed = this.suppressed.get(messageId) ?? new Set<string>()
    this.mailTags.set(
      `${source}:${messageId}`,
      [...tags].filter((t) => !suppressed.has(t))
    )
  }

  private suppressed = new Map<number, Set<string>>()

  async setMailTagManual(messageId: number, tag: string, on: boolean): Promise<void> {
    const clean = String(tag ?? '').trim().slice(0, 12)
    if (!clean) return
    const manual = this.mailTags.get(`manual:${messageId}`) ?? []
    if (on) {
      this.suppressed.get(messageId)?.delete(clean)
      if (!manual.includes(clean)) this.mailTags.set(`manual:${messageId}`, [...manual, clean])
    } else {
      this.mailTags.set(`manual:${messageId}`, manual.filter((t) => t !== clean))
      this.mailTags.set(`rule:${messageId}`, (this.mailTags.get(`rule:${messageId}`) ?? []).filter((t) => t !== clean))
      this.mailTags.set(`ai:${messageId}`, (this.mailTags.get(`ai:${messageId}`) ?? []).filter((t) => t !== clean))
      const set = this.suppressed.get(messageId) ?? new Set<string>()
      set.add(clean)
      this.suppressed.set(messageId, set)
    }
  }

  async getMailTags(messageIds: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>()
    for (const id of messageIds) {
      const merged = [...(this.mailTags.get(`rule:${id}`) ?? []), ...(this.mailTags.get(`ai:${id}`) ?? [])]
      if (merged.length > 0) out.set(id, merged)
    }
    return out
  }

  /** 日历：内存实现——只按 due 时间命中（卡片正文里的日期由 sqlite 实现提供） */
  async listCalendarSources(from: number, to: number): Promise<CalendarSourceMail[]> {
    const out: CalendarSourceMail[] = []
    for (const [id, m] of this.messages) {
      const due = (m as unknown as { dueTs?: number | null }).dueTs ?? null
      if (due && due >= from && due <= to) {
        out.push({
          messageId: id,
          subject: m.subject,
          fromName: m.fromName ?? null,
          dateTs: m.dateTs,
          type: null,
          course: null,
          dueTs: due,
          card: null
        })
      }
    }
    return out.sort((a, b) => (a.dueTs ?? 0) - (b.dueTs ?? 0))
  }

  async listTagCounts(): Promise<Array<{ tag: string; count: number; manual?: boolean }>> {
    const counts = new Map<string, Set<number>>()
    for (const [key, tags] of this.mailTags) {
      const id = Number(key.split(':')[1])
      for (const t of tags) {
        const set = counts.get(t) ?? new Set<number>()
        set.add(id)
        counts.set(t, set)
      }
    }
    return [...counts.entries()]
      .map(([tag, set]) => ({ tag, count: set.size }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  async rebuildRuleTags(): Promise<number> {
    let n = 0
    for (const [id, doc] of this.indexDocs) {
      await this.saveMailTags(id, deriveRuleTags({ type: doc.type, course: doc.course, dueTs: doc.dueTs, entities: doc.entities }), 'rule')
      n += 1
    }
    return n
  }

  async listTagExamples(): Promise<Array<{ id: number; subject: string; tags: string[] }>> {
    return [...this.tagExamples.entries()].map(([id, tags]) => ({
      id,
      subject: this.messages.get(id)?.subject ?? '(无主题)',
      tags
    }))
  }

  async setTagExample(messageId: number, tags: string[]): Promise<void> {
    if (tags.length === 0) this.tagExamples.delete(messageId)
    else this.tagExamples.set(messageId, [...tags])
  }

  async weeklyBrief(fromTs: number, toTs: number): Promise<WeeklyBrief> {
    const inRange = [...this.messages.entries()].filter(([, m]) => m.dateTs >= fromTs && m.dateTs <= toTs)
    const byTypeMap = new Map<string, number>()
    const courseMap = new Map<string, number>()
    const dueItems: WeeklyBrief['dueItems'] = []
    let missingCards = 0
    for (const [id, m] of inRange) {
      const doc = this.indexDocs.get(id)
      if (!doc?.type) missingCards += 1
      if (doc?.type) byTypeMap.set(doc.type, (byTypeMap.get(doc.type) ?? 0) + 1)
      if (doc?.course) courseMap.set(doc.course, (courseMap.get(doc.course) ?? 0) + 1)
      if (doc?.dueTs !== null && doc?.dueTs !== undefined && doc.dueTs >= fromTs && doc.dueTs <= toTs) {
        dueItems.push({ id, subject: m.subject, dueTs: doc.dueTs, course: doc.course })
      }
    }
    dueItems.sort((a, b) => a.dueTs - b.dueTs)
    return {
      fromTs,
      toTs,
      newMails: inRange.length,
      dueItems,
      byType: [...byTypeMap.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      courses: [...courseMap.entries()].map(([course, count]) => ({ course, count })).sort((a, b) => b.count - a.count),
      missingCards
    }
  }

  /** AI 助手聊天（内存版） */
  chatSessions: ChatSession[] = []
  chatMessages: ChatMessage[] = []
  private nextChatSessionId = 1
  private nextChatMessageId = 1

  async createChatSession(title: string): Promise<number> {
    const id = this.nextChatSessionId++
    const now = Date.now()
    this.chatSessions.unshift({ id, title: title.slice(0, 60) || '新对话', createdAt: now, updatedAt: now, messageCount: 0 })
    return id
  }

  async listChatSessions(limit = 100): Promise<ChatSession[]> {
    return this.chatSessions
      .map((s) => ({ ...s, messageCount: this.chatMessages.filter((m) => m.sessionId === s.id).length }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
  }

  async getChatMessages(sessionId: number, limit = 200): Promise<ChatMessage[]> {
    return this.chatMessages.filter((m) => m.sessionId === sessionId).slice(0, limit)
  }

  async appendChatMessage(
    sessionId: number,
    role: 'user' | 'assistant',
    content: string,
    citations: ChatMessage['citations'] = []
  ): Promise<number> {
    const id = this.nextChatMessageId++
    const now = Date.now()
    this.chatMessages.push({ id, sessionId, role, content, citations: citations ?? [], createdAt: now })
    const session = this.chatSessions.find((s) => s.id === sessionId)
    if (session) {
      session.updatedAt = now
      const count = this.chatMessages.filter((m) => m.sessionId === sessionId).length
      if (role === 'user' && count === 1) session.title = content.replace(/\s+/g, ' ').slice(0, 40) || '新对话'
    }
    return id
  }

  async deleteChatSession(sessionId: number): Promise<void> {
    this.chatSessions = this.chatSessions.filter((s) => s.id !== sessionId)
    this.chatMessages = this.chatMessages.filter((m) => m.sessionId !== sessionId)
  }

  async renameChatSession(sessionId: number, title: string): Promise<void> {
    const session = this.chatSessions.find((s) => s.id === sessionId)
    if (session) session.title = title.slice(0, 60) || '新对话'
  }

  async countMissingIndexDocs(): Promise<number> {
    let n = 0
    for (const id of this.messages.keys()) if (!this.indexDocs.has(id)) n += 1
    return n
  }

  private indexHit(
    id: number,
    doc: { card: string; type: string | null; course: string | null; dueTs: number | null },
    via: 'keyword' | 'filter'
  ): IndexSearchHit {
    const m = this.messages.get(id)
    return {
      id,
      uid: m?.uid ?? 0,
      threadId: m?.threadId ?? `t-${id}`,
      subject: m?.subject ?? '(无主题)',
      fromName: m?.fromName ?? '',
      fromAddr: m?.fromAddr ?? '',
      dateTs: m?.dateTs ?? 0,
      card: doc.card,
      type: doc.type,
      course: doc.course,
      dueTs: doc.dueTs,
      via
    }
  }

  sentItems: SentItem[] = []
  private nextSentId = 1

  async insertSentItem(item: {
    toAddrs: string[]
    ccAddrs: string[]
    subject: string
    body: string
    status: 'sent' | 'failed'
    error?: string | null
  }): Promise<number> {
    const id = this.nextSentId++
    this.sentItems.unshift({
      id,
      toAddrs: [...item.toAddrs],
      ccAddrs: [...item.ccAddrs],
      subject: item.subject,
      body: item.body,
      sentAt: Date.now(),
      status: item.status,
      error: item.error ?? null
    })
    return id
  }

  async listSentItems(limit = 200): Promise<SentItem[]> {
    return this.sentItems.slice(0, limit)
  }

  async deleteSentItem(id: number): Promise<void> {
    this.sentItems = this.sentItems.filter((s) => s.id !== id)
  }

  async deleteDraft(id: number): Promise<void> {
    this.draftRecords = this.draftRecords.filter((d) => d.id !== id)
  }

  close(): void {}
}

export class FakeHttpClient {
  /** 按调用顺序返回的响应/异常 */
  responses: (unknown | Error)[] = []
  calls: { url: string; params: Record<string, string> }[] = []

  queueResponse(r: unknown): this {
    this.responses.push(r)
    return this
  }

  queueError(e: Error): this {
    this.responses.push(e)
    return this
  }

  async postForm(url: string, params: Record<string, string>): Promise<unknown> {
    this.calls.push({ url, params })
    const next = this.responses.shift()
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('FakeHttpClient: no scripted response')
    return next
  }
}

export function oauthErrorResponse(code: string): Error {
  const err = new Error(`Request failed with status code 400: ${code}`) as Error & { response?: { data?: { error?: string } } }
  err.response = { data: { error: code } }
  return err
}

export class FakeSafeStorage implements SafeStorageLike {
  available = true
  encrypted: Buffer[] = []
  private map = new Map<string, string>()

  isEncryptionAvailable(): boolean {
    return this.available
  }

  encryptString(plain: string): Buffer {
    const buf = Buffer.from(`enc:${plain}`, 'utf8')
    this.encrypted.push(buf)
    return buf
  }

  decryptString(encrypted: Buffer): string {
    const s = encrypted.toString('utf8')
    if (!s.startsWith('enc:')) throw new Error('decrypt failed: corrupted data')
    return s.slice(4)
  }
}

export class FakeAccountRepository implements AccountRepository {
  record: AccountRecord | null = null

  async getAccount(): Promise<AccountRecord | null> {
    return this.record
  }

  async upsertAccount(record: AccountRecord): Promise<void> {
    this.record = record
  }

  async clearAccount(): Promise<void> {
    this.record = null
  }
}

export class FakeAiProvider implements AiProvider {
  calls: ChatParams[] = []
  reply = '（fake）摘要'
  /** 按顺序消费的回复队列（优先于 reply） */
  queue: string[] = []
  private model = 'fake-model'

  complete(params: ChatParams): Promise<string> {
    this.calls.push(params)
    const text = this.queue.length > 0 ? this.queue.shift()! : this.reply
    return Promise.resolve(text)
  }

  modelName(): string {
    return this.model
  }
}
