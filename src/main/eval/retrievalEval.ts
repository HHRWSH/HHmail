/**
 * 离线检索评测（M1）：判断「当前检索材料」够不够用，决定要不要上向量。
 *
 * 设计：直接复用线上链路（collectAskContext），避免评测跑的是另一套逻辑。
 * 不需要 API Key、不调用大模型 —— 只评「检索是否把正确的邮件召回」。
 *
 * 用法（详见 docs/检索评测.md）：
 *   1. 编辑 tests/eval/questions.json：填问题，把「正确邮件」的 id 写进 expect
 *      （第一轮可以留空，运行后脚本会打印每题的候选邮件供你挑）
 *   2. npm run eval:retrieval
 *   3. 看控制台与 tests/eval/report.md 里的 Recall@1 / Recall@5
 */
import type { Logger } from '../logger'
import { collectAskContext, type InboxSearch } from '../ai/service'

export interface EvalQuestion {
  q: string
  /** 期望命中的邮件 id（本地 messages.id） */
  expect?: number[]
  /**
   * true = 集合题（"这周有什么截止""有哪些奖学金"）：按「覆盖率」评估
   *        （|召回 ∩ 期望| / |期望|），而不是「命中任一即算对」。
   * false/缺省 = 命中任一即算对（Recall@1/@5）。
   */
  expectAll?: boolean
  note?: string
}

export interface EvalHit {
  id: number
  subject: string
  dateTs: number
  /** 命中来源：索引卡片关键词 / 索引结构化过滤 / 摘要 / 原文 / 最近兜底 */
  source: 'index-keyword' | 'index-filter' | 'summary' | 'body' | 'recent'
}

export interface EvalRow {
  q: string
  expect: number[]
  expectAll: boolean
  hits: EvalHit[]
  /** 命中的期望邮件在结果里的名次（1 起；0 = 没召回） */
  firstHitRank: number
  recallAt1: boolean
  recallAt5: boolean
  /** 集合题覆盖率：|命中 ∩ 期望| / |期望| */
  coverage: number
  /** 覆盖率用到的命中数（集合题看全部召回，不受 topK 截断影响） */
  coveredCount: number
  /** 排除「最近兜底」后的名次（0 = 未召回） */
  strictRank: number
}

export interface EvalReport {
  rows: EvalRow[]
  total: number
  /** 有标注的题目数量（expect 非空的才算分） */
  scored: number
  recallAt1: number
  recallAt5: number
  /** 集合题平均覆盖率 */
  coverage: number
  /** 严格口径（排除「最近邮件兜底」的命中）——衡量真实检索能力 */
  strictRecallAt1: number
  strictRecallAt5: number
  /** 集合题数量 */
  setQuestions: number
  /** 各来源贡献的命中数（用于判断「索引卡片是否真的有用」） */
  sourceStats: Record<EvalHit['source'], number>
}

