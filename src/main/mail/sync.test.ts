import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { computeSyncPlan, SyncEngine } from './sync'
import type { IncomingMessage } from '../db/store'
import { AppError, ErrorCodes } from '../../shared/error-codes'
import { FakeMailProvider, buildSimpleEml, InMemoryMessageStore } from '../../../tests/helpers/fakes'
import { MemoryLogger } from '../logger'
import { SqliteMessageStore } from '../db/sqlite'

describe('computeSyncPlan —— UIDVALIDITY/UID 状态机（规范 §6.4）', () => {
  const mailbox = { uidValidity: 7, exists: 120, uidNext: 121 }

  it('无历史状态 → 全量窗口（最近 20 封：uid 101..120）', () => {
    const plan = computeSyncPlan(null, mailbox, 20)
    expect(plan.mode).toBe('full')
    expect(plan.uids).toHaveLength(20)
    expect(plan.uids[0]).toBe(101)
    expect(plan.uids[19]).toBe(120)
  })

  it('UIDVALIDITY 变化 → 丢弃历史全量重同步', () => {
    const plan = computeSyncPlan({ uidValidity: 3, lastUid: 118 }, mailbox, 20)
    expect(plan.mode).toBe('full')
    expect(plan.uids[0]).toBe(101)
  })

  it('UIDVALIDITY 相同 → 增量 lastUid+1..uidNext-1', () => {
    const plan = computeSyncPlan({ uidValidity: 7, lastUid: 115 }, mailbox, 20)
    expect(plan.mode).toBe('incremental')
    expect(plan.uids).toEqual([116, 117, 118, 119, 120])
  })

  it('无新邮件 → uptodate', () => {
    const plan = computeSyncPlan({ uidValidity: 7, lastUid: 120 }, mailbox, 20)
    expect(plan.mode).toBe('uptodate')
    expect(plan.uids).toEqual([])
  })

  it('窗口下限不小于 1', () => {
    const plan = computeSyncPlan(null, { uidValidity: 1, exists: 5, uidNext: 6 }, 20)
    expect(plan.uids[0]).toBe(1)
    expect(plan.uids).toHaveLength(5)
  })

  it('window=0（全部历史）→ 从 UID 1 全量', () => {
    const plan = computeSyncPlan(null, mailbox, 0)
    expect(plan.mode).toBe('full')
    expect(plan.uids[0]).toBe(1)
    expect(plan.uids).toHaveLength(120)
  })

  it('老用户升级（lastUid 已推进但 fullHistory=false）+ window=0 → 重新全量回扫历史', () => {
    const plan = computeSyncPlan({ uidValidity: 7, lastUid: 120, fullHistory: false }, mailbox, 0)
    expect(plan.mode).toBe('full')
    expect(plan.uids[0]).toBe(1)
  })

  it('fullHistory=true + window=0 → 增量 lastUid+1', () => {
    const plan = computeSyncPlan({ uidValidity: 7, lastUid: 115, fullHistory: true }, mailbox, 0)
    expect(plan.mode).toBe('incremental')
    expect(plan.uids).toEqual([116, 117, 118, 119, 120])
  })

  it('window>0 时不受 fullHistory 影响（不回扫历史）', () => {
    const plan = computeSyncPlan({ uidValidity: 7, lastUid: 115, fullHistory: false }, mailbox, 20)
    expect(plan.mode).toBe('incremental')
    expect(plan.uids).toEqual([116, 117, 118, 119, 120])
  })
})

function makeProvider(uids: number[], mailbox: Partial<{ uidValidity: number; exists: number; uidNext: number }> = {}) {
  const bodies = new Map<number, Buffer>()
  for (const uid of uids) bodies.set(uid, buildSimpleEml(`邮件 ${uid}`, `正文 ${uid}`, `sender${uid}@example.edu <s${uid}@example.edu>`))
  return new FakeMailProvider({
    bodies,
    mailbox: { uidValidity: 7, uidNext: Math.max(...uids, 0) + 1, ...mailbox }
  })
}

