import { describe, expect, it } from 'vitest'
import {
  appendChecklistItem,
  checklistProgress,
  cnWeekStart,
  filterTasksByRange,
  formatTaskDue,
  isOverdue,
  localInputToTs,
  normalizeChecklist,
  parseActionItems,
  parseDueText,
  removeChecklistItem,
  sortTasks,
  taskPreview,
  taskSearchText,
  toggleChecklistItem,
  tsToLocalInput,
  updateChecklistItem,
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
  '- [x] 已经交过的报告 —— 截止：2026-09-10 23:59',
  '- [ ] 读一下阅读材料',
  '',
  '## 关键信息',
  '- 地点 SHB 123' // 不在行动项小节，不应被解析
].join('\n')

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: 1,
  title: 't',
  body: '',
  dueTs: null,
  done: false,
  checklist: [],
  links: [],
  createdAt: 0,
  updatedAt: 0,
  ...over
})

describe('待办（备忘录式）—— 截止时间解析', () => {
  it('YYYY-MM-DD HH:mm / 只有日期 / 无年份 / 中文写法', () => {
    expect(parseDueText('2026-09-16 14:42', 2026)).toBe(hkt(2026, 9, 16, 14, 42))
    expect(parseDueText('2026-09-16', 2026)).toBe(hkt(2026, 9, 16, 23, 59))
    expect(parseDueText('09-16 14:42', 2027)).toBe(hkt(2027, 9, 16, 14, 42))
    expect(parseDueText('2026年9月16日 14:42', 2026)).toBe(hkt(2026, 9, 16, 14, 42))
    expect(parseDueText('下周找个时间', 2026)).toBeNull()
    expect(parseDueText('', 2026)).toBeNull()
  })

  it('本地输入框 ↔ 时间戳互转', () => {
    const ts = localInputToTs('2026-09-16T14:42')
    expect(ts).not.toBeNull()
    expect(tsToLocalInput(ts)).toBe('2026-09-16T14:42')
    expect(tsToLocalInput(null)).toBe('')
    expect(localInputToTs('')).toBeNull()
  })

  it('截止文案：今天/明天/日期/无截止', () => {
    const now = hkt(2026, 9, 16, 12, 0)
    expect(formatTaskDue(hkt(2026, 9, 16, 14, 42), now)).toBe('今天 14:42')
    expect(formatTaskDue(hkt(2026, 9, 17, 9, 0), now)).toBe('明天 09:00')
    expect(formatTaskDue(hkt(2026, 9, 20, 9, 0), now)).toBe('09-20 09:00')
    expect(formatTaskDue(null, now)).toBe('无截止')
  })
})

describe('待办 —— 从摘要行动项解析（供「→ 待办」入口）', () => {
  it('只解析「截止与行动项」小节里的 - [ ] 行', () => {
    const items = parseActionItems(summary, 2026)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ title: '完成 Lab 0 上机', dueTs: hkt(2026, 9, 16, 23, 59), done: false })
    expect(items[1]).toMatchObject({ done: true })
    expect(items[2]).toMatchObject({ title: '读一下阅读材料', dueTs: null })
    expect(items.some((i) => i.title.includes('SHB'))).toBe(false)
  })

  it('兼容全角冒号 / 括号 / due:', () => {
    const md = ['## 行动项', '- [ ] 交作业（截止: 2026-10-01 09:00）', '- [ ] Pay fee due: 2026-10-02'].join('\n')
    expect(parseActionItems(md, 2026).map((i) => i.dueTs)).toEqual([hkt(2026, 10, 1, 9, 0), hkt(2026, 10, 2, 23, 59)])
  })

  it('空/无小节 → 空数组；标题剥离时间片段', () => {
    expect(parseActionItems('', 2026)).toEqual([])
    expect(parseActionItems('## 主旨\n随便写点', 2026)).toEqual([])
    expect(parseActionItems('## 截止与行动项\n- [ ] 写报告 —— 截止：2026-09-20 18:00', 2026)[0].title).toBe('写报告')
  })
})

