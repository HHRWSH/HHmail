import { describe, expect, it } from 'vitest'
import {
  clampText,
  deadlineUrgency,
  earliestDeadline,
  formatRemaining,
  inlinePlain,
  parseDeadline,
  shortDeadline,
  sortActionItems,
  parseActionItems,
  parseCategories,
  parseImportance,
  parseKeyInfoTable,
  parseQuotes,
  splitSummarySections
} from './summaryView'

const SAMPLE = `## 主旨

宣传「共伴同行」静观之旅英语工作坊，09-18 截止报名。

## 重要度

**中**

## 关键信息

| 项目 | 内容 |
| --- | --- |
| 时间 | 2026-09-30（星期三）14:30 - 16:30；共 2 节 |
| 地点 | 组m 303, 3/F, Pommerenke Student Centre |
| 金额 | 免费；按金 100 元，出席后退回 |
| 联系人 | mpps@example.edu |

## 截止与行动项

- [ ] 2026-09-18 前网上报名 —— 截止：2026-09-18 23:59
- [x] 已阅读海报

## 分类

活动通知、心理健康

## 原文摘录

> 名额 20 人，先到先得。
`

describe('splitSummarySections —— 摘要小节解析', () => {
  it('按 ## 标题拆成小节且去掉加粗与冒号', () => {
    const sections = splitSummarySections(SAMPLE)
    expect(sections.map((s) => s.title)).toEqual(['主旨', '重要度', '关键信息', '截止与行动项', '分类', '原文摘录'])
    expect(sections[0].body).toContain('共伴同行')
    expect(sections[2].body).toContain('Pommerenke')
  })

  it('没有 ## 结构（老摘要）→ 返回空数组，交给通用渲染兜底', () => {
    expect(splitSummarySections('【一句话主旨】老师要求周五前交第三章。')).toEqual([])
    expect(splitSummarySections('')).toEqual([])
    expect(splitSummarySections(null)).toEqual([])
  })

  it('只有标题没有正文的空小节会被丢掉', () => {
    const sections = splitSummarySections('## 主旨\n\n## 分类\n\n作业通知\n')
    expect(sections.map((s) => s.title)).toEqual(['分类'])
  })

  it('标题前有正文时作为无标题小节放最前（不丢内容）', () => {
    const sections = splitSummarySections('先说结论：要交作业。\n\n## 分类\n\n作业\n')
    expect(sections[0].title).toBe('')
    expect(sections[0].body).toContain('先说结论')
  })

  it('标题里的 ** 与末尾冒号会被清掉（模型偶尔加粗）', () => {
    const sections = splitSummarySections('## **关键信息**：\n\n| 时间 | 明天 |\n')
    expect(sections[0].title).toBe('关键信息')
  })
})

describe('parseKeyInfoTable —— 关键信息表格 → 定义列表', () => {
  it('解析标签/内容两列，跳过表头与分隔行', () => {
    const rows = parseKeyInfoTable(
      ['| 项目 | 内容 |', '| --- | --- |', '| 时间 | 09-30 14:30 |', '| 地点 | 303 室 |'].join('\n')
    )
    expect(rows).toEqual([
      { label: '时间', value: '09-30 14:30' },
      { label: '地点', value: '303 室' }
    ])
  })

  it('多列拼成值；无表格时返回空数组', () => {
    expect(parseKeyInfoTable('| 联系人 | mpps@example.edu | 3943 9951 |')).toEqual([
      { label: '联系人', value: 'mpps@example.edu · 3943 9951' }
    ])
    expect(parseKeyInfoTable('没有表格')).toEqual([])
  })
})

describe('parseActionItems —— 行动项与截止时间', () => {
  it('解析勾选状态、剥离「—— 截止：」并单独取出截止时间', () => {
    const items = parseActionItems('- [ ] 网上报名 —— 截止：2026-09-18 23:59\n- [x] 已阅读海报')
    expect(items[0]).toEqual({ text: '网上报名', done: false, deadline: '2026-09-18 23:59' })
    expect(items[1]).toEqual({ text: '已阅读海报', done: true, deadline: null })
  })

  it('没有截止时间的条目也保留；非列表行按普通句子处理', () => {
    const items = parseActionItems('1. 回复导师\n请直接阅读正文确认')
    expect(items[0].text).toBe('回复导师')
    expect(items[1].text).toContain('请直接阅读正文')
  })
})

