/**
 * 日历：把邮件里的「时间事件」整理成月视图数据。
 *
 * 数据来源：`mail_index_docs`（AI 索引卡片）——它已经解析出 `due_ts`（[DUE] 截止时间）与卡片正文。
 * 这里做两件事（纯函数，好测）：
 *   1) 把一封邮件变成 0..n 个日历事件（截止 = due；卡片正文里提到的其它日期 = 事件）；
 *   2) 生成月视图网格（含前后补白），并按天分组，供界面直接渲染。
 *
 * 时区约定：卡片里的日期都是**北京时间**（Asia/Hong_Kong，UTC+8，无夏令时），
 * 所以按月/按天分桶一律用固定 +08:00 偏移换算，**不能用本机时区**，
 * 否则 UTC 的 CI/服务器上会出现"事件跑到前一天"（这个坑在测试里踩过）。
 */

/** 一天/一小时的毫秒数 */
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** 北京时间相对 UTC 的偏移 */
const CN_OFFSET = 8 * HOUR

export type CalendarEventKind = 'due' | 'event'

export interface CalendarEvent {
  /** 邮件 id（点进去看原文） */
  messageId: number
  /** 事件发生时间（毫秒时间戳，UTC 绝对时间） */
  ts: number
  kind: CalendarEventKind
  /** 事件标题：截止用邮件主题，其它用卡片里那句话 */
  label: string
  /** 邮件主题（界面副标题） */
  subject: string
  fromName: string | null
  /** 索引卡片里的分类（作业/考试/行政…） */
  type: string | null
  course: string | null
  /** 标记日期是否精确到分钟（false = 只知道是哪天） */
  hasTime: boolean
}

/** 卡片里出现的、能当作事件候选的一行文字（截断后给界面用） */
export interface CalendarSourceMail {
  messageId: number
  subject: string
  fromName: string | null
  dateTs: number
  type: string | null
  course: string | null
  dueTs: number | null
  /** 索引卡片原文（含 [DUE]/[FACTS] 等） */
  card: string | null
}

/** 把绝对时间戳换算成"北京时间的年月日时分" */
export function cnParts(ts: number): { y: number; mo: number; d: number; h: number; mi: number } {
  const t = new Date(ts + CN_OFFSET)
  return {
    y: t.getUTCFullYear(),
    mo: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    h: t.getUTCHours(),
    mi: t.getUTCMinutes()
  }
}

/** 北京时间某天 00:00 对应的绝对时间戳 */
export function cnDayStart(ts: number): number {
  const { y, mo, d } = cnParts(ts)
  return Date.UTC(y, mo - 1, d) - CN_OFFSET
}

/** 北京时间某天 23:59:59.999 对应的绝对时间戳 */
export function cnDayEnd(ts: number): number {
  return cnDayStart(ts) + DAY - 1
}

/** 北京时间的年月 → 该月第一天 00:00 的绝对时间戳（month 从 1 开始） */
export function cnMonthStart(year: number, month: number): number {
  return Date.UTC(year, month - 1, 1) - CN_OFFSET
}

/** 北京时间的年月 → 该月最后一天 23:59:59.999 的绝对时间戳 */
export function cnMonthEnd(year: number, month: number): number {
  return Date.UTC(year, month, 1) - CN_OFFSET - 1
}

