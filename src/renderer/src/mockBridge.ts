/**
 * Mock 桥：浏览器预览 / renderer E2E 用（不发起真实网络请求）。
 * 数据形状与真实 IPC 完全一致，保证 UI 逻辑可被 E2E 覆盖。
 */
import type { WindowApi } from '@shared/api'
import { DEFAULT_AI_PROVIDER_ID } from '@shared/aiProviders'
import {
  DEFAULT_ASK_TOPK,
  DEFAULT_ATTACHMENT_DIR,
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_SUBTITLE,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_SUMMARY_PROMPT
} from '@shared/defaults'
import { DEFAULT_TAG_VOCABULARY, deriveRuleTags } from '@shared/tags'
import { filterMatches, sortMails } from '@shared/views'
import { parseIndexCard } from '@shared/indexCard'
import type {
  AiAskResult,
  AiSummaryResult,
  AppSettings,
  AttachmentDownload,
  AuthStatus,
  DeviceCodeEvent,
  DeviceCodeInfo,
  MailDetail,
  MailDraft,
  MailFolder,
  MailLabel,
  MailListItem,
  NewMailEvent,
  ChatMessage,
  ChatSession,
  CollectionMail,
  CollectionSummary,
  SavedView,
  SendMailArgs,
  SendMailResult,
  SentItem,
  SetSettingsArgs,
  SyncProgress,
  SyncResult,
  WeeklyBrief
} from '@shared/types'

/** mock 用的 v5 风格摘要（短行 + 近期截止，便于 E2E 验证「决策卡」排版） */
function mockSummaryText(mail: { subject: string; fromName: string }): string {
  const d = new Date()
  d.setDate(d.getDate() + 2)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const deadline = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 23:59`
  return [
    '## 主旨',
    `${mail.subject.slice(0, 18)}：${mail.fromName} 要求本周内完成并提交`,
    '',
    '## 重要度',
    '高',
    '',
    '## 关键信息',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 截止 | ${deadline} |`,
    '| 时间 | 每周五 15:30-16:30 |',
    '| 地点/形式 | TA Office / 线上 |',
    `| 联系人 | ${mail.fromName} |`,
    '',
    '## 截止与行动项',
    `- [ ] 完成实验并提交 —— 截止：${deadline}`,
    `- [ ] 阅读课程说明 —— 截止：${deadline}`,
    '',
    '## 分类',
    '作业'
  ].join('\n')
}

