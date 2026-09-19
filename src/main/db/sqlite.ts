/**
 * SqliteMessageStore —— MessageStore 的 better-sqlite3 实现（better-sqlite3 的唯一落点）。
 * 同步 API 包成 Promise，满足接口契约；FTS + LIKE 兜底；迁移只增不改。
 */
import Database from 'better-sqlite3'
import type { MailDetail, MailDraft, MailLabel, MailListItem, SavedView, SentItem, ViewFilter, ViewSort } from '../../shared/types'
import type {
  ChatMessage,
  ChatSession,
  CollectionMail,
  CollectionSummary,
  IndexFilterQuery,
  IndexSearchHit,
  WeeklyBrief
} from './store'
import { formatRelativeDate } from '../../shared/format'
import { deriveRuleTags } from '../../shared/tags'
import type { Logger } from '../logger'
import type { IncomingMessage, MessageStore, QueryParams, SavedSummary, SearchHit, SummarySearchHit, SyncStateRecord, DueSnooze } from './store'
import { currentVersion, migrate, readSyncState } from './schema'
import { buildFtsQuery, buildFtsQueryFromTokens, buildLikePattern, buildLikePatternsFromTokens, mergeSearchHits, extractRetrievalTokens, expandRetrievalTokens } from './search'
import { rankByTerms } from '../../shared/retrievalRank'
import type { WeightedTerm } from '../../shared/retrievalQuery'
import type { ThreadIndexEntry } from '../mail/thread'
import type { CalendarSourceMail } from '../../shared/calendar'

const ACCOUNT_ID = 1 // MVP 单账户

interface MessageRow {
  id: number
  uid: number
  message_id: string | null
  thread_id: string | null
  subject: string | null
  from_name: string | null
  from_addr: string | null
  to_addrs: string | null
  cc_addrs: string | null
  date_hdr?: string | null
  date_ts: number | null
  /** 列表查询不返回正文（性能）；详情/摘要路径才需要 */
  body_text?: string | null
  body_html?: string | null
  snippet: string | null
  is_read: number
  flags_json: string | null
  has_attachments: number
  starred: number
  flagged?: number
  snooze_until: number | null
}

interface AttachmentRow {
  id: number
  filename: string | null
  content_type: string | null
  size: number | null
  part_id: string | null
}

function parseAddrList(json: string | null): string[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rowToList(row: MessageRow): MailListItem {
  return {
    id: row.id,
    uid: row.uid,
    threadId: row.thread_id ?? `t-${row.uid}`,
    subject: row.subject ?? '(无主题)',
    fromName: row.from_name ?? '',
    fromAddr: row.from_addr ?? '',
    dateTs: row.date_ts ?? 0,
    dateLabel: formatRelativeDate(row.date_ts ?? 0),
    snippet: row.snippet ?? '',
    unread: row.is_read === 0,
    hasAttachments: row.has_attachments > 0,
    labels: [],
    starred: (row.starred ?? 0) === 1,
    flagged: (row.flagged ?? 0) === 1,
    snoozeUntil: row.snooze_until ?? null,
  }
}

/** 容错解析 JSON 数组列（历史数据可能为空串/非法 JSON）。 */
function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
  } catch {
    return []
  }
}

/**
 * 聊天消息的引用邮件（对象数组）。
 * 注意：不能用 safeJsonArray —— 它会把每个元素 String() 化（"[object Object]"），再 parse 必然失败，
 * 导致从 SQLite 读回的引用永远为空（真机表现：切回历史会话后引用卡片消失）。
 */
function parseCitations(raw: string | null | undefined): ChatMessage['citations'] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({
        id: Number(c.id) || 0,
        subject: String(c.subject ?? ''),
        fromName: String(c.fromName ?? ''),
        dateTs: Number(c.dateTs) || 0
      }))
      .filter((c) => c.id > 0)
  } catch {
    return []
  }
}

interface IndexRow {
  id: number
  uid: number
  thread_id: string | null
  subject: string | null
  from_name: string | null
  from_addr: string | null
  date_ts: number | null
  card: string
  type: string | null
  course: string | null
  due_ts: number | null
}

function indexRowToHit(r: IndexRow, via: 'keyword' | 'filter'): IndexSearchHit {
  return {
    id: r.id,
    uid: r.uid,
    threadId: r.thread_id ?? `t-${r.uid}`,
    subject: r.subject ?? '(无主题)',
    fromName: r.from_name ?? '',
    fromAddr: r.from_addr ?? '',
    dateTs: r.date_ts ?? 0,
    card: r.card,
    type: r.type,
    course: r.course,
    dueTs: r.due_ts,
    via
  }
}

