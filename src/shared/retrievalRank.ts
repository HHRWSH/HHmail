/**
 * 检索结果排序（纯函数）。
 *
 * 用户要求「第一条就命中」：召回有了（Recall@5 87.5%）但命中邮件经常排在第 2-5 位，
 * AI 看到的上下文里最相关的反而不在最前面。这里按**检索词命中情况**打分：
 *   - 主题命中 > 正文/卡片命中（主题是邮件里最凝练的信息）；
 *   - 英文词按词边界命中再加分（避免 "fee" 命中 "coffee"）；
 *   - 命中**不同**检索词越多分越高（覆盖度）；
 *   - 权重来自 retrievalQuery（用户原词 3 > 跨语言同义词 2 > 滑窗 1）；
 *   - 排序稳定：同分保持调用方给的顺序（结构化过滤路已按"未来最近截止优先"排好）。
 */
import type { WeightedTerm } from './retrievalQuery'

export interface RankFields {
  subject?: string | null
  /** 卡片 / 摘要 / 正文片段（用于打分的次要字段） */
  body?: string | null
}

const W_SUBJECT = 3
const W_SUBJECT_BOUNDARY = 1
const W_BODY = 1
const W_COVERAGE = 0.5

function escapeRe(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function includesTerm(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false
  return haystack.includes(needle)
}

/** 英文词的词边界命中（fee / Fees / fees 都算，coffee 不算）。 */
function boundaryHit(haystack: string, needle: string): boolean {
  if (!haystack || !/^[a-z0-9]+$/i.test(needle)) return false
  return new RegExp(`\\b${escapeRe(needle)}(?:s|es)?\\b`, 'i').test(haystack)
}

/**
 * 统一的命中判断：英文按词边界、中文按子串。
 * 只用 includes 会两头出错："fee" 命中 "coffee"（假阳性），又匹配不到 "Fees"（大小写假阴性）。
 */
function hitOf(haystack: string, term: string): boolean {
  if (!haystack || !term) return false
  return /^[a-z0-9]+$/i.test(term) ? boundaryHit(haystack, term) : includesTerm(haystack, term)
}

/** 单个实体对检索词的匹配得分（0 = 完全不相关）；idf 为可选的词稀有度（见 computeIdf）。 */
export function scoreFields(fields: RankFields, terms: WeightedTerm[], idf?: Map<string, number>): number {
  const subject = String(fields.subject ?? '')
  const body = String(fields.body ?? '')
  if (!subject && !body) return 0
  // 重叠词只算一次（长的优先）：notifications / notification / notif 都命中同一个单词时，
  // 按三个词计分会让"Daily Notifications"这种泛化邮件靠同义词堆分冲到第一（真机踩过）。
  const ordered = [...terms].sort((a, b) => b.term.length - a.term.length)
  const counted: string[] = []
  let score = 0
  let matched = 0
  for (const t of ordered) {
    const term = t.term
    if (!term) continue
    if (!hitOf(subject, term) && !hitOf(body, term)) continue
    const lower = term.toLowerCase()
    if (counted.some((c) => c.includes(lower))) continue
    counted.push(lower)
    let gain = 0
    if (hitOf(subject, term)) {
      gain += W_SUBJECT
      if (boundaryHit(subject, term)) gain += W_SUBJECT_BOUNDARY
    }
    if (hitOf(body, term)) gain += W_BODY
    matched += 1
    const rarity = idf?.get(term) ?? 1
    score += gain * t.weight * rarity
  }
  return score > 0 ? score + matched * W_COVERAGE : 0
}

/**
 * 按检索词相关性**稳定**排序（同分保持原顺序）。
 *
 * 真机教训：只按「命中/不命中 + 固定权重」排会被语料里的高频词带偏——
 * 问「Blackboard 上有什么新通知」时，"Daily Notifications" 因为主题里有「通知」排到了
 * 真正相关的 Blackboard 邮件前面。所以这里在候选集**内部**算一次 IDF：
 * 出现得越普遍的词（通知 / notifications）权重越低，越独特的词（Blackboard）权重越高。
 *
 * terms 为空 → 原样返回（纯时间/类型问题保持「未来最近截止优先」的既有顺序）。
 */
export function rankByTerms<T extends RankFields>(items: T[], terms: WeightedTerm[], opts: RankOptions = {}): T[] {
  if (!items || items.length === 0) return items ?? []
  if (!terms || terms.length === 0) return items
  const idf = opts.idf ?? computeIdf(items, terms)
  const penalize = opts.penalizeAggregator !== false
  const scored = items.map((item) => {
    const base = scoreFields(item, terms, idf)
    const isAggregator = penalize && base > 0 && AGGREGATOR_TITLE.test(String(item.subject ?? ''))
    return { item, score: isAggregator ? base * AGGREGATOR_FACTOR : base }
  })
  // 全都不相关 → 不动顺序（避免无意义重排）
  if (!scored.some((s) => s.score > 0)) return items
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}

/**
 * 候选集内部的 IDF：`ln(1 + N/(1+df))`（词越普遍 → 越小）。
 * 只在本批候选里统计；如果调用方给了全库统计（store 里的 idf 选项），优先用全库的——
 * 候选池会被同义词查询带偏（问「学费」会把一堆缴费邮件拉进池子，看起来"学费"很常见）。
 */
function computeIdf(items: RankFields[], terms: WeightedTerm[]): Map<string, number> {
  const n = items.length
  const out = new Map<string, number>()
  for (const t of terms) {
    let df = 0
    for (const it of items) {
      if (hitOf(String(it.subject ?? ''), t.term) || hitOf(String(it.body ?? ''), t.term)) df += 1
    }
    out.set(t.term, Math.log(1 + n / (1 + df)))
  }
  return out
}

/**
 * 汇总类（digest）邮件的标题：这类邮件几乎每封都命中泛化词（"Daily Notifications" 天然含
 * "Notifications"），会把真正有信息量的邮件挤到后面（真机：问「Blackboard 上有什么新通知」，
 * 5 封 Daily Notifications 霸榜，而 "CLASS CANCELLED" 那封排在后面）。
 * 处理方式：命中汇总标题的条目降权（不是排除），具体邮件优先。
 */
const AGGREGATOR_TITLE =
  /^\s*(\[[^\]]{0,20}\]\s*)?((daily|weekly|monthly|biweekly)\s+(notifications?|digest|highlights?|bulletin)|digest of|notification digest)|通知汇总|每日通知|每周摘要|每周快讯|摘要通知/i

export interface RankOptions {
  /** 全库 IDF（store 提供；缺省则用候选池内部统计） */
  idf?: Map<string, number>
  /** 是否对汇总类标题降权（默认 true） */
  penalizeAggregator?: boolean
}

const AGGREGATOR_FACTOR = 0.5
