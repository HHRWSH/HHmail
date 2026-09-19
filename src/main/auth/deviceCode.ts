/**
 * 设备码登录 + token 刷新（规范 §6.1 / §6.2）。
 * - 用 HTTP 直接实现（不经 MSAL，避免附加 scope 导致 reserved scope 报错）；
 * - scope 只传 IMAP.AccessAsUser.All（规范 §2 第 3 条）；
 * - 轮询可取消/超时；authorization_pending 继续、slow_down 加间隔、expired 重来；
 * - refresh 加互斥锁，新 refresh_token 覆盖旧值（覆盖动作在 TokenStore.save）。
 */
import axios from 'axios'
import { AppError, ErrorCodes } from '../../shared/error-codes'
import type { DeviceCodeEvent, DeviceCodeInfo } from '../../shared/types'
import { DEVICE_CODE_URL, IMAP_SCOPE_STRING, THUNDERBIRD_CLIENT_ID_NEW, TOKEN_URL } from '../config'
import type { Logger } from '../logger'
import type { OAuthTokens } from './tokenStore'
import { computeExpiresAt, extractEmailFromTokens } from './tokenStore'

export interface HttpClient {
  postForm(url: string, params: Record<string, string>): Promise<unknown>
}

export class AxiosHttpClient implements HttpClient {
  async postForm(url: string, params: Record<string, string>): Promise<unknown> {
    const resp = await axios.post(url, new URLSearchParams(params), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30_000
    })
    return resp.data
  }
}

/** 设备码请求参数（纯函数，可单测断言 scope/client_id 精确值）。 */
export function buildDeviceCodeParams(
  clientId: string = THUNDERBIRD_CLIENT_ID_NEW,
  scope: string = IMAP_SCOPE_STRING
): Record<string, string> {
  return { client_id: clientId, scope }
}

export function buildDeviceTokenParams(clientId: string, deviceCode: string): Record<string, string> {
  return {
    client_id: clientId,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode
  }
}

