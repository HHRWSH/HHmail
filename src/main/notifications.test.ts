import { describe, expect, it } from 'vitest'
import {
  buildNotificationBody,
  buildNotificationTitle,
  shouldNotifyNewMail,
  truncate,
  isNewMailBurst,
  describeNewMailBurst,
  NEW_MAIL_NOTIFY_BURST_THRESHOLD
} from './notifications'
import type { MailListItem } from '../shared/types'

const item: MailListItem = {
  id: 1,
  uid: 101,
  threadId: 't',
  subject: 'Hone Your Competencies with Co-op@University',
  fromName: 'OCEP',
  fromAddr: 'coop@example.edu',
  dateTs: 1,
  dateLabel: '',
  snippet: '信息会报名提醒',
  unread: true,
  hasAttachments: false,
  labels: [],
  starred: false,
  snoozeUntil: null,
  blocked: false,
}

describe('新邮件通知文案（纯函数）', () => {
  it('标题带图标与主题', () => {
    expect(buildNotificationTitle(item.subject)).toBe('📬 Hone Your Competencies with Co-op@University')
    expect(buildNotificationTitle('')).toBe('📬 (无主题)')
  })

  it('有摘要时取摘要首行（结构化输出的第一段）', () => {
    const summary = '【一句话主旨】宣传 Co-op 项目。\n【关键信息】信息会：9/11 4pm-5pm。'
    expect(buildNotificationBody(item, summary)).toBe('【一句话主旨】宣传 Co-op 项目。')
  })

  it('Markdown 摘要：跳过 ## 标题行，取真正的内容行', () => {
    const summary = [
      '## 主旨',
      '',
      '宣传 Co-op 项目，9/11 有信息会。',
      '',
      '## 重要度',
      '',
      '**中**'
    ].join('\n')
    expect(buildNotificationBody(item, summary)).toBe('宣传 Co-op 项目，9/11 有信息会。')
  })

  it('Markdown 摘要：去掉加粗/列表/表格标记', () => {
    expect(buildNotificationBody(item, '## 主旨\n\n- [ ] **周五前**回复导师')).toBe('周五前回复导师')
    expect(buildNotificationBody(item, '## 关键信息\n\n| 时间 | 9月11日 16:00 |')).toBe('时间 · 9月11日 16:00')
  })

  it('摘要只有标题行时退化为 发件人+摘要片段', () => {
    expect(buildNotificationBody(item, '## 主旨\n\n## 重要度')).toBe('OCEP：信息会报名提醒')
  })

  it('无摘要时退化为 发件人+摘要片段', () => {
    expect(buildNotificationBody(item, null)).toBe('OCEP：信息会报名提醒')
  })

  it('超长截断', () => {
    expect(truncate('a'.repeat(200), 50)).toHaveLength(51) // 50 + …
    expect(truncate('short', 50)).toBe('short')
    expect(truncate(null, 10)).toBe('')
  })
})

describe('新邮件通知策略（真机反馈：自己点同步/摘要时不要弹窗）', () => {
  it('用户主动触发 → 不弹通知', () => {
    expect(shouldNotifyNewMail('manual')).toBe(false)
    expect(shouldNotifyNewMail('manual-sync')).toBe(false)
    expect(shouldNotifyNewMail('manual-summarize')).toBe(false)
    expect(shouldNotifyNewMail('manual-anything')).toBe(false)
  })

  it('后台自动同步 → 弹通知', () => {
    for (const reason of ['interval', 'resume', 'unlock-screen', 'focus', 'idle', 'startup']) {
      expect(shouldNotifyNewMail(reason)).toBe(true)
    }
  })

  it('没说来源时默认弹（宁可多提醒，不要漏掉新邮件）', () => {
    expect(shouldNotifyNewMail(undefined)).toBe(true)
    expect(shouldNotifyNewMail('')).toBe(true)
  })
})

describe('新邮件过多时不弹通知（V2.4：订阅轰炸/批量转发）', () => {
  it('阈值 5 封，超过才静默', () => {
    expect(NEW_MAIL_NOTIFY_BURST_THRESHOLD).toBe(5)
    expect(isNewMailBurst(1)).toBe(false)
    expect(isNewMailBurst(5)).toBe(false)
    expect(isNewMailBurst(6)).toBe(true)
    expect(isNewMailBurst(30)).toBe(true)
  })

  it('阈值可配置；0 = 关闭该策略', () => {
    expect(isNewMailBurst(6, 10)).toBe(false)
    expect(isNewMailBurst(11, 10)).toBe(true)
    expect(isNewMailBurst(999, 0)).toBe(false)
  })

  it('非法输入按 0 处理（不误静默）', () => {
    expect(isNewMailBurst(Number.NaN)).toBe(false)
    expect(isNewMailBurst(-3)).toBe(false)
    expect(isNewMailBurst(2.9)).toBe(false)
  })

  it('静默日志文案带数量', () => {
    expect(describeNewMailBurst(12)).toContain('12')
  })
})
