import { describe, expect, it } from 'vitest'
import { buildXoauth2Payload, describeProbeResult, parseEhloCapabilities, type SmtpProbeResult } from './smtpProbe'

describe('SMTP 发送能力自检（纯逻辑，不联网）', () => {
  it('解析 EHLO 能力：AUTH 机制与 STARTTLS', () => {
    const caps = parseEhloCapabilities([
      '250-smtp.office365.com Hello',
      '250-SIZE 157286400',
      '250-STARTTLS',
      '250-AUTH LOGIN XOAUTH2',
      '250 OK'
    ])
    expect(caps.startTls).toBe(true)
    expect(caps.authMechanisms).toEqual(['LOGIN', 'XOAUTH2'])
  })

  it('XOAUTH2 凭据串格式正确（user=... \x01auth=Bearer ...）', () => {
    const payload = buildXoauth2Payload('a@example.edu', 'tok')
    const decoded = Buffer.from(payload, 'base64').toString('utf8')
    expect(decoded).toBe('user=a@example.edu\x01auth=Bearer tok\x01\x01')
  })

  it('结论映射：连不上 / 无 STARTTLS / 鉴权成功 / 缺 scope / 无 XOAUTH2', () => {
    const base: SmtpProbeResult = {
      reachable: false,
      startTls: false,
      authMechanisms: [],
      authAttempted: false,
      authOk: false,
      serverMessage: ''
    }
    expect(describeProbeResult(base)).toContain('无法连接')
    expect(describeProbeResult({ ...base, reachable: true })).toContain('未提供 STARTTLS')
    expect(
      describeProbeResult({ ...base, reachable: true, startTls: true, authMechanisms: ['XOAUTH2'], authOk: true })
    ).toContain('发送鉴权成功')
    expect(
      describeProbeResult({
        ...base,
        reachable: true,
        startTls: true,
        authMechanisms: ['XOAUTH2'],
        authAttempted: true,
        serverMessage: '535 5.7.3 Authentication unsuccessful'
      })
    ).toContain('发送需要额外授权')
    expect(
      describeProbeResult({ ...base, reachable: true, startTls: true, authMechanisms: ['LOGIN'] })
    ).toContain('Graph Mail.Send')
  })
})
