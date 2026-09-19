/**
 * UIDVALIDITY / UID 增量同步状态机（规范 §6.4）。
 * - 只依赖 MailProvider / MessageStore 接口，不 import imapflow / better-sqlite3；
 * - 失败批次不推进 lastUid，下次重试。
 */
import { AppError, ErrorCodes } from '../../shared/error-codes'
import type { SyncProgress } from '../../shared/types'
import { SYNC_CHUNK_SIZE } from '../config'
import type { Logger } from '../logger'
import type { MailboxInfo, MailProvider } from './provider'
import { CONFIRMED_FETCH_TIMEOUT_MS } from '../config'
import type { ParsedMessage } from './types'
import { assignThreadIds, type ThreadIndexEntry } from './thread'
import type { MessageStore } from '../db/store'

export interface SyncState {
  uidValidity: number
  lastUid: number
  /** 是否已完成过「全部历史」全量同步（老数据升级后为 false，触发重新全量回扫）。 */
  fullHistory?: boolean
}

export type SyncMode = 'full' | 'incremental' | 'uptodate'

export interface SyncPlan {
  mode: SyncMode
  uids: number[]
}

/**
 * 纯函数状态机：
 * - state 为空 / uidValidity 不一致 → 全量；
 * - window <= 0（同步全部历史）且从未完成过全量（fullHistory=false，含老版本升级）→ 从 UID 1 全量；
 * - window > 0 → 全量窗口（最近 window 封）或 lastUid+1..uidNext-1 增量；
 * - 没有新 UID → uptodate。
 */
export function computeSyncPlan(state: SyncState | null, mailbox: MailboxInfo, window: number): SyncPlan {
  const end = mailbox.uidNext - 1
  const needsFull =
    !state ||
    state.uidValidity !== mailbox.uidValidity ||
    (window <= 0 && !state.fullHistory)
  if (needsFull) {
    if (end <= 0) return { mode: 'full', uids: [] }
    const start = window > 0 ? Math.max(1, mailbox.uidNext - window) : 1
    const uids: number[] = []
    for (let u = start; u <= end; u++) uids.push(u)
    return { mode: 'full', uids }
  }
  if (state.lastUid >= end) return { mode: 'uptodate', uids: [] }
  const uids: number[] = []
  for (let u = state.lastUid + 1; u <= end; u++) uids.push(u)
  return { mode: 'incremental', uids }
}

export interface SyncEngineDeps {
  provider: MailProvider
  store: MessageStore
  parse: (raw: Buffer, uid: number, flags: string[]) => Promise<ParsedMessage>
  logger: Logger
  /** 默认同步范围；run() 的 windowOverride 优先（0 = 全部历史）。 */
  syncWindow?: number
}

export class SyncEngine {
  private deps: SyncEngineDeps
  /** 同步串行化链（见 run 注释） */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(deps: SyncEngineDeps) {
    this.deps = deps
  }

