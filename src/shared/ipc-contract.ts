/**
 * IPC 契约单一事实来源（规范 §14.4）：
 * 只放 channel 常量与请求/响应类型；zod schema 在 ipc-schemas.ts（主进程专用）。
 * 渲染进程禁止手写 ipcRenderer.invoke("字符串")，一律经 preload 的 window.api。
 */
import type { ViewFilter, ViewSort } from './types'

export const IPC_CHANNELS = {
  AUTH_STATUS: 'auth:status',
  AUTH_DEVICE_CODE: 'auth:device-code',
  AUTH_DEVICE_CODE_EVENT: 'auth:device-code:event',
  AUTH_LOGOUT: 'auth:logout',
  MAIL_LIST: 'mail:list',
  MAIL_LIST_FOLDERS: 'mail:list-folders',
  MAIL_GET: 'mail:get',
  MAIL_SEARCH: 'mail:search',
  MAIL_MARK_READ: 'mail:mark-read',
  MAIL_GET_ATTACHMENT: 'mail:get-attachment',
  MAIL_SYNC: 'mail:sync',
  MAIL_SYNC_EVENT: 'mail:sync:event',
  MAIL_NEW_EVENT: 'mail:new-event',
  LABELS_LIST: 'labels:list',
  LABELS_CREATE: 'labels:create',
  LABELS_DELETE: 'labels:delete',
  MAIL_SET_LABELS: 'mail:set-labels',
  MAIL_TOGGLE_STAR: 'mail:toggle-star',
  VIEWS_LIST: 'views:list',
  VIEWS_SAVE: 'views:save',
  VIEWS_DELETE: 'views:delete',
  MAIL_SNOOZE: 'mail:snooze',
  MAIL_CANCEL_SNOOZE: 'mail:snooze:cancel',
  MAIL_BULK_READ: 'mail:bulk-read',
  MAIL_BULK_LABEL: 'mail:bulk-label',
  DRAFTS_LIST: 'drafts:list',
  DRAFTS_SAVE: 'drafts:save',
  DRAFTS_DELETE: 'drafts:delete',
  AI_SUMMARIZE: 'ai:summarize',
  /** 一键总结所有未生成摘要的邮件（V2.1） */
  AI_SUMMARIZE_PENDING: 'ai:summarize-pending',
  /** 批量总结进度事件 */
  AI_SUMMARY_PROGRESS: 'ai:summary:progress',
  /** 取消正在进行的批量总结 */
  AI_CANCEL_SUMMARIZE: 'ai:cancel-summarize',
  /** 修复同步：同步游标回退到本地实际最大 UID，重新拉取缺失邮件（V2.1） */
  MAIL_RESYNC: 'mail:resync',
  /** 发送能力自检（只检测、不发送邮件） */
  MAIL_SEND_PROBE: 'mail:send-probe',
  /** 个人邮箱发信测试（SMTP，真的发一封测试邮件） */
  MAIL_SEND_TEST: 'mail:send-test',
  /** 真正发信（回复/转发/草稿发送/新写）：学校账号走 SMTP + OAuth，个人邮箱走应用密码 */
  MAIL_SEND: 'mail:send',
  /** 检索索引卡片覆盖情况（M1：给设置页显示「索引 x/y 封」） */
  MAIL_INDEX_STATS: 'mail:index-stats',
  /** 知识库集合列表（M3：课程 / 类型，由索引卡片派生） */
  KB_COLLECTIONS: 'kb:collections',
  /** 某个集合里的邮件（M3） */
  KB_COLLECTION_MAILS: 'kb:collection-mails',
  /** 把邮件移出/移回集合（手动修正；M3） */
  KB_COLLECTION_EXCLUDE: 'kb:collection-exclude',
  /** 本周简报（M3：聚合，不调模型） */
  KB_WEEKLY_BRIEF: 'kb:weekly-brief',
  /** 本地「已发送」列表 */
  MAIL_SENT_LIST: 'mail:sent-list',
  /** 删除一条已发送记录 */
  MAIL_SENT_DELETE: 'mail:sent-delete',
  AI_ASK_INBOX: 'ai:ask-inbox',
  /** 彩色类别（V2.2，Gmail 风格） */
  CATEGORIES_LIST: 'categories:list',
  CATEGORIES_COUNTS: 'categories:counts',
  CATEGORIES_CREATE: 'categories:create',
  CATEGORIES_UPDATE: 'categories:update',
  CATEGORIES_DELETE: 'categories:delete',
  MAIL_SET_CATEGORY: 'mail:set-category',
  /** 红旗（V2.2）：设置/取消后续标记 */
  MAIL_SET_FLAGGED: 'mail:set-flagged',
  /** 当前筛选条件下的邮件总数（V2.2：列表只取前 N 封，但角标要显示真实总数） */
  MAIL_COUNT: 'mail:count',
  /** 日历：某时间范围内的事件（截止 + 卡片里提到的日期） */
  MAIL_LIST_EVENTS: 'mail:list-events',
  /** 自动标签（V2.2：A 规则映射 + B AI 主题标签 + 示例邮件） */
  TAGS_COUNTS: 'tags:counts',
  TAGS_EXAMPLES: 'tags:examples',
  TAGS_EXAMPLE_SET: 'tags:example-set',
  /** 手动给某封邮件加/去标签（永不被自动重算覆盖） */
  TAGS_SET_MANUAL: 'tags:set-manual',
  TAGS_REBUILD: 'tags:rebuild',
  /** 附件保存（V2.2：主进程决定落盘位置并写文件；可配置固定目录） */
  MAIL_ATTACHMENT_SAVE: 'mail:attachment-save',
  /** 选择目录（设置里指定附件保存位置） */
  SHELL_PICK_DIRECTORY: 'shell:pick-directory',
  /** 在文件管理器中打开某个路径 */
  SHELL_OPEN_PATH: 'shell:open-path',
  /** AI 助手聊天会话（M4：聊天式界面） */
  AI_CHAT_SESSIONS: 'ai:chat-sessions',
  AI_CHAT_MESSAGES: 'ai:chat-messages',
  AI_CHAT_NEW: 'ai:chat-new',
  AI_CHAT_DELETE: 'ai:chat-delete',
  AI_CHAT_RENAME: 'ai:chat-rename',
  /** 带会话的多轮提问（自动保存消息到会话） */
  AI_CHAT_ASK: 'ai:chat-ask',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SHELL_OPEN_EXTERNAL: 'shell:open-external'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export interface ListMailsArgs {
  limit?: number
  offset?: number
  /** 文件夹过滤（V2 M3；缺省 INBOX） */
  folder?: string
  /** 标签过滤（V2 M4）：任一命中即包含 */
  labelIds?: number[]
  /** 只看星标（V2 M4） */
  starredOnly?: boolean
  /** 视图过滤（V2 M5） */
  filter?: ViewFilter
  /** 视图排序（V2 M5） */
  sort?: ViewSort
  /** 只看红旗（V2.2） */
  flaggedOnly?: boolean
  /** 只看未读（V2.2，未读筛选移到文件夹列表） */
  unreadOnly?: boolean
  /** 按彩色类别筛选（V2.2） */
  categoryId?: number
  /** 自动标签过滤（V2.2；多标签 OR） */
  autoTags?: string[]
}

export interface SyncMailArgs {
  /** 要同步的文件夹列表（V2 M3；缺省 ['INBOX']） */
  folders?: string[]
}

export interface GetMailArgs {
  id: number
}

export interface SearchMailArgs {
  term: string
}

export interface AskInboxArgs {
  question: string
}

export interface MarkReadArgs {
  id: number
  read: boolean
}

export interface GetAttachmentArgs {
  id: number
  partId: string
}

export interface CreateLabelArgs {
  name: string
  color?: string
}

export interface DeleteLabelArgs {
  id: number
}

export interface SetMailLabelsArgs {
  id: number
  labelIds: number[]
}

export interface ToggleStarArgs {
  id: number
  starred: boolean
}

export interface SaveViewArgs {
  /** 带 id = 覆盖同名视图 */
  id?: number
  name: string
  filter: ViewFilter
  sort: ViewSort
}

export interface DeleteViewArgs {
  id: number
}

export interface SnoozeMailArgs {
  id: number
  /** 提醒时间（ms 时间戳，必须晚于当前时间） */
  until: number
  /** 可选备注 */
  note?: string
}

export interface CancelSnoozeArgs {
  id: number
}

export interface BulkReadArgs {
  ids: number[]
  read: boolean
}

export interface BulkLabelArgs {
  ids: number[]
  /** 批量「加标签」= 并入现有标签（非覆盖） */
  labelIds: number[]
}

export interface SaveDraftArgs {
  /** 带 id = 覆盖该草稿 */
  id?: number
  toAddrs: string[]
  subject: string
  body: string
}

export interface DeleteDraftArgs {
  id: number
}

export interface SummarizePendingArgs {
  /** 本次最多总结多少封（默认 30，上限 200） */
  limit?: number
}

export interface ResyncArgs {
  /** 要修复的文件夹（缺省 INBOX） */
  folder?: string
}

export interface OpenExternalArgs {
  url: string
}

export interface SetSettingsArgs {
  aiModel?: string
  apiKey?: string
  syncWindow?: number
}
