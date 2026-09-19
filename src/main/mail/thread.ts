/**
 * 本地线程聚合（规范 §6.5 第 6 条）——纯函数，无副作用。
 * 规则：
 * 1. references / inReplyTo / 自己的 message-id 命中已知 message-id → 归入同一 thread；
 * 2. 无引用时用「规范化主题 + 发件人」兜底匹配；
 * 3. 仍无匹配 → 自成一线程。
 */

export interface ThreadSeed {
  uid: number
  messageId: string | null
  references: string[]
  inReplyTo: string | null
  subject: string
  fromAddr: string
  dateTs: number
}

export interface ThreadIndexEntry {
  messageId: string | null
  threadId: string
  subject: string | null
  fromAddr: string
  dateTs: number
}

const SUBJECT_PREFIXES = /^(re|fwd|fw|回复|答复|转发|res|sv|aw|wg)(\s*\[[^\]]*\])?\s*[:：]\s*/i

/** 规范化主题：去 Re:/Fwd:/回复:/转发: 前缀（可多层），trim，折叠空白。 */
export function normalizeSubject(subject: string): string {
  let s = (subject || '').trim()
  let changed = true
  while (changed) {
    const before = s
    s = s.replace(SUBJECT_PREFIXES, '').trim()
    changed = s !== before
  }
  return s.replace(/\s+/g, ' ')
}

function normalizeAddr(addr: string): string {
  return (addr || '').trim().toLowerCase()
}

export function newThreadId(uid: number): string {
  return `t-${uid}`
}

/**
 * 给 incoming 分配 threadId。
 * - existingIndex：库中已有消息的 thread 索引（messageId→threadId 等）；
 * - 同批 incoming 之间也会互相归并（按 dateTs 升序处理，先来先建索引）。
 */
export function assignThreadIds(incoming: ThreadSeed[], existingIndex: ThreadIndexEntry[] = []): Map<number, string> {
  const result = new Map<number, string>()
  const byMessageId = new Map<string, string>()
  // subject+from → threadId（保最近的 entry，用于兜底）
  const bySubjectFrom = new Map<string, { threadId: string; dateTs: number }>()
  const bySubject = new Map<string, { threadId: string; dateTs: number }>()

  const addEntry = (entry: ThreadIndexEntry): void => {
    if (entry.messageId) byMessageId.set(entry.messageId, entry.threadId)
    const subj = entry.subject ? normalizeSubject(entry.subject) : ''
    if (!subj) return
    const from = normalizeAddr(entry.fromAddr)
    const key = `${subj}\u0000${from}`
    const prev = bySubjectFrom.get(key)
    if (!prev || entry.dateTs >= prev.dateTs) bySubjectFrom.set(key, { threadId: entry.threadId, dateTs: entry.dateTs })
    const prevS = bySubject.get(subj)
    if (!prevS || entry.dateTs >= prevS.dateTs) bySubject.set(subj, { threadId: entry.threadId, dateTs: entry.dateTs })
  }

  for (const e of existingIndex) addEntry(e)

  const sorted = [...incoming].sort((a, b) => a.dateTs - b.dateTs)
  for (const msg of sorted) {
    let threadId: string | null = null

    // 1) 引用链匹配
    const candidateIds: (string | null)[] = [...msg.references, msg.inReplyTo, msg.messageId]
    for (const id of candidateIds) {
      if (!id) continue
      const hit = byMessageId.get(id)
      if (hit) {
        threadId = hit
        break
      }
    }

    // 2) 规范化主题 + 发件人兜底
    if (!threadId) {
      const subj = normalizeSubject(msg.subject)
      if (subj) {
        const from = normalizeAddr(msg.fromAddr)
        const sf = bySubjectFrom.get(`${subj}\u0000${from}`)
        if (sf) {
          threadId = sf.threadId
        } else {
          const s = bySubject.get(subj)
          if (s) threadId = s.threadId
        }
      }
    }

    // 3) 自成一线程
    if (!threadId) threadId = newThreadId(msg.uid)

    result.set(msg.uid, threadId)
    addEntry({
      messageId: msg.messageId,
      threadId,
      subject: msg.subject,
      fromAddr: msg.fromAddr,
      dateTs: msg.dateTs
    })
  }
  return result
}
