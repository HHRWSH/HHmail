import { describe, expect, it } from 'vitest'
import { bilingualTerms, isGenericWord, stripGenericWords, wordLevelVariants } from './bilingual'

describe('bilingual —— 中英跨语言检索词（真机短板：中文问、英文语料）', () => {
  it('中文问题补英文写法（评测里漏召回的「图书馆」）', () => {
    const terms = bilingualTerms('图书馆相关的邮件有哪些？')
    expect(terms).toContain('library')
    expect(terms).toContain('libraries')
  })

  it('英文问题补中文写法（反向也要能命中中文语料）', () => {
    const terms = bilingualTerms('Library opening hours')
    expect(terms).toContain('图书馆')
    expect(terms).toContain('圖書館')
  })

  it('常见校园主题：学费 / 宿舍 / 实习 / 考试 / 选课', () => {
    expect(bilingualTerms('学费什么时候交？')).toEqual(expect.arrayContaining(['tuition', 'fee', 'fees', 'billing']))
    expect(bilingualTerms('宿舍或住宿相关通知？')).toEqual(expect.arrayContaining(['hostel', 'accommodation']))
    expect(bilingualTerms('实习或就业相关的邮件？')).toEqual(expect.arrayContaining(['internship', 'job', 'career']))
    expect(bilingualTerms('有哪些考试或测验？')).toEqual(expect.arrayContaining(['exam', 'quiz', 'midterm']))
    expect(bilingualTerms('选课什么时候开始？')).toEqual(expect.arrayContaining(['course registration', 'enrollment']))
  })

  it('英文按词边界匹配：fee 不会命中 coffee', () => {
    const coffee = bilingualTerms('coffee corner discount')
    expect(coffee).not.toContain('tuition')
    expect(coffee).not.toContain('学费')
    // discount 是「优惠」概念，应该命中并补中文
    expect(coffee).toContain('优惠')
    expect(bilingualTerms('tuition payment')).toContain('学费')
  })

  it('stripGenericWords 抠掉泛化词（「图书馆相关的邮件」→「图书馆」）', () => {
    const stripped = stripGenericWords('图书馆相关的邮件')
    expect(stripped).not.toContain('邮件')
    expect(stripped).not.toContain('相关')
    expect(stripGenericWords('Any new email from library')).not.toMatch(/email/i)
  })

  it('没命中任何概念时返回空（不引入噪声）', () => {
    expect(bilingualTerms('hello there')).toEqual([])
    expect(bilingualTerms('')).toEqual([])
  })

  it('词级简繁/异体：注册→註冊、回复→回覆、平台→平臺', () => {
    expect(wordLevelVariants('注册新账号')).toContain('註冊')
    expect(wordLevelVariants('请回复我')).toContain('回覆')
    expect(wordLevelVariants('平台登录')).toContain('平臺')
    expect(wordLevelVariants('无关文本')).toEqual([])
  })

  it('过于泛化的邮件词被识别出来（"邮件"命中一切，不参与打分）', () => {
    expect(isGenericWord('邮件')).toBe(true)
    expect(isGenericWord('email')).toBe(true)
    expect(isGenericWord('Library')).toBe(false)
  })
})
