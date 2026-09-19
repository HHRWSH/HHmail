/**
 * 稍后提醒调度器（V2 M6）：
 * - processDueSnoozes 为纯逻辑（可单测）：查出到期未通知的提醒 → 逐个发系统通知 → 标记 notified_at；
 * - startSnoozeScheduler 在主进程用 setInterval 周期调度（间隔复用设置的自动刷新周期，兜底 60s）。
 * 只依赖 MessageStore / Logger 接口，不 import Electron（通知回调由调用方注入）。
 */
import type { MessageStore } from '../db/store'
import type { Logger } from '../logger'
import { truncateSafe } from '../../shared/text'

export interface SnoozeNotifier {
  /** 发一条 Windows 通知（调用方注入 Electron Notification） */
  notify(title: string, body: string): void
}

export const SNOOZE_POLL_MIN_MS = 30_000
export const SNOOZE_POLL_MAX_MS = 300_000

export function buildSnoozeNotificationTitle(subject: string): string {
  return `⏰ 稍后提醒：${subject}`
}

export function buildSnoozeNotificationBody(fromName: string, note: string | null): string {
  const base = note && note.trim() ? `${note.trim()}（来自 ${fromName || '未知发件人'}）` : fromName || '您稍后提醒的邮件到时间了'
  return truncateSafe(base, 160)
}

export interface SnoozeSchedulerDeps {
  store: MessageStore
  logger: Logger
  notifier: SnoozeNotifier
}

/** 处理一轮到期提醒；返回已触发条数。单条通知失败不影响标记（store 异常仍上抛）。 */
export async function processDueSnoozes(deps: SnoozeSchedulerDeps, now: number): Promise<number> {
  const due = await deps.store.dueSnoozes(now)
  if (due.length === 0) return 0
  for (const s of due) {
    try {
      deps.notifier.notify(buildSnoozeNotificationTitle(s.subject), buildSnoozeNotificationBody(s.fromName, s.note))
    } catch (e) {
      deps.logger.error('snooze.notify.failed', { reason: e instanceof Error ? e.message : String(e) })
    }
    await deps.store.markSnoozeNotified(s.id)
  }
  deps.logger.info('snooze.notified', { count: due.length })
  return due.length
}

export interface SnoozeSchedulerHandle {
  stop(): void
}

/** 周期调度：intervalMs 钳制在 [30s, 5min]；立即先跑一轮（防上次退出遗留的到期提醒） */
export function startSnoozeScheduler(deps: SnoozeSchedulerDeps, intervalMs: number): SnoozeSchedulerHandle {
  const clamped = Math.min(Math.max(intervalMs, SNOOZE_POLL_MIN_MS), SNOOZE_POLL_MAX_MS)
  let stopped = false
  void processDueSnoozes(deps, Date.now()).catch((e) => {
    deps.logger.error('snooze.scan.failed', { reason: e instanceof Error ? e.message : String(e) })
  })
  const timer = setInterval(() => {
    if (stopped) return
    void processDueSnoozes(deps, Date.now()).catch((e) => {
      deps.logger.error('snooze.scan.failed', { reason: e instanceof Error ? e.message : String(e) })
    })
  }, clamped)
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    }
  }
}
