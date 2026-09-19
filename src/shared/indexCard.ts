/**
 * 检索用「索引卡片」的解析与查询意图（纯函数，可单测）。
 *
 * 背景（用户需求）：摘要分两份产物 ——
 *   ① 给人读的 Markdown 决策卡（mail_summaries，见 shared/summaryView.ts）；
 *   ② 给 AI 助手检索的结构化索引卡片（mail_index_docs），信息密度优先、可关键词命中、可结构化过滤。
 *
 * 索引卡片模板（模型按此输出，本文件负责解析）：
 *   [TYPE] 作业 | [COURSE] ENG1110B | [TERM] 2026R1 | [DUE] 2026-09-11 23:59
 *   [FROM] xxx@example.edu | [ORG] 电子工程系
 *   [ENTITIES] Lab 0, Experiment 1, GraderScope
 *   [ALIASES] 实验一, Lab0
 *   [TAGS] 作业, 实验
 *   [FACTS]
 *   - ...
 *   [QUESTIONS] 这周有什么截止？ | ENG1110B 怎么交作业？
 *   [QUOTE] "Lab 0 is due 11 September at 11:59 pm"
 */
import { parseDeadline } from './summaryView'

export interface IndexCardFields {
  /** 原始卡片文本（存库 + 全文检索的主体） */
  card: string
  type: string | null
  course: string | null
  term: string | null
  /** [DUE] 解析出的时间戳（ms，解析不出为 null） */
  dueTs: number | null
  dueText: string | null
  entities: string[]
  aliases: string[]
  /** 主题标签（V2.2 B 方案：AI 从词表里挑的 1-3 个） */
  tags: string[]
  questions: string[]
  facts: string[]
  quote: string | null
}

/** 取 `[TAG] 值` 的值（同一行里到行尾或到下一个 `|` 分隔）。 */
function tagValue(text: string, tag: string): string | null {
  const re = new RegExp(`\\[${tag}\\]\\s*([^\\n|｜]*)`, 'i')
  const m = re.exec(text)
  const v = m?.[1]?.trim()
  return v ? v.replace(/^[|｜]\s*/, '').trim() || null : null
}

/** 取 `[TAG]` 直到下一个 `[TAG]` 之间的多行内容（用于 FACTS / QUESTIONS）。 */
function blockValue(text: string, tag: string): string {
  const re = new RegExp(`\\[${tag}\\]\\s*([\\s\\S]*?)(?=\\n\\s*\\[[A-Z_]+\\]|$)`, 'i')
  return (re.exec(text)?.[1] ?? '').trim()
}

function splitList(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(/[,，;；|｜]/)
    .map((s) => s.replace(/^[-*•]\s*/, '').trim())
    .filter((s) => s.length > 0 && s.length <= 60)
}

function splitLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
}

/** 解析模型输出的索引卡片（容错：缺字段不报错，返回 null/空数组）。 */
export function parseIndexCard(text: string | null | undefined, now: number = Date.now()): IndexCardFields {
  const card = String(text ?? '').trim()
  const type = tagValue(card, 'TYPE')
  const course = tagValue(card, 'COURSE')
  const term = tagValue(card, 'TERM')
  const dueText = tagValue(card, 'DUE')
  const quoteRaw = tagValue(card, 'QUOTE')
  return {
    card,
    type: type && type !== '无' ? type.slice(0, 20) : null,
    course: course && course !== '无' ? course.slice(0, 40) : null,
    term: term && term !== '无' ? term.slice(0, 20) : null,
    dueTs: parseDeadline(dueText, now),
    dueText: dueText && dueText !== '无' ? dueText.slice(0, 60) : null,
    entities: splitList(tagValue(card, 'ENTITIES')),
    aliases: splitList(tagValue(card, 'ALIASES')),
    tags: splitList(tagValue(card, 'TAGS')).filter((t) => t !== '无'),
    questions: blockValue(card, 'QUESTIONS')
      .split(/[|｜\n]/)
      .map((s) => s.replace(/^[-*•]\s*/, '').trim())
      .filter((s) => s.length > 1 && s.length <= 80)
      .slice(0, 8),
    facts: splitLines(blockValue(card, 'FACTS')).slice(0, 10),
    quote: quoteRaw ? quoteRaw.replace(/^["“]|["”]$/g, '').slice(0, 200) : null
  }
}

/** 结构化过滤条件（由查询意图解析或 UI 直接给出）。 */
export interface IndexFilter {
  /** 类型：作业 / 考试 / 选课 / 行政 / 活动 / 奖学金 / 通知 / 广告 */
  type?: string
  course?: string
  /** 截止时间下界（含） */
  dueAfter?: number
  /** 截止时间上界（含） */
  dueBefore?: number
  /** 只看有截止的卡片 */
  hasDue?: boolean
}

