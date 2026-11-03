/**
 * 待办（V2.4 备忘录式）—— 纯逻辑与类型。
 *
 * 设计（用户确认的方案）：
 *   - 待办 = 用户自己写的「备忘录卡片」：标题 + 正文 + 可增删的清单子项 + 引用（邮件 / 自定义时间）；
 *   - **不再自动从卡片 DUE / 摘要行动项生成**：全部由用户手动新建，或从邮件详情「加入待办」、
 *     摘要行动项「→ 待办」显式创建（都是用户主动点击）；
 *   - 时间分桶/逾期判断仍按**北京时间**，跨时区稳定（CI 是 UTC 也不漂）。
 */
import { cnDayEnd, cnDayStart, cnParts } from './calendar'

/** 待办里的一条清单子项 */
export interface TaskChecklistItem {
  id: string
  text: string
  done: boolean
}

/** 引用类型：邮件 / 自定义时间（用户确认：不做"日历事件列表"选择） */
export type TaskLinkKind = 'mail' | 'datetime'

/** 待办引用（挂在一张待办卡上） */
export interface TaskLink {
  id: number
  taskId: number
  kind: TaskLinkKind
  /** mail: messages.id 的字符串；datetime: 毫秒时间戳字符串 */
  refId: string
  /** 展示用：邮件主题 / 时间说明 */
  label: string | null
  /** 展示用：发件人+时间 / 备注 */
  sub: string | null
}

/** 待办卡（主进程返回给渲染层的形状） */
export interface TaskItem {
  id: number
  title: string
  body: string
  dueTs: number | null
  done: boolean
  checklist: TaskChecklistItem[]
  links: TaskLink[]
  createdAt: number
  updatedAt: number
}

/** 筛选范围 */
export type TaskRange = 'today' | 'week' | 'all' | 'done'

/** 清单子项上限（防止一屏塞爆） */
export const MAX_CHECKLIST_ITEMS = 100
/** 清单子项文字上限 */
export const MAX_CHECKLIST_TEXT = 200
/** 标题/正文上限（与 zod 保持一致） */
export const MAX_TASK_TITLE = 200
export const MAX_TASK_BODY = 20_000

// ---------------------------------------------------------------------------
// 时间解析与文案（与旧版一致，摘要行动项 / 手动时间都用它）
// ---------------------------------------------------------------------------

/** 解析「YYYY-MM-DD HH:mm」等 → 北京时间对应时间戳；无法解析返回 null */
export function parseDueText(raw: string, fallbackYear: number): number | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  let m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:\s*(\d{1,2})[:：](\d{2}))?/.exec(text)
  if (m) {
    const [, y, mo, d, h, mi] = m
    const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), h ? Number(h) - 8 : 15, mi ? Number(mi) : 59)
    return Number.isFinite(ts) ? ts : null
  }
  m = /(?<![\d/:])(\d{1,2})[-/](\d{1,2})(?:\s*(\d{1,2})[:：](\d{2}))?/.exec(text)
  if (m) {
    const [, mo, d, h, mi] = m
    const ts = Date.UTC(fallbackYear, Number(mo) - 1, Number(d), h ? Number(h) - 8 : 15, mi ? Number(mi) : 59)
    return Number.isFinite(ts) ? ts : null
  }
  return null
}

/** 从摘要 Markdown 解析「## 截止与行动项」里的行动项（供「→ 待办」入口用） */
export function parseActionItems(summaryMarkdown: string, fallbackYear: number): Array<{ title: string; dueTs: number | null; done: boolean }> {
  const text = String(summaryMarkdown ?? '')
  if (!text.trim()) return []
  const out: Array<{ title: string; dueTs: number | null; done: boolean }> = []
  let inSection = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^#{1,6}\s*/.test(line)) {
      inSection = /(截止|行动项|待办|to-?do)/i.test(line.replace(/^#{1,6}\s*/, ''))
      continue
    }
    if (!inSection) continue
    const m = /^[-*+]\s+\[([ xX])\]\s*(.+)$/.exec(line)
    if (!m) continue
    const body = m[2].trim()
    const dueMatch = /(?:截止|到期|due)\s*[:：]?\s*([^)）\n]+)/i.exec(body)
    let title = body
    let dueTs: number | null = null
    if (dueMatch) {
      dueTs = parseDueText(dueMatch[1], fallbackYear)
      title = body.slice(0, dueMatch.index).replace(/[\s—\-–:：]+$/, '').trim()
    }
    title = title.replace(/^[-*+]\s+/, '').replace(/\s+/g, ' ').trim()
    if (!title) continue
    out.push({ title, dueTs, done: m[1].toLowerCase() === 'x' })
  }
  return out
}

/** 是否逾期：有截止、未完成、且已过期 */
export function isOverdue(t: { dueTs: number | null; done: boolean }, now: number): boolean {
  return Boolean(t.dueTs) && !t.done && (t.dueTs as number) < now
}

