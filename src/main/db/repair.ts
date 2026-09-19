/**
 * 数据清洗修复：早期版本把 HTML 邮件的 text 部分（含 <style> 的 CSS）当成正文入库，
 * 导致 AI 总结看到的是 CSS 代码（真机回归：26 封邮件受影响）。
 * 这里在启动时对存量数据做一次性清洗（只改正文与摘要片段，同步维护 FTS）。
 */
import type { MessageStore } from './store'
import type { Logger } from '../logger'
import { cleanMailText, truncateSafe } from '../../shared/text'

/** 生成列表摘要片段（与解析层保持一致的极简策略） */
export function makeRepairSnippet(text: string, maxChars = 120): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return truncateSafe(s, maxChars)
}

export async function repairNoisyBodies(store: MessageStore, logger: Logger, limit = 300): Promise<number> {
  let fixed = 0
  try {
    const rows = await store.listNoisyBodies(limit)
    for (const row of rows) {
      const cleaned = cleanMailText(row.bodyText, row.bodyHtml)
      if (!cleaned || cleaned === row.bodyText) continue
      await store.updateBodyText(row.id, cleaned, makeRepairSnippet(cleaned))
      fixed += 1
    }
    if (fixed > 0) logger.info('db.repair.bodies', { count: fixed })
  } catch (e) {
    logger.warn('db.repair.failed', { reason: e instanceof Error ? e.message : String(e) })
  }
  return fixed
}
