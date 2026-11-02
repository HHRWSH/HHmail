/**
 * 待办增量重建（V2.3）。
 *
 * 触发时机：
 *   - 同步完成、有新邮件入库后（新卡片 → DUE 任务）；
 *   - 生成/更新摘要后（摘要里的「截止与行动项」）；
 *   - 启动时补一次（老库升级后首次打开也能看到待办）。
 *
 * 设计要点：
 *   1) **零 AI 成本**：只读已存的索引卡片与摘要 Markdown，纯函数解析（shared/tasks）。
 *   2) **不覆盖用户勾选**：重建前读出已有任务的 done 状态，按 key（邮件+标题+截止）回填。
 *   3) **手动任务不动**：source='manual' 的行不参与替换。
 *   4) 只处理传入的 messageIds（增量），避免全库重算。
 */
import type { MessageStore } from '../db/store'
import { cnParts } from '../../shared/calendar'
import { mergeTaskCandidates, parseActionItems, taskKey, type TaskCandidate } from '../../shared/tasks'

export interface TaskRebuildDeps {
  store: Pick<MessageStore, 'tasksForMessages' | 'replaceAutoTasks' | 'getIndexDocsFor' | 'getSummary'>
  /** 仅用于观测；可缺省（单测） */
  logger?: { info: (event: string, extra?: Record<string, unknown>) => void }
  /** 注入「现在」，便于单测（默认 Date.now） */
  now?: () => number
}

export interface TaskRebuildResult {
  /** 处理的邮件数 */
  messages: number
  /** 最终写入的自动任务数 */
  tasks: number
  /** 跳过的邮件（没有卡片也没有摘要） */
  skipped: number
}

/**
 * 从「索引卡片 DUE」+「摘要行动项」派生任务并替换这些邮件的自动任务。
 * 返回统计信息（便于日志与测试断言）。
 */
export async function rebuildTasksForMessages(
  deps: TaskRebuildDeps,
  messageIds: number[]
): Promise<TaskRebuildResult> {
  const ids = [...new Set(messageIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return { messages: 0, tasks: 0, skipped: 0 }

  const now = (deps.now ?? Date.now)()
  const docs = await deps.store.getIndexDocsFor(ids)
  const docById = new Map(docs.map((d) => [d.messageId, d]))
  const existing = await deps.store.tasksForMessages(ids)
  const doneByKey = new Map(existing.filter((t) => t.source !== 'manual').map((t) => [taskKey(t), t.done]))

  const candidates: TaskCandidate[] = []
  let skipped = 0
  for (const id of ids) {
    const doc = docById.get(id)
    const summary = await deps.store.getSummary(id)
    const fallbackYear = cnParts(doc?.dueTs ?? now).y
    let produced = 0
    // ① 索引卡片 DUE → 一条「截止」任务（标题用邮件主题，摘要里的行动项更具体时优先）
    if (doc && doc.dueTs && doc.dueTs > 0) {
      candidates.push({
        messageId: id,
        title: doc.subject || '（无主题）',
        dueTs: doc.dueTs,
        done: false,
        source: 'card'
      })
      produced += 1
    }
    // ② 摘要「截止与行动项」
    if (summary?.text) {
      for (const item of parseActionItems(summary.text, fallbackYear)) {
        candidates.push({ messageId: id, title: item.title, dueTs: item.dueTs, done: item.done, source: 'summary' })
        produced += 1
      }
    }
    if (produced === 0) skipped += 1
  }

  // 去重（同邮件+同标题+同截止，摘要优先），再把用户勾选过的 done 状态回填
  const merged = mergeTaskCandidates(candidates).map((c) => {
    const key = taskKey(c)
    const wasDone = doneByKey.get(key)
    return wasDone === undefined ? c : { ...c, done: c.done || wasDone }
  })

  await deps.store.replaceAutoTasks(ids, merged)
  deps.logger?.info('tasks.rebuilt', { messages: ids.length, tasks: merged.length, skipped })
  return { messages: ids.length, tasks: merged.length, skipped }
}
