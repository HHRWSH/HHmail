import { describe, expect, it } from 'vitest'
import { assignThreadIds, normalizeSubject, newThreadId, type ThreadSeed, type ThreadIndexEntry } from './thread'

function seed(uid: number, opts: Partial<ThreadSeed> = {}): ThreadSeed {
  return {
    uid,
    messageId: opts.messageId ?? `<m${uid}@x>`,
    references: opts.references ?? [],
    inReplyTo: opts.inReplyTo ?? null,
    subject: opts.subject ?? `主题 ${uid}`,
    fromAddr: opts.fromAddr ?? 'a@example.edu',
    dateTs: opts.dateTs ?? uid
  }
}

describe('normalizeSubject —— 去 Re:/Fwd:/回复:/转发: 前缀（可多层）', () => {
  it('英文前缀', () => {
    expect(normalizeSubject('Re: 论文进度')).toBe('论文进度')
    expect(normalizeSubject('RE: FW: 论文进度')).toBe('论文进度')
    expect(normalizeSubject('Fwd: 通知')).toBe('通知')
  })
  it('中文前缀', () => {
    expect(normalizeSubject('回复: 论文进度')).toBe('论文进度')
    expect(normalizeSubject('转发：回复：通知')).toBe('通知')
  })
  it('无前缀不变，折叠空白', () => {
    expect(normalizeSubject('  通知  邮件  ')).toBe('通知 邮件')
  })
})

describe('assignThreadIds —— 本地线程聚合（规范 §6.5 第 6 条）', () => {
  it('references 命中已有 messageId → 归入同线程', () => {
    const existing: ThreadIndexEntry[] = [
      { messageId: '<root@x>', threadId: 'T1', subject: '论文', fromAddr: 'a@example.edu', dateTs: 1 }
    ]
    const result = assignThreadIds([seed(2, { references: ['<root@x>'], messageId: '<m2@x>' })], existing)
    expect(result.get(2)).toBe('T1')
  })

  it('inReplyTo 命中 → 归入同线程', () => {
    const existing: ThreadIndexEntry[] = [{ messageId: '<parent@x>', threadId: 'T1', subject: 's', fromAddr: 'a', dateTs: 1 }]
    const result = assignThreadIds([seed(2, { inReplyTo: '<parent@x>' })], existing)
    expect(result.get(2)).toBe('T1')
  })

  it('同批 incoming 之间通过 references 互相归并', () => {
    const m1 = seed(1, { messageId: '<m1@x>', dateTs: 1 })
    const m2 = seed(2, { references: ['<m1@x>'], messageId: '<m2@x>', dateTs: 2 })
    const result = assignThreadIds([m2, m1], [])
    expect(result.get(1)).toBe(result.get(2))
  })

  it('无引用 → 规范化主题 + 发件人兜底', () => {
    const existing: ThreadIndexEntry[] = [
      { messageId: '<m1@x>', threadId: 'T1', subject: 'Re: 组队 project', fromAddr: 'b@example.edu', dateTs: 1 }
    ]
    const r1 = assignThreadIds([seed(2, { subject: '组队 project', fromAddr: 'b@example.edu' })], existing)
    expect(r1.get(2)).toBe('T1')
  })

  it('主题相同但发件人不同 → 主题兜底仍归并（宽松匹配）', () => {
    const existing: ThreadIndexEntry[] = [
      { messageId: '<m1@x>', threadId: 'T1', subject: '作业讨论', fromAddr: 'a@example.edu', dateTs: 1 }
    ]
    const result = assignThreadIds([seed(2, { subject: 'Re: 作业讨论', fromAddr: 'c@example.edu' })], existing)
    expect(result.get(2)).toBe('T1')
  })

  it('无任何匹配 → 自成一线程', () => {
    const result = assignThreadIds([seed(9)], [])
    expect(result.get(9)).toBe(newThreadId(9))
  })

  it('引用链多级：m3 refs m2，m2 refs m1（m1 已有 T1）', () => {
    const existing: ThreadIndexEntry[] = [{ messageId: '<m1@x>', threadId: 'T1', subject: 's', fromAddr: 'a', dateTs: 1 }]
    const m2 = seed(2, { references: ['<m1@x>'], messageId: '<m2@x>', dateTs: 2 })
    const m3 = seed(3, { references: ['<m2@x>'], messageId: '<m3@x>', dateTs: 3 })
    const result = assignThreadIds([m3, m2], existing)
    expect(result.get(2)).toBe('T1')
    expect(result.get(3)).toBe('T1')
  })

  it('references 列表命中任意一个即可', () => {
    const existing: ThreadIndexEntry[] = [{ messageId: '<mid@x>', threadId: 'T1', subject: 's', fromAddr: 'a', dateTs: 1 }]
    const result = assignThreadIds([seed(4, { references: ['<other@x>', '<mid@x>'] })], existing)
    expect(result.get(4)).toBe('T1')
  })
})
