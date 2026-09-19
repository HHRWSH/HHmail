import { describe, expect, it } from 'vitest'
import { AUTO_SYNC_RETRY_MS, AUTO_SYNC_STALL_MS, AUTO_SYNC_TICK_MS, createAutoSyncScheduler } from './autoSync'
import { MemoryLogger } from '../logger'

/** 可控时钟 + 可控定时器，验证调度逻辑而不依赖真实时间。 */
function makeHarness(opts: { intervalSec?: number; sync?: () => Promise<unknown>; afterSync?: () => Promise<void> } = {}) {
  let clock = 1_000_000
  const timers: Array<{ fn: () => void; ms: number; id: number; kind: 'interval' | 'timeout' }> = []
  let nextId = 1
  const syncCalls: string[] = []
  let stalls = 0
  const logger = new MemoryLogger()
  const scheduler = createAutoSyncScheduler({
    sync: async (reason) => {
      syncCalls.push(reason)
      if (opts.sync) await opts.sync()
    },
    intervalSec: async () => opts.intervalSec ?? 300,
    logger,
    onStall: () => {
      stalls += 1
    },
    afterSync: opts.afterSync,
    now: () => clock,
    setIntervalFn: (fn, ms) => {
      const id = nextId++
      timers.push({ fn, ms, id, kind: 'interval' })
      return id
    },
    clearIntervalFn: (h) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
    setTimeoutFn: (fn, ms) => {
      const id = nextId++
      timers.push({ fn, ms, id, kind: 'timeout' })
      return id
    },
    clearTimeoutFn: (h) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    }
  })
  const advance = (ms: number): void => {
    clock += ms
  }
  const fireTimeouts = (): void => {
    for (const t of [...timers].filter((x) => x.kind === 'timeout')) t.fn()
  }
  return { scheduler, syncCalls, logger, advance, fireTimeouts, timers, stallCount: () => stalls }
}