/** mock 索引卡片（M1，与 main 侧模板一致） */
function mockIndexCard(mail: { subject: string; fromName: string; fromAddr: string }): string {
  const d = new Date()
  d.setDate(d.getDate() + 2)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const deadline = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 23:59`
  return [
    `[TYPE] 作业 | [COURSE] ENG1110B | [TERM] 2026R1 | [DUE] ${deadline}`,
    `[FROM] ${mail.fromAddr} | [ORG] 电子工程系`,
    '[ENTITIES] Lab 0, GraderScope, Blackboard',
    '[ALIASES] 实验一, Lab0',
    '[FACTS]',
    `- ${mail.subject.slice(0, 20)} 用 GraderScope 提交`,
    '[TAGS] 作业、实验',
    '[QUESTIONS] 这周有什么截止？ | 实验怎么提交？',
    `[QUOTE] due ${deadline}`
  ].join(String.fromCharCode(10))
}

const FROM_POOL = [
  ['Prof. 林教授', 'lin@example.edu'],
  ['教务处', 'office@link.example.edu'],
  ['图书馆', 'lib@example.edu'],
  ['IT 服务台', 'helpdesk@example.edu'],
  ['王同学', 'wang@link.example.edu']
]

const SUBJECTS = [
  '关于毕业论文进度的沟通',
  '【重要】关于选课与学费缴费的通知',
  'CSE 系周会纪要 & 下周活动安排',
  '您借阅的资源即将到期，请及时归还',
  '组队需要：CSCI 540 期末 project',
  '校园网 VPN 使用指南更新',
  '关于 LHC 讲座的笔记分享',
  'CSCI 540 作业 4 评分已出',
  '图书馆研讨室预约确认',
  '研究生院奖学金评审通知',
  '实验室安全培训安排',
  '校车时刻表调整公告',
  'Career Fair 报名提醒',
  '宿舍网络维护通知',
  '体育课选课补充说明',
  '交换项目申请截止提醒',
  '论文查重系统开放通知',
  '社团招新活动预告',
  '课程调课与补课安排',
  '学术诚信讲座报名'
]

/** 性能自测用：?count=3000 或 localStorage['mail-ai-mock-count'] 指定邮件数量（默认 20） */
function mockMailCount(): number {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('count')
    if (fromUrl) return Math.max(1, Math.min(20_000, Number.parseInt(fromUrl, 10) || 20))
    const fromStore = window.localStorage.getItem('mail-ai-mock-count')
    if (fromStore) return Math.max(1, Math.min(20_000, Number.parseInt(fromStore, 10) || 20))
  } catch {
    /* ignore */
  }
  return 20
}

function buildMails(): MailListItem[] {
  const now = Date.now()
  const total = mockMailCount()
  return Array.from({ length: total }, (_, i) => {
    const [fromName, fromAddr] = FROM_POOL[i % FROM_POOL.length]
    const uid = 100 + (total - i)
    return {
      id: uid,
      uid,
      threadId: `t-${uid}`,
      subject: SUBJECTS[i % SUBJECTS.length],
      fromName,
      fromAddr,
      dateTs: now - i * 3600_000,
      dateLabel: '',
      snippet: `这是第 ${i + 1} 封测试邮件的内容摘要，用于验证列表渲染与搜索。`,
      // 默认 20 封时前 5 封未读（E2E 依赖）；大数据量性能自测时按比例给未读
      unread: total <= 50 ? i < 5 : i < Math.min(50, Math.ceil(total / 10)),
      hasAttachments: i % 4 === 0,
      labels: [],
      starred: i % 7 === 0,
      snoozeUntil: null
    }
  })
}

export function createMockBridge(): WindowApi {
  const mails = buildMails()
  // 大数据量性能自测：只给前 300 封预置摘要与标签（真机上也是逐步生成的）
  const warmCount = Math.min(300, mails.length)
  const deviceCodeListeners = new Set<(e: DeviceCodeEvent) => void>()
  const syncListeners = new Set<(p: SyncProgress) => void>()
  // 性能自测用：把监听器集合挂到 window，便于外部注入事件风暴（tests/perf.mjs）
  const exposeListeners = (): void => {
    ;(window as unknown as { __mockListeners?: Record<string, Set<unknown>> }).__mockListeners = {
      sync: syncListeners,
      newMail: newMailListeners
    }
  }
  let loggedIn = false
  // V2 M4：内存标签状态
  let labels: MailLabel[] = []
  let nextLabelId = 1
  const mailLabels = new Map<number, number[]>()
  const starred = new Set<number>()
  const PALETTE = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#5e5ce6', '#64d2ff', '#bf5af2', '#ffd60a']
  // V2 M5：内存视图状态
  let views: SavedView[] = []
  let nextViewId = 1
  // V2 M6：内存稍后提醒状态
  const snoozes = new Map<number, number>()
  // V2 M9：内存草稿状态
  let drafts: MailDraft[] = []
  // V2.2：自动标签（mock 内存态）
  const mockTags = new Set<string>()
  const mockTagsByMail = new Map<number, string[]>()
  const mockTagExamples = new Map<number, string[]>()
  const mockManualTags = new Map<number, string[]>()
  const mockFlagged = new Set<number>()
  // V2.2：彩色类别（默认给 Gmail 同款 6 个）
  let mockCategorySeq = 1
  const mockCategories = new Map<number, { id: number; name: string; color: string }>()
  const mockMailCategory = new Map<number, number>()
  for (const [name, color] of [
    ['Blue category', '#1a73e8'],
    ['Green category', '#188038'],
    ['Orange category', '#e8710a'],
    ['Purple category', '#8430ce'],
    ['Red category', '#d93025'],
    ['Yellow category', '#f9ab00']
  ] as const) {
    mockCategories.set(mockCategorySeq, { id: mockCategorySeq, name, color })
    mockCategorySeq += 1
  }
  const mockSuppressed = new Map<number, Set<string>>()

  // 发信：内存「已发送」状态
  let sentItems: SentItem[] = []
  let nextDraftId = 1
  let savedSettings: AppSettings = {
    aiProvider: DEFAULT_AI_PROVIDER_ID,
    aiModel: 'deepseek-flash',
    aiCustomBaseUrl: '',
    aiBaseUrl: 'https://api.deepseek.com',
    hasApiKey: false,
    syncWindow: 0,
    refreshIntervalSec: 300,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    autoSummarizeNew: true,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpTo: '',
    hasSmtpPass: false,
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
    autoTagEnabled: true,
    tagVocabulary: DEFAULT_TAG_VOCABULARY.join('、')
  }
  const summaries = new Map<number, { text: string; model: string; at: number }>()
  // M1：给 AI 检索用的索引卡片（mock 内存）
  const indexDocs = new Map<number, string>()
  let mockSummaryCancelled = false
  // M4：聊天会话内存态
  let chatSessions: ChatSession[] = []
  let chatMessages: ChatMessage[] = []
  let nextChatSessionId = 1
  let nextChatMessageId = 1
  const summaryListeners = new Set<
    (p: {
      done: number
      total: number
      subject: string | null
      current?: boolean
      finished?: boolean
      cancelled?: boolean
      elapsedMs?: number
    }) => void
  >()
  const newMailListeners = new Set<(e: NewMailEvent) => void>()
  exposeListeners()

  const emitDevice = (e: DeviceCodeEvent): void => {
    for (const cb of deviceCodeListeners) cb(e)
  }
  const emitSync = (p: SyncProgress): void => {
    for (const cb of syncListeners) cb(p)
  }
  const emitSummaryProgress = (p: {
    done: number
    total: number
    subject: string | null
    current?: boolean
    finished?: boolean
    cancelled?: boolean
    elapsedMs?: number
  }): void => {
    for (const cb of summaryListeners) cb(p)
  }

  return {
    async getAuthStatus(): Promise<AuthStatus> {
      return { loggedIn, email: loggedIn ? 'demo@link.example.edu' : null }
    },
    async startDeviceCode(): Promise<DeviceCodeInfo> {
      emitDevice({ type: 'started' })
      window.setTimeout(() => {
        emitDevice({ type: 'polling', attempts: 1 })
        loggedIn = true
        window.setTimeout(() => emitDevice({ type: 'success', email: 'demo@link.example.edu' }), 400)
      }, 500)
      return { userCode: 'MOCK23', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900, interval: 5 }
    },
    onDeviceCodeEvent(cb) {
      deviceCodeListeners.add(cb)
      return () => deviceCodeListeners.delete(cb)
    },
    async logout() {
      loggedIn = false
    },
    async listMails(args) {
      const limit = args?.limit ?? 20
      const folder = args?.folder ?? 'INBOX'
      const labelIds = args?.labelIds ?? []
      const starredOnly = args?.starredOnly === true
      // mock 数据全部属于 INBOX；其他文件夹为空
      if (folder !== 'INBOX') return []
      const decorate = (m: MailListItem): MailListItem => ({
        ...m,
        labels: (mailLabels.get(m.id) ?? []).map((lid) => labels.find((l) => l.id === lid)!).filter(Boolean),
        starred: starred.has(m.id),
        snoozeUntil: snoozes.get(m.id) ?? null,
        autoTags: mockTagsByMail.get(m.id) ?? [],
        manualTags: mockManualTags.get(m.id) ?? [],
        flagged: mockFlagged.has(m.id),
        category: (() => {
          const cid = mockMailCategory.get(m.id)
          return cid !== undefined ? (mockCategories.get(cid) ?? null) : null
        })()
      })
      const decorated = mails.map(decorate)
      const autoTags = args?.autoTags ?? []
      const flaggedOnly = args?.flaggedOnly === true
      const categoryId = args?.categoryId
      let filtered = decorated.filter((m) => {
        if (categoryId !== undefined && mockMailCategory.get(m.id) !== categoryId) return false
        if (flaggedOnly && !mockFlagged.has(m.id)) return false
        if (autoTags.length > 0 && !autoTags.some((t) => (mockTagsByMail.get(m.id) ?? []).includes(t))) return false
        if (starredOnly && !starred.has(m.id)) return false
        if (labelIds.length > 0) {
          const ids = mailLabels.get(m.id) ?? []
          if (!labelIds.some((lid) => ids.includes(lid))) return false
        }
        // V2 M5：视图过滤（与真实 store 同语义）
        if (!filterMatches(m, args?.filter)) return false
        return true
      })
      if (args?.sort) filtered = sortMails(filtered, args.sort)
      return filtered.slice(0, limit)
    },
    async listFolders() {
      return [
        { path: 'INBOX', name: '收件箱' },
        { path: 'Sent', name: '已发送' },
        { path: 'Drafts', name: '草稿' }
      ]
    },
    async getMail(id) {
      const base = mails.find((m) => m.id === id)
      if (!base) throw Object.assign(new Error('邮件不存在或已被移除。'), { code: 'UNKNOWN' })
      const longText = Array.from({ length: 60 }, (_, i) => `长正文第 ${i + 1} 行：用于验证详情区滚动与滑动条显示。`).join('\n')
      const summary = summaries.get(base.id) ?? null
      const detail: MailDetail = {
        ...base,
        messageId: `<mock-${base.id}@example.edu>`,
        labels: (mailLabels.get(base.id) ?? []).map((lid) => labels.find((l) => l.id === lid)!).filter(Boolean),
        autoTags: mockTagsByMail.get(base.id) ?? [],
        manualTags: mockManualTags.get(base.id) ?? [],
        starred: starred.has(base.id),
        snoozeUntil: snoozes.get(base.id) ?? null,
        toAddrs: ['student@link.example.edu'],
        ccAddrs: [],
        bodyText: `${base.snippet}\n\n${longText}`,
        bodyHtml: `<p>${base.snippet}</p>${Array.from({ length: 60 }, (_, i) => `<p>长正文第 ${i + 1} 行：用于验证详情区滚动。</p>`).join('')}<p><a href="https://example.com/guide">查看外部文档（点击应在默认浏览器打开）</a></p><p><img src="https://example.com/tracking-pixel.png" alt="远程图片" /></p>`,
        attachments:
          base.hasAttachments
            ? [{ id: 1, filename: '非常长的附件文件名用于验证省略号显示效果_项目最终版_第3次修订_含附录与图表说明.pdf', contentType: 'application/pdf', size: 1024 * 512, partId: '2' }]
            : [],
        savedSummary: summary?.text ?? null,
        savedSummaryModel: summary?.model ?? null,
        savedSummaryAt: summary?.at ?? null
      }
      return detail
    },
    async searchMail(term) {
      const t = term.toLowerCase()
      return mails.filter((m) => `${m.subject}${m.snippet}${m.fromName}${m.fromAddr}`.toLowerCase().includes(t))
    },
    // ---- V2 M4：标签 / 星标 ----
    async listLabels() {
      return [...labels]
    },
    async createLabel(name, color) {
      const existing = labels.find((l) => l.name === name)
      if (existing) return existing
      const label: MailLabel = { id: nextLabelId++, name, color: color ?? PALETTE[(nextLabelId - 1) % PALETTE.length] }
      labels = [...labels, label]
      return label
    },
    async deleteLabel(id) {
      labels = labels.filter((l) => l.id !== id)
      for (const [mid, ids] of mailLabels) mailLabels.set(mid, ids.filter((x) => x !== id))
    },
    async setMailLabels(id, labelIds) {
      mailLabels.set(id, [...labelIds])
    },
    async toggleStar(id, on) {
      if (on) starred.add(id)
      else starred.delete(id)
    },
    // ---- V2 M5：自定义视图 ----
    async listViews() {
      return [...views]
    },
    async saveView(args) {
      if (args.id !== undefined) {
        const idx = views.findIndex((v) => v.id === args.id)
        if (idx >= 0) {
          const updated: SavedView = { ...views[idx], name: args.name, filter: args.filter, sort: args.sort }
          views = views.map((v) => (v.id === args.id ? updated : v))
          return updated
        }
      }
      const view: SavedView = { id: nextViewId++, name: args.name, filter: args.filter, sort: args.sort, createdAt: Date.now() }
      views = [...views, view]
      return view
    },
    async deleteView(id) {
      views = views.filter((v) => v.id !== id)
    },
    // ---- V2 M6：稍后提醒 ----
    async snoozeMail(id, until) {
      snoozes.set(id, until)
    },
    async cancelSnooze(id) {
      snoozes.delete(id)
    },
    // ---- V2 M7：批量操作 ----
    async bulkMarkRead(ids, read) {
      for (const id of ids) {
        const m = mails.find((x) => x.id === id)
        if (m) m.unread = !read
      }
    },
    async bulkAddLabels(ids, labelIds) {
      for (const id of ids) {
        const existing = mailLabels.get(id) ?? []
        mailLabels.set(id, [...new Set([...existing, ...labelIds])])
      }
    },
    // ---- V2 M9：草稿 ----
    async listDrafts() {
      return [...drafts].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    async saveDraft(args) {
      const now = Date.now()
      if (args.id !== undefined) {
        const idx = drafts.findIndex((d) => d.id === args.id)
        if (idx >= 0) {
          const updated: MailDraft = { ...drafts[idx], toAddrs: [...args.toAddrs], subject: args.subject, body: args.body, updatedAt: now }
          drafts = drafts.map((d) => (d.id === args.id ? updated : d))
          return updated
        }
      }
      const draft: MailDraft = { id: nextDraftId++, toAddrs: [...args.toAddrs], subject: args.subject, body: args.body, createdAt: now, updatedAt: now }
      drafts = [...drafts, draft]
      return draft
    },
    async deleteDraft(id) {
      drafts = drafts.filter((d) => d.id !== id)
    },
    async markMailRead(id, read) {
      const m = mails.find((x) => x.id === id)
      if (m) m.unread = !read
    },
    async syncMail(args?: { folders?: string[] }): Promise<SyncResult> {
      const folders = args?.folders && args.folders.length > 0 ? args.folders : ['INBOX']
      let done = 0
      emitSync({ phase: 'full', done: 0, total: mails.length })
      await new Promise<void>((resolve) => {
        const timer = window.setInterval(() => {
          done += 4
          if (done >= mails.length) {
            window.clearInterval(timer)
            emitSync({ phase: 'done', done: mails.length, total: mails.length })
            resolve()
          } else {
            emitSync({ phase: 'full', done, total: mails.length })
          }
        }, 150)
      })
      // 模拟新邮件事件（自动总结 + 通知链路，仅 INBOX）
      if (folders.includes('INBOX')) {
        const first = mails[0]
        for (const cb of newMailListeners) {
          cb({ id: first.id, uid: first.uid, subject: first.subject, fromName: first.fromName, snippet: first.snippet, summary: '## 主旨\nmock 自动总结\n\n## 重要度\n**中**' })
        }
      }
      return { synced: mails.length, mode: 'full', durationMs: 600, newUids: [], folders }
    },
    onSyncProgress(cb) {
      syncListeners.add(cb)
      return () => syncListeners.delete(cb)
    },
    onNewMail(cb) {
      newMailListeners.add(cb)
      return () => newMailListeners.delete(cb)
    },
    // ---- V2.1：一键总结未生成摘要的邮件 + 修复同步 ----
    async summarizePending(limit = 500, force = false, ids?: number[]) {
      const base =
        ids && ids.length > 0 ? mails.filter((m) => ids.includes(m.id)) : force ? mails : mails.filter((m) => !summaries.has(m.id))
      const pending = base.slice(0, limit)
      const startedAt = Date.now()
      let done = 0
      mockSummaryCancelled = false
      for (const m of pending) {
        if (mockSummaryCancelled) break
        // 先报「正在生成哪一封」，再落库（与真实主进程行为一致）
        emitSummaryProgress({
          done,
          total: pending.length,
          subject: m.subject,
          current: true,
          elapsedMs: Date.now() - startedAt
        })
        await new Promise((r) => window.setTimeout(r, 150))
        summaries.set(m.id, { text: '## 主旨\nmock 自动批量摘要\n\n## 重要度\n**低**', model: 'mock', at: Date.now() })
        const card = mockIndexCard(m)
        indexDocs.set(m.id, card)
        // 与主进程一致：批量总结时顺带写自动标签（规则 + 卡片里的 AI 标签）
        const fields = parseIndexCard(card)
        const merged = [...deriveRuleTags(fields), ...fields.tags]
        mockTagsByMail.set(m.id, merged)
        for (const t of merged) mockTags.add(t)
        done += 1
        emitSummaryProgress({ done, total: pending.length, subject: m.subject, elapsedMs: Date.now() - startedAt })
      }
      emitSummaryProgress({
        done,
        total: pending.length,
        subject: null,
        finished: true,
        cancelled: mockSummaryCancelled,
        elapsedMs: Date.now() - startedAt
      })
      return { total: pending.length, done, degraded: 0, failed: 0, cancelled: mockSummaryCancelled }
    },
    async cancelSummarize() {
      mockSummaryCancelled = true
    },
    onSummaryProgress(cb) {
      summaryListeners.add(cb)
      return () => summaryListeners.delete(cb)
    },
    async probeSendCapability() {
      // mock：假定服务器支持 XOAUTH2 但当前登录只有 IMAP 只读权限
      return {
        reachable: true,
        startTls: true,
        authMechanisms: ['XOAUTH2'],
        authOk: false,
        serverMessage: '535 5.7.3 Authentication unsuccessful [mock]',
        guidance: '⚠️ 鉴权被拒：当前登录只申请了 IMAP 只读权限；发送需要额外授权（SMTP.Send 或 Graph Mail.Send）并重新登录'
      }
    },
    async sendMail(args: { to: string; cc?: string; subject: string; body: string; inReplyTo?: string; draftId?: number }) {
      await new Promise((r) => window.setTimeout(r, 250))
      const toAddrs = String(args.to ?? '')
        .split(/[,;，；\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
      const ccAddrs = String(args.cc ?? '')
        .split(/[,;，；\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
      const ok = toAddrs.length > 0 && !toAddrs.some((a) => a.includes('fail'))
      const id = sentItems.length + 1
      sentItems.unshift({
        id,
        toAddrs,
        ccAddrs,
        subject: args.subject || '(无主题)',
        body: args.body ?? '',
        sentAt: Date.now(),
        status: ok ? 'sent' : 'failed',
        error: ok ? null : 'auth: 535 5.7.3 Authentication unsuccessful [mock]'
      })
      if (ok && args.draftId !== undefined) drafts = drafts.filter((d) => d.id !== args.draftId)
      return {
        ok,
        stage: ok ? 'done' : 'auth',
        serverMessage: ok ? '250 2.0.0 Ok: queued as MOCK [mock]' : '535 5.7.3 Authentication unsuccessful [mock]',
        conclusion: ok
          ? `✅ 测试邮件已发送到 ${toAddrs.join(', ')}，请到收件箱确认（可能在垃圾邮件里）。`
          : '❌ OAuth 鉴权被拒：登录时未同意发信权限（scope 缺 SMTP.Send），请退出后重新登录并在授权页同意。',
        sentId: id
      }
    },
    async listCollections() {
      const now = Date.now()
      const acc = new Map<string, CollectionSummary>()
      for (const [id, card] of indexDocs) {
        const doc = parseIndexCard(card)
        const mail = mails.find((m) => m.id === id)
        for (const [kind, value] of [
          ['course', doc.course],
          ['type', doc.type]
        ] as Array<['course' | 'type', string | null]>) {
          if (!value) continue
          const key = `${kind}|${value}`
          const cur = acc.get(key) ?? { kind, value, count: 0, nextDue: null, lastAt: 0 }
          cur.count += 1
          if ((mail?.dateTs ?? 0) > cur.lastAt) cur.lastAt = mail?.dateTs ?? 0
          if (doc.dueTs !== null && doc.dueTs >= now && (cur.nextDue === null || doc.dueTs < cur.nextDue)) cur.nextDue = doc.dueTs
          acc.set(key, cur)
        }
      }
      return [...acc.values()].sort((a, b) => (a.kind === b.kind ? b.count - a.count : a.kind === 'course' ? -1 : 1))
    },
    async collectionMails(kind: 'course' | 'type', value: string, limit = 200) {
      const out: CollectionMail[] = []
      for (const [id, card] of indexDocs) {
        const doc = parseIndexCard(card)
        const hit = kind === 'course' ? doc.course === value : doc.type === value
        if (!hit) continue
        const mail = mails.find((m) => m.id === id)
        out.push({
          id,
          subject: mail?.subject ?? '(无主题)',
          fromName: mail?.fromName ?? '',
          fromAddr: mail?.fromAddr ?? '',
          dateTs: mail?.dateTs ?? 0,
          dueTs: doc.dueTs,
          type: doc.type,
          course: doc.course,
          entities: doc.entities,
          aliases: doc.aliases
        })
        if (out.length >= limit) break
      }
      return out.sort((a, b) => b.dateTs - a.dateTs)
    },
    async setCollectionExcluded() {
      // mock：无需持久化（真实实现写 collection_overrides 表）
    },
    async weeklyBrief(range?: { fromTs?: number; toTs?: number }) {
      const now = new Date()
      const day = now.getDay() === 0 ? 7 : now.getDay()
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day - 1), 0, 0, 0, 0)
      const fromTs = range?.fromTs ?? monday.getTime()
      const toTs = range?.toTs ?? new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7).getTime() - 1
      const inRange = mails.filter((m) => m.dateTs >= fromTs && m.dateTs <= toTs)
      const byType = new Map<string, number>()
      const courses = new Map<string, number>()
      const dueItems: WeeklyBrief['dueItems'] = []
      let missingCards = 0
      for (const m of inRange) {
        const card = indexDocs.get(m.id)
        const doc = card ? parseIndexCard(card) : null
        if (!doc?.type) missingCards += 1
        if (doc?.type) byType.set(doc.type, (byType.get(doc.type) ?? 0) + 1)
        if (doc?.course) courses.set(doc.course, (courses.get(doc.course) ?? 0) + 1)
        if (doc?.dueTs !== null && doc?.dueTs !== undefined && doc.dueTs >= fromTs && doc.dueTs <= toTs) {
          dueItems.push({ id: m.id, subject: m.subject, dueTs: doc.dueTs, course: doc.course })
        }
      }
      dueItems.sort((a, b) => a.dueTs - b.dueTs)
      return {
        fromTs,
        toTs,
        newMails: inRange.length,
        dueItems,
        byType: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
        courses: [...courses.entries()].map(([course, count]) => ({ course, count })).sort((a, b) => b.count - a.count),
        missingCards
      }
    },
    // M4：聊天会话（mock 内存版）
    async chatSessions() {
      return chatSessions.map((s) => ({
        ...s,
        messageCount: chatMessages.filter((m) => m.sessionId === s.id).length
      }))
    },
    async chatMessages(sessionId: number) {
      return chatMessages.filter((m) => m.sessionId === sessionId)
    },
    async newChatSession() {
      const id = nextChatSessionId++
      const now = Date.now()
      chatSessions.unshift({ id, title: '新对话', createdAt: now, updatedAt: now, messageCount: 0 })
      return id
    },
    async deleteChatSession(sessionId: number) {
      chatSessions = chatSessions.filter((s) => s.id !== sessionId)
      chatMessages = chatMessages.filter((m) => m.sessionId !== sessionId)
    },
    async renameChatSession(sessionId: number, title: string) {
      const s2 = chatSessions.find((s) => s.id === sessionId)
      if (s2) s2.title = title
    },
    async chatAsk(sessionId: number, question: string, _topK?: number) {
      const now = Date.now()
      const userMsg = { id: nextChatMessageId++, sessionId, role: 'user' as const, content: question, citations: [], createdAt: now }
      chatMessages.push(userMsg)
      const session = chatSessions.find((s) => s.id === sessionId)
      if (session) {
        session.updatedAt = now
        if (chatMessages.filter((m) => m.sessionId === sessionId).length === 1) session.title = question.slice(0, 40)
      }
      // mock 回答：能力类问题直接答能力，其余给一段基于已有摘要/索引的示意回答（带引用，覆盖引用跳转链路）
      const capability = /能不能|可以|你是谁|功能|知识库|怎么用/.test(question)
      const t = question.toLowerCase()
      const hits = mails.filter(
        (m) =>
          `${m.subject}${m.snippet}${m.fromName}${m.fromAddr}`.toLowerCase().includes('导师') ||
          t.includes(m.subject.toLowerCase().slice(0, 4)) ||
          t.includes(m.fromName.toLowerCase())
      )
      const top = (hits.length ? hits : mails.slice(0, 2)).slice(0, 3)
      const answer = capability
        ? [
            '我可以读取本地已同步的邮件、检索索引卡片与知识库集合（按课程/类型聚合），也能看 AI 摘要。',
            '',
            '- 不会访问互联网、不会读取未同步邮件',
            '- 不会发信，也不会修改服务器上的邮件',
            '- 回答邮件内容时只依据检索结果，找不到就说未找到'
          ].join('\n')
        : `（mock 回答）根据你的收件箱检索到 ${top.length} 封相关邮件。${
            question.includes('导师') ? '上周「林教授」发来一封与毕业论文进度相关的邮件，建议周五前回复。' : '详情请见引用邮件。'
          }${top[0] ? `

最相关的是「${top[0].subject}」。` : ''}`
      await new Promise((r) => window.setTimeout(r, 300))
      const assistantMsg = {
        id: nextChatMessageId++,
        sessionId,
        role: 'assistant' as const,
        content: answer,
        citations: capability
          ? []
          : top.map((m) => ({ id: m.id, subject: m.subject, fromName: m.fromName, dateTs: m.dateTs })),
        createdAt: Date.now()
      }
      chatMessages.push(assistantMsg)
      return assistantMsg
    },
    async indexStats() {
      // mock：索引卡片随摘要一起写入，因此覆盖数 = 已有摘要的邮件数
      return { total: mails.length, missing: Math.max(0, mails.length - summaries.size) }
    },
    async listSentItems(limit = 200) {
      return sentItems.slice(0, limit)
    },
    async deleteSentItem(id: number) {
      sentItems = sentItems.filter((s) => s.id !== id)
    },
    async sendTestMail(args: { mode?: 'personal' | 'school'; to?: string; subject?: string; text?: string }) {
      // mock：不发真邮件，只回一个成功结论（E2E 用）
      await new Promise((r) => window.setTimeout(r, 200))
      if (args?.mode === 'school') {
        if (!savedSettings.sendScope) {
          return {
            ok: false,
            stage: 'auth',
            serverMessage: '535 5.7.3 Authentication unsuccessful [mock]',
            conclusion:
              '❌ OAuth 鉴权被拒：登录时未同意发信权限（scope 缺 SMTP.Send），请退出后重新登录并在授权页同意。'
          }
        }
        return {
          ok: true,
          stage: 'done',
          serverMessage: '250 2.0.0 Ok: queued as MOCK [mock]',
          conclusion: '✅ 测试邮件已发送到 1***@link.example.edu，请到收件箱确认（可能在垃圾邮件里）。'
        }
      }
      const to = args?.to ?? savedSettings.smtpTo ?? savedSettings.smtpUser ?? 'me@example.com'
      return {
        ok: true,
        stage: 'done',
        serverMessage: '250 2.0.0 Ok: queued as MOCK [mock]',
        conclusion: `✅ 测试邮件已发送到 ${to}，请到收件箱确认（可能在垃圾邮件里）。`
      }
    },
    async resyncMail() {
      // mock 无服务端：仅模拟一次「立即重扫」
      emitSync({ phase: 'incremental', done: 0, total: mails.length })
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300))
      emitSync({ phase: 'done', done: mails.length, total: mails.length })
    },
    async getSettings(): Promise<AppSettings> {
      return { ...savedSettings }
    },
    async saveSettings(args: SetSettingsArgs): Promise<AppSettings> {
      if (args.aiProvider !== undefined) savedSettings.aiProvider = args.aiProvider
      if (args.aiModel !== undefined) savedSettings.aiModel = args.aiModel
      if (args.aiCustomBaseUrl !== undefined) savedSettings.aiCustomBaseUrl = args.aiCustomBaseUrl
      if (args.syncWindow !== undefined) savedSettings.syncWindow = args.syncWindow
      if (args.refreshIntervalSec !== undefined) savedSettings.refreshIntervalSec = args.refreshIntervalSec
      if (args.summaryPrompt !== undefined) savedSettings.summaryPrompt = args.summaryPrompt
      if (args.autoSummarizeNew !== undefined) savedSettings.autoSummarizeNew = args.autoSummarizeNew
      if (args.apiKey !== undefined && args.apiKey !== '') savedSettings.hasApiKey = true
      if (args.apiKey === '') savedSettings.hasApiKey = false
      // V2.2 外观 / 行为
      if (args.theme !== undefined) savedSettings.theme = args.theme
      if (args.density !== undefined) savedSettings.density = args.density
      if (args.brandName !== undefined) savedSettings.brandName = args.brandName
      if (args.brandSubtitle !== undefined) savedSettings.brandSubtitle = args.brandSubtitle
      if (args.listPageSize !== undefined) savedSettings.listPageSize = args.listPageSize
      if (args.relativeTime !== undefined) savedSettings.relativeTime = args.relativeTime
      if (args.openMailMarksRead !== undefined) savedSettings.openMailMarksRead = args.openMailMarksRead
      if (args.syncOnStartup !== undefined) savedSettings.syncOnStartup = args.syncOnStartup
      if (args.confirmBeforeSend !== undefined) savedSettings.confirmBeforeSend = args.confirmBeforeSend
      if (args.askTopK !== undefined) savedSettings.askTopK = args.askTopK
      if (args.attachmentDir !== undefined) savedSettings.attachmentDir = args.attachmentDir
      if (args.autoTagEnabled !== undefined) savedSettings.autoTagEnabled = args.autoTagEnabled
      if (args.tagVocabulary !== undefined) savedSettings.tagVocabulary = args.tagVocabulary
      if (args.sendScope !== undefined) savedSettings.sendScope = args.sendScope
      return { ...savedSettings }
    },
    async summarizeMail(id: number): Promise<AiSummaryResult> {
      const mail = mails.find((m) => m.id === id)
      if (!mail) throw Object.assign(new Error('邮件不存在或已被移除。'), { code: 'UNKNOWN' })
      await new Promise((r) => window.setTimeout(r, 600))
      const model = savedSettings.aiModel
      const text = mockSummaryText(mail)
      summaries.set(id, { text, model, at: Date.now() })
      const card = mockIndexCard(mail)
      indexDocs.set(id, card)
      const fields = parseIndexCard(card)
      const derived = deriveRuleTags(fields)
      // mock 里把 AI 标签与规则标签合并成一个集合（真实主进程按来源分开存）
      const merged = [...derived, ...fields.tags]
      mockTagsByMail.set(id, merged)
      for (const t of merged) mockTags.add(t)
      return { text, threadId: mail.threadId, messageCount: 1, model, savedAtMs: Date.now() }
    },
    async askInbox(question: string): Promise<AiAskResult> {
      await new Promise((r) => window.setTimeout(r, 600))
      const t = question.toLowerCase()
      const hits = mails.filter((m) => `${m.subject}${m.snippet}${m.fromName}${m.fromAddr}`.toLowerCase().includes('导师') || t.includes(m.subject.toLowerCase().slice(0, 4)) || t.includes(m.fromName.toLowerCase()))
      const top = (hits.length ? hits : mails.slice(0, 2)).slice(0, 3)
      return {
        answer: `（mock 回答）根据你的收件箱检索到 ${top.length} 封相关邮件。${question.includes('导师') ? '上周「林教授」发来一封与毕业论文进度相关的邮件，建议周五前回复。' : '详情请见引用邮件。'}`,
        citations: top.map((m) => ({ id: m.id, subject: m.subject, fromName: m.fromName, dateTs: m.dateTs })),
        model: savedSettings.aiModel
      }
    },
    // V2.2：自动标签（mock：内存版）
    async listCategories() {
      return [...mockCategories.values()]
    },
    async categoryCounts() {
      return [...mockCategories.values()].map((c) => ({
        ...c,
        count: [...mockMailCategory.values()].filter((cid) => cid === c.id).length
      }))
    },
    async createCategory(name: string, color: string) {
      const existing = [...mockCategories.values()].find((c) => c.name === name)
      if (existing) return existing
      const cat = { id: mockCategorySeq++, name, color }
      mockCategories.set(cat.id, cat)
      return cat
    },
    async updateCategory(id: number, patch: { name?: string; color?: string }) {
      const cur = mockCategories.get(id)
      if (cur) mockCategories.set(id, { ...cur, ...patch })
    },
    async deleteCategory(id: number) {
      mockCategories.delete(id)
      for (const [mid, cid] of mockMailCategory) if (cid === id) mockMailCategory.delete(mid)
    },
    async setMailCategory(messageId: number, categoryId: number | null) {
      if (categoryId === null) mockMailCategory.delete(messageId)
      else mockMailCategory.set(messageId, categoryId)
    },
    async setFlagged(id: number, flagged: boolean) {
      if (flagged) mockFlagged.add(id)
      else mockFlagged.delete(id)
    },
    async countMails(args?: { folder?: string; autoTags?: string[]; starredOnly?: boolean; labelIds?: number[] }) {
      const list = await this.listMails({ ...args, limit: 100000, offset: 0 })
      return list.length
    },
    async tagCounts() {
      // 与主进程一致：按「每封邮件实际持有的标签」统计（DISTINCT message_id）
      const counts = new Map<string, { count: number; manual: boolean }>()
      for (const [id, tags] of mockTagsByMail) {
        const manual = new Set(mockManualTags.get(id) ?? [])
        for (const t of new Set(tags)) {
          const cur = counts.get(t) ?? { count: 0, manual: false }
          counts.set(t, { count: cur.count + 1, manual: cur.manual || manual.has(t) })
        }
      }
      return [...counts.entries()]
        .map(([tag, v]) => ({ tag, count: v.count, manual: v.manual }))
        .sort((a, b) => b.count - a.count)
    },
    async tagExamples() {
      return [...mockTagExamples.entries()].map(([id, tags]) => ({
        id,
        subject: mails.find((m) => m.id === id)?.subject ?? '(无主题)',
        tags
      }))
    },
    async setMailTagManual(messageId: number, tag: string, on: boolean) {
      const cur = mockTagsByMail.get(messageId) ?? []
      const manual = mockManualTags.get(messageId) ?? []
      if (on) {
        mockSuppressed.get(messageId)?.delete(tag)
        if (!cur.includes(tag)) mockTagsByMail.set(messageId, [...cur, tag])
        if (!manual.includes(tag)) mockManualTags.set(messageId, [...manual, tag])
        mockTags.add(tag)
      } else {
        mockTagsByMail.set(messageId, cur.filter((t) => t !== tag))
        mockManualTags.set(messageId, manual.filter((t) => t !== tag))
        const set = mockSuppressed.get(messageId) ?? new Set<string>()
        set.add(tag)
        mockSuppressed.set(messageId, set)
      }
    },
    async setTagExample(messageId: number, tags: string[]) {
      if (tags.length === 0) mockTagExamples.delete(messageId)
      else mockTagExamples.set(messageId, [...tags])
    },
    async rebuildTags() {
      // mock：按索引卡片字段推导规则标签（与主进程同一套纯函数）
      let n = 0
      for (const [id, card] of indexDocs) {
        const fields = parseIndexCard(card)
        const manual = mockManualTags.get(id) ?? []
        const suppressed = mockSuppressed.get(id) ?? new Set<string>()
        // 手动标签保留 + 规则/AI 标签重新推导（跳过硬抑制的）——与主进程同语义
        const merged = [...new Set([...manual, ...deriveRuleTags(fields), ...fields.tags])].filter(
          (t) => !suppressed.has(t) || manual.includes(t)
        )
        mockTagsByMail.set(id, merged)
        for (const t of merged) mockTags.add(t)
        n += 1
      }
      return n
    },
    // V2.2：附件保存（mock：不落盘，返回一个假路径）
    async saveAttachment(id: number, partId: string) {
      await new Promise((r) => window.setTimeout(r, 200))
      const filename = `${(partId || 'attachment').replace(/[^\w.-]/g, '_')}.txt`
      const dir = savedSettings.attachmentDir || 'C:\Users\demo\Downloads'
      return { saved: true, path: `${dir}\${filename}`, filename }
    },
    async pickDirectory() {
      return savedSettings.attachmentDir || 'C:\Users\demo\Downloads'
    },
    async openPath() {
      /* mock：不做任何事 */
    },
    async downloadAttachment(id, partId) {
      await new Promise((r) => window.setTimeout(r, 300))
      const mail = mails.find((m) => m.id === id)
      return {
        filename: `${partId || '附件'}-${mail?.subject ?? 'mail'}.txt`,
        contentType: 'text/plain',
        dataBase64: btoa('mock attachment content')
      }
    },
    async openExternal() {
      console.info('[mock] openExternal')
    }
  }
}
