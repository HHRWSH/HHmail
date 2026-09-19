import { describe, expect, it } from 'vitest'
import { buildFtsQuery, buildLikePattern, buildSearchPlan, escapeLike, expandRetrievalTokens, extractRetrievalTokens, mergeSearchHits, tokenizeSearchTerms } from './search'
import type { SearchHit } from './store'

describe('搜索查询构建（规范 §6.6）', () => {
  it('tokenize：按空白切分并过滤空串', () => {
    expect(tokenizeSearchTerms('  选课  通知 ')).toEqual(['选课', '通知'])
    expect(tokenizeSearchTerms('')).toEqual([])
  })

  it('FTS：≥3 字符的 token 转义后 AND 组合；<3 字符 token 不进 FTS', () => {
    expect(buildFtsQuery('VPN 校园网')).toBe('"VPN" AND "校园网"')
    expect(buildFtsQuery('毕业论文')).toBe('"毕业论文"')
    expect(buildFtsQuery('AB')).toBeNull() // 2 字符 trigram 无法索引
    expect(buildFtsQuery('通知')).toBeNull() // 2 个中文字符 → LIKE 兜底
    expect(buildFtsQuery('VPN 指南')).toBe('"VPN"') // 2 字中文 token 被剔除
  })

  it('FTS：用户输入的引号被转义，防止语法错误', () => {
    expect(buildFtsQuery('a"b"c')).toBe('"a""b""c"')
  })

  it('LIKE：% _ \\ 被转义', () => {
    expect(escapeLike('100%_x')).toBe('100\\%\\_x')
    expect(buildLikePattern('50%off')).toBe('%50\\%off%')
  })

  it('buildSearchPlan 同时给 FTS 与 LIKE 方案', () => {
    const plan = buildSearchPlan('VPN 校园网')
    expect(plan.ftsQuery).toBe('"VPN" AND "校园网"')
    expect(plan.likePattern).toBe('%VPN 校园网%')
  })
})

describe('mergeSearchHits —— 按 id 去重 + 日期倒序', () => {
  it('FTS 与 LIKE 合并去重，日期倒序', () => {
    const hit = (id: number, dateTs: number): SearchHit => ({
      id,
      uid: id,
      threadId: `t-${id}`,
      subject: 's',
      fromName: 'a',
      fromAddr: 'a@x',
      dateTs,
      snippet: ''
    })
    const merged = mergeSearchHits([hit(1, 100), hit(2, 300)], [hit(2, 300), hit(3, 200)])
    expect(merged.map((h) => h.id)).toEqual([2, 3, 1])
  })
})


describe('M1：AI 问答的检索词处理（真机评测驱动）', () => {
  it('extractRetrievalTokens：去掉疑问词/时间词，保留有信息量的词', () => {
    expect(extractRetrievalTokens('下周要交什么作业？')).toEqual(['要交作业'])
    // 英文 token 保持原样（大小写不强制转换），中文部分去掉疑问词与首尾停顿字
    expect(extractRetrievalTokens('Blackboard 上有什么新通知？')).toEqual(['Blackboard', '新通知'])
    // 「有哪些」被剥掉后剩下「考试或测验」——整词交给 FTS/LIKE 时并不理想，
    // 但 2 字滑窗会拆出「考试」「测验」，实际召回由 expandRetrievalTokens + LIKE 兜底
    expect(expandRetrievalTokens(extractRetrievalTokens('有哪些考试或测验？'))).toEqual(
      expect.arrayContaining(['考试', '测验'])
    )
  })

  it('expandRetrievalTokens：中文同时给 3 字滑窗（FTS）与 2 字滑窗（LIKE 兜底）', () => {
    const tokens = expandRetrievalTokens(extractRetrievalTokens('学费什么时候交？'))
    // 「学费交」在正文里不连续出现，3 字滑窗全落空；2 字滑窗里的「学费」才能通过 LIKE 命中
    expect(tokens).toContain('学费交')
    expect(tokens).toContain('学费')
    expect(tokens).toContain('费交')
  })

  it('英文 token 不做滑窗（整词匹配）', () => {
    expect(expandRetrievalTokens(['blackboard'])).toEqual(['blackboard'])
  })
})