describe('parseImportance / parseCategories / parseQuotes / inlinePlain', () => {
  it('重要度识别高/中/低，识别不到返回 null', () => {
    expect(parseImportance('**高**')).toBe('高')
    expect(parseImportance('中')).toBe('中')
    expect(parseImportance('低')).toBe('低')
    expect(parseImportance('未知')).toBeNull()
  })

  it('分类按顿号/逗号/斜杠切分并限制数量', () => {
    expect(parseCategories('活动通知、心理健康')).toEqual(['活动通知', '心理健康'])
    expect(parseCategories('- 作业\n- 截止提醒')).toEqual(['作业', '截止提醒'])
  })

  it('原文摘录去掉引用符号', () => {
    expect(parseQuotes('> 名额 20 人\n“先到先得”')).toEqual(['名额 20 人', '先到先得'])
  })

  it('inlinePlain 去掉行内 Markdown 标记', () => {
    expect(inlinePlain('**周五**前回复 `导师`')).toBe('周五前回复 导师')
  })
})

describe('截止时间：解析 / 排序 / 倒计时（让用户一眼看到「还剩多久」）', () => {
  const now = new Date(2026, 8, 11, 12, 0, 0).getTime() // 2026-09-11 12:00

  it('parseDeadline 支持多种写法', () => {
    expect(parseDeadline('2026-09-11 23:59', now)).toBe(new Date(2026, 8, 11, 23, 59).getTime())
    expect(parseDeadline('09-11 23:59', now)).toBe(new Date(2026, 8, 11, 23, 59).getTime())
    expect(parseDeadline('9月11日 23:59', now)).toBe(new Date(2026, 8, 11, 23, 59).getTime())
    expect(parseDeadline('09-12（本周五）18:00', now)).toBe(new Date(2026, 8, 12, 18, 0).getTime())
    expect(parseDeadline('明天 09:00', now)).toBe(new Date(2026, 8, 12, 9, 0).getTime())
    expect(parseDeadline('今天', now)).toBe(new Date(2026, 8, 11, 23, 59).getTime())
    expect(parseDeadline('', now)).toBeNull()
    expect(parseDeadline('尽快', now)).toBeNull()
  })

  it('只有月日且已过去很久 → 视为明年（避免显示成「已过期 300 天」）', () => {
    const late = new Date(2026, 11, 20, 10, 0).getTime() // 2026-12-20
    expect(parseDeadline('01-15', late)).toBe(new Date(2027, 0, 15, 23, 59).getTime())
  })

  it('sortActionItems：未完成在前，有截止的按时间从早到晚', () => {
    const items = [
      { text: 'C', done: false, deadline: '09-20 23:59' },
      { text: 'A', done: false, deadline: '09-11 23:59' },
      { text: 'B', done: false, deadline: null },
      { text: 'D', done: true, deadline: '09-01 23:59' }
    ]
    expect(sortActionItems(items, now).map((i) => i.text)).toEqual(['A', 'C', 'B', 'D'])
  })

  it('earliestDeadline 同时看行动项与「截止」行', () => {
    const items = [{ text: '交作业', done: false, deadline: '09-20 23:59' }]
    const rows = [{ label: '截止', value: '2026-09-11 23:59' }]
    expect(earliestDeadline(items, rows, now)).toBe(new Date(2026, 8, 11, 23, 59).getTime())
    expect(earliestDeadline([{ text: 'x', done: true, deadline: '09-01 23:59' }], [], now)).toBeNull()
  })

  it('formatRemaining / deadlineUrgency：显示还剩多久与紧急度', () => {
    const in8h = new Date(2026, 8, 11, 20, 0).getTime()
    expect(formatRemaining(in8h, now)).toBe('还有 8 小时')
    expect(deadlineUrgency(in8h, now)).toBe('soon')
    const in2d = new Date(2026, 8, 13, 20, 0).getTime()
    expect(deadlineUrgency(in2d, now)).toBe('near')
    const past = new Date(2026, 8, 9, 12, 0).getTime()
    expect(formatRemaining(past, now)).toBe('已过期 2 天')
    expect(deadlineUrgency(past, now)).toBe('past')
  })

  it('shortDeadline / clampText：界面里省位置、防止长句撑破布局', () => {
    expect(shortDeadline('2026-09-11 23:59')).toBe('09-11 23:59')
    expect(shortDeadline('09-11')).toBe('09-11')
    expect(clampText('**周五**前把第三章实验数据发给导师，并抄送助教', 10)).toBe('周五前把第三章实验数…')
  })
})
