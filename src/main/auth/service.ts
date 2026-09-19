/**
 * AuthService —— 组合设备码、DPAPI 存储与续期的业务门面（组合根装配）。
 * - refresh 互斥锁，防并发刷新竞态覆盖（规范 §6.2）；
 * - 登录延迟/刷新失败落脱敏日志指标（规范 §6.10）。
 */
import { AppError, ErrorCodes } from '../../shared/error-codes'
import type { AuthStatus, DeviceCodeEvent, DeviceCodeInfo } from '../../shared/types'
import type { Logger } from '../logger'
import type { DeviceCodeAuth } from './deviceCode'
import { extractEmailFromTokens, isTokenExpired, type TokenStore } from './tokenStore'
import { hashAccount } from '../logger'

export interface AuthService {
  status(): Promise<AuthStatus>
  startDeviceCode(): Promise<DeviceCodeInfo>
  cancelDeviceCode(): void
  logout(): Promise<void>
  ensureValidToken(): Promise<{ user: string; accessToken: string }>
  refresh(): Promise<void>
}

export class DefaultAuthService implements AuthService {
  private deviceCodeAuth: DeviceCodeAuth
  private tokenStore: TokenStore
  private logger: Logger
  private emit: (e: DeviceCodeEvent) => void
  private refreshChain: Promise<void> = Promise.resolve()
  private pollAbort: AbortController | null = null

  constructor(deps: { deviceCodeAuth: DeviceCodeAuth; tokenStore: TokenStore; logger: Logger; emit: (e: DeviceCodeEvent) => void }) {
    this.deviceCodeAuth = deps.deviceCodeAuth
    this.tokenStore = deps.tokenStore
    this.logger = deps.logger
    this.emit = deps.emit
  }

  async status(): Promise<AuthStatus> {
    const saved = await this.tokenStore.load()
    if (!saved) return { loggedIn: false, email: null }
    return { loggedIn: true, email: saved.email }
  }

  async startDeviceCode(): Promise<DeviceCodeInfo> {
    const startedAt = Date.now()
    const { info, deviceCode } = await this.deviceCodeAuth.startDeviceCode()
    this.emit({ type: 'started' })
    this.pollAbort = new AbortController()
    const signal = this.pollAbort.signal
    // 后台轮询（不阻塞 IPC 返回）
    void (async () => {
      try {
        const tokens = await this.deviceCodeAuth.poll(deviceCode, info.interval, this.emit, signal)
        const email = extractEmailFromTokens(tokens)
        if (!email) {
          this.emit({ type: 'error', code: ErrorCodes.UNKNOWN, message: '无法从登录响应中解析账户邮箱，请重试。' })
          return
        }
        await this.tokenStore.save(tokens, email)
        this.logger.metric('auth.login.duration', Date.now() - startedAt, { accountHash: hashAccount(email) })
        this.logger.info('auth.login.success', { accountHash: hashAccount(email) })
        this.emit({ type: 'success', email })
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError(ErrorCodes.UNKNOWN, '登录失败，请重试。')
        if (err.code === ErrorCodes.AUTH_CANCELLED) {
          this.emit({ type: 'cancelled' })
          return
        }
        this.logger.warn('auth.login.failed', { errorCode: err.code })
        this.emit({ type: 'error', code: err.code, message: err.message })
      }
    })()
    return info
  }

  cancelDeviceCode(): void {
    this.deviceCodeAuth.cancel()
    this.pollAbort?.abort()
  }

  async logout(): Promise<void> {
    this.cancelDeviceCode()
    await this.tokenStore.clear()
    this.logger.info('auth.logout')
  }

  /** refresh 互斥：并发调用全部挂到同一 promise 上。 */
  refresh(): Promise<void> {
    this.refreshChain = this.refreshChain.then(() => this.doRefresh(), () => this.doRefresh())
    return this.refreshChain
  }

  private async doRefresh(): Promise<void> {
    const saved = await this.tokenStore.load()
    if (!saved) throw new AppError(ErrorCodes.AUTH_REQUIRED, '尚未登录，请先登录。')
    if (!saved.tokens.refreshToken) {
      // 本次登录未拿到 refresh_token：无法续期，清空回退设备码
      this.logger.warn('auth.refresh.no_refresh_token')
      await this.tokenStore.clear()
      const err = new AppError(ErrorCodes.AUTH_INVALID_GRANT, '登录已失效，请重新登录。')
      this.emit({ type: 'error', code: err.code, message: err.message })
      throw err
    }
    const startedAt = Date.now()
    try {
      const tokens = await this.deviceCodeAuth.refreshTokens(saved.tokens.refreshToken)
      // 新 refresh_token 覆盖旧值（规范 §2 第 4 条）
      await this.tokenStore.save(tokens, saved.email)
      this.logger.metric('auth.refresh.duration', Date.now() - startedAt, { accountHash: hashAccount(saved.email) })
      this.logger.info('auth.refresh.success', { accountHash: hashAccount(saved.email) })
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError(ErrorCodes.UNKNOWN, '刷新失败。')
      if (err.code === ErrorCodes.AUTH_INVALID_GRANT) {
        // refresh_token 失效 → 清空并回退设备码（记录原因，通知 UI 回登录页）
        this.logger.warn('auth.refresh.invalid_grant')
        await this.tokenStore.clear()
        this.emit({ type: 'error', code: err.code, message: err.message })
      }
      throw err
    }
  }

  /** IMAP 连接前调用：过期则刷新，返回可用的 user + accessToken。 */
  async ensureValidToken(): Promise<{ user: string; accessToken: string }> {
    const saved = await this.tokenStore.load()
    if (!saved) throw new AppError(ErrorCodes.AUTH_REQUIRED, '尚未登录，请先登录。')
    if (isTokenExpired(saved.tokens)) {
      if (!saved.tokens.refreshToken) {
        // 没有 refresh_token 可续期 → 只能重新登录（微软本次登录未发放 refresh 凭据）
        this.logger.warn('auth.refresh.no_refresh_token')
        await this.tokenStore.clear()
        this.emit({ type: 'error', code: ErrorCodes.AUTH_INVALID_GRANT, message: '登录已失效，请重新登录。' })
        throw new AppError(ErrorCodes.AUTH_INVALID_GRANT, '登录已失效，请重新登录。')
      }
      await this.refresh()
    }
    const fresh = await this.tokenStore.load()
    if (!fresh) throw new AppError(ErrorCodes.AUTH_REQUIRED, '登录状态已失效，请重新登录。')
    return { user: fresh.email, accessToken: fresh.tokens.accessToken }
  }
}
