/**
 * 全文搜索查询构建（纯函数，规范 §6.6）。
 * - FTS5 trigram：≥3 字符的 token 走 MATCH（引号短语，转义 `"`）；
 * - 短中文词（<3 字符）trigram 无法命中 → LIKE 兜底扫描。
 */
import type { MessageStore, SearchHit } from './store'

export function tokenizeSearchTerms(term: string): string[] {
  return (term || '')
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function escapeFtsPhrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}

/** 仅包含 trigram 可索引 token（≥3 字符）的 FTS MATCH 串；不可用返回 null。 */
export function buildFtsQuery(term: string): string | null {
  const ftsTokens = tokenizeSearchTerms(term).filter((t) => [...t].length >= 3)
  if (ftsTokens.length === 0) return null
  return ftsTokens.map(escapeFtsPhrase).join(' AND ')
}

/** LIKE 兜底：转义 % _ \ 后做包含匹配。 */
export function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function buildLikePattern(term: string): string {
  return `%${escapeLike(term)}%`
}

export interface SearchPlan {
  ftsQuery: string | null
  likePattern: string
  ftsTokens: string[]
}

export function buildSearchPlan(term: string): SearchPlan {
  return {
    ftsQuery: buildFtsQuery(term),
    likePattern: buildLikePattern(term),
    ftsTokens: tokenizeSearchTerms(term).filter((t) => [...t].length >= 3)
  }
}

/**
 * 合并 FTS 命中与 LIKE 兜底命中（按 id 去重）。
 * ftsHits / likeHits 由 store 层实现注入——这里只做合并与排序，便于单测。
 */
export function mergeSearchHits(ftsHits: SearchHit[], likeHits: SearchHit[]): SearchHit[] {
  const byId = new Map<number, SearchHit>()
  for (const h of ftsHits) byId.set(h.id, h)
  for (const h of likeHits) {
    if (!byId.has(h.id)) byId.set(h.id, h)
  }
  return [...byId.values()].sort((a, b) => b.dateTs - a.dateTs)
}



// ---------- M1：自然语言问题的检索词（去疑问词，OR 召回） ----------
//
// 真机评测（scripts/eval-retrieval.ts）发现：把这个中文问句
//   「Blackboard 上有什么新通知？」
// 原样丢给 trigram FTS → `"Blackboard" AND "上有什么新通知？"` → 第二段永远匹配不上 → 0 命中，
// 于是 AI 助手只能退回「最近邮件」兜底。这里把疑问词/停顿词剥掉再召回。

// 检索词切分/去疑问词已抽到 src/shared/searchTokens.ts（跨语言查询构造也要用），这里只做转出。
export { extractRetrievalTokens } from '../../shared/searchTokens'

/** 用检索词构造 FTS MATCH：and = 全部命中（精确），or = 命中任一（召回优先，bm25 排序）。 */
export function buildFtsQueryFromTokens(tokens: string[], mode: 'and' | 'or' = 'and'): string | null {
  const ftsTokens = tokens.filter((t) => [...t].length >= 3)
  if (ftsTokens.length === 0) return null
  return ftsTokens.map(escapeFtsPhrase).join(mode === 'or' ? ' OR ' : ' AND ')
}

/** 用检索词构造 LIKE 模式列表（每个 token 一个 %token%）。 */
export function buildLikePatternsFromTokens(tokens: string[]): string[] {
  return tokens.filter((t) => t.length >= 2).map((t) => buildLikePattern(t))
}

/**
 * 长中文串切成 3 字滑窗：FTS5 trigram 只能匹配 ≥3 字符的子串，
 * 「要交作业」这种 4 字短语如果整串做短语匹配，正文里几乎不会原样出现 → 0 命中。
 * 切成滑窗后 OR 召回，再由 bm25 排序，召回率显著提升。
 */
export function expandRetrievalTokens(tokens: string[], maxPerToken = 4): string[] {
  const out: string[] = []
  for (const t of tokens) {
    if (/^[a-zA-Z0-9]+$/.test(t)) {
      out.push(t)
      continue
    }
    const chars = [...t]
    if (chars.length <= 2) {
      out.push(t)
      continue
    }
    // 3 字滑窗给 FTS（trigram 下限），2 字滑窗给 LIKE 兜底。
    // 真机教训：问「学费什么时候交」→ 词干「学费交」在正文里并不连续出现，
    // 3 字滑窗全落空；补 2 字滑窗后「学费」能命中（LIKE 只需要 ≥2 字）。
    let added = 0
    for (let i = 0; i + 3 <= chars.length && added < maxPerToken; i += 1) {
      out.push(chars.slice(i, i + 3).join(''))
      added += 1
    }
    added = 0
    for (let i = 0; i + 2 <= chars.length && added < maxPerToken; i += 1) {
      out.push(chars.slice(i, i + 2).join(''))
      added += 1
    }
    // 同时保留原串（精确命中时权重更高，由 bm25 决定）
    out.push(t)
  }
  return [...new Set(out)]
}
