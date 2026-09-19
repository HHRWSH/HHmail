import { describe, expect, it } from 'vitest'
import { findSubjectMention, linkifyCitations, mailIdFromHref, normalizeForMatch } from './citations'

describe('归一化与主题定位', () => {
  it('归一化去掉空白与标点', () => {
    expect(normalizeForMatch('【重要】关于 选课 与学费缴费的通知！')).toBe('重要关于选课与学费缴费的通知')
  })

  it('完整主题、截断主题都能找到', () => {
    const answer = '| 2026-09-14 | Daily Notifications | Blackboard | 成绩更新 |'
    expect(findSubjectMention(answer, 'Daily Notifications')).toBe('Daily Notifications')
    // 回答里写全了就用全文；只写了前 16 字也能定位
    const long = '2026R1 University Life and Learning (GEUC1111): Anti-Scam Awareness Quiz'
    const answer2 = `1. ${long} —— 完成测验`
    expect(findSubjectMention(answer2, long)).toBe(long)
    const answer3 = '1. 2026R1 University Life and Learning (GEUC1111) —— 完成测验'
    expect(findSubjectMention(answer3, long)).toBe(long.slice(0, 16))
  })

  it('回答里没提到就返回 null（短主题不误判）', () => {
    expect(findSubjectMention('今天没有相关邮件', 'Daily Notifications')).toBeNull()
    expect(findSubjectMention('abc', 'abc')).toBeNull() // 太短，宁可不链接
  })
})

describe('linkifyCitations —— 回答里的邮件名可点击', () => {
  it('把主题替换成 #mail-<id> 锚点', () => {
    const md = '共检索到 2 封：\n- Daily Notifications\n- 选课与学费缴费通知'
    const out = linkifyCitations(md, [
      { id: 103, subject: 'Daily Notifications' },
      { id: 77, subject: '选课与学费缴费通知' }
    ])
    expect(out).toContain('[Daily Notifications](#mail-103)')
    expect(out).toContain('[选课与学费缴费通知](#mail-77)')
  })

  it('只替换一次，且不破坏已有的链接写法', () => {
    const md = 'Daily Notifications 与 Daily Notifications'
    const once = linkifyCitations(md, [{ id: 1, subject: 'Daily Notifications' }])
    expect(once.match(/#mail-1/g)).toHaveLength(1)

    const already = '- [Daily Notifications](#mail-5)'
    const untouched = linkifyCitations(already, [{ id: 5, subject: 'Daily Notifications' }])
    expect(untouched).toBe(already)
  })

  it('没提到的引用不链接（避免回答被改花）', () => {
    const md = '这里有别的邮件'
    expect(linkifyCitations(md, [{ id: 9, subject: 'Daily Notifications' }])).toBe(md)
  })

  it('从 href 解析邮件 id', () => {
    expect(mailIdFromHref('#mail-42')).toBe(42)
    expect(mailIdFromHref('https://example.com/#mail-42')).toBe(42)
    expect(mailIdFromHref('#mail-abc')).toBeNull()
    expect(mailIdFromHref(null)).toBeNull()
  })
})
