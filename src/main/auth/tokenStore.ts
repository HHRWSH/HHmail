/**
 * Token 安全存储（规范 §2 第 4 条）：
 * - 明文永不落盘：经 safeStorage（Windows DPAPI）加密后写入 SQLite accounts 表；
 * - refresh 后新 token 覆盖旧值；
 * - JWT 解析/邮箱兜底为纯函数，可单测。
 */
import { AppError, ErrorCodes } from '../../shared/error-codes'
import type { Logger } from '../logger'

export interface OAuthTokens {
  accessToken: string
  /** 允许为空串：设备码流偶发不返回 refresh_token（登录仍可完成，续期时回退重新登录）。 */
  refreshToken: string
  idToken?: string | null
  expiresAtMs: number
  obtainedAtMs: number
  scope: string
}

export interface AccountRecord {
  email: string
  refreshTokenEnc: string
  accessTokenEnc: string
  accessTokenExpiresAtMs: number
}

/** accounts 表的极窄仓储接口（SQLite 实现注入，测试用 fake）。 */
export interface AccountRepository {
  getAccount(): Promise<AccountRecord | null>
  upsertAccount(record: AccountRecord): Promise<void>
  clearAccount(): Promise<void>
}

/** safeStorage 的形状（组合根注入 electron.safeStorage，测试注入 fake）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** 把 base64 密文还原成 Buffer 供 safeStorage 解密。 */
export function decodeB64(b64: string): Buffer {
  return Buffer.from(b64, 'base64')
}

export function encodeB64(buf: Buffer): string {
  return buf.toString('base64')
}

/** 解码 JWT payload（不校验签名，只用于提取 upn/email 等声明）。 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const obj = JSON.parse(json)
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 账户邮箱兜底顺序（规范 §6.1）：upn → unique_name → email → preferred_username。 */
export function pickAccountEmail(payload: Record<string, unknown>): string | null {
  const keys = ['upn', 'unique_name', 'email', 'preferred_username'] as const
  for (const key of keys) {
    const v = payload[key]
    if (typeof v === 'string' && v.includes('@')) return v.trim()
  }
  return null
}

export function computeExpiresAt(expiresInSec: number, now: number = Date.now()): number {
  const safeSec = Math.max(0, Math.floor(expiresInSec))
  return now + safeSec * 1000
}

export function isTokenExpired(tokens: OAuthTokens, skewMs: number = 60_000, now: number = Date.now()): boolean {
  return now + skewMs >= tokens.expiresAtMs
}

export function extractEmailFromTokens(tokens: OAuthTokens): string | null {
  if (tokens.idToken) {
    const email = pickAccountEmail(decodeJwtPayload(tokens.idToken) ?? {})
    if (email) return email
  }
  return pickAccountEmail(decodeJwtPayload(tokens.accessToken) ?? {})
}

export interface TokenStore {
  save(tokens: OAuthTokens, email: string): Promise<void>
  load(): Promise<{ email: string; tokens: OAuthTokens } | null>
  clear(): Promise<void>
}

export class SafeStorageTokenStore implements TokenStore {
  private safeStorage: SafeStorageLike
  private repo: AccountRepository
  private logger?: Logger

  constructor(safeStorage: SafeStorageLike, repo: AccountRepository, logger?: Logger) {
    this.safeStorage = safeStorage
    this.repo = repo
    this.logger = logger
  }

  async save(tokens: OAuthTokens, email: string): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new AppError(ErrorCodes.ENCRYPTION_UNAVAILABLE, '系统加密服务（DPAPI）不可用，无法安全保存登录凭证。')
    }
    const record: AccountRecord = {
      email,
      refreshTokenEnc: encodeB64(this.safeStorage.encryptString(tokens.refreshToken)),
      accessTokenEnc: encodeB64(this.safeStorage.encryptString(tokens.accessToken)),
      accessTokenExpiresAtMs: tokens.expiresAtMs
    }
    await this.repo.upsertAccount(record)
    // 注意：这里只能记录 email 的存在性，绝不记录 token 本身
    this.logger?.info('auth.token.saved')
  }

  async load(): Promise<{ email: string; tokens: OAuthTokens } | null> {
    const record = await this.repo.getAccount()
    if (!record) return null
    try {
      const accessToken = this.safeStorage.decryptString(decodeB64(record.accessTokenEnc))
      const refreshToken = this.safeStorage.decryptString(decodeB64(record.refreshTokenEnc))
      if (!accessToken) return null
      return {
        email: record.email,
        tokens: {
          accessToken,
          refreshToken: refreshToken ?? '',
          idToken: null,
          expiresAtMs: record.accessTokenExpiresAtMs,
          obtainedAtMs: 0,
          scope: ''
        }
      }
    } catch (e) {
      // 解密失败 = 数据损坏（如换用户/系统），清掉重建，不抛栈给用户
      this.logger?.warn('auth.token.corrupt')
      await this.repo.clearAccount()
      return null
    }
  }

  async clear(): Promise<void> {
    await this.repo.clearAccount()
    this.logger?.info('auth.token.cleared')
  }
}
