import { describe, expect, it } from 'vitest'
import {
  buildSnoozeNotificationBody,
  buildSnoozeNotificationTitle,
  processDueSnoozes,
  SNOOZE_POLL_MAX_MS,
  SNOOZE_POLL_MIN_MS
} from './snoozeScheduler'
import { InMemoryMessageStore } from '../../../tests/helpers/fakes'
import { MemoryLogger } from '../logger'

function makeStoreWithMails(): InMemoryMessageStore {
  const store = new InMemoryMessageStore()
  void store.upsertMessages([
    {
      uid: 101,
      subject: '毕业论文提醒',
      fromName: '林教授',
      fromAddr: 'lin@example.edu',
      toAddrs: [],
      ccAddrs: [],
      dateHdr: null,
      dateTs: 101,
      messageId: '<m101>',
      threadId: 't-101',
      references: [],
      inReplyTo: null,
      bodyText: '正文',
      bodyHtml: null,
      snippet: '',
      attachments: [],
      flags: []
    },
    {
      uid: 102,
      subject: '缴费通知',
      fromName: '教务处',
      fromAddr: 'office@example.edu',
      toAddrs: [],
      ccAddrs: [],
      dateHdr: null,
      dateTs: 102,
      messageId: '<m102>',
      threadId: 't-102',
      references: [],
      inReplyTo: null,
      bodyText: '正文',
      bodyHtml: null,
      snippet: '',
      attachments: [],
      flags: []
    }
  ])
  return store
}

describe('snoozeScheduler —— 稍后提醒调度纯逻辑（V2 M6）', () => {
  it('无到期提醒 → 不发通知、返回 0', async () => {
    const store = makeStoreWithMails()
    const list = await store.query({ limit: 10, offset: 0 })
    const mail = list.find((m) => m.uid === 101)!
    await store.setSnooze(mail.id, 9_999_999_999_999)
    const notified: string[] = []
    const n = await processDueSnoozes(
      { store, logger: new MemoryLogger(), notifier: { notify: (t) => notified.push(t) } },
      Date.now()
    )
    expect(n).toBe(0)
    expect(notified).toHaveLength(0)
  })

  it('到期提醒 → 逐个发通知并标记 notified_at（不再重复触发）', async () => {
    const store = makeStoreWithMails()
    const list = await store.query({ limit: 10, offset: 0 })
    const a = list.find((m) => m.uid === 101)!
    const b = list.find((m) => m.uid === 102)!
    await store.setSnooze(a.id, 1000, '记得问第三章')
    await store.setSnooze(b.id, 2000)
    const notified: { title: string; body: string }[] = []
    const n = await processDueSnoozes(
      { store, logger: new MemoryLogger(), notifier: { notify: (title, body) => notified.push({ title, body }) } },
      3000
    )
    expect(n).toBe(2)
    expect(notified[0].title).toContain('毕业论文提醒')
    expect(notified[0].body).toContain('记得问第三章')
    expect(notified[0].body).toContain('林教授')
    expect(notified[1].title).toContain('缴费通知')
    // 标记后不再到期
    expect(await store.dueSnoozes(3000)).toHaveLength(0)
    // 列表不再显示提醒
    const after = await store.query({ limit: 10, offset: 0 })
    expect(after.find((m) => m.uid === 101)?.snoozeUntil).toBeNull()
  })

  it('notifier 抛错 → 仍标记为已通知，不影响其余提醒', async () => {
    const store = makeStoreWithMails()
    const list = await store.query({ limit: 10, offset: 0 })
    const a = list.find((m) => m.uid === 101)!
    const b = list.find((m) => m.uid === 102)!
    await store.setSnooze(a.id, 1000)
    await store.setSnooze(b.id, 2000)
    let calls = 0
    const n = await processDueSnoozes(
      {
        store,
        logger: new MemoryLogger(),
        notifier: {
          notify: () => {
            calls += 1
            if (calls === 1) throw new Error('notify boom')
          }
        }
      },
      3000
    )
    expect(n).toBe(2)
    expect(await store.dueSnoozes(3000)).toHaveLength(0)
  })

  it('标题/正文构造与截断', () => {
    expect(buildSnoozeNotificationTitle('关于毕业论文的沟通')).toBe('⏰ 稍后提醒：关于毕业论文的沟通')
    expect(buildSnoozeNotificationBody('林教授', '记得带实验数据')).toBe('记得带实验数据（来自 林教授）')
    expect(buildSnoozeNotificationBody('林教授', null)).toBe('林教授')
    expect(buildSnoozeNotificationBody('', null)).toBe('您稍后提醒的邮件到时间了')
    expect(buildSnoozeNotificationBody('林教授', 'x'.repeat(300)).length).toBeLessThanOrEqual(161)
  })

  it('轮询间隔钳制在 [30s, 5min]（常量契约）', () => {
    expect(SNOOZE_POLL_MIN_MS).toBe(30_000)
    expect(SNOOZE_POLL_MAX_MS).toBe(300_000)
  })
})
