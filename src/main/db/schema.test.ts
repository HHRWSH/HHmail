import { describe, expect, it } from 'vitest'
import { migrate, currentVersion, SCHEMA_MIGRATIONS, type MigratableDb } from './schema'

/** 极简 fake DB：记录 exec 调用 + user_version。 */
class FakeDb implements MigratableDb {
  version = 0
  execLog: string[] = []

  pragma(query: string): unknown {
    if (query === 'user_version') return this.version
    return null
  }

  exec(sql: string): unknown {
    this.execLog.push(sql)
    if (sql.startsWith('PRAGMA user_version')) {
      this.version = Number(sql.split('=')[1])
    }
    return null
  }

  transaction(fn: () => void): () => void {
    fn()
    return () => undefined
  }
}

describe('migrate —— PRAGMA user_version 迁移器（只增不改）', () => {
  it('全新库：应用全部迁移并推进 user_version', () => {
    const db = new FakeDb()
    const v = migrate(db)
    expect(v).toBe(SCHEMA_MIGRATIONS.length)
    expect(db.version).toBe(SCHEMA_MIGRATIONS.length)
    expect(db.execLog.join('\n')).toContain('CREATE TABLE')
    expect(db.execLog.join('\n')).toContain('messages_fts')
  })

  it('已到最新版本：零动作', () => {
    const db = new FakeDb()
    db.version = SCHEMA_MIGRATIONS.length
    const before = db.execLog.length
    migrate(db)
    expect(db.execLog.length).toBe(before)
    expect(currentVersion(db)).toBe(SCHEMA_MIGRATIONS.length)
  })

  it('迁移列表 version 严格递增（只增不改的硬前提）', () => {
    const versions = SCHEMA_MIGRATIONS.map((m) => m.version)
    expect([...versions].sort((a, b) => a - b)).toEqual(versions)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('init 迁移包含规范 §6.5 的关键表', () => {
    const init = SCHEMA_MIGRATIONS.find((m) => m.version === 1)
    const sql = (init?.sql ?? []).join('\n')
    for (const table of ['accounts', 'sync_state', 'messages', 'attachments', 'messages_fts']) {
      expect(sql).toContain(table)
    }
    expect(sql).toContain('UNIQUE(account_id, uid)')
    expect(sql).toContain("tokenize='trigram'")
  })

  it('v2 迁移为 sync_state 增加 full_history 列（只增不改）', () => {
    const v2 = SCHEMA_MIGRATIONS.find((m) => m.version === 2)
    expect(v2?.sql.join('\n')).toContain('full_history')
  })

  it('v3 迁移新增 mail_summaries 表（AI 总结持久化）', () => {
    const v3 = SCHEMA_MIGRATIONS.find((m) => m.version === 3)
    expect(v3?.sql.join('\n')).toContain('mail_summaries')
  })

  it('v4 迁移回填附件 part_id 空串（V2 M2）', () => {
    const v4 = SCHEMA_MIGRATIONS.find((m) => m.version === 4)
    expect(v4?.sql.join('\n')).toContain("part_id = ''")
  })

  it('v5 迁移多文件夹：messages.folder 列 + (account_id,folder,uid) 唯一 + sync_state 含 folder 主键（V2 M3）', () => {
    const v5 = SCHEMA_MIGRATIONS.find((m) => m.version === 5)
    const sql = v5?.sql.join('\n') ?? ''
    expect(sql).toContain('folder TEXT NOT NULL')
    expect(sql).toContain('UNIQUE(account_id, folder, uid)')
    expect(sql).toContain('sync_state_v5')
    expect(sql).toContain("SELECT account_id, 'INBOX', uid_validity")
  })

  it('v6 迁移标签/星标：labels + message_labels 表 + messages.starred 列（V2 M4）', () => {
    const v6 = SCHEMA_MIGRATIONS.find((m) => m.version === 6)
    const sql = v6?.sql.join('\n') ?? ''
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS labels')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS message_labels')
    expect(sql).toContain('ADD COLUMN starred INTEGER NOT NULL DEFAULT 0')
    expect(sql).toContain('idx_messages_starred')
  })

  it('v7 迁移自定义视图：views 表（filter_json/sort_json，V2 M5）', () => {
    const v7 = SCHEMA_MIGRATIONS.find((m) => m.version === 7)
    const sql = v7?.sql.join('\n') ?? ''
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS views')
    expect(sql).toContain('filter_json TEXT NOT NULL')
    expect(sql).toContain('sort_json TEXT NOT NULL')
  })

  it('v8 迁移稍后提醒：snoozes 表 + 未触发部分唯一索引（V2 M6）', () => {
    const v8 = SCHEMA_MIGRATIONS.find((m) => m.version === 8)
    const sql = v8?.sql.join('\n') ?? ''
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS snoozes')
    expect(sql).toContain('snooze_until INTEGER NOT NULL')
    expect(sql).toContain('notified_at')
    expect(sql).toContain('ON snoozes(message_id) WHERE notified_at IS NULL')
  })

  it('v9 迁移优先级属于历史（v11 已下线该功能）', () => {
    const v9 = SCHEMA_MIGRATIONS.find((m) => m.version === 9)
    expect((v9?.sql.join('\n') ?? '')).toContain('ADD COLUMN priority_score')
    const v11 = SCHEMA_MIGRATIONS.find((m) => m.version === 11)
    const sql = v11?.sql.join('\n') ?? ''
    expect(sql).toContain('DROP INDEX IF EXISTS idx_messages_priority')
    expect(sql).toContain('DROP COLUMN priority_score')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS sent_items')
  })

  it('v10 迁移本地草稿：drafts 表（V2 M9）', () => {
    const v10 = SCHEMA_MIGRATIONS.find((m) => m.version === 10)
    const sql = v10?.sql.join('\n') ?? ''
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS drafts')
    expect(sql).toContain('to_addrs TEXT NOT NULL')
    expect(sql).toContain('updated_at INTEGER NOT NULL')
  })
})
