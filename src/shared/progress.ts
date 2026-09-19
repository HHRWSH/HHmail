/**
 * 批量总结进度显示（纯函数，可单测）。
 *
 * 用户反馈：批量总结时「不知道进度」→ 显示「12 / 50 · 已用 1 分 20 秒」。
 * V2.2 起**不再显示「预计还需」**（用户反馈估算值多余、还会随波动跳来跳去），
 * estimateRemainingMs 仍保留给需要的地方用（例如将来的导出脚本）。
 */

export interface SummaryProgressInput {
  done: number
  total: number
  /** 从开始到现在的耗时（ms） */
  elapsedMs: number
}

/** 毫秒 → 「1 分 20 秒」/「45 秒」/「1 小时 2 分」。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const restMin = minutes % 60
  return restMin > 0 ? `${hours} 小时 ${restMin} 分` : `${hours} 小时`
}

/**
 * 估算剩余时间：按「已完成邮件的平均耗时」外推。
 * done=0 时无法估算 → null（界面显示「正在估算…」）。
 */
export function estimateRemainingMs(input: SummaryProgressInput): number | null {
  const { done, total, elapsedMs } = input
  if (done <= 0 || total <= done || elapsedMs <= 0) return null
  const perItem = elapsedMs / done
  return Math.round(perItem * (total - done))
}

/** 一行进度文案（界面直接渲染）：`已完成 / 总数 · 已用 xx`。 */
export function formatProgressText(input: SummaryProgressInput): string {
  const { done, total, elapsedMs } = input
  const parts: string[] = [`${done} / ${total}`]
  if (elapsedMs > 0) parts.push(`已用 ${formatDuration(elapsedMs)}`)
  return parts.join(' · ')
}

/** 进度百分比（0~100）。 */
export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

/** 主题过长时截断，避免把进度条挤变形。 */
export function shortenSubject(subject: string | null | undefined, max = 42): string {
  const s = String(subject ?? '').trim()
  if (!s) return '（无主题）'
  return s.length > max ? `${s.slice(0, max)}…` : s
}