/** 构造一封可直接入库的邮件（对账测试里预置「本地已有」的 UID） */
function makeParsed(uid: number, bodyText = ''): IncomingMessage {
  return {
    uid,
    subject: `s${uid}`,
    fromName: 'A',
    fromAddr: 'a@example.edu',
    toAddrs: [],
    ccAddrs: [],
    dateHdr: null,
    dateTs: uid,
    messageId: `<m${uid}@example.edu>`,
    threadId: `t-${uid}`,
    references: [],
    inReplyTo: null,
    bodyText,
    bodyHtml: null,
    snippet: '',
    attachments: [],
    flags: [],
    folder: 'INBOX'
  }
}

describe('SyncEngine.run —— 契约测试（FakeMailProvider + InMemoryStore）', () => {
  it('首次全量：拉取窗口内 UID、入库、推进 lastUid 到最大成功 UID', async () => {
    const provider = makeProvider([101, 102, 103, 104, 105])
    provider.mailbox = { uidValidity: 7, exists: 105, uidNext: 106 }
    const store = new InMemoryMessageStore()
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid, flags) => {
        // 走真实 mailparser 的替代：直接构造 ParsedMessage 会绕过解析层。
        // 这里用一个假 parser 保持契约（真实 mailparser 在 mime.test.ts 覆盖）
        return {
          uid,
          subject: `s${uid}`,
          fromName: 'A',
          fromAddr: 'a@example.edu',
          toAddrs: [],
          ccAddrs: [],
          dateHdr: null,
          dateTs: uid,
          messageId: `<m${uid}>`,
          references: [],
          inReplyTo: null,
          bodyText: String(raw),
          bodyHtml: null,
          snippet: '',
          attachments: [],
          flags
        }
      },
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run()
    expect(result.mode).toBe('full')
    expect(result.synced).toBe(5)
    expect(await store.count()).toBe(5)
    const state = await store.getSyncState()
    expect(state).toEqual({ uidValidity: 7, lastUid: 105, folder: 'INBOX' })
  })

  it('增量：补齐服务端有、本地没有的 UID（含游标之前的漏信）', async () => {
    const provider = makeProvider([101, 102, 103])
    provider.mailbox = { uidValidity: 7, exists: 103, uidNext: 104 }
    const store = new InMemoryMessageStore()
    // 本地只真的有 101；游标也已推进到 101 —— 102/103 属于新增
    await store.upsertMessages([makeParsed(101)])
    await store.setSyncState({ uidValidity: 7, lastUid: 101 })
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => makeParsed(uid, String(raw)),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run()
    expect(result.mode).toBe('incremental')
    expect(provider.fetchedUids).toEqual([102, 103])
    expect(result.newUids).toEqual([102, 103])
    expect((await store.getSyncState())?.lastUid).toBe(103)
  })

  it('权威对账：游标越过真实邮件（服务器 5 封、本地只有 3 封）也会自动补回', async () => {
    // 真机回归：服务器 exists=167、uidNext=2158，本地只有 165 封、maxUid=2144，
    // 游标却已经推进到 2148 → 旧的「游标 +1..uidNext-1」区间扫描永远看不到 2145/2147。
    const provider = makeProvider([101, 102, 103, 105, 107])
    provider.mailbox = { uidValidity: 7, exists: 5, uidNext: 108 }
    const store = new InMemoryMessageStore()
    await store.upsertMessages([makeParsed(101), makeParsed(103), makeParsed(107)])
    await store.setSyncState({ uidValidity: 7, lastUid: 107, fullHistory: true })
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => makeParsed(uid, String(raw)),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run()
    expect(provider.fetchedUids.sort((a, b) => a - b)).toEqual([102, 105])
    expect(await store.count()).toBe(5)
    expect((await store.getSyncState())?.lastUid).toBe(107)
  })

  it('UID SEARCH 不可用 → 退回 envelope 区间扫描（不影响同步）', async () => {
    const provider = makeProvider([101, 102])
    provider.searchAllUidsFails = true
    provider.mailbox = { uidValidity: 7, exists: 2, uidNext: 103 }
    const store = new InMemoryMessageStore()
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => makeParsed(uid, String(raw)),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run()
    expect(result.synced).toBe(2)
    expect(provider.fetchedUids).toEqual([101, 102])
  })

  it('UIDVALIDITY 变化 → 全量重同步并落新 UIDVALIDITY', async () => {
    const provider = makeProvider([101, 102])
    provider.mailbox = { uidValidity: 9, exists: 102, uidNext: 103 }
    const store = new InMemoryMessageStore()
    await store.setSyncState({ uidValidity: 7, lastUid: 102 })
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => ({
        uid,
        subject: 's',
        fromName: 'A',
        fromAddr: 'a@example.edu',
        toAddrs: [],
        ccAddrs: [],
        dateHdr: null,
        dateTs: uid,
        messageId: null,
        references: [],
        inReplyTo: null,
        bodyText: '',
        bodyHtml: null,
        snippet: '',
        attachments: [],
        flags: []
      }),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run()
    expect(result.mode).toBe('full')
    expect((await store.getSyncState())?.uidValidity).toBe(9)
  })

  it('取信失败 → 不推进 lastUid，抛 SYNC_FAILED（下次重试断点续传）', async () => {
    const provider = makeProvider([101, 102, 103])
    provider.mailbox = { uidValidity: 7, exists: 103, uidNext: 104 }
    provider.failUids.add(102)
    const store = new InMemoryMessageStore()
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => ({
        uid,
        subject: 's',
        fromName: 'A',
        fromAddr: 'a@example.edu',
        toAddrs: [],
        ccAddrs: [],
        dateHdr: null,
        dateTs: uid,
        messageId: null,
        references: [],
        inReplyTo: null,
        bodyText: '',
        bodyHtml: null,
        snippet: '',
        attachments: [],
        flags: []
      }),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    await expect(engine.run()).rejects.toMatchObject({ code: 'SYNC_FAILED' })
    expect((await store.getSyncState())?.lastUid).toBe(101)
  })

  it('uid 不存在（已删除）→ 跳过并继续推进', async () => {
    const provider = makeProvider([101, 103])
    provider.mailbox = { uidValidity: 7, exists: 2, uidNext: 104 }
    const store = new InMemoryMessageStore()
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => ({
        uid,
        subject: 's',
        fromName: 'A',
        fromAddr: 'a@example.edu',
        toAddrs: [],
        ccAddrs: [],
        dateHdr: null,
        dateTs: uid,
        messageId: null,
        references: [],
        inReplyTo: null,
        bodyText: '',
        bodyHtml: null,
        snippet: '',
        attachments: [],
        flags: []
      }),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run()
    expect(result.synced).toBe(2)
    expect((await store.getSyncState())?.lastUid).toBe(103)
  })

  it('uptodate：不产生任何 fetch', async () => {
    const provider = makeProvider([101])
    provider.mailbox = { uidValidity: 7, exists: 1, uidNext: 102 }
    const store = new InMemoryMessageStore()
    await store.upsertMessages([makeParsed(101)])
    await store.setSyncState({ uidValidity: 7, lastUid: 101, fullHistory: true })
    const engine = new SyncEngine({
      provider,
      store,
      parse: async () => {
        throw new Error('should not parse')
      },
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run()
    expect(result.mode).toBe('uptodate')
    expect(provider.fetchedUids).toEqual([])
  })

  it('服务端有、本地没有的邮件即使在游标之前，也会被对账补回来（标记为增量）', async () => {
    const provider = makeProvider([101, 102])
    provider.mailbox = { uidValidity: 7, exists: 2, uidNext: 103 }
    const store = new InMemoryMessageStore()
    await store.upsertMessages([makeParsed(101)])
    await store.setSyncState({ uidValidity: 7, lastUid: 102, fullHistory: true })
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => makeParsed(uid, String(raw)),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run()
    expect(result.mode).toBe('incremental')
    expect(provider.fetchedUids).toEqual([102])
    expect(await store.count()).toBe(2)
  })

  it('run(windowOverride=0)：全量同步后落 fullHistory=true（升级场景覆盖）', async () => {
    const provider = makeProvider([101, 102])
    provider.mailbox = { uidValidity: 7, exists: 102, uidNext: 103 }
    const store = new InMemoryMessageStore()
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => ({
        uid,
        subject: 's',
        fromName: 'A',
        fromAddr: 'a@example.edu',
        toAddrs: [],
        ccAddrs: [],
        dateHdr: null,
        dateTs: uid,
        messageId: null,
        references: [],
        inReplyTo: null,
        bodyText: String(raw),
        bodyHtml: null,
        snippet: '',
        attachments: [],
        flags: []
      }),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run(undefined, 0)
    expect(result.mode).toBe('full')
    expect(result.synced).toBe(2)
    const state = await store.getSyncState()
    expect(state?.lastUid).toBe(102)
    expect(state?.fullHistory).toBe(true)
  })

  it('connect 抛 AUTH_INVALID_GRANT → 透传真实错误码（不伪装成网络错误）', async () => {
    const provider = makeProvider([101])
    provider.connect = async () => {
      throw new AppError(ErrorCodes.AUTH_INVALID_GRANT, '登录已失效，请重新登录。')
    }
    const engine = new SyncEngine({
      provider,
      store: new InMemoryMessageStore(),
      parse: async () => {
        throw new Error('should not parse')
      },
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    await expect(engine.run()).rejects.toMatchObject({ code: 'AUTH_INVALID_GRANT' })
  })

  it('个别邮件解析失败 → 跳过继续，不中断整个同步（部分邮件读不到的兜底）', async () => {
    const provider = makeProvider([101, 102, 103])
    provider.mailbox = { uidValidity: 7, exists: 3, uidNext: 104 }
    const store = new InMemoryMessageStore()
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => {
        if (uid === 102) throw new Error('bad mime')
        return {
          uid,
          subject: 's',
          fromName: 'A',
          fromAddr: 'a@example.edu',
          toAddrs: [],
          ccAddrs: [],
          dateHdr: null,
          dateTs: uid,
          messageId: null,
          references: [],
          inReplyTo: null,
          bodyText: String(raw),
          bodyHtml: null,
          snippet: '',
          attachments: [],
          flags: []
        }
      },
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run()
    expect(result.synced).toBe(2)
    expect((await store.getSyncState())?.lastUid).toBe(103)
  })

  it('多文件夹：每文件夹独立 UIDVALIDITY/UID 状态，互不污染（V2 M3）', async () => {
    const provider = makeProvider([101, 102])
    provider.mailbox = { uidValidity: 7, exists: 102, uidNext: 103 }
    provider.folderMailboxes.set('Sent', { uidValidity: 8, exists: 0, uidNext: 1 })
    const store = new InMemoryMessageStore()
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => ({
        uid,
        subject: 's',
        fromName: 'A',
        fromAddr: 'a@example.edu',
        toAddrs: [],
        ccAddrs: [],
        dateHdr: null,
        dateTs: uid,
        messageId: null,
        references: [],
        inReplyTo: null,
        bodyText: String(raw),
        bodyHtml: null,
        snippet: '',
        attachments: [],
        flags: []
      }),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const result = await engine.run(undefined, 0, ['INBOX', 'Sent'])
    expect(result.folders).toEqual(['INBOX', 'Sent'])
    const inbox = await store.getSyncState('INBOX')
    expect(inbox?.uidValidity).toBe(7)
    expect(inbox?.lastUid).toBe(102)
    expect(inbox?.folder).toBe('INBOX')
    const sent = await store.getSyncState('Sent')
    expect(sent?.uidValidity).toBe(8)
    expect(sent?.folder).toBe('Sent')
  })

  it('并发 run() 不丢附件（回归：M3 收件箱首次进入双重同步 + 真实 SqliteMessageStore）', async () => {
    // 收件箱首次挂载时「首次同步」与「文件夹切换」两个 effect 各触发一次 sync，
    // 两个 run() 并发对同一批 UID 做 UPSERT。回归验证附件/摘要落对行且 FTS 可用。
    const dbPath = path.join(os.tmpdir(), `mail-ai-sync-conc-${process.pid}-${Date.now()}.db`)
    const provider = makeProvider([101, 102, 103, 104, 105])
    provider.mailbox = { uidValidity: 7, exists: 105, uidNext: 106 }
    const store = new SqliteMessageStore(dbPath, new MemoryLogger())
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => ({
        uid,
        subject: `s${uid}`,
        fromName: 'A',
        fromAddr: 'a@example.edu',
        toAddrs: [],
        ccAddrs: [],
        dateHdr: null,
        dateTs: uid,
        messageId: `<m${uid}>`,
        references: [],
        inReplyTo: null,
        bodyText: `正文 ${uid} 选课缴费`,
        bodyHtml: null,
        snippet: '',
        attachments:
          uid === 101
            ? [{ partId: '2', filename: '课件.pdf', contentType: 'application/pdf', size: 2048, contentId: null, disposition: 'attachment' }]
            : [],
        flags: []
      }),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    try {
      await Promise.all([engine.run(), engine.run()])
      const all = await store.query({ limit: 100, offset: 0 })
      const row = all.find((m) => m.uid === 101)!
      expect(row.hasAttachments).toBe(true)
      const detail = await store.getMessage(row.id)
      expect(detail?.attachments).toHaveLength(1)
      expect(detail?.attachments[0].filename).toBe('课件.pdf')
      expect(detail?.attachments[0].partId).toBe('2')
      const hits = await store.search('选课', 10)
      expect(hits.some((h) => h.uid === 101)).toBe(true)
    } finally {
      store.close()
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(dbPath + suffix, { force: true })
        } catch {
          /* ignore */
        }
      }
    }
  })
})

describe('SyncEngine —— envelope 预扫描与取信健壮性（V2.1 真机回归）', () => {
  it('envelope 确认存在的邮件取不到正文 → 重试一次且游标不越过它', async () => {
    const provider = makeProvider([101, 102, 103])
    provider.mailbox = { uidValidity: 7, exists: 3, uidNext: 104 }
    // 102 在 envelope 里存在，但正文永久取不到（模拟慢服务器/取信失败）
    let fetchAttempts = 0
    const origFetch = provider.fetchBody.bind(provider)
    provider.fetchBody = async (uid: number) => {
      if (uid === 102) {
        fetchAttempts += 1
        return null
      }
      return origFetch(uid)
    }
    const store = new InMemoryMessageStore()
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => ({
        uid,
        subject: `s${uid}`,
        fromName: 'A',
        fromAddr: 'a@example.edu',
        toAddrs: [],
        ccAddrs: [],
        dateHdr: null,
        dateTs: uid,
        messageId: null,
        references: [],
        inReplyTo: null,
        bodyText: String(raw),
        bodyHtml: null,
        snippet: '',
        attachments: [],
        flags: []
      }),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const res = await engine.run(undefined, 0, ['INBOX'])
    expect(res.synced).toBe(2)
    expect(fetchAttempts).toBe(2) // 首取 + 重试一次
    const state = await store.getSyncState('INBOX')
    // 游标停在 101（即 102 之前），下次同步会继续尝试补回这封
    expect(state?.lastUid).toBe(101)
  })

  it('服务端已删除的 UID 由 envelope 扫描直接跳过（不再逐个试探正文）', async () => {
    const provider = makeProvider([101, 105]) // 102..104 不存在
    provider.mailbox = { uidValidity: 7, exists: 2, uidNext: 106 }
    let fetchCalls = 0
    const origFetch = provider.fetchBody.bind(provider)
    provider.fetchBody = async (uid: number) => {
      fetchCalls += 1
      return origFetch(uid)
    }
    const store = new InMemoryMessageStore()
    const engine = new SyncEngine({
      provider,
      store,
      parse: async (raw, uid) => ({
        uid,
        subject: `s${uid}`,
        fromName: 'A',
        fromAddr: 'a@example.edu',
        toAddrs: [],
        ccAddrs: [],
        dateHdr: null,
        dateTs: uid,
        messageId: null,
        references: [],
        inReplyTo: null,
        bodyText: String(raw),
        bodyHtml: null,
        snippet: '',
        attachments: [],
        flags: []
      }),
      logger: new MemoryLogger(),
      syncWindow: 20
    })
    const res = await engine.run(undefined, 0, ['INBOX'])
    expect(res.synced).toBe(2)
    expect(fetchCalls).toBe(2) // 只对真实存在的 2 封取正文
    expect((await store.getSyncState('INBOX'))?.lastUid).toBe(105)
  })
})
