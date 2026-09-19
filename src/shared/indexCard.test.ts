import { describe, expect, it } from 'vitest'
import { parseIndexCard, parseQueryIntent } from './indexCard'

const CARD = `[TYPE] 作业 | [COURSE] ENG1110B | [TERM] 2026R1 | [DUE] 2026-09-11 23:59
[FROM] ta@example.edu | [ORG] 电子工程系
[ENTITIES] Lab 0, Experiment 1, GraderScope, Blackboard
[ALIASES] 实验一, 第一次实验, Lab0
[FACTS]
- Lab 0 上机 09-11 23:59 截止，不计分，用 GraderScope 提交
- Experiment 1 同截止，代码相似度查重，禁止抄袭
- TA Office Hours 每周五 15:30-16:30
[QUESTIONS] 这周有什么截止？ | ENG1110B 的实验怎么交？ | 查重政策是什么？
[QUOTE] "Lab 0 is due 11 September at 11:59 pm"`

describe('parseIndexCard —— 索引卡片解析', () => {
  const now = new Date(2026, 8, 1, 10, 0).getTime()

  it('解析结构化字段与截止时间', () => {
    const f = parseIndexCard(CARD, now)
    expect(f.type).toBe('作业')
    expect(f.course).toBe('ENG1110B')
    expect(f.term).toBe('2026R1')
    expect(f.dueTs).toBe(new Date(2026, 8, 11, 23, 59).getTime())
    expect(f.entities).toContain('GraderScope')
    expect(f.aliases).toContain('Lab0')
    expect(f.facts).toHaveLength(3)
    expect(f.quote).toContain('Lab 0 is due')
  })

  it('QUESTIONS 支持 | 与换行两种写法', () => {
    const a = parseIndexCard('[QUESTIONS] 甲？ | 乙？', now)
    expect(a.questions).toEqual(['甲？', '乙？'])
    const b = parseIndexCard('[QUESTIONS]\n- 甲？\n- 乙？\n[TYPE] 通知', now)
    expect(b.questions).toEqual(['甲？', '乙？'])
    expect(b.type).toBe('通知')
  })

  it('缺字段/写「无」时不报错', () => {
    const f = parseIndexCard('[TYPE] 通知\n[DUE] 无\n[COURSE] 无', now)
    expect(f.type).toBe('通知')
    expect(f.dueTs).toBeNull()
    expect(f.dueText).toBeNull()
    expect(f.course).toBeNull()
    expect(f.entities).toEqual([])
  })

  it('空输入安全', () => {
    expect(parseIndexCard('', now).card).toBe('')
    expect(parseIndexCard(null, now).questions).toEqual([])
  })
})

describe('parseQueryIntent —— 查询意图（时间窗 / 类型 / 课程号 / 关键词）', () => {
  // 2026-09-11 是周五
  const now = new Date(2026, 8, 11, 14, 0).getTime()

  it('识别「这周/下周/今天/明天/本月」的时间窗', () => {
    const week = parseQueryIntent('这周有什么截止？', now)
    // 本周一 = 09-07
    expect(week.filter.dueAfter).toBe(new Date(2026, 8, 7, 0, 0, 0, 0).getTime())
    expect(week.filter.dueBefore).toBe(new Date(2026, 8, 13, 23, 59, 59, 999).getTime())
    expect(week.filter.hasDue).toBe(true)
    expect(week.timeHint).toBe('本周')

    expect(parseQueryIntent('明天要交什么？', now).filter.dueAfter).toBe(new Date(2026, 8, 12).getTime())
    expect(parseQueryIntent('下周的截止', now).timeHint).toBe('下周')
    expect(parseQueryIntent('本月截止的作业', now).timeHint).toBe('本月')
    expect(parseQueryIntent('最近 3 天有什么通知', now).timeHint).toBe('最近 3天')
  })

  it('识别类型与课程号', () => {
    const r = parseQueryIntent('ENG1110B 的作业怎么交？', now)
    expect(r.filter.type).toBe('作业')
    expect(r.filter.course).toBe('ENG1110B')
    const e = parseQueryIntent('这学期有哪些考试？', now)
    expect(e.filter.type).toBe('考试')
  })

  it('关键词去掉疑问词与时间/类型词', () => {
    const r = parseQueryIntent('上周导师发了什么邮件？', now)
    expect(r.keywords).toContain('导师')
    expect(r.keywords).not.toContain('什么')
    expect(r.keywords).not.toContain('上周')
    expect(r.timeHint).toBe('上周')
  })

  it('识别「广告推销」类型（评测发现之前没有这条规则 → 问广告时 0 命中）', () => {
    expect(parseQueryIntent('有哪些广告推销邮件？', now).filter.type).toBe('广告')
    expect(parseQueryIntent('有没有促销优惠', now).filter.type).toBe('广告')
  })

  it('无时间/类型词时只给关键词', () => {
    const r = parseQueryIntent('GraderScope 怎么用', now)
    expect(r.filter.type).toBeUndefined()
    expect(r.filter.dueAfter).toBeUndefined()
    expect(r.keywords).toContain('GraderScope')
  })
})
