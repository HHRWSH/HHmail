import { describe, expect, it } from 'vitest'
import { filterMatches, sortMails } from './views'
import type { MailListItem, ViewFilter } from './types'

function makeMail(overrides: Partial<MailListItem> = {}): MailListItem {
  return {
    id: 1,
    uid: 101,
    threadId: 't-101',
    subject: '关于毕业论文进度的沟通',
    fromName: '林教授',
    fromAddr: 'lin@example.edu',
    dateTs: 1700000000000,
    dateLabel: '',
    snippet: '第三章需要补充实验数据',
    unread: true,
    hasAttachments: true,
    labels: [{ id: 1, name: '课业', color: '#0a84ff' }],
    starred: false,
    snoozeUntil: null,
    ...overrides
  }
}

describe('filterMatches —— 自定义视图纯函数（V2 M5，与 sqlite SQL 同语义）', () => {
  it('无 filter → 全部命中', () => {
    expect(filterMatches(makeMail(), undefined)).toBe(true)
    expect(filterMatches(makeMail(), {})).toBe(true)
  })

  it('from：姓名或地址子串命中', () => {
    expect(filterMatches(makeMail(), { from: '林教授' })).toBe(true)
    expect(filterMatches(makeMail(), { from: 'lin@example' })).toBe(true)
    expect(filterMatches(makeMail(), { from: '教务处' })).toBe(false)
  })

  it('unread / hasAttachment', () => {
    expect(filterMatches(makeMail({ unread: true }), { unread: true })).toBe(true)
    expect(filterMatches(makeMail({ unread: false }), { unread: true })).toBe(false)
    expect(filterMatches(makeMail({ hasAttachments: true }), { hasAttachment: true })).toBe(true)
    expect(filterMatches(makeMail({ hasAttachments: false }), { hasAttachment: true })).toBe(false)
  })

  it('labelIds：任一命中即包含', () => {
    expect(filterMatches(makeMail(), { labelIds: [1] })).toBe(true)
    expect(filterMatches(makeMail(), { labelIds: [1, 9] })).toBe(true)
    expect(filterMatches(makeMail(), { labelIds: [9] })).toBe(false)
    expect(filterMatches(makeMail({ labels: [] }), { labelIds: [1] })).toBe(false)
  })

  it('dateFrom/dateTo 闭区间', () => {
    const t = 1700000000000
    expect(filterMatches(makeMail({ dateTs: t }), { dateFrom: t })).toBe(true)
    expect(filterMatches(makeMail({ dateTs: t }), { dateTo: t })).toBe(true)
    expect(filterMatches(makeMail({ dateTs: t }), { dateFrom: t + 1 })).toBe(false)
    expect(filterMatches(makeMail({ dateTs: t }), { dateTo: t - 1 })).toBe(false)
  })

  it('text：主题/正文/发件人关键字', () => {
    expect(filterMatches(makeMail(), { text: '毕业论文' })).toBe(true)
    expect(filterMatches(makeMail(), { text: '实验数据' })).toBe(true)
    expect(filterMatches(makeMail(), { text: '林教授' })).toBe(true)
    expect(filterMatches(makeMail(), { text: '不存在的词' })).toBe(false)
  })

  it('多条件 AND', () => {
    const f: ViewFilter = { from: '林', unread: true, hasAttachment: true, labelIds: [1] }
    expect(filterMatches(makeMail(), f)).toBe(true)
    expect(filterMatches(makeMail({ hasAttachments: false }), f)).toBe(false)
    expect(filterMatches(makeMail({ unread: false }), f)).toBe(false)
  })
})

describe('sortMails —— 视图排序纯函数（V2 M5）', () => {
  const a = makeMail({ id: 1, uid: 1, dateTs: 100, fromName: 'Alice', subject: 'Apple' })
  const b = makeMail({ id: 2, uid: 2, dateTs: 200, fromName: 'Bob', subject: 'banana' })
  const c = makeMail({ id: 3, uid: 3, dateTs: 300, fromName: 'Charlie', subject: 'Cherry' })

  it('缺省 / date desc', () => {
    expect(sortMails([a, b, c], undefined).map((m) => m.id)).toEqual([3, 2, 1])
    expect(sortMails([a, b, c], { by: 'date', dir: 'desc' }).map((m) => m.id)).toEqual([3, 2, 1])
    expect(sortMails([a, b, c], { by: 'date', dir: 'asc' }).map((m) => m.id)).toEqual([1, 2, 3])
  })

  it('subject / from 不区分大小写', () => {
    expect(sortMails([b, c, a], { by: 'subject', dir: 'asc' }).map((m) => m.id)).toEqual([1, 2, 3])
    expect(sortMails([c, a, b], { by: 'subject', dir: 'desc' }).map((m) => m.id)).toEqual([3, 2, 1])
    expect(sortMails([c, b, a], { by: 'from', dir: 'asc' }).map((m) => m.id)).toEqual([1, 2, 3])
  })

  it('不修改原数组', () => {
    const input = [a, b, c]
    sortMails(input, { by: 'subject', dir: 'desc' })
    expect(input.map((m) => m.id)).toEqual([1, 2, 3])
  })
})
