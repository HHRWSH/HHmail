import { describe, expect, it } from 'vitest'
import { formatAbsoluteDate, formatBytes, formatFullDate, formatListTime, formatRelativeDate, formatSmartTime } from './format'

describe('时间格式化（纯函数）', () => {
  const now = new Date(2025, 9, 10, 15, 30).getTime() // 2025-10-10 15:30

  it('今天 → HH:mm', () => {
    const ts = new Date(2025, 9, 10, 9, 5).getTime()
    expect(formatRelativeDate(ts, now)).toBe('09:05')
  })

  it('昨天 → 昨天', () => {
    const ts = new Date(2025, 9, 9, 20, 0).getTime()
    expect(formatRelativeDate(ts, now)).toBe('昨天')
  })

  it('今年更早 → M月D日', () => {
    const ts = new Date(2025, 8, 1).getTime()
    expect(formatRelativeDate(ts, now)).toBe('9月1日')
  })

  it('跨年 → YYYY年M月D日', () => {
    const ts = new Date(2024, 11, 31).getTime()
    expect(formatRelativeDate(ts, now)).toBe('2024年12月31日')
  })

  it('formatFullDate 带星期', () => {
    const ts = new Date(2025, 9, 10, 9, 5).getTime()
    expect(formatFullDate(ts)).toContain('2025年10月10日')
  })
})

describe('附件大小格式化', () => {
  it('B/KB/MB 三档', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatBytes(0)).toBe('—')
  })
})

describe('formatSmartTime / formatAbsoluteDate —— 设置里的「时间显示」', () => {
  const now = new Date(2026, 8, 12, 18, 30).getTime()

  it('相对时间：刚刚 / 分钟 / 小时 / 昨天 / 日期', () => {
    expect(formatSmartTime(now - 5_000, now)).toBe('刚刚')
    expect(formatSmartTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatSmartTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(formatSmartTime(new Date(2026, 8, 11, 9, 0).getTime(), now)).toBe('昨天')
    expect(formatSmartTime(new Date(2026, 7, 1, 9, 0).getTime(), now)).toBe('8月1日')
    expect(formatSmartTime(new Date(2024, 11, 31, 9, 0).getTime(), now)).toBe('2024年12月31日')
  })

  it('绝对时间：YYYY-MM-DD HH:mm', () => {
    expect(formatAbsoluteDate(new Date(2026, 8, 12, 18, 5).getTime())).toBe('2026-09-12 18:05')
  })

  it('formatListTime 按开关切换两种写法', () => {
    const ts = now - 2 * 60_000
    expect(formatListTime(ts, true, now)).toBe('2 分钟前')
    expect(formatListTime(ts, false, now)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})
