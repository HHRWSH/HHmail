/**
 * 头像（纯函数）：列表与详情页共用同一套配色/取字规则。
 *
 * 真机 bug：详情页的头像只写了文字没有背景色（列表里有），于是白字落在白底上——
 * 用户看到的就是左上角"空了一块"。这里统一提供：
 *   - `avatarInitial`：优先取发件人姓名首字；姓名为空时退回邮箱首字母；都给不出就 '?'
 *   - `avatarColor`：按名称哈希取调色板颜色，保证同一个人颜色稳定
 */

const PALETTE = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#5e5ce6', '#64d2ff', '#bf5af2']

export function avatarInitial(fromName: string | null | undefined, fromAddr?: string | null): string {
  const name = String(fromName ?? '').trim()
  if (name) return [...name][0]?.toUpperCase() ?? '?'
  const addr = String(fromAddr ?? '').trim()
  if (addr) return [...addr][0]?.toUpperCase() ?? '?'
  return '?'
}

export function avatarColor(fromName: string | null | undefined, fromAddr?: string | null): string {
  const seed = String(fromName ?? '').trim() || String(fromAddr ?? '').trim() || '?'
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 997
  return PALETTE[h % PALETTE.length]
}
