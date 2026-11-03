/**
 * 待办页（V2.4 备忘录式）—— 左列表 + 右「备忘录卡片」。
 *
 * 交互（用户确认的方案）：
 *   - 全部手动：新建、编辑（自动保存）、勾选完成、删除；
 *   - 引用：可挂邮件（搜索选择 / 从邮件详情「加入待办」）+ 自定义时间；
 *   - 不再自动从卡片 DUE / 摘要行动项生成（那些入口都是显式按钮）。
 *
 * 数据都在主进程（`api.*Tasks*`），渲染层只做展示与编辑；时间分桶用 shared/tasks 纯函数（北京时间）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PageProps } from '../registry'
import { api } from '../bridge'
import { errorMessage } from '../lib/errors'
import type { MailListItem } from '@shared/types'
import {
  appendChecklistItem,
  checklistProgress,
  filterTasksByRange,
  formatTaskDue,
  isOverdue,
  localInputToTs,
  removeChecklistItem,
  sortTasks,
  taskPreview,
  toggleChecklistItem,
  tsToLocalInput,
  updateChecklistItem,
  type TaskChecklistItem,
  type TaskItem,
  type TaskRange
} from '@shared/tasks'

const RANGES: Array<{ id: TaskRange; label: string }> = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本周' },
  { id: 'all', label: '全部' },
  { id: 'done', label: '已完成' }
]

/** 把空标题兜底成「未命名待办」（与主进程一致） */
const safeTitle = (raw: string): string => String(raw ?? '').trim() || '未命名待办'