export interface QueryIntent {
  /** 去掉时间/类型词后剩下的检索词（可能为空 → 纯过滤查询） */
  keywords: string
  filter: IndexFilter
  /** 解析出的时间窗说明（日志/调试用） */
  timeHint?: string
}

const TYPE_WORDS: Array<{ re: RegExp; type: string }> = [
  { re: /作业|功课|assignment|homework|lab|实验|report|论文|paper/i, type: '作业' },
  { re: /考试|测验|quiz|exam|midterm|final/i, type: '考试' },
  { re: /选课|加课|退课|enroll|course selection/i, type: '选课' },
  { re: /奖学金|助学金|scholarship|grant/i, type: '奖学金' },
  { re: /活动|讲座|工作坊|seminar|workshop|event/i, type: '活动' },
  { re: /缴费|账单|费用|学费|payment|bill|fee/i, type: '行政' },
  { re: /广告|推销|促销|优惠|推广|advertis|promotion|discount/i, type: '广告' }
]

const DAY = 86_400_000

/** 从自然语言问题里解析时间窗与类型（规则法，零成本、可解释）。 */
export function parseQueryIntent(question: string, now: number = Date.now()): QueryIntent {
  const q = String(question ?? '')
  const filter: IndexFilter = {}
  let timeHint: string | undefined
  const base = new Date(now)
  const startOfToday = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime()

  if (/今天|今日|today/i.test(q)) {
    filter.dueAfter = startOfToday
    filter.dueBefore = startOfToday + DAY - 1
    timeHint = '今天'
  } else if (/明天|tomorrow/i.test(q)) {
    filter.dueAfter = startOfToday + DAY
    filter.dueBefore = startOfToday + 2 * DAY - 1
    timeHint = '明天'
  } else if (/这周|本周|this week|下星期|下周|next week/i.test(q)) {
    const nextWeek = /下周|next week/i.test(q)
    const day = base.getDay() === 0 ? 7 : base.getDay() // 周一=1 … 周日=7
    const monday = startOfToday - (day - 1) * DAY + (nextWeek ? 7 * DAY : 0)
    filter.dueAfter = monday
    filter.dueBefore = monday + 7 * DAY - 1
    timeHint = nextWeek ? '下周' : '本周'
  } else if (/上周|上星期|last week/i.test(q)) {
    const day = base.getDay() === 0 ? 7 : base.getDay()
    const monday = startOfToday - (day - 1) * DAY - 7 * DAY
    // 上周没有「截止」语义 → 用「收件时间」不好在索引表里过滤，这里只留时间提示
    timeHint = '上周'
    filter.dueAfter = undefined
    filter.dueBefore = undefined
    void monday
  } else if (/本月|这个月|this month/i.test(q)) {
    const first = new Date(base.getFullYear(), base.getMonth(), 1).getTime()
    const next = new Date(base.getFullYear(), base.getMonth() + 1, 1).getTime()
    filter.dueAfter = first
    filter.dueBefore = next - 1
    timeHint = '本月'
  } else {
    const m = /最近\s*(\d+)\s*(天|周|个月)/.exec(q)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      const span = m[2] === '天' ? n * DAY : m[2] === '周' ? n * 7 * DAY : n * 30 * DAY
      filter.dueAfter = now - span
      timeHint = `最近 ${n}${m[2]}`
    }
  }

  if (/截止|ddl|deadline|due/i.test(q)) filter.hasDue = true

  for (const { re, type } of TYPE_WORDS) {
    if (re.test(q)) {
      filter.type = type
      break
    }
  }

  // 课程号（ENG1110B / MAE 1234 / CSC 3160）
  const course = /([A-Z]{2,5}\s?\d{3,4}[A-Z]?)/.exec(q)
  if (course) filter.course = course[1].replace(/\s+/g, '').toUpperCase()

  // 关键词：去掉疑问词与时间/类型词，保留有信息量的部分
  const keywords = q
    .replace(/[？?。！!，,、]/g, ' ')
    .replace(/今天|今日|明天|这周|本周|下周|上星期|上周|本月|这个月|最近|today|tomorrow|this week|last week|next week/gi, ' ')
    .replace(/截止|ddl|deadline|due/gi, ' ')
    .replace(/有没有|有哪些|有什么|什么时候|多少|哪几封|哪些|是谁|什么|几点|怎么|如何|请问|帮我|查一下|找一下|看看/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { keywords: keywords === q.trim() ? q.trim() : keywords, filter, timeHint }
}
