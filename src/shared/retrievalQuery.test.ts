import { describe, expect, it } from 'vitest'
import { buildRetrievalQuery } from './retrievalQuery'

describe('buildRetrievalQuery —— 检索词构造（跨语言 + 简繁 + 滑窗 + 权重）', () => {
  it('中文问题：「图书馆」补英文与繁体写法', () => {
    const rq = buildRetrievalQuery('图书馆相关的邮件有哪些？', '图书馆相关的邮件')
    const terms = rq.terms.map((t) => t.term)
    expect(terms).toContain('图书馆')
    expect(terms).toContain('圖書館')
    expect(terms).toContain('library')
    expect(rq.hasContent).toBe(true)
    // 用户原词权重最高，同义词次之，滑窗最低
    const w = (t: string): number => rq.terms.find((x) => x.term === t)?.weight ?? 0
    expect(w('图书馆')).toBe(3)
    expect(w('library')).toBe(2)
    expect(w('图书')).toBeLessThan(3)
  })

  it('英文问题也能补中文（反向）', () => {
    const rq = buildRetrievalQuery('Any library notice?', 'library notice')
    const terms = rq.terms.map((t) => t.term)
    expect(terms).toContain('图书馆')
    expect(terms).toContain('圖書館')
  })

  it('长中文串切滑窗（trigram 只能匹配 ≥3 字子串）', () => {
    const rq = buildRetrievalQuery('语言课程或英语工作坊？', '语言课程或英语工作坊')
    const terms = rq.terms.map((t) => t.term)
    expect(terms).toContain('工作坊')
    expect(terms).toContain('語言課程')
    expect(terms).toContain('英語工作坊')
  })

  it('拼写/派生差异：英文长词补前缀兜底（GraderScope ↔ Gradescope）', () => {
    const rq = buildRetrievalQuery('GraderScope 怎么提交作业？', 'GraderScope 提交作业')
    const terms = rq.terms.map((t) => t.term.toLowerCase())
    expect(terms).toContain('grade')
  })

  it('泛化词被丢掉（"邮件"不该参与打分）', () => {
    const rq = buildRetrievalQuery('有哪些邮件带附件？', '邮件带附件')
    expect(rq.terms.map((t) => t.term)).not.toContain('邮件')
  })

  it('纯时间/类型问题没有内容词 → hasContent=false（保持截止时间排序）', () => {
    const rq = buildRetrievalQuery('这周有什么截止？', '')
    expect(rq.hasContent).toBe(false)
  })

  it('检索串由所有词组成，供 FTS/LIKE 召回', () => {
    const rq = buildRetrievalQuery('学费什么时候交？', '学费 交')
    expect(rq.query).toContain('学费')
    expect(rq.query).toContain('fee')
    expect(rq.hasContent).toBe(true)
  })
})
