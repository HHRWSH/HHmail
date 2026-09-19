/**
 * 发送能力自检（只检测、绝不发送邮件）。
 * 用途：回答「能不能直接发邮件」这个问题——用当前登录凭据对
 * smtp.office365.com:587 做 STARTTLS + EHLO + AUTH XOAUTH2，
 * 根据服务器回应判断是「租户禁用了 SMTP AUTH」还是「缺少发送 scope」。
 * 注意：XOAUTH2 的凭据串只在本模块内构造，绝不写日志。
 */
import * as net from 'node:net'
import * as tls from 'node:tls'

export interface SmtpProbeResult {
  reachable: boolean
  startTls: boolean
  authMechanisms: string[]
  authAttempted: boolean
  authOk: boolean
  /** 服务器原始回应（已裁剪，不含凭据） */
  serverMessage: string
}

export interface SmtpProbeOptions {
  host: string
  port: number
  user: string
  accessToken: string
  timeoutMs?: number
}

/** 解析 EHLO 能力行（纯函数，可单测）。 */
export function parseEhloCapabilities(lines: string[]): { authMechanisms: string[]; startTls: boolean } {
  const auth = new Set<string>()
  let startTls = false
  for (const line of lines) {
    const text = line.replace(/^\d{3}[ -]/, '').trim()
    if (/^STARTTLS/i.test(text)) startTls = true
    const m = /^AUTH\s+(.*)$/i.exec(text)
    if (m) {
      for (const mech of m[1].split(/\s+/)) if (mech) auth.add(mech.toUpperCase())
    }
  }
  return { authMechanisms: [...auth], startTls }
}

/** XOAUTH2 凭据串（base64）。仅内部使用，不落日志。 */
export function buildXoauth2Payload(user: string, accessToken: string): string {
  return Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, 'utf8').toString('base64')
}

/** 把探测结果翻译成给用户看的结论与下一步（纯函数，可单测）。 */
export function describeProbeResult(r: SmtpProbeResult): string {
  if (!r.reachable) return '❌ 无法连接 smtp.office365.com:587（网络或防火墙拦截）'
  if (!r.startTls) return '⚠️ 服务器未提供 STARTTLS，出于安全考虑已终止检测'
  const hasXoauth2 = r.authMechanisms.includes('XOAUTH2')
  if (r.authOk) return '✅ 发送鉴权成功：此账号允许 SMTP 发送，可开放「发送邮件」功能'
  if (!hasXoauth2) {
    return `⚠️ 服务器未通告 XOAUTH2（仅支持 ${r.authMechanisms.join(' / ') || '未知'}）→ 需改用 Microsoft Graph Mail.Send 发送`
  }
  if (/scope|permission|not permitted|access denied|invalid_token|401|535/i.test(r.serverMessage)) {
    return '⚠️ 鉴权被拒：当前登录只申请了 IMAP 只读权限；发送需要额外授权（SMTP.Send 或 Graph Mail.Send）并重新登录'
  }
  return `⚠️ 鉴权失败：${r.serverMessage.slice(0, 120)}`
}

/** 读取 SMTP 回应（读到「状态码 + 空格」的结束行）。 */
function readReply(socket: net.Socket, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('SMTP 超时'))
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
          resolve(lines)
          return
        }
        idx = buffer.indexOf('\n')
      }
    }
    const onError = (e: Error): void => {
      cleanup()
      reject(e)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

async function send(socket: net.Socket, command: string, timeoutMs: number): Promise<string[]> {
  socket.write(`${command}\r\n`)
  return readReply(socket, timeoutMs)
}

/** 执行一次发送能力探测（不发送任何邮件）。 */
export async function probeSmtpAuth(opts: SmtpProbeOptions): Promise<SmtpProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const result: SmtpProbeResult = {
    reachable: false,
    startTls: false,
    authMechanisms: [],
    authAttempted: false,
    authOk: false,
    serverMessage: ''
  }
  let socket: net.Socket | null = null
  try {
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: opts.host, port: opts.port })
      const timer = setTimeout(() => {
        s.destroy()
        reject(new Error('连接超时'))
      }, timeoutMs)
      s.once('connect', () => {
        clearTimeout(timer)
        resolve(s)
      })
      s.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    result.reachable = true

    const greeting = await readReply(socket, timeoutMs)
    result.serverMessage = greeting.join(' | ')

    let ehlo = await send(socket, `EHLO mail-ai.local`, timeoutMs)
    let caps = parseEhloCapabilities(ehlo)
    result.startTls = caps.startTls

    if (caps.startTls) {
      await send(socket, 'STARTTLS', timeoutMs)
      const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const t = tls.connect({ socket: socket as net.Socket, servername: opts.host }, () => resolve(t))
        t.once('error', reject)
      })
      socket = secure
      ehlo = await send(socket, `EHLO mail-ai.local`, timeoutMs)
      caps = parseEhloCapabilities(ehlo)
    }
    result.authMechanisms = caps.authMechanisms

    if (caps.authMechanisms.includes('XOAUTH2')) {
      result.authAttempted = true
      const reply = await send(socket, `AUTH XOAUTH2 ${buildXoauth2Payload(opts.user, opts.accessToken)}`, timeoutMs)
      result.serverMessage = reply.join(' | ')
      result.authOk = reply.some((l) => /^235/.test(l))
    } else {
      result.serverMessage = ehlo.join(' | ')
    }
    await send(socket, 'QUIT', 3000).catch(() => undefined)
    return result
  } catch (e) {
    result.serverMessage = result.serverMessage || (e instanceof Error ? e.message : String(e))
    return result
  } finally {
    socket?.destroy()
  }
}
