/**
 * 发信附件的公共约束与纯函数（渲染层 UI 与单测共用）。
 *
 * 为什么放在 shared：主进程 zod（ipc-schemas.ts）、主进程文件选择器（ipc.ts）、
 * 渲染层 Composer 都要用同一套上限，写三份必然漂移。这里只放「纯数据规则」，不碰 fs/electron。
 */
import type { MailAttachmentPayload } from './types'

/** 单个附件上限：15MB */
export const MAX_ATTACH_BYTES = 15 * 1024 * 1024
/** 附件合计上限：20MB */
export const MAX_ATTACH_TOTAL_BYTES = 20 * 1024 * 1024
/** 附件数量上限 */
export const MAX_ATTACH_COUNT = 10

/** 附件大小的人类可读文案（B / KB / MB） */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 合并新选的附件并做上限校验（纯函数）。
 * 规则：同名同大小视为重复（跳过）；数量 >10、单文件 >15MB、合计 >20MB 时停止添加并返回中文错误。
 * 返回值里的 `list` 是**已经接受的部分**（不是全部丢弃），符合"尽量加上能加的"的直觉。
 */
export function mergeAttachments(
  prev: MailAttachmentPayload[],
  picked: MailAttachmentPayload[]
): { list: MailAttachmentPayload[]; error: string | null } {
  const list = [...prev]
  for (const a of picked) {
    if (list.some((x) => x.filename === a.filename && x.size === a.size)) continue
    if (list.length >= MAX_ATTACH_COUNT) return { list, error: `一次最多 ${MAX_ATTACH_COUNT} 个附件` }
    if (a.size > MAX_ATTACH_BYTES) return { list, error: `「${a.filename}」超过 15MB` }
    const total = [...list, a].reduce((n, x) => n + x.size, 0)
    if (total > MAX_ATTACH_TOTAL_BYTES) return { list, error: '附件合计超过 20MB' }
    list.push(a)
  }
  return { list, error: null }
}

/** 附件总大小 */
export function totalAttachmentBytes(list: MailAttachmentPayload[]): number {
  return list.reduce((n, a) => n + a.size, 0)
}
