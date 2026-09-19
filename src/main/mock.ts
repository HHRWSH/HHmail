/**
 * 自测 mock 模式（HHMAIL_MOCK=1，仅开发/自测用）：
 * - FakeMailProvider 生成 20 封构造邮件，走真实 mailparser + SQLite 全链路；
 * - MockAuthService 直接"已登录"，不发起任何真实 OAuth 请求、不写真实 DPAPI；
 * - 真实登录链路（设备码 → DPAPI）不受影响，mock 只在自测时注入。
 */
import type { AuthStatus, DeviceCodeEvent, DeviceCodeInfo } from '../shared/types'
import {
  DEFAULT_ASK_TOPK,
  DEFAULT_ATTACHMENT_DIR,
  DEFAULT_AUTO_TAG,
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_SUBTITLE,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_SUMMARY_PROMPT
} from '../shared/defaults'
import { DEFAULT_TAG_VOCABULARY } from '../shared/tags'
import { DEFAULT_AI_PROVIDER_ID } from '../shared/aiProviders'
import { DEFAULT_SMTP_HOST, DEFAULT_SMTP_PORT } from './settings'
import type { Logger } from './logger'
import type { AuthService } from './auth/service'
import {
  type AttachmentPayload,
  type MailboxInfo,
  type MailProvider,
  type MailProviderCapabilities,
  type OutgoingDraft,
  type RawMessageBody,
  type RawMessageMeta,
  unsupportedOperation
} from './mail/provider'
import type { AppSettings, SetSettingsArgs } from '../shared/types'
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from './config'
import type { SettingsStore } from './settings'

export const MOCK_EMAIL = 'demo@link.example.edu'

/** 构造一封简单 EML（含中文主题/正文），供 mailparser 真实解析。 */
export function buildTestEmail(
  uid: number,
  opts: { subject?: string; from?: string; body?: string; refs?: string; messageId?: string; attachment?: { filename: string; content: string } } = {}
): Buffer {
  const subject = opts.subject ?? `测试邮件 ${uid}`
  const from = opts.from ?? 'Prof. 林教授 <lin@example.edu>'
  const body = opts.body ?? `这是第 ${uid} 封测试邮件的正文，用于验证同步与解析链路。\n\n第二行内容：邮箱助手自测。`
  const messageId = opts.messageId ?? `<test-${uid}@example.edu>`
  const date = new Date(Date.now() - uid * 3600_000).toUTCString()
  const lines = [
    `From: ${from}`,
    'To: student@link.example.edu',
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0'
  ]
  if (opts.refs) lines.push(`References: ${opts.refs}`)
  if (opts.attachment) {
    // multipart/mixed：正文 + 附件（验证附件解析与下载链路）
    const boundary = `B${uid}X`
    lines.push(
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body, 'utf8').toString('base64'),
      `--${boundary}`,
      'Content-Type: application/octet-stream; name="att.txt"',
      'Content-Disposition: attachment; filename="att.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(opts.attachment.content, 'utf8').toString('base64'),
      `--${boundary}--`
    )
  } else {
    lines.push(
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body, 'utf8').toString('base64')
    )
  }
  return Buffer.from(lines.join('\r\n'), 'utf8')
}

export class FakeMailProvider implements MailProvider {
  readonly capabilities: MailProviderCapabilities = { readOnly: true, send: false, move: false }
  readonly mailbox: MailboxInfo
  private messages: Map<number, Buffer>
  private connected = false
  folderMailboxes = new Map<string, MailboxInfo>()

  constructor(messages?: Map<number, Buffer>, mailbox?: Partial<MailboxInfo>) {
    this.messages = messages ?? new Map()
    const maxUid = this.messages.size > 0 ? Math.max(...this.messages.keys()) : 0
    this.mailbox = {
      uidValidity: mailbox?.uidValidity ?? 7,
      exists: mailbox?.exists ?? this.messages.size,
      uidNext: mailbox?.uidNext ?? maxUid + 1
    }
  }

