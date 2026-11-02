/**
 * 免打扰（DND，V2.3）：在设定时间窗内**不弹系统通知**（照常同步、照常计未读、照常推应用内事件）。
 *
 * 约定：
 *   - 时间格式 `HH:mm`（本地时区，用户机器的时区 —— 这是"免打扰"，跟用户作息绑定，不该用北京时间硬编码）；
 *   - 支持跨午夜（如 23:00–08:00）；
 *   - 起点包含、终点不包含（23:00 生效，08:00 已解除）；
 *   - 起止相同 = 视为未启用（0 长度窗口），避免手滑变成"永远免打扰"；
 *   - 非法输入（格式错、缺少配置）一律按"不在免打扰"处理（宁可多一条通知，也不要静默吞掉新邮件）。
 */

/** 解析 `HH:mm` → 当天分钟数（0..1439）；非法返回 null */
export function parseHhMm(raw: string | null | undefined): number | null {
  const text = String(raw ?? '').trim()
  const m = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return h * 60 + mi
}

/** 本地时间 → 当天分钟数 */
export function localMinutes(nowMs: number): number {
  const d = new Date(nowMs)
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * 是否处于免打扰窗口内。
 * - 跨午夜（start > end）：now >= start 或 now < end；
 * - 同一天（start < end）：start <= now < end；
 * - start === end 或任一非法 → 不算免打扰。
 */
export function isInDndWindow(nowMs: number, start: string, end: string): boolean {
  const s = parseHhMm(start)
  const e = parseHhMm(end)
  if (s === null || e === null || s === e) return false
  const now = localMinutes(nowMs)
  if (s < e) return now >= s && now < e
  // 跨午夜
  return now >= s || now < e
}

/**
 * 统一的「是否弹系统通知」判断（真机反馈：手动动作 + 免打扰都不该打扰用户）。
 * 注意：这里只决定**系统通知**；应用内事件（mail:new）始终照旧推送。
 */
export function shouldShowSystemNotification(opts: {
  /** 新邮件来源（manual* = 用户自己点的动作） */
  reason?: string
  /** 是否启用了免打扰 */
  dndEnabled?: boolean
  dndStart?: string
  dndEnd?: string
  nowMs: number
}): boolean {
  if (opts.reason && opts.reason.startsWith('manual')) return false
  if (opts.dndEnabled && isInDndWindow(opts.nowMs, opts.dndStart ?? '', opts.dndEnd ?? '')) return false
  return true
}

/** 设置页展示用：把窗口格式化为「23:00 – 次日 08:00」 */
export function formatDndWindow(start: string, end: string): string {
  const s = parseHhMm(start)
  const e = parseHhMm(end)
  if (s === null || e === null) return '未设置'
  if (s === e) return '未启用（起止相同）'
  return s > e ? `${start} – 次日 ${end}` : `${start} – ${end}`
}
