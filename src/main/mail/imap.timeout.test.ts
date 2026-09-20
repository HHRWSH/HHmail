/**
 * 真机修复回归：同步「卡两分钟 / 同步不上」的根因是**建连没有硬超时**。
 *
 * 证据（用户 app.log，一次没有任何新邮件的同步）：
 *   sync.auto.start → （120 秒无任何日志）→ imap.connected → 真正干活只有 2 秒
 * imapflow 默认 connectionTimeout≈90s，网络半死时这一次建连就挂满整个周期，
 * 调度器 120 秒看门狗才踢掉它 → 用户看到「一直同步中」。
 *
 * 这里用毫秒级注入参数验证三件事：
 *   ① 建连永不返回 → 会在 connectMs 内失败（不会挂住）；
 *   ② 首次失败/超时 → 自动重试，第二次成功即恢复；
 *   ③ NOOP 保活：连接变坏时主动回收，下次同步走新建连。
 */
import { describe, expect, it, vi } from 'vitest'
import { ImapMailProvider } from './imap'
import { MemoryLogger } from '../logger'

interface FakeClient {
  usable?: boolean
  connectFails?: number
  connectHangs?: boolean
  noopResult?: 'ok' | 'fail' | 'false'
  closed?: boolean
  noopCalls?: number
  handlers?: Record<string, Array<() => void>>
  connect(): Promise<void>
  getMailboxLock(path: string): Promise<{ release(): void }>
  mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<{ uidValidity: number; exists: number; uidNext: number }>
  list(): Promise<{ path: string; name: string; flags: Set<string> }[]>
  status?(): Promise<{ messages: number; uidNext: number; uidValidity: number }>
  search(): Promise<number[] | false>
  fetch(): AsyncGenerator<never>
  fetchOne(): Promise<null>
  noop(): Promise<boolean>
  on(event: string, cb: () => void): void
  logout(): Promise<void>
  close(): Promise<void>
}

function makeFakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  const client: FakeClient = {
    usable: true,
    closed: false,
    handlers: {},
    noopCalls: 0,
    async connect() {
      if (client.connectHangs) return new Promise<void>(() => undefined)
      if ((client.connectFails ?? 0) > 0) {
        client.connectFails = (client.connectFails ?? 0) - 1
        throw new Error('ECONNRESET')
      }
    },
    async getMailboxLock() {
      return { release: () => undefined }
    },
    async mailboxOpen() {
      return { uidValidity: 14, exists: 10, uidNext: 11 }
    },
    async list() {
      return []
    },
    async status() {
      return { messages: 10, uidNext: 11, uidValidity: 14 }
    },
    async search() {
      return [1, 2, 3]
    },
    // eslint-disable-next-line require-yield
    async *fetch() {
      return
    },
    async fetchOne() {
      return null
    },
    async noop() {
      client.noopCalls = (client.noopCalls ?? 0) + 1
      if (client.noopResult === 'fail') throw new Error('socket closed')
      if (client.noopResult === 'false') return false
      return true
    },
    on(event, cb) {
      ;(client.handlers ??= {})[event] = [...((client.handlers ?? {})[event] ?? []), cb]
    },
    async logout() {
      client.closed = true
    },
    async close() {
      client.closed = true
    },
    ...overrides
  }
  return client
}

const fastTimeouts = { connectMs: 60, greetingMs: 40, socketMs: 200, attempts: 3, backoffMs: [0, 5, 10], keepAliveMs: 10_000, keepAliveMaxFailures: 2 }

describe('IMAP 建连：硬超时 + 有限重试（真机「同步卡两分钟」回归）', () => {
  it('建连挂住 → 在 connectMs 量级失败，而不是无限等待', async () => {
    const logger = new MemoryLogger()
    const provider = new ImapMailProvider(
      async () => ({ user: 'me@example.edu', accessToken: 'tok' }),
      logger,
      () => makeFakeClient({ connectHangs: true }) as never,
      { ...fastTimeouts, attempts: 1 }
    )
    const started = Date.now()
    await expect(provider.connect()).rejects.toMatchObject({ code: 'IMAP_CONNECT_FAILED' })
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(1000) // 生产值 15s；测试注入 60ms，这里只验证「有上限」
    expect(provider.isConnected()).toBe(false)
    expect(logger.entries.some((e) => e.event === 'imap.connect.failed')).toBe(true)
  })

  it('首次失败 → 自动重试并成功（用户无感恢复）', async () => {
    const logger = new MemoryLogger()
    const clients: FakeClient[] = []
    const provider = new ImapMailProvider(
      async () => ({ user: 'me@example.edu', accessToken: 'tok' }),
      logger,
      () => {
        const c = makeFakeClient({ connectFails: clients.length === 0 ? 1 : 0 })
        clients.push(c)
        return c as never
      },
      fastTimeouts
    )
    await provider.connect()
    expect(clients).toHaveLength(2)
    expect(provider.isConnected()).toBe(true)
    expect(logger.entries.map((e) => e.event)).toContain('imap.connect.attempt_failed')
    expect(logger.entries.map((e) => e.event)).toContain('imap.connected')
    // 失败的那条连接必须被关掉，不能留着挂住 socket
    expect(clients[0].closed).toBe(true)
  })

  it('每次都失败 → 抛出 IMAP_CONNECT_FAILED（错误码不变，UI 提示不变）', async () => {
    const provider = new ImapMailProvider(
      async () => ({ user: 'me@example.edu', accessToken: 'tok' }),
      new MemoryLogger(),
      () => makeFakeClient({ connectFails: 99 }) as never,
      fastTimeouts
    )
    await expect(provider.connect()).rejects.toMatchObject({ code: 'IMAP_CONNECT_FAILED' })
  })
})

