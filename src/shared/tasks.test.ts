import { describe, expect, it } from 'vitest'
import {
  cnWeekStart,
  filterTasksByRange,
  formatTaskDue,
  isOverdue,
  mergeTaskCandidates,
  parseActionItems,
  parseDueText,
  sortTasks,
  taskKey,
  type TaskItem
} from './tasks'

/** 北京时间某时刻的绝对时间戳 */
const hkt = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

const summary = [
  '# 决策卡',
  '',
  '## 主旨',
  '这封邮件讲实验安排。',
  '',
  '## 截止与行动项',
  '- [ ] 完成 Lab 0 上机 —— 截止：2026-09-16 23:59',
  '- [ ] 提交 Experiment 1 —— 截止：2026-09-18 14:42',
  '- [x] 已经交过的报告 —— 截止：2026-09-10 23:59',
  '- [ ] 读一下阅读材料',
  '',
  '## 关键信息',
  '- 地点 SHB 123' // 不在行动项小节，不应被解析
].join('\n')

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: 1,
  messageId: 10,
  title: 't',
  dueTs: null,
  source: 'summary',
  done: false,
  createdAt: 0,
  updatedAt: 0,
  ...over
})

describe('待办 —— 截止时间解析（北京时间）', () => {
  it('YYYY-MM-DD HH:mm', () => {
    expect(parseDueText('2026-09-16 14:42', 2026)).toBe(hkt(2026, 9, 16, 14, 42))
  })

  it('只有日期 → 默认当天 23:59（北京时间）', () => {
    expect(parseDueText('2026-09-16', 2026)).toBe(hkt(2026, 9, 16, 23, 59))
  })

  it('无年份（09-16 14:42）→ 用 fallbackYear', () => {
    expect(parseDueText('09-16 14:42', 2027)).toBe(hkt(2027, 9, 16, 14, 42))
  })

  it('中文写法 2026年9月16日 14:42', () => {
    expect(parseDueText('2026年9月16日 14:42', 2026)).toBe(hkt(2026, 9, 16, 14, 42))
  })

  it('解析不了 → null', () => {
    expect(parseDueText('下周找个时间', 2026)).toBeNull()
    expect(parseDueText('', 2026)).toBeNull()
  })
})

describe('待办 —— 从摘要解析行动项', () => {
  it('只解析「截止与行动项」小节里的 - [ ] 行', () => {
    const items = parseActionItems(summary, 2026)
    expect(items).toHaveLength(4)
    expect(items[0]).toMatchObject({ title: '完成 Lab 0 上机', dueTs: hkt(2026, 9, 16, 23, 59), done: false })
    expect(items[1]).toMatchObject({ title: '提交 Experiment 1', dueTs: hkt(2026, 9, 18, 14, 42) })
    // [x] → done
    expect(items[2]).toMatchObject({ done: true })
    // 没写截止 → dueTs=null，标题保留
    expect(items[3]).toMatchObject({ title: '读一下阅读材料', dueTs: null })
    // 「关键信息」里的列表不算任务
    expect(items.some((i) => i.title.includes('SHB'))).toBe(false)
  })

  it('兼容全角冒号、括号、due: 英文写法', () => {
    const md = ['## 行动项', '- [ ] 交作业（截止: 2026-10-01 09:00）', '- [ ] Pay fee due: 2026-10-02'].join('\n')
    const items = parseActionItems(md, 2026)
    expect(items.map((i) => i.dueTs)).toEqual([hkt(2026, 10, 1, 9, 0), hkt(2026, 10, 2, 23, 59)])
  })

  it('空摘要/没有行动项小节 → 空数组', () => {
    expect(parseActionItems('', 2026)).toEqual([])
    expect(parseActionItems('## 主旨\n随便写点', 2026)).toEqual([])
  })

  it('标题里的「—— 截止：…」被剥离，不重复出现', () => {
    const items = parseActionItems('## 截止与行动项\n- [ ] 写报告 —— 截止：2026-09-20 18:00', 2026)
    expect(items[0].title).toBe('写报告')
  })
})

