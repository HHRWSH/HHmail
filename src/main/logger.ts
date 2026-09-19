/**
 * 脱敏日志（规范 §2 第 7 条 / §6.10）：
 * - 永不记录 token、Account ID 明文、邮件正文；
 * - 允许记录：主题/发件人/时间戳/uid/耗时/错误码等白名单字段；
 * - 额外兜底：redact() 把疑似 JWT / token 值打码，防误写。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

type Level = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: number
  level: Level
  event: string
  extra?: Record<string, unknown>
}

/** 日志 extra 字段白名单（防止业务代码顺手把敏感对象整个塞进来）。 */
const ALLOWED_EXTRA_KEYS = new Set([
  'durationMs',
  'uid',
  'uidRange',
  'count',
  'total',
  'done',
  'skipped',
  'mode',
  'phase',
  'errorCode',
  'accountHash',
  'attempts',
  'interval',
  'expiresIn',
  'synced',
  'attempt',
  'questionLength',
  'hits',
  'inputChars',
  'elapsedMs',
  'size',
  'reason',
  'outputChars',
  'finishReason',
  'dbPath',
  'found',
  'listCount',
  'model',
  'labelId',
  'labelName',
  'viewId',
  'viewName',
  'snoozeUntil',
  'draftId',
  'folder',
  'uidValidity',
  'uidNext',
  'exists',
  'lastUid',
  'crashes',
  'reachable',
  'authOk',
  'mechanisms',
  'forced',
  // 同步权威对账（UID SEARCH ALL ↔ 本地 UID）
  'server',
  'local',
  'missing',
  'windowed',
  // 发信测试阶段与结果
  'ok',
  'stage',
  'secure'
])

const FORBIDDEN_KEY_HINTS = ['token', 'secret', 'body', 'html', 'password', 'access', 'refresh', 'authorization']

/** 把可能包含敏感信息的文本打码（兜底；正常路径靠白名单即可）。 */
export function redact(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  // JWT 三段式 / bearer token
  let out = s.replace(/eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED-JWT]')
  // sk- / 通用 token 形 key=value
  out = out.replace(/(sk-[A-Za-z0-9]{6,})/g, '[REDACTED-KEY]')
  out = out.replace(/((?:access|refresh)_token["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]')
  return out
}

export function hashAccount(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 12)
}

/** 白名单过滤 + 打码后的 extra。 */
export function sanitizeExtra(extra?: Record<string, unknown>): Record<string, unknown> {
  if (!extra) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(extra)) {
    const lk = k.toLowerCase()
    if (FORBIDDEN_KEY_HINTS.some((hint) => lk.includes(hint))) continue
    if (!ALLOWED_EXTRA_KEYS.has(k)) continue
    out[k] = typeof v === 'string' ? redact(v) : v
  }
  return out
}

export interface Logger {
  debug(event: string, extra?: Record<string, unknown>): void
  info(event: string, extra?: Record<string, unknown>): void
  warn(event: string, extra?: Record<string, unknown>): void
  error(event: string, extra?: Record<string, unknown>): void
  metric(name: string, value: number, extra?: Record<string, unknown>): void
  close(): void
}

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export class FileLogger implements Logger {
  private filePath: string | null = null
  private minLevel: number
  private lines: string[] = []

  constructor(opts: { logDir?: string; minLevel?: Level } = {}) {
    this.minLevel = LEVEL_ORDER[opts.minLevel ?? 'info']
    if (opts.logDir) {
      try {
        fs.mkdirSync(opts.logDir, { recursive: true })
        this.filePath = path.join(opts.logDir, 'app.log')
        this.rotateIfNeeded()
      } catch {
        this.filePath = null // 写不了文件就退回 console，不让日志拖垮主流程
      }
    }
  }

  private rotateIfNeeded(): void {
    if (!this.filePath) return
    try {
      const st = fs.statSync(this.filePath)
      if (st.size > 512 * 1024) {
        fs.renameSync(this.filePath, `${this.filePath}.1`)
      }
    } catch {
      /* 文件不存在则忽略 */
    }
  }

  private write(level: Level, event: string, extra?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.minLevel) return
    const entry: LogEntry = { ts: Date.now(), level, event, extra: sanitizeExtra(extra) }
    const line = JSON.stringify(entry)
    this.lines.push(line)
    const isError = level === 'error'
    const isWarn = level === 'warn'
    // console 输出也走 redact 兜底
    const consoleLine = redact(line)
    if (isError) console.error(consoleLine)
    else if (isWarn) console.warn(consoleLine)
    else console.log(consoleLine)
    if (this.filePath && this.lines.length >= 8) this.flush()
  }

  private flush(): void {
    if (!this.filePath || this.lines.length === 0) return
    try {
      fs.appendFileSync(this.filePath, this.lines.join('\n') + '\n', 'utf8')
      this.lines = []
    } catch {
      /* 忽略文件写入失败 */
    }
  }

  debug(event: string, extra?: Record<string, unknown>): void {
    this.write('debug', event, extra)
  }
  info(event: string, extra?: Record<string, unknown>): void {
    this.write('info', event, extra)
  }
  warn(event: string, extra?: Record<string, unknown>): void {
    this.write('warn', event, extra)
  }
  error(event: string, extra?: Record<string, unknown>): void {
    this.write('error', event, extra)
  }
  metric(name: string, value: number, extra?: Record<string, unknown>): void {
    this.write('info', `metric.${name}`, { ...sanitizeExtra(extra), value })
  }
  close(): void {
    this.flush()
  }
}

/** 单元测试用的内存 logger。 */
export class MemoryLogger implements Logger {
  entries: LogEntry[] = []
  debug(event: string, extra?: Record<string, unknown>): void {
    this.entries.push({ ts: Date.now(), level: 'debug', event, extra })
  }
  info(event: string, extra?: Record<string, unknown>): void {
    this.entries.push({ ts: Date.now(), level: 'info', event, extra })
  }
  warn(event: string, extra?: Record<string, unknown>): void {
    this.entries.push({ ts: Date.now(), level: 'warn', event, extra })
  }
  error(event: string, extra?: Record<string, unknown>): void {
    this.entries.push({ ts: Date.now(), level: 'error', event, extra })
  }
  metric(name: string, value: number, extra?: Record<string, unknown>): void {
    this.entries.push({ ts: Date.now(), level: 'info', event: `metric.${name}`, extra: { ...extra, value } })
  }
  close(): void {}
}
