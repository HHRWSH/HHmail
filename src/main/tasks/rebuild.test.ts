import { describe, expect, it } from 'vitest'
import { rebuildTasksForMessages, type TaskRebuildDeps } from './rebuild'
import type { TaskItem } from '../../shared/tasks'

const hkt = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

/** 可注入的假 store：只实现重建需要的四个方法 */
function makeDeps(opts: {
  docs?: Array<{ messageId: number; card: string; dueTs: number | null; subject: string }>
  summaries?: Map<number, string>
  existing?: TaskItem[]
}) {
  const calls: { replaced: Array<{ ids: number[]; tasks: unknown[] }> } = { replaced: [] }
  const deps: TaskRebuildDeps = {
    store: {
      getIndexDocsFor: async (ids: number[]) => (opts.docs ?? []).filter((d) => ids.includes(d.messageId)),
      getSummary: async (id: number) => {
        const text = opts.summaries?.get(id)
        return text ? { text, model: 'test', createdAtMs: 0 } : null
      },
      tasksForMessages: async (ids: number[]) =>
        (opts.existing ?? []).filter((t) => t.messageId !== null && ids.includes(t.messageId)),
      replaceAutoTasks: async (ids: number[], tasks: unknown[]) => {
        calls.replaced.push({ ids, tasks })
      }
    } as unknown as TaskRebuildDeps['store'],
    now: () => hkt(2026, 9, 16, 12, 0)
  }
  return { deps, calls }
}

describe('待办重建 —— 卡片 DUE + 摘要行动项', () => {
  it('卡片有 DUE → 一条截止任务，标题用邮件主题', async () => {
    const { deps, calls } = makeDeps({
      docs: [{ messageId: 5, card: '[TYPE] 作业 | [DUE] 2026-09-16 23:59', dueTs: hkt(2026, 9, 16, 23, 59), subject: 'Lab 0 提交' }]
    })
    const res = await rebuildTasksForMessages(deps, [5])
    expect(res).toEqual({ messages: 1, tasks: 1, skipped: 0 })
    expect(calls.replaced[0].tasks[0]).toMatchObject({ messageId: 5, source: 'card', title: 'Lab 0 提交', dueTs: hkt(2026, 9, 16, 23, 59) })
  })

  it('摘要行动项 → 每条一个任务（含截止解析）', async () => {
    const { deps, calls } = makeDeps({
      docs: [],
      summaries: new Map([[7, '## 截止与行动项\n- [ ] 写报告 —— 截止：2026-09-18 14:00\n- [ ] 读材料']])
    })
    const res = await rebuildTasksForMessages(deps, [7])
    expect(res.tasks).toBe(2)
    const tasks = calls.replaced[0].tasks as Array<{ title: string; dueTs: number | null; source: string }>
    expect(tasks[0]).toMatchObject({ title: '写报告', dueTs: hkt(2026, 9, 18, 14, 0), source: 'summary' })
    expect(tasks[1]).toMatchObject({ title: '读材料', dueTs: null })
  })

  it('卡片与摘要重复（同标题同截止）→ 去重后只剩一条（摘要来源）', async () => {
    const { deps, calls } = makeDeps({
      docs: [{ messageId: 9, card: '', dueTs: hkt(2026, 9, 20, 23, 59), subject: '交作业' }],
      summaries: new Map([[9, '## 截止与行动项\n- [ ] 交作业 —— 截止：2026-09-20 23:59']])
    })
    const res = await rebuildTasksForMessages(deps, [9])
    expect(res.tasks).toBe(1)
    expect((calls.replaced[0].tasks as Array<{ source: string }>)[0].source).toBe('summary')
  })

  it('已有任务被勾选 → 重建后保留 done 状态', async () => {
    const due = hkt(2026, 9, 18, 14, 0)
    const { deps, calls } = makeDeps({
      docs: [],
      summaries: new Map([[7, '## 截止与行动项\n- [ ] 写报告 —— 截止：2026-09-18 14:00']]),
      existing: [
        {
          id: 1,
          messageId: 7,
          title: '写报告',
          dueTs: due,
          source: 'summary',
          done: true,
          createdAt: 0,
          updatedAt: 0
        }
      ]
    })
    await rebuildTasksForMessages(deps, [7])
    expect((calls.replaced[0].tasks as Array<{ done: boolean }>)[0].done).toBe(true)
  })

  it('没有卡片也没有摘要 → skipped 计数，不写任务', async () => {
    const { deps, calls } = makeDeps({ docs: [], summaries: new Map() })
    const res = await rebuildTasksForMessages(deps, [1, 2])
    expect(res).toEqual({ messages: 2, tasks: 0, skipped: 2 })
    expect(calls.replaced[0].tasks).toEqual([])
  })

  it('过滤非法 id / 去重 id；空输入不触发写入', async () => {
    const { deps, calls } = makeDeps({ docs: [] })
    expect(await rebuildTasksForMessages(deps, [0, -1, Number.NaN])).toEqual({ messages: 0, tasks: 0, skipped: 0 })
    expect(calls.replaced).toHaveLength(0)
    await rebuildTasksForMessages(deps, [3, 3])
    expect(calls.replaced[0].ids).toEqual([3])
  })
})
