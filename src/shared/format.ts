/**
 * 时间格式化（纯函数，主进程与渲染进程共用）。
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 邮件列表时间：今天→HH:mm；昨天→昨天；今年→M月D日；更早→YYYY年M月D日。 */
export function formatRelativeDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const t = new Date(now)
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(t) - startOfDay(d)) / 86_400_000)
  if (dayDiff <= 0) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (dayDiff === 1) return '昨天'
  if (d.getFullYear() === t.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * 更细的「相对时间」（设置里开了相对时间时用）：
 * 刚刚 / N 分钟前 / N 小时前 / 昨天 / M月D日 / YYYY年M月D日。
 */
export function formatSmartTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts
  if (diff >= 0 && diff < 60_000) return '刚刚'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return formatRelativeDate(ts, now)
}

/** 绝对时间（设置里关掉相对时间时用）：2026-09-12 18:30。 */
export function formatAbsoluteDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 列表时间：按设置选相对或绝对。 */
export function formatListTime(ts: number, relative: boolean, now: number = Date.now()): string {
  return relative ? formatSmartTime(ts, now) : formatAbsoluteDate(ts)
}

/** 详情页完整时间。 */
export function formatFullDate(ts: number): string {
  const d = new Date(ts)
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（周${week}） ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 附件大小显示。 */
export function formatBytes(size: number): string {
  if (size <= 0) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
