/**
 * AI 摘要的结构化解析（纯函数，可单测）。
 *
 * 背景：摘要按固定 Markdown 模板生成
 *   ## 主旨 / ## 重要度 / ## 关键信息（表格）/ ## 截止与行动项（- [ ]）/ ## 分类 / ## 原文摘录
 * 但「直接渲染 Markdown」有两个问题：
 *   1) 表格 + 长中文在窄侧栏里会横向溢出、被裁掉（用户反馈「文字超出文本框，看不到」）；
 *   2) 一坨 Markdown 看起来并不比纯文本直观。
 * 因此这里把模板解析成结构化数据，交给 UI 用卡片/定义列表/清单来排版；
 * 解析不出来（老摘要、模型自由发挥）时返回空数组，UI 退回通用 Markdown 渲染。
 */

export interface SummarySection {
  /** 归一化后的标题（去掉空格、去掉 # 号） */
  title: string
  /** 该节正文（不含标题行） */
  body: string
}

export interface KeyInfoRow {
  label: string
  value: string
}

export interface ActionItem {
  text: string
  done: boolean
  /** 形如 2026-09-30 14:30 的截止时间（从「—— 截止：…」里提取） */
  deadline: string | null
}

/** 已知小节标题（含中英/别名，模型偶尔会加粗或换措辞）。 */
export const KNOWN_SECTIONS = ['主旨', '重要度', '关键信息', '截止与行动项', '分类', '原文摘录'] as const

function cleanTitle(raw: string): string {
  return raw
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/[：:]\s*$/, '')
    .trim()
}

/** 把摘要拆成小节；没有 `## 标题` 结构时返回空数组（调用方退回通用渲染）。 */
export function splitSummarySections(markdown: string | null | undefined): SummarySection[] {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n')
  if (!text.trim()) return []
  const lines = text.split('\n')
  const sections: SummarySection[] = []
  let currentTitle: string | null = null
  let currentBody: string[] = []
  const preambleLines: string[] = []
  const flush = (): void => {
    if (currentTitle !== null) sections.push({ title: currentTitle, body: currentBody.join('\n').trim() })
    currentTitle = null
    currentBody = []
  }
  for (const line of lines) {
    const m = /^\s{0,3}#{2,4}\s+(.*\S)\s*$/.exec(line)
    if (m) {
      flush()
      currentTitle = cleanTitle(m[1])
      continue
    }
    if (currentTitle !== null) currentBody.push(line)
    else preambleLines.push(line)
  }
  flush()
  // 只有标题没有正文的空小节去掉（模型偶尔多打一个标题）
  const nonEmpty = sections.filter((s) => s.body.trim() !== '')
  // 完全没有 ## 结构 → 交给通用渲染
  if (nonEmpty.length === 0) return []
  const lead = preambleLines.join('\n').trim()
  if (lead) nonEmpty.unshift({ title: '', body: lead })
  return nonEmpty
}

/** 从「关键信息」小节里解析 Markdown 表格（`| 项目 | 内容 |`）。 */
export function parseKeyInfoTable(body: string): KeyInfoRow[] {
  const rows: KeyInfoRow[] = []
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    if (/^\|?[\s:|-]*-{2,}[\s:|-]*\|?$/.test(line)) continue // |---|---| 分隔行
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.replace(/\*\*/g, '').trim())
    if (cells.length < 2) continue
    const [label, ...rest] = cells
    const value = rest.join(' · ').trim()
    if (!label && !value) continue
    if (/^(项目|字段|名称|label)$/i.test(label) && /^(内容|说明|value|详情)$/i.test(value)) continue // 表头
    if (!value) continue
    rows.push({ label, value })
  }
  return rows
}

/** 解析「截止与行动项」：`- [ ] 事情 —— 截止：2026-09-30 14:30`。 */
export function parseActionItems(body: string): ActionItem[] {
  const items: ActionItem[] = []
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(?:[-*+]|\d+[.)])\s*(?:\[([ xX])\]\s*)?(.*)$/.exec(line)
    if (!m) {
      // 非列表行也当作一条（模型偶尔写成普通句子）
      const plain = line.replace(/^\*\*(.+?)\*\*$/, '$1').trim()
      if (plain && !/^[-|]/.test(plain)) items.push({ text: plain, done: false, deadline: null })
      continue
    }
    const done = (m[1] ?? '').toLowerCase() === 'x'
    let text = m[2].trim()
    let deadline: string | null = null
    const dm = /(?:——|--|—|,|，)?\s*截止[:：]\s*(.+)$/.exec(text)
    if (dm) {
      deadline = dm[1].replace(/\*\*/g, '').trim()
      text = text.slice(0, dm.index).replace(/[——\-—,，\s]+$/, '').trim()
    }
    text = text.replace(/\*\*/g, '').trim()
    if (!text && !deadline) continue
    items.push({ text, done, deadline })
  }
  return items
}

/** 重要度：返回「高 / 中 / 低」，识别不到返回 null。 */
export function parseImportance(body: string): '高' | '中' | '低' | null {
  const t = String(body ?? '').replace(/\*\*/g, '')
  if (/[高high]/i.test(t) && !/不高/.test(t)) return '高'
  if (/[中medium]/i.test(t)) return '中'
  if (/[低low]/i.test(t)) return '低'
  const m = /(高|中|低)/.exec(t)
  return m ? (m[1] as '高' | '中' | '低') : null
}