/** FTS5 MATCH 查询串：把用户问题拆成词并加引号，避免特殊字符导致语法错误。 */
function ftsQuery(term: string): string {
  const words = term
    .split(/[\s,，。？?！!、；;：:()（）\[\]"']+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
  if (words.length === 0) return `"${term.replace(/"/g, '""')}"`
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ')
}

/** 分块（SQLite IN(...) 的占位符有上限，且 1000 个占位符会让查询明显变慢） */
const ID_CHUNK_SIZE = 400
function chunkIds(ids: number[]): number[][] {
  const out: number[][] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) out.push(ids.slice(i, i + ID_CHUNK_SIZE))
  return out
}

/** 把检索串拆成候选词（索引卡片用）：按空白/标点切分，保留 ≥2 字符的词。 */
function indexQueryWords(term: string): string[] {
  const words = String(term ?? '')
    .split(/[\s,，。？?！!、；;：:()（）\[\]"'/|]+/)
    .map((w) => w.trim())
    .filter((w) => [...w].length >= 2)
  return [...new Set(words)]
}

export class SqliteMessageStore implements MessageStore {
  private db: Database.Database
  private logger?: Logger

  constructor(dbPath: string, logger?: Logger) {
    this.logger = logger
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    const before = currentVersion(this.db)
    const version = migrate(this.db)
    this.logger?.info('db.migrated', { size: version })
    // V2.2：v17 把正文搬出 messages 后会留下上百 MB 的空洞（真机库 127MB 里 107MB 是 HTML 正文）。
    // 一次性 VACUUM 把空间真正还给磁盘：文件变小 → 之后所有查询的 I/O 都更快。
    if (before > 0 && before < 17) {
      try {
        const t0 = Date.now()
        this.db.exec('VACUUM')
        this.logger?.info('db.vacuum', { from: before, to: version, ms: Date.now() - t0 })
      } catch (e) {
        this.logger?.warn('db.vacuum_failed', { message: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  /** 批量回填列表项的 labels（V2 M4；避免 N+1，单条 getMessage 也走这里） */
  private attachLabels(items: MailListItem[]): void {
    if (items.length === 0) return
    const rows: { messageId: number; id: number; name: string; color: string }[] = []
    // V2.2 性能：分块查询 —— 列表一次要 1000 封，1000 个占位符既慢又可能超过 SQLite 变量上限
    for (const chunk of chunkIds(items.map((i) => i.id))) {
      const placeholders = chunk.map(() => '?').join(',')
      rows.push(
        ...(this.db
          .prepare(
            `SELECT ml.message_id AS messageId, l.id AS id, l.name AS name, l.color AS color
             FROM message_labels ml
             JOIN labels l ON l.id = ml.label_id
             WHERE ml.message_id IN (${placeholders})
             ORDER BY l.id`
          )
          .all(...chunk) as { messageId: number; id: number; name: string; color: string }[])
      )
    }
    const byId = new Map<number, MailLabel[]>()
    for (const r of rows) {
      const arr = byId.get(r.messageId) ?? []
      arr.push({ id: r.id, name: r.name, color: r.color })
      byId.set(r.messageId, arr)
    }
    for (const item of items) {
      item.labels = byId.get(item.id) ?? []
    }
  }

  /** 批量回填自动标签（V2.2；与 attachLabels 同样的「一次查询避免 N+1」做法） */
  /** 回填彩色类别（V2.2；与标签一样分块查询，避免 N+1） */
  private attachCategories(items: MailListItem[]): void {
    if (items.length === 0) return
    const byId = new Map<number, { id: number; name: string; color: string }>()
    for (const c of this.db.prepare('SELECT id, name, color FROM categories').all() as {
      id: number
      name: string
      color: string
    }[]) {
      byId.set(c.id, c)
    }
    for (const chunk of chunkIds(items.map((i) => i.id))) {
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db
        .prepare(`SELECT message_id AS messageId, category_id AS categoryId FROM message_category WHERE message_id IN (${placeholders})`)
        .all(...chunk) as { messageId: number; categoryId: number }[]
      const map = new Map(rows.map((r) => [r.messageId, r.categoryId]))
      for (const item of items) {
        const cid = map.get(item.id)
        item.category = cid !== undefined ? (byId.get(cid) ?? null) : null
      }
    }
  }

  private attachAutoTags(items: MailListItem[]): void {
    if (items.length === 0) return
    const rows: { messageId: number; tag: string; source: string }[] = []
    // 同样分块（见 attachLabels 的说明）
    for (const chunk of chunkIds(items.map((i) => i.id))) {
      const placeholders = chunk.map(() => '?').join(',')
      rows.push(
        ...(this.db
          .prepare(
            `SELECT message_id AS messageId, tag, source FROM mail_tags
             WHERE message_id IN (${placeholders})
             ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'ai' THEN 1 ELSE 2 END, rowid`
          )
          .all(...chunk) as { messageId: number; tag: string; source: string }[])
      )
    }
    const byId = new Map<number, string[]>()
    const manualById = new Map<number, string[]>()
    for (const r of rows) {
      const arr = byId.get(r.messageId) ?? []
      if (!arr.includes(r.tag)) arr.push(r.tag)
      byId.set(r.messageId, arr)
      if (r.source === 'manual') {
        const m = manualById.get(r.messageId) ?? []
        m.push(r.tag)
        manualById.set(r.messageId, m)
      }
    }
    for (const item of items) {
      item.autoTags = byId.get(item.id) ?? []
      item.manualTags = manualById.get(item.id) ?? []
    }
  }

  async upsertMessages(msgs: IncomingMessage[]): Promise<void> {
    if (msgs.length === 0) return
    // V2.2：正文不再写进 messages（那会让每行几十上百 KB，列表查询被迫读大页）。
    // 正文单独进 message_bodies，按需读取；messages 只留小字段 + snippet。
    const insertMsg = this.db.prepare(`
      INSERT INTO messages (account_id, uid, message_id, thread_id, subject, from_name, from_addr,
        to_addrs, cc_addrs, date_hdr, date_ts, snippet, is_read, flags_json, created_at, folder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, folder, uid) DO UPDATE SET
        message_id=excluded.message_id, thread_id=excluded.thread_id, subject=excluded.subject,
        from_name=excluded.from_name, from_addr=excluded.from_addr, to_addrs=excluded.to_addrs,
        cc_addrs=excluded.cc_addrs, date_hdr=excluded.date_hdr, date_ts=excluded.date_ts,
        snippet=excluded.snippet, flags_json=excluded.flags_json
    `)
    const upsertBody = this.db.prepare(`
      INSERT INTO message_bodies (message_id, body_text, body_html) VALUES (?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET body_text=excluded.body_text, body_html=excluded.body_html
    `)
    const delAtt = this.db.prepare('DELETE FROM attachments WHERE message_id = ?')
    const insAtt = this.db.prepare(`
      INSERT INTO attachments (message_id, part_id, filename, content_type, size)
      VALUES (?, ?, ?, ?, ?)
    `)
    // FTS5 外部内容表（content='messages'）删除必须用 'delete' 命令；
    // 只有"更新已有行"才需要先删旧索引（对未索引 rowid 执行会损坏库），用旧行值发起 delete。
    // 同时取回旧行 id：UPSERT 冲突更新路径下 lastInsertRowid 不可靠（并发同步曾导致附件写错行）。
    const selPrev = this.db.prepare(
      `SELECT m.id, m.subject, m.from_name, m.from_addr, b.body_text
       FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
       WHERE m.account_id = ? AND m.folder = ? AND m.uid = ?`
    )
    const delFts = this.db.prepare(
      `INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_addr, body_text)
       VALUES('delete', ?, ?, ?, ?, ?)`
    )
    const insFts = this.db.prepare(`
      INSERT INTO messages_fts (rowid, subject, from_name, from_addr, body_text)
      VALUES (?, ?, ?, ?, ?)
    `)
    const now = Date.now()

    const tx = this.db.transaction(() => {
      for (const m of msgs) {
        const folder = m.folder ?? 'INBOX'
        const prev = selPrev.get(ACCOUNT_ID, folder, m.uid) as { id: number; subject: string | null; from_name: string | null; from_addr: string | null; body_text: string | null } | undefined
        const info = insertMsg.run(
          ACCOUNT_ID,
          m.uid,
          m.messageId,
          m.threadId,
          m.subject,
          m.fromName,
          m.fromAddr,
          JSON.stringify(m.toAddrs),
          JSON.stringify(m.ccAddrs),
          m.dateHdr,
          m.dateTs,
          m.snippet,
          0,
          JSON.stringify(m.flags),
          now,
          folder
        )
        const rowId = prev ? prev.id : Number(info.lastInsertRowid)
        upsertBody.run(rowId, m.bodyText, m.bodyHtml)
        delAtt.run(rowId)
        for (const a of m.attachments) {
          insAtt.run(rowId, a.partId, a.filename, a.contentType, a.size)
        }
        if (prev) delFts.run(rowId, prev.subject, prev.from_name, prev.from_addr, prev.body_text)
        insFts.run(rowId, m.subject, m.fromName, m.fromAddr, m.bodyText)
      }
    })
    tx()
  }

  /** 组装列表/计数共用的 WHERE（V2.2：计数与列表必须用同一套条件，否则数字对不上） */
  private buildListWhere(params: QueryParams): { where: string; bind: (string | number)[] } {
    const folder = params.folder ?? 'INBOX'
    const labelIds = params.labelIds ?? []
    const where: string[] = ['m.folder = ?', '(? = 0 OR m.is_read = 0)']
    const bind: (string | number)[] = [folder, params.unreadOnly ? 1 : 0]
    if (labelIds.length > 0) {
      where.push(`EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id IN (${labelIds.map(() => '?').join(',')}))`)
      bind.push(...labelIds)
    }
    if (params.starredOnly) where.push('m.starred = 1')
    if (params.flaggedOnly) where.push('m.flagged = 1')
    if (params.categoryId !== undefined) {
      where.push('EXISTS (SELECT 1 FROM message_category mc WHERE mc.message_id = m.id AND mc.category_id = ?)')
      bind.push(params.categoryId)
    }
    if (params.autoTags && params.autoTags.length > 0) {
      where.push(
        `EXISTS (SELECT 1 FROM mail_tags t WHERE t.message_id = m.id AND t.tag IN (${params.autoTags
          .map(() => '?')
          .join(',')}))`
      )
      bind.push(...params.autoTags)
    }
    // 视图过滤（V2 M5，与 shared/views.ts filterMatches 同语义）
    const f = params.filter
    if (f) {
      if (f.from) {
        where.push('(m.from_name LIKE ? OR m.from_addr LIKE ?)')
        bind.push(`%${f.from}%`, `%${f.from}%`)
      }
      if (f.unread) where.push('m.is_read = 0')
      if (f.hasAttachment) where.push('EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)')
      if (f.labelIds && f.labelIds.length > 0) {
        where.push(`EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id IN (${f.labelIds.map(() => '?').join(',')}))`)
        bind.push(...f.labelIds)
      }
      if (f.dateFrom !== undefined) {
        where.push('m.date_ts >= ?')
        bind.push(f.dateFrom)
      }
      if (f.dateTo !== undefined) {
        where.push('m.date_ts <= ?')
        bind.push(f.dateTo)
      }
      if (f.text) {
        where.push(
          `(m.subject LIKE ? OR m.from_name LIKE ? OR m.from_addr LIKE ?
            OR EXISTS (SELECT 1 FROM message_bodies b WHERE b.message_id = m.id AND b.body_text LIKE ?))`
        )
        bind.push(`%${f.text}%`, `%${f.text}%`, `%${f.text}%`, `%${f.text}%`)
      }
    }
    return { where: where.join(' AND '), bind }
  }

  // ---- 彩色类别（V2.2） ----

  async listCategories(): Promise<Array<{ id: number; name: string; color: string }>> {
    return this.db
      .prepare('SELECT id, name, color FROM categories ORDER BY sort_order, id')
      .all() as Array<{ id: number; name: string; color: string }>
  }

  async listCategoryCounts(): Promise<Array<{ id: number; name: string; color: string; count: number }>> {
    return this.db
      .prepare(
        `SELECT c.id, c.name, c.color, COUNT(mc.message_id) AS count
         FROM categories c
         LEFT JOIN message_category mc ON mc.category_id = c.id
         GROUP BY c.id ORDER BY c.sort_order, c.id`
      )
      .all() as Array<{ id: number; name: string; color: string; count: number }>
  }

  async createCategory(name: string, color: string): Promise<{ id: number; name: string; color: string }> {
    const clean = String(name ?? '').trim().slice(0, 30)
    if (!clean) throw new Error('类别名称不能为空')
    const existing = this.db.prepare('SELECT id, name, color FROM categories WHERE name = ?').get(clean) as
      | { id: number; name: string; color: string }
      | undefined
    if (existing) return existing
    const max = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories').get() as { m: number }
    const info = this.db
      .prepare('INSERT INTO categories (name, color, sort_order, created_at) VALUES (?, ?, ?, ?)')
      .run(clean, color, max.m + 1, Date.now())
    return { id: Number(info.lastInsertRowid), name: clean, color }
  }

  async updateCategory(id: number, patch: { name?: string; color?: string }): Promise<void> {
    if (patch.name !== undefined) {
      this.db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(String(patch.name).trim().slice(0, 30), id)
    }
    if (patch.color !== undefined) {
      this.db.prepare('UPDATE categories SET color = ? WHERE id = ?').run(String(patch.color).slice(0, 20), id)
    }
  }

  async deleteCategory(id: number): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM message_category WHERE category_id = ?').run(id)
      this.db.prepare('DELETE FROM categories WHERE id = ?').run(id)
    })
    tx()
  }

  async setMailCategory(messageId: number, categoryId: number | null): Promise<void> {
    if (categoryId === null) {
      this.db.prepare('DELETE FROM message_category WHERE message_id = ?').run(messageId)
      return
    }
    this.db
      .prepare(
        `INSERT INTO message_category (message_id, category_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET category_id = excluded.category_id, created_at = excluded.created_at`
      )
      .run(messageId, categoryId, Date.now())
  }

  async setFlagged(id: number, flagged: boolean): Promise<void> {
    this.db.prepare('UPDATE messages SET flagged = ? WHERE id = ?').run(flagged ? 1 : 0, id)
  }

  async countMails(params: QueryParams): Promise<number> {
    const { where, bind } = this.buildListWhere(params)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${where}`)
      .get(...bind) as { n: number } | undefined
    return row?.n ?? 0
  }

  async query(params: QueryParams): Promise<MailListItem[]> {
    const limit = params.limit
    const offset = params.offset
    const { where, bind } = this.buildListWhere(params)
    const sort = params.sort
    let orderBy = 'm.date_ts DESC, m.uid DESC'
    if (sort) {
      const col = sort.by === 'from' ? 'm.from_name' : sort.by === 'subject' ? 'm.subject' : 'm.date_ts'
      const dir = sort.dir === 'asc' ? 'ASC' : 'DESC'
      orderBy = `${col} COLLATE NOCASE ${dir}, m.date_ts DESC`
    }
    // V2.2 性能：**不要** `SELECT m.*` —— 列表用不到 body_html/body_text（单封可达 10MB），
    // 读了就是几十 MB 的磁盘 I/O 与内存分配。只取列表真正要用的列。
    const rows = this.db
      .prepare(
        `SELECT
          m.id, m.uid, m.thread_id, m.subject, m.from_name, m.from_addr, m.date_ts, m.snippet,
          m.is_read, m.starred, m.flagged, m.folder,
          (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
          (SELECT snooze_until FROM snoozes s WHERE s.message_id = m.id AND s.notified_at IS NULL) AS snooze_until
         FROM messages m
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`
      )
      .all(...bind, limit, offset) as MessageRow[]
    const list = rows.map(rowToList)
    this.attachLabels(list)
    this.attachAutoTags(list)
    this.attachCategories(list)
    return list
  }

  async search(
    term: string,
    limit = 50,
    opts: { retrieval?: boolean; rankTerms?: WeightedTerm[] } = {}
  ): Promise<SearchHit[]> {
    // retrieval=true（AI 问答）：去疑问词 + 长中文滑窗 + OR 召回，
    // 因为自然语言问句整句丢给 trigram FTS 几乎不可能命中（会被 AND 成一个超长短语）。
    const retrievalTokens = opts.retrieval ? expandRetrievalTokens(extractRetrievalTokens(term)) : []
    const ftsQuery = opts.retrieval ? buildFtsQueryFromTokens(retrievalTokens, 'or') : buildFtsQuery(term)
    const like = buildLikePattern(term)
    const likePatterns = opts.retrieval ? buildLikePatternsFromTokens(retrievalTokens.length ? retrievalTokens : [term]) : []

    let ftsHits: SearchHit[] = []
    if (ftsQuery) {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.uid, m.thread_id, m.subject, m.from_name, m.from_addr, m.date_ts, m.snippet
           FROM messages_fts f
           JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ?
           ORDER BY m.date_ts DESC
           LIMIT ?`
        )
        .all(ftsQuery, limit) as (MessageRow & { rowid?: number })[]
      ftsHits = rows.map((r) => ({
        id: r.id,
        uid: r.uid,
        threadId: r.thread_id ?? `t-${r.uid}`,
        subject: r.subject ?? '(无主题)',
        fromName: r.from_name ?? '',
        fromAddr: r.from_addr ?? '',
        dateTs: r.date_ts ?? 0,
        snippet: r.snippet ?? ''
      }))
    }

    const likeRows = (
      likePatterns.length > 0
        ? this.db
            .prepare(
              `SELECT id, uid, thread_id, subject, from_name, from_addr, date_ts, snippet
               FROM messages
               WHERE ${likePatterns
                 .map(
                   () =>
                     `(subject LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\'
                       OR EXISTS (SELECT 1 FROM message_bodies b WHERE b.message_id = messages.id AND b.body_text LIKE ? ESCAPE '\\'))`
                 )
                 .join(' OR ')}
               ORDER BY date_ts DESC
               LIMIT ?`
            )
            .all(...likePatterns.flatMap((p) => [p, p, p, p]), limit)
        : this.db
            .prepare(
              `SELECT id, uid, thread_id, subject, from_name, from_addr, date_ts, snippet
               FROM messages
               WHERE subject LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\'
                  OR from_addr LIKE ? ESCAPE '\\'
                  OR EXISTS (SELECT 1 FROM message_bodies b WHERE b.message_id = messages.id AND b.body_text LIKE ? ESCAPE '\\')
               ORDER BY date_ts DESC
               LIMIT ?`
            )
            .all(like, like, like, like, limit)
    ) as MessageRow[]

    const likeHits: SearchHit[] = likeRows.map((r) => ({
      id: r.id,
      uid: r.uid,
      threadId: r.thread_id ?? `t-${r.uid}`,
      subject: r.subject ?? '(无主题)',
      fromName: r.from_name ?? '',
      fromAddr: r.from_addr ?? '',
      dateTs: r.date_ts ?? 0,
      snippet: r.snippet ?? ''
    }))

    const merged = mergeSearchHits(ftsHits, likeHits)
    // 相关性排序（「第一条就命中」）：主题命中 > 正文命中，命中词越多越靠前；同分保持时间倒序
    const ranked =
      opts.retrieval && opts.rankTerms && opts.rankTerms.length > 0
        ? rankByTerms(
            merged.map((h) => ({ ...h, body: h.snippet })),
            opts.rankTerms
          )
        : merged
    return ranked.slice(0, limit)
  }

  async getMessage(id: number): Promise<MailDetail | null> {
    // 正文按需 JOIN（详情/转发/摘要才需要），列表查询不碰这张表
    const row = this.db
      .prepare(
        `SELECT m.*, b.body_text, b.body_html,
          (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
          (SELECT snooze_until FROM snoozes s WHERE s.message_id = m.id AND s.notified_at IS NULL) AS snooze_until
         FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
         WHERE m.id = ?`
      )
      .get(id) as MessageRow | undefined
    if (!row) return null
    const atts = this.db.prepare('SELECT id, filename, content_type, size, part_id FROM attachments WHERE message_id = ? ORDER BY id').all(id) as AttachmentRow[]
    const summary = this.db
      .prepare('SELECT summary_text, model, created_at FROM mail_summaries WHERE message_id = ?')
      .get(id) as { summary_text: string; model: string; created_at: number } | undefined
    const list = rowToList(row)
    this.attachLabels([list])
    this.attachAutoTags([list])
    this.attachCategories([list])
    return {
      ...list,
      messageId: row.message_id ?? null,
      toAddrs: parseAddrList(row.to_addrs),
      ccAddrs: parseAddrList(row.cc_addrs),
      bodyText: row.body_text ?? '',
      bodyHtml: row.body_html ?? null,
      attachments: atts.map((a) => ({
        id: a.id,
        filename: a.filename ?? 'attachment',
        contentType: a.content_type ?? 'application/octet-stream',
        size: a.size ?? 0,
        partId: a.part_id ?? ''
      })),
      savedSummary: summary?.summary_text ?? null,
      savedSummaryModel: summary?.model ?? null,
      savedSummaryAt: summary?.created_at ?? null
    }
  }

  async getThread(threadId: string): Promise<MailDetail[]> {
    // V2.2 性能：这里只需要 id（正文由 getMessage 按需 JOIN），别再 SELECT m.* 把整串正文读出来
    const rows = this.db
      .prepare('SELECT id FROM messages WHERE thread_id = ? ORDER BY date_ts ASC, uid ASC')
      .all(threadId) as { id: number }[]
    const out: MailDetail[] = []
    for (const row of rows) {
      const detail = await this.getMessage(row.id)
      if (detail) out.push(detail)
    }
    return out
  }

  async getSyncState(folder: string = 'INBOX'): Promise<SyncStateRecord | null> {
    const row = this.db
      .prepare('SELECT uid_validity, last_uid, full_history FROM sync_state WHERE account_id = ? AND folder = ?')
      .get(ACCOUNT_ID, folder) as { uid_validity: number; last_uid: number; full_history: number } | undefined
    if (!row) return null
    return { ...readSyncState(row)!, folder }
  }

  async setSyncState(state: SyncStateRecord): Promise<void> {
    const folder = state.folder ?? 'INBOX'
    this.db
      .prepare(
        `INSERT INTO sync_state (account_id, folder, uid_validity, last_uid, full_history) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, folder) DO UPDATE SET uid_validity=excluded.uid_validity, last_uid=excluded.last_uid,
           full_history=excluded.full_history`
      )
      .run(ACCOUNT_ID, folder, state.uidValidity, state.lastUid, state.fullHistory ? 1 : 0)
  }

  async getMaxUid(folder: string = 'INBOX'): Promise<number> {
    const row = this.db
      .prepare('SELECT MAX(uid) AS m FROM messages WHERE account_id = ? AND folder = ?')
      .get(ACCOUNT_ID, folder) as { m: number | null }
    return row.m ?? 0
  }

  async listUids(folder: string = 'INBOX'): Promise<number[]> {
    const rows = this.db
      .prepare('SELECT uid FROM messages WHERE account_id = ? AND folder = ? ORDER BY uid ASC')
      .all(ACCOUNT_ID, folder) as { uid: number }[]
    return rows.map((r) => r.uid)
  }

  async listUnsummarized(limit: number, force = false): Promise<MailListItem[]> {
    const rows = this.db
      .prepare(
        `SELECT m.*, b.body_text, b.body_html,
          (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
          (SELECT snooze_until FROM snoozes s WHERE s.message_id = m.id AND s.notified_at IS NULL) AS snooze_until
         FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
         LEFT JOIN mail_summaries s ON s.message_id = m.id
         LEFT JOIN mail_index_docs d ON d.message_id = m.id
         -- M1 双产物：给人读的摘要（mail_summaries）或给 AI 检索的索引卡片（mail_index_docs）
         -- 任一缺失都算「待生成」，这样批量重建能把老数据补齐
         WHERE (? = 1 OR s.message_id IS NULL OR d.message_id IS NULL) AND m.folder = 'INBOX'
         ORDER BY m.date_ts DESC
         LIMIT ?`
      )
      .all(force ? 1 : 0, limit) as MessageRow[]
    const list = rows.map(rowToList)
    this.attachLabels(list)
    return list
  }

  async listNoisyBodies(limit: number): Promise<{ id: number; bodyText: string; bodyHtml: string | null }[]> {
    // 粗略筛选：正文里出现 CSS/HTML 特征的邮件（真机回归：HTML 邮件的 text 部分混入 <style>）
    const rows = this.db
      .prepare(
        `SELECT m.id, b.body_text, b.body_html FROM messages m
         JOIN message_bodies b ON b.message_id = m.id
         WHERE (b.body_text LIKE '%{%' OR b.body_text LIKE '%<%' OR b.body_text LIKE '%@media%'
                OR b.body_text LIKE '%!important%' OR b.body_text LIKE '%font-family%'
                OR b.body_text LIKE '%&%;%')
         ORDER BY m.date_ts DESC
         LIMIT ?`
      )
      .all(limit) as { id: number; body_text: string | null; body_html: string | null }[]
    return rows.map((r) => ({ id: r.id, bodyText: r.body_text ?? '', bodyHtml: r.body_html }))
  }

  async updateBodyText(id: number, bodyText: string, snippet: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const prev = this.db
        .prepare(
          `SELECT m.subject, m.from_name, m.from_addr, b.body_text
           FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id WHERE m.id = ?`
        )
        .get(id) as { subject: string | null; from_name: string | null; from_addr: string | null; body_text: string | null } | undefined
      if (!prev) return
      this.db
        .prepare(
          `INSERT INTO message_bodies (message_id, body_text, body_html) VALUES (?, ?, NULL)
           ON CONFLICT(message_id) DO UPDATE SET body_text = excluded.body_text`
        )
        .run(id, bodyText)
      this.db.prepare('UPDATE messages SET snippet = ? WHERE id = ?').run(snippet, id)
      // FTS 外部内容表：先按旧值 delete 再插入新值（顺序不能反，否则索引损坏）
      this.db
        .prepare(
          `INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_addr, body_text)
           VALUES('delete', ?, ?, ?, ?, ?)`
        )
        .run(id, prev.subject, prev.from_name, prev.from_addr, prev.body_text)
      this.db
        .prepare('INSERT INTO messages_fts(rowid, subject, from_name, from_addr, body_text) VALUES(?, ?, ?, ?, ?)')
        .run(id, prev.subject, prev.from_name, prev.from_addr, bodyText)
    })
    tx()
  }

  async searchSummaries(term: string, limit: number): Promise<SummarySearchHit[]> {
    // M1 修复：自然语言问句不能整句 LIKE（几乎永远匹配不上）→
    // 拆成「去掉疑问词的检索词」逐个 OR 召回（命中词越多，日期越新越靠前）。
    const tokens = extractRetrievalTokens(term).slice(0, 8)
    if (tokens.length === 0) return []
    const clause =
      "(s.summary_text LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\' OR m.from_addr LIKE ? ESCAPE '\\')"
    const where = tokens.map(() => clause).join(' OR ')
    const bind: unknown[] = []
    for (const t of tokens) {
      const like = buildLikePattern(t)
      bind.push(like, like, like, like)
    }
    bind.push(limit)
    const rows = this.db
      .prepare(
        `SELECT m.id, m.uid, m.thread_id, m.subject, m.from_name, m.from_addr, m.date_ts, s.summary_text
         FROM mail_summaries s
         JOIN messages m ON m.id = s.message_id
         WHERE ${where}
         ORDER BY m.date_ts DESC
         LIMIT ?`
      )
      .all(...bind) as {
      id: number
      uid: number
      thread_id: string | null
      subject: string | null
      from_name: string | null
      from_addr: string | null
      date_ts: number | null
      summary_text: string
    }[]
    return rows.map((r) => ({
      id: r.id,
      uid: r.uid,
      threadId: r.thread_id ?? `t-${r.uid}`,
      subject: r.subject ?? '(无主题)',
      fromName: r.from_name ?? '',
      fromAddr: r.from_addr ?? '',
      dateTs: r.date_ts ?? 0,
      summary: r.summary_text
    }))
  }

  // ---- M1：检索索引卡片（给 AI 用；与人读摘要分开存） ----

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
    const entities = JSON.stringify(doc.entities)
    const aliases = JSON.stringify(doc.aliases)
    const questions = JSON.stringify(doc.questions)
    const now = Date.now()
    const tx = this.db.transaction(() => {
      // FTS 外部内容表：更新已有行必须先按旧值发 delete 命令（否则索引残留脏数据）
      const prev = this.db
        .prepare('SELECT card, entities, aliases, questions FROM mail_index_docs WHERE message_id = ?')
        .get(doc.messageId) as { card: string; entities: string; aliases: string; questions: string } | undefined
      if (prev) {
        this.db
          .prepare(
            `INSERT INTO mail_index_fts(mail_index_fts, rowid, card, entities, aliases, questions)
             VALUES('delete', ?, ?, ?, ?, ?)`
          )
          .run(doc.messageId, prev.card, prev.entities, prev.aliases, prev.questions)
      }
      this.db
        .prepare(
          `INSERT INTO mail_index_docs (message_id, card, type, course, term, due_ts, entities, aliases, questions, model, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(message_id) DO UPDATE SET
             card=excluded.card, type=excluded.type, course=excluded.course, term=excluded.term,
             due_ts=excluded.due_ts, entities=excluded.entities, aliases=excluded.aliases,
             questions=excluded.questions, model=excluded.model, updated_at=excluded.updated_at`
        )
        .run(
          doc.messageId,
          doc.card,
          doc.type,
          doc.course,
          doc.term,
          doc.dueTs,
          entities,
          aliases,
          questions,
          doc.model,
          now
        )
      this.db
        .prepare('INSERT INTO mail_index_fts(rowid, card, entities, aliases, questions) VALUES (?, ?, ?, ?, ?)')
        .run(doc.messageId, doc.card, entities, aliases, questions)
    })
    tx()
  }

  /**
   * 索引卡片关键词检索（M1；M4 起支持排序词与短词 LIKE）。
   *
   * 两条召回合并，再按检索词相关性排序（用户要求「第一条就命中」）：
   *   ① FTS5 trigram（≥3 字符的词，OR 召回，bm25 只是初排）；
   *   ② LIKE 兜底（≥2 字符的词）——中文 2 字词（学费/宿舍/讲座）trigram 命中不了，
   *      而主题里的词（如「住宿申請」）也不在 FTS 列（FTS 只索引卡片字段），所以这里连带 m.subject 一起 LIKE。
   */
  async searchIndexDocs(
    term: string,
    limit: number,
    opts: { rankTerms?: WeightedTerm[] } = {}
  ): Promise<IndexSearchHit[]> {
    const trimmed = (term || '').trim()
    if (!trimmed) return []
    const words = indexQueryWords(trimmed)
    const ftsWords = words.filter((w) => [...w].length >= 3)
    const likeWords = words.filter((w) => [...w].length >= 2).slice(0, 12)
    const overFetch = Math.max(limit * 3, 30)
    const rows: IndexRow[] = []
    const seen = new Set<number>()
    if (ftsWords.length > 0) {
      const ftsRows = this.db
        .prepare(
          `SELECT m.id, m.uid, m.thread_id, m.subject, m.from_name, m.from_addr, m.date_ts,
                  d.card, d.type, d.course, d.due_ts
           FROM mail_index_fts f
           JOIN mail_index_docs d ON d.message_id = f.rowid
           JOIN messages m ON m.id = d.message_id
           WHERE mail_index_fts MATCH ?
           ORDER BY bm25(mail_index_fts), m.date_ts DESC
           LIMIT ?`
        )
        .all(ftsWords.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR '), overFetch) as IndexRow[]
      for (const r of ftsRows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        rows.push(r)
      }
    }
    if (likeWords.length > 0 && rows.length < overFetch) {
      const likeRows = this.db
        .prepare(
          `SELECT m.id, m.uid, m.thread_id, m.subject, m.from_name, m.from_addr, m.date_ts,
                  d.card, d.type, d.course, d.due_ts
           FROM mail_index_docs d
           JOIN messages m ON m.id = d.message_id
           WHERE ${likeWords.map(() => "(m.subject LIKE ? ESCAPE '\\' OR d.card LIKE ? ESCAPE '\\')").join(' OR ')}
           ORDER BY m.date_ts DESC
           LIMIT ?`
        )
        .all(
          ...likeWords.flatMap((w) => {
            const p = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
            return [p, p]
          }),
          overFetch
        ) as IndexRow[]
      for (const r of likeRows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        rows.push(r)
      }
    }
    const hits: Array<IndexSearchHit & { body: string }> = rows.map((r) => ({ ...indexRowToHit(r, 'keyword'), body: r.card }))
    if (opts.rankTerms && opts.rankTerms.length > 0) {
      return rankByTerms(hits, opts.rankTerms, { idf: this.indexRarity(opts.rankTerms) }).slice(0, limit)
    }
    return hits.slice(0, limit)
  }

  /**
   * 全库词稀有度（IDF, 自然对数）：`ln(1 + N/(1+df))`。
   * 用全库而不是候选池统计——候选池会被同义词查询带偏（问「学费」时一堆缴费邮件进池，看起来"学费"很常见）；
   * 「course / program / notification」这类全库高频词拿到低权重，具体词（工作坊 / 圖書館 / Blackboard）才有分量。
   */
  private indexRarity(terms: WeightedTerm[]): Map<string, number> {
    const total =
      ((this.db.prepare('SELECT COUNT(*) AS n FROM mail_index_docs').get() as { n: number } | undefined)?.n ?? 0) || 1
    const stmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM mail_index_docs d
       JOIN messages m ON m.id = d.message_id
       WHERE m.subject LIKE ? ESCAPE '\\' OR d.card LIKE ? ESCAPE '\\'`
    )
    const out = new Map<string, number>()
    for (const t of terms.slice(0, 16)) {
      const p = `%${t.term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      const df = (stmt.get(p, p) as { n: number } | undefined)?.n ?? 0
      out.set(t.term, Math.log(1 + total / (1 + df)))
    }
    return out
  }

  /**
   * 结构化过滤（类型/课程/截止窗口）。
   *
   * 这里**故意不做相关性重排**：过滤路代表「集合视图」（这周有什么截止 / 有哪些活动 / 某课程的截止清单），
   * 用户要的是按时间列全，重排会把窗口内的条目挤出前 N（真机实测：活动集合覆盖率 76% → 40%）。
   * 「相关的那封排第一」交给关键词路（跨语言 + 短词 LIKE + IDF 排序）。
   */
  async searchIndexByFilter(filter: IndexFilterQuery, limit: number): Promise<IndexSearchHit[]> {
    const where: string[] = []
    const bind: unknown[] = []
    if (filter.type) {
      where.push('d.type = ?')
      bind.push(filter.type)
    }
    if (filter.course) {
      where.push("UPPER(REPLACE(d.course, ' ', '')) = ?")
      bind.push(filter.course.toUpperCase())
    }
    if (filter.hasDue) where.push('d.due_ts IS NOT NULL')
    if (filter.dueAfter !== undefined) {
      where.push('d.due_ts >= ?')
      bind.push(filter.dueAfter)
    }
    if (filter.dueBefore !== undefined) {
      where.push('d.due_ts <= ?')
      bind.push(filter.dueBefore)
    }
    if (where.length === 0) return []
    const now = Date.now()
    bind.push(now, now, limit)
    const rows = this.db
      .prepare(
        `SELECT m.id, m.uid, m.thread_id, m.subject, m.from_name, m.from_addr, m.date_ts,
                d.card, d.type, d.course, d.due_ts
         FROM mail_index_docs d
         JOIN messages m ON m.id = d.message_id
         WHERE ${where.join(' AND ')}
         -- 排序：未来最近的优先（"这周有什么截止"最该先看到临近的），
         -- 其次是已经过去的，最后是没有截止时间的；避免老邮件把新邮件挤出前几名（真机教训）
         ORDER BY
           CASE WHEN d.due_ts IS NULL THEN 2 WHEN d.due_ts >= ? THEN 0 ELSE 1 END,
           ABS(d.due_ts - ?),
           m.date_ts DESC
         LIMIT ?`
      )
      .all(...bind) as IndexRow[]
    return rows.map((r) => indexRowToHit(r, 'filter'))
  }

  async countMissingIndexDocs(): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         LEFT JOIN mail_index_docs d ON d.message_id = m.id
         WHERE m.folder = 'INBOX' AND d.message_id IS NULL`
      )
      .get() as { n: number }
    return row.n
  }

  // ---- M3 知识库：集合（由索引卡片派生）+ 周报 ----

  /** 用户手动移出的记录（kind|value|messageId → 排除集合） */
  private excludedKeys(): Set<string> {
    const rows = this.db
      .prepare("SELECT message_id, kind, value FROM collection_overrides WHERE action = 'exclude'")
      .all() as { message_id: number; kind: string; value: string }[]
    return new Set(rows.map((r) => `${r.kind}|${r.value}|${r.message_id}`))
  }

  async listCollections(): Promise<CollectionSummary[]> {
    const excluded = this.excludedKeys()
    const out: CollectionSummary[] = []
    const push = (kind: 'course' | 'type', value: string, count: number, nextDue: number | null, lastAt: number): void => {
      if (count > 0) out.push({ kind, value, count, nextDue, lastAt })
    }
    const now = Date.now()
    const group = (kind: 'course' | 'type', col: 'course' | 'type'): void => {
      const rows = this.db
        .prepare(
          `SELECT d.${col} AS v, m.id AS id, m.date_ts AS date_ts, d.due_ts AS due_ts
           FROM mail_index_docs d JOIN messages m ON m.id = d.message_id
           WHERE d.${col} IS NOT NULL AND d.${col} <> ''
           ORDER BY m.date_ts DESC`
        )
        .all() as { v: string; id: number; date_ts: number; due_ts: number | null }[]
      const acc = new Map<string, { count: number; nextDue: number | null; lastAt: number }>()
      for (const r of rows) {
        if (excluded.has(`${kind}|${r.v}|${r.id}`)) continue
        const cur = acc.get(r.v) ?? { count: 0, nextDue: null, lastAt: 0 }
        cur.count += 1
        if (r.date_ts > cur.lastAt) cur.lastAt = r.date_ts
        if (r.due_ts !== null && r.due_ts >= now && (cur.nextDue === null || r.due_ts < cur.nextDue)) cur.nextDue = r.due_ts
        acc.set(r.v, cur)
      }
      for (const [value, v] of acc) push(kind, value, v.count, v.nextDue, v.lastAt)
    }
    group('course', 'course')
    group('type', 'type')
    // 课程在前（更具体），同组内按「最近截止优先 → 数量」
    return out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'course' ? -1 : 1
      if (a.nextDue !== b.nextDue) {
        if (a.nextDue === null) return 1
        if (b.nextDue === null) return -1
        return a.nextDue - b.nextDue
      }
      return b.count - a.count
    })
  }

  async listCollectionMails(kind: 'course' | 'type', value: string, limit = 200): Promise<CollectionMail[]> {
    const excluded = this.excludedKeys()
    const col = kind === 'course' ? 'course' : 'type'
    const rows = this.db
      .prepare(
        `SELECT m.id, m.subject, m.from_name, m.from_addr, m.date_ts, d.due_ts, d.type, d.course, d.entities, d.aliases
         FROM mail_index_docs d JOIN messages m ON m.id = d.message_id
         WHERE d.${col} = ?
         ORDER BY m.date_ts DESC
         LIMIT ?`
      )
      .all(value, limit) as {
      id: number
      subject: string | null
      from_name: string | null
      from_addr: string | null
      date_ts: number | null
      due_ts: number | null
      type: string | null
      course: string | null
      entities: string
      aliases: string
    }[]
    return rows
      .filter((r) => !excluded.has(`${kind}|${value}|${r.id}`))
      .map((r) => ({
        id: r.id,
        subject: r.subject ?? '(无主题)',
        fromName: r.from_name ?? '',
        fromAddr: r.from_addr ?? '',
        dateTs: r.date_ts ?? 0,
        dueTs: r.due_ts,
        type: r.type,
        course: r.course,
        entities: safeJsonArray(r.entities),
        aliases: safeJsonArray(r.aliases)
      }))
  }

  async excludeFromCollection(messageId: number, kind: 'course' | 'type', value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO collection_overrides (message_id, kind, value, action, created_at) VALUES (?, ?, ?, 'exclude', ?)
         ON CONFLICT(message_id, kind, value) DO UPDATE SET action = 'exclude', created_at = excluded.created_at`
      )
      .run(messageId, kind, value, Date.now())
  }

  async includeInCollection(messageId: number, kind: 'course' | 'type', value: string): Promise<void> {
    this.db.prepare('DELETE FROM collection_overrides WHERE message_id = ? AND kind = ? AND value = ?').run(messageId, kind, value)
  }

  async weeklyBrief(fromTs: number, toTs: number): Promise<WeeklyBrief> {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.subject, m.date_ts, d.type, d.course, d.due_ts
         FROM messages m LEFT JOIN mail_index_docs d ON d.message_id = m.id
         WHERE m.folder = 'INBOX' AND m.date_ts >= ? AND m.date_ts <= ?
         ORDER BY m.date_ts DESC`
      )
      .all(fromTs, toTs) as {
      id: number
      subject: string | null
      date_ts: number
      type: string | null
      course: string | null
      due_ts: number | null
    }[]

    const byTypeMap = new Map<string, number>()
    const courseMap = new Map<string, number>()
    const dueItems: WeeklyBrief['dueItems'] = []
    let missingCards = 0
    for (const r of rows) {
      if (r.type) byTypeMap.set(r.type, (byTypeMap.get(r.type) ?? 0) + 1)
      else missingCards += 1
      if (r.course) courseMap.set(r.course, (courseMap.get(r.course) ?? 0) + 1)
      // 截止时间：本封邮件自身的截止落在本周内（含尚未过期的）
      if (r.due_ts !== null && r.due_ts >= fromTs && r.due_ts <= toTs) {
        dueItems.push({ id: r.id, subject: r.subject ?? '(无主题)', dueTs: r.due_ts, course: r.course })
      }
    }
    dueItems.sort((a, b) => a.dueTs - b.dueTs)
    const toSorted = (m: Map<string, number>): Array<{ count: number } & Record<string, unknown>> =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => (k.match(/^[A-Z]/) ? { course: k, count: v } : { type: k, count: v }))
    const byType = toSorted(byTypeMap) as Array<{ type: string; count: number }>
    const courses = toSorted(courseMap) as Array<{ course: string; count: number }>
    return { fromTs, toTs, newMails: rows.length, dueItems, byType, courses, missingCards }
  }

  // ---- 自动标签（V2.2：A 规则映射 + B AI 主题标签 + 示例邮件） ----

  async saveMailTags(messageId: number, tags: string[], source: 'rule' | 'ai'): Promise<void> {
    const now = Date.now()
    // 用户手动删掉过的自动标签不再加回来（抑制表）
    const suppressed = new Set(
      (
        this.db.prepare('SELECT tag FROM tag_suppressed WHERE message_id = ?').all(messageId) as { tag: string }[]
      ).map((r) => r.tag)
    )
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM mail_tags WHERE message_id = ? AND source = ?').run(messageId, source)
      const ins = this.db.prepare(
        'INSERT OR IGNORE INTO mail_tags (message_id, tag, source, created_at) VALUES (?, ?, ?, ?)'
      )
      for (const raw of tags) {
        const tag = String(raw ?? '').trim().slice(0, 12)
        if (tag && !suppressed.has(tag)) ins.run(messageId, tag, source, now)
      }
    })
    tx()
  }

  /**
   * 手动加/去标签（V2.2 统一标签体系）：
   *   - 加上 → 写入 source='manual'，并清掉同名抑制记录（手动加回来就别再拦）；
   *   - 去掉 → 删除所有来源的同名标签，并记一条抑制（否则规则/AI 重算会把它加回来）。
   */
  async setMailTagManual(messageId: number, tag: string, on: boolean): Promise<void> {
    const clean = String(tag ?? '').trim().slice(0, 12)
    if (!clean) return
    const now = Date.now()
    const tx = this.db.transaction(() => {
      if (on) {
        this.db.prepare('DELETE FROM tag_suppressed WHERE message_id = ? AND tag = ?').run(messageId, clean)
        this.db
          .prepare('INSERT OR IGNORE INTO mail_tags (message_id, tag, source, created_at) VALUES (?, ?, ?, ?)')
          .run(messageId, clean, 'manual', now)
      } else {
        this.db.prepare('DELETE FROM mail_tags WHERE message_id = ? AND tag = ?').run(messageId, clean)
        this.db
          .prepare('INSERT OR REPLACE INTO tag_suppressed (message_id, tag, created_at) VALUES (?, ?, ?)')
          .run(messageId, clean, now)
      }
    })
    tx()
  }

  async getMailTags(messageIds: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>()
    if (messageIds.length === 0) return out
    const placeholders = messageIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT message_id AS messageId, tag FROM mail_tags WHERE message_id IN (${placeholders})`)
      .all(...messageIds) as { messageId: number; tag: string }[]
    for (const r of rows) {
      const arr = out.get(r.messageId) ?? []
      arr.push(r.tag)
      out.set(r.messageId, arr)
    }
    return out
  }

  /**
   * 日历数据源：取时间范围内「可能有事件」的邮件。
   * - `due_ts` 落在区间内（有索引，主路径）；
   * - 或者邮件本身在该区间内**且**有索引卡片（卡片正文里可能写着考试/活动日期，交给上层正则解析）。
   * 只读必要列：卡片正文可能较长，但不含 HTML 正文（那是另一个表）。
   */
  async listCalendarSources(from: number, to: number, limit = 800): Promise<CalendarSourceMail[]> {
    const rows = this.db
      .prepare(
        `SELECT m.id AS messageId, m.subject AS subject, m.from_name AS fromName, m.date_ts AS dateTs,
                d.type AS type, d.course AS course, d.due_ts AS dueTs, d.card AS card
         FROM messages m
         JOIN mail_index_docs d ON d.message_id = m.id
         WHERE (d.due_ts IS NOT NULL AND d.due_ts BETWEEN ? AND ?)
            OR (m.date_ts BETWEEN ? AND ? AND d.card IS NOT NULL)
         ORDER BY COALESCE(d.due_ts, m.date_ts) ASC
         LIMIT ?`
      )
      .all(from, to, from, to, limit) as Array<{
      messageId: number
      subject: string
      fromName: string | null
      dateTs: number
      type: string | null
      course: string | null
      dueTs: number | null
      card: string | null
    }>
    return rows
  }

  async listTagCounts(): Promise<Array<{ tag: string; count: number }>> {
    const rows = this.db
      .prepare(
        // V2.2：统计包含全部来源（规则 / AI / 手动），并标出「手动打过的标签」
        //（标签面板据此把手动标签归入「主题标签」组，而不是混进课程/平台那堆自动标签里）
        `SELECT tag,
                COUNT(DISTINCT message_id) AS n,
                MAX(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) AS manual
         FROM mail_tags GROUP BY tag ORDER BY n DESC, tag ASC LIMIT 200`
      )
      .all() as { tag: string; n: number; manual: number }[]
    return rows.map((r) => ({ tag: r.tag, count: r.n, manual: r.manual === 1 }))
  }

  /**
   * 用现有索引卡片重算全部规则标签（A 方案）。
   * 规则标签完全由卡片字段推导，所以换规则/补卡片后重跑一次即可，不花 AI 成本。
   */
  async rebuildRuleTags(): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT d.message_id AS id, d.type, d.course, d.due_ts AS dueTs, d.entities
         FROM mail_index_docs d`
      )
      .all() as { id: number; type: string | null; course: string | null; dueTs: number | null; entities: string }[]
    const now = Date.now()
    let n = 0
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        const entities = safeJsonArray(r.entities)
        const tags = deriveRuleTags({ type: r.type, course: r.course, dueTs: r.dueTs, entities }, now)
        this.db.prepare('DELETE FROM mail_tags WHERE message_id = ? AND source = ?').run(r.id, 'rule')
        const ins = this.db.prepare(
          'INSERT OR IGNORE INTO mail_tags (message_id, tag, source, created_at) VALUES (?, ?, ?, ?)'
        )
        for (const tag of tags) ins.run(r.id, tag, 'rule', now)
        n += 1
      }
    })
    tx()
    return n
  }

  async listTagExamples(): Promise<Array<{ id: number; subject: string; tags: string[] }>> {
    const rows = this.db
      .prepare(
        `SELECT e.message_id AS id, e.tags, m.subject
         FROM tag_examples e LEFT JOIN messages m ON m.id = e.message_id
         ORDER BY e.created_at DESC LIMIT 20`
      )
      .all() as { id: number; tags: string; subject: string | null }[]
    return rows.map((r) => ({ id: r.id, subject: r.subject ?? '(无主题)', tags: safeJsonArray(r.tags) }))
  }

  async setTagExample(messageId: number, tags: string[]): Promise<void> {
    const clean = tags.map((t) => String(t ?? '').trim().slice(0, 12)).filter(Boolean)
    if (clean.length === 0) {
      this.db.prepare('DELETE FROM tag_examples WHERE message_id = ?').run(messageId)
      return
    }
    this.db
      .prepare(
        `INSERT INTO tag_examples (message_id, tags, created_at) VALUES (?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET tags = excluded.tags, created_at = excluded.created_at`
      )
      .run(messageId, JSON.stringify(clean), Date.now())
  }

  // ---- AI 助手聊天（多轮会话） ----

  async createChatSession(title: string): Promise<number> {
    const now = Date.now()
    const info = this.db
      .prepare('INSERT INTO chat_sessions (title, created_at, updated_at) VALUES (?, ?, ?)')
      .run(title.slice(0, 60) || '新对话', now, now)
    return Number(info.lastInsertRowid)
  }

  async listChatSessions(limit = 100): Promise<ChatSession[]> {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count
         FROM chat_sessions s
         ORDER BY s.updated_at DESC, s.id DESC
         LIMIT ?`
      )
      .all(limit) as { id: number; title: string; created_at: number; updated_at: number; message_count: number }[]
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: r.message_count
    }))
  }

  async getChatMessages(sessionId: number, limit = 200): Promise<ChatMessage[]> {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, role, content, citations, created_at FROM chat_messages
         WHERE session_id = ? ORDER BY id ASC LIMIT ?`
      )
      .all(sessionId, limit) as {
      id: number
      session_id: number
      role: string
      content: string
      citations: string
      created_at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.content,
      citations: parseCitations(r.citations),
      createdAt: r.created_at
    }))
  }

  async appendChatMessage(
    sessionId: number,
    role: 'user' | 'assistant',
    content: string,
    citations: ChatMessage['citations'] = []
  ): Promise<number> {
    const now = Date.now()
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare('INSERT INTO chat_messages (session_id, role, content, citations, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, role, content, JSON.stringify(citations ?? []), now)
      // 首条用户消息用作会话标题（还没改过标题的话）
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?').get(sessionId) as {
        n: number
      }
      if (role === 'user' && count.n === 1) {
        this.db
          .prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?')
          .run(content.replace(/\s+/g, ' ').slice(0, 40) || '新对话', now, sessionId)
      } else {
        this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
      }
      return Number(info.lastInsertRowid)
    })
    return tx()
  }

  async deleteChatSession(sessionId: number): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId)
    })
    tx()
  }

  async renameChatSession(sessionId: number, title: string): Promise<void> {
    this.db
      .prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.slice(0, 60) || '新对话', Date.now(), sessionId)
  }

  async getThreadIndex(): Promise<ThreadIndexEntry[]> {    const rows = this.db
      .prepare('SELECT message_id, thread_id, subject, from_addr, date_ts FROM messages ORDER BY date_ts DESC LIMIT 2000')
      .all() as { message_id: string | null; thread_id: string | null; subject: string | null; from_addr: string | null; date_ts: number | null }[]
    return rows.map((r) => ({
      messageId: r.message_id,
      threadId: r.thread_id ?? 't-0',
      subject: r.subject,
      fromAddr: r.from_addr ?? '',
      dateTs: r.date_ts ?? 0
    }))
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
    return row.c
  }

  async markRead(id: number, read: boolean): Promise<void> {
    this.db.prepare('UPDATE messages SET is_read = ? WHERE id = ?').run(read ? 1 : 0, id)
  }

  async setAttachmentPartId(messageId: number, filename: string, partId: string): Promise<void> {
    this.db
      .prepare('UPDATE attachments SET part_id = ? WHERE message_id = ? AND filename = ?')
      .run(partId, messageId, filename)
  }

  async saveSummary(messageId: number, text: string, model: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO mail_summaries (message_id, summary_text, model, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET summary_text=excluded.summary_text,
           model=excluded.model, created_at=excluded.created_at`
      )
      .run(messageId, text, model, Date.now())
  }

  async getSummary(messageId: number): Promise<SavedSummary | null> {
    const row = this.db
      .prepare('SELECT summary_text, model, created_at FROM mail_summaries WHERE message_id = ?')
      .get(messageId) as { summary_text: string; model: string; created_at: number } | undefined
    if (!row) return null
    return { text: row.summary_text, model: row.model, createdAtMs: row.created_at }
  }

  // ---- V2 M4：本地标签 / 星标 ----

  async listLabels(): Promise<MailLabel[]> {
    const rows = this.db.prepare('SELECT id, name, color FROM labels ORDER BY id').all() as { id: number; name: string; color: string }[]
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color }))
  }

  async createLabel(name: string, color?: string): Promise<MailLabel> {
    // 同名标签幂等返回（name 唯一约束）
    const existing = this.db.prepare('SELECT id, name, color FROM labels WHERE name = ?').get(name) as MailLabel | undefined
    if (existing) return existing
    const palette = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#5e5ce6', '#64d2ff', '#bf5af2', '#ffd60a']
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM labels').get() as { c: number }).c
    const chosen = color ?? palette[count % palette.length]
    const info = this.db.prepare('INSERT INTO labels (name, color, created_at) VALUES (?, ?, ?)').run(name, chosen, Date.now())
    return { id: Number(info.lastInsertRowid), name, color: chosen }
  }

  async deleteLabel(id: number): Promise<void> {
    const tx = this.db.transaction(() => {
      // 显式解除关联（不依赖外键级联的开关状态）
      this.db.prepare('DELETE FROM message_labels WHERE label_id = ?').run(id)
      this.db.prepare('DELETE FROM labels WHERE id = ?').run(id)
    })
    tx()
  }

  async setMailLabels(messageId: number, labelIds: number[]): Promise<void> {
    const unique = [...new Set(labelIds)]
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM message_labels WHERE message_id = ?').run(messageId)
      const ins = this.db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)')
      for (const labelId of unique) ins.run(messageId, labelId)
    })
    tx()
  }

  async setStarred(messageId: number, starred: boolean): Promise<void> {
    this.db.prepare('UPDATE messages SET starred = ? WHERE id = ?').run(starred ? 1 : 0, messageId)
  }

  // ---- V2 M5：自定义视图 ----

  async listViews(): Promise<SavedView[]> {
    const rows = this.db
      .prepare('SELECT id, name, filter_json, sort_json, created_at FROM views ORDER BY id')
      .all() as { id: number; name: string; filter_json: string; sort_json: string; created_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      filter: JSON.parse(r.filter_json) as ViewFilter,
      sort: JSON.parse(r.sort_json) as ViewSort,
      createdAt: r.created_at
    }))
  }

  async saveView(view: { id?: number; name: string; filter: ViewFilter; sort: ViewSort }): Promise<SavedView> {
    const filterJson = JSON.stringify(view.filter ?? {})
    const sortJson = JSON.stringify(view.sort ?? { by: 'date', dir: 'desc' })
    if (view.id !== undefined) {
      this.db
        .prepare('UPDATE views SET name = ?, filter_json = ?, sort_json = ? WHERE id = ?')
        .run(view.name, filterJson, sortJson, view.id)
      return { id: view.id, name: view.name, filter: view.filter, sort: view.sort, createdAt: Date.now() }
    }
    const info = this.db
      .prepare('INSERT INTO views (name, filter_json, sort_json, created_at) VALUES (?, ?, ?, ?)')
      .run(view.name, filterJson, sortJson, Date.now())
    return { id: Number(info.lastInsertRowid), name: view.name, filter: view.filter, sort: view.sort, createdAt: Date.now() }
  }

  async deleteView(id: number): Promise<void> {
    this.db.prepare('DELETE FROM views WHERE id = ?').run(id)
  }

  // ---- V2 M6：稍后提醒 ----

  async setSnooze(messageId: number, snoozeUntil: number, note?: string): Promise<void> {
    // 每封邮件只保留一条未触发提醒（部分唯一索引），再次设置 = 覆盖
    this.db
      .prepare(
        `INSERT INTO snoozes (message_id, snooze_until, note, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) WHERE notified_at IS NULL
         DO UPDATE SET snooze_until=excluded.snooze_until, note=excluded.note, created_at=excluded.created_at`
      )
      .run(messageId, snoozeUntil, note ?? null, Date.now())
  }

  async cancelSnooze(messageId: number): Promise<void> {
    this.db.prepare('DELETE FROM snoozes WHERE message_id = ? AND notified_at IS NULL').run(messageId)
  }

  async dueSnoozes(now: number): Promise<DueSnooze[]> {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.message_id, s.snooze_until, s.note, s.created_at, s.notified_at,
           m.subject, m.from_name
         FROM snoozes s
         JOIN messages m ON m.id = s.message_id
         WHERE s.snooze_until <= ? AND s.notified_at IS NULL
         ORDER BY s.snooze_until ASC`
      )
      .all(now) as {
      id: number
      message_id: number
      snooze_until: number
      note: string | null
      created_at: number
      notified_at: number | null
      subject: string | null
      from_name: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      messageId: r.message_id,
      snoozeUntil: r.snooze_until,
      note: r.note,
      createdAt: r.created_at,
      notifiedAt: r.notified_at,
      subject: r.subject ?? '(无主题)',
      fromName: r.from_name ?? ''
    }))
  }

  async markSnoozeNotified(snoozeId: number): Promise<void> {
    this.db.prepare('UPDATE snoozes SET notified_at = ? WHERE id = ?').run(Date.now(), snoozeId)
  }

  // ---- V2 M7：批量操作 ----

  async bulkMarkRead(ids: number[], read: boolean): Promise<void> {
    const stmt = this.db.prepare('UPDATE messages SET is_read = ? WHERE id = ?')
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(read ? 1 : 0, id)
    })
    tx()
  }

  async bulkAddLabels(ids: number[], labelIds: number[]): Promise<void> {
    const ins = this.db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)')
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        for (const labelId of labelIds) ins.run(id, labelId)
      }
    })
    tx()
  }

  // ---- V2 M9：本地草稿（发送 P1 待授权） ----

  async listDrafts(): Promise<MailDraft[]> {
    const rows = this.db
      .prepare('SELECT id, to_addrs, subject, body, created_at, updated_at FROM drafts ORDER BY updated_at DESC, id DESC')
      .all() as { id: number; to_addrs: string; subject: string; body: string; created_at: number; updated_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      toAddrs: JSON.parse(r.to_addrs) as string[],
      subject: r.subject,
      body: r.body,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  }

  async saveDraft(draft: { id?: number; toAddrs: string[]; subject: string; body: string }): Promise<MailDraft> {
    const now = Date.now()
    const toJson = JSON.stringify(draft.toAddrs)
    if (draft.id !== undefined) {
      this.db
        .prepare('UPDATE drafts SET to_addrs = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?')
        .run(toJson, draft.subject, draft.body, now, draft.id)
      return { id: draft.id, toAddrs: [...draft.toAddrs], subject: draft.subject, body: draft.body, createdAt: now, updatedAt: now }
    }
    const info = this.db
      .prepare('INSERT INTO drafts (to_addrs, subject, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(toJson, draft.subject, draft.body, now, now)
    return { id: Number(info.lastInsertRowid), toAddrs: [...draft.toAddrs], subject: draft.subject, body: draft.body, createdAt: now, updatedAt: now }
  }

  async deleteDraft(id: number): Promise<void> {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
  }

  // ---- 发信：本地「已发送」记录 ----

  async insertSentItem(item: {
    toAddrs: string[]
    ccAddrs: string[]
    subject: string
    body: string
    status: 'sent' | 'failed'
    error?: string | null
  }): Promise<number> {
    const info = this.db
      .prepare(
        `INSERT INTO sent_items (to_addrs, cc_addrs, subject, body, sent_at, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        JSON.stringify(item.toAddrs),
        JSON.stringify(item.ccAddrs),
        item.subject,
        item.body,
        Date.now(),
        item.status,
        item.error ?? null
      )
    return Number(info.lastInsertRowid)
  }

  async listSentItems(limit = 200): Promise<SentItem[]> {
    const rows = this.db
      .prepare('SELECT id, to_addrs, cc_addrs, subject, body, sent_at, status, error FROM sent_items ORDER BY sent_at DESC, id DESC LIMIT ?')
      .all(limit) as {
      id: number
      to_addrs: string
      cc_addrs: string
      subject: string
      body: string
      sent_at: number
      status: string
      error: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      toAddrs: safeJsonArray(r.to_addrs),
      ccAddrs: safeJsonArray(r.cc_addrs),
      subject: r.subject,
      body: r.body,
      sentAt: r.sent_at,
      status: r.status === 'failed' ? 'failed' : 'sent',
      error: r.error
    }))
  }

  async deleteSentItem(id: number): Promise<void> {
    this.db.prepare('DELETE FROM sent_items WHERE id = ?').run(id)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}
