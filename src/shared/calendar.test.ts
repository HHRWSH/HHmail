import { describe, expect, it } from 'vitest'
import {
  buildMonthGrid,
  cnDayEnd,
  cnDayKey,
  cnDayStart,
  cnMonthEnd,
  cnMonthStart,
  cnParts,
  formatEventTime,
  groupByDay,
  mailToEvents,
  parseCardDates
} from './calendar'

/** 北京时间某时刻的绝对时间戳（避免用本机时区，CI 是 UTC） */
const hkt = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

describe('calendar —— 北京时间换算（不依赖本机时区）', () => {
  it('cnParts 按 +08:00 解析', () => {
    expect(cnParts(hkt(2026, 9, 16, 14, 42))).toEqual({ y: 2026, mo: 9, d: 16, h: 14, mi: 42 })
    // UTC 的 16:00 = 北京次日 00:00（跨日边界）
    expect(cnParts(Date.UTC(2026, 8, 16, 16, 0))).toEqual({ y: 2026, mo: 9, d: 17, h: 0, mi: 0 })
  })

  it('cnDayStart / cnDayEnd 覆盖北京时间的一整天', () => {
    const t = hkt(2026, 9, 16, 23, 59)
    expect(cnDayKey(cnDayStart(t))).toBe('2026-09-16')
    expect(cnDayKey(cnDayEnd(t))).toBe('2026-09-16')
    expect(cnDayEnd(t) - cnDayStart(t)).toBe(86_399_999)
  })

  it('cnMonthStart / cnMonthEnd 是北京时间月初与月末', () => {
    expect(cnParts(cnMonthStart(2026, 9))).toEqual({ y: 2026, mo: 9, d: 1, h: 0, mi: 0 })
    expect(cnParts(cnMonthEnd(2026, 9))).toEqual({ y: 2026, mo: 9, d: 30, h: 23, mi: 59 })
    expect(cnParts(cnMonthEnd(2026, 2))).toEqual({ y: 2026, mo: 2, d: 28, h: 23, mi: 59 })
  })
})

describe('calendar —— 从卡片里找日期', () => {
  it('识别 2026-09-16 / 9月16日 / 09-16 三种写法', () => {
    const card = ['[TYPE] 考试', '[FACTS] 期末考 2026-09-16 14:42', '· 补考 9月18日', '- 报名截止 09-20'].join('\n')
    const hits = parseCardDates(card, 2026)
    expect(hits.map((h) => h.ts)).toEqual([hkt(2026, 9, 16, 14, 42), hkt(2026, 9, 18), hkt(2026, 9, 20)])
    expect(hits[1].text).toContain('补考')
  })

  it('跳过 [DUE] 行（交给 due_ts，避免重复）', () => {
    const hits = parseCardDates('[DUE] 2026-09-16 23:59 提交报告', 2026)
    expect(hits).toHaveLength(0)
  })

  it('忽略非法月份/日期', () => {
    expect(parseCardDates('13月40日 不是日期', 2026)).toHaveLength(0)
  })
})

describe('calendar —— 邮件转事件', () => {
  it('有 dueTs → 一个「截止」事件；卡片里其它日期 → 「事件」', () => {
    const events = mailToEvents({
      messageId: 7,
      subject: 'ENG1110B 期末考安排',
      fromName: '教务处',
      dateTs: hkt(2026, 9, 1, 9, 0),
      type: '考试',
      course: 'ENG1110B',
      dueTs: hkt(2026, 9, 16, 14, 42),
      card: '[TYPE] 考试\n[FACTS] 考试地点 SHB 123，另补考 9月18日 10:00'
    })
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'due', ts: hkt(2026, 9, 16, 14, 42), subject: 'ENG1110B 期末考安排', hasTime: true })
    expect(events[1]).toMatchObject({ kind: 'event', ts: hkt(2026, 9, 18, 10, 0), course: 'ENG1110B' })
    expect(events[1].label).toContain('补考')
  })

  it('23:59 视为「当天截止」（hasTime=false，界面只显示日期）', () => {
    const events = mailToEvents({
      messageId: 8,
      subject: '缴费通知',
      fromName: null,
      dateTs: hkt(2026, 9, 1),
      type: '行政',
      course: null,
      dueTs: hkt(2026, 9, 13, 23, 59),
      card: null
    })
    expect(events).toHaveLength(1)
    expect(events[0].hasTime).toBe(false)
    expect(formatEventTime(events[0])).toBe('09-13')
  })

  it('没有 dueTs 也没有卡片 → 不产生事件', () => {
    expect(
      mailToEvents({ messageId: 9, subject: '广告', fromName: null, dateTs: hkt(2026, 9, 1), type: null, course: null, dueTs: null, card: null })
    ).toHaveLength(0)
  })
})

describe('calendar —— 月视图网格与分组', () => {
  it('2026 年 9 月：1 号是周二，网格从 8/30（周日）开始，整周对齐', () => {
    const { cells, firstDay } = buildMonthGrid(2026, 9)
    expect(firstDay).toBe(2) // 周二
    expect(cells[0][0].key).toBe('2026-08-30')
    expect(cells[0][0].inMonth).toBe(false)
    // 9/1 在第 1 行第 3 格
    expect(cells[0][2]).toMatchObject({ key: '2026-09-01', inMonth: true })
    expect(cells.flat().filter((c) => c.inMonth)).toHaveLength(30)
    // 每行 7 格，行数 = 4~6
    for (const row of cells) expect(row).toHaveLength(7)
    expect(cells.length).toBeGreaterThanOrEqual(4)
    expect(cells.length).toBeLessThanOrEqual(6)
  })

  it('按天分组：同一天内按时间升序，跨天分到不同键', () => {
    const events = [
      { messageId: 1, ts: hkt(2026, 9, 16, 18, 0), kind: 'event' as const, label: 'b', subject: 's', fromName: null, type: null, course: null, hasTime: true },
      { messageId: 2, ts: hkt(2026, 9, 16, 9, 0), kind: 'due' as const, label: 'a', subject: 's', fromName: null, type: null, course: null, hasTime: true },
      { messageId: 3, ts: hkt(2026, 9, 17, 10, 0), kind: 'due' as const, label: 'c', subject: 's', fromName: null, type: null, course: null, hasTime: true }
    ]
    const grouped = groupByDay(events)
    expect([...grouped.keys()]).toEqual(['2026-09-16', '2026-09-17'])
    expect(grouped.get('2026-09-16')?.map((e) => e.label)).toEqual(['a', 'b'])
  })
})