  static withDefaults(count = 20): FakeMailProvider {
    const map = new Map<number, Buffer>()
    const longBody = Array.from({ length: 60 }, (_, i) => `长正文第 ${i + 1} 行：邮箱助手自测，用于验证详情区滚动与滑动条显示。`).join('\r\n')
    for (let i = 1; i <= count; i++) {
      const uid = 100 + i
      map.set(
        uid,
        buildTestEmail(uid, {
          subject: i === 1 ? '关于毕业论文进度的沟通' : `测试通知 ${i}`,
          from: i % 3 === 0 ? '教务处 <office@link.example.edu>' : 'Prof. 林教授 <lin@example.edu>',
          // 列表第一封（uid 101，日期最新）给长正文，验证详情滚动
          body: i === 1 ? longBody : undefined,
          // 第一封带附件，验证附件解析与下载链路
          attachment: i === 1 ? { filename: 'att.txt', content: 'mock attachment content' } : undefined
        })
      )
    }
    const provider = new FakeMailProvider(map)
    // 其他只读文件夹（空），验证多文件夹导航与独立同步状态
    provider.folderMailboxes.set('Sent', { uidValidity: 8, exists: 0, uidNext: 1 })
    provider.folderMailboxes.set('Drafts', { uidValidity: 9, exists: 0, uidNext: 1 })
    return provider
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async openInboxReadOnly(): Promise<MailboxInfo> {
    await this.connect()
    this.currentFolder = 'INBOX'
    return this.mailbox
  }

  async openFolderReadOnly(folderPath: string): Promise<MailboxInfo> {
    await this.connect()
    this.currentFolder = folderPath
    if (folderPath === 'INBOX') return this.mailbox
    return this.folderMailboxes.get(folderPath) ?? { uidValidity: 8, exists: 0, uidNext: 1 }
  }

  async listFolders(): Promise<{ name: string; path: string }[]> {
    return [
      { name: '收件箱', path: 'INBOX' },
      ...Array.from(this.folderMailboxes.keys(), (p) => ({ name: p, path: p }))
    ]
  }

  /** 记录最近一次只读打开的文件夹：mock 只给 INBOX 造了邮件，其它文件夹按空处理 */
  private currentFolder = 'INBOX'

  async searchAllUids(folder: string): Promise<number[]> {
    if (folder !== 'INBOX') return []
    return [...this.messages.keys()].sort((a, b) => a - b)
  }

  async *fetchEnvelopeRange(startUid: number, endUid: number): AsyncIterable<RawMessageMeta> {
    for (const [uid] of this.messages) {
      if (uid >= startUid && uid <= endUid) {
        yield { uid, envelope: { subject: `mock-${uid}` }, flags: [] }
      }
    }
  }

  async fetchBody(uid: number): Promise<RawMessageBody | null> {
    const raw = this.messages.get(uid)
    return raw ? { uid, raw } : null
  }

  async fetchAttachment(_uid: number, partId: string): Promise<AttachmentPayload> {
    // mock 模式返回假附件内容，验证下载链路
    return {
      filename: `mock-${partId || '附件'}.txt`,
      contentType: 'text/plain',
      content: Buffer.from('mock attachment content', 'utf8')
    }
  }

  async send(_draft: OutgoingDraft): Promise<void> {
    throw unsupportedOperation('发送邮件')
  }

  async move(_uid: number, _folder: string): Promise<void> {
    throw unsupportedOperation('移动/归档邮件')
  }

  async close(): Promise<void> {
    this.connected = false
  }
}

export class MockAuthService implements AuthService {
  private emit: (e: DeviceCodeEvent) => void

  constructor(emit: (e: DeviceCodeEvent) => void) {
    this.emit = emit
  }

  async status(): Promise<AuthStatus> {
    return { loggedIn: true, email: MOCK_EMAIL }
  }

  async startDeviceCode(): Promise<DeviceCodeInfo> {
    this.emit({ type: 'started' })
    setTimeout(() => {
      this.emit({ type: 'success', email: MOCK_EMAIL })
    }, 500)
    return { userCode: 'MOCK01', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900, interval: 5 }
  }

  cancelDeviceCode(): void {}

  async logout(): Promise<void> {}

  async ensureValidToken(): Promise<{ user: string; accessToken: string }> {
    return { user: MOCK_EMAIL, accessToken: 'mock-access-token' }
  }

  async refresh(): Promise<void> {}
}

export class MockSettingsStore implements SettingsStore {
  /** mock 模式下也做内存态保存，让 E2E 能验证「保存 → 读回」的真实链路 */
  private overrides: Partial<AppSettings> = {}
  private apiKey: string | null = null
  private smtpPass: string | null = null

