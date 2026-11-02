import { describe, expect, it } from 'vitest'
import { badgeDescription, badgeKind, badgeText, badgeTooltip } from './unreadBadge'

describe('未读角标 —— 数量映射', () => {
  it('0 / 负数 / 非法 → 无角标', () => {
    expect(badgeKind(0)).toBeNull()
    expect(badgeKind(-3)).toBeNull()
    expect(badgeKind(Number.NaN)).toBeNull()
  })

  it('1..9 → 对应数字', () => {
    for (let n = 1; n <= 9; n += 1) expect(badgeKind(n)).toBe(String(n))
  })

  it('≥10 → 9+（不显示三位数）', () => {
    expect(badgeKind(10)).toBe('9plus')
    expect(badgeKind(99)).toBe('9plus')
    expect(badgeKind(1234)).toBe('9plus')
  })

  it('小数向下取整', () => {
    expect(badgeKind(3.9)).toBe('3')
  })

  it('角标文字', () => {
    expect(badgeText('3')).toBe('3')
    expect(badgeText('9plus')).toBe('9+')
  })

  it('无障碍描述用于 setOverlayIcon 的第二个参数', () => {
    expect(badgeDescription(3)).toBe('3 封未读邮件')
    expect(badgeDescription(0)).toBe('没有未读邮件')
  })
})

describe('未读角标 —— 托盘 tooltip', () => {
  it('有未读：品牌名 + 数量', () => {
    expect(badgeTooltip('HHmail', 3)).toBe('HHmail · 3 封未读')
    expect(badgeTooltip('HHmail', 12)).toBe('HHmail · 12 封未读')
  })

  it('无未读：只显示品牌名（不出现 "0 封未读"）', () => {
    expect(badgeTooltip('HHmail', 0)).toBe('HHmail')
  })

  it('品牌名为空/非法 → 回退默认名', () => {
    expect(badgeTooltip('', 2)).toBe('HHmail · 2 封未读')
    expect(badgeTooltip('   ', 0)).toBe('HHmail')
  })
})
