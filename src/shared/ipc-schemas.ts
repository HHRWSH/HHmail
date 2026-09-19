/**
 * IPC 入参 zod 校验 schema（仅主进程 import，避免把 zod 拉进 sandbox preload）。
 */
import { z } from 'zod'

// V2 M5：自定义视图（先声明，listMailsSchema 引用）
export const viewFilterSchema = z
  .object({
    from: z.string().trim().min(1).max(200).optional(),
    unread: z.boolean().optional(),
    hasAttachment: z.boolean().optional(),
    labelIds: z.array(z.number().int().positive()).max(50).optional(),
    dateFrom: z.number().int().nonnegative().optional(),
    dateTo: z.number().int().nonnegative().optional(),
    text: z.string().trim().min(1).max(200).optional()
  })
  .strict()

export const viewSortSchema = z
  .object({
    by: z.enum(['date', 'from', 'subject']),
    dir: z.enum(['asc', 'desc'])
  })
  .strict()

export const listMailsSchema = z.object({
  limit: z.number().int().min(1).max(2000).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  // 文件夹过滤（V2 M3）
  folder: z.string().min(1).max(200).optional(),
  // 标签过滤 / 星标过滤（V2 M4）
  labelIds: z.array(z.number().int().positive()).max(50).optional(),
  starredOnly: z.boolean().optional(),
  flaggedOnly: z.boolean().optional(),
  categoryId: z.number().int().positive().optional(),
  // 视图过滤 / 排序（V2 M5）
  filter: viewFilterSchema.optional(),
  sort: viewSortSchema.optional(),
  // 自动标签过滤（V2.2：多标签 OR，只看，不做硬过滤）
  autoTags: z.array(z.string().trim().min(1).max(12)).max(10).optional()
})

/** 彩色类别（V2.2） */
export const categoryCreateSchema = z
  .object({ name: z.string().trim().min(1).max(30), color: z.string().trim().min(1).max(20) })
  .strict()
export const categoryUpdateSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(30).optional(),
    color: z.string().trim().min(1).max(20).optional()
  })
  .strict()
export const categoryIdSchema = z.object({ id: z.number().int().positive() }).strict()
export const setMailCategorySchema = z
  .object({ messageId: z.number().int().positive(), categoryId: z.number().int().positive().nullable() })
  .strict()

/** 红旗：设置/取消 */
export const setFlaggedSchema = z.object({ id: z.number().int().positive(), flagged: z.boolean() }).strict()

/** 计数：与 listMails 相同的筛选条件（无需 limit/offset） */
export const countMailsSchema = z.object({
  folder: z.string().min(1).max(200).optional(),
  labelIds: z.array(z.number().int().positive()).max(50).optional(),
  starredOnly: z.boolean().optional(),
  unreadOnly: z.boolean().optional(),
  filter: viewFilterSchema.optional(),
  autoTags: z.array(z.string().trim().min(1).max(12)).max(10).optional()
})

export const syncMailSchema = z.object({
  folders: z.array(z.string().min(1).max(200)).max(10).optional()
})

export const getMailSchema = z.object({
  id: z.number().int().positive()
})

export const aiSummarizeSchema = z.object({
  id: z.number().int().positive()
})

// V2.1：一键总结未生成摘要的邮件 / 修复同步
export const summarizePendingSchema = z.object({
  // 一次点击把所有未总结邮件跑完：上限与 handler 的 maxTotal 保持一致
  limit: z.number().int().min(1).max(500).optional(),
  // true = 重新生成全部摘要（覆盖已有的），用于修复历史低质量摘要
  force: z.boolean().optional(),
  // 只处理指定的邮件（多选批量重新生成）；给定时默认 force=true
  ids: z.array(z.number().int().positive()).max(500).optional()
})

export const resyncSchema = z.object({
  folder: z.string().min(1).max(200).optional()
})

export const sendTestMailSchema = z
  .object({
    /** personal = 用设置里的个人邮箱（AUTH LOGIN）；school = 用学校账号的登录凭据（AUTH XOAUTH2）；值名沿用历史写法 cuhk，仅为兼容已保存的设置 */
    mode: z.enum(['personal', 'school']).optional(),
    to: z.string().trim().email().max(320).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    text: z.string().max(4000).optional()
  })
  .optional()

/** 发信参数：收件人支持逗号/分号分隔的多个地址（zod 不做严格 email 校验，逐个地址在 handler 里校验） */
export const sendMailSchema = z
  .object({
    to: z.string().trim().min(1).max(1000),
    cc: z.string().trim().max(1000).optional(),
    subject: z.string().max(500).default('(无主题)'),
    body: z.string().max(200_000).default(''),
    inReplyTo: z.string().trim().max(500).optional(),
    draftId: z.number().int().positive().optional()
  })
  .strict()

export const collectionMailsSchema = z
  .object({
    kind: z.enum(['course', 'type']),
    value: z.string().trim().min(1).max(80),
    limit: z.number().int().min(1).max(500).optional()
  })
  .strict()

export const collectionExcludeSchema = z
  .object({
    messageId: z.number().int().positive(),
    kind: z.enum(['course', 'type']),
    value: z.string().trim().min(1).max(80),
    /** true = 移出集合；false = 撤销移出 */
    exclude: z.boolean()
  })
  .strict()

export const weeklyBriefSchema = z
  .object({ fromTs: z.number().int().nonnegative().optional(), toTs: z.number().int().positive().optional() })
  .strict()

export const sentListSchema = z.object({ limit: z.number().int().min(1).max(1000).optional() }).strict()
export const sentDeleteSchema = z.object({ id: z.number().int().positive() }).strict()

