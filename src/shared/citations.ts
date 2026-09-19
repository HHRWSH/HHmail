/**
 * 回答里的邮件引用（纯函数，可单测）。
 *
 * 用户反馈：AI 回答底下贴了一堆「检索命中」，反而找不到真正相关的那几封；
 * 希望能「点回答里的邮件名直接跳过去」。
 *
 * 这里负责两件事：
 *   ① `normalizeForMatch`：把主题/回答归一化（去掉空白与标点、统一小写）后做子串匹配；
 *   ② `linkifyCitations`：把回答里出现的邮件主题替换成 `[主题](#mail-<id>)` 锚点，
 *      渲染端拦截点击就能跳回收件箱对应邮件（markdown 渲染器只放行 http(s) 与 #mail-）。
 */

export interface CitationLike {
  id: number
  subject: string
}

/** 归一化：去空白、去常见标点、转小写（只用于匹配，不改原文本）。 */
export function normalizeForMatch(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？…—–\-·|/\\()（）[\]【】"'“”‘’*#>]/g, '')
}

/** 在回答里找该主题最合适的匹配片段（找不到返回 null）。 */
export function findSubjectMention(answer: string, subject: string): string | null {
  const raw = String(subject ?? '').trim()
  if (raw.length < 4) return null
  // 先试完整主题，再试前 16 字（模型常截断长主题）
  for (const probe of [raw, raw.slice(0, 16), raw.slice(0, 10)]) {
    if (probe.length >= 4 && answer.includes(probe)) return probe
  }
  // 归一化后再试一次（回答里可能把标点/空格换了写法）
  const normAnswer = normalizeForMatch(answer)
  const normSubject = normalizeForMatch(raw)
  const head = normSubject.slice(0, 12)
  if (head.length >= 6 && normAnswer.includes(head)) {
    // 归一化能匹配到，但原文定位不到 → 用归一化片段在原文里找最长公共前缀
    const chars = [...raw]
    for (let len = Math.min(chars.length, 16); len >= 6; len -= 1) {
      const piece = chars.slice(0, len).join('')
      if (answer.includes(piece)) return piece
    }
  }
  return null
}

/**
 * 把回答里提到的邮件主题变成可点链接（`#mail-<id>`）。
 * 只替换第一次出现，且跳过已经是链接的位置，避免把回答改花。
 */
export function linkifyCitations<T extends CitationLike>(markdown: string, citations: T[]): string {
  let out = String(markdown ?? '')
  for (const c of citations ?? []) {
    const mention = findSubjectMention(out, c.subject)
    if (!mention) continue
    const idx = out.indexOf(mention)
    if (idx < 0) continue
    const before = out.slice(Math.max(0, idx - 3), idx)
    const after = out.slice(idx + mention.length, idx + mention.length + 3)
    // 已经在链接文字里（前面是 `](` 或 `[`，后面是 `](`）就跳过
    if (before.endsWith('](') || before.endsWith('[') || after.startsWith('](')) continue
    out = `${out.slice(0, idx)}[${mention}](#mail-${c.id})${out.slice(idx + mention.length)}`
  }
  return out
}

/** 从点击事件的目标里解析出邮件 id（渲染端用；非 #mail- 链接返回 null）。 */
export function mailIdFromHref(href: string | null | undefined): number | null {
  const m = /#mail-(\d+)$/.exec(String(href ?? ''))
  if (!m) return null
  const id = Number.parseInt(m[1], 10)
  return Number.isFinite(id) && id > 0 ? id : null
}