describe('后台自动同步调度（真机：休眠/最小化后不同步）', () => {
  it('启动后要等一个间隔才同步，之后每次到点同步一次', async () => {
    const h = makeHarness({ intervalSec: 300 })
    h.scheduler.start()
    await h.scheduler.tick() // 启动对齐：只登记下一次允许时刻
    expect(h.syncCalls).toHaveLength(0)
    h.advance(299_000)
    await h.scheduler.tick() // 还差一点
    expect(h.syncCalls).toHaveLength(0)
    h.advance(2_000)
    await h.scheduler.tick()
    expect(h.syncCalls).toEqual(['interval'])
    await h.scheduler.tick() // 刚同步完，间隔没到
    expect(h.syncCalls).toHaveLength(1)
    h.advance(301_000)
    await h.scheduler.tick()
    expect(h.syncCalls).toHaveLength(2)
    h.scheduler.stop()
  })

  it('间隔设为 0 = 关闭自动同步', async () => {
    const h = makeHarness({ intervalSec: 0 })
    h.scheduler.start()
    await h.scheduler.tick()
    h.advance(10 * 60_000)
    await h.scheduler.tick()
    expect(h.syncCalls).toHaveLength(0)
    h.scheduler.stop()
  })

  it('正在同步时心跳跳过，不并发（串行链不被并发调用打乱）', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const h = makeHarness({ intervalSec: 1, sync: () => gate })
    h.scheduler.start()
    await h.scheduler.tick() // 第一次心跳只做启动对齐
    h.advance(2_000)
    const first = h.scheduler.tick() // 进入同步并挂住
    await new Promise((r) => setTimeout(r, 0)) // 让 run() 走完 await（真实计时器，与假定时器无关）
    expect(h.scheduler.isRunning()).toBe(true)
    h.advance(10_000)
    await h.scheduler.tick() // 应跳过
    expect(h.syncCalls).toHaveLength(1)
    release()
    await first
    expect(h.scheduler.isRunning()).toBe(false)
    h.scheduler.stop()
  })

  it('同步失败不终止调度，并在 60 秒后提前重试', async () => {
    let fail = true
    const h = makeHarness({
      intervalSec: 300,
      sync: async () => {
        if (fail) throw new Error('IMAP_CONNECT_FAILED')
      }
    })
    h.scheduler.start()
    await h.scheduler.tick() // 启动对齐
    h.advance(301_000)
    await h.scheduler.tick()
    expect(h.syncCalls).toHaveLength(1)
    // 正常要等 300 秒；失败后只等 60 秒就重试
    h.advance(AUTO_SYNC_RETRY_MS + 1_000)
    await h.scheduler.tick()
    expect(h.syncCalls).toHaveLength(2)
    fail = false
    h.advance(AUTO_SYNC_RETRY_MS + 1_000)
    await h.scheduler.tick()
    expect(h.syncCalls).toHaveLength(3)
    expect(h.logger.entries.some((e) => e.event === 'sync.auto.failed')).toBe(true)
    h.scheduler.stop()
  })

  it('唤醒补偿：kick 无视间隔立刻同步（休眠/解锁后调用）', async () => {
    const h = makeHarness({ intervalSec: 300 })
    h.scheduler.start()
    await h.scheduler.kick('resume')
    expect(h.syncCalls).toEqual(['resume'])
    await h.scheduler.kick('unlock-screen')
    expect(h.syncCalls).toEqual(['resume', 'unlock-screen'])
    h.scheduler.stop()
  })

  it('同步卡死超过 2 分钟 → 触发 onStall（关连接让请求快速失败）', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const h = makeHarness({ intervalSec: 1, sync: () => gate })
    h.scheduler.start()
    await h.scheduler.tick() // 启动对齐
    h.advance(2_000)
    const running = h.scheduler.tick()
    await new Promise((r) => setTimeout(r, 0))
    h.fireTimeouts() // 触发看门狗
    expect(h.stallCount()).toBe(1)
    expect(h.logger.entries.some((e) => e.event === 'sync.auto.stall')).toBe(true)
    release()
    await running
    h.scheduler.stop()
  })

  it('stop 之后心跳与 kick 都不再同步', async () => {
    const h = makeHarness({ intervalSec: 1 })
    h.scheduler.start()
    h.scheduler.stop()
    h.advance(10 * 60_000)
    await h.scheduler.tick()
    await h.scheduler.kick('resume')
    expect(h.syncCalls).toHaveLength(0)
    expect(h.timers.filter((t) => t.kind === 'interval')).toHaveLength(0)
  })

  it('心跳间隔常量保持合理（20 秒检查、2 分钟判卡死）', () => {
    expect(AUTO_SYNC_TICK_MS).toBe(20_000)
    expect(AUTO_SYNC_STALL_MS).toBe(120_000)
  })
  it('陈旧自愈：超过 2 个间隔没成功同步 → 无视节流立刻补一次（休眠/托盘久置兜底）', async () => {
    const h = makeHarness({ intervalSec: 300 })
    h.scheduler.start()
    await h.scheduler.tick() // 启动对齐
    h.advance(301_000)
    await h.scheduler.tick() // 第一次成功同步
    expect(h.syncCalls).toHaveLength(1)
    h.advance(601_000) // 超过 2 个间隔（600s）都没有成功同步
    await h.scheduler.tick()
    expect(h.syncCalls).toHaveLength(2)
    expect(h.logger.entries.some((e) => e.event === 'sync.auto.stale')).toBe(true)
    h.scheduler.stop()
  })

  it('同步成功后执行 afterSync（自动补摘要），失败不影响同步计数', async () => {
    let after = 0
    const h = makeHarness({
      intervalSec: 300,
      afterSync: async () => {
        after += 1
        throw new Error('model failed')
      }
    })
    h.scheduler.start()
    await h.scheduler.tick()
    h.advance(301_000)
    await h.scheduler.tick()
    expect(h.syncCalls).toHaveLength(1)
    expect(after).toBe(1)
    expect(h.logger.entries.some((e) => e.event === 'sync.auto.after_failed')).toBe(true)
    h.scheduler.stop()
  })

  it('kickIfStale：刚同步过就不打扰，陈旧时才同步（窗口重新获得焦点用）', async () => {
    const h = makeHarness({ intervalSec: 300 })
    h.scheduler.start()
    await h.scheduler.tick()
    h.advance(301_000)
    await h.scheduler.tick()
    expect(h.syncCalls).toHaveLength(1)
    await h.scheduler.kickIfStale('focus') // 刚同步过 → 不重复同步
    expect(h.syncCalls).toHaveLength(1)
    h.advance(301_000)
    await h.scheduler.kickIfStale('focus') // 已陈旧 → 补一次
    expect(h.syncCalls).toHaveLength(2)
    expect(h.scheduler.lastSuccessAt()).toBeGreaterThan(0)
    h.scheduler.stop()
  })
})
