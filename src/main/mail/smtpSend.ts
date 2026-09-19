/**
 * 个人邮箱发信（SMTP，用户自带账号/应用密码）。
 *
 * 为什么要单独一条通道：学校账号默认只申请了 IMAP 只读权限，直接发信一定被拒
 * （见 smtpProbe.ts 的自检结论）。为了「先验证发信能力」，这里支持用户填自己的
 * 邮箱（例如 Gmail / Outlook 个人邮箱）做一次真实的测试发信，与学校只读账号互不影响。
 *
 * 安全约定：
 * - 密码只经 safeStorage 加密落盘，绝不写日志、绝不回传渲染进程；
 * - 只做「发一封纯文本测试邮件」这一件事，不做收件/附件/批量发送。
 *
 * 实现要点：base64 正文（避免点填充与超长行）、RFC 2047 主题、STARTTLS 或直连 TLS、
 * AUTH LOGIN / AUTH PLAIN。
 */
import * as net from 'node:net'
import * as tls from 'node:tls'
import { buildXoauth2Payload } from './smtpProbe'

export interface SmtpSendOptions {
  host: string
  port: number
  /** true = 465 直连 TLS；false = 587 STARTTLS */
  secure?: boolean
  user: string
  /** 密码 / 应用密码（AUTH LOGIN/PLAIN 用；用 OAuth token 时留空） */
  pass?: string
  /** OAuth2 access token（学校账号场景：登录 scope 含 SMTP.Send 时走 AUTH XOAUTH2） */
  accessToken?: string
  from?: string
  fromName?: string
  /** 主收件人（多个用逗号分隔） */
  to: string
  cc?: string[]
  subject: string
  text: string
  /** 回复时带上原邮件的 Message-ID（写入 In-Reply-To / References，便于会话归并） */
  inReplyTo?: string
  timeoutMs?: number
}

export type SmtpSendStage = 'connect' | 'greeting' | 'ehlo' | 'starttls' | 'auth' | 'mail' | 'rcpt' | 'data' | 'done'

export interface SmtpSendResult {
  ok: boolean
  stage: SmtpSendStage
  /** 服务器最后一条回应（已裁剪，绝不含凭据） */
  serverMessage: string
  hint?: string
}

/** RFC 2047 编码（非 ASCII 头字段）。 */
export function encodeHeaderValue(value: string): string {
  const v = String(value ?? '')
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(v)) return v
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

/** 折叠 base64，每行 76 字符（RFC 2045）。 */
export function wrapBase64(b64: string, width = 76): string {
  const out: string[] = []
  for (let i = 0; i < b64.length; i += width) out.push(b64.slice(i, i + width))
  return out.join('\r\n')
}

/** SMTP 点填充：行首的 '.' 变成 '..'。 */
export function dotStuff(message: string): string {
  return message.replace(/(^|\r?\n)\./g, '$1..')
}

