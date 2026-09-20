/**
 * ImapMailProvider —— MailProvider 的 imapflow 实现（imapflow 的唯一落点）。
 * 只读三连（规范 §2 第 1 条）：
 * - SELECT 永远 readOnly；
 * - 取正文用 source 下载（imapflow 内部发 BODY.PEEK[]），永不标 \Seen；
 * - 本文件内禁止出现 STORE / COPY / MOVE / DELETE（有契约测试扫描兜底）。
 */
import { ImapFlow } from 'imapflow'
import { AppError, ErrorCodes } from '../../shared/error-codes'
import {
  FETCH_BODY_TIMEOUT_MS,
  IMAP_CONNECT_ATTEMPTS,
  IMAP_CONNECT_BACKOFF_MS,
  IMAP_CONNECT_TIMEOUT_MS,
  IMAP_GREETING_TIMEOUT_MS,
  IMAP_HOST,
  IMAP_KEEPALIVE_MAX_FAILURES,
  IMAP_KEEPALIVE_MS,
  IMAP_PORT,
  IMAP_SOCKET_TIMEOUT_MS
} from '../config'
import type { Logger } from '../logger'
import {
  type AttachmentPayload,
  type FetchBodyOptions,
  type MailboxInfo,
  type MailProvider,
  type MailProviderCapabilities,
  type OutgoingDraft,
  type RawMessageBody,
  type RawMessageMeta,
  unsupportedOperation
} from './provider'

export interface TokenGetter {
  (): Promise<{ user: string; accessToken: string }>
}

interface ImapFlowLike {
  /** 连接是否可用（imapflow 提供；断线后为 false） */
  usable?: boolean
  connect(): Promise<void>
  getMailboxLock(path: string): Promise<{ release(): void }>
  mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<{
    uidValidity: bigint | number
    exists: number
    uidNext: number
  }>
  list(): Promise<{ path: string; name: string; flags: Set<string> }[]>
  /** STATUS：始终向服务器查询，用于取到最新 uidNext/exists（mailboxOpen 命中缓存时会拿到过期值） */
  status?(path: string, query?: Record<string, boolean>): Promise<{
    messages?: number
    uidNext?: number
    uidValidity?: bigint | number
  }>
  /** UID SEARCH：返回 UID 数组（imapflow 支持 { uid: true } 选项；失败/未选中会返回 false） */
  search(query: unknown, opts?: unknown): Promise<number[] | false>
  /** 当前已选中的邮箱（未选中时 imapflow 给 false） */
  mailbox?: { path?: string; exists?: number } | false
  fetch(range: unknown, query: unknown, opts?: unknown): AsyncGenerator<{
    uid: number
    envelope?: {
      subject?: string
      from?: { name?: string; address?: string }[]
      date?: Date | string
      messageId?: string
    }
    flags: Set<string>
  }>
  fetchOne(seq: unknown, query: unknown, opts?: unknown): Promise<{
    uid: number
    source?: Buffer
    /** BODY.PEEK[part] 取回的分段内容（key = partId） */
    bodyParts?: Map<string, Buffer> | null
  } | null>
  /** 下载指定分段（附件）：imapflow 1.x 的推荐用法，meta 里有文件名/类型 */
  downloadMany?(
    range: unknown,
    parts: string[],
    opts?: { uid?: boolean }
  ): Promise<
    Record<
      string,
      {
        meta: { contentType?: string; filename?: string; disposition?: string; encoding?: string }
        content: Buffer | null
      }
    >
  >
  /** 保活用：NOOP（imapflow 支持；失败即视为连接不可用） */
  noop?(): Promise<boolean | void>
  /** 连接事件（close/error）：断线时我们要立刻知道，好在后台重连 */
  on?(event: string, cb: (...args: unknown[]) => void): void
  once?(event: string, cb: (...args: unknown[]) => void): void
  logout(): Promise<void>
  close(): Promise<void>
}

const NOT_FOUND_RE = /not found|no such|unknown|does not exist|no messages/i

