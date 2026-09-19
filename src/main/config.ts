/**
 * 全局常量与 AI 模型配置（规范 §3）。
 */
import { AppError, ErrorCodes } from '../shared/error-codes'
import { validateAiConfig } from '../shared/aiProviders'

// —— OAuth / IMAP 关键常量（规范 §3）——
export const THUNDERBIRD_CLIENT_ID_NEW = '9e5f94bc-e8a4-4e73-b8be-63364c29d753'
export const THUNDERBIRD_CLIENT_ID_OLD = '08162f7c-0fd2-4200-a84a-f25a4db0b584'

export const DEVICE_CODE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode'
export const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'

/**
 * 设备码 scope：数据权限只有 IMAP 只读（不含 openid/profile/email/Graph）。
 * 另加 `offline_access`——它不授予任何额外数据访问，只是让微软发放 refresh token；
 * 缺了它 access token 一小时后过期就必须重新登录（真机回归：DB 里 refresh 密文为空串）。
 */
export const IMAP_SCOPES = ['https://outlook.office.com/IMAP.AccessAsUser.All', 'offline_access'] as const

/** 请求 scope 字符串（多个用空格分隔，OAuth 规范） */
export const IMAP_SCOPE_STRING = IMAP_SCOPES.join(' ')

/**
 * 发信权限（真机验证：Microsoft 365 学校租户允许该公共客户端申请 SMTP.Send，
 * 且邮箱本身允许 SMTP AUTH —— AUTH XOAUTH2 返回 235）。
 * 勾选后登录会多要这一条权限；不同意也能退回纯只读。
 */
export const SMTP_SEND_SCOPE = 'https://outlook.office.com/SMTP.Send'
export const SEND_SCOPE_STRING = ['https://outlook.office.com/IMAP.AccessAsUser.All', SMTP_SEND_SCOPE, 'offline_access'].join(' ')

/** 按设置决定登录 scope */
export function buildScopeString(includeSend: boolean): string {
  return includeSend ? SEND_SCOPE_STRING : IMAP_SCOPE_STRING
}

export const IMAP_HOST = 'outlook.office365.com'
export const IMAP_PORT = 993

/** SMTP（发送能力自检用；当前版本不提供真正的发送功能） */
export const SMTP_HOST = 'smtp.office365.com'
export const SMTP_PORT = 587

// —— DeepSeek（规范 §3.1）——
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
/** 默认模型：V4.1 Flash（2026-09 正式发布）。注意 API 实际模型名是 `deepseek-flash`——
 *  服务端明确返回：supported API model names are `deepseek-flash`, `deepseek-v4-pro`。 */
export const DEEPSEEK_MODEL = 'deepseek-flash'
export const DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/** 历史默认模型：仅用于「默认值一次性迁移」（老用户没主动改过就跟随新默认）。 */
export const LEGACY_DEFAULT_AI_MODELS: readonly string[] = ['deepseek-v4-pro', 'deepseek-v4.1', 'deepseek-v4.1-flash']

/**
 * DeepSeek 允许的模型名（V2.2 起只保留 deepseek-flash = V4.1 Flash；
 * 用户明确要求下线 deepseek-v4-pro / v4-flash / vision 版本）。
 * 其它服务商的模型名不在这里校验，见 shared/aiProviders.ts。
 */
export const ALLOWED_AI_MODELS: readonly string[] = [
  DEEPSEEK_MODEL
]

export const DEPRECATED_AI_MODELS: readonly string[] = ['deepseek-chat', 'deepseek-reasoner']

/**
 * 校验模型名（V2.2：支持多家服务商）。
 * - DeepSeek 只保留 deepseek-flash（V4.1 Flash，用户要求下线其余 DeepSeek 模型）；
 * - 其它服务商/自定义：只校验非空与长度（模型名会随服务商更新，不写死）。
 */
export function validateAiModel(name: string, providerId: string = 'deepseek'): string {
  const trimmed = name.trim()
  if (DEPRECATED_AI_MODELS.includes(trimmed)) {
    throw new AppError(
      ErrorCodes.VALIDATION_FAILED,
      `模型 ${trimmed} 已弃用，DeepSeek 请使用 ${DEEPSEEK_MODEL}`
    )
  }
  const check = validateAiConfig(providerId, trimmed)
  if (!check.ok) throw new AppError(ErrorCodes.VALIDATION_FAILED, check.reason ?? `不支持的 AI 模型：${trimmed}`)
  return trimmed
}

/** 同步范围默认值：0 = 全部历史邮件（用户要求），>0 = 最近 N 封。 */
export const DEFAULT_SYNC_WINDOW = 0

/** 自动刷新间隔默认值（秒）：300 = 每 5 分钟自动增量同步一次；0 = 关闭。 */
export const DEFAULT_REFRESH_INTERVAL_SEC = 300

/** 单封取正文兜底超时（毫秒）：无法确认 UID 是否存在时使用。 */
export const FETCH_BODY_TIMEOUT_MS = 25_000
/** envelope 已确认存在的邮件取正文超时（毫秒）：真机单封可达 40s+，宁可慢也不丢信。 */
export const CONFIRMED_FETCH_TIMEOUT_MS = 120_000

/** 同步每批 UID 数量（规范 §6.4：10–20 封/批）。 */
export const SYNC_CHUNK_SIZE = 15
