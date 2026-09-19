/**
 * 自动标签（A：规则映射 / B：AI 主题标签）—— 纯函数，主进程与渲染进程共用。
 *
 * 用户需求：自动检测邮件内容并打上标签，且**可以挑示例邮件给 AI 当参考**。
 * 设计原则（与知识库集合同一套）：
 *   - 多标签，不硬分类；
 *   - 自动标签与手动标签分开存、分开显示；
 *   - 只用于浏览/筛选/聚合，绝不参与删除或"硬过滤"；
 *   - 任何自动标签都能被忽略/重建（规则标签可随时重算）。
 */
import type { IndexCardFields } from './indexCard'

/** 默认标签词表（用户可在设置里改；AI 只能从这个词表里挑） */
export const DEFAULT_TAG_VOCABULARY: readonly string[] = [
  '作业',
  '考试',
  '选课',
  '行政',
  '活动',
  '奖学金',
  '通知',
  '广告',
  '实习',
  '招聘',
  '讲座',
  '工作坊',
  '社团',
  '志愿活动',
  '交换交流',
  '图书馆',
  '宿舍住宿',
  '缴费',
  'IT 服务',
  '心理支援',
  '健康医疗',
  '体育',
  '紧急',
  '需回复'
]

/** 一个自动标签的来源：规则映射 / AI / 用户手动指定的示例 */
export type TagSource = 'rule' | 'ai' | 'manual'

export interface TaggedMail {
  id: number
  subject: string
  tags: string[]
}

/** 标签规范化：去空白、去掉两侧的 #/【】、长度限制 1-12 字。 */
export function normalizeTag(raw: string): string | null {
  const t = String(raw ?? '')
    .replace(/^[#\s【\[]+|[#\s】\]]+$/g, '')
    .trim()
  if (!t) return null
  return t.length > 12 ? t.slice(0, 12) : t
}

/** 解析设置里的词表（逗号/换行/顿号分隔，去重、保序）。 */
export function parseVocabulary(text: string, fallback: readonly string[] = DEFAULT_TAG_VOCABULARY): string[] {
  const out: string[] = []
  for (const piece of String(text ?? '').split(/[,，、\n\r;；]+/)) {
    const t = normalizeTag(piece)
    if (t && !out.includes(t)) out.push(t)
  }
  return out.length > 0 ? out : [...fallback]
}

export function vocabularyToText(vocab: readonly string[]): string {
  return vocab.join('、')
}

const PLATFORM_TAGS: Array<{ re: RegExp; tag: string }> = [
  { re: /blackboard|learn|lms/i, tag: 'Blackboard' },
  { re: /gradescope|grader\s*scope/i, tag: 'Gradescope' },
  { re: /cusis/i, tag: 'CUSIS' },
  { re: /zoom/i, tag: 'Zoom' },
  { re: /qualtrics/i, tag: 'Qualtrics' },
  { re: /microsoft\s*teams|teams/i, tag: 'Teams' },
  { re: /canvas/i, tag: 'Canvas' }
]

const DAY = 86_400_000

/**
 * A 方案：由索引卡片的**已有字段**推导规则标签（零 AI 成本、可随时重算）。
 * 覆盖：类型 / 课程号 / 平台 / 截止与紧急度。
 */
export function deriveRuleTags(fields: Pick<IndexCardFields, 'type' | 'course' | 'dueTs' | 'entities'>, now = Date.now()): string[] {
  const tags: string[] = []
  const push = (t: string | null | undefined): void => {
    const n = normalizeTag(String(t ?? ''))
    if (n && !tags.includes(n)) tags.push(n)
  }
  push(fields.type)
  const course = String(fields.course ?? '').trim().toUpperCase()
  if (course) push(course)
  const haystack = (fields.entities ?? []).join(' ')
  for (const { re, tag } of PLATFORM_TAGS) {
    if (re.test(haystack)) push(tag)
  }
  if (typeof fields.dueTs === 'number' && fields.dueTs > 0) {
    // 截止状态只给一个标签（已过期 > 紧急 > 有截止），避免同一件事占两个名额
    if (fields.dueTs < now) push('已过期')
    else if (fields.dueTs - now <= 2 * DAY) push('紧急')
    else push('有截止')
  }
  // 最多 4 个规则标签：列表里显示得下，也避免标签墙
  return tags.slice(0, 4)
}

/** 解析 AI 返回的标签行（`实习, 招聘` / `实习、招聘` / `无`）。 */
export function parseAiTags(raw: string | null | undefined, vocab: readonly string[] = []): string[] {
  const text = String(raw ?? '').trim()
  if (!text || /^(无|none|n\/a|-)$/i.test(text)) return []
  const out: string[] = []
  for (const piece of text.split(/[,，、;；|/]+/)) {
    const t = normalizeTag(piece)
    if (!t) continue
    // 词表非空时优先保留词表内的写法（大小写/同义统一），词表外的新词也允许（用户可能想扩充）
    const known = vocab.find((v) => v.toLowerCase() === t.toLowerCase())
    const final = known ?? t
    if (!out.includes(final)) out.push(final)
  }
  return out.slice(0, 3)
}

/**
 * 给模型的标签说明 + 用户挑的示例邮件（few-shot）。
 * 示例里只放「主题 + 类型 + 用户认可的标签」，不放正文（省 token 也更稳）。
 */
export function buildTagPromptBlock(vocab: readonly string[], examples: TaggedMail[], maxExamples = 4): string {
  const lines: string[] = []
  if (vocab.length > 0) {
    lines.push(`标签只能从这个词表里挑（最多 3 个，宁缺毋滥；都不合适就写「无」）：${vocab.join('、')}`)
  }
  const usable = examples.filter((e) => e.tags.length > 0).slice(0, maxExamples)
  if (usable.length > 0) {
    lines.push('用户提供的示例邮件（请按这些示例的口径打标签）：')
    for (const e of usable) {
      lines.push(`- 主题「${e.subject.slice(0, 60)}」→ 标签：${e.tags.join('、')}`)
    }
  }
  return lines.join('\n')
}

/** 合并多来源标签（规则在前、AI 在后，去重，最多 max 个）。 */
export function mergeTags(...groups: Array<readonly string[] | undefined>): string[] {
  const out: string[] = []
  for (const g of groups) {
    for (const t of g ?? []) {
      const n = normalizeTag(t)
      if (n && !out.includes(n)) out.push(n)
    }
  }
  return out
}

/** 列表里最多显示几个标签 chip（其余折叠成 +N）。 */
export function visibleTags(tags: readonly string[], max = 3): { shown: string[]; more: number } {
  const list = tags.filter(Boolean)
  if (list.length <= max) return { shown: list, more: 0 }
  return { shown: list.slice(0, max), more: list.length - max }
}