/** 跑一遍评测（纯检索，无 LLM）。 */
export async function runRetrievalEval(
  store: InboxSearch,
  questions: EvalQuestion[],
  opts: { topK?: number; logger?: Logger } = {}
): Promise<EvalReport> {
  const topK = opts.topK ?? 5
  const rows: EvalRow[] = []
  const sourceStats: Record<EvalHit['source'], number> = {
    'index-keyword': 0,
    'index-filter': 0,
    summary: 0,
    body: 0,
    recent: 0
  }

  for (const item of questions) {
    const ctx = await collectAskContext(store, item.q, topK, opts.logger)
    const hits: EvalHit[] = []
    const seen = new Set<number>()
    const push = (id: number, subject: string, dateTs: number, source: EvalHit['source']): void => {
      if (seen.has(id)) return
      seen.add(id)
      hits.push({ id, subject, dateTs, source })
      sourceStats[source] += 1
    }
    for (const d of ctx.indexDocs) push(d.id, d.subject, d.dateTs, d.via === 'filter' ? 'index-filter' : 'index-keyword')
    for (const s of ctx.summaries) push(s.id, s.subject, s.dateTs, 'summary')
    for (const m of ctx.mails) push(m.id, m.subject, m.dateTs, ctx.usedRecentFallback ? 'recent' : 'body')

    const expect = item.expect ?? []
    const expectAll = item.expectAll === true
    const rank = expect.length > 0 ? hits.findIndex((h) => expect.includes(h.id)) + 1 : 0
    const strictHits = hits.filter((h) => h.source !== 'recent')
    const strictRank = expect.length > 0 ? strictHits.findIndex((h) => expect.includes(h.id)) + 1 : 0
    // 集合题：用全部召回（不受 topK 截断）算覆盖率
    const coveredCount = expectAll ? hits.filter((h) => expect.includes(h.id)).length : 0
    rows.push({
      q: item.q,
      expect,
      expectAll,
      hits: hits.slice(0, topK),
      firstHitRank: rank,
      recallAt1: expect.length > 0 && !expectAll ? rank === 1 : false,
      recallAt5: expect.length > 0 && !expectAll ? rank > 0 && rank <= topK : false,
      coverage: expectAll && expect.length > 0 ? coveredCount / expect.length : 0,
      coveredCount,
      strictRank
    })
  }

  const scoredRows = rows.filter((r) => r.expect.length > 0 && !r.expectAll)
  const setRows = rows.filter((r) => r.expect.length > 0 && r.expectAll)
  return {
    rows,
    total: rows.length,
    scored: scoredRows.length,
    recallAt1: scoredRows.length ? scoredRows.filter((r) => r.recallAt1).length / scoredRows.length : 0,
    recallAt5: scoredRows.length ? scoredRows.filter((r) => r.recallAt5).length / scoredRows.length : 0,
    coverage: setRows.length ? setRows.reduce((a, r) => a + r.coverage, 0) / setRows.length : 0,
    setQuestions: setRows.length,
    strictRecallAt1: scoredRows.length ? scoredRows.filter((r) => r.strictRank === 1).length / scoredRows.length : 0,
    strictRecallAt5: scoredRows.length
      ? scoredRows.filter((r) => r.strictRank > 0 && r.strictRank <= topK + 4).length / scoredRows.length
      : 0,
    sourceStats
  }
}

/** 生成可直接贴进 report.md 的报告文本。 */
export function formatEvalReport(report: EvalReport, label = ''): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`
  const lines: string[] = []
  lines.push(`# 检索评测报告${label ? ` · ${label}` : ''}`)
  lines.push('')
  lines.push('## 总览')
  lines.push('')
  lines.push('| 指标 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 问题数 | ${report.total} |`)
  lines.push(`| 已标注（参与打分） | ${report.scored} |`)
  lines.push(`| Recall@1 | ${report.scored ? pct(report.recallAt1) : '—'} |`)
  lines.push(`| Recall@5 | ${report.scored ? pct(report.recallAt5) : '—'} |`)
  lines.push(`| Recall@1（严格：排除最近兜底） | ${report.scored ? pct(report.strictRecallAt1) : '—'} |`)
  lines.push(`| Recall@5（严格：排除最近兜底） | ${report.scored ? pct(report.strictRecallAt5) : '—'} |`)
  lines.push(`| 集合题数量 | ${report.setQuestions} |`)
  lines.push(`| 平均覆盖率（集合题） | ${report.setQuestions ? pct(report.coverage) : '—'} |`)
  lines.push('')
  lines.push('## 命中来源分布（每题取 top5 内的去重结果）')
  lines.push('')
  lines.push('| 来源 | 条数 |')
  lines.push('| --- | --- |')
  for (const [k, v] of Object.entries(report.sourceStats)) lines.push(`| ${k} | ${v} |`)
  lines.push('')
  lines.push('## 逐题结果')
  lines.push('')
  for (const r of report.rows) {
    const mark =
      r.expect.length === 0
        ? '（未标注）'
        : r.expectAll
          ? `集合题 覆盖 ${r.coveredCount}/${r.expect.length}（${(r.coverage * 100).toFixed(0)}%）`
          : r.recallAt1
            ? '✅ 命中第 1'
            : r.recallAt5
              ? `🟡 第 ${r.firstHitRank}`
              : '❌ 未召回'
    lines.push(`### ${r.q} ${mark}`)
    if (r.expect.length > 0) lines.push(`- 期望：${r.expect.join(', ')}`)
    for (const h of r.hits) {
      const hit = r.expect.includes(h.id) ? ' ←期望' : ''
      lines.push(`- [${h.source}] #${h.id} ${h.subject}${hit}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
