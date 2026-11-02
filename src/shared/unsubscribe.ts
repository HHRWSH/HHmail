/**
 * 一键退订（List-Unsubscribe，V2.3）—— 纯函数部分：解析、分类、安全校验。
 *
 * 安全底线（硬约束）：
 *   - **只允许 https: 与 mailto:**；http:、javascript:、data:、file: 等一律拒绝（防钓鱼/防本地文件读取）；
 *   - 永不"跟随邮件里的任意链接"：只能使用 `List-Unsubscribe` 头里声明的地址；
 *   - 只做「发一个退订请求」这一件事，不改服务端邮件，不自动执行（必须用户二次确认）。
 */

export interface UnsubscribeInfo {
  /** 类型的优先级：一键 POST > https GET > mailto > 无 */
  kind: 'one-click' | 'https-get' | 'mailto' | 'none'
  /** https 地址（one-click / https-get 时存在） */
  url?: string
  /** mailto 地址 + 参数（mailto 时存在） */
  mailto?: { to: string; subject?: string; body?: string }
  /** 给出不可用原因（界面提示用；kind='none' 时） */
  reason?: string
}

/** 从邮件头原文里取出所有 `<...>` 形式的退订地址 */
export function parseListUnsubscribe(raw: string | null | undefined): string[] {
  const text = String(raw ?? '').trim()
  if (!text) return []
  const out: string[] = []
  for (const m of text.matchAll(/<([^>]*)>/g)) {
    const v = m[1].trim()
    if (v) out.push(v)
  }
  // 也兼容没有尖括号的裸地址（部分发件方不按 RFC 写）
  if (out.length === 0) {
    for (const part of text.split(',')) {
      const v = part.trim()
      if (v) out.push(v)
    }
  }
  return out
}

/** 只允许 https 与 mailto（其余协议一律拒绝） */
export function isAllowedUnsubscribeTarget(target: string): boolean {
  const t = String(target ?? '').trim()
  if (!t) return false
  try {
    const u = new URL(t)
    return u.protocol === 'https:' || u.protocol === 'mailto:'
  } catch {
    // mailto 里带 query 的极端写法（URL 解析失败时退回正则严格判断）
    return /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+(\?.*)?$/i.test(t)
  }
}

/** 解析 mailto: 里的 to/subject/body */
export function parseMailto(target: string): { to: string; subject?: string; body?: string } | null {
  const t = String(target ?? '').trim()
  if (!/^mailto:/i.test(t)) return null
  const rest = t.slice('mailto:'.length)
  const [addrPart, queryPart] = rest.split('?')
  const to = decodeURIComponent((addrPart ?? '').replace(/^\/\//, '')).split(',')[0]?.trim()
  if (!to || !to.includes('@')) return null
  const params = new URLSearchParams(queryPart ?? '')
  const subject = params.get('subject') ?? undefined
  const body = params.get('body') ?? undefined
  return { to, subject, body }
}

/**
 * 把 `List-Unsubscribe` / `List-Unsubscribe-Post` 头解析成可执行方案。
 * 优先级（RFC 8058）：https + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` → one-click POST；
 * 否则 https GET；否则 mailto；都不合法 → none（带原因，界面只展示不可点）。
 */
export function parseUnsubscribe(headers: {
  listUnsubscribe?: string | null
  listUnsubscribePost?: string | null
}): UnsubscribeInfo {
  const targets = parseListUnsubscribe(headers.listUnsubscribe)
  if (targets.length === 0) return { kind: 'none', reason: '这封邮件没有提供退订方式' }
  const allowed = targets.filter(isAllowedUnsubscribeTarget)
  if (allowed.length === 0) {
    return { kind: 'none', reason: '退订地址不安全（只允许 https / mailto），已拒绝执行' }
  }
  const https = allowed.find((t) => /^https:/i.test(t))
  const mailto = allowed.find((t) => /^mailto:/i.test(t))
  const oneClick =
    https && /list-unsubscribe\s*=\s*one-click/i.test(String(headers.listUnsubscribePost ?? ''))
  if (oneClick && https) return { kind: 'one-click', url: https }
  if (https) return { kind: 'https-get', url: https }
  if (mailto) {
    const parsed = parseMailto(mailto)
    if (parsed) return { kind: 'mailto', mailto: parsed }
    return { kind: 'none', reason: '退订邮件地址格式不正确' }
  }
  return { kind: 'none', reason: '没有可用的 https / mailto 退订地址' }
}

/** 一键退订 POST 的请求体（RFC 8058 固定值） */
export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click'

/** 界面文案：按钮标题与二次确认文案 */
export function unsubscribeButtonLabel(info: UnsubscribeInfo): string | null {
  if (info.kind === 'none') return null
  if (info.kind === 'one-click') return '退订'
  if (info.kind === 'https-get') return '退订（浏览器）'
  return '退订（发邮件）'
}

/** 二次确认提示（必须让用户知道会发生什么） */
export function unsubscribeConfirmText(info: UnsubscribeInfo): string {
  if (info.kind === 'one-click') return '将向该发件方发送一键退订请求（HTTPS POST），确定继续吗？'
  if (info.kind === 'https-get') return '将打开浏览器访问发件方的退订页面，确定继续吗？'
  if (info.kind === 'mailto') return `将向 ${info.mailto?.to ?? '发件方'} 发送一封退订邮件，确定继续吗？`
  return info.reason ?? '这封邮件不支持退订。'
}
