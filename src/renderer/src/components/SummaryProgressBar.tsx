/**
 * 批量总结进度条（用户反馈：批量跑摘要时「不知道进度、也不知道要等多久」）。
 *
 * 显示：
 *   ① 正在生成哪一封（主题，实时更新）
 *   ② 完成数 / 总数（+ 已用时间）+ 百分比进度条
 *   ③ 「停止」按钮
 * 注：V2.2 起去掉「预计还需 xx」——用户反馈估算值多余（且会随每封耗时波动跳变）。
 *
 * 常驻挂载：订阅一次全局进度事件，任一页面触发批量总结都会显示。
 */
import { memo, useEffect, useRef, useState } from 'react'
import { formatProgressText, progressPercent, shortenSubject } from '@shared/progress'
import { api } from '../bridge'

export interface SummaryProgressState {
  done: number
  total: number
  subject: string | null
  current: boolean
  /** 主进程报告的已用时间（收到事件那一刻） */
  elapsedMs: number
  /** 本地收到该事件的时刻，用于在两次事件之间继续走秒 */
  receivedAt: number
  cancelled: boolean
}

interface Props {
  /** 完成时回调（例如设置页刷新索引覆盖数） */
  onFinished?: (cancelled: boolean) => void
}

export const SummaryProgressBar = memo(function SummaryProgressBar({ onFinished }: Props) {
  const [state, setState] = useState<SummaryProgressState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const finishedRef = useRef<((cancelled: boolean) => void) | undefined>(onFinished)
  finishedRef.current = onFinished

  useEffect(() => {
    const unsubscribe = api.onSummaryProgress((p) => {
      if (p.finished) {
        setState(null)
        finishedRef.current?.(p.cancelled === true)
        return
      }
      setState({
        done: p.done,
        total: p.total,
        subject: p.subject,
        current: p.current === true,
        elapsedMs: p.elapsedMs ?? 0,
        receivedAt: Date.now(),
        cancelled: p.cancelled === true
      })
    })
    return unsubscribe
  }, [])

  // 每 2 秒刷新一次本地时钟：主进程只在每封结束推事件，
  // 中间这段时间「已用」也要继续走，否则用户以为卡住了
  useEffect(() => {
    if (!state) return
    const timer = window.setInterval(() => setNow(Date.now()), 2000)
    return () => window.clearInterval(timer)
  }, [state])

  if (!state) return null

  const percent = progressPercent(state.done, state.total)
  const elapsedMs = state.elapsedMs + Math.max(0, now - state.receivedAt)
  const text = formatProgressText({ done: state.done, total: state.total, elapsedMs })

  return (
    <div className="summary-progress" data-testid="summary-progress">
      <div className="sp-line">
        <span className="sp-ico">{state.current ? '🧠' : '⏳'}</span>
        <span className="sp-what" data-testid="summary-progress-subject">
          {state.current ? '正在生成：' : '刚完成：'}
          {shortenSubject(state.subject)}
        </span>
        <span className="sp-text" data-testid="summary-progress-text">
          {text}
        </span>
        <button
          className="link-btn sp-stop"
          onClick={() => void api.cancelSummarize().catch(() => undefined)}
          data-testid="summary-progress-stop"
        >
          停止
        </button>
      </div>
      <div className="sp-bar">
        <div className="sp-bar-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
})
