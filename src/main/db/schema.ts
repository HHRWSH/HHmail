/**
 * SQLite 表结构（规范 §6.5）与迁移器（只增不改，规范 §14.3）。
 * migrations 数组只能 append，不能修改历史项。
 */
import type { SyncStateRecord } from './store'

export interface Migration {
  version: number
  name: string
  sql: string[]
}

export const SCHEMA_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: [
      `CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        refresh_token_enc BLOB NOT NULL,
        access_token_enc BLOB,
        access_token_expires_at INTEGER,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sync_state (
        account_id INTEGER PRIMARY KEY,
        uid_validity INTEGER NOT NULL,
        last_uid INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL DEFAULT 1,
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
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_ts DESC)`,
      `CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL,
        part_id TEXT,
        filename TEXT,
        content_type TEXT,
        size INTEGER,
        local_path TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        subject, from_name, from_addr, body_text,
        content='messages',
        content_rowid='id',
        tokenize='trigram'
      )`,
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_enc BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    ]
  },
  {
    version: 2,
    name: 'sync-state-full-history',
    sql: [
      // 「同步全部历史邮件」模式标记：老用户升级后 last_uid 已推进过，需重新全量同步一次
      `ALTER TABLE sync_state ADD COLUMN full_history INTEGER NOT NULL DEFAULT 0`
    ]
  },
  {
    version: 3,
    name: 'mail-summaries',
    sql: [
      // AI 总结持久化：每封邮件一条，长期保留供查阅
      `CREATE TABLE IF NOT EXISTS mail_summaries (
        message_id INTEGER PRIMARY KEY,
        summary_text TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    ]
  },
  {
    version: 4,
    name: 'attachment-partid-backfill',
    sql: [
      // 附件下载（V2 M2）：老数据 part_id 为 NULL → 置空串，下载时按需回填
      `UPDATE attachments SET part_id = '' WHERE part_id IS NULL`
    ]
  },
  {
    version: 5,
    name: 'multi-folder',
    sql: [
      // V2 M3 多文件夹只读：
      // 1) messages 增加 folder 列，唯一约束改为 (account_id, folder, uid)——不同文件夹的 UID 独立；
      //    保留原 id（rowid），FTS 外部内容表与 attachments 外键不受影响。
      `CREATE TABLE messages_v5 (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL DEFAULT 1,
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
        folder TEXT NOT NULL DEFAULT 'INBOX',
        UNIQUE(account_id, folder, uid)
      )`,
      `INSERT INTO messages_v5 (id, account_id, uid, message_id, thread_id, subject, from_name, from_addr,
         to_addrs, cc_addrs, date_hdr, date_ts, body_text, body_html, snippet, is_read, flags_json, created_at, folder)
       SELECT id, account_id, uid, message_id, thread_id, subject, from_name, from_addr,
         to_addrs, cc_addrs, date_hdr, date_ts, body_text, body_html, snippet, is_read, flags_json, created_at, 'INBOX'
       FROM messages`,
      `DROP TABLE messages`,
      `ALTER TABLE messages_v5 RENAME TO messages`,
      `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_ts DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder)`,
      // 内容表被重建后，外部内容 FTS 必须一并重建并回填索引（否则损坏）
      `DROP TABLE IF EXISTS messages_fts`,
      `CREATE VIRTUAL TABLE messages_fts USING fts5(
        subject, from_name, from_addr, body_text,
        content='messages',
        content_rowid='id',
        tokenize='trigram'
      )`,
      `INSERT INTO messages_fts(rowid, subject, from_name, from_addr, body_text)
       SELECT id, subject, from_name, from_addr, body_text FROM messages`,
      // 2) sync_state 增加 folder 列，主键改为 (account_id, folder)——每个文件夹独立同步状态
      `CREATE TABLE sync_state_v5 (
        account_id INTEGER NOT NULL,
        folder TEXT NOT NULL,
        uid_validity INTEGER NOT NULL,
        last_uid INTEGER NOT NULL,
        full_history INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account_id, folder)
      )`,
      `INSERT INTO sync_state_v5 (account_id, folder, uid_validity, last_uid, full_history)
       SELECT account_id, 'INBOX', uid_validity, last_uid, full_history FROM sync_state`,
      `DROP TABLE sync_state`,
      `ALTER TABLE sync_state_v5 RENAME TO sync_state`
    ]
  },
  {
    version: 6,
    name: 'labels-star',
    sql: [
      // V2 M4 本地标签 / 星标：
      // labels + message_labels 关联表（级联删除由 sqlite.ts 显式维护，不依赖外键开关）；
      // 星标用 messages.starred 列（简单、查询快）。
      `CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#0a84ff',
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS message_labels (
        message_id INTEGER NOT NULL,
        label_id INTEGER NOT NULL,
        PRIMARY KEY (message_id, label_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_message_labels_label ON message_labels(label_id)`,
      `ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_messages_starred ON messages(starred)`
    ]
  },
  {
    version: 7,
    name: 'saved-views',
    sql: [
      // V2 M5 自定义视图：命名保存「筛选 + 排序」到侧边栏
      `CREATE TABLE IF NOT EXISTS views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        filter_json TEXT NOT NULL,
        sort_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    ]
  },
  {
    version: 8,
    name: 'snoozes',
    sql: [
      // V2 M6 稍后提醒：每封邮件最多一条「未触发」的提醒（部分唯一索引）
      `CREATE TABLE IF NOT EXISTS snoozes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        snooze_until INTEGER NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        notified_at INTEGER
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_snoozes_pending ON snoozes(message_id) WHERE notified_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_snoozes_due ON snoozes(snooze_until)`
    ]
  },
  {
    version: 9,
    name: 'priority-score',
    sql: [
      // V2 M8 优先级收件箱：规则打分列（0..100）。
      // 回填 SQL 必须与 shared/priority.ts 同规则：本校域名 +30、带附件 +20、重要/DDL/截止 +30。
      `ALTER TABLE messages ADD COLUMN priority_score INTEGER NOT NULL DEFAULT 0`,
      `UPDATE messages SET priority_score = MIN(100,
        (CASE WHEN lower(from_addr) LIKE '%.edu%' THEN 30 ELSE 0 END) +
        (CASE WHEN EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = messages.id) THEN 20 ELSE 0 END) +
        (CASE WHEN lower(subject) LIKE '%重要%' OR lower(subject) LIKE '%ddl%' OR lower(subject) LIKE '%截止%'
            OR lower(body_text) LIKE '%重要%' OR lower(body_text) LIKE '%ddl%' OR lower(body_text) LIKE '%截止%'
             THEN 30 ELSE 0 END)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority_score DESC)`
    ]
  },
  {
    version: 10,
    name: 'drafts',
    sql: [
      // V2 M9 本地草稿：只存本地，发送需 Graph Mail.Send / SMTP AUTH 授权（P1，本轮不做）
      `CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        to_addrs TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    ]
  },
  {
    version: 11,
    name: 'drop-priority-and-sent-items',
    sql: [
      // 用户反馈「优先级功能没什么用」→ 删除该功能：先删索引再删列
      // （SQLite 的 DROP COLUMN 要求该列没有被索引/视图引用）
      `DROP INDEX IF EXISTS idx_messages_priority`,
      `ALTER TABLE messages DROP COLUMN priority_score`,
      // 发信功能（SMTP + OAuth）：本地记录「已发送」，含失败原因，便于 UI 展示与重试
      `CREATE TABLE IF NOT EXISTS sent_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        to_addrs TEXT NOT NULL,
        cc_addrs TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        in_reply_to TEXT,
        sent_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        error TEXT
      )`
    ]
  },
  {
    version: 12,
    name: 'mail-index-docs',
    sql: [
      // 检索用「索引卡片」：与人类阅读的摘要分开存（用户要求双摘要）。
      // 给人看的是 Markdown 决策卡（mail_summaries）；给 AI 检索的是结构化卡片（本表），
      // 含类型/课程/截止等可过滤字段，供 askInbox 做「关键词 + 结构化过滤」召回。
      `CREATE TABLE IF NOT EXISTS mail_index_docs (
        message_id INTEGER PRIMARY KEY,
        card TEXT NOT NULL,
        type TEXT,
        course TEXT,
        term TEXT,
        due_ts INTEGER,
        entities TEXT NOT NULL DEFAULT '[]',
        aliases TEXT NOT NULL DEFAULT '[]',
        questions TEXT NOT NULL DEFAULT '[]',
        model TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      // 关键词路：FTS5（trigram，中文按子串命中），外部内容表需手动同步
      `CREATE VIRTUAL TABLE IF NOT EXISTS mail_index_fts USING fts5(
        card, entities, aliases, questions,
        content='mail_index_docs',
        content_rowid='message_id',
        tokenize='trigram'
      )`,
      `CREATE INDEX IF NOT EXISTS idx_index_due ON mail_index_docs(due_ts)`,
      `CREATE INDEX IF NOT EXISTS idx_index_type ON mail_index_docs(type)`
    ]
  },
  {
    version: 13,
    name: 'collection-overrides',
    sql: [
      // M3 知识库集合：集合本身由索引卡片的结构化字段派生（course / type），
      // 这张表只存「用户手动修正」——目前只支持把某封邮件移出某个集合。
      // 设计约束：集合默认只做加权/浏览，不做硬过滤；不确定的进「未分类」，绝不硬塞。
      `CREATE TABLE IF NOT EXISTS collection_overrides (
        message_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'exclude',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, kind, value)
      )`
    ]
  },
  {
    version: 14,
    name: 'chat-sessions',
    sql: [
      // AI 助手改成聊天式（用户要求「像市面上的 AI 客户端」）：会话 + 消息本地留存，支持多轮上下文。
      `CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        citations TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id)`
    ]
  },
  {
    version: 15,
    name: 'auto-tags',
    sql: [
      // 自动标签（V2.2）：A 方案由索引卡片字段推导 + B 方案由 AI 从词表里挑；与手动标签（labels）分开存。
      // 只用于浏览/筛选/聚合，不参与删除或硬过滤；规则标签可随时整体重算。
      `CREATE TABLE IF NOT EXISTS mail_tags (
        message_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'rule',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, tag, source)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mail_tags_tag ON mail_tags(tag)`,
      // 用户挑的「示例邮件」：给 AI 打标签时当 few-shot 参考（主题 + 用户认可的标签）
      `CREATE TABLE IF NOT EXISTS tag_examples (
        message_id INTEGER PRIMARY KEY,
        tags TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    ]
  },
  {
    version: 16,
    name: 'manual-tags-and-suppression',
    sql: [
      // V2.2：统一标签体系 —— 旧的「彩色标签(labels)」整体并入 mail_tags(source='manual')，
      // 之后标签只有一个入口：自动（rule/ai）+ 手动（manual，永不被重算覆盖）。
      `INSERT OR IGNORE INTO mail_tags (message_id, tag, source, created_at)
         SELECT ml.message_id, l.name, 'manual', 0
         FROM message_labels ml JOIN labels l ON l.id = ml.label_id`,
      // 用户「删掉某个自动标签」后，重算不应该再把它加回来 → 记一张抑制表
      `CREATE TABLE IF NOT EXISTS tag_suppressed (
        message_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, tag)
      )`
    ]
  },
  {
    version: 17,
    name: 'bodies-out-of-messages',
    sql: [
      // 真机数据：242 封邮件的 body_html 合计 107MB（单封最大 11.6MB）。
      // 旧实现列表查询 `SELECT m.*` 会把每封的整份 HTML 读进内存（200 封约 106MB！），
      // 每次切收件箱/每次新邮件刷新都要付这个代价 —— 这就是「邮件多就很卡」的根因。
      // 这里把正文搬到独立表：messages 行变小、排布紧凑，列表查询只读几页；
      // 正文只在打开邮件/生成摘要时按需读取（VACUUM 会把腾出来的空间真正还给磁盘）。
      `CREATE TABLE IF NOT EXISTS message_bodies (
        message_id INTEGER PRIMARY KEY,
        body_text TEXT,
        body_html TEXT
      )`,
      `INSERT OR REPLACE INTO message_bodies (message_id, body_text, body_html)
         SELECT id, body_text, body_html FROM messages
         WHERE body_text IS NOT NULL OR body_html IS NOT NULL`,
      `UPDATE messages SET body_text = NULL, body_html = NULL`
    ]
  },
  {
    version: 18,
    name: 'flagged-mails',
    sql: [
      // 红旗（V2.2）：像 Outlook 的后续标记 —— 独立于星标，列表里显示红色小旗并可筛选
      `ALTER TABLE messages ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_messages_flagged ON messages(flagged)`
    ]
  },
  {
    version: 19,
    name: 'colored-categories',
    sql: [
      // 彩色类别（V2.2，Gmail 风格）：一封邮件最多一个类别，列表里用该颜色的淡色背景"常亮"标出
      `CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS message_category (
        message_id INTEGER PRIMARY KEY,
        category_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_message_category ON message_category(category_id)`,
      `INSERT OR IGNORE INTO categories (name, color, sort_order, created_at) VALUES
        ('Blue category', '#1a73e8', 1, 0),
        ('Green category', '#188038', 2, 0),
        ('Orange category', '#e8710a', 3, 0),
        ('Purple category', '#8430ce', 4, 0),
        ('Red category', '#d93025', 5, 0),
        ('Yellow category', '#f9ab00', 6, 0)`
    ]
  }
] as const

export interface MigratableDb {
  pragma(query: string, opts?: { simple?: boolean }): unknown
  exec(sql: string): unknown
  /** better-sqlite3 的 transaction(fn) 返回可调用的 Transaction 函数，需调用才执行。 */
  transaction(fn: () => void): () => void
}

export function currentVersion(db: MigratableDb): number {
  const v = db.pragma('user_version', { simple: true })
  return typeof v === 'number' ? v : Number(v)
}

/** 应用所有未应用的迁移；返回迁移后的版本号。 */
export function migrate(db: MigratableDb): number {
  const from = currentVersion(db)
  let applied = 0
  for (const m of SCHEMA_MIGRATIONS) {
    if (m.version <= from) continue
    const tx = db.transaction(() => {
      for (const sql of m.sql) db.exec(sql)
      db.exec(`PRAGMA user_version = ${m.version}`)
    })
    tx()
    applied += 1
  }
  return from + applied
}

export function readSyncState(row: { uid_validity: number; last_uid: number; full_history?: number } | undefined): SyncStateRecord | null {
  if (!row) return null
  return {
    uidValidity: row.uid_validity,
    lastUid: row.last_uid,
    fullHistory: row.full_history === 1
  }
}
