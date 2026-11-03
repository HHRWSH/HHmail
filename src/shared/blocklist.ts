/**
 * 拦截规则（V2.7）—— 纯函数部分：地址/域名归一化、规则匹配。
 *
 * 设计（用户确认：A 本地黑名单 + B 折叠整理）：
 *   - 收信仍是**只读**：拦截只改本地库（messages.blocked 标记 + 规则表），不动服务器；
 *   - 被拦截发件人的邮件**照常入库**，但不进收件箱主列表、不计未读/角标、不弹通知，
 *     统一折叠到「已拦截」视图，可随时解除拦截、恢复显示。
 */

export type BlockKind = 'email' | 'domain'

export interface BlockSender {
  id: number
  kind: BlockKind
  /** 归一化后的值（小写；域名不带 @） */
  value: string
  createdAt: number
}

/** 归一化邮箱：去空格、小写、去掉尖括号和显示名 */
export function normalizeAddress(raw: string): string {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return ''
  const m = /<([^>]+)>/.exec(text)
  const addr = (m ? m[1] : text).trim()
  const candidate = addr.includes('@') ? addr : ''
  if (!candidate) return ''
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate)) return ''
  return candidate
}

/** 从邮箱取域名（可能含子域）；非法返回空串 */
export function deriveDomain(address: string): string {
  const addr = normalizeAddress(address)
  if (!addr) return ''
  return addr.slice(addr.indexOf('@') + 1)
}

/** 归一化规则值：email 用完整地址；domain 用域名（去掉开头的 @ / * .） */
export function normalizeRuleValue(kind: BlockKind, raw: string): string {
  if (kind === 'email') return normalizeAddress(raw)
  const text = String(raw ?? '').trim().toLowerCase().replace(/^[@*.]+/, '')
  return text.includes('.') && !/\s/.test(text) ? text : ''
}

/** 判断发件人是否命中规则（email 精确或 domain 后缀；不做「子域通配」以外的聪明事） */
export function senderMatchesRule(fromAddr: string, rule: { kind: BlockKind; value: string }): boolean {
  const addr = normalizeAddress(fromAddr)
  if (!addr) return false
  if (rule.kind === 'email') return addr === rule.value
  const domain = deriveDomain(addr)
  if (!domain) return false
  // 域名规则：完全相等或子域匹配（ads.example.com 命中 example.com）
  return domain === rule.value || domain.endsWith('.' + rule.value)
}

/** 是否命中任意规则 */
export function isBlockedByRules(fromAddr: string, rules: Array<{ kind: BlockKind; value: string }>): boolean {
  for (const rule of rules) if (senderMatchesRule(fromAddr, rule)) return true
  return false
}

/**
 * 从「发件人地址」推断该加哪种规则（用户点「拦截发件人」时用完整邮箱；
 * 用户手输 `@example.com` / `example.com` 时用域名）。
 */
export function inferRuleKind(raw: string): BlockKind {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return 'email'
  if (text.startsWith('@') || text.startsWith('*.')) return 'domain'
  return text.includes('@') ? 'email' : 'domain'
}

/** 规则展示文案 */
export function describeRule(rule: { kind: BlockKind; value: string }): string {
  return rule.kind === 'email' ? rule.value : `@${rule.value}（含子域）`
}