describe('待办 —— 去重合并（卡片 DUE vs 摘要行动项）', () => {
  it('同邮件同标题同截止 → 只留一条，且优先摘要来源', () => {
    const merged = mergeTaskCandidates([
      { messageId: 10, title: '完成 Lab 0 上机', dueTs: hkt(2026, 9, 16, 23, 59), done: false, source: 'card' },
      { messageId: 10, title: '完成 Lab 0 上机', dueTs: hkt(2026, 9, 16, 23, 59), done: false, source: 'summary' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].source).toBe('summary')
  })

  it('标题有空白差异也算同一条', () => {
    const merged = mergeTaskCandidates([
      { messageId: 1, title: '写  报告', dueTs: 100, done: false, source: 'card' },
      { messageId: 1, title: '写 报告', dueTs: 100, done: false, source: 'summary' }
    ])
    expect(merged).toHaveLength(1)
  })

  it('截止不同 / 邮件不同 → 保留两条', () => {
    const merged = mergeTaskCandidates([
      { messageId: 1, title: 'x', dueTs: 100, done: false, source: 'card' },
      { messageId: 1, title: 'x', dueTs: 200, done: false, source: 'card' },
      { messageId: 2, title: 'x', dueTs: 100, done: false, source: 'card' }
    ])
    expect(merged).toHaveLength(3)
  })

  it('任一来源已完成 → 合并后视为完成', () => {
    const merged = mergeTaskCandidates([
      { messageId: 1, title: 'x', dueTs: 100, done: false, source: 'card' },
      { messageId: 1, title: 'x', dueTs: 100, done: true, source: 'summary' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].done).toBe(true)
  })

  it('taskKey 归一化标题', () => {
    expect(taskKey({ messageId: 1, title: '  写  报告 ', dueTs: 5 })).toBe(taskKey({ messageId: 1, title: '写 报告', dueTs: 5 }))
  })
})

describe('待办 —— 逾期与筛选', () => {
  const now = hkt(2026, 9, 16, 12, 0) // 周三中午

  it('逾期判断：有截止且已过、未完成', () => {
    expect(isOverdue({ dueTs: hkt(2026, 9, 16, 9, 0), done: false }, now)).toBe(true)
    expect(isOverdue({ dueTs: hkt(2026, 9, 16, 9, 0), done: true }, now)).toBe(false) // 完成了不算逾期
    expect(isOverdue({ dueTs: hkt(2026, 9, 17, 9, 0), done: false }, now)).toBe(false)
    expect(isOverdue({ dueTs: null, done: false }, now)).toBe(false)
  })

  it('本周起点是周一 00:00（北京时间）', () => {
    // 2026-09-16 是周三 → 本周一 = 2026-09-14
    expect(cnWeekStart(now)).toBe(hkt(2026, 9, 14, 0, 0))
  })

  it('今天 = 北京时间当天内到期（含 23:59）', () => {
    const list = [
      task({ id: 1, dueTs: hkt(2026, 9, 16, 8, 0) }),
      task({ id: 2, dueTs: hkt(2026, 9, 16, 23, 59) }),
      task({ id: 3, dueTs: hkt(2026, 9, 17, 1, 0) }),
      task({ id: 4, dueTs: null })
    ]
    expect(filterTasksByRange(list, 'today', now).map((t) => t.id)).toEqual([1, 2])
  })

  it('本周 = 周一至周日', () => {
    const list = [
      task({ id: 1, dueTs: hkt(2026, 9, 14, 0, 0) }),
      task({ id: 2, dueTs: hkt(2026, 9, 20, 23, 59) }),
      task({ id: 3, dueTs: hkt(2026, 9, 21, 0, 0) }) // 下周一
    ]
    expect(filterTasksByRange(list, 'week', now).map((t) => t.id)).toEqual([1, 2])
  })

  it('全部 = 未完成（含无截止）；已完成单独一档', () => {
    const list = [
      task({ id: 1, dueTs: hkt(2026, 9, 1, 0, 0) }),
      task({ id: 2, dueTs: null }),
      task({ id: 3, done: true })
    ]
    expect(filterTasksByRange(list, 'all', now).map((t) => t.id)).toEqual([1, 2])
    expect(filterTasksByRange(list, 'done', now).map((t) => t.id)).toEqual([3])
  })

  it('排序：未完成在前、截止升序、无截止靠后', () => {
    const list = [
      task({ id: 1, done: true, dueTs: 1 }),
      task({ id: 2, dueTs: hkt(2026, 9, 18) }),
      task({ id: 3, dueTs: hkt(2026, 9, 16) }),
      task({ id: 4, dueTs: null, createdAt: 50 })
    ]
    expect(sortTasks(list).map((t) => t.id)).toEqual([3, 2, 4, 1])
  })

  it('截止文案：今天/明天/日期', () => {
    expect(formatTaskDue(hkt(2026, 9, 16, 14, 42), now)).toBe('今天 14:42')
    expect(formatTaskDue(hkt(2026, 9, 17, 9, 0), now)).toBe('明天 09:00')
    expect(formatTaskDue(hkt(2026, 9, 20, 9, 0), now)).toBe('09-20 09:00')
    expect(formatTaskDue(null, now)).toBe('无截止')
  })
})
