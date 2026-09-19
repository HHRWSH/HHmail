/**
 * 后台自动同步调度（V2.2 真机修复：休眠/最小化后长时间不同步、甚至同步不上）。
 *
 * 旧实现的问题（真机反馈「电脑休眠后邮箱长时间不同步 / 同步不上」）：
 *   ① 定时器在**渲染进程**里：窗口隐藏到托盘/最小化后 Chromium 会节流后台页面的定时器，
 *      间隔被拉长到分钟级甚至暂停；休眠期间更是完全不走；
 *   ② 唤醒后没有任何补偿：既不会立刻同步，也不会把休眠期间已经断掉的 IMAP 连接丢掉重连；
 *   ③ 同步一旦卡在半死连接上会一直挂住（串行链后面的同步全被堵住），用户看到的
 *      就是「一直同步中 / 同步不上」。
 *
 * 这个调度器把「何时同步」搬到主进程：定时检查（与窗口是否可见无关）+ 唤醒/解锁立即补偿 +
 * 卡死看门狗（超时就关连接让同步快速失败，下一次重新连）。逻辑与 Electron 解耦，便于单测。
 */
import type { Logger } from '../logger'

export interface AutoSyncDeps {
  /** 执行一次同步（SyncEngine.run 内部已串行化，可安全重复调用） */
  sync: (reason: string) => Promise<unknown>
  /** 读取「自动刷新间隔（秒）」；0 = 关闭 */
  intervalSec: () => Promise<number>
  logger?: Logger
  /** 同步疑似卡死时调用（一般实现为：关掉 IMAP 连接，让挂住的请求立刻失败） */
  onStall?: () => void
  /** 同步成功后的收尾（例如：自动补摘要）。失败不影响同步本身。 */
  afterSync?: (reason: string) => Promise<void>
  /** 注入时钟/定时器（单测用） */
  now?: () => number
  setIntervalFn?: (fn: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

export interface AutoSyncScheduler {
  start(): void
  stop(): void
  /** 立即同步一次（唤醒 / 解锁 / 用户手动），不受间隔限制 */
  kick(reason: string): Promise<void>
  /** 只有「已经陈旧」（超过一个间隔没成功同步）时才同步；用于窗口重新获得焦点 */
  kickIfStale(reason: string): Promise<void>
  /** 上次成功同步的时刻（0 = 还没成功过） */
  lastSuccessAt(): number
  /** 心跳检查（导出便于单测） */
  tick(): Promise<void>
  /** 是否正在同步 */
  isRunning(): boolean
}

/** 心跳间隔：20 秒检查一次，足够及时又不费资源 */
export const AUTO_SYNC_TICK_MS = 20_000
/** 同步失败后多久重试（比正常间隔更短，尽快恢复） */
export const AUTO_SYNC_RETRY_MS = 60_000
/** 单次同步超过这个时间视为卡死 → 触发 onStall（关连接） */
export const AUTO_SYNC_STALL_MS = 120_000

export function createAutoSyncScheduler(deps: AutoSyncDeps): AutoSyncScheduler {
  const now = deps.now ?? ((): number => Date.now())
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let timer: unknown = null
  let busy = false
  let stopped = true
  let lastStartedAt = 0
  /** 下一次允许同步的时刻（失败后会更早重试） */
  let nextAllowedAt = 0
  /** 启动后先等满一个间隔再自动同步（进入收件箱那次同步由渲染端触发，不必抢） */
  let bootstrapped = false
  /** 上次成功同步时刻：用于「陈旧自愈」（休眠/托盘久置后即使没收到唤醒事件也能补上） */
  let lastSuccess = 0

  async function intervalMs(): Promise<number> {
    try {
      const sec = await deps.intervalSec()
      return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0
    } catch {
      return 0
    }
  }

  async function run(reason: string): Promise<void> {
    if (busy) {
      deps.logger?.info('sync.auto.skip', { reason, why: 'busy' })
      return
    }
    // 先占坑再 await：否则两个心跳可能都通过 busy 检查后才各自 await 设置，造成并发同步
    busy = true
    const interval = await intervalMs()
    if (interval <= 0 && reason === 'interval') {
      busy = false
      return
    }
    lastStartedAt = now()
    nextAllowedAt = lastStartedAt + interval
    const startedAt = now()
    let stalled = false
    const watchdog = setTimeoutFn(() => {
      stalled = true
      deps.logger?.warn('sync.auto.stall', { reason, elapsedMs: now() - startedAt })
      try {
        deps.onStall?.()
      } catch {
        /* ignore */
      }
    }, AUTO_SYNC_STALL_MS)
    deps.logger?.info('sync.auto.start', { reason })
    try {
      await deps.sync(reason)
      lastSuccess = now()
      const elapsed = now() - startedAt
      deps.logger?.info('sync.auto.done', { reason, elapsedMs: elapsed })
      deps.logger?.metric('sync.auto.duration', elapsed, { reason })
      // 同步成功后的收尾（自动补摘要等）：失败只记日志，不影响同步
      if (deps.afterSync) {
        try {
          await deps.afterSync(reason)
        } catch (e2) {
          deps.logger?.warn('sync.auto.after_failed', { reason, message: e2 instanceof Error ? e2.message : String(e2) })
        }
      }
    } catch (e) {
      // 失败不终止调度：下一次提前 60 秒重试，避免「一次断网就再也不自动同步」
      nextAllowedAt = now() + AUTO_SYNC_RETRY_MS
      deps.logger?.warn('sync.auto.failed', { reason, message: e instanceof Error ? e.message : String(e) })
    } finally {
      clearTimeoutFn(watchdog)
      busy = false
      if (stalled) deps.logger?.info('sync.auto.stall_recovered', { reason })
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return
    if (busy) {
      deps.logger?.info('sync.auto.skip', { why: 'busy' })
      return
    }
    const interval = await intervalMs()
    if (interval <= 0) return // 关闭自动刷新
    if (!bootstrapped) {
      bootstrapped = true
      nextAllowedAt = now() + interval
      return
    }
    // 陈旧自愈：超过 2 个间隔都没成功同步（休眠/托盘久置/漏掉唤醒事件）→ 无视节流立刻补一次
    const stale = lastSuccess > 0 && now() - lastSuccess > interval * 2
    if (stale) {
      deps.logger?.info('sync.auto.stale', { sinceMs: now() - lastSuccess })
      await run('stale')
      return
    }
    if (now() < nextAllowedAt) return
    await run('interval')
  }

  return {
    start(): void {
      if (!stopped) return
      stopped = false
      bootstrapped = false
      nextAllowedAt = now()
      timer = setIntervalFn(() => void tick(), AUTO_SYNC_TICK_MS)
      deps.logger?.info('sync.auto.started', { tickMs: AUTO_SYNC_TICK_MS })
    },
    stop(): void {
      stopped = true
      if (timer !== null) {
        clearIntervalFn(timer)
        timer = null
      }
    },
    async kick(reason: string): Promise<void> {
      if (stopped) return
      await run(reason)
    },
    async kickIfStale(reason: string): Promise<void> {
      if (stopped || busy) return
      const interval = await intervalMs()
      if (interval <= 0) return
      if (lastSuccess > 0 && now() - lastSuccess < interval) return
      await run(reason)
    },
    lastSuccessAt: () => lastSuccess,
    tick,
    isRunning: () => busy
  }
}