export const askInboxSchema = z.object({
  question: z.string().trim().min(1).max(2000)
})

export const chatSessionIdSchema = z.object({ sessionId: z.number().int().positive() }).strict()
export const chatRenameSchema = z
  .object({ sessionId: z.number().int().positive(), title: z.string().trim().min(1).max(60) })
  .strict()
export const chatAskSchema = z
  .object({
    sessionId: z.number().int().positive(),
    question: z.string().trim().min(1).max(2000),
    /** 最多带几封引用邮件（设置里的「问答引用条数」） */
    topK: z.number().int().min(3).max(40).optional()
  })
  .strict()

export const markReadSchema = z.object({
  id: z.number().int().positive(),
  read: z.boolean()
})

export const getAttachmentSchema = z.object({
  id: z.number().int().positive(),
  partId: z.string().max(100)
})

// V2 M4：标签 / 星标
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export const createLabelSchema = z.object({
  name: z.string().trim().min(1).max(30),
  color: z.string().regex(HEX_COLOR).optional()
})

export const deleteLabelSchema = z.object({
  id: z.number().int().positive()
})

export const setMailLabelsSchema = z.object({
  id: z.number().int().positive(),
  labelIds: z.array(z.number().int().positive()).max(50)
})

export const toggleStarSchema = z.object({
  id: z.number().int().positive(),
  starred: z.boolean()
})

// V2 M5：自定义视图（viewFilterSchema/viewSortSchema 定义在文件顶部）
export const saveViewSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(50),
  filter: viewFilterSchema,
  sort: viewSortSchema
})

export const deleteViewSchema = z.object({
  id: z.number().int().positive()
})

// V2 M6：稍后提醒
export const snoozeMailSchema = z.object({
  id: z.number().int().positive(),
  until: z.number().int().positive(),
  note: z.string().trim().max(200).optional()
})

export const cancelSnoozeSchema = z.object({
  id: z.number().int().positive()
})

// V2 M7：批量操作
const bulkIds = z.array(z.number().int().positive()).min(1).max(500)

export const bulkReadSchema = z.object({
  ids: bulkIds,
  read: z.boolean()
})

export const bulkLabelSchema = z.object({
  ids: bulkIds,
  labelIds: z.array(z.number().int().positive()).min(1).max(50)
})

// V2 M9：本地草稿（发送为 P1 待授权，本轮只有草稿）
export const saveDraftSchema = z.object({
  id: z.number().int().positive().optional(),
  toAddrs: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  subject: z.string().trim().max(300),
  body: z.string().max(20000)
})

export const deleteDraftSchema = z.object({
  id: z.number().int().positive()
})

export const searchMailSchema = z.object({
  term: z.string().min(1).max(200)
})

export const setSettingsSchema = z.object({
  aiProvider: z.string().min(1).max(40).optional(),
  aiModel: z.string().min(1).max(100).optional(),
  aiCustomBaseUrl: z.string().max(300).optional(),
  apiKey: z.string().max(500).optional(),
  // 0 = 同步全部历史邮件；>0 = 最近 N 封
  syncWindow: z.number().int().min(0).max(10000).optional(),
  // 自动刷新间隔（秒）；0 = 关闭自动刷新
  refreshIntervalSec: z.number().int().min(0).max(86400).optional(),
  // 自定义 AI 总结提示词
  summaryPrompt: z.string().max(2000).optional(),
  // 新邮件自动总结 + 通知
  autoSummarizeNew: z.boolean().optional(),
  // V2.2 通用化：外观与行为
  theme: z.enum(['system', 'light', 'dark']).optional(),
  density: z.enum(['compact', 'standard', 'relaxed']).optional(),
  brandName: z.string().trim().min(1).max(24).optional(),
  brandSubtitle: z.string().trim().max(40).optional(),
  listPageSize: z.number().int().min(5).max(200).optional(),
  relativeTime: z.boolean().optional(),
  openMailMarksRead: z.boolean().optional(),
  syncOnStartup: z.boolean().optional(),
  confirmBeforeSend: z.boolean().optional(),
  askTopK: z.number().int().min(3).max(40).optional(),
  // 附件保存目录（空串 = 每次询问）
  attachmentDir: z.string().max(400).optional(),
  // V2.2 自动标签
  autoTagEnabled: z.boolean().optional(),
  tagVocabulary: z.string().max(600).optional()
})

/** 附件保存：id + partId（partId 可为空串，主进程会按需回填） */
export const attachmentSaveSchema = z
  .object({
    id: z.number().int().positive(),
    partId: z.string().max(64).optional()
  })
  .strict()

/** 手动标签：给某封邮件加/去一个标签 */
export const tagManualSchema = z
  .object({
    messageId: z.number().int().positive(),
    tag: z.string().trim().min(1).max(12),
    on: z.boolean()
  })
  .strict()

/** 标签示例：设置/取消某封邮件的示例标签（空数组 = 取消） */
export const tagExampleSchema = z
  .object({
    messageId: z.number().int().positive(),
    tags: z.array(z.string().trim().max(12)).max(5)
  })
  .strict()

/** 选择目录（可带默认目录） */
export const pickDirectorySchema = z
  .object({ defaultPath: z.string().max(1000).optional() })
  .strict()

/** 打开本地路径（只允许打开存在的目录/文件所在目录） */
export const openPathSchema = z.object({ path: z.string().min(1).max(1000) }).strict()

export const openExternalSchema = z.object({
  url: z.string().min(1).max(2048)
})
