/**
 * 待办页（V2.3）：把邮件里的截止/行动项变成可勾选的任务。
 *
 * 数据全部由主进程提供（`api.listTasks` 等）：卡片 DUE 与摘要行动项在**主进程**派生，
 * 渲染层只做展示、过滤、勾选与手动增删改 —— 避免两处解析逻辑漂移。
 * 时间分桶/逾期判断用 shared/tasks 的纯函数（按北京时间，跨时区稳定）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PageProps } from '../registry'
import { api } from '../bridge'
import { errorMessage } from '../lib/errors'
import {
  filterTasksByRange,
  formatTaskDue,
  isOverdue,
  sortTasks,
  type TaskItem,
  type TaskRange
} from '@shared/tasks'

const RANGES: Array<{ id: TaskRange; label: string }> = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本周' },
  { id: 'all', label: '全部' },
  { id: 'done', label: '已完成' }
]

/** datetime-local 输入值（本地时区）→ 毫秒时间戳；空串 = null */
export function localInputToTs(value: string): number | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  return Number.isFinite(ts) ? ts : null
}

/** 毫秒时间戳 → datetime-local 的 value（本地时区，分钟精度） */
export function tsToLocalInput(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function TasksPage({ onOpenMail, onToast, isActive = true }: PageProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [range, setRange] = useState<TaskRange>('all')
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDue, setEditDue] = useState('')
  const now = Date.now()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = (await api.listTasks()) as TaskItem[]
      setTasks(Array.isArray(list) ? list : [])
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [onToast])

  useEffect(() => {
    if (isActive === false) return
    void load()
  }, [load, isActive])

  const visible = useMemo(() => sortTasks(filterTasksByRange(tasks, range, now)), [tasks, range, now])
  const openCount = useMemo(() => tasks.filter((t) => !t.done).length, [tasks])
  const overdueCount = useMemo(() => tasks.filter((t) => isOverdue(t, now)).length, [tasks, now])
  const doneCount = useMemo(() => tasks.filter((t) => t.done).length, [tasks])

  const toggleDone = async (t: TaskItem): Promise<void> => {
    setBusyId(t.id)
    try {
      const updated = (await api.updateTask({ id: t.id, done: !t.done })) as TaskItem
      setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...updated } : x)))
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setBusyId(null)
    }
  }

  const removeTask = async (t: TaskItem): Promise<void> => {
    if (!window.confirm(`删除待办「${t.title}」？`)) return
    setBusyId(t.id)
    try {
      await api.deleteTask(t.id)
      setTasks((prev) => prev.filter((x) => x.id !== t.id))
      onToast('已删除')
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setBusyId(null)
    }
  }

  const startEdit = (t: TaskItem): void => {
    setEditingId(t.id)
    setEditTitle(t.title)
    setEditDue(tsToLocalInput(t.dueTs))
  }

  const saveEdit = async (): Promise<void> => {
    if (editingId === null) return
    const title = editTitle.trim()
    if (!title) {
      onToast('标题不能为空')
      return
    }
    setBusyId(editingId)
    try {
      const updated = (await api.updateTask({
        id: editingId,
        title,
        dueTs: localInputToTs(editDue)
      })) as TaskItem
      setTasks((prev) => prev.map((x) => (x.id === editingId ? { ...x, ...updated } : x)))
      setEditingId(null)
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setBusyId(null)
    }
  }

  const addTask = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) return
    try {
      const created = (await api.createTask({ title, dueTs: localInputToTs(newDue) })) as TaskItem
      setTasks((prev) => [...prev, created])
      setNewTitle('')
      setNewDue('')
      onToast('已添加待办')
    } catch (e) {
      onToast(errorMessage(e))
    }
  }

  return (
    <div className="tasks-wrap" data-testid="tasks-page">
      <div className="tasks-head">
        <div className="tasks-title">
          ✅ 待办
          <span className="sub" data-testid="tasks-summary">
            {loading ? '读取中…' : `${openCount} 件未完成${overdueCount > 0 ? ` · ${overdueCount} 件已逾期` : ''}${doneCount > 0 ? ` · ${doneCount} 件已完成` : ''}`}
          </span>
        </div>
        <div className="tasks-filters" data-testid="tasks-filters">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`chip-btn ${range === r.id ? 'on' : ''}`}
              onClick={() => setRange(r.id)}
              data-testid={`task-filter-${r.id}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tasks-add">
        <input
          className="input"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addTask()
          }}
          placeholder="手动加一条待办…"
          maxLength={300}
          data-testid="task-add-input"
        />
        <input
          className="input"
          type="datetime-local"
          value={newDue}
          onChange={(e) => setNewDue(e.target.value)}
          title="截止时间（可留空）"
          data-testid="task-add-due"
        />
        <button className="btn primary" onClick={() => void addTask()} disabled={!newTitle.trim()} data-testid="task-add">
          ＋ 添加
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="tasks-empty" data-testid="tasks-empty">
          {range === 'done' ? '还没有已完成的任务。' : '这个范围内没有待办 —— 邮件里解析到截止/行动项后会自动出现。'}
        </div>
      ) : (
        <ul className="tasks-list" data-testid="tasks-list">
          {visible.map((t) => {
            const overdue = isOverdue(t, now)
            const editing = editingId === t.id
            return (
              <li
                key={t.id}
                className={`task-item ${t.done ? 'done' : ''} ${overdue ? 'overdue' : ''}`}
                data-testid="task-item"
                data-done={t.done ? '1' : '0'}
                data-overdue={overdue ? '1' : '0'}
              >
                <input
                  type="checkbox"
                  className="task-check"
                  checked={t.done}
                  onChange={() => void toggleDone(t)}
                  disabled={busyId === t.id}
                  data-testid="task-check"
                  title={t.done ? '标记为未完成' : '标记为完成'}
                />
                {editing ? (
                  <div className="task-edit">
                    <input
                      className="input"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      maxLength={300}
                      data-testid="task-edit-title"
                    />
                    <input
                      className="input"
                      type="datetime-local"
                      value={editDue}
                      onChange={(e) => setEditDue(e.target.value)}
                      data-testid="task-edit-due"
                    />
                    <button className="btn primary sm" onClick={() => void saveEdit()} data-testid="task-edit-save">
                      保存
                    </button>
                    <button className="btn ghost sm" onClick={() => setEditingId(null)} data-testid="task-edit-cancel">
                      取消
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="task-title"
                      onClick={() => {
                        if (t.messageId && onOpenMail) onOpenMail(t.messageId)
                      }}
                      title={t.messageId ? '打开原邮件' : '手动任务'}
                      data-testid="task-title"
                    >
                      {t.title}
                    </button>
                    <span className={`task-due ${overdue ? 'overdue' : ''}`} data-testid="task-due">
                      {formatTaskDue(t.dueTs, now)}
                    </span>
                    <span className={`task-source ${t.source}`} data-testid="task-source">
                      {t.source === 'card' ? '卡片' : t.source === 'summary' ? '摘要' : '手动'}
                    </span>
                  </>
                )}
                <span className="task-actions">
                  <button className="link-btn" onClick={() => startEdit(t)} disabled={busyId === t.id} data-testid="task-edit">
                    编辑
                  </button>
                  <button className="link-btn" onClick={() => void removeTask(t)} disabled={busyId === t.id} data-testid="task-delete">
                    删除
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
