import { describe, expect, it } from 'vitest'
import {
  buildMimeMessage,
  chooseAuthMechanism,
  describeSendResult,
  dotStuff,
  encodeHeaderValue,
  formatRfc5322Date,
  parseSmtpReply,
  runSmtpSend,
  wrapBase64,
  type SmtpSendOptions,
  type SmtpTransport
} from './smtpSend'

/** 脚本化假连接：按顺序吐回应，并记录客户端发出的每一行命令。 */
class FakeTransport implements SmtpTransport {
  script: string[][]
  commands: string[] = []
  tlsUpgrades = 0
  closed = false

  constructor(script: string[][]) {
    this.script = [...script]
  }

  write(line: string): void {
    this.commands.push(line)
  }

  async readReply(): Promise<string[]> {
    const next = this.script.shift()
    if (!next) throw new Error('脚本用尽：服务器没有更多回应')
    return next
  }

  async upgradeTls(): Promise<void> {
    this.tlsUpgrades += 1
  }

  close(): void {
    this.closed = true
  }
}

const opts: SmtpSendOptions = {
  host: 'smtp.example.com',
  port: 587,
  user: 'me@example.com',
  pass: 'app-password',
  to: 'me@example.com',
  subject: '测试',
  text: 'hello 世界'
}

const greeting = ['220 smtp.example.com ESMTP']
const ehloTlsLogin = ['250-smtp.example.com', '250-STARTTLS', '250 AUTH LOGIN PLAIN']
const ehloSecureLogin = ['250-smtp.example.com', '250 AUTH LOGIN PLAIN']

describe('smtpSend —— MIME 组装（纯函数）', () => {
  it('中文主题用 RFC 2047 编码，ASCII 主题保持原样', () => {
    expect(encodeHeaderValue('HHmail test')).toBe('HHmail test')
    expect(encodeHeaderValue('测试邮件')).toBe('=?UTF-8?B?5rWL6K+V6YKu5Lu2?=')
  })

  it('正文 base64 且按 76 字符折行（避免点填充与超长行）', () => {
    const msg = buildMimeMessage({ from: 'a@x.com', fromName: '发件人', to: 'b@y.com', subject: '测试', text: '你好世界' })
    expect(msg).toContain('Content-Type: text/plain; charset=utf-8')
    expect(msg).toContain('Content-Transfer-Encoding: base64')
    expect(msg).toContain('From: =?UTF-8?B?')
    const body = msg.split('\r\n\r\n')[1]
    expect(body.split('\r\n').every((l) => l.length <= 76)).toBe(true)
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('你好世界')
  })

  it('行首的点会被填充（SMTP 转义）', () => {
    expect(dotStuff('.hidden\r\n..already')).toBe('..hidden\r\n...already')
  })

  it('RFC 5322 日期带时区偏移', () => {
    const s = formatRfc5322Date(new Date(2025, 0, 2, 3, 4, 5))
    expect(s).toMatch(/^Thu, 02 Jan 2025 03:04:05 [+-]\d{4}$/)
  })

  it('wrapBase64 折行', () => {
    expect(wrapBase64('a'.repeat(100)).split('\r\n')).toHaveLength(2)
  })
})

