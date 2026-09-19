import { describe, expect, it } from 'vitest'
import {
  computeExpiresAt,
  decodeJwtPayload,
  encodeB64,
  decodeB64,
  extractEmailFromTokens,
  isTokenExpired,
  pickAccountEmail,
  SafeStorageTokenStore,
  type OAuthTokens
} from './tokenStore'
import { FakeAccountRepository, FakeSafeStorage } from '../../../tests/helpers/fakes'
import { MemoryLogger } from '../logger'

function makeJwt(payload: Record<string, unknown>): string {
  const enc = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `h.${enc}.sig`
}

describe('JWT payload 解码与邮箱兜底（规范 §6.1）', () => {
  it('解码 payload', () => {
    const payload = decodeJwtPayload(makeJwt({ upn: 'me@link.example.edu' }))
    expect(payload?.upn).toBe('me@link.example.edu')
  })

  it('非法 token 返回 null', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull()
    expect(decodeJwtPayload('')).toBeNull()
    expect(decodeJwtPayload('a.b')).toBeNull()
  })

  it('兜底顺序：upn → unique_name → email → preferred_username', () => {
    expect(pickAccountEmail({ upn: 'a@example.edu', email: 'b@example.edu' })).toBe('a@example.edu')
    expect(pickAccountEmail({ unique_name: 'b@example.edu', email: 'c@example.edu' })).toBe('b@example.edu')
    expect(pickAccountEmail({ email: 'c@example.edu' })).toBe('c@example.edu')
    expect(pickAccountEmail({ preferred_username: 'd@example.edu' })).toBe('d@example.edu')
    expect(pickAccountEmail({})).toBeNull()
    expect(pickAccountEmail({ upn: 'no-at-sign' })).toBeNull()
  })

  it('extractEmailFromTokens 先 id_token 后 access_token', () => {
    const tokens: OAuthTokens = {
      accessToken: makeJwt({ upn: 'from-access@example.edu' }),
      refreshToken: 'r',
      idToken: makeJwt({ preferred_username: 'from-id@example.edu' }),
      expiresAtMs: Date.now() + 100000,
      obtainedAtMs: Date.now(),
      scope: 's'
    }
    expect(extractEmailFromTokens(tokens)).toBe('from-id@example.edu')
    const noId: OAuthTokens = { ...tokens, idToken: null }
    expect(extractEmailFromTokens(noId)).toBe('from-access@example.edu')
  })
})

describe('过期计算', () => {
  it('expires_in 转绝对时间；临近过期视为过期', () => {
    const at = computeExpiresAt(3600, 1_000_000)
    expect(at).toBe(1_000_000 + 3600_000)
    expect(isTokenExpired({ expiresAtMs: 2_000_000 } as OAuthTokens, 60_000, 1_950_000)).toBe(true)
    expect(isTokenExpired({ expiresAtMs: 2_000_000 } as OAuthTokens, 60_000, 1_900_000)).toBe(false)
  })
})

describe('base64 工具', () => {
  it('往返一致', () => {
    const buf = Buffer.from('你好 world')
    expect(decodeB64(encodeB64(buf)).toString('utf8')).toBe('你好 world')
  })
})

describe('SafeStorageTokenStore（DPAPI 落盘，规范 §2 第 4 条）', () => {
  function makeStore() {
    const safe = new FakeSafeStorage()
    const repo = new FakeAccountRepository()
    const store = new SafeStorageTokenStore(safe, repo, new MemoryLogger())
    return { safe, repo, store }
  }

  it('保存时明文经加密后才落盘（不出现明文）', async () => {
    const { safe, repo, store } = makeStore()
    await store.save(
      {
        accessToken: 'SUPER-SECRET-AT',
        refreshToken: 'SUPER-SECRET-RT',
        expiresAtMs: Date.now() + 3600_000,
        obtainedAtMs: Date.now(),
        scope: 's'
      },
      'me@link.example.edu'
    )
    expect(repo.record).not.toBeNull()
    const dumped = JSON.stringify(repo.record)
    expect(dumped).not.toContain('SUPER-SECRET-AT')
    expect(dumped).not.toContain('SUPER-SECRET-RT')
    expect(safe.encrypted.length).toBe(2)
  })

  it('load 解密还原；refresh 后 save 覆盖旧值', async () => {
    const { repo, store } = makeStore()
    await store.save(
      { accessToken: 'AT1', refreshToken: 'RT1', expiresAtMs: Date.now() + 1000, obtainedAtMs: 0, scope: 's' },
      'me@link.example.edu'
    )
    const first = await store.load()
    expect(first?.tokens.accessToken).toBe('AT1')

    await store.save(
      { accessToken: 'AT2', refreshToken: 'RT2', expiresAtMs: Date.now() + 2000, obtainedAtMs: 0, scope: 's' },
      'me@link.example.edu'
    )
    const second = await store.load()
    expect(second?.tokens.accessToken).toBe('AT2')
    expect(second?.tokens.refreshToken).toBe('RT2')
    expect(repo.record?.refreshTokenEnc).not.toContain('RT1')
  })

  it('无记录 → null；clear 清空', async () => {
    const { repo, store } = makeStore()
    expect(await store.load()).toBeNull()
    await store.save(
      { accessToken: 'AT', refreshToken: 'RT', expiresAtMs: 1, obtainedAtMs: 0, scope: 's' },
      'me@link.example.edu'
    )
    await store.clear()
    expect(repo.record).toBeNull()
  })

  it('解密失败（损坏数据）→ 清空并返回 null，不抛异常', async () => {
    const safe = new FakeSafeStorage()
    const repo = new FakeAccountRepository()
    repo.record = {
      email: 'me@link.example.edu',
      refreshTokenEnc: encodeB64(Buffer.from('corrupt')),
      accessTokenEnc: encodeB64(Buffer.from('corrupt')),
      accessTokenExpiresAtMs: 1
    }
    const store = new SafeStorageTokenStore(safe, repo, new MemoryLogger())
    expect(await store.load()).toBeNull()
    expect(repo.record).toBeNull()
  })

  it('refreshToken 为空串（设备码流缺 refresh_token）也能保存/读取', async () => {
    const { repo, store } = makeStore()
    await store.save(
      { accessToken: 'AT', refreshToken: '', expiresAtMs: Date.now() + 100_000, obtainedAtMs: 0, scope: 's' },
      'me@link.example.edu'
    )
    const loaded = await store.load()
    expect(loaded?.tokens.accessToken).toBe('AT')
    expect(loaded?.tokens.refreshToken).toBe('')
    expect(repo.record).not.toBeNull()
  })

  it('DPAPI 不可用 → 拒绝保存（ENCRYPTION_UNAVAILABLE）', async () => {
    const safe = new FakeSafeStorage()
    safe.available = false
    const store = new SafeStorageTokenStore(safe, new FakeAccountRepository(), new MemoryLogger())
    await expect(
      store.save({ accessToken: 'AT', refreshToken: 'RT', expiresAtMs: 1, obtainedAtMs: 0, scope: 's' }, 'x@example.edu')
    ).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' })
  })
})