/** 本周起点（周一 00:00，北京时间） */
export function cnWeekStart(now: number): number {
  const { y, mo, d } = cnParts(now)
  const dayStart = Date.UTC(y, mo - 1, d) - 8 * 3_600_000
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  const back = weekday === 0 ? 6 : weekday - 1
  return dayStart - back * 86_400_000
}

/** 按筛选范围过滤（已完成单独一档） */
export function filterTasksByRange<T extends { dueTs: number | null; done: boolean }>(tasks: T[], range: TaskRange, now: number): T[] {
  if (range === 'done') return tasks.filter((t) => t.done)
  const open = tasks.filter((t) => !t.done)
  if (range === 'all') return open
  if (range === 'today') {
    const start = cnDayStart(now)
    const end = cnDayEnd(now)
    return open.filter((t) => t.dueTs !== null && t.dueTs >= start && t.dueTs <= end)
  }
  const start = cnWeekStart(now)
  const end = start + 7 * 86_400_000 - 1
  return open.filter((t) => t.dueTs !== null && t.dueTs >= start && t.dueTs <= end)
}

/** 排序：未完成在前、截止升序、无截止按更新时间倒序 */
export function sortTasks<T extends { dueTs: number | null; done: boolean; updatedAt: number }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.dueTs !== null && b.dueTs !== null) return a.dueTs - b.dueTs
    if (a.dueTs !== null) return -1
    if (b.dueTs !== null) return 1
    return b.updatedAt - a.updatedAt
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

/** 本地时间 → datetime-local 输入值 */
export function tsToLocalInput(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local 输入值 → 毫秒时间戳；空串 → null */
export function localInputToTs(value: string): number | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  return Number.isFinite(ts) ? ts : null
}

// ---------------------------------------------------------------------------
// 清单子项（纯函数，便于单测与 IPC 校验）
// ---------------------------------------------------------------------------

/** 生成一个清单子项 id（本地唯一即可） */
export function newChecklistId(seed: number = Date.now()): string {
  return `c${seed.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 规范化清单（去空行、截断超长、去掉重复 id），最多 MAX_CHECKLIST_ITEMS 条 */
export function normalizeChecklist(raw: unknown): TaskChecklistItem[] {
  if (!Array.isArray(raw)) return []
  const out: TaskChecklistItem[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { id?: unknown; text?: unknown; done?: unknown }
    const text = String(rec.text ?? '').trim().slice(0, MAX_CHECKLIST_TEXT)
    if (!text) continue
    let id = String(rec.id ?? '').trim()
    if (!id || seen.has(id)) id = newChecklistId(out.length + 1)
    seen.add(id)
    out.push({ id, text, done: rec.done === true })
    if (out.length >= MAX_CHECKLIST_ITEMS) break
  }
  return out
}

/** 追加一条清单子项（空文字不追加） */
export function appendChecklistItem(list: TaskChecklistItem[], text: string): TaskChecklistItem[] {
  const t = String(text ?? '').trim().slice(0, MAX_CHECKLIST_TEXT)
  if (!t || list.length >= MAX_CHECKLIST_ITEMS) return list
  return [...list, { id: newChecklistId(list.length + 1), text: t, done: false }]
}

/** 切换某条子项的完成状态 */
export function toggleChecklistItem(list: TaskChecklistItem[], id: string): TaskChecklistItem[] {
  return list.map((item) => (item.id === id ? { ...item, done: !item.done } : item))
}

/** 删除某条子项 */
export function removeChecklistItem(list: TaskChecklistItem[], id: string): TaskChecklistItem[] {
  return list.filter((item) => item.id !== id)
}

/** 修改某条子项文字（空文字 → 删除该条） */
export function updateChecklistItem(list: TaskChecklistItem[], id: string, text: string): TaskChecklistItem[] {
  const t = String(text ?? '').trim().slice(0, MAX_CHECKLIST_TEXT)
  if (!t) return removeChecklistItem(list, id)
  return list.map((item) => (item.id === id ? { ...item, text: t } : item))
}

/** 清单完成度（用于列表行上的「2/3」提示） */
export function checklistProgress(list: TaskChecklistItem[]): { done: number; total: number } {
  return { done: list.filter((i) => i.done).length, total: list.length }
}

/** 列表行的摘要文字：优先取正文第一行，其次清单第一条 */
export function taskPreview(task: Pick<TaskItem, 'body' | 'checklist'>): string {
  const body = String(task.body ?? '').trim()
  if (body) return body.split('\n')[0].trim().slice(0, 120)
  const first = task.checklist[0]
  return first ? first.text : ''
}

/** 搜索/过滤用的纯文本（标题 + 正文 + 清单 + 引用标签） */
export function taskSearchText(task: TaskItem): string {
  const parts = [task.title, task.body, ...task.checklist.map((c) => c.text), ...task.links.map((l) => `${l.label ?? ''} ${l.sub ?? ''}`)]
  return parts.join(' ').toLowerCase()
}