  async get(): Promise<AppSettings> {
    return {
      aiProvider: DEFAULT_AI_PROVIDER_ID,
      aiModel: DEEPSEEK_MODEL,
      aiCustomBaseUrl: '',
      aiBaseUrl: DEEPSEEK_BASE_URL,
      hasApiKey: this.apiKey !== null,
      syncWindow: 0,
      refreshIntervalSec: 300,
      summaryPrompt: DEFAULT_SUMMARY_PROMPT,
      autoSummarizeNew: true,
      smtpHost: DEFAULT_SMTP_HOST,
      smtpPort: DEFAULT_SMTP_PORT,
      smtpSecure: false,
      smtpUser: '',
      smtpTo: '',
      hasSmtpPass: this.smtpPass !== null,
      sendScope: true,
      theme: 'system',
      density: 'standard',
      brandName: DEFAULT_BRAND_NAME,
      brandSubtitle: DEFAULT_BRAND_SUBTITLE,
      listPageSize: DEFAULT_LIST_PAGE_SIZE,
      relativeTime: true,
      openMailMarksRead: true,
      syncOnStartup: false,
      confirmBeforeSend: false,
      askTopK: DEFAULT_ASK_TOPK,
      attachmentDir: DEFAULT_ATTACHMENT_DIR,
      autoTagEnabled: DEFAULT_AUTO_TAG,
      tagVocabulary: DEFAULT_TAG_VOCABULARY.join('、'),
      ...this.overrides
    }
  }
  async set(args: SetSettingsArgs): Promise<AppSettings> {
    if (args.aiProvider !== undefined) this.overrides.aiProvider = args.aiProvider
    if (args.aiModel !== undefined) this.overrides.aiModel = args.aiModel
    if (args.aiCustomBaseUrl !== undefined) this.overrides.aiCustomBaseUrl = args.aiCustomBaseUrl
    if (args.apiKey !== undefined) this.apiKey = args.apiKey === '' ? null : args.apiKey
    if (args.syncWindow !== undefined) this.overrides.syncWindow = args.syncWindow
    if (args.refreshIntervalSec !== undefined) this.overrides.refreshIntervalSec = args.refreshIntervalSec
    if (args.summaryPrompt !== undefined && args.summaryPrompt.trim()) this.overrides.summaryPrompt = args.summaryPrompt.trim()
    if (args.autoSummarizeNew !== undefined) this.overrides.autoSummarizeNew = args.autoSummarizeNew
    if (args.smtpHost !== undefined) this.overrides.smtpHost = args.smtpHost
    if (args.smtpPort !== undefined) this.overrides.smtpPort = args.smtpPort
    if (args.smtpSecure !== undefined) this.overrides.smtpSecure = args.smtpSecure
    if (args.theme !== undefined) this.overrides.theme = args.theme
    if (args.density !== undefined) this.overrides.density = args.density
    if (args.brandName !== undefined) this.overrides.brandName = args.brandName
    if (args.brandSubtitle !== undefined) this.overrides.brandSubtitle = args.brandSubtitle
    if (args.listPageSize !== undefined) this.overrides.listPageSize = args.listPageSize
    if (args.relativeTime !== undefined) this.overrides.relativeTime = args.relativeTime
    if (args.openMailMarksRead !== undefined) this.overrides.openMailMarksRead = args.openMailMarksRead
    if (args.syncOnStartup !== undefined) this.overrides.syncOnStartup = args.syncOnStartup
    if (args.confirmBeforeSend !== undefined) this.overrides.confirmBeforeSend = args.confirmBeforeSend
    if (args.askTopK !== undefined) this.overrides.askTopK = args.askTopK
    if (args.attachmentDir !== undefined) this.overrides.attachmentDir = args.attachmentDir
    if (args.autoTagEnabled !== undefined) this.overrides.autoTagEnabled = args.autoTagEnabled
    if (args.tagVocabulary !== undefined) this.overrides.tagVocabulary = args.tagVocabulary
    if (args.smtpUser !== undefined) this.overrides.smtpUser = args.smtpUser
    if (args.smtpTo !== undefined) this.overrides.smtpTo = args.smtpTo
    if (args.smtpPass !== undefined) this.smtpPass = args.smtpPass === '' ? null : args.smtpPass
    if (args.sendScope !== undefined) this.overrides.sendScope = args.sendScope
    return this.get()
  }
  async getApiKey(): Promise<string | null> {
    return this.apiKey
  }
  async getSmtpPass(): Promise<string | null> {
    return this.smtpPass
  }
}

export type { Logger }
