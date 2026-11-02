/**
 * 待办（V2.3）：把「邮件里的截止/行动项」变成可勾选的任务。
 *
 * 数据来源（零 AI 成本，只用已有产物）：
 *   1) 索引卡片的 `[DUE]` → 一条「截止」任务（标题 = 邮件主题）；
 *   2) 已存摘要里「## 截止与行动项」的 Markdown 列表 → 每条一行任务（`- [ ] xxx —— 截止：YYYY-MM-DD HH:mm`）。
 * 两路按「同邮件 + 同标题 + 同截止」去重；手动新增的任务（source='manual'）不参与重建、不会被覆盖。
 *
 * 时区约定：与日历一致 —— 所有时间按**北京时间**分桶（`cnParts` 等来自 shared/calendar），
 * 避免 UTC 与本地时区混算导致"今天到期"错位（CI 是 UTC，这个坑踩过）。
 */
import { cnDayEnd, cnDayStart, cnParts, type CalendarEventKind } from './calendar'

export type TaskSource = 'card' | 'summary' | 'manual'

/** 待办条目（主进程返回给渲染层的形状，含原邮件信息便于跳转/展示） */
export interface TaskItem {
  id: number
  /** 关联邮件（手动任务可为空） */
  messageId: number | null
  title: string
  /** 截止时间（毫秒时间戳）；null = 没有明确截止 */
  dueTs: number | null
  source: TaskSource
  done: boolean
  createdAt: number
  updatedAt: number
  /** 关联邮件的主题/发件人（手动任务为 null） */
  subject?: string | null
  fromName?: string | null
}

/** 解析出来的一条候选任务（还没有 id） */
export interface ParsedTask {
  title: string
  dueTs: number | null
  done: boolean
}

/** 带邮件来源的候选任务（重建时用） */
export interface TaskCandidate extends ParsedTask {
  messageId: number
  source: Exclude<TaskSource, 'manual'>
}

/** 待办筛选范围 */
export type TaskRange = 'today' | 'week' | 'all' | 'done'

/** 去掉清单符号与多余空白，用于标题归一化比较 */
function normalizeTitle(raw: string): string {
  return raw
    .replace(/^[-*+]\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[：:]\s*$/, '')
    .trim()
}

/**
 * 解析「YYYY-MM-DD HH:mm」（或 `YYYY/MM/DD`、`MM-DD HH:mm`，缺年份用 fallbackYear）
 * 返回北京时间对应的绝对时间戳；无法解析返回 null。
 */
export function parseDueText(raw: string, fallbackYear: number): number | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  // 2026-09-16 14:42 / 2026/9/16 14:42 / 2026年9月16日 14:42
  let m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:\s*(\d{1,2})[:：](\d{2}))?/.exec(text)
  if (m) {
    const [, y, mo, d, h, mi] = m
    const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), h ? Number(h) - 8 : 15, mi ? Number(mi) : 59)
    return Number.isFinite(ts) ? ts : null
  }
  // 09-16 14:42 / 9/16 14:42（无年份 → 用邮件年份）
  m = /(?<![\d/:])(\d{1,2})[-/](\d{1,2})(?:\s*(\d{1,2})[:：](\d{2}))?/.exec(text)
  if (m) {
    const [, mo, d, h, mi] = m
    const ts = Date.UTC(fallbackYear, Number(mo) - 1, Number(d), h ? Number(h) - 8 : 15, mi ? Number(mi) : 59)
    return Number.isFinite(ts) ? ts : null
  }
  return null
}

/**
 * 从摘要 Markdown 解析行动项：
 *   - [ ] 提交 Experiment 1 —— 截止：2026-09-16 23:59
 *   - [x] 已完成的保留 done=true（界面筛选「已完成」用）
 * 没有 `截止：` 的行也保留（dueTs=null），标题取该行正文。
 * 只认 `## 截止与行动项`/`## 行动项` 小节内的列表项，避免把「关键信息」里的列表也当成任务。
 */