/** 日期分组的键：YYYY-MM-DD（北京时间） */
export function cnDayKey(ts: number): string {
  const { y, mo, d } = cnParts(ts)
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** 解析卡片正文里除了 [DUE] 之外提到的日期（行级扫描，返回时间戳与该行文字） */
export function parseCardDates(card: string, fallbackYear: number): { ts: number; text: string }[] {
  const out: { ts: number; text: string }[] = []
  const lines = card.split(/\r?\n/)
  const seen = new Set<string>()
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    // [DUE] 行交给 due_ts 处理，避免同一件事出现两次
    if (/^\[DUE\]/i.test(line)) continue
    // 收集这一行里的所有日期：2026-09-16 / 09-16 / 9月16日 / 16/9
    const found: { y: number; mo: number; d: number; h?: number; mi?: number }[] = []
    for (const m of line.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/g)) {
      found.push({ y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: m[4] ? Number(m[4]) : undefined, mi: m[5] ? Number(m[5]) : undefined })
    }
    for (const m of line.matchAll(/(?<![\d-])(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2})[:：](\d{2}))?/g)) {
      found.push({ y: fallbackYear, mo: Number(m[1]), d: Number(m[2]), h: m[3] ? Number(m[3]) : undefined, mi: m[4] ? Number(m[4]) : undefined })
    }
    for (const m of line.matchAll(/(?<![\d/-])(\d{1,2})-(\d{1,2})(?![\d-])(?:\s+(\d{1,2}):(\d{2}))?/g)) {
      found.push({ y: fallbackYear, mo: Number(m[1]), d: Number(m[2]), h: m[3] ? Number(m[3]) : undefined, mi: m[4] ? Number(m[4]) : undefined })
    }
    for (const f of found) {
      if (f.mo < 1 || f.mo > 12 || f.d < 1 || f.d > 31) continue
      // 同年内，月份已经过去很久（>6 个月）说明它是「下一年」的事（如 12 月发的次年 1 月考试）
      const year = f.y >= 2000 ? f.y : f.mo + 6 < cnParts(Date.now()).mo ? fallbackYear + 1 : fallbackYear
      const ts = Date.UTC(year, f.mo - 1, f.d, (f.h ?? 0) - 8, f.mi ?? 0)
      const key = `${ts}|${line.slice(0, 20)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ts, text: line.replace(/^[·•\-*\s]+/, '').slice(0, 80) })
    }
  }
  return out
}

/**
 * 一封邮件 → 日历事件。
 * - 有 due_ts：一个「截止」事件（kind=due），标题用邮件主题；
 * - 卡片正文里提到的其它日期：各算一个事件（kind=event），标题用那句话。
 */
export function mailToEvents(mail: CalendarSourceMail): CalendarEvent[] {
  const base = {
    messageId: mail.messageId,
    subject: mail.subject,
    fromName: mail.fromName,
    type: mail.type,
    course: mail.course
  }
  const events: CalendarEvent[] = []
  if (mail.dueTs && mail.dueTs > 0) {
    const { h, mi } = cnParts(mail.dueTs)
    events.push({ ...base, ts: mail.dueTs, kind: 'due', label: mail.subject, hasTime: !(h === 23 && mi === 59) })
  }
  if (mail.card) {
    const year = cnParts(mail.dueTs && mail.dueTs > 0 ? mail.dueTs : mail.dateTs).y
    for (const hit of parseCardDates(mail.card, year)) {
      if (mail.dueTs && Math.abs(hit.ts - mail.dueTs) < 60_000) continue
      const { h, mi } = cnParts(hit.ts)
      events.push({ ...base, ts: hit.ts, kind: 'event', label: hit.text, hasTime: !(h === 0 && mi === 0) })
    }
  }
  return events
}

/** 一天在月视图里的格位 */
export interface CalendarCell {
  /** YYYY-MM-DD（北京时间） */
  key: string
  day: number
  /** 该格是否属于当前月（false = 上/下月补白） */
  inMonth: boolean
  /** 该格的绝对时间范围 */
  start: number
  end: number
}

/**
 * 生成月视图网格：按周日起始、整周对齐（42 格 = 6 行，行数按需 4~6 行）。
 * 用「周日起始」是中文日历习惯（周日 / 周一 / …）。
 */
export function buildMonthGrid(year: number, month: number): { cells: CalendarCell[][]; firstDay: number } {
  const first = cnMonthStart(year, month)
  const firstWeekday = new Date(first + CN_OFFSET).getUTCDay() // 0=周日
  const gridStart = first - firstWeekday * DAY
  const end = cnMonthEnd(year, month)
  const days = Math.ceil((end - gridStart + 1) / DAY)
  const rows = Math.ceil(days / 7)
  const cells: CalendarCell[][] = []
  for (let r = 0; r < rows; r += 1) {
    const row: CalendarCell[] = []
    for (let c = 0; c < 7; c += 1) {
      const start = gridStart + (r * 7 + c) * DAY
      const p = cnParts(start)
      row.push({
        key: cnDayKey(start),
        day: p.d,
        inMonth: p.mo === month && p.y === year,
        start,
        end: start + DAY - 1
      })
    }
    cells.push(row)
  }
  return { cells, firstDay: firstWeekday }
}

/** 按天分组（键 = YYYY-MM-DD，北京时间），同一天内按时间升序 */
export function groupByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>()
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const key = cnDayKey(e.ts)
    const list = map.get(key)
    if (list) list.push(e)
    else map.set(key, [e])
  }
  return map
}

/** 事件时间的中文短标签：09-16 14:42 / 09-16（全天） */
export function formatEventTime(e: CalendarEvent): string {
  const { mo, d, h, mi } = cnParts(e.ts)
  const date = `${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  if (!e.hasTime) return date
  return `${date} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}
