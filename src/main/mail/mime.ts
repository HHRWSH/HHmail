/**
 * MIME 解析（mailparser 的唯一落点）。
 * 解析结果映射为领域类型 ParsedMessage；inline 内嵌图片不进附件列表（规范 §6.5）。
 */
import { simpleParser } from 'mailparser'
import { cleanMailText, plainFromHtml } from '../../shared/text'
import { makeSnippet, type ParsedAttachmentMeta, type ParsedMessage } from './types'

/** mailparser 结果的子集形状（便于契约测试用 fake 驱动 normalize）。 */
export interface ParsedMailLike {
  subject?: string
  from?: { value?: { name?: string; address?: string }[] }
  to?: { value?: { name?: string; address?: string }[] }
  cc?: { value?: { name?: string; address?: string }[] }
  date?: Date | null
  messageId?: string
  references?: string | string[]
  inReplyTo?: string
  text?: string
  html?: string | false
  attachments?: {
    partId?: string
    filename?: string | null
    contentType?: string
    size?: number
    contentId?: string
    contentDisposition?: string
  }[]
}

function toAddrList(value?: { name?: string; address?: string }[]): string[] {
  if (!value) return []
  return value
    .map((v) => (v.address ? v.address.trim() : ''))
    .filter((x) => x.length > 0)
}

/**
 * HTML → 纯文本兜底（纯 HTML 邮件 mailparser 可能不生成 text 部分，
 * 导致 AI 总结读到「正文内容未提供」、FTS 索引为空）。
 */
/** HTML → 纯文本（实现见 shared/text.ts，纯函数便于单测与跨进程复用）。 */
export { plainFromHtml } from '../../shared/text'

export function normalizeParsed(parsed: ParsedMailLike, uid: number, flags: string[] = []): ParsedMessage {
  const from = parsed.from?.value?.[0]
  const fromName = from?.name?.trim() || ''
  const fromAddr = from?.address?.trim() || ''

  // inline（contentDisposition=inline 且有 cid）不放附件列表；其余按真实附件处理
  const attachments: ParsedAttachmentMeta[] = (parsed.attachments ?? [])
    .filter((a) => !(a.contentDisposition === 'inline' && a.contentId))
    .map((a) => ({
      partId: a.partId ?? null,
      filename: a.filename ?? `part-${a.partId ?? 'unknown'}`,
      contentType: a.contentType ?? 'application/octet-stream',
      size: a.size ?? 0,
      contentId: a.contentId ?? null,
      disposition: a.contentDisposition === 'inline' ? 'inline' : 'attachment'
    }))

  const references: string[] = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? String(parsed.references)
          .split(/\s+/)
          .filter(Boolean)
      : []

  const htmlRaw = typeof parsed.html === 'string' ? parsed.html : null
  // 注意：HTML 邮件的 text 部分常混入 <style> 的 CSS（真机回归）→ 统一做清洗
  const bodyTextRaw = cleanMailText(parsed.text ?? '', htmlRaw)
  // 纯 HTML 邮件：text 为空时从 HTML 提取纯文本（保证 AI 总结与 FTS 能读到正文）
  const bodyText = bodyTextRaw || plainFromHtml(htmlRaw)
  const bodyHtml = typeof parsed.html === 'string' ? parsed.html : null
  const dateTs = parsed.date ? parsed.date.getTime() : 0

  return {
    uid,
    subject: (parsed.subject ?? '').trim() || '(无主题)',
    fromName,
    fromAddr,
    toAddrs: toAddrList(parsed.to?.value),
    ccAddrs: toAddrList(parsed.cc?.value),
    dateHdr: null,
    dateTs,
    messageId: parsed.messageId ?? null,
    references,
    inReplyTo: parsed.inReplyTo ?? null,
    bodyText,
    bodyHtml,
    snippet: makeSnippet(bodyText),
    attachments,
    flags
  }
}

export type RawParser = (raw: Buffer) => Promise<ParsedMailLike>

export const defaultRawParser: RawParser = async (raw) => {
  const parsed = await simpleParser(raw)
  return parsed as unknown as ParsedMailLike
}

export async function parseRawMessage(raw: Buffer, uid: number, flags: string[] = [], parser: RawParser = defaultRawParser): Promise<ParsedMessage> {
  const parsed = await parser(raw)
  return normalizeParsed(parsed, uid, flags)
}