export function TasksPage({ onToast, onOpenMail, isActive = true }: PageProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [range, setRange] = useState<TaskRange>('all')
  const [keyword, setKeyword] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // 编辑中的草稿（与选中任务同步）
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [due, setDue] = useState('')
  const [checklist, setChecklist] = useState<TaskChecklistItem[]>([])
  const [newItem, setNewItem] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerTerm, setPickerTerm] = useState('')
  const [pickerHits, setPickerHits] = useState<MailListItem[]>([])
  const [timeInput, setTimeInput] = useState('')

  const now = Date.now()
  const saveTimer = useRef<number | null>(null)
  const draftRef = useRef({ id: 0, title: '', body: '', dueTs: null as number | null, checklist: [] as TaskChecklistItem[] })

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

  const visible = useMemo(() => {
    const filtered = filterTasksByRange(tasks, range, now)
    const k = keyword.trim().toLowerCase()
    if (!k) return sortTasks(filtered)
    return sortTasks(
      filtered.filter((t) =>
        [t.title, t.body, ...t.checklist.map((c) => c.text), ...t.links.map((l) => `${l.label ?? ''} ${l.sub ?? ''}`)]
          .join(' ')
          .toLowerCase()
          .includes(k)
      )
    )
  }, [tasks, range, keyword, now])

  const selected = useMemo(() => tasks.find((t) => t.id === selectedId) ?? null, [tasks, selectedId])

  /** 选中变化 → 同步草稿 */
  useEffect(() => {
    if (!selected) return
    setTitle(selected.title)
    setBody(selected.body)
    setDue(tsToLocalInput(selected.dueTs))
    setChecklist(selected.checklist.map((c) => ({ ...c })))
    draftRef.current = { id: selected.id, title: selected.title, body: selected.body, dueTs: selected.dueTs, checklist: selected.checklist }
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 800ms 防抖自动保存（标题/正文/截止/清单） */
  const scheduleSave = useCallback(
    (patch: { title?: string; body?: string; dueTs?: number | null; checklist?: TaskChecklistItem[] }) => {
      const id = draftRef.current.id
      if (!id) return
      draftRef.current = { ...draftRef.current, ...patch }
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        const d = draftRef.current
        setSaving(true)
        void api
          .updateTask({ id: d.id, title: d.title, body: d.body, dueTs: d.dueTs, checklist: d.checklist })
          .then((updated) => {
            const t = updated as TaskItem
            setTasks((prev) => prev.map((x) => (x.id === t.id ? t : x)))
          })
          .catch((e) => onToast(errorMessage(e)))
          .finally(() => setSaving(false))
      }, 800)
    },
    [onToast]
  )

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [])

  const createTask = async (): Promise<void> => {
    try {
      const created = (await api.createTask({ title: '' })) as TaskItem
      setTasks((prev) => [created, ...prev])
      setSelectedId(created.id)
    } catch (e) {
      onToast(errorMessage(e))
    }
  }

  const removeTask = async (): Promise<void> => {
    if (!selected) return
    if (!window.confirm(`删除待办「${selected.title}」？`)) return
    try {
      await api.deleteTask(selected.id)
      setTasks((prev) => prev.filter((x) => x.id !== selected.id))
      setSelectedId(null)
      onToast('已删除')
    } catch (e) {
      onToast(errorMessage(e))
    }
  }

  const toggleDone = async (t: TaskItem): Promise<void> => {
    try {
      const updated = (await api.updateTask({ id: t.id, done: !t.done })) as TaskItem
      setTasks((prev) => prev.map((x) => (x.id === t.id ? updated : x)))
    } catch (e) {
      onToast(errorMessage(e))
    }
  }

  /** 加邮件引用：打开选择器（搜索最近邮件） */
  const openPicker = async (): Promise<void> => {
    setPickerOpen(true)
    setPickerTerm('')
    try {
      const hits = (await api.searchMail('')) as MailListItem[]
      setPickerHits(Array.isArray(hits) ? hits.slice(0, 20) : [])
    } catch {
      setPickerHits([])
    }
  }

  const searchMails = async (term: string): Promise<void> => {
    setPickerTerm(term)
    try {
      const hits = (await api.searchMail(term)) as MailListItem[]
      setPickerHits(Array.isArray(hits) ? hits.slice(0, 20) : [])
    } catch {
      setPickerHits([])
    }
  }

  const addMailLink = async (mailId: number): Promise<void> => {
    if (!selected) return
    try {
      const updated = (await api.addTaskLink({ taskId: selected.id, kind: 'mail', refId: String(mailId) })) as TaskItem
      setTasks((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
      setPickerOpen(false)
      onToast('已引用这封邮件')
    } catch (e) {
      onToast(errorMessage(e))
    }
  }

  const addTimeLink = async (): Promise<void> => {
    if (!selected) return
    const ts = localInputToTs(timeInput)
    if (!ts) {
      onToast('请选择要引用的时间')
      return
    }
    try {
      const updated = (await api.addTaskLink({
        taskId: selected.id,
        kind: 'datetime',
        refId: String(ts),
        label: formatTaskDue(ts, Date.now())
      })) as TaskItem
      setTasks((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
      setTimeInput('')
      onToast('已引用这个时间')
    } catch (e) {
      onToast(errorMessage(e))
    }
  }

  const removeLink = async (linkId: number): Promise<void> => {
    if (!selected) return
    try {
      const updated = (await api.removeTaskLink({ taskId: selected.id, linkId })) as TaskItem
      setTasks((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
    } catch (e) {
      onToast(errorMessage(e))
    }
  }

  const counts = useMemo(() => {
    const open = tasks.filter((t) => !t.done).length
    const overdue = tasks.filter((t) => isOverdue(t, now)).length
    const done = tasks.length - open
    return { open, overdue, done }
  }, [tasks, now])

  return (
    <div className="tasks2-wrap" data-testid="tasks-page">
      <header className="tasks2-head">
        <h1>待办</h1>
        <span className="sub" data-testid="tasks-summary">
          {loading ? '读取中…' : `${counts.open} 件未完成${counts.overdue > 0 ? ` · ${counts.overdue} 件已逾期` : ''}${counts.done > 0 ? ` · ${counts.done} 件已完成` : ''}`}
        </span>
        <div className="tasks2-head-actions">
          <div className="seg" data-testid="tasks-filters">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={range === r.id ? 'on' : ''}
                onClick={() => setRange(r.id)}
                data-testid={`task-filter-${r.id}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={() => void createTask()} data-testid="task-add">
            ＋ 新建待办
          </button>
        </div>
      </header>

      <div className="tasks2-split">
        <section className="tasks2-list" data-testid="tasks-list-pane">
          <div className="tasks2-search">
            <input
              className="input"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索待办、邮件、时间…"
              data-testid="task-search"
            />
          </div>
          <div className="tasks2-rows">
            {visible.length === 0 ? (
              <div className="tasks2-empty" data-testid="tasks-empty">
                <div className="empty-icon">📝</div>
                <div className="empty-title">{keyword || range !== 'all' ? '这个范围没有待办' : '还没有待办'}</div>
                <div className="empty-hint">
                  {keyword || range !== 'all'
                    ? '换个筛选条件试试'
                    : '点右上角「＋ 新建待办」，或在邮件详情里点「加入待办」'}
                </div>
              </div>
            ) : (
              visible.map((t) => {
                const overdue = isOverdue(t, now)
                const progress = checklistProgress(t.checklist)
                const preview = taskPreview(t)
                return (
                  <div
                    key={t.id}
                    className={`tasks2-row ${t.id === selectedId ? 'selected' : ''} ${t.done ? 'done' : ''}`}
                    onClick={() => setSelectedId(t.id)}
                    data-testid="task-item"
                    data-done={t.done ? '1' : '0'}
                    data-overdue={overdue ? '1' : '0'}
                  >
                    <button
                      className={`tasks2-check ${t.done ? 'on' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        void toggleDone(t)
                      }}
                      title={t.done ? '标记为未完成' : '标记为完成'}
                      data-testid="task-check"
                    >
                      {t.done ? '✓' : ''}
                    </button>
                    <div className="tasks2-row-main">
                      <div className="tasks2-row-title" data-testid="task-title">
                        {t.title}
                      </div>
                      {preview ? <div className="tasks2-row-preview">{preview}</div> : null}
                      <div className="tasks2-row-meta">
                        <span className={`badge ${overdue ? 'overdue' : t.dueTs ? 'due' : ''}`} data-testid="task-due">
                          {formatTaskDue(t.dueTs, now)}
                        </span>
                        {progress.total > 0 && (
                          <span className="badge">
                            清单 {progress.done}/{progress.total}
                          </span>
                        )}
                        {t.links.filter((l) => l.kind === 'mail').length > 0 && (
                          <span className="badge">📧 {t.links.filter((l) => l.kind === 'mail').length}</span>
                        )}
                        {t.links.filter((l) => l.kind === 'datetime').length > 0 && (
                          <span className="badge">🕒 {t.links.filter((l) => l.kind === 'datetime').length}</span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="tasks2-detail" data-testid="task-detail">
          {!selected ? (
            <div className="tasks2-empty detail-empty">
              <div className="empty-icon">🗂</div>
              <div className="empty-title">选一张待办，或新建一个</div>
              <div className="empty-hint">左边点任意待办开始编辑；写标题、正文、清单，还能引用邮件和时间</div>
            </div>
          ) : (
            <div className="memo" data-testid="task-memo">
              <div className="memo-top">
                <span className="memo-tag" data-testid="task-saved">
                  {saving ? '保存中…' : selected.done ? '已完成' : '待办'} · {formatTaskDue(selected.dueTs, now)}
                </span>
                <div className="memo-acts">
                  <button
                    className="icon-btn"
                    title={selected.done ? '标记为未完成' : '标记为完成'}
                    onClick={() => void toggleDone(selected)}
                    data-testid="task-toggle-done"
                  >
                    {selected.done ? '↺' : '✓'}
                  </button>
                  <button className="icon-btn danger" title="删除待办" onClick={() => void removeTask()} data-testid="task-delete">
                    🗑
                  </button>
                </div>
              </div>

              <input
                className="memo-title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value)
                  scheduleSave({ title: safeTitle(e.target.value) })
                }}
                placeholder="未命名待办"
                maxLength={200}
                data-testid="task-title-input"
              />

              <textarea
                className="memo-body"
                value={body}
                onChange={(e) => {
                  setBody(e.target.value)
                  scheduleSave({ body: e.target.value })
                }}
                placeholder="写点什么…（自动保存）"
                rows={4}
                data-testid="task-body"
              />

              <div className="memo-divider" />

              <div className="memo-section">
                <div className="memo-section-label">清单</div>
                <div className="memo-checklist" data-testid="task-checklist">
                  {checklist.map((item) => (
                    <div key={item.id} className={`memo-check-item ${item.done ? 'done' : ''}`} data-testid="task-check-item">
                      <button
                        className={`memo-box ${item.done ? 'on' : ''}`}
                        onClick={() => {
                          const next = toggleChecklistItem(checklist, item.id)
                          setChecklist(next)
                          scheduleSave({ checklist: next })
                        }}
                        data-testid="task-check-item-toggle"
                      >
                        {item.done ? '✓' : ''}
                      </button>
                      <input
                        className="memo-check-text"
                        value={item.text}
                        onChange={(e) => {
                          const next = updateChecklistItem(checklist, item.id, e.target.value)
                          setChecklist(next)
                          scheduleSave({ checklist: next })
                        }}
                        onBlur={() => {
                          // 改空 = 删除该条
                          if (!item.text.trim()) {
                            const next = removeChecklistItem(checklist, item.id)
                            setChecklist(next)
                            scheduleSave({ checklist: next })
                          }
                        }}
                        maxLength={200}
                      />
                      <button
                        className="memo-check-del"
                        onClick={() => {
                          const next = removeChecklistItem(checklist, item.id)
                          setChecklist(next)
                          scheduleSave({ checklist: next })
                        }}
                        title="删除这一条"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <div className="memo-check-add">
                    <input
                      className="input"
                      value={newItem}
                      onChange={(e) => setNewItem(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        const next = appendChecklistItem(checklist, newItem)
                        if (next !== checklist) {
                          setChecklist(next)
                          scheduleSave({ checklist: next })
                          setNewItem('')
                        }
                      }}
                      placeholder="＋ 加一条清单（回车添加）"
                      maxLength={200}
                      data-testid="task-checklist-add"
                    />
                  </div>
                </div>
              </div>

              <div className="memo-divider" />

              <div className="memo-section">
                <div className="memo-section-label">引用</div>
                <div className="memo-links" data-testid="task-links">
                  {selected.links.map((link) => (
                    <div key={link.id} className={`link-chip ${link.kind === 'datetime' ? 'cal' : ''}`} data-testid="task-link">
                      <div className="kind">{link.kind === 'mail' ? '📧' : '🕒'}</div>
                      <div className="li">
                        <div className="t">{link.label ?? (link.kind === 'mail' ? '邮件' : '自定义时间')}</div>
                        <div className="s">{link.sub ?? (link.kind === 'datetime' ? '手动添加的时间' : '')}</div>
                      </div>
                      {link.kind === 'mail' && onOpenMail ? (
                        <button className="open" onClick={() => onOpenMail(Number(link.refId))} data-testid="task-link-open">
                          打开 ›
                        </button>
                      ) : null}
                      <button className="memo-check-del" onClick={() => void removeLink(link.id)} title="移除引用">
                        ×
                      </button>
                    </div>
                  ))}
                  <div className="memo-add-links">
                    <button className="add-link" onClick={() => void openPicker()} data-testid="task-add-mail">
                      ＋ 引用邮件
                    </button>
                    <div className="memo-time-add">
                      <input
                        className="input"
                        type="datetime-local"
                        value={timeInput}
                        onChange={(e) => setTimeInput(e.target.value)}
                        data-testid="task-add-time-input"
                      />
                      <button className="add-link" onClick={() => void addTimeLink()} data-testid="task-add-time">
                        ＋ 引用时间
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="memo-divider" />

              <div className="memo-foot">
                <label className="memo-due">
                  ⏰
                  <input
                    className="input"
                    type="datetime-local"
                    value={due}
                    onChange={(e) => {
                      setDue(e.target.value)
                      scheduleSave({ dueTs: localInputToTs(e.target.value) })
                    }}
                    data-testid="task-due-input"
                  />
                </label>
                <span className="spacer" />
                {selected.done ? (
                  <button className="btn ghost" onClick={() => void toggleDone(selected)} data-testid="task-set-open">
                    标记为未完成
                  </button>
                ) : (
                  <button className="btn primary" onClick={() => void toggleDone(selected)} data-testid="task-set-done">
                    设为完成
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      {pickerOpen && (
        <div className="memo-picker-mask" onClick={() => setPickerOpen(false)} data-testid="task-mail-picker">
          <div className="memo-picker" onClick={(e) => e.stopPropagation()}>
            <div className="memo-picker-head">
              <span>选择要引用的邮件</span>
              <button className="icon-btn" onClick={() => setPickerOpen(false)}>
                ×
              </button>
            </div>
            <input
              className="input"
              value={pickerTerm}
              onChange={(e) => void searchMails(e.target.value)}
              placeholder="搜索主题 / 发件人…"
              data-testid="task-mail-picker-search"
              autoFocus
            />
            <div className="memo-picker-list">
              {pickerHits.length === 0 ? (
                <div className="memo-picker-empty">没有匹配的邮件</div>
              ) : (
                pickerHits.map((hit) => (
                  <button
                    key={hit.id}
                    className="memo-picker-row"
                    onClick={() => void addMailLink(hit.id)}
                    data-testid="task-mail-picker-item"
                  >
                    <span className="t">{hit.subject || '(无主题)'}</span>
                    <span className="s">
                      {hit.fromName || hit.fromAddr}
                      {hit.dateTs ? ` · ${new Date(hit.dateTs).toLocaleDateString()}` : ''}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