/** RFC 5322 日期（本地时间 + 时区偏移）。 */
export function formatRfc5322Date(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n: number): string => String(n).padStart(2, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${days[d.getDay()]}, ${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
}

/** 组装 MIME 纯文本邮件（纯函数，可单测；正文 base64，主题按需 RFC 2047）。 */
export function buildMimeMessage(opts: {
  from: string
  fromName?: string
  to: string
  cc?: string[]
  subject: string
  text: string
  inReplyTo?: string
  date?: Date
  messageId?: string
}): string {
  const fromHeader = opts.fromName ? `${encodeHeaderValue(opts.fromName)} <${opts.from}>` : `<${opts.from}>`
  const id = opts.messageId ?? `<${Date.now()}.${Math.random().toString(36).slice(2)}@mail-ai>`
  const toList = String(opts.to ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const headers = [
    `From: ${fromHeader}`,
    `To: ${toList.map((a) => `<${a}>`).join(', ')}`,
    ...(opts.cc && opts.cc.length > 0 ? [`Cc: ${opts.cc.map((a) => `<${a}>`).join(', ')}`] : []),
    `Subject: ${encodeHeaderValue(opts.subject)}`,
    `Date: ${formatRfc5322Date(opts.date ?? new Date())}`,
    `Message-ID: ${id}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64'
  ]
  const body = wrapBase64(Buffer.from(String(opts.text ?? ''), 'utf8').toString('base64'))
  return `${headers.join('\r\n')}\r\n\r\n${body}`
}

/** 解析 SMTP 应答：返回状态码与（多行）原文。 */
export function parseSmtpReply(lines: string[]): { code: number; text: string } {
  const last = lines[lines.length - 1] ?? ''
  const m = /^(\d{3})/.exec(last)
  const code = m ? Number.parseInt(m[1], 10) : 0
  const text = lines
    .map((l) => l.replace(/^\d{3}[ -]?/, '').trim())
    .filter(Boolean)
    .join(' | ')
  return { code, text }
}

/** 选择认证机制：有 OAuth token 且服务器支持 → XOAUTH2；否则 LOGIN，其次 PLAIN。 */
export function chooseAuthMechanism(mechanisms: string[], hasToken = false): 'XOAUTH2' | 'LOGIN' | 'PLAIN' | null {
  const upper = mechanisms.map((m) => m.toUpperCase())
  if (hasToken && upper.includes('XOAUTH2')) return 'XOAUTH2'
  if (upper.includes('LOGIN')) return 'LOGIN'
  if (upper.includes('PLAIN')) return 'PLAIN'
  return upper.length === 0 && !hasToken ? 'LOGIN' : null
}

/** 把结果翻译成给用户看的中文结论（纯函数，可单测）。 */
export function describeSendResult(r: SmtpSendResult, to?: string, opts: { oauth?: boolean } = {}): string {
  if (r.ok) return `✅ 测试邮件已发送到 ${to ?? '收件人'}，请到收件箱确认（可能在垃圾邮件里）。`
  const msg = r.serverMessage || '（无服务器回应）'
  if (r.stage === 'connect') return `❌ 无法连接 SMTP 服务器：${msg}`
  if (r.stage === 'starttls') return `❌ STARTTLS 失败：${msg}（若服务器用 465 端口，请勾选「直连 SSL/TLS」）`
  if (r.stage === 'auth') {
    if (/SmtpClientAuthentication is disabled/i.test(msg)) {
      return `❌ 学校/租户关闭了 SMTP AUTH：${msg}\n只能改用 Graph Mail.Send（需管理员同意）发信。`
    }
    if (opts.oauth) {
      return `❌ OAuth 鉴权被拒：${msg}\n常见原因：登录时未同意发信权限（scope 缺 SMTP.Send），请退出后重新登录并在授权页同意。`
    }
    if (/535|534|530|5\.7\.\d|authentication|credentials/i.test(msg)) {
      return `❌ 鉴权失败：${msg}\n常见原因：① 用了登录密码而不是「应用密码」；② 邮箱未开启 SMTP/两步验证；③ 账号被要求用 OAuth。`
    }
    return `❌ 鉴权失败：${msg}`
  }
  if (r.stage === 'rcpt') return `❌ 收件人被拒绝：${msg}`
  if (r.stage === 'mail') return `❌ 发件人被拒绝：${msg}`
  return `❌ 发送失败（${r.stage}）：${msg}`
}

/** 可注入的 SMTP 连接（单测用假实现，不碰网络）。 */
export interface SmtpTransport {
  /** 发送一行命令（自动补 CRLF） */
  write(line: string): void
  /** 读一条完整应答（多行应答读到 "250 " 为止） */
  readReply(): Promise<string[]>
  /** STARTTLS 升级（失败时抛错） */
  upgradeTls(): Promise<void>
  close(): void
}

/** 用给定连接执行一次完整发信流程（协议状态机，纯逻辑 → 可单测）。 */
export async function runSmtpSend(
  t: SmtpTransport,
  opts: SmtpSendOptions
): Promise<SmtpSendResult> {
  const from = opts.from && opts.from.trim() ? opts.from.trim() : opts.user
  const fail = (stage: SmtpSendStage, text: string): SmtpSendResult => ({ ok: false, stage, serverMessage: text })
  let stage: SmtpSendStage = 'greeting'

  try {
    const greeting = parseSmtpReply(await t.readReply())
    if (greeting.code !== 220) return fail('greeting', greeting.text)

    stage = 'ehlo'
    t.write('EHLO mail-ai.local')
    let ehloLines = await t.readReply()
    let caps = parseCaps(ehloLines)
    if (parseSmtpReply(ehloLines).code !== 250) return fail('ehlo', parseSmtpReply(ehloLines).text)

    if (!opts.secure && caps.startTls) {
      stage = 'starttls'
      t.write('STARTTLS')
      const reply = parseSmtpReply(await t.readReply())
      if (reply.code !== 220) return fail('starttls', reply.text)
      try {
        await t.upgradeTls()
      } catch (e) {
        return fail('starttls', e instanceof Error ? e.message : String(e))
      }
      t.write('EHLO mail-ai.local')
      ehloLines = await t.readReply()
      caps = parseCaps(ehloLines)
      if (parseSmtpReply(ehloLines).code !== 250) return fail('ehlo', parseSmtpReply(ehloLines).text)
    } else if (!opts.secure && !caps.startTls) {
      // 未加密且服务器不支持 STARTTLS：拒绝在明文里送密码
      return fail('starttls', '服务器未提供 STARTTLS，已中止（避免明文发送密码）。若服务器仅支持 465，请勾选「直连 SSL/TLS」。')
    }

    stage = 'auth'
    const useToken = Boolean(opts.accessToken)
    if (!useToken && !opts.pass) {
      return fail('auth', '缺少认证凭据：既没有 OAuth token（SMTP.Send），也没有密码/应用密码。')
    }
    const mech = chooseAuthMechanism(caps.auth, useToken)
    if (!mech) return fail('auth', `服务器未通告可用的认证机制（${caps.auth.join(' / ') || '无'}）`)
    if (mech === 'XOAUTH2') {
      t.write(`AUTH XOAUTH2 ${buildXoauth2Payload(opts.user, opts.accessToken as string)}`)
      const r = parseSmtpReply(await t.readReply())
      if (r.code === 334) {
        // XOAUTH2 失败时服务器会先回 334 + base64 错误串，客户端必须回一个空行再读最终错误
        t.write('')
        const r2 = parseSmtpReply(await t.readReply())
        return fail('auth', r2.text || r.text)
      }
      if (r.code !== 235) return fail('auth', r.text)
    } else if (mech === 'LOGIN') {
      t.write('AUTH LOGIN')
      const r1 = parseSmtpReply(await t.readReply())
      if (r1.code !== 334) return fail('auth', r1.text)
      t.write(Buffer.from(opts.user, 'utf8').toString('base64'))
      const r2 = parseSmtpReply(await t.readReply())
      if (r2.code !== 334) return fail('auth', r2.text)
      t.write(Buffer.from(opts.pass ?? '', 'utf8').toString('base64'))
      const r3 = parseSmtpReply(await t.readReply())
      if (r3.code !== 235) return fail('auth', r3.text)
    } else {
      const payload = Buffer.from(`\u0000${opts.user}\u0000${opts.pass ?? ''}`, 'utf8').toString('base64')
      t.write(`AUTH PLAIN ${payload}`)
      const r = parseSmtpReply(await t.readReply())
      if (r.code !== 235) return fail('auth', r.text)
    }

    stage = 'mail'
    t.write(`MAIL FROM:<${from}>`)
    const mail = parseSmtpReply(await t.readReply())
    if (mail.code !== 250) return fail('mail', mail.text)

    stage = 'rcpt'
    const rcptTargets = [
      ...String(opts.to ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      ...(opts.cc ?? []).map((s) => s.trim()).filter(Boolean)
    ]
    for (const addr of rcptTargets) {
      t.write(`RCPT TO:<${addr}>`)
      const rcpt = parseSmtpReply(await t.readReply())
      if (rcpt.code !== 250 && rcpt.code !== 251) return fail('rcpt', `${addr}：${rcpt.text}`)
    }

    stage = 'data'
    t.write('DATA')
    const data = parseSmtpReply(await t.readReply())
    if (data.code !== 354) return fail('data', data.text)

    const message = buildMimeMessage({
      from,
      fromName: opts.fromName,
      to: opts.to,
      cc: opts.cc,
      subject: opts.subject,
      text: opts.text,
      inReplyTo: opts.inReplyTo
    })
    t.write(`${dotStuff(message)}\r\n.`)
    const sent = parseSmtpReply(await t.readReply())
    if (sent.code !== 250) return fail('data', sent.text)

    t.write('QUIT')
    await t.readReply().catch(() => undefined)
    return { ok: true, stage: 'done', serverMessage: sent.text }
  } catch (e) {
    return fail(stage, e instanceof Error ? e.message : String(e))
  } finally {
    t.close()
  }
}

function parseCaps(lines: string[]): { startTls: boolean; auth: string[] } {
  let startTls = false
  const auth: string[] = []
  for (const raw of lines) {
    const text = raw.replace(/^\d{3}[ -]/, '').trim()
    if (/^STARTTLS/i.test(text)) startTls = true
    const m = /^AUTH\s+(.*)$/i.exec(text)
    if (m) for (const mech of m[1].split(/\s+/)) if (mech) auth.push(mech.toUpperCase())
  }
  return { startTls, auth }
}

/** 真实连接实现（node:net / node:tls）。 */
export function createNodeTransport(host: string, port: number, secure: boolean, timeoutMs: number): Promise<SmtpTransport> {
  return new Promise<SmtpTransport>((resolve, reject) => {
    let socket: net.Socket
    let buffer = ''
    const connect = (): void => {
      socket = secure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`连接 ${host}:${port} 超时`))
      }, timeoutMs)
      const readyEvent = secure ? 'secureConnect' : 'connect'
      socket.once(readyEvent, () => {
        clearTimeout(timer)
        resolve(makeTransport())
      })
      socket.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    }
    const makeTransport = (): SmtpTransport => {
      const readReply = (): Promise<string[]> =>
        new Promise((res, rej) => {
          const lines: string[] = []
          const timer = setTimeout(() => {
            cleanup()
            rej(new Error('SMTP 应答超时'))
          }, timeoutMs)
          const onData = (chunk: Buffer): void => {
            buffer += chunk.toString('utf8')
            let idx = buffer.indexOf('\n')
            while (idx >= 0) {
              const line = buffer.slice(0, idx).replace(/\r$/, '')
              buffer = buffer.slice(idx + 1)
              lines.push(line)
              if (/^\d{3} /.test(line)) {
                cleanup()
                res(lines)
                return
              }
              idx = buffer.indexOf('\n')
            }
          }
          const onError = (e: Error): void => {
            cleanup()
            rej(e)
          }
          const cleanup = (): void => {
            clearTimeout(timer)
            socket.off('data', onData)
            socket.off('error', onError)
          }
          socket.on('data', onData)
          socket.on('error', onError)
        })
      return {
        write: (line: string) => {
          socket.write(`${line}\r\n`)
        },
        readReply,
        upgradeTls: () =>
          new Promise<void>((res, rej) => {
            const secure = tls.connect({ socket, servername: host }, () => res())
            secure.once('error', rej)
            socket = secure
          }),
        close: () => socket.destroy()
      }
    }
    connect()
  })
}

/** 发送一封纯文本邮件（真实网络；凭据不落日志）。 */
export async function sendSmtpMail(opts: SmtpSendOptions): Promise<SmtpSendResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  let transport: SmtpTransport | null = null
  try {
    transport = await createNodeTransport(opts.host, opts.port, opts.secure === true, timeoutMs)
  } catch (e) {
    return { ok: false, stage: 'connect', serverMessage: e instanceof Error ? e.message : String(e) }
  }
  return runSmtpSend(transport, { ...opts, timeoutMs })
}
