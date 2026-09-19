/**
 * MailProvider —— 邮件后端抽象（规范 §14.1，最关键接口）。
 * 上层（sync/AI/UI）只依赖本接口；imapflow 只允许出现在 imap.ts。
 */
import { AppError, ErrorCodes } from '../../shared/error-codes'

export interface MailboxInfo {
  uidValidity: number
  exists: number
  uidNext: number
}

export interface RawAddress {
  name?: string
  address?: string
}

export interface RawEnvelope {
  subject?: string
  from?: RawAddress[]
  date?: string | Date
  messageId?: string
}

export interface RawMessageMeta {
  uid: number
  envelope: RawEnvelope
  flags: string[]
}

export interface RawMessageBody {
  uid: number
  raw: Buffer
}

export interface AttachmentPayload {
  filename: string
  contentType: string
  content: Buffer
}

export interface MailProviderCapabilities {
  /** P0 只读；P1 加 Graph/SMTP 时同步代码不动。 */
  readOnly: true
  send?: false
  move?: false
}

export interface OutgoingDraft {
  to: string[]
  subject: string
  text: string
}

export function unsupportedOperation(what: string): AppError {
  return new AppError(ErrorCodes.UNSUPPORTED_OPERATION, `${what} 当前版本不支持（P0 只读，P1 预留）`)
}

export interface FetchBodyOptions {
  /** 单封取正文超时（毫秒）；envelope 已确认存在的邮件可放宽，避免慢服务器丢信 */
  timeoutMs?: number
}

export interface MailProvider {
  readonly capabilities: MailProviderCapabilities
  connect(): Promise<void>
  /** 永远 readonly（规范 §2 第 1 条）。 */
  openInboxReadOnly(): Promise<MailboxInfo>
  /** 只读打开任意文件夹（V2 M3）。 */
  openFolderReadOnly(folderPath: string): Promise<MailboxInfo>
  /** 列出所有文件夹（V2 M3）。 */
  listFolders(): Promise<{ name: string; path: string }[]>
  fetchEnvelopeRange(startUid: number, endUid: number): AsyncIterable<RawMessageMeta>
  /**
   * 服务端权威 UID 列表（UID SEARCH ALL）。
   * 用于与本地 UID 集合对账：彻底消除「本地游标越过真实邮件」和
   * 「envelope 区间扫描漏 UID」两种丢信路径（真机回归：服务器 167 封、本地 165 封）。
   */
  searchAllUids(folder: string): Promise<number[]>
  /** BODY.PEEK，永不标 \Seen；uid 不存在时返回 null。 */
  fetchBody(uid: number, opts?: FetchBodyOptions): Promise<RawMessageBody | null>
  /** 按需拉取附件（BODY.PEEK[part]）。 */
  fetchAttachment(uid: number, partId: string): Promise<AttachmentPayload>
  close(): Promise<void>
  // —— 预留写能力（P0 抛 UnsupportedOperationError，UI 按 capabilities 隐藏按钮）——
  send?(draft: OutgoingDraft): Promise<void>
  move?(uid: number, folder: string): Promise<void>
}
