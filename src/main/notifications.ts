/**
 * 新邮件通知（自动总结 + Windows 通知）的纯函数部分（可单测）。
 * 系统通知在 ipc 层创建（依赖 Electron Notification）。
 */
import type { MailListItem } from '../shared/types'
import { truncateSafe } from '../shared/text'

export function buildNotificationTitle(subject: string): string {
  return `📬 ${subject || '(无主题)'}`
}

/**
 * 摘要现在按 Markdown 生成（## 主旨 / | 表格 | / - [ ] 待办 …）。
 * 通知栏只显示纯文本，所以要把 Markdown 标记剥掉并跳过纯标题行，
 * 否则通知正文会变成“## 主旨”这种没意义的文本。
 */
export function summaryLeadPlain(summary: string): string {
  const lines = String(summary ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const isHeading = (l: string) => /^#{1,6}\s+/.test(l)
  const isTableSep = (l: string) => /^\|?[\s:|-]*-{2,}[\s:|-]*\|?$/.test(l)
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (isHeading(raw) || isTableSep(raw)) continue // 「## 主旨」这类标题行不是正文
    if (i + 1 < lines.length && isTableSep(lines[i + 1])) continue // 表头行（下一行是 |---|---|）
    const line = raw
      .replace(/^>\s*/, '')
      .replace(/^[-*+]\s+(\[[ xX]\]\s*)?/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .replace(/\s*\|\s*/g, ' · ')
      .trim()
    if (line) return line
  }
  return ''
}

export function buildNotificationBody(item: MailListItem, summary: string | null): string {
  const lead = summaryLeadPlain(summary ?? '')
  if (lead) return truncate(lead, 160)
  return truncate(`${item.fromName || item.fromAddr}：${item.snippet || ''}`, 160)
}

export function truncate(text: string | null | undefined, max: number): string {
  return truncateSafe(String(text ?? ''), max)
}
