/**
 * 统一错误码（规范 §6.10）。
 * 只新增、不改名；UI 层通过 error-codes 映射为中文可行动提示。
 */
export const ErrorCodes = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_DEVICE_CODE_EXPIRED: 'AUTH_DEVICE_CODE_EXPIRED',
  AUTH_ACCESS_DENIED: 'AUTH_ACCESS_DENIED',
  AUTH_INVALID_GRANT: 'AUTH_INVALID_GRANT',
  AUTH_CANCELLED: 'AUTH_CANCELLED',
  ENCRYPTION_UNAVAILABLE: 'ENCRYPTION_UNAVAILABLE',
  IMAP_CONNECT_FAILED: 'IMAP_CONNECT_FAILED',
  IMAP_TIMEOUT: 'IMAP_TIMEOUT',
  SYNC_FAILED: 'SYNC_FAILED',
  SYNC_UIDVALIDITY_CHANGED: 'SYNC_UIDVALIDITY_CHANGED',
  AI_NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  AI_RATE_LIMIT: 'AI_RATE_LIMIT',
  AI_FAILED: 'AI_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  UNKNOWN: 'UNKNOWN'
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/** 带错误码的应用错误：跨 IPC 只传 code + 中文提示，不传 stack trace。 */
export class AppError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, userMessage: string) {
    super(userMessage)
    this.name = 'AppError'
    this.code = code
  }
}
