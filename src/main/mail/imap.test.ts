import { describe, expect, it } from 'vitest'
import { ImapMailProvider } from './imap'
import { AppError } from '../../shared/error-codes'
import { MemoryLogger } from '../logger'

/** 极简 imapflow fake：可编程 mailboxOpen / fetchOne 行为，验证重连逻辑。 */
interface FakeClient {
  usable?: boolean
  connectCount: number
  openFails: number
  openCalls: number
  fetchFails: number
  fetchCalls: number
  closed: boolean
  openedPaths: string[]
  connect(): Promise<void>
  getMailboxLock(path: string): Promise<{ release(): void }>
  mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<{ uidValidity: bigint; exists: number; uidNext: number }>
  list(): Promise<{ path: string; name: string; flags: Set<string> }[]>
  fetch(range: unknown, query: unknown, opts?: unknown): AsyncGenerator<never>
  fetchOne(
    seq: unknown,
    query: unknown,
    opts?: unknown
  ): Promise<{ uid: number; source?: Buffer; bodyParts?: Map<string, Buffer> } | null>
  /** imapflow 1.x 的附件下载 API（旧代码误用了不存在的 msg.attachment()，真机附件全挂） */
  downloadMany?(
    range: unknown,
    parts: string[],
    opts?: { uid?: boolean }
  ): Promise<Record<string, { meta: { contentType?: string; filename?: string }; content: Buffer | null }>>
  logout(): Promise<void>
  close(): Promise<void>
}

function makeFakeClient(): FakeClient {
  const c: FakeClient = {
    usable: true,
    connectCount: 0,
    openFails: 0,
    openCalls: 0,
    fetchFails: 0,
    fetchCalls: 0,
    closed: false,
    openedPaths: [],
    async connect() {
      c.connectCount += 1
      c.usable = true
      c.closed = false
    },
    async getMailboxLock() {
      return { release: () => undefined }
    },
    async mailboxOpen(path, opts) {
      c.openCalls += 1
      c.openedPaths.push(path)
      if (c.openFails > 0) {
        c.openFails -= 1
        throw new Error('Mailbox is not available (connection lost)')
      }
      // 只读约束被守护测试覆盖；这里确认 readOnly 参数透传
      expect(opts?.readOnly).toBe(true)
      return { uidValidity: 7n, exists: 2, uidNext: 103 }
    },
    // imapflow v1 的 list() 返回 Promise<ListResponse[]>（真实契约，2025-09 真机回归修复）
    async list() {
      return [
        { path: 'INBOX', name: 'INBOX', flags: new Set() },
        { path: 'Sent', name: 'Sent', flags: new Set() },
        { path: '[Gmail]', name: '[Gmail]', flags: new Set(['\\Noselect']) }
      ]
    },
    async *fetch() {
      // unused in these tests
    },
    async fetchOne(seq) {
      c.fetchCalls += 1
      if (c.fetchFails > 0) {
        c.fetchFails -= 1
        throw new Error('socket closed')
      }
      return { uid: Number(String(seq).split(':')[0]), source: Buffer.from('raw') }
    },
    // 附件：默认走 downloadMany（真实 imapflow 1.x 的行为）
    async downloadMany(_range, parts) {
      const out: Record<string, { meta: { contentType?: string; filename?: string }; content: Buffer | null }> = {}
      for (const part of parts) out[part] = { meta: { contentType: 'application/pdf', filename: 'report.pdf' }, content: Buffer.from(`bytes-${part}`) }
      return out
    },
    async logout() {
      /* noop */
    },
    async close() {
      c.closed = true
      c.usable = false
    }
  }
  return c
}

function makeProvider(create: () => FakeClient) {
  const clients: FakeClient[] = []
  const provider = new ImapMailProvider(
    async () => ({ user: 'me@link.example.edu', accessToken: 'tok' }),
    undefined,
    () => {
      const c = create()
      clients.push(c)
      return c as never
    }
  )
  return { provider, clients }
}

