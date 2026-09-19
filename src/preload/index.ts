/**
 * preload —— 经 contextBridge 暴露白名单 API（规范 §6.9）。
 * - renderer 禁止直接拿 Node / ipcRenderer，只能走 window.api；
 * - 本文件不 import 任何依赖包（sandbox 下 preload 只能用 electron + 内置能力）。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-contract'
import type { WindowApi } from '../shared/api'
import type {
  AiAskResult,
  AiSummaryResult,
  AppSettings,
  AttachmentDownload,
  AttachmentSaveResult,
  TagExample,
  AuthStatus,
  DeviceCodeEvent,
  DeviceCodeInfo,
  IpcResult,
  MailDetail,
  MailDraft,
  MailFolder,
  MailLabel,
  MailListItem,
  MailCategory,
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
  WeeklyBrief,
  ViewFilter,
  ViewSort
} from '../shared/types'

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>
  if (!result.ok) {
    const err = new Error(result.error.message) as Error & { code?: string }
    err.code = result.error.code
    throw err
  }
  return result.data
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: WindowApi = {
  getAuthStatus: (): Promise<AuthStatus> => invoke(IPC_CHANNELS.AUTH_STATUS),
  startDeviceCode: (): Promise<DeviceCodeInfo> => invoke(IPC_CHANNELS.AUTH_DEVICE_CODE),
  onDeviceCodeEvent: (cb: (event: DeviceCodeEvent) => void): (() => void) =>
    subscribe(IPC_CHANNELS.AUTH_DEVICE_CODE_EVENT, cb),
  logout: (): Promise<void> => invoke(IPC_CHANNELS.AUTH_LOGOUT),
  listMails: (args?: {
    limit?: number
    offset?: number
    folder?: string
    labelIds?: number[]
    starredOnly?: boolean
    filter?: ViewFilter
    sort?: ViewSort
    autoTags?: string[]
  }): Promise<MailListItem[]> =>
    invoke(IPC_CHANNELS.MAIL_LIST, args ?? {}),
  listFolders: (): Promise<MailFolder[]> => invoke(IPC_CHANNELS.MAIL_LIST_FOLDERS),
  getMail: (id: number): Promise<MailDetail> => invoke(IPC_CHANNELS.MAIL_GET, { id }),
  searchMail: (term: string): Promise<MailListItem[]> => invoke(IPC_CHANNELS.MAIL_SEARCH, { term }),
  markMailRead: (id: number, read: boolean): Promise<void> => invoke(IPC_CHANNELS.MAIL_MARK_READ, { id, read }),
  downloadAttachment: (id: number, partId: string): Promise<AttachmentDownload> =>
    invoke(IPC_CHANNELS.MAIL_GET_ATTACHMENT, { id, partId }),
  saveAttachment: (id: number, partId: string): Promise<AttachmentSaveResult> =>
    invoke(IPC_CHANNELS.MAIL_ATTACHMENT_SAVE, { id, partId }),
  listCategories: (): Promise<MailCategory[]> => invoke(IPC_CHANNELS.CATEGORIES_LIST),
  categoryCounts: (): Promise<Array<{ id: number; name: string; color: string; count: number }>> =>
    invoke(IPC_CHANNELS.CATEGORIES_COUNTS),
  createCategory: (name: string, color: string): Promise<MailCategory> =>
    invoke(IPC_CHANNELS.CATEGORIES_CREATE, { name, color }),
  updateCategory: (id: number, patch: { name?: string; color?: string }): Promise<void> =>
    invoke(IPC_CHANNELS.CATEGORIES_UPDATE, { id, ...patch }),
  deleteCategory: (id: number): Promise<void> => invoke(IPC_CHANNELS.CATEGORIES_DELETE, { id }),
  setMailCategory: (messageId: number, categoryId: number | null): Promise<void> =>
    invoke(IPC_CHANNELS.MAIL_SET_CATEGORY, { messageId, categoryId }),
  setFlagged: (id: number, flagged: boolean): Promise<void> =>
    invoke(IPC_CHANNELS.MAIL_SET_FLAGGED, { id, flagged }),
  countMails: (args?: Record<string, unknown>): Promise<number> => invoke(IPC_CHANNELS.MAIL_COUNT, args ?? {}),
  /** 日历：取某时间范围内的事件（截止 + 卡片里的日期） */
  listEvents: (args: { from: number; to: number }): Promise<import('../shared/calendar').CalendarEvent[]> =>
    invoke(IPC_CHANNELS.MAIL_LIST_EVENTS, args),
  tagCounts: (): Promise<Array<{ tag: string; count: number }>> => invoke(IPC_CHANNELS.TAGS_COUNTS),
  tagExamples: (): Promise<TagExample[]> => invoke(IPC_CHANNELS.TAGS_EXAMPLES),
  setMailTagManual: (messageId: number, tag: string, on: boolean): Promise<void> =>
    invoke(IPC_CHANNELS.TAGS_SET_MANUAL, { messageId, tag, on }),
  setTagExample: (messageId: number, tags: string[]): Promise<void> =>
    invoke(IPC_CHANNELS.TAGS_EXAMPLE_SET, { messageId, tags }),
  rebuildTags: (): Promise<number> => invoke(IPC_CHANNELS.TAGS_REBUILD),
  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    invoke(IPC_CHANNELS.SHELL_PICK_DIRECTORY, defaultPath ? { defaultPath } : {}),
  openPath: (path: string): Promise<void> => invoke(IPC_CHANNELS.SHELL_OPEN_PATH, { path }),
  syncMail: (args?: { folders?: string[] }): Promise<SyncResult> => invoke(IPC_CHANNELS.MAIL_SYNC, args ?? {}),
  onSyncProgress: (cb: (progress: SyncProgress) => void): (() => void) => subscribe(IPC_CHANNELS.MAIL_SYNC_EVENT, cb),
  onNewMail: (cb: (event: NewMailEvent) => void): (() => void) => subscribe(IPC_CHANNELS.MAIL_NEW_EVENT, cb),
  summarizeMail: (id: number): Promise<AiSummaryResult> => invoke(IPC_CHANNELS.AI_SUMMARIZE, { id }),
  askInbox: (question: string): Promise<AiAskResult> => invoke(IPC_CHANNELS.AI_ASK_INBOX, { question }),
  chatSessions: (): Promise<ChatSession[]> => invoke(IPC_CHANNELS.AI_CHAT_SESSIONS),
  chatMessages: (sessionId: number): Promise<ChatMessage[]> => invoke(IPC_CHANNELS.AI_CHAT_MESSAGES, { sessionId }),
  newChatSession: (): Promise<number> => invoke(IPC_CHANNELS.AI_CHAT_NEW),
  deleteChatSession: (sessionId: number): Promise<void> => invoke(IPC_CHANNELS.AI_CHAT_DELETE, { sessionId }),
  renameChatSession: (sessionId: number, title: string): Promise<void> =>
    invoke(IPC_CHANNELS.AI_CHAT_RENAME, { sessionId, title }),
  chatAsk: (sessionId: number, question: string, topK?: number): Promise<ChatMessage> =>
    invoke(IPC_CHANNELS.AI_CHAT_ASK, { sessionId, question, topK }),
  summarizePending: (
    limit?: number,
    force?: boolean,
    ids?: number[]
  ): Promise<{ total: number; done: number; degraded: number; failed: number; cancelled?: boolean }> =>
    invoke(IPC_CHANNELS.AI_SUMMARIZE_PENDING, { limit, force, ids }),
  cancelSummarize: (): Promise<void> => invoke(IPC_CHANNELS.AI_CANCEL_SUMMARIZE),
  onSummaryProgress: (
    cb: (p: {
      done: number
      total: number
      subject: string | null
      current?: boolean
      finished?: boolean
      cancelled?: boolean
      elapsedMs?: number
    }) => void
  ): (() => void) => subscribe(IPC_CHANNELS.AI_SUMMARY_PROGRESS, cb),
  resyncMail: (folder?: string): Promise<void> => invoke(IPC_CHANNELS.MAIL_RESYNC, { folder }),
  probeSendCapability: (): Promise<{
    reachable: boolean
    startTls: boolean
    authMechanisms: string[]
    authOk: boolean
    serverMessage: string
    guidance: string
    userDataDir?: string
  }> => invoke(IPC_CHANNELS.MAIL_SEND_PROBE),
  sendTestMail: (args: { mode?: 'personal' | 'school'; to?: string; subject?: string; text?: string }): Promise<{
    ok: boolean
    stage: string
    serverMessage: string
    conclusion: string
  }> => invoke(IPC_CHANNELS.MAIL_SEND_TEST, args),
  sendMail: (args: SendMailArgs): Promise<SendMailResult> => invoke(IPC_CHANNELS.MAIL_SEND, args),
  indexStats: (): Promise<{ total: number; missing: number }> => invoke(IPC_CHANNELS.MAIL_INDEX_STATS),
  listCollections: (): Promise<CollectionSummary[]> => invoke(IPC_CHANNELS.KB_COLLECTIONS),
  collectionMails: (kind: 'course' | 'type', value: string, limit?: number): Promise<CollectionMail[]> =>
    invoke(IPC_CHANNELS.KB_COLLECTION_MAILS, { kind, value, limit }),
  setCollectionExcluded: (messageId: number, kind: 'course' | 'type', value: string, exclude: boolean): Promise<void> =>
    invoke(IPC_CHANNELS.KB_COLLECTION_EXCLUDE, { messageId, kind, value, exclude }),
  weeklyBrief: (range?: { fromTs?: number; toTs?: number }): Promise<WeeklyBrief> =>
    invoke(IPC_CHANNELS.KB_WEEKLY_BRIEF, range ?? {}),
  listSentItems: (limit?: number): Promise<SentItem[]> => invoke(IPC_CHANNELS.MAIL_SENT_LIST, { limit }),
  deleteSentItem: (id: number): Promise<void> => invoke(IPC_CHANNELS.MAIL_SENT_DELETE, { id }),
  listLabels: (): Promise<MailLabel[]> => invoke(IPC_CHANNELS.LABELS_LIST),
  createLabel: (name: string, color?: string): Promise<MailLabel> => invoke(IPC_CHANNELS.LABELS_CREATE, { name, color }),
  deleteLabel: (id: number): Promise<void> => invoke(IPC_CHANNELS.LABELS_DELETE, { id }),
  setMailLabels: (id: number, labelIds: number[]): Promise<void> => invoke(IPC_CHANNELS.MAIL_SET_LABELS, { id, labelIds }),
  toggleStar: (id: number, starred: boolean): Promise<void> => invoke(IPC_CHANNELS.MAIL_TOGGLE_STAR, { id, starred }),
  listViews: (): Promise<SavedView[]> => invoke(IPC_CHANNELS.VIEWS_LIST),
  saveView: (args: { id?: number; name: string; filter: ViewFilter; sort: ViewSort }): Promise<SavedView> =>
    invoke(IPC_CHANNELS.VIEWS_SAVE, args),
  deleteView: (id: number): Promise<void> => invoke(IPC_CHANNELS.VIEWS_DELETE, { id }),
  snoozeMail: (id: number, until: number, note?: string): Promise<void> =>
    invoke(IPC_CHANNELS.MAIL_SNOOZE, { id, until, note }),
  cancelSnooze: (id: number): Promise<void> => invoke(IPC_CHANNELS.MAIL_CANCEL_SNOOZE, { id }),
  bulkMarkRead: (ids: number[], read: boolean): Promise<void> => invoke(IPC_CHANNELS.MAIL_BULK_READ, { ids, read }),
  bulkAddLabels: (ids: number[], labelIds: number[]): Promise<void> => invoke(IPC_CHANNELS.MAIL_BULK_LABEL, { ids, labelIds }),
  listDrafts: (): Promise<MailDraft[]> => invoke(IPC_CHANNELS.DRAFTS_LIST),
  saveDraft: (args: { id?: number; toAddrs: string[]; subject: string; body: string }): Promise<MailDraft> =>
    invoke(IPC_CHANNELS.DRAFTS_SAVE, args),
  deleteDraft: (id: number): Promise<void> => invoke(IPC_CHANNELS.DRAFTS_DELETE, { id }),
  getSettings: (): Promise<AppSettings> => invoke(IPC_CHANNELS.SETTINGS_GET),
  saveSettings: (args: SetSettingsArgs): Promise<AppSettings> => invoke(IPC_CHANNELS.SETTINGS_SET, args),
  openExternal: (url: string): Promise<void> => invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, { url })
}

contextBridge.exposeInMainWorld('api', api)
