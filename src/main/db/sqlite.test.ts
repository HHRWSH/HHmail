import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { SqliteMessageStore } from './sqlite'
import { SCHEMA_MIGRATIONS } from './schema'
import type { IncomingMessage } from './store'
import { MemoryLogger } from '../logger'
import { buildRetrievalQuery } from '../../shared/retrievalQuery'

function makeMsg(uid: number, opts: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    uid,
    subject: opts.subject ?? `邮件 ${uid}`,
    fromName: opts.fromName ?? '林教授',
    fromAddr: opts.fromAddr ?? 'lin@example.edu',
    toAddrs: opts.toAddrs ?? [],
    ccAddrs: [],
    dateHdr: null,
    dateTs: opts.dateTs ?? uid * 1000,
    messageId: opts.messageId ?? `<m${uid}@example.edu>`,
    threadId: opts.threadId ?? `t-${uid}`,
    references: opts.references ?? [],
    inReplyTo: null,
    bodyText: opts.bodyText ?? `这是第 ${uid} 封邮件的正文，关于选课与学费缴费的通知。`,
    bodyHtml: opts.bodyHtml ?? null,
    snippet: opts.snippet ?? '',
    attachments: opts.attachments ?? [],
    flags: [],
    folder: opts.folder
  }
}

describe('SqliteMessageStore —— 真实 better-sqlite3 契约测试', () => {
  let dbPath: string
  let store: SqliteMessageStore

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `mail-ai-store-test-${process.pid}-${Date.now()}.db`)
    store = new SqliteMessageStore(dbPath, new MemoryLogger())
  })

  afterAll(() => {
    store.close()
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(dbPath + suffix, { force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('upsert 幂等（同 uid 覆盖不重复）', async () => {
    await store.upsertMessages([makeMsg(101), makeMsg(102)])
    expect(await store.count()).toBe(2)
    await store.upsertMessages([makeMsg(101, { subject: '更新后的主题' })])
    expect(await store.count()).toBe(2)
    const all = await store.query({ limit: 10, offset: 0 })
    expect(all.find((m) => m.uid === 101)?.subject).toBe('更新后的主题')
  })

  it('query 按日期倒序 + limit/offset', async () => {
    const all = await store.query({ limit: 10, offset: 0 })
    expect(all.length).toBe(2)
    expect(all[0].uid).toBe(102) // dateTs 更大的在前
    expect(all[0].fromName).toBe('林教授')
  })

  it('FTS trigram 命中中文 ≥3 字符', async () => {
    await store.upsertMessages([makeMsg(103, { bodyText: '毕业论文进度沟通：第三章需要补充实验数据' })])
    const hits = await store.search('毕业论文', 10)
    expect(hits.some((h) => h.uid === 103)).toBe(true)
  })

  it('FTS 命中英文关键词（VPN）', async () => {
    await store.upsertMessages([makeMsg(104, { bodyText: '新版 VPN 客户端已支持 Windows 11。' })])
    const hits = await store.search('VPN', 10)
    expect(hits.some((h) => h.uid === 104)).toBe(true)
  })

  it('短中文词（2 字符，trigram 覆盖不到）→ LIKE 兜底命中', async () => {
    await store.upsertMessages([makeMsg(105, { bodyText: '关于选课的补充说明。' })])
    const hits = await store.search('选课', 10)
    expect(hits.some((h) => h.uid === 105)).toBe(true)
  })

  it('搜索命中发件人（LIKE 兜底）', async () => {
    await store.upsertMessages([makeMsg(106, { fromName: '教务处', fromAddr: 'office@link.example.edu' })])
    const hits = await store.search('教务处', 10)
    expect(hits.some((h) => h.uid === 106)).toBe(true)
  })

  it('getMessage 返回完整详情 + 附件元数据（含 partId，V2 M2）', async () => {
    await store.upsertMessages([
      makeMsg(107, {
        attachments: [{ partId: '2', filename: '报告.pdf', contentType: 'application/pdf', size: 2048, contentId: null, disposition: 'attachment' }]
      })
    ])
    const list = await store.query({ limit: 10, offset: 0 })
    const item = list.find((m) => m.uid === 107)
    expect(item?.hasAttachments).toBe(true)
    const detail = await store.getMessage(item!.id)
    expect(detail?.attachments).toHaveLength(1)
    expect(detail?.attachments[0].filename).toBe('报告.pdf')
    expect(detail?.attachments[0].partId).toBe('2')
    expect(detail?.bodyText).toContain('选课')
  })

  it('附件 partId 回填：setAttachmentPartId 更新旧数据（V2 M2）', async () => {
    await store.upsertMessages([
      makeMsg(1080, {
        attachments: [{ partId: '', filename: '旧附件.pdf', contentType: 'application/pdf', size: 1024, contentId: null, disposition: 'attachment' }]
      })
    ])
    const list = await store.query({ limit: 10, offset: 0 })
    const item = list.find((m) => m.uid === 1080)!
    const before = await store.getMessage(item.id)
    expect(before?.attachments[0].partId).toBe('')
    await store.setAttachmentPartId(item.id, '旧附件.pdf', '3.1')
    const after = await store.getMessage(item.id)
    expect(after?.attachments[0].partId).toBe('3.1')
  })

  it('并发 upsert 同一封带附件邮件 → 附件不丢、FTS 不坏（回归：UPSERT 冲突更新路径 rowId 必须取旧行 id）', async () => {
    // M3 上线后收件箱首次进入会触发两次同步（初始 + 文件夹切换 effect），
    // 两个 SyncEngine.run 并发 upsert 同一批 UID。此前在冲突更新路径误用
    // lastInsertRowid（返回脏值），导致附件/摘要写到错误的 message_id。
    const withAtt = makeMsg(202, {
      attachments: [
        { partId: '2', filename: '课件.pdf', contentType: 'application/pdf', size: 1234, contentId: null, disposition: 'attachment' },
        { partId: '3', filename: '作业.txt', contentType: 'text/plain', size: 56, contentId: null, disposition: 'attachment' }
      ]
    })
    await Promise.all([
      store.upsertMessages([withAtt, makeMsg(203)]),
      store.upsertMessages([withAtt, makeMsg(203)])
    ])
    const list = await store.query({ limit: 100, offset: 0 })
    const row = list.find((m) => m.uid === 202)!
    expect(row.hasAttachments).toBe(true)
    const detail = await store.getMessage(row.id)
    expect(detail?.attachments.map((a) => a.filename).sort()).toEqual(['作业.txt', '课件.pdf'])
    expect(detail?.attachments.every((a) => a.partId !== '')).toBe(true)
    // FTS 外部内容表在并发 delete/insert 后必须仍然可查（曾出现过 database disk image is malformed）
    const hits = await store.search('选课', 10)
    expect(hits.some((h) => h.uid === 202)).toBe(true)
    expect(await store.count()).toBeGreaterThan(0)
  })

  it('同步状态读写 + 线程索引', async () => {
    await store.setSyncState({ uidValidity: 7, lastUid: 107 })
    expect(await store.getSyncState()).toEqual({ uidValidity: 7, lastUid: 107, fullHistory: false, folder: 'INBOX' })
    const index = await store.getThreadIndex()
    expect(index.length).toBeGreaterThan(0)
    expect(index.every((e) => typeof e.threadId === 'string')).toBe(true)
  })

  it('getThread 按线程聚合（同 thread_id 的邮件归组）', async () => {
    await store.upsertMessages([
      makeMsg(108, { threadId: 'T-x', dateTs: 108_000, subject: 'Re: 讨论' }),
      makeMsg(109, { threadId: 'T-x', dateTs: 109_000, subject: '讨论' })
    ])
    const thread = await store.getThread('T-x')
    expect(thread.map((m) => m.uid)).toEqual([108, 109])
  })

  it('markRead 只改本地 is_read，不涉及服务端', async () => {
    const list = await store.query({ limit: 10, offset: 0 })
    const target = list.find((m) => m.uid === 109)!
    expect(target.unread).toBe(true)
    await store.markRead(target.id, true)
    const after = await store.query({ limit: 10, offset: 0, unreadOnly: true })
    expect(after.some((m) => m.uid === 109)).toBe(false)
  })

  it('AI 总结持久化：saveSummary 覆盖、getMessage 返回保存的摘要', async () => {
    const list = await store.query({ limit: 10, offset: 0 })
    const target = list.find((m) => m.uid === 107)!
    await store.saveSummary(target.id, '第一版摘要', 'deepseek-v4-pro')
    await store.saveSummary(target.id, '第二版摘要', 'deepseek-v4-flash')
    const saved = await store.getSummary(target.id)
    expect(saved?.text).toBe('第二版摘要')
    expect(saved?.model).toBe('deepseek-v4-flash')
    const detail = await store.getMessage(target.id)
    expect(detail?.savedSummary).toBe('第二版摘要')
    expect(detail?.savedSummaryModel).toBe('deepseek-v4-flash')
    expect(detail?.savedSummaryAt).toBeGreaterThan(0)
    const none = await store.getSummary(999999)
    expect(none).toBeNull()
  })

  it('迁移幂等：同一 db 文件重开不报错、版本不变', async () => {
    const second = new SqliteMessageStore(dbPath, new MemoryLogger())
    expect(await second.count()).toBeGreaterThan(0)
    second.close()
  })

  it('v5 老库升级：旧邮件与同步状态归入 INBOX，同 UID 可在不同文件夹共存（V2 M3）', async () => {
    const legacyPath = path.join(os.tmpdir(), `mail-ai-legacy-${process.pid}-${Date.now()}.db`)
    // 手工构造 v4 老库（只执行 1..4 迁移 + 旧表结构数据）
    const raw = new Database(legacyPath)
    for (const m of SCHEMA_MIGRATIONS.filter((x) => x.version <= 4)) {
      for (const sql of m.sql) raw.exec(sql)
      raw.exec(`PRAGMA user_version = ${m.version}`)
    }
    raw
      .prepare(
        `INSERT INTO messages (account_id, uid, subject, from_name, from_addr, body_text, snippet, created_at)
         VALUES (1, 55, '旧邮件', 'A', 'a@example.edu', '旧正文', '', 1)`
      )
      .run()
    raw.prepare('INSERT INTO sync_state (account_id, uid_validity, last_uid) VALUES (1, 7, 55)').run()
    raw.close()

    const store = new SqliteMessageStore(legacyPath, new MemoryLogger())
    // 老同步状态迁移为 INBOX
    expect((await store.getSyncState('INBOX'))?.lastUid).toBe(55)
    // 老邮件归入 INBOX
    const inboxList = await store.query({ limit: 10, offset: 0 })
    expect(inboxList.some((m) => m.uid === 55)).toBe(true)
    // 同 UID 可存在于另一文件夹（唯一约束带 folder）
    await store.upsertMessages([makeMsg(55, { folder: 'Sent', subject: '已发送副本' })])
    const sentList = await store.query({ limit: 10, offset: 0, folder: 'Sent' })
    expect(sentList.some((m) => m.uid === 55)).toBe(true)
    expect(sentList[0].subject).toBe('已发送副本')
    // INBOX 中原邮件不受影响
    const inboxAfter = await store.query({ limit: 10, offset: 0 })
    expect(inboxAfter.filter((m) => m.uid === 55)).toHaveLength(1)
    expect(inboxAfter.find((m) => m.uid === 55)?.subject).toBe('旧邮件')
    store.close()
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(legacyPath + suffix, { force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('V2 M4：标签 CRUD + 邮件关联 + 标签/星标过滤', async () => {
    const a = await store.createLabel('课业')
    const b = await store.createLabel('重要', '#ff375f')
    expect((await store.listLabels()).map((l) => l.name)).toEqual(['课业', '重要'])
    expect(b.color).toBe('#ff375f')
    // 同名幂等（name 唯一）
    const a2 = await store.createLabel('课业')
    expect(a2.id).toBe(a.id)
    expect((await store.listLabels())).toHaveLength(2)

    const list = await store.query({ limit: 100, offset: 0 })
    const target = list.find((m) => m.uid === 107)!
    // 覆盖式关联
    await store.setMailLabels(target.id, [a.id, b.id, a.id])
    const detail = await store.getMessage(target.id)
    expect(detail?.labels.map((l) => l.id).sort()).toEqual([a.id, b.id].sort())
    expect(detail?.starred).toBe(false)

    // 列表项携带 labels/starred
    const listAfter = await store.query({ limit: 100, offset: 0 })
    const item = listAfter.find((m) => m.id === target.id)!
    expect(item.labels.map((l) => l.id).sort()).toEqual([a.id, b.id].sort())
    expect(item.starred).toBe(false)

    // 星标过滤
    await store.setStarred(target.id, true)
    const starredList = await store.query({ limit: 100, offset: 0, starredOnly: true })
    expect(starredList.every((m) => m.starred)).toBe(true)
    expect(starredList.some((m) => m.id === target.id)).toBe(true)
    const starDetail = await store.getMessage(target.id)
    expect(starDetail?.starred).toBe(true)

    // 标签过滤（任一命中）+ 空命中
    const labelList = await store.query({ limit: 100, offset: 0, labelIds: [a.id] })
    expect(labelList.some((m) => m.id === target.id)).toBe(true)
    const c = await store.createLabel('归档')
    const none = await store.query({ limit: 100, offset: 0, labelIds: [c.id] })
    expect(none).toHaveLength(0)

    // 覆盖式 setMailLabels：移除 a
    await store.setMailLabels(target.id, [b.id])
    const d2 = await store.getMessage(target.id)
    expect(d2?.labels.map((l) => l.id)).toEqual([b.id])

    // 删除标签 → 关联解除、标签消失
    await store.deleteLabel(b.id)
    const d3 = await store.getMessage(target.id)
    expect(d3?.labels).toHaveLength(0)
    expect((await store.listLabels()).map((l) => l.id).sort()).toEqual([a.id, c.id].sort())

    // 取消星标
    await store.setStarred(target.id, false)
    const unstarred = await store.query({ limit: 100, offset: 0, starredOnly: true })
    expect(unstarred.some((m) => m.id === target.id)).toBe(false)
  })

  it('v5 老库升级到 v6：标签表就绪、现有邮件 starred=0（V2 M4）', async () => {
    const legacyPath = path.join(os.tmpdir(), `mail-ai-v5legacy-${process.pid}-${Date.now()}.db`)
    // 手工构造 v5 老库（执行 1..5 迁移 + 数据）
    const raw = new Database(legacyPath)
    for (const m of SCHEMA_MIGRATIONS.filter((x) => x.version <= 5)) {
      for (const sql of m.sql) raw.exec(sql)
      raw.exec(`PRAGMA user_version = ${m.version}`)
    }
    raw
      .prepare(
        `INSERT INTO messages (account_id, uid, subject, from_name, from_addr, body_text, snippet, created_at, folder)
         VALUES (1, 66, 'v5 旧邮件', 'A', 'a@example.edu', '旧正文', '', 1, 'INBOX')`
      )
      .run()
    raw.close()

    const store = new SqliteMessageStore(legacyPath, new MemoryLogger())
    try {
      // v6 迁移后旧邮件可查、starred 缺省 false、labels 为空
      const inbox = await store.query({ limit: 10, offset: 0 })
      const old = inbox.find((m) => m.uid === 66)!
      expect(old.starred).toBe(false)
      expect(old.labels).toHaveLength(0)
      // 新表可用
      const label = await store.createLabel('课业')
      await store.setMailLabels(old.id, [label.id])
      const detail = await store.getMessage(old.id)
      expect(detail?.labels.map((l) => l.name)).toEqual(['课业'])
      await store.setStarred(old.id, true)
      const starred = await store.query({ limit: 10, offset: 0, starredOnly: true })
      expect(starred.some((m) => m.uid === 66)).toBe(true)
    } finally {
      store.close()
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(legacyPath + suffix, { force: true })
        } catch {
          /* ignore */
        }
      }
    }
  })

  it('V2 M5：视图 CRUD + filter/sort 查询（与纯函数同语义）', async () => {
    // 数据准备：已有 uid 103（毕业论文/实验数据）、104（VPN）、107（附件）等
    const label = await store.createLabel('课业')
    const list = await store.query({ limit: 100, offset: 0 })
    const vpn = list.find((m) => m.uid === 104)!
    await store.setMailLabels(vpn.id, [label.id])

    // 保存视图
    const saved = await store.saveView({
      name: 'VPN 邮件',
      filter: { text: 'VPN' },
      sort: { by: 'date', dir: 'desc' }
    })
    expect(saved.id).toBeGreaterThan(0)
    const saved2 = await store.saveView({
      name: '未读+课业标签',
      filter: { unread: true, labelIds: [label.id] },
      sort: { by: 'subject', dir: 'asc' }
    })
    expect((await store.listViews()).map((v) => v.name)).toEqual(['VPN 邮件', '未读+课业标签'])

    // 覆盖保存
    await store.saveView({ id: saved.id, name: 'VPN 视图改', filter: { text: 'VPN' }, sort: { by: 'from', dir: 'asc' } })
    const viewsAfter = await store.listViews()
    expect(viewsAfter.find((v) => v.id === saved.id)?.name).toBe('VPN 视图改')
    expect(viewsAfter).toHaveLength(2)

    // filter 查询：text 命中
    const byText = await store.query({ limit: 100, offset: 0, filter: { text: 'VPN' } })
    expect(byText.some((m) => m.uid === 104)).toBe(true)
    expect(byText.every((m) => m.uid === 104)).toBe(true)

    // filter 查询：unread + labelIds
    await store.markRead(vpn.id, true)
    const byLabel = await store.query({ limit: 100, offset: 0, filter: { labelIds: [label.id], unread: true } })
    expect(byLabel.some((m) => m.uid === 104)).toBe(false)
    await store.markRead(vpn.id, false)
    const byLabel2 = await store.query({ limit: 100, offset: 0, filter: { labelIds: [label.id], unread: true } })
    expect(byLabel2.some((m) => m.uid === 104)).toBe(true)

    // filter 查询：from / hasAttachment / dateFrom/dateTo
    const byFrom = await store.query({ limit: 100, offset: 0, filter: { from: 'lin@example' } })
    expect(byFrom.length).toBeGreaterThan(0)
    expect(byFrom.every((m) => m.fromAddr.includes('lin@example'))).toBe(true)
    const byAtt = await store.query({ limit: 100, offset: 0, filter: { hasAttachment: true } })
    expect(byAtt.some((m) => m.uid === 107)).toBe(true)
    const byDate = await store.query({ limit: 100, offset: 0, filter: { dateFrom: 103_000, dateTo: 104_000 } })
    expect(byDate.every((m) => m.dateTs >= 103_000 && m.dateTs <= 104_000)).toBe(true)
    expect(byDate.some((m) => m.uid === 103)).toBe(true)

    // sort 查询：subject asc（忽略大小写）
    const sorted = await store.query({ limit: 100, offset: 0, sort: { by: 'subject', dir: 'asc' } })
    const subjects = sorted.map((m) => m.subject.toLowerCase())
    expect([...subjects].sort()).toEqual(subjects)

    // 删除视图
    await store.deleteView(saved2.id)
    expect((await store.listViews()).map((v) => v.id)).toEqual([saved.id])
    await store.deleteView(999999) // 幂等不抛
    expect((await store.listViews())).toHaveLength(1)
  })

  it('V2 M6：稍后提醒 CRUD + 到期查询 + 列表/详情透出', async () => {
    const list = await store.query({ limit: 100, offset: 0 })
    const target = list.find((m) => m.uid === 101)!
    const other = list.find((m) => m.uid === 102)!

    // 设置提醒 → 列表与详情透出 snoozeUntil
    const until = 9_999_999_999_999
    await store.setSnooze(target.id, until, '记得跟进')
    const listAfter = await store.query({ limit: 100, offset: 0 })
    expect(listAfter.find((m) => m.id === target.id)?.snoozeUntil).toBe(until)
    expect(listAfter.find((m) => m.id === other.id)?.snoozeUntil).toBeNull()
    const detail = await store.getMessage(target.id)
    expect(detail?.snoozeUntil).toBe(until)

    // 覆盖设置（每封只保留一条未触发）
    const until2 = until + 1
    await store.setSnooze(target.id, until2)
    const detail2 = await store.getMessage(target.id)
    expect(detail2?.snoozeUntil).toBe(until2)

    // 到期查询：只返回未通知且到点的
    await store.setSnooze(other.id, 5000)
    const due = await store.dueSnoozes(6000)
    expect(due.map((d) => d.messageId)).toEqual([other.id])
    expect(due[0].subject).toContain('邮件 102')
    expect(due[0].fromName).toBe('林教授')
    expect(due[0].note).toBeNull()

    // 标记已通知 → 不再到期；列表不再显示提醒
    await store.markSnoozeNotified(due[0].id)
    expect(await store.dueSnoozes(6000)).toHaveLength(0)
    const listAfterNotify = await store.query({ limit: 100, offset: 0 })
    expect(listAfterNotify.find((m) => m.id === other.id)?.snoozeUntil).toBeNull()

    // 取消提醒
    await store.cancelSnooze(target.id)
    const detail3 = await store.getMessage(target.id)
    expect(detail3?.snoozeUntil).toBeNull()
    // 幂等取消
    await store.cancelSnooze(target.id)
    expect((await store.dueSnoozes(until2))).toHaveLength(0)
  })

  it('v7 老库升级到 v8：snoozes 表可用（V2 M6）', async () => {
    const legacyPath = path.join(os.tmpdir(), `mail-ai-v7legacy-${process.pid}-${Date.now()}.db`)
    const raw = new Database(legacyPath)
    for (const m of SCHEMA_MIGRATIONS.filter((x) => x.version <= 7)) {
      for (const sql of m.sql) raw.exec(sql)
      raw.exec(`PRAGMA user_version = ${m.version}`)
    }
    raw
      .prepare(
        `INSERT INTO messages (account_id, uid, subject, from_name, from_addr, body_text, snippet, created_at, folder)
         VALUES (1, 77, 'v7 旧邮件', 'A', 'a@example.edu', '旧正文', '', 1, 'INBOX')`
      )
      .run()
    raw.close()

    const store = new SqliteMessageStore(legacyPath, new MemoryLogger())
    try {
      const inbox = await store.query({ limit: 10, offset: 0 })
      const old = inbox.find((m) => m.uid === 77)!
      expect(old.snoozeUntil).toBeNull()
      await store.setSnooze(old.id, 1234, '老库提醒')
      const due = await store.dueSnoozes(2000)
      expect(due).toHaveLength(1)
      expect(due[0].note).toBe('老库提醒')
    } finally {
      store.close()
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(legacyPath + suffix, { force: true })
        } catch {
          /* ignore */
        }
      }
    }
  })

  it('V2 M7：批量标记已读/未读 + 批量加标签（并入不覆盖）', async () => {
    const list = await store.query({ limit: 100, offset: 0 })
    const a = list.find((m) => m.uid === 101)!
    const b = list.find((m) => m.uid === 102)!
    const c = list.find((m) => m.uid === 103)!

    // 批量已读
    await store.bulkMarkRead([a.id, b.id], true)
    let after = await store.query({ limit: 100, offset: 0 })
    expect(after.find((m) => m.id === a.id)?.unread).toBe(false)
    expect(after.find((m) => m.id === b.id)?.unread).toBe(false)
    expect(after.find((m) => m.id === c.id)?.unread).toBe(true)
    // 批量未读
    await store.bulkMarkRead([a.id], false)
    after = await store.query({ limit: 100, offset: 0 })
    expect(after.find((m) => m.id === a.id)?.unread).toBe(true)

    // 批量加标签：并入现有
    const label1 = await store.createLabel('课业')
    const label2 = await store.createLabel('重要')
    await store.setMailLabels(a.id, [label1.id])
    await store.bulkAddLabels([a.id, b.id, c.id], [label1.id, label2.id])
    const da = await store.getMessage(a.id)
    const db = await store.getMessage(b.id)
    const dc = await store.getMessage(c.id)
    expect(da?.labels.map((l) => l.id).sort()).toEqual([label1.id, label2.id].sort())
    expect(db?.labels.map((l) => l.id).sort()).toEqual([label1.id, label2.id].sort())
    expect(dc?.labels.map((l) => l.id).sort()).toEqual([label1.id, label2.id].sort())
  })

  it('v10 老库升级到 v11：priority_score 列与索引被删除（优先级功能下线）', async () => {
    const legacyPath = path.join(os.tmpdir(), `mail-ai-v10legacy-${process.pid}-${Date.now()}.db`)
    const raw = new Database(legacyPath)
    for (const m of SCHEMA_MIGRATIONS.filter((x) => x.version <= 10)) {
      for (const sql of m.sql) raw.exec(sql)
      raw.exec(`PRAGMA user_version = ${m.version}`)
    }
    const cols = (raw.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('priority_score')
    raw.close()

    const store = new SqliteMessageStore(legacyPath, new MemoryLogger())
    try {
      await store.upsertMessages([makeMsg(501, { subject: '迁移后仍可入库' })])
      const list = await store.query({ limit: 10, offset: 0 })
      expect(list.map((m) => m.uid)).toContain(501)
      const db = (store as unknown as { db: Database.Database }).db
      const after = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name)
      expect(after).not.toContain('priority_score')
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_priority'").all()
      expect(idx).toHaveLength(0)
    } finally {
      store.close()
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(`${legacyPath}${suffix}`)
        } catch {
          /* ignore */
        }
      }
    }
  })

  it('V2 M9：草稿 CRUD（保存/覆盖/删除，本地 only）', async () => {
    const d1 = await store.saveDraft({ toAddrs: ['lin@example.edu'], subject: '课题讨论', body: '正文一' })
    const d2 = await store.saveDraft({ toAddrs: ['a@example.edu', 'b@example.edu'], subject: '组会', body: '正文二' })
    expect(d1.id).toBeGreaterThan(0)
    const all = await store.listDrafts()
    expect(all.map((d) => d.subject)).toEqual(['组会', '课题讨论']) // updated_at 倒序
    expect(all[1].toAddrs).toEqual(['lin@example.edu'])

    // 覆盖保存
    const updated = await store.saveDraft({ id: d1.id, toAddrs: ['lin@example.edu'], subject: '课题讨论 v2', body: '修改后正文' })
    expect(updated.subject).toBe('课题讨论 v2')
    const after = await store.listDrafts()
    expect(after).toHaveLength(2)
    expect(after.find((d) => d.id === d1.id)?.body).toBe('修改后正文')

    // 删除 + 幂等
    await store.deleteDraft(d2.id)
    expect((await store.listDrafts()).map((d) => d.id)).toEqual([d1.id])
    await store.deleteDraft(999999)
    expect(await store.listDrafts()).toHaveLength(1)
  })

  it('v9 老库升级到 v10：drafts 表可用（V2 M9）', async () => {
    const legacyPath = path.join(os.tmpdir(), `mail-ai-v9legacy-${process.pid}-${Date.now()}.db`)
    const raw = new Database(legacyPath)
    for (const m of SCHEMA_MIGRATIONS.filter((x) => x.version <= 9)) {
      for (const sql of m.sql) raw.exec(sql)
      raw.exec(`PRAGMA user_version = ${m.version}`)
    }
    raw.close()

    const store = new SqliteMessageStore(legacyPath, new MemoryLogger())
    try {
      expect(await store.listDrafts()).toHaveLength(0)
      const d = await store.saveDraft({ toAddrs: ['a@example.edu'], subject: '升级后草稿', body: '内容' })
      expect((await store.listDrafts())[0].id).toBe(d.id)
    } finally {
      store.close()
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(legacyPath + suffix, { force: true })
        } catch {
          /* ignore */
        }
      }
    }
  })
  it('V2.1：getMaxUid / listUnsummarized / searchSummaries（同步修复与摘要优先问答的基础）', async () => {
    const inbox = await store.query({ limit: 100, offset: 0 })
    const uid101 = inbox.find((m) => m.uid === 101)!
    const uid102 = inbox.find((m) => m.uid === 102)!
    // getMaxUid = 本地该文件夹最大 UID
    const maxUid = await store.getMaxUid('INBOX')
    expect(maxUid).toBe(Math.max(...inbox.map((m) => m.uid)))
    expect(await store.getMaxUid('不存在文件夹')).toBe(0)

    // listUnsummarized（M1 起 = 双产物待办）：有摘要但没索引卡片，仍算待处理
    await store.saveSummary(uid101.id, '【一句话主旨】关于选课', 'test-model')
    const pending = await store.listUnsummarized(50)
    expect(pending.some((m) => m.id === uid101.id)).toBe(true) // 缺索引卡片
    expect(pending.some((m) => m.id === uid102.id)).toBe(true)
    // 两份产物都齐了才算完成
    await store.saveIndexDoc({
      messageId: uid101.id,
      card: '[TYPE] 选课 | [DUE] 2026-09-20 23:59',
      type: '选课',
      course: null,
      term: null,
      dueTs: new Date(2026, 8, 20, 23, 59).getTime(),
      entities: ['CUSIS'],
      aliases: ['选课系统'],
      questions: ['选课什么时候开始？'],
      model: 'test-model'
    })
    const pending2 = await store.listUnsummarized(50)
    expect(pending2.some((m) => m.id === uid101.id)).toBe(false)
    expect(await store.countMissingIndexDocs()).toBeGreaterThan(0)
    // 上限生效
    expect((await store.listUnsummarized(1)).length).toBeLessThanOrEqual(1)

    // searchSummaries：命中摘要正文与主题
    const bySummary = await store.searchSummaries('选课', 10)
    expect(bySummary.some((h) => h.id === uid101.id)).toBe(true)
    expect(bySummary[0].summary).toContain('关于选课')
    const bySubject = await store.searchSummaries('邮件 102', 10)
    expect(Array.isArray(bySubject)).toBe(true)
    expect(await store.searchSummaries('   ', 10)).toEqual([])
  })

  it('M1：索引卡片检索（关键词/别名/问题）+ 结构化过滤（类型/截止窗口）', async () => {
    const inbox = await store.query({ limit: 100, offset: 0 })
    const target = inbox.find((m) => m.uid === 101)!
    const other = inbox.find((m) => m.uid === 102)!
    const due = new Date(2026, 8, 20, 23, 59).getTime()
    await store.saveIndexDoc({
      messageId: target.id,
      card: '[TYPE] 作业 | [COURSE] ENG1110B | [DUE] 2026-09-20 23:59\n[FACTS]\n- 实验一用 GraderScope 提交',
      type: '作业',
      course: 'ENG1110B',
      term: '2026R1',
      dueTs: due,
      entities: ['GraderScope', 'Lab 0'],
      aliases: ['实验一', 'lab0'],
      questions: ['实验什么时候截止？'],
      model: 'test-model'
    })

    // 关键词命中卡片正文
    const byCard = await store.searchIndexDocs('GraderScope', 10)
    expect(byCard.map((h) => h.id)).toContain(target.id)
    expect(byCard[0].via).toBe('keyword')
    // 别名命中（trigram 需要 >=3 字符）
    expect((await store.searchIndexDocs('实验一', 10)).map((h) => h.id)).toContain(target.id)
    // 结构化过滤：类型 + 截止窗口
    const byFilter = await store.searchIndexByFilter({ type: '作业', dueBefore: due + 1000 }, 10)
    expect(byFilter.map((h) => h.id)).toContain(target.id)
    expect(byFilter[0].dueTs).toBe(due)
    // 不匹配的类型/窗口返回空
    expect(await store.searchIndexByFilter({ type: '广告' }, 10)).toEqual([])
    expect(await store.searchIndexByFilter({ dueBefore: due - 86400000 }, 10)).toEqual([])
    // 无过滤条件直接返回空（避免全库扫描）
    expect(await store.searchIndexByFilter({}, 10)).toEqual([])
    // 排序：未来最近的排前面，过去的排后面（否则老邮件会把新邮件挤出前几名）
    await store.saveIndexDoc({
      messageId: other.id,
      card: '[TYPE] 作业 | [DUE] 2026-09-25 23:59',
      type: '作业',
      course: null,
      term: null,
      dueTs: Date.now() + 5 * 86400000,
      entities: [],
      aliases: [],
      questions: [],
      model: 'test-model'
    })
    await store.saveIndexDoc({
      messageId: target.id,
      card: '[TYPE] 作业 | [DUE] 2026-09-30 23:59',
      type: '作业',
      course: null,
      term: null,
      dueTs: Date.now() + 10 * 86400000,
      entities: [],
      aliases: [],
      questions: [],
      model: 'test-model'
    })
    const ordered = await store.searchIndexByFilter({ type: '作业', hasDue: true }, 10)
    expect(ordered.map((h) => h.id)).toEqual([other.id, target.id])
    // 覆盖保存：FTS 不残留旧内容
    await store.saveIndexDoc({
      messageId: target.id,
      card: '[TYPE] 通知',
      type: '通知',
      course: null,
      term: null,
      dueTs: null,
      entities: [],
      aliases: [],
      questions: [],
      model: 'test-model'
    })
    expect(await store.searchIndexDocs('GraderScope', 10)).toEqual([])
    await store.saveSummary(other.id, '其他邮件摘要', 'test-model')
  })

  it('M3：集合由索引卡片派生（课程/类型多标签）+ 手动移出 + 周报聚合', async () => {
    const inbox = await store.query({ limit: 100, offset: 0 })
    const a = inbox.find((m) => m.uid === 101)!
    const b = inbox.find((m) => m.uid === 102)!
    const now = Date.now()
    // 同一封邮件可以同时属于课程集合与类型集合（多标签，不单桶）
    await store.saveIndexDoc({
      messageId: a.id,
      card: '[TYPE] 作业 | [COURSE] ENG1110B | [DUE] x',
      type: '作业',
      course: 'ENG1110B',
      term: '2026R1',
      dueTs: now + 3 * 86400000,
      entities: ['GraderScope'],
      aliases: ['实验一'],
      questions: [],
      model: 'm'
    })
    await store.saveIndexDoc({
      messageId: b.id,
      card: '[TYPE] 通知 | [COURSE] ENG1110B | [DUE] y',
      type: '通知',
      course: 'ENG1110B',
      term: null,
      dueTs: null,
      entities: ['Blackboard'],
      aliases: [],
      questions: [],
      model: 'm'
    })

    const cols = await store.listCollections()
    const course = cols.find((c) => c.kind === 'course' && c.value === 'ENG1110B')
    expect(course?.count).toBe(2)
    expect(course?.nextDue).toBe(now + 3 * 86400000)
    expect(cols.some((c) => c.kind === 'type' && c.value === '作业')).toBe(true)

    const mails = await store.listCollectionMails('course', 'ENG1110B')
    expect(mails.map((m) => m.id).sort()).toEqual([a.id, b.id].sort())
    expect(mails.find((m) => m.id === a.id)?.entities).toContain('GraderScope')

    // 手动移出（可撤销）：集合默认不做硬分类，但用户可以纠正
    await store.excludeFromCollection(b.id, 'course', 'ENG1110B')
    expect((await store.listCollectionMails('course', 'ENG1110B')).map((m) => m.id)).toEqual([a.id])
    expect((await store.listCollections()).find((c) => c.value === 'ENG1110B')?.count).toBe(1)
    await store.includeInCollection(b.id, 'course', 'ENG1110B')
    expect((await store.listCollectionMails('course', 'ENG1110B'))).toHaveLength(2)

    // 周报：区间内聚合（截止清单按时间升序、类型/课程分布、缺卡片计数）
    // 注意：测试数据的 date_ts 就是 uid（很小的数），所以区间从 1 开始
    const brief = await store.weeklyBrief(1, now + 40 * 86400000)
    expect(brief.newMails).toBeGreaterThan(0)
    expect(brief.dueItems.some((d) => d.id === a.id)).toBe(true)
    expect(brief.byType.some((t) => t.type === '作业')).toBe(true)
    expect(brief.courses.some((c) => c.course === 'ENG1110B')).toBe(true)
    // 区间外（很久以前）不应包含这些邮件
    const empty = await store.weeklyBrief(1, 2)
    expect(empty.newMails).toBe(0)
    expect(empty.dueItems).toEqual([])
  })

  it('V2.1：listUnsummarized(force) 与噪声正文清洗（FTS 同步维护）', async () => {
    await store.upsertMessages([
      makeMsg(601, { subject: '带 CSS 的邮件', bodyText: 'img { max-width: 600px; } @media screen { .a { width: 100% !important; } } 正文要点：就业讲座周五报名。' })
    ])
    const inbox = await store.query({ limit: 100, offset: 0 })
    const target = inbox.find((m) => m.uid === 601)!

    // 噪声正文可被检出
    const noisy = await store.listNoisyBodies(50)
    expect(noisy.some((n) => n.id === target.id)).toBe(true)

    // 清洗后写回：正文干净、FTS 仍能按新正文搜到
    const { cleanMailText } = await import('../../shared/text')
    const cleaned = cleanMailText(noisy.find((n) => n.id === target.id)!.bodyText, null)
    await store.updateBodyText(target.id, cleaned, cleaned.slice(0, 40))
    const after = await store.getMessage(target.id)
    expect(after?.bodyText).not.toContain('max-width')
    expect(after?.bodyText).toContain('就业讲座')
    const hits = await store.search('就业讲座', 10)
    expect(hits.some((h) => h.id === target.id)).toBe(true)

    // force=true 时也返回已有摘要的邮件；M1 起「有摘要但缺索引卡片」也算待处理
    await store.saveSummary(target.id, '【一句话主旨】测试', 'm')
    const missing = await store.listUnsummarized(50, false)
    expect(missing.some((m) => m.id === target.id)).toBe(true) // 缺索引卡片
    await store.saveIndexDoc({
      messageId: target.id,
      card: '[TYPE] 活动',
      type: '活动',
      course: null,
      term: null,
      dueTs: null,
      entities: [],
      aliases: [],
      questions: [],
      model: 'm'
    })
    const missing2 = await store.listUnsummarized(50, false)
    expect(missing2.some((m) => m.id === target.id)).toBe(false)
    const forced = await store.listUnsummarized(50, true)
    expect(forced.some((m) => m.id === target.id)).toBe(true)
  })

  it('M4：聊天会话 CRUD（新建/标题自动取首问/列表排序/引用持久化/删除级联）', async () => {
    const id = await store.createChatSession('新对话')
    expect(id).toBeGreaterThan(0)

    // 空会话：消息为空、条数 0
    expect(await store.getChatMessages(id)).toEqual([])
    let sessions = await store.listChatSessions()
    expect(sessions.find((s) => s.id === id)?.messageCount).toBe(0)

    // 首条用户消息 → 会话标题自动取前 40 字（换行折叠为空格）
    await store.appendChatMessage(id, 'user', '上周导师发了什么邮件？\n还有截止时间吗？')
    const title = (await store.listChatSessions()).find((s) => s.id === id)?.title ?? ''
    expect(title).toBe('上周导师发了什么邮件？ 还有截止时间吗？'.slice(0, 40))

    // 助手消息 + 引用邮件（对象数组，必须原样读回，不能被 String() 化）
    const citations = [
      { id: 9001, subject: '毕业论文进度', fromName: '林教授', dateTs: 1_700_000_000_000 },
      { id: 9002, subject: '缴费通知', fromName: '教务处', dateTs: 1_700_100_000_000 }
    ]
    await store.appendChatMessage(id, 'assistant', '**结论**：周五前回复导师。', citations)
    const msgs = await store.getChatMessages(id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toContain('结论')
    expect(msgs[1].citations).toEqual(citations)

    // 第二条会话：列表按 updated_at 倒序（最新在前）
    const id2 = await store.createChatSession('第二个对话')
    await new Promise((r) => setTimeout(r, 5))
    await store.appendChatMessage(id2, 'user', '这周有什么截止？')
    sessions = await store.listChatSessions()
    expect(sessions[0].id).toBe(id2)
    expect(sessions.find((s) => s.id === id)?.messageCount).toBe(2)
    expect(sessions.find((s) => s.id === id2)?.messageCount).toBe(1)

    // 重命名保留历史消息
    await store.renameChatSession(id2, '截止时间查询')
    expect((await store.listChatSessions()).find((s) => s.id === id2)?.title).toBe('截止时间查询')
    expect((await store.getChatMessages(id2)).length).toBe(1)

    // 删除级联：会话与消息一起消失，其它会话不受影响
    await store.deleteChatSession(id2)
    sessions = await store.listChatSessions()
    expect(sessions.some((s) => s.id === id2)).toBe(false)
    expect(await store.getChatMessages(id2)).toEqual([])
    expect(sessions.some((s) => s.id === id)).toBe(true)
    expect((await store.getChatMessages(id)).length).toBe(2)
  })

  it('M4：跨语言/短词召回与「第一条就命中」（评测暴露的三个短板）', async () => {
    // 造三封：① 英文主题 + 中文卡片的学费邮件；② 主题含繁体「住宿申請」但卡片没写的邮件；③ 泛化汇总邮件
    await store.upsertMessages([
      makeMsg(701, { subject: 'Tuition Fee Notice for Term 1', bodyText: 'Please settle the tuition fee before the deadline.' }),
      makeMsg(702, { subject: 'LATE APPLICATION 2026-2027 年度聯合書院新生住宿申請(本地生適用)', bodyText: 'late application for hostel' }),
      makeMsg(703, { subject: 'Daily Notifications', bodyText: 'New items in Blackboard courses.' })
    ])
    const inbox = await store.query({ limit: 200, offset: 0 })
    const fees = inbox.find((m) => m.uid === 701)!
    const hostel = inbox.find((m) => m.uid === 702)!
    const digest = inbox.find((m) => m.uid === 703)!

    await store.saveIndexDoc({
      messageId: fees.id,
      card: '[TYPE] 行政\n[FACTS]\n- 学费缴纳截止 09-30',
      type: '行政',
      course: null,
      term: null,
      dueTs: null,
      entities: [],
      aliases: [],
      questions: [],
      model: 'test-model'
    })
    await store.saveIndexDoc({
      messageId: hostel.id,
      card: '[TYPE] 行政\n[FACTS]\n- 迟交住宿申請（卡片里没写繁体主题词）',
      type: '行政',
      course: null,
      term: null,
      dueTs: null,
      entities: [],
      aliases: [],
      questions: [],
      model: 'test-model'
    })
    await store.saveIndexDoc({
      messageId: digest.id,
      card: '[TYPE] 通知\n[ALIASES] Blackboard 通知, 每日通知',
      type: '通知',
      course: null,
      term: null,
      dueTs: null,
      entities: [],
      aliases: [],
      questions: [],
      model: 'test-model'
    })

    // ① 中文「学费」+ 英文同义词：跨语言召回（trigram 对 2 字中文无能为力，靠 LIKE 兜底）
    const rqFees = buildRetrievalQuery('学费什么时候交？', '学费 交')
    const feesHits = await store.searchIndexDocs(rqFees.query, 10, { rankTerms: rqFees.terms })
    expect(feesHits.map((h) => h.id)).toContain(fees.id)
    // 真正相关的那封排第一（而不是"最近但无关"的）
    expect(feesHits[0].id).toBe(fees.id)

    // ② 主题里才有繁体「住宿申請」：LIKE 兜底必须带 m.subject
    const rqHostel = buildRetrievalQuery('宿舍或住宿相关通知？', '宿舍 住宿')
    const hostelHits = await store.searchIndexDocs(rqHostel.query, 10, { rankTerms: rqHostel.terms })
    expect(hostelHits.map((h) => h.id)).toContain(hostel.id)
    expect(hostelHits[0].id).toBe(hostel.id)

    // ③ 汇总类邮件（Daily Notifications）不能霸榜：具体邮件优先
    //    真实语料里这类日报有很多封（评测时 5 封霸榜），所以这里也造几封做对照。
    await store.upsertMessages([
      makeMsg(704, { subject: 'CLASS CANCELLED on Monday, Sep 7', bodyText: 'the lecture will be cancelled' }),
      makeMsg(705, { subject: 'Daily Notifications', bodyText: 'digest 2' }),
      makeMsg(706, { subject: 'Daily Notifications', bodyText: 'digest 3' })
    ])
    const all = await store.query({ limit: 200, offset: 0 })
    const specific = all.find((m) => m.uid === 704)!
    const digest2 = all.find((m) => m.uid === 705)!
    const digest3 = all.find((m) => m.uid === 706)!
    for (const m of [digest2, digest3]) {
      await store.saveIndexDoc({
        messageId: m.id,
        card: '[TYPE] 通知\n[ALIASES] Blackboard 通知, 每日通知',
        type: '通知',
        course: null,
        term: null,
        dueTs: null,
        entities: [],
        aliases: ['Blackboard 通知'],
        questions: [],
        model: 'test-model'
      })
    }
    await store.saveIndexDoc({
      messageId: specific.id,
      card: '[TYPE] 通知\n[ENTITIES] Blackboard\n[FACTS]\n- ENGG1040 讲座取消',
      type: '通知',
      course: 'ENGG1040',
      term: null,
      dueTs: null,
      entities: ['Blackboard'],
      aliases: [],
      questions: [],
      model: 'test-model'
    })
    const rqBb = buildRetrievalQuery('Blackboard 上有什么新通知？', 'Blackboard 新通知')
    const bbHits = await store.searchIndexDocs(rqBb.query, 10, { rankTerms: rqBb.terms })
    const bbIds = bbHits.map((h) => h.id)
    // 召回：具体通知与日报都能进候选（排序细节见 retrievalRank.test.ts 的降权用例）
    expect(bbIds).toContain(digest.id)
    expect(bbIds).toContain(specific.id)
    expect([digest2.id, digest3.id].every((id) => bbIds.includes(id))).toBe(true)

    // ④ 正文路（messages）同样按相关性排序：主题命中的排前面
    const bodyHits = await store.search(rqFees.query, 10, { retrieval: true, rankTerms: rqFees.terms })
    expect(bodyHits.map((h) => h.id)).toContain(fees.id)
  })

  it('M4：结构化过滤路保持「未来最近截止优先」（集合视图不做相关性重排）', async () => {
    await store.upsertMessages([
      makeMsg(711, { subject: 'Locker Application / 儲物箱申請' }),
      makeMsg(712, { subject: 'Tuition Fee Notice for Term 1' })
    ])
    const inbox = await store.query({ limit: 200, offset: 0 })
    const a = inbox.find((m) => m.uid === 711)!
    const b = inbox.find((m) => m.uid === 712)!
    const soon = Date.now() + 86_400_000
    const later = Date.now() + 5 * 86_400_000
    // 相关性上「学费」只在 b 上，但 b 的截止更晚 → 过滤路仍按截止时间排（a 在前）
    await store.saveIndexDoc({
      messageId: a.id, card: '[TYPE] 行政', type: '行政', course: null, term: null, dueTs: soon,
      entities: [], aliases: [], questions: [], model: 'm'
    })
    await store.saveIndexDoc({
      messageId: b.id, card: '[TYPE] 行政\n[FACTS]\n- 学费缴纳', type: '行政', course: null, term: null, dueTs: later,
      entities: [], aliases: [], questions: [], model: 'm'
    })
    const filtered = await store.searchIndexByFilter({ type: '行政' }, 10)
    const ids = filtered.filter((h) => h.id === a.id || h.id === b.id).map((h) => h.id)
    expect(ids).toEqual([a.id, b.id])
  })

  it('V2.2：自动标签（规则/AI 两种来源）+ 示例邮件 + 按标签查询', async () => {
    await store.upsertMessages([
      makeMsg(801, { subject: 'Internships and Job Openings' }),
      makeMsg(802, { subject: '选课缴费通知' })
    ])
    const inbox = await store.query({ limit: 300, offset: 0 })
    const a = inbox.find((m) => m.uid === 801)!
    const b = inbox.find((m) => m.uid === 802)!

    await store.saveMailTags(a.id, ['实习', '招聘'], 'ai')
    await store.saveMailTags(a.id, ['通知', '有截止'], 'rule')
    await store.saveMailTags(b.id, ['行政'], 'rule')

    // 覆盖式写入：同来源重复保存只保留最后一次
    await store.saveMailTags(a.id, ['实习'], 'ai')
    const tags = await store.getMailTags([a.id, b.id])
    expect(tags.get(a.id)?.sort()).toEqual(['实习', '有截止', '通知'].sort())
    expect(tags.get(b.id)).toEqual(['行政'])

    // 列表查询会带上 autoTags（列表页直接显示 chip）
    const listed = await store.query({ limit: 300, offset: 0, autoTags: ['行政'] })
    expect(listed.map((m) => m.id)).toEqual([b.id])
    expect(listed[0].autoTags).toEqual(['行政'])

    // 计数
    const counts = await store.listTagCounts()
    expect(counts.find((c) => c.tag === '行政')?.count).toBe(1)

    // 示例邮件（给 AI 打标签当参考）
    await store.setTagExample(a.id, ['实习', '招聘'])
    const examples = await store.listTagExamples()
    expect(examples[0]).toMatchObject({ id: a.id, tags: ['实习', '招聘'] })
    await store.setTagExample(a.id, [])
    expect(await store.listTagExamples()).toEqual([])

    // 规则标签可由索引卡片整体重算（A 方案，零 AI 成本）
    await store.saveIndexDoc({
      messageId: a.id,
      card: '[TYPE] 通知 | [COURSE] ENG1110B',
      type: '通知',
      course: 'ENG1110B',
      term: null,
      dueTs: Date.now() + 3600_000,
      entities: ['Blackboard'],
      aliases: [],
      questions: [],
      model: 'm'
    })
    const n = await store.rebuildRuleTags()
    expect(n).toBeGreaterThan(0)
    const after = await store.getMailTags([a.id])
    // 规则标签最多 4 个：类型 + 课程号 + 平台 + 截止状态
    expect(after.get(a.id)).toEqual(expect.arrayContaining(['通知', 'ENG1110B', 'Blackboard', '紧急']))
  })

  it('V2.2 性能：1000+ 封邮件列表附带标签不会踩 SQL 变量上限、也不慢', async () => {
    const bulk: IncomingMessage[] = []
    for (let i = 0; i < 1200; i += 1) {
      bulk.push(makeMsg(9000 + i, { subject: `批量邮件 ${i}`, folder: 'INBOX', dateTs: 1_700_000_000_000 + i }))
    }
    await store.upsertMessages(bulk)
    const listed = await store.query({ limit: 1500, offset: 0 })
    expect(listed.length).toBeGreaterThan(1000)
    // 给前 500 封写标签（覆盖分块路径），再查一次：必须成功且每个都带上 autoTags 字段
    for (const m of listed.slice(0, 500)) {
      await store.saveMailTags(m.id, ['批量标签'], 'rule')
    }
    const t0 = Date.now()
    const again = await store.query({ limit: 1500, offset: 0 })
    const elapsed = Date.now() - t0
    expect(again.length).toBeGreaterThan(1000)
    expect(again.filter((m) => (m.autoTags ?? []).includes('批量标签')).length).toBe(500)
    // 真机卡顿的阈值：一次列表查询（含标签回填）应在 1.5 秒内
    expect(elapsed).toBeLessThan(1500)
  })

  it('V2.2：统一标签 —— 手动标签不被重算覆盖、删掉的自动标签不会被加回来', async () => {
    await store.upsertMessages([makeMsg(881, { subject: '手动标签用例', dateTs: Date.now() })])
    const item = (await store.query({ limit: 300, offset: 0 })).find((m) => m.uid === 881)!
    expect(item).toBeTruthy()
    // 自动标签（规则）
    await store.saveMailTags(item.id, ['作业', 'ENG1110B'], 'rule')
    // 手动加两个标签，并删掉一个自动标签
    await store.setMailTagManual(item.id, '课业', true)
    await store.setMailTagManual(item.id, '作业', false)

    let detail = (await store.getMessage(item.id)) as unknown as { autoTags?: string[]; manualTags?: string[] }
    expect(detail.manualTags).toEqual(['课业'])
    expect(detail.autoTags).toContain('课业')
    expect(detail.autoTags).not.toContain('作业') // 被手动删掉了

    // 重算规则标签：手动标签保留，删掉的自动标签不会回来
    await store.saveMailTags(item.id, ['作业', 'ENG1110B', '紧急'], 'rule')
    detail = (await store.getMessage(item.id)) as unknown as { autoTags?: string[]; manualTags?: string[] }
    expect(detail.autoTags).toContain('课业')
    expect(detail.autoTags).toContain('ENG1110B')
    expect(detail.autoTags).not.toContain('作业')

    // 手动再加回来 → 抑制解除
    await store.setMailTagManual(item.id, '作业', true)
    detail = (await store.getMessage(item.id)) as unknown as { manualTags?: string[] }
    expect(detail.manualTags).toContain('作业')

    // 统计包含手动标签（侧边栏/标签面板要用）
    const counts = await store.listTagCounts()
    expect(counts.find((c) => c.tag === '课业')?.count).toBe(1)
  })

  it('V2.2 性能：正文搬到 message_bodies —— 列表查询不再读正文（大邮件也不拖慢列表）', async () => {
    // 造一封「HTML 正文 8MB」的邮件（真机最大单封 11.6MB，正是切页卡顿的根因）
    const hugeHtml = `<html><body>${'<p>很长的正文段落，用于模拟真实 HTML 邮件。</p>'.repeat(60_000)}</body></html>`
    await store.upsertMessages([
      makeMsg(771, { subject: '超大正文邮件', bodyHtml: hugeHtml, bodyText: '短正文', dateTs: Date.now() })
    ])
    // 列表查询不受影响：不返回正文，也不把正文读进内存
    const t0 = Date.now()
    const listed = await store.query({ limit: 300, offset: 0 })
    const listMs = Date.now() - t0
    const item = listed.find((m) => m.uid === 771)!
    expect(item).toBeTruthy()
    expect((item as unknown as { bodyHtml?: string }).bodyHtml).toBeUndefined()
    expect(listMs).toBeLessThan(300)

    // 正文仍能按需读到（详情）
    const detail = (await store.getMessage(item.id))!
    expect(detail.bodyHtml?.length).toBe(hugeHtml.length)
    expect(detail.bodyText).toBe('短正文')

    // messages 表里不再存正文（迁移后列值为 NULL）
    const raw = store['db'].prepare('SELECT body_text, body_html FROM messages WHERE id = ?').get(item.id) as {
      body_text: string | null
      body_html: string | null
    }
    expect(raw.body_text).toBeNull()
    expect(raw.body_html).toBeNull()

    // 正文清洗回写路径（噪声修复）也要写到正文字表
    await store.updateBodyText(item.id, '清洗后的正文', '清洗后的摘要')
    const after = (await store.getMessage(item.id))!
    expect(after.bodyText).toBe('清洗后的正文')
    expect(after.snippet).toBe('清洗后的摘要')
  })

  it('V2.2：红旗标记 + 彩色类别 + 真实总数（countMails）', async () => {
    await store.upsertMessages([
      makeMsg(951, { subject: '红旗用例', dateTs: Date.now() }),
      makeMsg(952, { subject: '类别用例', dateTs: Date.now() - 1000 })
    ])
    const list = await store.query({ limit: 300, offset: 0 })
    const a = list.find((m) => m.uid === 951)!
    const b = list.find((m) => m.uid === 952)!

    // 总数与列表同条件（不再只看「已加载的 200 封」）—— 列表受 limit 限制，总数应 >= 列表长度
    const totalAll = await store.countMails({ limit: 0, offset: 0 })
    expect(totalAll).toBeGreaterThanOrEqual(list.length)
    const all = await store.query({ limit: 100000, offset: 0 })
    expect(totalAll).toBe(all.length)
    await store.setFlagged(a.id, true)
    const flagged = await store.query({ limit: 300, offset: 0, flaggedOnly: true })
    expect(flagged.map((m) => m.id)).toEqual([a.id])
    expect(flagged[0].flagged).toBe(true)
    expect(await store.countMails({ limit: 0, offset: 0, flaggedOnly: true })).toBe(1)
    await store.setFlagged(a.id, false)
    expect((await store.query({ limit: 300, offset: 0, flaggedOnly: true })).length).toBe(0)

    // 彩色类别：默认 6 个（Gmail 同款）
    const cats = await store.listCategories()
    expect(cats.length).toBeGreaterThanOrEqual(6)
    expect(cats[0].color).toMatch(/^#/)
    const created = await store.createCategory('我的重点', '#123456')
    expect((await store.createCategory('我的重点', '#abcdef')).id).toBe(created.id) // 重名返回已有
    await store.updateCategory(created.id, { color: '#654321' })
    expect((await store.listCategories()).find((c) => c.id === created.id)?.color).toBe('#654321')

    // 指派类别 → 列表带类别 + 可按类别筛选
    await store.setMailCategory(b.id, created.id)
    const withCat = await store.query({ limit: 300, offset: 0, categoryId: created.id })
    expect(withCat.map((m) => m.id)).toEqual([b.id])
    expect(withCat[0].category?.name).toBe('我的重点')
    const detail = await store.getMessage(b.id)
    expect(detail?.category?.color).toBe('#654321')

    // 删除类别 → 邮件上的引用一并清除
    await store.deleteCategory(created.id)
    expect((await store.getMessage(b.id))?.category ?? null).toBeNull()
    expect((await store.query({ limit: 300, offset: 0, categoryId: created.id })).length).toBe(0)
  })

  it('M4：chat 表在 v13 老库升级后可用（迁移幂等）', async () => {
    const legacyPath = path.join(os.tmpdir(), `mail-ai-chat-legacy-${process.pid}-${Date.now()}.db`)
    const legacy = new Database(legacyPath)
    // 造一个 v13 的库：只跑 v14（chat-sessions）之前的迁移
    const chat = SCHEMA_MIGRATIONS.find((m) => m.version === 14)!
    expect(chat.name).toBe('chat-sessions')
    for (const m of SCHEMA_MIGRATIONS) {
      if (m.version >= 14) continue
      for (const sql of m.sql) legacy.exec(sql)
    }
    legacy.pragma('user_version = 13')
    legacy.close()

    const upgradedLogger = new MemoryLogger()
    const upgraded = new SqliteMessageStore(legacyPath, upgradedLogger)
    // 迁移日志里的版本号 = 迁移后版本（v13 → v14）
    expect(upgradedLogger.entries.find((e) => e.event === 'db.migrated')?.extra?.size).toBe(SCHEMA_MIGRATIONS.length)
    const sid = await upgraded.createChatSession('升级后新建')
    await upgraded.appendChatMessage(sid, 'user', '能查知识库吗？')
    expect((await upgraded.getChatMessages(sid)).length).toBe(1)
    upgraded.close()
    fs.rmSync(legacyPath, { force: true })
  })
})