describe('smtpSend —— 应答解析与机制选择（纯函数）', () => {
  it('多行应答取最后一行状态码、文本合并', () => {
    expect(parseSmtpReply(['250-smtp', '250 AUTH LOGIN'])).toEqual({ code: 250, text: 'smtp | AUTH LOGIN' })
    expect(parseSmtpReply(['535 5.7.8 Authentication failed']).code).toBe(535)
  })

  it('优先 LOGIN，其次 PLAIN，未通告时按 LOGIN 尝试；都不支持则 null', () => {
    expect(chooseAuthMechanism(['LOGIN', 'PLAIN'])).toBe('LOGIN')
    expect(chooseAuthMechanism(['PLAIN'])).toBe('PLAIN')
    expect(chooseAuthMechanism([])).toBe('LOGIN')
    expect(chooseAuthMechanism(['XOAUTH2'])).toBeNull()
  })

  it('有 OAuth token 且服务器支持 XOAUTH2 → 优先 XOAUTH2（学校邮箱场景）', () => {
    expect(chooseAuthMechanism(['LOGIN', 'XOAUTH2'], true)).toBe('XOAUTH2')
    expect(chooseAuthMechanism(['LOGIN', 'PLAIN'], true)).toBe('LOGIN')
    expect(chooseAuthMechanism(['XOAUTH2'], false)).toBeNull()
  })

  it('OAuth 鉴权失败的结论提示重新登录同意授权', () => {
    const text = describeSendResult({ ok: false, stage: 'auth', serverMessage: '535 5.7.3 Authentication unsuccessful' }, undefined, {
      oauth: true
    })
    expect(text).toContain('SMTP.Send')
    expect(text).toContain('重新登录')
    // 租户关闭 SMTP AUTH 时给出不同指引
    expect(
      describeSendResult(
        { ok: false, stage: 'auth', serverMessage: '535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.' },
        undefined,
        { oauth: true }
      )
    ).toContain('Graph Mail.Send')
  })

  it('结论文案区分鉴权失败/收件人被拒/成功', () => {
    expect(describeSendResult({ ok: true, stage: 'done', serverMessage: 'ok' }, 'a@b.com')).toContain('已发送')
    expect(describeSendResult({ ok: false, stage: 'auth', serverMessage: '535 auth failed' })).toContain('应用密码')
    expect(describeSendResult({ ok: false, stage: 'rcpt', serverMessage: '550 no such user' })).toContain('收件人被拒绝')
  })
})