  /**
   * 串行化入口：多个调用方（渲染端启动同步 / 文件夹切换 / 自动刷新 / 修复同步）
   * 不能并发跑同一 provider——并发时后一次 connect/openFolder 会让前一次的
   * fetch 全部落空，表现为「同步完成但一封都没进来」（真机回归）。
   */
  async run(
    progress?: (p: SyncProgress) => void,
    windowOverride?: number,
    folders: string[] = ['INBOX']
  ): Promise<{ synced: number; mode: SyncMode; durationMs: number; newUids: number[]; folders: string[] }> {
    const execute = (): ReturnType<SyncEngine['runOnce']> => this.runOnce(progress, windowOverride, folders)
    const next = this.chain.then(execute, execute)
    this.chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async runOnce(
    progress?: (p: SyncProgress) => void,
    windowOverride?: number,
    folders: string[] = ['INBOX']
  ): Promise<{ synced: number; mode: SyncMode; durationMs: number; newUids: number[]; folders: string[] }> {
    const { provider, logger } = this.deps
    const window = windowOverride ?? this.deps.syncWindow ?? 0
    const startedAt = Date.now()

    progress?.({ phase: 'connecting', done: 0, total: 0 })
    try {
      await provider.connect()
    } catch (e) {
      // 透传真实错误码（AUTH_INVALID_GRANT / AUTH_REQUIRED / IMAP_CONNECT_FAILED），
      // 让 UI 能提示「登录已失效」并引导重新登录，而不是一律伪装成网络错误
      const code = e instanceof AppError ? e.code : ErrorCodes.IMAP_CONNECT_FAILED
      logger.error('sync.connect.failed', { errorCode: code })
      if (e instanceof AppError) throw e
      throw new AppError(ErrorCodes.IMAP_CONNECT_FAILED, '无法连接邮箱服务器，请检查网络后重试。')
    }

    // 多文件夹（V2 M3）：每个文件夹独立 UIDVALIDITY/UID 状态
    const targetFolders = folders.length > 0 ? folders : ['INBOX']
    let syncedTotal = 0
    let skippedTotal = 0
    const newUidsAll: number[] = []
    const modes: SyncMode[] = []

    for (const folder of targetFolders) {
      const result = await this.syncFolder(folder, window, progress)
      syncedTotal += result.synced
      skippedTotal += result.skipped
      newUidsAll.push(...result.newUids)
      modes.push(result.mode)
    }

    const mode: SyncMode = modes.includes('full') ? 'full' : modes.includes('incremental') ? 'incremental' : 'uptodate'
    const durationMs = Date.now() - startedAt
    logger.metric('sync.duration', durationMs, { mode, synced: syncedTotal, skipped: skippedTotal })
    logger.info('sync.done', { mode, synced: syncedTotal, skipped: skippedTotal, durationMs })
    progress?.({ phase: 'done', done: 1, total: 1 })
    return { synced: syncedTotal, mode, durationMs, newUids: newUidsAll, folders: targetFolders }
  }

  private async syncFolder(
    folder: string,
    window: number,
    progress?: (p: SyncProgress) => void
  ): Promise<{ synced: number; skipped: number; mode: SyncMode; newUids: number[] }> {
    const { provider, store, parse, logger } = this.deps

    let mailbox: MailboxInfo
    try {
      mailbox = folder === 'INBOX' ? await provider.openInboxReadOnly() : await provider.openFolderReadOnly(folder)
    } catch (e) {
      logger.error('sync.open.failed', { errorCode: 'IMAP_CONNECT_FAILED' })
      // 释放连接，下次同步从全新连接开始（防断线残留）
      await provider.close().catch(() => undefined)
      throw new AppError(ErrorCodes.IMAP_CONNECT_FAILED, `无法以只读方式打开文件夹 ${folder}。`)
    }

    const state = await store.getSyncState(folder)
    const plan = computeSyncPlan(state, mailbox, window)
    logger.info('sync.plan', {
      mode: plan.mode,
      total: plan.uids.length,
      uidRange: plan.uids.length ? `${plan.uids[0]}:${plan.uids[plan.uids.length - 1]}` : undefined
    })
    // 服务器侧真实状态（排查「收不到新邮件」的关键信息：uidNext 是否推进、本地游标是否越过）
    logger.info('sync.mailbox', {
      folder,
      uidValidity: mailbox.uidValidity,
      exists: mailbox.exists,
      uidNext: mailbox.uidNext,
      lastUid: state?.lastUid ?? 0
    })

    if (plan.mode === 'full' && state && state.uidValidity !== mailbox.uidValidity) {
      // UIDVALIDITY 变化：历史已失效，按全量窗口重同步（规范 §2 第 5 条）
      logger.warn('sync.uidvalidity.changed', { errorCode: 'SYNC_UIDVALIDITY_CHANGED' })
    }

    let synced = 0
    let skipped = 0
    let missing = 0
    /** envelope 确认存在、但正文取不到的 UID（游标不越过它，下次继续重试） */
    let lowestUnavailable: number | null = null
    let newUids: number[] = []
    // 「全部历史」模式下 lastUid 从头累计；窗口模式下沿用旧 lastUid 做增量
    let lastUid =
      state && state.uidValidity === mailbox.uidValidity && plan.mode !== 'full' ? state.lastUid : 0
    const fullHistoryDone = window <= 0
    const persistProgress = async (): Promise<void> => {
      // 「全部历史」模式只有完整跑完才标记完成；窗口模式可持久化部分进度做断点续传
      await store
        .setSyncState({ uidValidity: mailbox.uidValidity, lastUid, fullHistory: fullHistoryDone ? true : state?.fullHistory, folder })
        .catch(() => undefined)
    }

    // ① 权威对账（UID SEARCH ALL ↔ 本地 UID 集合）：以服务端真实 UID 列表为准，
    //    而不是「游标 +1 .. uidNext-1」的猜测。这样即使游标曾经越过真实邮件
    //    （真机回归：服务器 exists=167、uidNext=2158，本地只有 165 封、maxUid=2144、
    //    游标已到 2148），缺失的邮件也会自动补回来；也顺带避免了逐个 fetch 不存在的 UID。
    let targetUids = plan.uids
    let reconciled = false
    let envelopeConfirmed = false
    const alive = new Set<number>()
    try {
      const serverUids = await provider.searchAllUids(folder)
      const localUids = new Set(await store.listUids(folder))
      // 同步窗口（最近 N 封）：只处理窗口内的服务端 UID
      const inWindow = window > 0 && serverUids.length > window ? new Set(serverUids.slice(-window)) : null
      const missingUids = serverUids.filter((u) => !localUids.has(u) && (!inWindow || inWindow.has(u)))
      for (const u of serverUids) alive.add(u)
      targetUids = missingUids
      reconciled = true
      envelopeConfirmed = true
      const planSet = new Set(plan.uids)
      skipped += Math.max(0, plan.uids.length - missingUids.filter((u) => planSet.has(u)).length)
      logger.info('sync.reconcile', {
        folder,
        server: serverUids.length,
        local: localUids.size,
        missing: missingUids.length,
        windowed: inWindow !== null
      })
    } catch (e) {
      logger.warn('sync.reconcile.failed', { reason: e instanceof Error ? e.message : String(e) })
    }

    if (!reconciled && plan.uids.length > 0) {
      // ② 兜底：envelope 扫描（单个 FETCH，秒级）确认区间内真实存在的 UID：
      //    服务端已删除的 UID 逐个 fetchOne 会长时间无响应，导致整次同步卡死（真机回归）。
      try {
        const rangeStart = plan.uids[0]
        const rangeEnd = plan.uids[plan.uids.length - 1]
        for await (const meta of provider.fetchEnvelopeRange(rangeStart, rangeEnd)) {
          if (meta.uid >= rangeStart && meta.uid <= rangeEnd) alive.add(meta.uid)
        }
        envelopeConfirmed = true
        const before = plan.uids.length
        targetUids = plan.uids.filter((u) => alive.has(u))
        const gone = before - targetUids.length
        if (gone > 0) {
          skipped += gone
          logger.info('sync.envelope.skipped', { count: gone, alive: targetUids.length })
        }
      } catch (e) {
        // 扫描失败：退回逐个拉取（保持旧行为）
        logger.warn('sync.envelope.failed', { reason: e instanceof Error ? e.message : String(e) })
      }
    }

    // 对账后的实际模式：全量仍是全量；否则「有缺就增量、无缺就 up-to-date」
    const mode: SyncMode = plan.mode === 'full' ? 'full' : targetUids.length > 0 ? 'incremental' : 'uptodate'
    const planPhase: SyncProgress['phase'] = mode === 'uptodate' ? 'done' : mode

    if (targetUids.length === 0 && reconciled) {
      // 对账成功且没有缺失 → 游标推进到服务端最新，避免下次重复计算
      const serverMax = alive.size > 0 ? Math.max(...alive) : 0
      if (serverMax > lastUid) lastUid = serverMax
      await persistProgress()
    }

    if (targetUids.length > 0) {
      progress?.({ phase: mode === 'full' ? 'full' : 'incremental', done: 0, total: targetUids.length })
      // 线程索引只在整个同步过程中加载一次，并在本地增量维护（提速关键）
      let threadIndex: ThreadIndexEntry[] = await store.getThreadIndex()
      // 分块（每批 SYNC_CHUNK_SIZE 封批量入库，避免逐封开事务）
      for (let i = 0; i < targetUids.length; i += SYNC_CHUNK_SIZE) {
        const chunk = targetUids.slice(i, i + SYNC_CHUNK_SIZE)
        const batch: ParsedMessage[] = []
        const flushBatch = async (): Promise<void> => {
          if (batch.length === 0) return
          const threadMap = assignThreadIds(batch, threadIndex)
          const incoming = batch.map((m) => ({
            ...m,
            threadId: threadMap.get(m.uid) ?? `t-${m.uid}`,
            folder
          }))
          await store.upsertMessages(incoming)
          threadIndex = [
            ...threadIndex,
            ...incoming.map((m) => ({
              messageId: m.messageId,
              threadId: m.threadId,
              subject: m.subject,
              fromAddr: m.fromAddr,
              dateTs: m.dateTs
            }))
          ]
          batch.length = 0
        }
        for (const uid of chunk) {
          let body
          try {
            body = await provider.fetchBody(uid, envelopeConfirmed ? { timeoutMs: CONFIRMED_FETCH_TIMEOUT_MS } : undefined)
          } catch (e) {
            // 取信失败：失败批次不推进；先把本批已解析的落库，再按模式持久化断点
            logger.error('sync.fetch.failed', { uid, errorCode: 'SYNC_FAILED' })
            await flushBatch().catch(() => undefined)
            if (window > 0 && lastUid > 0) await persistProgress()
            throw new AppError(ErrorCodes.SYNC_FAILED, '同步失败：拉取邮件超时，请重试。')
          }
          if (!body && alive.has(uid)) {
            // envelope 已确认这封存在 → 取不到只能是取信链路问题：重试一次
            logger.warn('sync.body.retry', { uid })
            body = await provider.fetchBody(uid, { timeoutMs: CONFIRMED_FETCH_TIMEOUT_MS }).catch(() => null)
            if (!body) {
              logger.error('sync.body.unavailable', { uid })
              lowestUnavailable = lowestUnavailable === null ? uid : Math.min(lowestUnavailable, uid)
            }
          }
          if (!body) {
            // uid 取不到（服务端已删除，或服务器无响应）→ 跳过。
            missing += 1
            skipped += 1
            if (missing <= 5) logger.warn('sync.body.missing.uid', { uid })
            lastUid = uid
            progress?.({ phase: planPhase, done: i + chunk.indexOf(uid) + 1, total: targetUids.length })
            continue
          }
          let parsed: ParsedMessage
          try {
            parsed = await parse(body.raw, uid, [])
          } catch (e) {
            // 个别邮件格式异常：跳过继续（否则整批同步被卡死，后面邮件都同步不了）
            logger.warn('sync.parse.skipped', { uid, reason: e instanceof Error ? e.message : String(e) })
            skipped += 1
            lastUid = uid
            progress?.({ phase: planPhase, done: i + chunk.indexOf(uid) + 1, total: targetUids.length })
            continue
          }
          batch.push(parsed)
          lastUid = uid
          synced += 1
          if (mode === 'incremental') newUids.push(uid)
          progress?.({ phase: planPhase, done: i + chunk.indexOf(uid) + 1, total: targetUids.length })
        }
        await flushBatch()
      }
      if (envelopeConfirmed) {
        // UID 集合已确认（envelope 扫描或 UID SEARCH ALL 对账）→ 游标可推进到服务端最新；
        // 但若有个别「确实存在却取不到正文」的邮件，游标停在它之前，下次同步继续补
        const planEnd = alive.size > 0 ? Math.max(...alive) : plan.uids[plan.uids.length - 1]
        if (lowestUnavailable !== null) {
          // 有「确实存在却取不到正文」的邮件：游标回退到它之前，下次同步继续补
          lastUid = Math.min(lastUid, Math.max(plan.uids[0] - 1, lowestUnavailable - 1))
        } else {
          lastUid = Math.max(lastUid, planEnd)
        }
      }
      if (missing > 0) {
        // 汇总一条即可（全量首次同步时服务端已删除的历史 UID 可能很多，避免刷日志）
        logger.warn('sync.body.missing', { count: missing, folder })
      }
      await store.setSyncState({
        uidValidity: mailbox.uidValidity,
        lastUid,
        fullHistory: fullHistoryDone ? true : state?.fullHistory,
        folder
      })
    } else if (!state || (window <= 0 && !state.fullHistory)) {
      // 空邮箱也要落状态，避免每次都走全量
      await store.setSyncState({
        uidValidity: mailbox.uidValidity,
        lastUid: mailbox.uidNext - 1,
        fullHistory: fullHistoryDone ? true : state?.fullHistory,
        folder
      })
    }

    return { synced, skipped, mode, newUids }
  }
}

export type { ThreadIndexEntry }
