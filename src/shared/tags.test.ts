import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TAG_VOCABULARY,
  buildTagPromptBlock,
  deriveRuleTags,
  mergeTags,
  normalizeTag,
  parseAiTags,
  parseVocabulary,
  visibleTags,
  vocabularyToText
} from './tags'

describe('标签规范化与词表', () => {
  it('normalizeTag：去 #/【】/空白，最长 12 字', () => {
    expect(normalizeTag('【实习】')).toBe('实习')
    expect(normalizeTag('# 招聘 ')).toBe('招聘')
    expect(normalizeTag('')).toBeNull()
    expect(normalizeTag('一二三四五六七八九十十一十二十三')).toHaveLength(12)
  })

  it('parseVocabulary：逗号/顿号/换行分隔、去重；空则回退默认词表', () => {
    expect(parseVocabulary('实习、招聘，讲座\n实习')).toEqual(['实习', '招聘', '讲座'])
    expect(parseVocabulary('   ')).toEqual([...DEFAULT_TAG_VOCABULARY])
    expect(vocabularyToText(['a', 'b'])).toBe('a、b')
  })
})

describe('A 方案：规则标签（索引卡片字段 → 标签）', () => {
  const now = new Date(2026, 8, 12, 10, 0).getTime()

  it('类型 + 课程号 + 平台', () => {
    const tags = deriveRuleTags(
      { type: '作业', course: 'eng1110b', dueTs: null, entities: ['Lab 0', 'GraderScope'] },
      now
    )
    expect(tags).toContain('作业')
    expect(tags).toContain('ENG1110B')
    // 平台标签按卡片里的实体归一化（GraderScope 的正式名是 Gradescope）
    expect(tags).toContain('Gradescope')
  })

  it('截止：紧急（48 小时内）/ 已过期 / 一般有截止', () => {
    expect(deriveRuleTags({ type: '通知', course: null, dueTs: now + 3 * 3600_000, entities: [] }, now)).toContain('紧急')
    expect(deriveRuleTags({ type: '通知', course: null, dueTs: now - 3600_000, entities: [] }, now)).toContain('已过期')
    expect(deriveRuleTags({ type: '通知', course: null, dueTs: now + 10 * 86_400_000, entities: [] }, now)).toContain('有截止')
  })

  it('无字段时返回空，最多 4 个标签', () => {
    expect(deriveRuleTags({ type: null, course: null, dueTs: null, entities: [] }, now)).toEqual([])
    const many = deriveRuleTags(
      { type: '作业', course: 'ENG1110B', dueTs: now + 3600_000, entities: ['Blackboard', 'Gradescope', 'CUSIS'] },
      now
    )
    expect(many.length).toBeLessThanOrEqual(4)
  })
})

describe('B 方案：AI 标签解析', () => {
  it('解析并统一到词表写法；「无」返回空', () => {
    const vocab = ['实习', '招聘', '讲座']
    expect(parseAiTags('实习、招聘', vocab)).toEqual(['实习', '招聘'])
    expect(parseAiTags('实习, 招聘, 冷门标签', vocab)).toEqual(['实习', '招聘', '冷门标签'])
    expect(parseAiTags('无', vocab)).toEqual([])
    expect(parseAiTags('', vocab)).toEqual([])
    expect(parseAiTags('a、b、c、d', vocab)).toHaveLength(3) // 最多 3 个
  })

  it('示例邮件块：带词表与用户认可的标签，不夹带正文', () => {
    const block = buildTagPromptBlock(['实习', '招聘'], [
      { id: 1, subject: '[Weekly Highlights] Internships and Job Openings', tags: ['实习', '招聘'] },
      { id: 2, subject: '无关邮件', tags: [] }
    ])
    expect(block).toContain('标签只能从这个词表里挑')
    expect(block).toContain('Internships and Job Openings')
    expect(block).toContain('实习、招聘')
    expect(block).not.toContain('无关邮件') // 没有标签的示例不参与
  })
})

describe('标签合并与展示', () => {
  it('mergeTags：规则在前、AI 在后、去重', () => {
    expect(mergeTags(['作业', 'ENG1110B'], ['ENG1110B', '紧急'], ['需回复'])).toEqual(['作业', 'ENG1110B', '紧急', '需回复'])
  })

  it('visibleTags：超过上限折叠为 +N', () => {
    expect(visibleTags(['a', 'b'])).toEqual({ shown: ['a', 'b'], more: 0 })
    expect(visibleTags(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 })
  })
})