/** 连接相关的时间参数（可注入，便于单测用毫秒级验证超时/重试） */
export interface ImapTimeouts {
  connectMs: number
  greetingMs: number
  socketMs: number
  attempts: number
  backoffMs: number[]
  keepAliveMs: number
  keepAliveMaxFailures: number
}

/** 小工具：等待若干毫秒（重试退避用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 单封取正文超时：兜底路径用 FETCH_BODY_TIMEOUT_MS，已确认存在的用 CONFIRMED_FETCH_TIMEOUT_MS（见 config.ts）。 */
const FETCH_ONE_TIMEOUT_MS = FETCH_BODY_TIMEOUT_MS

/** 附件下载超时：卡住时给用户明确提示，而不是无限等待 */
const ATTACHMENT_TIMEOUT_MS = 30_000

export class ImapMailProvider implements MailProvider {
  readonly capabilities: MailProviderCapabilities = { readOnly: true, send: false, move: false }

  private client: ImapFlowLike | null = null
  private lock: { release(): void } | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private keepAliveFailures = 0
  private timeouts: ImapTimeouts = {
    connectMs: IMAP_CONNECT_TIMEOUT_MS,
    greetingMs: IMAP_GREETING_TIMEOUT_MS,
    socketMs: IMAP_SOCKET_TIMEOUT_MS,
    attempts: IMAP_CONNECT_ATTEMPTS,
    backoffMs: IMAP_CONNECT_BACKOFF_MS,
    keepAliveMs: IMAP_KEEPALIVE_MS,
    keepAliveMaxFailures: IMAP_KEEPALIVE_MAX_FAILURES
  }
  private tokenGetter: TokenGetter
  private logger?: Logger
  private flowFactory?: (opts: Record<string, unknown>) => ImapFlowLike

  constructor(
    tokenGetter: TokenGetter,
    logger?: Logger,
    flowFactory?: (opts: Record<string, unknown>) => ImapFlowLike,
    /** 可注入的超时/重试参数（单测用毫秒级，生产用 config 里的常量） */
    timeouts?: Partial<ImapTimeouts>
  ) {
    this.tokenGetter = tokenGetter
    this.logger = logger
    this.flowFactory = flowFactory
    if (timeouts) this.timeouts = { ...this.timeouts, ...timeouts }
  }