/** 「分类」小节 → 标签数组（支持 `、`/`,`/`/` 分隔与 `- ` 列表）。 */
export function parseCategories(body: string): string[] {
  return String(body ?? '')
    .split('\n')
    .map((l) => l.replace(/^[-*+]\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .flatMap((l) => l.split(/[、,，/|]/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 20)
    .slice(0, 6)
}

/** 「原文摘录」小节 → 去掉引用符号的纯文本。 */
export function parseQuotes(body: string): string[] {
  return String(body ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*>\s?/, '').replace(/^["“]|["”]$/g, '').trim())
    .filter(Boolean)
}

/** 把 `**加粗**` / `` `代码` `` 转成安全的纯文本（结构化视图不需要 Markdown）。 */
export function inlinePlain(text: string): string {
  return String(text ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

// ---------- 截止时间：解析 / 排序 / 倒计时（“30 秒看清要做什么”的核心） ----------

/**
 * 从文本里解析截止时间 → 本地时间戳（解析不出返回 null）。
 * 支持：2026-09-11 23:59 / 2026/09/11 / 09-11 23:59 / 9月11日 23:59 /
 *       09-12（本周五）/ 今天 23:59 / 明天 / 后天 18:00 / 23:59
 */
export function parseDeadline(text: string | null | undefined, now: number = Date.now()): number | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const t = raw.replace(/[（(][^）)]*[）)]/g, ' ').replace(/[，,；;]/g, ' ')
  const timeMatch = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(t)
  const hh = timeMatch ? Number.parseInt(timeMatch[1], 10) : 23
  const mm = timeMatch ? Number.parseInt(timeMatch[2], 10) : 59
  if (hh > 23 || mm > 59) return null

  const base = new Date(now)
  const y = base.getFullYear()
  const m = base.getMonth() + 1
  const d = base.getDate()
  const at = (year: number, month: number, day: number): number => new Date(year, month - 1, day, hh, mm, 0, 0).getTime()

  // 相对日
  if (/今天|today/i.test(t)) return at(y, m, d)
  if (/明天|tomorrow/i.test(t)) return at(y, m, d + 1)
  if (/后天/.test(t)) return at(y, m, d + 2)

  // 2026-09-11 / 2026/09/11
  let match = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(t)
  if (match) return at(Number(match[1]), Number(match[2]), Number(match[3]))

  // 09-11 / 9/11
  match = /(?<!\d)(\d{1,2})[-/](\d{1,2})(?!\d)/.exec(t)
  if (match) {
    const month = Number.parseInt(match[1], 10)
    const day = Number.parseInt(match[2], 10)
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let ts = at(y, month, day)
      // 已经过去 30 天以上 → 多半是明年的截止
      if (ts < now - 30 * 86400000) ts = at(y + 1, month, day)
      return ts
    }
  }

  // 9月11日
  match = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(t)
  if (match) {
    const month = Number.parseInt(match[1], 10)
    const day = Number.parseInt(match[2], 10)
    let ts = at(y, month, day)
    if (ts < now - 30 * 86400000) ts = at(y + 1, month, day)
    return ts
  }

  // 只有时间（23:59）→ 今天该时刻
  if (timeMatch) return at(y, m, d)
  return null
}

/** 行动项排序：有截止的按时间从早到晚，未完成的在前。 */
export function sortActionItems(items: ActionItem[], now: number = Date.now()): ActionItem[] {
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    const da = a.deadline ? parseDeadline(a.deadline, now) : null
    const db = b.deadline ? parseDeadline(b.deadline, now) : null
    if (da !== null && db !== null) return da - db
    if (da !== null) return -1
    if (db !== null) return 1
    return 0
  })
}

/** 最近的一个截止时间戳（行动项 + 关键信息里的「截止」行）。 */
export function earliestDeadline(items: ActionItem[], rows: KeyInfoRow[], now: number = Date.now()): number | null {
  const candidates: number[] = []
  for (const it of items) {
    if (it.done || !it.deadline) continue
    const ts = parseDeadline(it.deadline, now)
    if (ts !== null) candidates.push(ts)
  }
  for (const row of rows) {
    if (!/截止|deadline|due/i.test(row.label)) continue
    const ts = parseDeadline(row.value, now)
    if (ts !== null) candidates.push(ts)
  }
  return candidates.length > 0 ? Math.min(...candidates) : null
}

/** 倒计时文案：还有 8 小时 / 已过期 2 天。 */
export function formatRemaining(deadline: number, now: number = Date.now()): string {
  const diff = deadline - now
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60000)
  const hours = Math.round(abs / 3600000)
  const days = Math.round(abs / 86400000)
  const unit = mins < 60 ? `${Math.max(1, mins)} 分钟` : hours < 48 ? `${hours} 小时` : `${days} 天`
  return diff >= 0 ? `还有 ${unit}` : `已过期 ${unit}`
}

/** 紧急度：past（已过期）/ soon（<24h）/ near（<72h）/ later。 */
export function deadlineUrgency(deadline: number, now: number = Date.now()): 'past' | 'soon' | 'near' | 'later' {
  const diff = deadline - now
  if (diff < 0) return 'past'
  if (diff < 86400000) return 'soon'
  if (diff < 3 * 86400000) return 'near'
  return 'later'
}

/** 把「2026-09-11 23:59」这类文本压成「09-11 23:59」（界面里省位置）。 */
export function shortDeadline(text: string | null | undefined): string {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}:\d{2}))?/.exec(raw)
  if (m) return `${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}${m[4] ? ` ${m[4]}` : ''}`
  return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw
}

/** 单行裁剪（超出补省略号），用于紧凑卡片里防止长句撑破布局。 */
export function clampText(text: string, max = 48): string {
  const t = inlinePlain(text).replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max)}…` : t
}
