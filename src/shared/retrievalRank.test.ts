import { describe, expect, it } from 'vitest'
import { rankByTerms, scoreFields } from './retrievalRank'
import type { WeightedTerm } from './retrievalQuery'

const t = (term: string, weight = 2): WeightedTerm => ({ term, weight, kind: 'synonym' })

describe('retrievalRank —— 相关性排序（用户要求「第一条就命中」）', () => {
  it('主题命中 > 正文命中', () => {
    const terms = [t('学费'), t('fee')]
    const subjectHit = scoreFields({ subject: 'Tuition Fee Notice', body: '' }, terms)
    const bodyHit = scoreFields({ subject: 'Daily Notifications', body: '...fees...' }, terms)
    expect(subjectHit).toBeGreaterThan(bodyHit)
  })

  it('英文词按词边界加分：fee 不命中 coffee', () => {
    const terms = [t('fee')]
    expect(scoreFields({ subject: 'fee payment', body: '' }, terms)).toBeGreaterThan(0)
    expect(scoreFields({ subject: 'coffee corner', body: '' }, terms)).toBe(0)
  })

  it('命中不同检索词越多分越高（覆盖度）', () => {
    const terms = [t('实习'), t('internship'), t('job')]
    const both = scoreFields({ subject: 'Internships and Job Openings', body: '' }, terms)
    const one = scoreFields({ subject: 'Internship report', body: '' }, terms)
    expect(both).toBeGreaterThan(one)
  })

  it('权重生效：用户原词（3）胜过滑窗（1）', () => {
    const exact = scoreFields({ subject: '学费缴纳通知', body: '' }, [{ term: '学费', weight: 3, kind: 'exact' }])
    const win = scoreFields({ subject: '学费缴纳通知', body: '' }, [{ term: '学费', weight: 1, kind: 'window' }])
    expect(exact).toBeGreaterThan(win)
  })

  it('排序稳定：同分保持原顺序（结构化过滤已按截止时间排好）', () => {
    const items = [
      { id: 1, subject: 'A 无关', body: '' },
      { id: 2, subject: 'B 无关', body: '' },
      { id: 3, subject: 'C 无关', body: '' }
    ]
    expect(rankByTerms(items, [t('不存在')]).map((i) => i.id)).toEqual([1, 2, 3])
  })

  it('把最相关的那条排到第一（真机场景：同类里挑出「学费」那封）', () => {
    const items = [
      { id: 126, subject: 'Locker Application for Non-residential Students', body: '儲物箱 申請' },
      { id: 135, subject: 'Non-means-tested Loan Scheme 2026/27', body: 'loan application' },
      { id: 115, subject: 'Tuition Fee Notice for Term 1', body: '[TYPE] 行政 [FACTS] 学费 缴费' }
    ]
    const ranked = rankByTerms(items, [t('学费', 3), t('fee'), t('fees'), t('billing'), t('tuition')])
    expect(ranked[0].id).toBe(115)
  })

  it('汇总类标题降权：内容命中相同时，具体邮件排在「Daily Notifications」之前', () => {
    const terms = [t('Blackboard', 3), t('通知', 2)]
    const items = [
      { id: 1, subject: 'Daily Notifications', body: 'Blackboard 通知' },
      { id: 2, subject: 'CLASS CANCELLED on Monday', body: 'Blackboard 通知' }
    ]
    expect(rankByTerms(items, terms)[0].id).toBe(2)
    // 关掉降权则保持原顺序（说明差别确实来自降权，而不是别的规则）
    expect(rankByTerms(items, terms, { penalizeAggregator: false })[0].id).toBe(1)
  })

  it('全库 IDF 优先于候选池统计（避免"看起来常见"的词被误判）', () => {
    const terms = [t('library', 3)]
    const items = [
      { id: 1, subject: 'University Library Newsletter', body: '' },
      { id: 2, subject: 'Library Orientation', body: '' }
    ]
    const idf = new Map([
      ['library', 0.2]
    ])
    // 同分时保持原顺序（稳定排序）
    expect(rankByTerms(items, terms, { idf }).map((i) => i.id)).toEqual([1, 2])
  })

  it('空 terms 或空列表时原样返回', () => {
    const items = [{ id: 1, subject: 'x', body: '' }]
    expect(rankByTerms(items, [])).toBe(items)
    expect(rankByTerms([], [t('a')])).toEqual([])
  })
})
