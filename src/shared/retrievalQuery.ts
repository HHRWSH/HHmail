/**
 * 检索词构造（纯函数）：把一句自然语言问题变成**带权重的检索词**。
 *
 * 一轮真机评测暴露的三个短板，都由这里统一解决：
 *   ① 跨语言：中文问「图书馆」，语料是 "Library Orientation" → 补英文写法（bilingual.ts）；
 *   ② 简繁：用户写简体，语料是繁體（圖書館/學費/選課）→ 补简繁变体（zhTw.ts）；
 *   ③ 长中文串：trigram FTS 只能匹配 ≥3 字符子串，且要求子串在文中连续出现，
 *      「语言课程或英语工作坊」这种整串必然 0 命中 → 切 3 字/2 字滑窗做兜底召回。
 *
 * 权重用于**排序**（不是召回）：用户原词最高，跨语言同义词次之，滑窗最低。
 * 这样「召回优先、精确优先排序」，不会因为补了同义词就把原词命中的邮件挤下去。
 */
import { bilingualTerms, isGenericWord, stripGenericWords, wordLevelVariants } from './bilingual'
import { extractRetrievalTokens } from './searchTokens'
import { hasCjk, toSimplified, toTraditional } from './zhTw'

export type TermKind = 'exact' | 'variant' | 'synonym' | 'window'

export interface WeightedTerm {
  term: string
  /** 打分权重：原词 3、简繁变体 3、跨语言同义词 2、滑窗 1 */
  weight: number
  kind: TermKind
}

const W_EXACT = 3
const W_VARIANT = 3
const W_SYNONYM = 2
const W_WINDOW = 1

/** 英文长词的前缀（≥5 字符）做模糊兜底：GraderScope / Gradescope 共享 "grade"，拼写差异也能召回。 */
const PREFIX_MIN = 5
const PREFIX_LEN = 5

function addTerm(map: Map<string, WeightedTerm>, term: string, weight: number, kind: TermKind): void {
  const t = term.trim()
  if (t.length < 2) return
  if (isGenericWord(t)) return
  const prev = map.get(t.toLowerCase())
  if (!prev || prev.weight < weight) map.set(t.toLowerCase(), { term: t, weight, kind })
}

/** 中文长词切滑窗（3 字给 trigram FTS，2 字给 LIKE 兜底）。 */
function windows(token: string, maxPerWidth = 4): string[] {
  const chars = [...token]
  const out: string[] = []
  if (chars.length <= 2) return out
  let n = 0
  for (let i = 0; i + 3 <= chars.length && n < maxPerWidth; i += 1, n += 1) out.push(chars.slice(i, i + 3).join(''))
  n = 0
  for (let i = 0; i + 2 <= chars.length && n < maxPerWidth; i += 1, n += 1) out.push(chars.slice(i, i + 2).join(''))
  return out
}

/** 并列连接词（中文）：把「语言课程或英语工作坊」拆成两个短语，各自才能匹配到语料。 */
const CONJUNCTIONS = /[和与及或、／/]/

/**
 * 清洗一个检索词：抠掉泛化词（邮件/相关）→ 去首尾的「的/了」等虚词 → 按并列词拆分。
 * 例：「图书馆相关的邮件」→「图书馆」；「语言课程或英语工作坊」→「语言课程」+「英语工作坊」。
 */
function splitPhrase(token: string): string[] {
  const cleaned = stripGenericWords(token)
  return cleaned
    .split(CONJUNCTIONS)
    .map((part) => part.replace(/^[的了和与及或\s]+|[的了和与及或\s]+$/g, '').trim())
    .filter((part) => [...part].length >= 2)
}

export interface RetrievalQuery {
  /** 所有检索词（按权重降序），调用方用它们做召回与排序 */
  terms: WeightedTerm[]
  /** 拼好的查询串（给 FTS/LIKE 用）：所有词空格分隔 */
  query: string
  /** 是否存在「内容词」（时间/类型等纯过滤问题没有内容词 → 不做相关性重排，保持截止时间序） */
  hasContent: boolean
  /** 命中/补充的跨语言与简繁变体（日志与调试用） */
  variants: string[]
}

/**
 * 构造检索词。
 * @param question 原始问题（用于识别跨语言概念）
 * @param keywords parseQueryIntent 去掉时间/类型词后的关键词（可能为空字符串）
 */
export function buildRetrievalQuery(question: string, keywords: string): RetrievalQuery {
  const q = String(question ?? '').trim()
  const kw = String(keywords ?? '').trim()
  const map = new Map<string, WeightedTerm>()

  // ① 用户原词（去疑问词后的检索词；关键词为空时退回整句的检索词切分）
  //    再做两步清洗：抠掉「邮件/相关」这类泛化词、按「或/和/与」拆并列短语、去掉残留的「的」。
  const exactTokens = extractRetrievalTokens(kw || q).flatMap(splitPhrase)
  for (const t of exactTokens) {
    if (isGenericWord(t)) continue
    addTerm(map, t, W_EXACT, 'exact')
    // ② 简繁变体
    for (const v of [toTraditional(t), toSimplified(t)]) {
      if (v !== t) addTerm(map, v, W_VARIANT, 'variant')
    }
  }

  // ③ 跨语言同义词（也覆盖同语言的别名，如「图书馆」→「圖書」）
  const syn = [...bilingualTerms(q), ...bilingualTerms(kw), ...wordLevelVariants(q), ...wordLevelVariants(kw)]
  for (const s of syn) {
    for (const v of [s, toTraditional(s), toSimplified(s)]) addTerm(map, v, W_SYNONYM, 'synonym')
  }

  // ④ 滑窗兜底（中文长词）与英文前缀兜底（拼写差异）
  for (const t of [...exactTokens, ...syn]) {
    if (hasCjk(t)) {
      for (const w of windows(t)) addTerm(map, w, W_WINDOW, 'window')
    } else if (/^[a-z0-9]+$/i.test(t) && t.length > PREFIX_MIN) {
      addTerm(map, t.slice(0, PREFIX_LEN), W_WINDOW, 'window')
    }
  }

  const terms = [...map.values()].sort((a, b) => b.weight - a.weight || b.term.length - a.term.length)
  // hasContent 只看「用户自己的内容词」：纯时间/类型问题（"这周有什么截止"）parseQueryIntent
  // 会把关键词全部剥掉 → 这里判定为"没有内容词"，调用方据此跳过相关性重排，
  // 保持结构化过滤的「未来最近截止优先」顺序（否则会被 deadline/due 这类同义词打乱）。
  const hasContent = kw.length > 0 && terms.some((t) => t.kind === 'exact')
  return {
    terms,
    query: terms.map((t) => t.term).join(' '),
    hasContent,
    variants: terms.filter((t) => t.kind === 'variant' || t.kind === 'synonym').map((t) => t.term)
  }
}
