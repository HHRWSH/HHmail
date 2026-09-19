import { describe, expect, it } from 'vitest'
import {
  AxiosHttpClient,
  buildDeviceCodeParams,
  buildDeviceTokenParams,
  buildRefreshParams,
  DeviceCodeAuth,
  extractOAuthErrorCode,
  isAccessDenied,
  isExpiredDeviceCode,
  isPendingError,
  isSlowDownError,
  parseDeviceCodeResponse,
  toTokens
} from './deviceCode'
import { THUNDERBIRD_CLIENT_ID_NEW, DEVICE_CODE_URL, TOKEN_URL, IMAP_SCOPE_STRING, SEND_SCOPE_STRING, buildScopeString } from '../config'
import { FakeHttpClient, oauthErrorResponse } from '../../../tests/helpers/fakes'
import { AppError, ErrorCodes } from '../../shared/error-codes'
import { MemoryLogger } from '../logger'

describe('设备码请求参数（规范 §2 第 3 条：scope 精确值）', () => {
  it('scope = IMAP 只读 + offline_access（后者仅为拿 refresh token，不含 openid/profile/email/Graph）', () => {
    const p = buildDeviceCodeParams()
    expect(p.client_id).toBe(THUNDERBIRD_CLIENT_ID_NEW)
    expect(p.scope).toBe('https://outlook.office.com/IMAP.AccessAsUser.All offline_access')
    expect(p.scope).not.toContain('openid')
    expect(p.scope).not.toContain('graph.microsoft.com')
    expect(Object.keys(p)).toEqual(['client_id', 'scope'])
  })

  it('scope 可注入：默认只读；开启发信时带上 SMTP.Send（真机验证：微软 365 学校租户允许）', () => {
    expect(buildDeviceCodeParams(THUNDERBIRD_CLIENT_ID_NEW).scope).toBe(IMAP_SCOPE_STRING)
    expect(buildDeviceCodeParams(THUNDERBIRD_CLIENT_ID_NEW, SEND_SCOPE_STRING).scope).toContain('SMTP.Send')
    expect(buildScopeString(false)).toBe(IMAP_SCOPE_STRING)
    expect(buildScopeString(true)).toContain('https://outlook.office.com/SMTP.Send')
    // 发信 scope 仍保留 IMAP 只读与 offline_access（否则会掉线）
    expect(buildScopeString(true)).toContain('IMAP.AccessAsUser.All')
    expect(buildScopeString(true)).toContain('offline_access')
    // refresh 也带 scope，避免刷新后掉权限
    expect(buildRefreshParams(THUNDERBIRD_CLIENT_ID_NEW, 'RT', SEND_SCOPE_STRING).scope).toContain('SMTP.Send')
  })

  it('token 请求 grant_type 为设备码流', () => {
    const p = buildDeviceTokenParams(THUNDERBIRD_CLIENT_ID_NEW, 'DEVCODE')
    expect(p.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(p.device_code).toBe('DEVCODE')
  })

  it('refresh 请求带 scope 且用 refresh_token grant', () => {
    const p = buildRefreshParams(THUNDERBIRD_CLIENT_ID_NEW, 'RT')
    expect(p.grant_type).toBe('refresh_token')
    expect(p.refresh_token).toBe('RT')
    expect(p.scope).toBe('https://outlook.office.com/IMAP.AccessAsUser.All offline_access')
  })
})

describe('设备码响应解析', () => {
  it('解析合法响应', () => {
    const info = parseDeviceCodeResponse({
      device_code: 'dc',
      user_code: 'ABC123',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900,
      interval: 5
    })
    expect(info.user_code).toBe('ABC123')
    expect(info.interval).toBe(5)
  })

  it('缺字段抛错', () => {
    expect(() => parseDeviceCodeResponse({ device_code: 'x' })).toThrow(AppError)
  })

  it('token 响应转 OAuthTokens（expires_in 转绝对时间）', () => {
    const tokens = toTokens({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
    expect(tokens.accessToken).toBe('AT')
    expect(tokens.refreshToken).toBe('RT')
    expect(tokens.expiresAtMs).toBeGreaterThan(Date.now() + 3590 * 1000)
  })

  it('缺 refresh_token 不阻断登录（refreshToken 为空串，续期时回退重登）', () => {
    const tokens = toTokens({ access_token: 'AT', expires_in: 3600 })
    expect(tokens.accessToken).toBe('AT')
    expect(tokens.refreshToken).toBe('')
    expect(() => toTokens({ refresh_token: 'RT' })).toThrow(AppError) // 缺 access_token 仍报错
  })
})

describe('OAuth 错误分类', () => {
  it('authorization_pending / slow_down / expired_token / access_denied', () => {
    expect(isPendingError(extractOAuthErrorCode(oauthErrorResponse('authorization_pending')))).toBe(true)
    expect(isSlowDownError(extractOAuthErrorCode(oauthErrorResponse('slow_down')))).toBe(true)
    expect(isExpiredDeviceCode(extractOAuthErrorCode(oauthErrorResponse('expired_token')))).toBe(true)
    expect(isAccessDenied(extractOAuthErrorCode(oauthErrorResponse('access_denied')))).toBe(true)
  })
})

describe('轮询状态机', () => {
  it('pending → 继续轮询 → 成功返回 token', async () => {
    const http = new FakeHttpClient()
    http
      .queueResponse({ device_code: 'dc', user_code: 'U', verification_uri: 'v', expires_in: 900, interval: 5 })
      .queueError(oauthErrorResponse('authorization_pending'))
      .queueResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
    const auth = new DeviceCodeAuth(http, new MemoryLogger())
    const { info, deviceCode } = await auth.startDeviceCode()
    expect(info.userCode).toBe('U')

    const events: string[] = []
    const tokens = await auth.poll(deviceCode, 1, (e) => events.push(e.type), new AbortController().signal)
    expect(tokens.accessToken).toBe('AT')
    expect(events).toContain('polling')
    expect(events[events.length - 1]).toBe('success')
    expect(http.calls[0].url).toBe(DEVICE_CODE_URL)
    expect(http.calls[1].url).toBe(TOKEN_URL)
  })

  it('expired_token → 抛 AUTH_DEVICE_CODE_EXPIRED 并上报 expired 事件', async () => {
    const http = new FakeHttpClient()
      .queueResponse({ device_code: 'dc', user_code: 'U', verification_uri: 'v', expires_in: 900, interval: 5 })
      .queueError(oauthErrorResponse('expired_token'))
    const auth = new DeviceCodeAuth(http, new MemoryLogger())
    const { deviceCode } = await auth.startDeviceCode()
    const events: string[] = []
    await expect(auth.poll(deviceCode, 1, (e) => events.push(e.type), new AbortController().signal)).rejects.toMatchObject({
      code: ErrorCodes.AUTH_DEVICE_CODE_EXPIRED
    })
    expect(events[events.length - 1]).toBe('expired')
  })

  it('slow_down → 加大轮询间隔后继续', async () => {
    const http = new FakeHttpClient()
      .queueResponse({ device_code: 'dc', user_code: 'U', verification_uri: 'v', expires_in: 900, interval: 5 })
      .queueError(oauthErrorResponse('slow_down'))
      .queueResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
    const auth = new DeviceCodeAuth(http, new MemoryLogger())
    const { deviceCode } = await auth.startDeviceCode()
    const tokens = await auth.poll(deviceCode, 1, () => undefined, new AbortController().signal)
    expect(tokens.accessToken).toBe('AT')
  })

  it('取消轮询 → AUTH_CANCELLED', async () => {
    const http = new FakeHttpClient()
      .queueResponse({ device_code: 'dc', user_code: 'U', verification_uri: 'v', expires_in: 900, interval: 5 })
      .queueError(oauthErrorResponse('authorization_pending'))
    const auth = new DeviceCodeAuth(http, new MemoryLogger())
    const { deviceCode } = await auth.startDeviceCode()
    const ac = new AbortController()
    const p = auth.poll(deviceCode, 10, () => undefined, ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: ErrorCodes.AUTH_CANCELLED })
  })

  it('invalid_grant（设备码已消费）→ 提示重新生成 + 日志记录真实错误码', async () => {
    const http = new FakeHttpClient()
      .queueResponse({ device_code: 'dc', user_code: 'U', verification_uri: 'v', expires_in: 900, interval: 5 })
      .queueError(oauthErrorResponse('invalid_grant'))
    const logger = new MemoryLogger()
    const auth = new DeviceCodeAuth(http, logger)
    const { deviceCode } = await auth.startDeviceCode()
    const events: { type: string; code?: string; message?: string }[] = []
    await expect(auth.poll(deviceCode, 1, (e) => events.push(e), new AbortController().signal)).rejects.toMatchObject({
      code: ErrorCodes.AUTH_DEVICE_CODE_EXPIRED
    })
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'invalid_grant' })
    expect((events[events.length - 1] as { message: string }).message).toContain('重新生成')
    expect(JSON.stringify(logger.entries)).toContain('invalid_grant')
  })

  it('网络抖动（network_error）→ 继续轮询直到成功', async () => {
    const http = new FakeHttpClient()
      .queueResponse({ device_code: 'dc', user_code: 'U', verification_uri: 'v', expires_in: 900, interval: 5 })
      .queueError(new Error('connect ECONNREFUSED')) // 无 response 字段 → network_error
      .queueResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
    const auth = new DeviceCodeAuth(http, new MemoryLogger())
    const { deviceCode } = await auth.startDeviceCode()
    const tokens = await auth.poll(deviceCode, 1, () => undefined, new AbortController().signal)
    expect(tokens.accessToken).toBe('AT')
  })
})

describe('refresh_token 续期', () => {
  it('invalid_grant → AUTH_INVALID_GRANT（回退设备码）', async () => {
    const http = new FakeHttpClient().queueError(oauthErrorResponse('invalid_grant'))
    const auth = new DeviceCodeAuth(http, new MemoryLogger())
    await expect(auth.refreshTokens('OLD')).rejects.toMatchObject({ code: ErrorCodes.AUTH_INVALID_GRANT })
    expect(http.calls[0].params.grant_type).toBe('refresh_token')
  })

  it('成功时新 token 返回（覆盖由 TokenStore 负责）', async () => {
    const http = new FakeHttpClient().queueResponse({ access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 3600 })
    const auth = new DeviceCodeAuth(http, new MemoryLogger())
    const tokens = await auth.refreshTokens('OLD_RT')
    expect(tokens.accessToken).toBe('NEW_AT')
    expect(tokens.refreshToken).toBe('NEW_RT')
  })
})

describe('AxiosHttpClient 形状', () => {
  it('存在 postForm 方法（网络调用不在此测试）', () => {
    expect(typeof new AxiosHttpClient().postForm).toBe('function')
  })
})
