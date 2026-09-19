import { describe, expect, it } from 'vitest'
import { hashAccount, redact, sanitizeExtra } from './logger'

describe('日志脱敏（规范 §2 第 7 条：不记录 token / Account ID / 正文）', () => {
  it('redact 打码 JWT 与 API Key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1cG4iOiJtZUBjZWhrLmNvbSJ9.signature-part'
    const out = redact(`token=${jwt} key=sk-abc123def456`)
    expect(out).not.toContain('eyJhbGci')
    expect(out).toContain('[REDACTED-JWT]')
    expect(out).not.toContain('sk-abc123def456')
  })

  it('redact 打码 access_token=… 形值', () => {
    const out = redact('access_token=abcdefghijklmnopqrstuvwxyz123456')
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(out).toContain('[REDACTED]')
  })

  it('sanitizeExtra 白名单：允许 uid/耗时/计数；丢弃 token/body/email', () => {
    const out = sanitizeExtra({
      uid: 123,
      durationMs: 45,
      count: 3,
      accessToken: 'SECRET',
      refresh_token: 'SECRET2',
      bodyText: '邮件正文',
      accountHash: 'abc',
      unknownKey: 'x'
    })
    expect(out.uid).toBe(123)
    expect(out.durationMs).toBe(45)
    expect(out.accountHash).toBe('abc')
    expect(out).not.toHaveProperty('accessToken')
    expect(out).not.toHaveProperty('refresh_token')
    expect(out).not.toHaveProperty('bodyText')
    expect(out).not.toHaveProperty('unknownKey')
  })

  it('hashAccount 稳定且不泄露原文', () => {
    const h1 = hashAccount('me@link.example.edu')
    const h2 = hashAccount(' me@link.example.edu ')
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(12)
    expect(h1).not.toContain('@')
    expect(h1).not.toContain('university-domain-marker')
  })
})