  private createClient(accessToken: string, user: string): ImapFlowLike {
    if (this.flowFactory) {
      return this.flowFactory({ host: IMAP_HOST, port: IMAP_PORT, secure: true, accessToken, user })
    }
    // imapflow 的 auth.accessToken 会自动拼 XOAUTH2（\x01 分隔符由库处理，规范 §2 第 2 条）
    return new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user, accessToken },
      // 每个阶段都设硬上限：默认 connectionTimeout≈90s，网络半死时会挂满两分钟（真机踩过）
      connectionTimeout: this.timeouts.connectMs,
      greetingTimeout: this.timeouts.greetingMs,
      socketTimeout: this.timeouts.socketMs,
      logger: false // 关闭内部日志，避免打印敏感信息
    }) as unknown as ImapFlowLike
  }

  async connect(): Promise<void> {
    if (this.client) return
    const { user, accessToken } = await this.tokenGetter()
    let lastReason = ''
    for (let attempt = 1; attempt <= this.timeouts.attempts; attempt += 1) {
      const backoff = this.timeouts.backoffMs[Math.min(attempt - 1, this.timeouts.backoffMs.length - 1)] ?? 0
      if (backoff > 0) await sleep(backoff)
      const client = this.createClient(accessToken, user)
      const startedAt = Date.now()
      try {
        await this.connectWithTimeout(client)
        this.client = client
        this.attachLifecycle(client)
        this.logger?.info('imap.connected', { attempt, elapsedMs: Date.now() - startedAt })
        return
      } catch (e) {
        lastReason = e instanceof Error ? e.message : String(e)
        this.logger?.warn('imap.connect.attempt_failed', {
          attempt,
          of: this.timeouts.attempts,
          elapsedMs: Date.now() - startedAt,
          reason: lastReason
        })
        // 超时/失败的那条连接必须显式关掉，否则 socket 会一直挂着（真机表现为「同步卡死」）
        try {
          await client.close()
        } catch {
          /* ignore */
        }
      }
    }
    this.logger?.error('imap.connect.failed', { errorCode: 'IMAP_CONNECT_FAILED', reason: lastReason })
    throw new AppError(ErrorCodes.IMAP_CONNECT_FAILED, '无法连接邮箱服务器，请检查网络后重试。')
  }

  /**
   * 建连硬超时：即使库本身忽略了 connectionTimeout，这里也会在 15 秒后放弃并关掉这条连接。
   * 这是「不再出现 120 秒同步」的关键兜底。
   */
  private async connectWithTimeout(client: ImapFlowLike): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`connect timeout after ${this.timeouts.connectMs}ms`)), this.timeouts.connectMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 监听断线事件：立刻把 client 置空（下次同步会重新建连），并顺手停掉保活 */
  private attachLifecycle(client: ImapFlowLike): void {
    const drop = (event: string) => {
      if (this.client === client) {
        this.client = null
        this.lock = null
        this.logger?.warn('imap.dropped', { event })
      }
    }
    try {
      client.on?.('close', () => drop('close'))
      client.on?.('error', () => drop('error'))
      client.on?.('end', () => drop('end'))
    } catch {
      /* 假客户端（测试）可能没实现 on */
    }
  }

  /**
   * NOOP 保活：闲置的 IMAP 连接会被运营商/服务器悄悄掐断（日志里表现为每个周期都 imap.connected），
   * 断掉之后用户点同步就要重新握手，一旦网络抖动就卡两分钟。
   * 这里定期 NOOP：成功了连接就是热的；连续失败就主动关掉，让下一次同步走「新建连」而不是「用坏连接」。
   */
  startKeepAlive(): void {
    if (this.keepAliveTimer) return
    this.keepAliveTimer = setInterval(() => {
      void this.keepAliveOnce()
    }, this.timeouts.keepAliveMs)
    // 保活是后台任务，不应该拖住进程退出
    ;(this.keepAliveTimer as unknown as { unref?: () => void }).unref?.()
  }

  stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  /** 供测试直接调用：一次保活检查 */
  async keepAliveOnce(): Promise<'idle' | 'ok' | 'dropped'> {
    const client = this.client
    if (!client) return 'idle'
    if (client.usable === false) {
      await this.close().catch(() => undefined)
      return 'dropped'
    }
    if (typeof client.noop !== 'function') return 'ok'
    try {
      const ok = await client.noop()
      if (ok === false) throw new Error('noop returned false')
      this.keepAliveFailures = 0
      return 'ok'
    } catch (e) {
      this.keepAliveFailures += 1
      this.logger?.warn('imap.keepalive.failed', {
        failures: this.keepAliveFailures,
        reason: e instanceof Error ? e.message : String(e)
      })
      if (this.keepAliveFailures >= this.timeouts.keepAliveMaxFailures) {
        this.keepAliveFailures = 0
        await this.close().catch(() => undefined)
        this.logger?.info('imap.keepalive.recycled')
        return 'dropped'
      }
      return 'idle'
    }
  }

  /** 连接是否可用（界面/日志用） */
  isConnected(): boolean {
    return Boolean(this.client) && this.client?.usable !== false
  }

  async openInboxReadOnly(): Promise<MailboxInfo> {
    return this.openFolderReadOnly('INBOX')
  }

  async openFolderReadOnly(folderPath: string): Promise<MailboxInfo> {
    let client = await this.ensureConnected()
    try {
      return await this.openFolder(client, folderPath)
    } catch (e) {
      // 空闲断线导致首次打开失败：断开重连后重试一次
      this.logger?.warn('imap.open.retry', { errorCode: 'IMAP_CONNECT_FAILED' })
      await this.close().catch(() => undefined)
      client = await this.ensureConnected()
      try {
        return await this.openFolder(client, folderPath)
      } catch (e2) {
        this.logger?.error('imap.open.failed', { errorCode: 'IMAP_CONNECT_FAILED' })
        throw new AppError(ErrorCodes.IMAP_CONNECT_FAILED, `无法以只读方式打开文件夹 ${folderPath}。`)
      }
    }
  }

  async listFolders(): Promise<{ name: string; path: string }[]> {
    const client = await this.ensureConnected()
    const folders: { name: string; path: string }[] = []
    try {
      // imapflow v1 的 list() 返回 Promise<ListResponse[]>（不是异步迭代器）
      const items = await client.list()
      for (const item of items) {
        // \Noselect 容器目录不可打开，跳过
        if (item.flags.has('\\Noselect')) continue
        folders.push({ name: item.name || item.path, path: item.path })
      }
    } catch (e) {
      this.logger?.warn('imap.listFolders.failed', { reason: e instanceof Error ? e.message : String(e) })
    }
    return folders
  }

  private async openFolder(client: ImapFlowLike, folderPath: string): Promise<MailboxInfo> {
    const lock = await client.getMailboxLock(folderPath)
    try {
      const mailbox = await client.mailboxOpen(folderPath, { readOnly: true })
      this.lock = lock
      let exists = mailbox.exists
      let uidNext = mailbox.uidNext
      let uidValidity = Number(mailbox.uidValidity)
      // mailboxOpen 对「已打开的同一文件夹」会命中 imapflow 内部缓存（uidNext/exists 可能是旧值），
      // 会造成新邮件同步不进来。这里额外发一次 STATUS（只读）取实时值。
      try {
        if (typeof client.status === 'function') {
          const st = await client.status(folderPath, { messages: true, uidNext: true, uidValidity: true })
          if (st) {
            if (typeof st.messages === 'number') exists = st.messages
            if (typeof st.uidNext === 'number') uidNext = st.uidNext
            if (st.uidValidity !== undefined && st.uidValidity !== null) uidValidity = Number(st.uidValidity)
          }
        }
      } catch (e) {
        this.logger?.warn('imap.status.failed', { reason: e instanceof Error ? e.message : String(e) })
      }
      return { uidValidity, exists, uidNext }
    } catch (e) {
      lock.release()
      throw e
    }
  }

  private async ensureConnected(): Promise<ImapFlowLike> {
    if (!this.client || this.client.usable === false) {
      await this.close().catch(() => undefined)
      await this.connect()
    }
    return this.client as ImapFlowLike
  }

  /**
   * 服务端权威 UID 列表（UID SEARCH ALL）。
   * 注意：imapflow 在「邮箱未选中」或命令失败时会**静默返回 false**，
   * 这里必须抛错而不是当成「服务器没有邮件」——否则会误判成已同步完成。
   */
  async searchAllUids(folder: string): Promise<number[]> {
    const client = await this.ensureConnected()
    // SEARCH 要求邮箱处于 SELECTED 状态；断线重连后会丢失选中状态，这里补一次（幂等）
    const mb = client.mailbox
    const selected = mb && typeof mb === 'object' ? mb.path : undefined
    if (!selected || selected.toUpperCase() !== folder.toUpperCase()) {
      await client.mailboxOpen(folder, { readOnly: true })
    }
    const res = await client.search({ all: true }, { uid: true })
    if (!Array.isArray(res)) {
      throw new Error('UID SEARCH 未返回结果（邮箱未选中或服务器拒绝）')
    }
    const uids = res.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    this.logger?.info('imap.search.all', { folder, count: uids.length })
    return uids.sort((a, b) => a - b)
  }

  async *fetchEnvelopeRange(startUid: number, endUid: number): AsyncIterable<RawMessageMeta> {
    const client = await this.ensureConnected()
    for await (const msg of client.fetch(`${startUid}:${endUid}`, { uid: true, envelope: true, flags: true }, { uid: true })) {
      yield {
        uid: msg.uid,
        envelope: {
          subject: msg.envelope?.subject,
          from: msg.envelope?.from,
          date: msg.envelope?.date,
          messageId: msg.envelope?.messageId
        },
        flags: [...(msg.flags ?? [])]
      }
    }
  }

  async fetchBody(uid: number, opts: FetchBodyOptions = {}): Promise<RawMessageBody | null> {
    const client = await this.ensureConnected()
    try {
      return await this.fetchBodyOnce(client, uid, opts.timeoutMs ?? FETCH_ONE_TIMEOUT_MS)
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e)
      if (NOT_FOUND_RE.test(text)) return null
      // 网络断开：重连后重试一次
      this.logger?.warn('imap.fetch.retry', { uid })
      await this.close().catch(() => undefined)
      const fresh = await this.ensureConnected()
      try {
        return await this.fetchBodyOnce(fresh, uid, opts.timeoutMs ?? FETCH_ONE_TIMEOUT_MS)
      } catch (e2) {
        const text2 = e2 instanceof Error ? e2.message : String(e2)
        if (NOT_FOUND_RE.test(text2)) return null
        throw e2
      }
    }
  }

  private async fetchBodyOnce(client: ImapFlowLike, uid: number, timeoutMs: number): Promise<RawMessageBody | null> {
    // 超时保护：个别 UID 服务端不响应时，fetchOne 可能长时间挂起，拖死整次同步（真机回归）
    const msg = await Promise.race([
      client.fetchOne(`${uid}`, { uid: true, source: true }, { uid: true }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ])
    if (!msg || !msg.source) return null
    return { uid: msg.uid, raw: msg.source }
  }

  /**
   * 取附件内容（BODY.PEEK[part]，只读、不标已读）。
   *
   * 真机 bug（用户反馈「附件完全用不了」）：旧代码用的是 `msg.attachment(partId)`，
   * 那是 imapflow 旧版本的 API —— 1.x 的 FetchMessageObject 里根本没有这个方法，
   * 于是永远走到「附件不存在或已被删除」。现在按 1.x 的正确用法取：
   *   ① `downloadMany([uid], [partId], { uid: true })` —— 一步拿到 Buffer + meta（含文件名/类型）；
   *   ② 兜底 `fetchOne(..., { bodyParts: [partId] })` 读 `bodyParts` Map；
   *   ③ 再不行才报错，并明确提示「可能是服务器已删除该附件/分段号对不上」。
   */
  async fetchAttachment(uid: number, partId: string): Promise<AttachmentPayload> {
    const client = await this.ensureConnected()
    const timeoutMs = ATTACHMENT_TIMEOUT_MS
    const withTimeout = <T>(p: Promise<T>, fallback: T): Promise<T> =>
      Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))])

    if (typeof client.downloadMany === 'function') {
      const empty: Record<string, { meta: { contentType?: string; filename?: string }; content: Buffer | null }> = {}
      const res = await withTimeout(
        client.downloadMany(`${uid}`, [partId], { uid: true }).catch(() => empty),
        empty
      )
      const part = res[partId]
      if (part?.content && part.content.length > 0) {
        return {
          filename: part.meta?.filename ?? 'attachment',
          contentType: part.meta?.contentType ?? 'application/octet-stream',
          content: part.content
        }
      }
    }

    const msg = await withTimeout(
      client.fetchOne(`${uid}`, { uid: true, bodyParts: [partId] }, { uid: true }).catch(() => null),
      null
    )
    const buf = msg?.bodyParts?.get(partId)
    if (!buf || buf.length === 0) {
      throw new AppError(
        ErrorCodes.IMAP_TIMEOUT,
        '附件读取失败：服务器没有返回该分段。可能是邮件已被移动/删除，或分段号与服务器不一致——可点右上角「↻ 同步」重新同步该邮件后再试。'
      )
    }
    return { filename: 'attachment', contentType: 'application/octet-stream', content: buf }
  }

  async close(): Promise<void> {
    this.stopKeepAlive()
    if (this.lock) {
      try {
        this.lock.release()
      } catch {
        /* ignore */
      }
      this.lock = null
    }
    if (this.client) {
      try {
        await this.client.logout()
      } catch {
        /* ignore */
      }
      try {
        await this.client.close()
      } catch {
        /* ignore */
      }
      this.client = null
    }
  }

  async send(_draft: OutgoingDraft): Promise<void> {
    throw unsupportedOperation('发送邮件')
  }

  async move(_uid: number, _folder: string): Promise<void> {
    throw unsupportedOperation('移动/归档邮件')
  }
}
