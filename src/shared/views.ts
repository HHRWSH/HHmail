/**
 * 自定义视图纯函数（V2 M5）：
 * - filterMatches / sortMails 与存储实现无关，SQL 实现（sqlite.ts）与内存实现（tests/helpers/fakes.ts）
 *   必须保持同语义；这些纯函数是 fakes 与单测的事实标准。
 */
import type { MailListItem, ViewFilter, ViewSort } from './types'

/** 视图过滤：所有非空条件 AND 命中（语义与 sqlite.query 的 filter SQL 一致） */
export function filterMatches(mail: MailListItem, filter: ViewFilter | undefined): boolean {
  if (!filter) return true
  if (filter.from) {
    const f = filter.from.toLowerCase()
    if (!mail.fromName.toLowerCase().includes(f) && !mail.fromAddr.toLowerCase().includes(f)) return false
  }
  if (filter.unread && !mail.unread) return false
  if (filter.hasAttachment && !mail.hasAttachments) return false
  if (filter.labelIds && filter.labelIds.length > 0) {
    const ids = mail.labels.map((l) => l.id)
    if (!filter.labelIds.some((id) => ids.includes(id))) return false
  }
  if (filter.dateFrom !== undefined && mail.dateTs < filter.dateFrom) return false
  if (filter.dateTo !== undefined && mail.dateTs > filter.dateTo) return false
  if (filter.text) {
    const t = filter.text.toLowerCase()
    const hay = `${mail.subject}\n${mail.snippet}\n${mail.fromName}\n${mail.fromAddr}`.toLowerCase()
    if (!hay.includes(t)) return false
  }
  return true
}

/** 视图排序（稳定：同键按 dateTs 降序兜底） */
export function sortMails(mails: MailListItem[], sort: ViewSort | undefined): MailListItem[] {
  const dir = sort?.dir === 'asc' ? 1 : -1
  const key = (m: MailListItem): string | number => {
    switch (sort?.by) {
      case 'from':
        return (m.fromName || m.fromAddr).toLowerCase()
      case 'subject':
        return m.subject.toLowerCase()
      default:
        return m.dateTs
    }
  }
  return [...mails].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka === kb) return b.dateTs - a.dateTs
    if (typeof ka === 'number' && typeof kb === 'number') return (ka - kb) * dir
    return String(ka).localeCompare(String(kb)) * dir
  })
}
