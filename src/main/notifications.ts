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

/**
 * 新邮件要不要弹 Windows 通知？（真机反馈：用户自己点「同步」时不想被打扰）
 *
 * 规则：
 * - 用户**主动**触发的（手动点同步、手动生成摘要后的顺带同步）→ 不弹；
 * - **后台**自动同步发现的（定时、唤醒、解锁、窗口重新聚焦、IDLE 推送）→ 弹。
 * 无论弹不弹，都会推 `mail:new` 事件让界面刷新列表 —— 所以「不弹通知」不等于「界面不更新」。
 */
export type SyncNotifyReason =
  | 'manual'
  | 'manual-sync'
  | 'manual-summarize'
  | 'interval'
  | 'resume'
  | 'unlock-screen'
  | 'focus'
  | 'idle'
  | 'startup'

export function shouldNotifyNewMail(reason: string | undefined): boolean {
  if (!reason) return true
  if (reason === 'manual' || reason.startsWith('manual')) return false
  return true
}
