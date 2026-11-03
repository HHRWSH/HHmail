import { describe, expect, it } from 'vitest'
import {
  deriveDomain,
  describeRule,
  inferRuleKind,
  isBlockedByRules,
  normalizeAddress,
  normalizeRuleValue,
  senderMatchesRule
} from './blocklist'

describe('拦截规则（V2.7）—— 地址归一化', () => {
  it('normalizeAddress 去空格/小写/去显示名', () => {
    expect(normalizeAddress('  Prof. Lin <Lin@Example.EDU> ')).toBe('lin@example.edu')
    expect(normalizeAddress('a@b.com')).toBe('a@b.com')
    expect(normalizeAddress('not-an-email')).toBe('')
    expect(normalizeAddress('')).toBe('')
  })

  it('deriveDomain 取 @ 后面', () => {
    expect(deriveDomain('a@sub.example.com')).toBe('sub.example.com')
    expect(deriveDomain('bad')).toBe('')
  })

  it('normalizeRuleValue：email 用完整地址、domain 去前缀', () => {
    expect(normalizeRuleValue('email', ' X@Y.COM ')).toBe('x@y.com')
    expect(normalizeRuleValue('domain', '@Example.COM')).toBe('example.com')
    expect(normalizeRuleValue('domain', '*.ads.com')).toBe('ads.com')
    expect(normalizeRuleValue('domain', 'no-dot')).toBe('')
  })
})

describe('拦截规则 —— 匹配', () => {
  it('邮箱精确匹配', () => {
    expect(senderMatchesRule('a@x.com', { kind: 'email', value: 'a@x.com' })).toBe(true)
    expect(senderMatchesRule('b@x.com', { kind: 'email', value: 'a@x.com' })).toBe(false)
  })

  it('域名匹配 + 子域匹配', () => {
    const rule = { kind: 'domain' as const, value: 'example.com' }
    expect(senderMatchesRule('a@example.com', rule)).toBe(true)
    expect(senderMatchesRule('a@mail.example.com', rule)).toBe(true)
    expect(senderMatchesRule('a@notexample.com', rule)).toBe(false)
    expect(senderMatchesRule('a@example.com.cn', rule)).toBe(false)
  })

  it('非法地址不命中', () => {
    expect(senderMatchesRule('', { kind: 'email', value: 'a@x.com' })).toBe(false)
    expect(senderMatchesRule('nope', { kind: 'domain', value: 'x.com' })).toBe(false)
  })

  it('isBlockedByRules 任一规则命中即拦截', () => {
    const rules = [
      { kind: 'email' as const, value: 'spam@a.com' },
      { kind: 'domain' as const, value: 'ads.com' }
    ]
    expect(isBlockedByRules('spam@a.com', rules)).toBe(true)
    expect(isBlockedByRules('x@promo.ads.com', rules)).toBe(true)
    expect(isBlockedByRules('friend@school.edu', rules)).toBe(false)
    expect(isBlockedByRules('anything@a.com', [])).toBe(false)
  })
})

describe('拦截规则 —— 推断与文案', () => {
  it('inferRuleKind', () => {
    expect(inferRuleKind('a@b.com')).toBe('email')
    expect(inferRuleKind('@b.com')).toBe('domain')
    expect(inferRuleKind('*.b.com')).toBe('domain')
    expect(inferRuleKind('b.com')).toBe('domain')
  })

  it('describeRule', () => {
    expect(describeRule({ kind: 'email', value: 'a@b.com' })).toBe('a@b.com')
    expect(describeRule({ kind: 'domain', value: 'ads.com' })).toContain('@ads.com')
  })
})