describe('IMAP 保活：坏连接主动回收（避免下一次同步踩到死连接）', () => {
  it('无连接时保活是空操作', async () => {
    const provider = new ImapMailProvider(
      async () => ({ user: 'me@example.edu', accessToken: 'tok' }),
      new MemoryLogger(),
      () => makeFakeClient() as never,
      fastTimeouts
    )
    expect(await provider.keepAliveOnce()).toBe('idle')
  })

  it('NOOP 正常 → 连接保持，不重连', async () => {
    const clients: FakeClient[] = []
    const provider = new ImapMailProvider(
      async () => ({ user: 'me@example.edu', accessToken: 'tok' }),
      new MemoryLogger(),
      () => {
        const c = makeFakeClient()
        clients.push(c)
        return c as never
      },
      fastTimeouts
    )
    await provider.connect()
    expect(await provider.keepAliveOnce()).toBe('ok')
    expect(clients[0].noopCalls).toBe(1)
    expect(clients).toHaveLength(1)
    expect(provider.isConnected()).toBe(true)
  })

  it('NOOP 连续失败到阈值 → 关掉连接（下次同步新建连）', async () => {
    const clients: FakeClient[] = []
    const logger = new MemoryLogger()
    const provider = new ImapMailProvider(
      async () => ({ user: 'me@example.edu', accessToken: 'tok' }),
      logger,
      () => {
        const c = makeFakeClient({ noopResult: 'fail' })
        clients.push(c)
        return c as never
      },
      fastTimeouts
    )
    await provider.connect()
    expect(await provider.keepAliveOnce()).toBe('idle') // 第 1 次失败：还给它一次机会
    expect(await provider.keepAliveOnce()).toBe('dropped') // 第 2 次失败：回收
    expect(provider.isConnected()).toBe(false)
    expect(clients[0].closed).toBe(true)
    expect(logger.entries.some((e) => e.event === 'imap.keepalive.recycled')).toBe(true)
  })

  it('usable=false（已断线）→ 立刻回收', async () => {
    const clients: FakeClient[] = []
    const provider = new ImapMailProvider(
      async () => ({ user: 'me@example.edu', accessToken: 'tok' }),
      new MemoryLogger(),
      () => {
        const c = makeFakeClient()
        clients.push(c)
        return c as never
      },
      fastTimeouts
    )
    await provider.connect()
    clients[0].usable = false
    expect(await provider.keepAliveOnce()).toBe('dropped')
    expect(provider.isConnected()).toBe(false)
  })

  it('收到 close 事件 → 立刻标记为未连接（下一次同步重新建连）', async () => {
    const clients: FakeClient[] = []
    const logger = new MemoryLogger()
    const provider = new ImapMailProvider(
      async () => ({ user: 'me@example.edu', accessToken: 'tok' }),
      logger,
      () => {
        const c = makeFakeClient()
        clients.push(c)
        return c as never
      },
      fastTimeouts
    )
    await provider.connect()
    expect(provider.isConnected()).toBe(true)
    clients[0].handlers?.close?.forEach((cb) => cb())
    expect(provider.isConnected()).toBe(false)
    expect(logger.entries.some((e) => e.event === 'imap.dropped')).toBe(true)
  })

  it('startKeepAlive/stopKeepAlive 幂等且不阻塞退出', async () => {
    const provider = new ImapMailProvider(
      async () => ({ user: 'me@example.edu', accessToken: 'tok' }),
      new MemoryLogger(),
      () => makeFakeClient() as never,
      fastTimeouts
    )
    const spy = vi.spyOn(globalThis, 'setInterval')
    provider.startKeepAlive()
    provider.startKeepAlive() // 第二次不应再注册
    expect(spy).toHaveBeenCalledTimes(1)
    provider.stopKeepAlive()
    provider.stopKeepAlive()
    spy.mockRestore()
  })
})
