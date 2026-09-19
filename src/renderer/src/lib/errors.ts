/**
 * 错误码 → 中文可行动提示（规范 §2 第 8 条：不把 stack trace 展示给用户）。
 */
import { ErrorCodes } from '@shared/error-codes'

const MESSAGES: Record<string, string> = {
  [ErrorCodes.AUTH_REQUIRED]: '尚未登录，请先完成设备码登录。',
  [ErrorCodes.AUTH_DEVICE_CODE_EXPIRED]: '设备码已过期，请重新生成一个。',
  [ErrorCodes.AUTH_ACCESS_DENIED]: '授权被拒绝，请重试。',
  [ErrorCodes.AUTH_INVALID_GRANT]: '登录已失效，请重新登录。',
  [ErrorCodes.AUTH_CANCELLED]: '登录已取消。',
  [ErrorCodes.ENCRYPTION_UNAVAILABLE]: '系统加密服务（DPAPI）不可用，无法安全保存登录凭证。',
  [ErrorCodes.IMAP_CONNECT_FAILED]: '无法连接邮箱服务器，请检查网络后重试。',
  [ErrorCodes.IMAP_TIMEOUT]: '邮箱服务器响应超时，请重试。',
  [ErrorCodes.SYNC_FAILED]: '同步失败，请点击刷新重试。',
  [ErrorCodes.SYNC_UIDVALIDITY_CHANGED]: '邮箱结构已变化，正在全量重新同步。',
  [ErrorCodes.AI_NOT_CONFIGURED]: '尚未配置 DeepSeek API Key。',
  [ErrorCodes.AI_RATE_LIMIT]: 'AI 服务请求过于频繁，请稍后再试。',
  [ErrorCodes.AI_FAILED]: 'AI 服务调用失败，请检查 API Key 与网络。',
  [ErrorCodes.VALIDATION_FAILED]: '请求参数无效。',
  [ErrorCodes.UNSUPPORTED_OPERATION]: '当前版本为只读模式，该操作暂不支持。',
  [ErrorCodes.UNKNOWN]: '操作失败，请稍后重试。'
}

export function errorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string }
  if (err?.code && MESSAGES[err.code]) return MESSAGES[err.code]
  if (err?.message) return err.message
  return MESSAGES[ErrorCodes.UNKNOWN]
}