export function buildRefreshParams(
  clientId: string,
  refreshToken: string,
  scope: string = IMAP_SCOPE_STRING
): Record<string, string> {
  return {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope
  }
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface TokenResponseData {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

export function parseDeviceCodeResponse(data: unknown): DeviceCodeResponse {
  const d = (data ?? {}) as Record<string, unknown>
  if (
    typeof d.device_code !== 'string' ||
    typeof d.user_code !== 'string' ||
    typeof d.verification_uri !== 'string' ||
    typeof d.expires_in !== 'number'
  ) {
    throw new AppError(ErrorCodes.UNKNOWN, '设备码请求返回格式异常，请重试。')
  }
  return {
    device_code: d.device_code,
    user_code: d.user_code,
    verification_uri: d.verification_uri,
    expires_in: d.expires_in,
    interval: typeof d.interval === 'number' ? d.interval : 5
  }
}

export function toTokens(data: unknown): OAuthTokens {
  const d = (data ?? {}) as TokenResponseData
  if (typeof d.access_token !== 'string') {
    throw new AppError(ErrorCodes.UNKNOWN, '登录响应缺少 token，请重试。')
  }
  return {
    accessToken: d.access_token,
    // 设备码流偶发不返回 refresh_token：不阻断登录（续期时回退重新登录）
    refreshToken: typeof d.refresh_token === 'string' ? d.refresh_token : '',
    idToken: d.id_token ?? null,
    expiresAtMs: computeExpiresAt(typeof d.expires_in === 'number' ? d.expires_in : 3600),
    obtainedAtMs: Date.now(),
    scope: d.scope ?? ''
  }
}

/** 从 axios 风格错误里提取 OAuth error 代码（不含 token/正文）。 */
export function extractOAuthErrorCode(e: unknown): string {
  const err = e as { response?: { data?: { error?: string } } }
  return err?.response?.data?.error ?? 'network_error'
}

export function isPendingError(code: string): boolean {
  return code === 'authorization_pending'
}
export function isSlowDownError(code: string): boolean {
  return code === 'slow_down'
}
export function isExpiredDeviceCode(code: string): boolean {
  return code === 'expired_token'
}
export function isAccessDenied(code: string): boolean {
  return code === 'access_denied'
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError(ErrorCodes.AUTH_CANCELLED, '登录已取消。'))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new AppError(ErrorCodes.AUTH_CANCELLED, '登录已取消。'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type DeviceCodeEventSink = (event: DeviceCodeEvent) => void

export interface DeviceCodeFlowResult {
  tokens: OAuthTokens
}

export class DeviceCodeAuth {
  private client: HttpClient
  private clientId: string
  private logger?: Logger
  private abort: AbortController | null = null
  /** 登录/刷新时使用的 scope（由设置决定是否包含 SMTP.Send） */
  private scopeProvider: () => Promise<string>

  constructor(
    client: HttpClient,
    logger?: Logger,
    clientId: string = THUNDERBIRD_CLIENT_ID_NEW,
    scopeProvider?: () => Promise<string>
  ) {
    this.client = client
    this.logger = logger
    this.clientId = clientId
    this.scopeProvider = scopeProvider ?? (async () => IMAP_SCOPE_STRING)
  }

  private async scope(): Promise<string> {
    try {
      return await this.scopeProvider()
    } catch {
      return IMAP_SCOPE_STRING
    }
  }

  cancel(): void {
    if (this.abort) {
      this.abort.abort()
      this.abort = null
    }
  }

  /** 发起设备码并返回展示信息；调用 poll() 开始轮询。 */
  async startDeviceCode(): Promise<{ info: DeviceCodeInfo; deviceCode: string }> {
    this.cancel()
    const data = await this.client.postForm(DEVICE_CODE_URL, buildDeviceCodeParams(this.clientId, await this.scope()))
    const parsed = parseDeviceCodeResponse(data)
    this.abort = new AbortController()
    return {
      info: {
        userCode: parsed.user_code,
        verificationUri: parsed.verification_uri,
        expiresIn: parsed.expires_in,
        interval: Math.max(5, parsed.interval)
      },
      deviceCode: parsed.device_code
    }
  }

  /** 轮询 token 端点直到成功/过期/取消。 */
  async poll(deviceCode: string, intervalSec: number, onEvent: DeviceCodeEventSink, signal: AbortSignal): Promise<OAuthTokens> {
    let attempts = 0
    let waitSec = intervalSec
    const deadlineMs = Date.now() + 15 * 60 * 1000 // 设备码最长 15 分钟
    for (;;) {
      if (signal.aborted) {
        onEvent({ type: 'cancelled' })
        throw new AppError(ErrorCodes.AUTH_CANCELLED, '登录已取消。')
      }
      if (Date.now() > deadlineMs) {
        onEvent({ type: 'expired' })
        throw new AppError(ErrorCodes.AUTH_DEVICE_CODE_EXPIRED, '设备码已过期，请重新生成。')
      }
      await sleep(waitSec * 1000, signal)
      attempts += 1
      onEvent({ type: 'polling', attempts })
      try {
        const data = await this.client.postForm(TOKEN_URL, buildDeviceTokenParams(this.clientId, deviceCode))
        if ((data as TokenResponseData)?.access_token) {
          const tokens = toTokens(data)
          onEvent({ type: 'success', email: extractEmailFromTokens(tokens) ?? '' })
          return tokens
        }
      } catch (e) {
        // 业务解析错误（AppError）直接上抛，保留具体中文提示
        if (e instanceof AppError) {
          this.logger?.warn('auth.poll.failed', { errorCode: e.code, attempts })
          throw e
        }
        const code = extractOAuthErrorCode(e)
        this.logger?.warn('auth.poll.failed', { errorCode: code, attempts })
        if (isPendingError(code)) continue
        if (isSlowDownError(code)) {
          waitSec += 5
          continue
        }
        if (isExpiredDeviceCode(code)) {
          onEvent({ type: 'expired' })
          throw new AppError(ErrorCodes.AUTH_DEVICE_CODE_EXPIRED, '设备码已过期，请重新生成。')
        }
        if (isAccessDenied(code)) {
          onEvent({ type: 'error', code, message: '授权被拒绝，请重试。' })
          throw new AppError(ErrorCodes.AUTH_ACCESS_DENIED, '授权被拒绝，请重试。')
        }
        if (code === 'invalid_grant' || code === 'bad_verification_code') {
          onEvent({
            type: 'error',
            code,
            message: '设备码已失效或已被使用（可能上次授权没有在浏览器里点完「接受」）。请点击「重新生成设备码」再试一次。'
          })
          throw new AppError(ErrorCodes.AUTH_DEVICE_CODE_EXPIRED, '设备码已失效或已被使用，请重新生成。')
        }
        if (code === 'network_error') {
          // 网络抖动：继续轮询，不要立刻放弃
          continue
        }
        onEvent({ type: 'error', code, message: '登录失败，请重试。' })
        throw new AppError(ErrorCodes.UNKNOWN, '登录失败，请重试。')
      }
    }
  }

  /** refresh_token 换新 token；invalid_grant → 抛 AUTH_INVALID_GRANT（回退设备码）。 */
  async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    try {
      const data = await this.client.postForm(TOKEN_URL, buildRefreshParams(this.clientId, refreshToken, await this.scope()))
      return toTokens(data)
    } catch (e) {
      const code = extractOAuthErrorCode(e)
      if (code === 'invalid_grant') {
        throw new AppError(ErrorCodes.AUTH_INVALID_GRANT, '登录已失效，请重新登录。')
      }
      this.logger?.warn('auth.refresh.failed', { errorCode: code })
      throw new AppError(ErrorCodes.UNKNOWN, '刷新登录状态失败，请检查网络后重试。')
    }
  }
}