describe('smtpSend —— 协议流程（假连接，不联网）', () => {
  it('STARTTLS + AUTH LOGIN + 发送成功：命令顺序与凭据 base64 正确', async () => {
    const t = new FakeTransport([
      greeting,
      ehloTlsLogin,
      ['220 2.0.0 Ready to start TLS'],
      ehloSecureLogin,
      ['334 VXNlcm5hbWU6'],
      ['334 UGFzc3dvcmQ6'],
      ['235 2.7.0 Authentication successful'],
      ['250 2.1.0 Sender OK'],
      ['250 2.1.5 Recipient OK'],
      ['354 Start mail input'],
      ['250 2.0.0 Queued']
    ])
    const r = await runSmtpSend(t, opts)
    expect(r.ok).toBe(true)
    expect(t.tlsUpgrades).toBe(1)
    expect(t.commands).toEqual([
      'EHLO mail-ai.local',
      'STARTTLS',
      'EHLO mail-ai.local',
      'AUTH LOGIN',
      Buffer.from('me@example.com').toString('base64'),
      Buffer.from('app-password').toString('base64'),
      'MAIL FROM:<me@example.com>',
      'RCPT TO:<me@example.com>',
      'DATA',
      expect.stringContaining('.'),
      'QUIT'
    ])
    expect(t.closed).toBe(true)
    // 密码只以 base64 出现在协议里，命令记录里没有明文
    expect(t.commands.join('\n')).not.toContain('app-password')
  })

  it('AUTH XOAUTH2：有 token 时走 XOAUTH2，payload 正确且不发密码（学校邮箱场景）', async () => {
    const t = new FakeTransport([
      greeting,
      ['250-smtp', '250-STARTTLS', '250 AUTH LOGIN XOAUTH2'],
      ['220 Ready'],
      ['250-smtp', '250 AUTH LOGIN XOAUTH2'],
      ['235 2.7.0 Authentication successful'],
      ['250 ok'],
      ['250 ok'],
      ['354 go'],
      ['250 queued']
    ])
    const r = await runSmtpSend(t, { ...opts, pass: undefined, accessToken: 'TOKEN-123' })
    expect(r.ok).toBe(true)
    const expected = Buffer.from('user=me@example.com\u0001auth=Bearer TOKEN-123\u0001\u0001', 'utf8').toString('base64')
    expect(t.commands).toContain(`AUTH XOAUTH2 ${expected}`)
    expect(t.commands.join('\n')).not.toContain('app-password')
  })

  it('AUTH XOAUTH2 失败：服务器先回 334 错误串，客户端补空行后拿到真正的 535', async () => {
    const t = new FakeTransport([
      greeting,
      ['250-smtp', '250-STARTTLS', '250 AUTH XOAUTH2'],
      ['220 Ready'],
      ['250-smtp', '250 AUTH XOAUTH2'],
      ['334 eyJzdGF0dXMiOiI0MDEifQ=='],
      ['535 5.7.3 Authentication unsuccessful']
    ])
    const r = await runSmtpSend(t, { ...opts, pass: undefined, accessToken: 'BAD' })
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('auth')
    expect(r.serverMessage).toContain('Authentication unsuccessful')
    expect(t.commands).toContain('')
  })

  it('既没有 token 也没有密码 → 明确报错，不发认证命令', async () => {
    const t = new FakeTransport([greeting, ehloSecureLogin])
    const r = await runSmtpSend(t, { ...opts, pass: undefined, secure: true })
    expect(r.ok).toBe(false)
    expect(r.serverMessage).toContain('缺少认证凭据')
    expect(t.commands.some((c) => c.startsWith('AUTH'))).toBe(false)
  })

  it('AUTH PLAIN：单条命令带 payload', async () => {
    const t = new FakeTransport([
      greeting,
      ehloTlsLogin,
      ['220 Ready'],
      ['250-smtp', '250 AUTH PLAIN'],
      ['235 ok'],
      ['250 ok'],
      ['250 ok'],
      ['354 go'],
      ['250 queued']
    ])
    const r = await runSmtpSend(t, opts)
    expect(r.ok).toBe(true)
    expect(t.commands).toContain(`AUTH PLAIN ${Buffer.from('\u0000me@example.com\u0000app-password').toString('base64')}`)
  })

  it('服务器不支持 STARTTLS → 拒绝明文发送密码', async () => {
    const t = new FakeTransport([greeting, ['250-smtp', '250 AUTH LOGIN']])
    const r = await runSmtpSend(t, opts)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('starttls')
    expect(r.serverMessage).toContain('未提供 STARTTLS')
    expect(t.commands).not.toContain('AUTH LOGIN')
  })

  it('直连 TLS（465）不需要 STARTTLS', async () => {
    const t = new FakeTransport([
      greeting,
      ehloSecureLogin,
      ['334 u'],
      ['334 p'],
      ['235 ok'],
      ['250 ok'],
      ['250 ok'],
      ['354 go'],
      ['250 queued']
    ])
    const r = await runSmtpSend(t, { ...opts, port: 465, secure: true })
    expect(r.ok).toBe(true)
    expect(t.tlsUpgrades).toBe(0)
    expect(t.commands).not.toContain('STARTTLS')
  })

  it('鉴权失败：返回 535 原文且停在 auth 阶段（不继续发信）', async () => {
    const t = new FakeTransport([
      greeting,
      ehloTlsLogin,
      ['220 Ready'],
      ehloSecureLogin,
      ['334 u'],
      ['334 p'],
      ['535 5.7.8 Username and Password not accepted']
    ])
    const r = await runSmtpSend(t, opts)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('auth')
    expect(t.commands).not.toContain('DATA')
  })

  it('收件人被拒：停在 rcpt 阶段', async () => {
    const t = new FakeTransport([
      greeting,
      ehloTlsLogin,
      ['220 Ready'],
      ehloSecureLogin,
      ['334 u'],
      ['334 p'],
      ['235 ok'],
      ['250 ok'],
      ['550 5.1.1 User unknown']
    ])
    const r = await runSmtpSend(t, opts)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('rcpt')
    expect(t.commands).not.toContain('DATA')
  })

  it('连接层异常（读取超时）也能返回结构化失败', async () => {
    const t = new FakeTransport([greeting, ehloTlsLogin, ['220 Ready'], ehloSecureLogin, ['334 u']])
    const r = await runSmtpSend(t, opts) // 脚本用尽 → 抛错
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('auth')
  })
})