export function parseActionItems(summaryMarkdown: string, fallbackYear: number): ParsedTask[] {
  const text = String(summaryMarkdown ?? '')
  if (!text.trim()) return []
  const lines = text.split(/\r?\n/)
  const out: ParsedTask[] = []
  let inSection = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^#{1,6}\s*/.test(line)) {
      const heading = line.replace(/^#{1,6}\s*/, '')
      inSection = /(截止|行动项|待办|to-?do)/i.test(heading)
      continue
    }
    if (!inSection) continue
    const m = /^[-*+]\s+\[([ xX])\]\s*(.+)$/.exec(line)
    if (!m) continue
    const done = m[1].toLowerCase() === 'x'
    const body = m[2].trim()
    // 截止信息：全角/半角冒号、`—— 截止：`、`(截止: ...)` 都兼容
    const dueMatch = /(?:截止|到期|due)\s*[:：]?\s*([^)）\n]+)/i.exec(body)
    let title = body
    let dueTs: number | null = null
    if (dueMatch) {
      dueTs = parseDueText(dueMatch[1], fallbackYear)
      // 标题里去掉「—— 截止：…」这一段，避免任务名里重复出现时间
      title = body.slice(0, dueMatch.index).replace(/[\s—\-–:：]+$/, '').trim()
    }
    title = normalizeTitle(title)
    if (!title) continue
    out.push({ title, dueTs, done })
  }
  return out
}

/** 去重键：同邮件 + 同标题（归一化）+ 同截止 */
export function taskKey(t: { messageId: number | null; title: string; dueTs: number | null }): string {
  return `${t.messageId ?? 'm'}|${normalizeTitle(t.title)}|${t.dueTs ?? 0}`
}

/**
 * 合并候选任务并去重：同 key 保留**摘要**来源（摘要里的行动项标题更具体、通常带截止；
 * 卡片来源只是「邮件主题 + DUE」的粗粒度兜底）。
 */
export function mergeTaskCandidates(candidates: TaskCandidate[]): TaskCandidate[] {
  const byKey = new Map<string, TaskCandidate>()
  for (const c of candidates) {
    const key = taskKey(c)
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, c)
      continue
    }
    const prefer = (x: TaskCandidate): number => (x.source === 'summary' ? 1 : 0)
    if (prefer(c) > prefer(prev)) byKey.set(key, c)
    // 任一来源标记完成 → 视为完成
    else if (c.done && !prev.done) byKey.set(key, { ...prev, done: true })
  }
  return [...byKey.values()]
}

/** 是否逾期：有截止、未完成、且已过期 */
export function isOverdue(t: Pick<TaskItem, 'dueTs' | 'done'>, now: number): boolean {
  return Boolean(t.dueTs) && !t.done && (t.dueTs as number) < now
}

/** 本周起点（周一 00:00，北京时间） */
export function cnWeekStart(now: number): number {
  const { y, mo, d } = cnParts(now)
  const dayStart = Date.UTC(y, mo - 1, d) - 8 * 3_600_000
  // getUTCDay 基于北京时间的日期：0=周日 → 周一为一周起点
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  const back = weekday === 0 ? 6 : weekday - 1
  return dayStart - back * 86_400_000
}

/** 按筛选范围过滤（已完成的单独一档） */
export function filterTasksByRange(tasks: TaskItem[], range: TaskRange, now: number): TaskItem[] {
  if (range === 'done') return tasks.filter((t) => t.done)
  const open = tasks.filter((t) => !t.done)
  if (range === 'all') return open
  if (range === 'today') {
    const start = cnDayStart(now)
    const end = cnDayEnd(now)
    return open.filter((t) => t.dueTs !== null && t.dueTs >= start && t.dueTs <= end)
  }
  // 本周（周一至周日）
  const start = cnWeekStart(now)
  const end = start + 7 * 86_400_000 - 1
  return open.filter((t) => t.dueTs !== null && t.dueTs >= start && t.dueTs <= end)
}

/** 排序：逾期/有截止的在前（按截止升序），无截止的按创建时间倒序 */
export function sortTasks(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.dueTs !== null && b.dueTs !== null) return a.dueTs - b.dueTs
    if (a.dueTs !== null) return -1
    if (b.dueTs !== null) return 1
    return b.createdAt - a.createdAt
  })
}

/** 截止文案：今天 14:42 / 明天 09:00 / 09-16 14:42 / 无截止 */
export function formatTaskDue(dueTs: number | null, now: number): string {
  if (!dueTs) return '无截止'
  const today = cnDayStart(now)
  const p = cnParts(dueTs)
  const hhmm = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`
  if (dueTs >= today && dueTs <= cnDayEnd(now)) return `今天 ${hhmm}`
  if (dueTs >= today + 86_400_000 && dueTs <= cnDayEnd(now) + 86_400_000) return `明天 ${hhmm}`
  return `${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${hhmm}`
}

/** 给界面用的空任务模板（避免各处重复造对象） */
export function emptyTaskDraft(): { title: string; dueTs: number | null } {
  return { title: '', dueTs: null }
}

// 导出给测试/主进程复用的类型别名（保持 shared 自洽）
export type { CalendarEventKind }