describe('待办 —— 逾期与筛选', () => {
  const now = hkt(2026, 9, 16, 12, 0) // 周三中午

  it('逾期判断', () => {
    expect(isOverdue({ dueTs: hkt(2026, 9, 16, 9, 0), done: false }, now)).toBe(true)
    expect(isOverdue({ dueTs: hkt(2026, 9, 16, 9, 0), done: true }, now)).toBe(false)
    expect(isOverdue({ dueTs: hkt(2026, 9, 17, 9, 0), done: false }, now)).toBe(false)
    expect(isOverdue({ dueTs: null, done: false }, now)).toBe(false)
  })

  it('本周起点是周一 00:00（北京时间）', () => {
    expect(cnWeekStart(now)).toBe(hkt(2026, 9, 14, 0, 0))
  })

  it('今天 / 本周 / 全部 / 已完成', () => {
    const list = [
      task({ id: 1, dueTs: hkt(2026, 9, 16, 8, 0) }),
      task({ id: 2, dueTs: hkt(2026, 9, 16, 23, 59) }),
      task({ id: 3, dueTs: hkt(2026, 9, 17, 1, 0) }),
      task({ id: 4, dueTs: null }),
      task({ id: 5, done: true })
    ]
    expect(filterTasksByRange(list, 'today', now).map((t) => t.id)).toEqual([1, 2])
    expect(filterTasksByRange(list, 'all', now).map((t) => t.id)).toEqual([1, 2, 3, 4])
    expect(filterTasksByRange(list, 'done', now).map((t) => t.id)).toEqual([5])
    const week = [
      task({ id: 1, dueTs: hkt(2026, 9, 14, 0, 0) }),
      task({ id: 2, dueTs: hkt(2026, 9, 20, 23, 59) }),
      task({ id: 3, dueTs: hkt(2026, 9, 21, 0, 0) })
    ]
    expect(filterTasksByRange(week, 'week', now).map((t) => t.id)).toEqual([1, 2])
  })

  it('排序：未完成在前、截止升序、无截止按更新时间倒序', () => {
    const list = [
      task({ id: 1, done: true, dueTs: 1 }),
      task({ id: 2, dueTs: hkt(2026, 9, 18) }),
      task({ id: 3, dueTs: hkt(2026, 9, 16) }),
      task({ id: 4, dueTs: null, updatedAt: 50 })
    ]
    expect(sortTasks(list).map((t) => t.id)).toEqual([3, 2, 4, 1])
  })
})

describe('待办 —— 清单子项', () => {
  it('normalizeChecklist：去空、去重 id、截断超长、最多 100 条', () => {
    expect(normalizeChecklist([{ text: '  ' }, { text: 'a' }])).toEqual([{ id: expect.any(String), text: 'a', done: false }])
    const dup = normalizeChecklist([{ id: 'x', text: 'a' }, { id: 'x', text: 'b' }])
    expect(dup).toHaveLength(2)
    expect(dup[1].id).not.toBe('x')
    expect(normalizeChecklist([{ text: 'x'.repeat(500) }])[0].text.length).toBe(200)
    const many = Array.from({ length: 150 }, (_, i) => ({ text: `t${i}` }))
    expect(normalizeChecklist(many)).toHaveLength(100)
  })

  it('追加 / 勾选 / 改文字 / 删除', () => {
    let list = appendChecklistItem([], '写报告')
    expect(list).toHaveLength(1)
    expect(appendChecklistItem(list, '   ')).toHaveLength(1)
    const id = list[0].id
    list = toggleChecklistItem(list, id)
    expect(list[0].done).toBe(true)
    list = updateChecklistItem(list, id, '写报告 v2')
    expect(list[0].text).toBe('写报告 v2')
    expect(updateChecklistItem(list, id, '')).toHaveLength(0) // 改成空 = 删除
    list = appendChecklistItem([], 'a')
    expect(removeChecklistItem(list, list[0].id)).toHaveLength(0)
  })

  it('完成度与列表摘要', () => {
    const list = [
      { id: 'a', text: 'a', done: true },
      { id: 'b', text: 'b', done: false }
    ]
    expect(checklistProgress(list)).toEqual({ done: 1, total: 2 })
    expect(taskPreview({ body: '正文第一行\n第二行', checklist: list })).toBe('正文第一行')
    expect(taskPreview({ body: '', checklist: list })).toBe('a')
    expect(taskPreview({ body: '  ', checklist: [] })).toBe('')
  })

  it('搜索文本包含标题/正文/清单/引用标签', () => {
    const t = task({
      title: '作业',
      body: '实验报告',
      checklist: [{ id: 'a', text: '画图', done: false }],
      links: [{ id: 1, taskId: 1, kind: 'mail', refId: '5', label: 'Experiment 1 说明', sub: '林教授' }]
    })
    const text = taskSearchText(t)
    expect(text).toContain('作业')
    expect(text).toContain('实验报告')
    expect(text).toContain('画图')
    expect(text).toContain('experiment 1 说明')
  })
})
