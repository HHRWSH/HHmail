import { describe, expect, it } from 'vitest'
import { DefaultAuthService } from './service'
import { DeviceCodeAuth } from './deviceCode'
import { SafeStorageTokenStore } from './tokenStore'
import { ErrorCodes } from '../../shared/error-codes'
import { FakeAccountRepository, FakeHttpClient, FakeSafeStorage } from '../../../tests/helpers/fakes'
import { MemoryLogger } from '../logger'
import type { DeviceCodeEvent } from '../../shared/types'

function makeService() {
  const repo = new FakeAccountRepository()
  const store = new SafeStorageTokenStore(new FakeSafeStorage(), repo, new MemoryLogger())
  const device = new DeviceCodeAuth(new FakeHttpClient(), new MemoryLogger())
  const events: DeviceCodeEvent[] = []
  const svc = new DefaultAuthService({
    deviceCodeAuth: device,
    tokenStore: store,
    logger: new MemoryLogger(),
    emit: (e) => events.push(e)
  })
  return { svc, store, events }
}

describe('DefaultAuthService —— 无 refresh_token 的降级路径（契约测试）', () => {
  it('refresh：无 refresh_token → 清空 token + AUTH_INVALID_GRANT + 推送重登事件', async () => {
    const { svc, store, events } = makeService()
    await store.save(
      { accessToken: 'AT', refreshToken: '', expiresAtMs: Date.now() + 3600_000, obtainedAtMs: 0, scope: 's' },
      'me@link.example.edu'
    )
    await expect(svc.refresh()).rejects.toMatchObject({ code: ErrorCodes.AUTH_INVALID_GRANT })
    expect(await store.load()).toBeNull()
    expect(events.some((e) => e.type === 'error' && e.code === ErrorCodes.AUTH_INVALID_GRANT)).toBe(true)
  })

  it('ensureValidToken：access 过期且无 refresh → 回退重登', async () => {
    const { svc, store } = makeService()
    await store.save(
      { accessToken: 'AT', refreshToken: '', expiresAtMs: Date.now() - 1000, obtainedAtMs: 0, scope: 's' },
      'me@link.example.edu'
    )
    await expect(svc.ensureValidToken()).rejects.toMatchObject({ code: ErrorCodes.AUTH_INVALID_GRANT })
    expect(await store.load()).toBeNull()
  })

  it('ensureValidToken：未过期直接返回（即使没有 refresh_token）', async () => {
    const { svc, store } = makeService()
    await store.save(
      { accessToken: 'AT', refreshToken: '', expiresAtMs: Date.now() + 3600_000, obtainedAtMs: 0, scope: 's' },
      'me@link.example.edu'
    )
    const result = await svc.ensureValidToken()
    expect(result.user).toBe('me@link.example.edu')
    expect(result.accessToken).toBe('AT')
  })

  it('未登录 → AUTH_REQUIRED', async () => {
    const { svc } = makeService()
    await expect(svc.ensureValidToken()).rejects.toMatchObject({ code: ErrorCodes.AUTH_REQUIRED })
  })
})