describe('ImapMailProvider —— 断线重连（同步失败「无法以只读方式打开收件箱」的修复）', () => {
  it('openInboxReadOnly 首次失败 → 断开重连后重试成功', async () => {
    const { provider, clients } = makeProvider(() => {
      const c = makeFakeClient()
      if (clients.length === 0) c.openFails = 1 // 第一个连接（旧连接）打开失败
      return c
    })
    const mailbox = await provider.openInboxReadOnly()
    expect(mailbox.uidNext).toBe(103)
    expect(clients).toHaveLength(2) // 重连产生了新客户端
    expect(clients[0].closed).toBe(true)
  })

  it('usable=false 的旧连接被丢弃并重连', async () => {
    const { provider, clients } = makeProvider(() => makeFakeClient())
    await provider.connect()
    clients[0].usable = false // 模拟空闲断线
    await provider.openInboxReadOnly()
    expect(clients).toHaveLength(2)
  })

  it('fetchBody 网络断开 → 重连重试一次成功', async () => {
    const { provider, clients } = makeProvider(() => {
      const c = makeFakeClient()
      if (clients.length === 0) c.fetchFails = 1
      return c
    })
    const body = await provider.fetchBody(101)
    expect(body?.uid).toBe(101)
    expect(clients).toHaveLength(2)
    expect(clients[1].fetchCalls).toBe(1)
  })

  it('fetchBody 消息不存在 → 返回 null 且不重连', async () => {
    const { provider, clients } = makeProvider(() => makeFakeClient())
    await provider.connect()
    clients[0].fetchOne = async () => {
      throw new Error('Message not found')
    }
    const body = await provider.fetchBody(999)
    expect(body).toBeNull()
    expect(clients).toHaveLength(1)
  })

  it('重连后仍失败 → 抛出 IMAP_CONNECT_FAILED', async () => {
    const { provider } = makeProvider(() => {
      const c = makeFakeClient()
      c.openFails = 99
      return c
    })
    await expect(provider.openInboxReadOnly()).rejects.toBeInstanceOf(AppError)
  })

  it('connect 失败：日志记录脱敏后的真实原因（便于定位）', async () => {
    const logger = new MemoryLogger()
    const provider = new ImapMailProvider(
      async () => ({ user: 'me@link.example.edu', accessToken: 'tok' }),
      logger,
      () => {
        const c = makeFakeClient()
        c.connect = async () => {
          throw new Error('ECONNRESET socket closed')
        }
        return c as unknown as never
      }
    )
    await expect(provider.connect()).rejects.toMatchObject({ code: 'IMAP_CONNECT_FAILED' })
    const entry = logger.entries.find((e) => e.event === 'imap.connect.failed')
    expect(entry?.extra?.reason).toBe('ECONNRESET socket closed')
  })

  it('listFolders 解析 LIST 结果并跳过 \\Noselect（V2 M3）', async () => {
    const { provider } = makeProvider(() => makeFakeClient())
    const folders = await provider.listFolders()
    expect(folders.map((f) => f.path)).toEqual(['INBOX', 'Sent'])
    expect(folders.map((f) => f.path)).not.toContain('[Gmail]')
  })

  it('openFolderReadOnly 以 readOnly 打开非 INBOX 文件夹（V2 M3）', async () => {
    const { provider, clients } = makeProvider(() => makeFakeClient())
    const mailbox = await provider.openFolderReadOnly('Sent')
    expect(mailbox.uidNext).toBe(103)
    expect(clients[0].openedPaths[0]).toBe('Sent')
  })
})

describe('ImapMailProvider —— 附件下载（真机 bug：附件完全用不了）', () => {
  it('走 imapflow 1.x 的 downloadMany：拿到内容与文件名/类型', async () => {
    const { provider } = makeProvider(() => makeFakeClient())
    const att = await provider.fetchAttachment(101, '2')
    expect(att.content.toString()).toBe('bytes-2')
    expect(att.filename).toBe('report.pdf')
    expect(att.contentType).toBe('application/pdf')
  })

  it('回归：客户端没有旧的 msg.attachment() 方法时也必须成功（旧代码正是死在这里）', async () => {
    const { provider } = makeProvider(() => {
      const c = makeFakeClient()
      // 真机 imapflow 1.x 的 FetchMessageObject 没有 attachment() 方法
      expect('attachment' in (c as unknown as Record<string, unknown>)).toBe(false)
      return c
    })
    const att = await provider.fetchAttachment(202, '1')
    expect(att.content.length).toBeGreaterThan(0)
  })

  it('downloadMany 不可用（老版本客户端）→ 退回 fetchOne 的 bodyParts Map', async () => {
    const { provider } = makeProvider(() => {
      const c = makeFakeClient()
      delete (c as { downloadMany?: unknown }).downloadMany
      c.fetchOne = async (_seq, query) => {
        const want = (query as { bodyParts?: string[] }).bodyParts?.[0] ?? '1'
        return { uid: 303, bodyParts: new Map([[want, Buffer.from('from-bodyparts')]]) }
      }
      return c
    })
    const att = await provider.fetchAttachment(303, '1.2')
    expect(att.content.toString()).toBe('from-bodyparts')
    expect(att.contentType).toBe('application/octet-stream') // 该路径没有 meta，由上层用本地元信息补
  })

  it('两条路都拿不到内容 → 明确的错误提示（不再是模糊的「附件不存在」）', async () => {
    const { provider } = makeProvider(() => {
      const c = makeFakeClient()
      delete (c as { downloadMany?: unknown }).downloadMany
      c.fetchOne = async () => ({ uid: 404, bodyParts: new Map() })
      return c
    })
    await expect(provider.fetchAttachment(404, '9')).rejects.toMatchObject({ code: 'IMAP_TIMEOUT' })
    await expect(provider.fetchAttachment(404, '9')).rejects.toThrow(/服务器没有返回该分段/)
  })
})
