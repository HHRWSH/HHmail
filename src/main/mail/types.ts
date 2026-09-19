/**
 * 邮件领域类型（存储/同步/AI 共用，不依赖任何具体实现库）。
 */
import { truncateSafe } from '../../shared/text'

export interface ParsedAttachmentMeta {
  partId: string | null
  filename: string
  contentType: string
  size: number
  contentId: string | null
  disposition: 'attachment' | 'inline'
}

export interface ParsedMessage {
  uid: number
  subject: string
  fromName: string
  fromAddr: string
  toAddrs: string[]
  ccAddrs: string[]
  dateHdr: string | null
  dateTs: number
  messageId: string | null
  references: string[]
  inReplyTo: string | null
  bodyText: string
  bodyHtml: string | null
  snippet: string
  attachments: ParsedAttachmentMeta[]
  flags: string[]
}

export const SNIPPET_MAX = 200

/** 正文 → 摘要（去空白折叠，截断）。 */
export function makeSnippet(text: string, max: number = SNIPPET_MAX): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim()
  return truncateSafe(flat, max)
}
