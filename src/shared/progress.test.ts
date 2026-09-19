import { describe, expect, it } from 'vitest'
import { estimateRemainingMs, formatDuration, formatProgressText, progressPercent, shortenSubject } from './progress'

describe('批量总结进度文案（用户反馈：不知道进度、不知道等多久）', () => {
  it('formatDuration：秒 / 分秒 / 小时', () => {
    expect(formatDuration(45_000)).toBe('45 秒')
    expect(formatDuration(80_000)).toBe('1 分 20 秒')
    expect(formatDuration(120_000)).toBe('2 分')
    expect(formatDuration(3_720_000)).toBe('1 小时 2 分')
    expect(formatDuration(-5)).toBe('0 秒')
  })

  it('estimateRemainingMs：按已完成平均耗时外推；无法估算时返回 null', () => {
    // 已完成 5 封用了 50 秒 → 每封 10 秒 → 还剩 45 封 ≈ 450 秒
    expect(estimateRemainingMs({ done: 5, total: 50, elapsedMs: 50_000 })).toBe(450_000)
    expect(estimateRemainingMs({ done: 0, total: 50, elapsedMs: 3_000 })).toBeNull()
    expect(estimateRemainingMs({ done: 50, total: 50, elapsedMs: 500_000 })).toBeNull()
    expect(estimateRemainingMs({ done: 5, total: 50, elapsedMs: 0 })).toBeNull()
  })

  it('formatProgressText：一行给出进度与已用（不再给「预计还需」）', () => {
    const text = formatProgressText({ done: 5, total: 50, elapsedMs: 50_000 })
    expect(text).toBe('5 / 50 · 已用 50 秒')
    expect(text).not.toContain('预计')
    // 刚开始：只显示进度与已用时间
    expect(formatProgressText({ done: 0, total: 0, elapsedMs: 1_000 })).toBe('0 / 0 · 已用 1 秒')
  })

  it('progressPercent：0~100 且 total=0 时安全', () => {
    expect(progressPercent(1, 4)).toBe(25)
    expect(progressPercent(9, 0)).toBe(0)
    expect(progressPercent(200, 100)).toBe(100)
  })

  it('shortenSubject：空主题与超长主题', () => {
    expect(shortenSubject(null)).toBe('（无主题）')
    expect(shortenSubject('  ')).toBe('（无主题）')
    const long = '关于2026-27学年第一学期选课与缴费的紧急通知以及后续安排说明会'
    expect(shortenSubject(long, 10)).toBe(`${long.slice(0, 10)}…`)
    expect(shortenSubject('短主题')).toBe('短主题')
  })
})
