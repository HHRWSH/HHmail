/**
 * 日历页：把邮件里的时间事件（截止 / 卡片里提到的日期）铺到月视图上。
 *
 * 设计取舍：
 * - **不在本页做任何解析**：事件由主进程用 shared/calendar 的纯函数派生（统一按北京时间分桶），
 *   渲染层只负责画月历、分天展示，避免同一份时间在不同机器上落到不同日期。
 * - 只请求「当前可见网格」的时间范围（含上下月补白），切换月份才重新拉。
 * - 点某天 → 下面列出当天事项；点某条 → 跳回收件箱详情看原文。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PageProps } from '../registry'
import { api } from '../bridge'
import {
  buildMonthGrid,
  cnDayKey,
  cnDayStart,
  cnParts,
  formatEventTime,
  groupByDay,
  type CalendarCell,
  type CalendarEvent
} from '@shared/calendar'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function CalendarPage({ onOpenMail, onToast, isActive }: PageProps) {
  const today = useMemo(() => Date.now(), [])
  const [cursor, setCursor] = useState(() => {
    const p = cnParts(today)
    return { y: p.y, mo: p.mo }
  })
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string>(() => cnDayKey(today))

  const grid = useMemo(() => buildMonthGrid(cursor.y, cursor.mo), [cursor.y, cursor.mo])
  const from = grid.cells[0][0].start
  const to = grid.cells[grid.cells.length - 1][6].end

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = (await api.listEvents({ from, to })) as CalendarEvent[]
      setEvents(Array.isArray(list) ? list : [])
    } catch (err) {
      setEvents([])
      onToast(`读取日历事件失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [from, to, onToast])

  useEffect(() => {
    if (isActive === false) return
    void load()
  }, [load, isActive])

  const byDay = useMemo(() => groupByDay(events), [events])
  const monthLabel = `${cursor.y} 年 ${cursor.mo} 月`
  const todayKey = cnDayKey(today)
  const monthCount = useMemo(() => events.filter((e) => cnParts(e.ts).mo === cursor.mo && cnParts(e.ts).y === cursor.y).length, [events, cursor])
  const dueCount = useMemo(() => events.filter((e) => e.kind === 'due').length, [events])
  const selectedEvents = byDay.get(selected) ?? []

  const shift = (delta: number) => {
    const next = new Date(Date.UTC(cursor.y, cursor.mo - 1 + delta, 1))
    setCursor({ y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1 })
  }

  const gotoToday = () => {
    const p = cnParts(Date.now())
    setCursor({ y: p.y, mo: p.mo })
    setSelected(cnDayKey(Date.now()))
  }

  const renderCell = (cell: CalendarCell) => {
    const list = byDay.get(cell.key) ?? []
    const isToday = cell.key === todayKey
    const isSelected = cell.key === selected
    const cls = ['cal-cell']
    if (!cell.inMonth) cls.push('out')
    if (isToday) cls.push('today')
    if (isSelected) cls.push('selected')
    if (list.length) cls.push('has-events')
    return (
      <button
        key={cell.key}
        type="button"
        className={cls.join(' ')}
        data-day={cell.key}
        data-count={list.length}
        onClick={() => setSelected(cell.key)}
        title={list.map((e) => `${formatEventTime(e)} ${e.label}`).join('\n') || undefined}
      >
        <span className="cal-daynum">{cell.day}</span>
        {list.length > 0 && <span className="cal-count">{list.length}</span>}
        <span className="cal-dots">
          {list.slice(0, 3).map((e, i) => (
            <span key={`${e.messageId}:${e.ts}:${i}`} className={`cal-dot ${e.kind === 'due' ? 'due' : 'event'}`} />
          ))}
        </span>
        <span className="cal-mini">
          {list.slice(0, 2).map((e, i) => (
            <span key={`m:${e.messageId}:${e.ts}:${i}`} className={`cal-mini-line ${e.kind === 'due' ? 'due' : 'event'}`}>
              {e.hasTime ? `${String(cnParts(e.ts).h).padStart(2, '0')}:${String(cnParts(e.ts).mi).padStart(2, '0')}` : '全天'} {e.label}
            </span>
          ))}
          {list.length > 2 && <span className="cal-mini-more">+{list.length - 2}</span>}
        </span>
      </button>
    )
  }

  return (
    <div className="cal-wrap">
      <div className="cal-head">
        <div className="cal-title">
          <span className="cal-month" data-testid="calendar-month">
            {monthLabel}
          </span>
          <span className="cal-sub">
            {loading ? '读取中…' : `本月 ${monthCount} 件事${dueCount ? ` · 其中截止 ${dueCount}` : ''}`}
          </span>
        </div>
        <div className="cal-actions">
          <button type="button" className="btn ghost" onClick={() => shift(-1)} data-testid="calendar-prev">
            ‹ 上个月
          </button>
          <button type="button" className="btn ghost" onClick={gotoToday} data-testid="calendar-today">
            回到今天
          </button>
          <button type="button" className="btn ghost" onClick={() => shift(1)} data-testid="calendar-next">
            下个月 ›
          </button>
        </div>
      </div>

      <div className="cal-grid-head">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-weekday">
            {w}
          </div>
        ))}
      </div>

      <div className="cal-grid" data-testid="calendar-grid">
        {grid.cells.map((row, ri) => (
          <div className="cal-row" key={`r${ri}`}>
            {row.map(renderCell)}
          </div>
        ))}
      </div>

      <div className="cal-day-panel" data-testid="calendar-day-list" data-day={selected}>
        <div className="cal-day-title">
          {selected}
          {selected === todayKey ? '（今天）' : ''} · {selectedEvents.length} 件事
        </div>
        {selectedEvents.length === 0 ? (
          <div className="cal-empty">这一天没有从邮件里解析到事情。</div>
        ) : (
          <ul className="cal-list">
            {selectedEvents.map((e, i) => (
              <li key={`${e.messageId}:${e.ts}:${i}`} className={`cal-item ${e.kind === 'due' ? 'due' : 'event'}`}>
                <span className="cal-time">{formatEventTime(e)}</span>
                <span className={`cal-kind ${e.kind === 'due' ? 'due' : 'event'}`}>{e.kind === 'due' ? '截止' : '事件'}</span>
                <span className="cal-label" title={e.label}>
                  {e.label}
                </span>
                <span className="cal-meta">
                  {e.course ? `${e.course} · ` : ''}
                  {e.fromName ?? '未知发件人'}
                </span>
                {onOpenMail && (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => onOpenMail(e.messageId)}
                    data-testid="calendar-open-mail"
                  >
                    打开邮件
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** 供其它页面复用：某天 00:00 的时间戳（北京时间） */
export const dayStartOf = cnDayStart
