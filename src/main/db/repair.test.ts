import { describe, expect, it } from 'vitest'
import { InMemoryMessageStore } from '../../../tests/helpers/fakes'
import { MemoryLogger } from '../logger'
import { makeRepairSnippet, repairNoisyBodies } from './repair'

const CSS_BODY = `img { max-width: 600px; } @media screen { .a { width: 100% !important; } }
Welcome to the programme. Best regards, Vicky Long`

function msg(uid: number, bodyText: string, bodyHtml: string | null = null): Parameters<InMemoryMessageStore['upsertMessages']>[0][number] {
  return {
    uid,
    subject: `邮件 ${uid}`,
    fromName: 'A',
    fromAddr: 'a@example.edu',
    toAddrs: [],
    ccAddrs: [],
    dateHdr: null,
    dateTs: uid * 1000,
    messageId: null,
    threadId: `t-${uid}`,
    references: [],
    inReplyTo: null,
    bodyText,
    bodyHtml,
    snippet: '',
    attachments: [],
    flags: []
  }
}

describe('repairNoisyBodies —— 存量正文 CSS 噪声清洗（V2.1 真机回归）', () => {
  it('把混入 CSS 的正文改写成干净文本，干净邮件不动', async () => {
    const store = new InMemoryMessageStore()
    await store.upsertMessages([
      msg(101, CSS_BODY, '<html><body><p>Welcome to the programme.</p><p>Best regards, Vicky Long</p></body></html>'),
      msg(102, '普通通知：请周五前提交实验报告。')
    ])
    const fixed = await repairNoisyBodies(store, new MemoryLogger())
    expect(fixed).toBe(1)

    const list = await store.query({ limit: 10, offset: 0 })
    const dirty = list.find((m) => m.uid === 101)!
    const clean = list.find((m) => m.uid === 102)!
    const dirtyDetail = await store.getMessage(dirty.id)
    expect(dirtyDetail?.bodyText).not.toContain('max-width')
    expect(dirtyDetail?.bodyText).toContain('Welcome to the programme')
    expect(dirtyDetail?.snippet).not.toContain('max-width')
    expect((await store.getMessage(clean.id))?.bodyText).toBe('普通通知：请周五前提交实验报告。')
  })

  it('无噪声数据时返回 0（幂等）', async () => {
    const store = new InMemoryMessageStore()
    await store.upsertMessages([msg(201, '干净正文')])
    expect(await repairNoisyBodies(store, new MemoryLogger())).toBe(0)
    expect(await repairNoisyBodies(store, new MemoryLogger())).toBe(0)
  })

  it('makeRepairSnippet 压缩空白并截断', () => {
    expect(makeRepairSnippet('a\n\n  b   c')).toBe('a b c')
    expect(makeRepairSnippet('x'.repeat(200)).endsWith('…')).toBe(true)
  })
})
