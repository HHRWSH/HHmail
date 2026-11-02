/**
 * 未读角标的「取哪个角标 / 什么文案」规则（纯函数，渲染层与主进程共用，便于单测）。
 *
 * Windows 任务栏 overlay 只能用一张图：1–9 用单个数字，超过 9 用「9+」；
 * 0 = 清空角标（传 null 给 setOverlayIcon）。
 */

export type UnreadBadgeKind = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '9plus'

/** 未读数 → 角标种类；0/负数/非法 → null（清除角标） */
export function badgeKind(count: number): UnreadBadgeKind | null {
  const n = Math.floor(Number(count))
  if (!Number.isFinite(n) || n <= 0) return null
  if (n >= 10) return '9plus'
  return String(n) as UnreadBadgeKind
}

/** 角标上的文字（9plus → '9+'） */
export function badgeText(kind: UnreadBadgeKind): string {
  return kind === '9plus' ? '9+' : kind
}

/** 任务栏 overlay 的无障碍描述（Windows 会读屏播报） */
export function badgeDescription(count: number): string {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  return n > 0 ? `${n} 封未读邮件` : '没有未读邮件'
}

/** 托盘 tooltip：品牌名 + 未读数（0 时只显示品牌名） */
export function badgeTooltip(brand: string, count: number): string {
  const name = String(brand ?? '').trim() || 'HHmail'
  const n = Math.max(0, Math.floor(Number(count) || 0))
  return n > 0 ? `${name} · ${n} 封未读` : name
}
