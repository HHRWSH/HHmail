/**
 * IPC handlers —— 白名单 + zod 参数校验（规范 §14.4 / §6.9）。
 * channel 一律从 shared/ipc-contract.ts 读取；响应统一 IpcResult 形状。
 */
import { app, dialog, ipcMain, shell, Notification, BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AppError, ErrorCodes } from '../shared/error-codes'
import { mailToEvents } from '../shared/calendar'
import { IPC_CHANNELS, type AskInboxArgs, type BulkLabelArgs, type BulkReadArgs, type CancelSnoozeArgs, type CreateLabelArgs, type DeleteDraftArgs, type DeleteLabelArgs, type DeleteViewArgs, type GetAttachmentArgs, type ListMailsArgs, type MarkReadArgs, type SaveDraftArgs, type SaveViewArgs, type SearchMailArgs, type SetMailLabelsArgs, type SnoozeMailArgs, type SyncMailArgs, type ToggleStarArgs } from '../shared/ipc-contract'
import {
  aiSummarizeSchema,
  askInboxSchema,
  bulkLabelSchema,
  bulkReadSchema,
  cancelSnoozeSchema,
  createLabelSchema,
  deleteDraftSchema,
  deleteLabelSchema,
  deleteViewSchema,
  attachmentSaveSchema,
  getAttachmentSchema,
  pickDirectorySchema,
  countMailsSchema,
  listEventsSchema,
  setFlaggedSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  categoryIdSchema,
  setMailCategorySchema,
  tagExampleSchema,
  tagManualSchema,
  openPathSchema,
  getMailSchema,
  listMailsSchema,
  markReadSchema,
  openExternalSchema,
  resyncSchema,
  saveDraftSchema,
  saveViewSchema,
  chatAskSchema,
  chatRenameSchema,
  chatSessionIdSchema,
  collectionExcludeSchema,
  collectionMailsSchema,
  searchMailSchema,
  sendMailSchema,
  sendTestMailSchema,
  sentDeleteSchema,
  sentListSchema,
  setMailLabelsSchema,
  setSettingsSchema,
  snoozeMailSchema,
  summarizePendingSchema,
  syncMailSchema,
  weeklyBriefSchema,
  toggleStarSchema
} from '../shared/ipc-schemas'
import type { AppSettings, IpcResult, NewMailEvent, SendMailArgs, SetSettingsArgs, SyncProgress } from '../shared/types'
import type { AppContext } from './bootstrap'
import type { Logger } from './logger'
import { plainFromHtml } from './mail/mime'
import { deriveRuleTags, parseAiTags, parseVocabulary } from '../shared/tags'
import { describeProbeResult, probeSmtpAuth } from './mail/smtpProbe'
import { describeSendResult, sendSmtpMail, type SmtpSendResult } from './mail/smtpSend'
import { SMTP_HOST, SMTP_PORT } from './config'
import { buildNotificationBody, buildNotificationTitle } from './notifications'

function sendToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

type Handler<TArgs, TData> = (args: TArgs) => Promise<TData>

/** 逗号/分号分隔的地址列表 → 逐个做宽松校验（避免一个错地址静默丢弃）。 */
export function parseAddressList(raw: string | null | undefined): string[] {
  return String(raw ?? '')
    .split(/[,;，；\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(s))
    .slice(0, 50)
}

function wrap<TArgs, TData>(
  ctx: AppContext,
  schema: { safeParse(x: unknown): { success: boolean } } | null,
  fn: Handler<TArgs, TData>
) {
  return async (_event: Electron.IpcMainInvokeEvent, rawArgs: unknown): Promise<IpcResult<TData>> => {
    try {
      if (schema) {
        const parsed = schema.safeParse(rawArgs ?? {})
        if (!parsed.success) {
          throw new AppError(ErrorCodes.VALIDATION_FAILED, '请求参数无效。')
        }
      }
      const data = await fn((rawArgs ?? {}) as TArgs)
      return { ok: true, data }
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError(ErrorCodes.UNKNOWN, '操作失败，请稍后重试。')
      ctx.logger.error('ipc.error', { errorCode: err.code })
      return { ok: false, error: { code: err.code, message: err.message } }
    }
  }
}

/** 单封邮件 AI 总结（AI_SUMMARIZE 与批量总结共用）：成功才落库，降级摘要不覆盖旧摘要。 */
/** 批量总结的取消标志（用户点「停止」时置位，循环在两封之间检查） */
let summaryCancelRequested = false

async function summarizeOne(
  ctx: AppContext,
  id: number
): Promise<{ text: string; threadId: string; messageCount: number; model: string; savedAtMs: number; degraded?: boolean }> {
  const mail = await ctx.store.getMessage(id)
  if (!mail) throw new AppError(ErrorCodes.UNKNOWN, '邮件不存在或已被移除。')
  const thread = await ctx.store.getThread(mail.threadId)
  const settings = await ctx.settings.get()
  const result = await ctx.ai.summarize(
    {
      threadId: mail.threadId,
      subject: mail.subject,
      messages: thread.map((m) => ({
        fromName: m.fromName,
        fromAddr: m.fromAddr,
        dateTs: m.dateTs,
        // 正文交给提示词层清洗（shared/text.cleanMailText）：bodyText 可能混入 CSS，
        // 也可能为空（纯 HTML 邮件）→ 同时带上 bodyHtml 兜底
        bodyText: m.bodyText,
        bodyHtml: m.bodyHtml
      }))
    },
    { systemPrompt: settings.summaryPrompt }
  )
  const model = ctx.ai.modelName()
  if (!result.degraded) {
    await ctx.store.saveSummary(id, result.text, model)
  }
  // M1 双产物：再生成一份「给 AI 检索用的索引卡片」并入库（失败不影响摘要）
  await buildIndexCardFor(ctx, id, mail.threadId)
  return { text: result.text, threadId: result.threadId, messageCount: thread.length, model, savedAtMs: Date.now(), degraded: result.degraded }
}

/** 生成并保存某封邮件的检索索引卡片（M1）。失败只记日志，不阻断摘要流程。 */
async function buildIndexCardFor(ctx: AppContext, id: number, threadId: string): Promise<void> {
  try {
    const thread = await ctx.store.getThread(threadId)
    // V2.2 自动标签（B 方案）：把词表 + 用户挑的示例邮件交给模型，在同一个索引卡片调用里产出 [TAGS]
    const settings = await ctx.settings.get()
    const tagOptions = settings.autoTagEnabled
      ? { vocabulary: parseVocabulary(settings.tagVocabulary), examples: await ctx.store.listTagExamples() }
      : {}
    const card = await ctx.ai.indexDoc(
      {
        threadId,
        subject: thread[0]?.subject ?? '',
        messages: thread.map((m) => ({
          fromName: m.fromName,
          fromAddr: m.fromAddr,
          dateTs: m.dateTs,
          bodyText: m.bodyText,
          bodyHtml: m.bodyHtml
        }))
      },
      tagOptions
    )
    if (card.degraded || !card.text.trim()) return
    await ctx.store.saveIndexDoc({
      messageId: id,
      card: card.text,
      type: card.fields.type,
      course: card.fields.course,
      term: card.fields.term,
      dueTs: card.fields.dueTs,
      entities: card.fields.entities,
      aliases: card.fields.aliases,
      questions: card.fields.questions,
      model: card.model
    })
    if (settings.autoTagEnabled) {
      // A 方案（规则标签，零成本、可重算）+ B 方案（AI 标签，来自卡片 [TAGS]）
      await ctx.store.saveMailTags(id, deriveRuleTags(card.fields), 'rule')
      await ctx.store.saveMailTags(id, parseAiTags(card.fields.tags.join('、'), parseVocabulary(settings.tagVocabulary)), 'ai')
      ctx.logger.info('tags.saved', { rule: deriveRuleTags(card.fields).length, ai: card.fields.tags.length })
    }
    ctx.logger.info('ai.indexDoc.saved', { count: card.fields.entities.length })
  } catch (e) {
    ctx.logger.warn('ai.indexDoc.save_failed', { reason: e instanceof Error ? e.message : String(e) })
  }
}

async function handleNewMails(ctx: AppContext, newUids: number[], settings: AppSettings): Promise<void> {
  const all = await ctx.store.query({ limit: 1000, offset: 0 })
  for (const uid of newUids) {
    const item = all.find((m) => m.uid === uid)
    if (!item) continue

    let summary: string | null = null
    if (settings.hasApiKey && settings.autoSummarizeNew) {
      try {
        const mail = await ctx.store.getMessage(item.id)
        if (mail) {
          const thread = await ctx.store.getThread(mail.threadId)
          const res = await ctx.ai.summarize(
            {
              threadId: mail.threadId,
              subject: mail.subject,
              messages: thread.map((m) => ({
                fromName: m.fromName,
                fromAddr: m.fromAddr,
                dateTs: m.dateTs,
                bodyText: m.bodyText,
                bodyHtml: m.bodyHtml
              }))
            },
            { systemPrompt: settings.summaryPrompt }
          )
          await ctx.store.saveSummary(item.id, res.text, ctx.ai.modelName())
          summary = res.text
          // M1：同步维护检索索引卡片（失败不影响通知）
          await buildIndexCardFor(ctx, item.id, mail.threadId)
        }
      } catch (e) {
        ctx.logger.warn('newmail.summarize.failed', { uid, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    const payload: NewMailEvent = {
      id: item.id,
      uid: item.uid,
      subject: item.subject,
      fromName: item.fromName,
      snippet: item.snippet,
      summary
    }

    // Windows 系统通知（尽力而为：无 Key 时退化为基本信息通知）
    try {
      const notification = new Notification({
        title: buildNotificationTitle(item.subject),
        body: buildNotificationBody(item, summary)
      })
      notification.on('click', () => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.show()
        }
        sendToAllWindows(IPC_CHANNELS.MAIL_NEW_EVENT, { ...payload, fromClick: true })
      })
      notification.show()
    } catch (e) {
      ctx.logger.warn('newmail.notification.failed', { reason: e instanceof Error ? e.message : String(e) })
    }

    sendToAllWindows(IPC_CHANNELS.MAIL_NEW_EVENT, payload)
  }
}

/**
 * 批量生成摘要（V2.1）：按「缺摘要或缺索引卡片」的邮件顺序执行。
 * 抽成独立函数的原因：IPC 处理与「自动同步后的补摘要」共用同一套逻辑（真机反馈：有时不自动总结）。
 */
export async function summarizePendingBatch(
  ctx: AppContext,
  opts: { limit?: number; force?: boolean; ids?: number[]; onProgress?: (p: Record<string, unknown>) => void } = {}
): Promise<{ total: number; done: number; degraded: number; failed: number; cancelled: boolean }> {
  const args = opts
  // 一次点击把待办邮件跑完（分批取，避免一次载入过多；总量设安全上限）
  const maxTotal = Math.min(Math.max(args.limit ?? 500, 1), 500)
  const batchSize = 20
  const startedAt = Date.now()
  let total = 0
  let done = 0
  let degraded = 0
  let failed = 0
  let cancelled = false
  summaryCancelRequested = false
  const emit = (payload: {
    done: number
    total: number
    subject: string | null
    current?: boolean
    finished?: boolean
    cancelled?: boolean
  }): void => {
    opts.onProgress?.({ ...payload, elapsedMs: Date.now() - startedAt })
  }
  // ids 模式（多选批量重新生成）：只跑这几封，默认覆盖旧摘要
  const idList = args.ids && args.ids.length > 0 ? args.ids.slice(0, maxTotal) : null
  const force = args.force === true || idList !== null
  emit({ done: 0, total: 0, subject: null })
  let finished = false
  while (!finished) {
    const pending = idList
      ? (await Promise.all(idList.map((id) => ctx.store.getMessage(id)))).filter((m): m is NonNullable<typeof m> => m !== null)
      : await ctx.store.listUnsummarized(Math.min(batchSize, maxTotal - total), force)
    if (pending.length === 0) break
    total += pending.length
    for (const item of pending) {
      if (summaryCancelRequested) {
        cancelled = true
        finished = true
        break
      }
      // 先告诉界面「正在生成哪一封」，用户才知道进度与大概还要等多久
      emit({ done: done + degraded + failed, total, subject: item.subject, current: true })
      try {
        const res = await summarizeOne(ctx, item.id)
        if (res.degraded) degraded += 1
        else done += 1
      } catch (e) {
        failed += 1
        ctx.logger.warn('ai.summarize_pending.item_failed', { reason: e instanceof Error ? e.message : String(e) })
      }
      emit({ done: done + degraded + failed, total, subject: item.subject })
    }
    if (idList || total >= maxTotal) break
  }
  ctx.logger.info('ai.summarize_pending.done', { count: done, degraded, failed, cancelled })
  emit({ done: done + degraded + failed, total, subject: null, finished: true, cancelled })
  return { total, done, degraded, failed, cancelled }

}

export function registerIpcHandlers(ctx: AppContext, logger: Logger, emitSync: (p: SyncProgress) => void): void {  ipcMain.handle(
    IPC_CHANNELS.AUTH_STATUS,
    wrap(ctx, null, async () => ctx.auth.status())
  )

  ipcMain.handle(
    IPC_CHANNELS.AUTH_DEVICE_CODE,
    wrap(ctx, null, async () => ctx.auth.startDeviceCode())
  )

  ipcMain.handle(
    IPC_CHANNELS.AUTH_LOGOUT,
    wrap(ctx, null, async () => {
      await ctx.auth.logout()
      await ctx.provider.close().catch(() => undefined)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_LIST,
    wrap(ctx, listMailsSchema, async (args: ListMailsArgs) =>
      // V2.2 修复（关键）：必须把**所有**筛选字段透传下去。
      // 这里原来是逐个字段手写的，新增 flaggedOnly / autoTags / categoryId / unreadOnly 时漏了，
      // 导致「红旗筛选点了没反应」「标签筛选一直不生效」——改成展开透传，杜绝这类漏字段。
      ctx.store.query({
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
        ...args
      })
    )
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_LIST_FOLDERS,
    wrap(ctx, null, async () => {
      // V2 M3：列出邮箱文件夹（失败兜底 INBOX，保证收件箱可用）
      try {
        const folders = await ctx.provider.listFolders()
        return folders.length > 0 ? folders : [{ name: '收件箱', path: 'INBOX' }]
      } catch (e) {
        ctx.logger.warn('folders.list.failed', { reason: e instanceof Error ? e.message : String(e) })
        return [{ name: '收件箱', path: 'INBOX' }]
      }
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_GET,
    wrap(ctx, getMailSchema, async (args: { id: number }) => {
      let mail = await ctx.store.getMessage(args.id)
      if (!mail) throw new AppError(ErrorCodes.UNKNOWN, '邮件不存在或已被移除。')
      if (!mail.bodyText.trim() && !mail.bodyHtml) {
        // 旧版本同步的纯 HTML 邮件正文为空 → 按需从服务器回填（BODY.PEEK，只读）
        try {
          const raw = await ctx.provider.fetchBody(mail.uid)
          if (raw) {
            const parsed = await ctx.parse(raw.raw, mail.uid, [])
            await ctx.store.upsertMessages([{ ...parsed, threadId: mail.threadId }])
            const refilled = await ctx.store.getMessage(args.id)
            if (refilled) mail = refilled
          }
        } catch (e) {
          ctx.logger.warn('mail.backfill.failed', { uid: mail.uid, reason: e instanceof Error ? e.message : String(e) })
        }
      }
      return mail
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_SEARCH,
    wrap(ctx, searchMailSchema, async (args: SearchMailArgs) => {
      const hits = await ctx.store.search(args.term, 50)
      const ids = hits.map((h) => h.id)
      const all = await ctx.store.query({ limit: 1000, offset: 0 })
      return all.filter((m) => ids.includes(m.id))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_MARK_READ,
    wrap(ctx, markReadSchema, async (args: MarkReadArgs) => {
      // 只在本机维护已读/未读，不改服务端标志（规范 §1.1 第 8 条 / §2 第 1 条）
      await ctx.store.markRead(args.id, args.read)
    })
  )

  // ---- V2 M4：本地标签 / 星标 ----

  ipcMain.handle(
    IPC_CHANNELS.LABELS_LIST,
    wrap(ctx, null, async () => ctx.store.listLabels())
  )

  ipcMain.handle(
    IPC_CHANNELS.LABELS_CREATE,
    wrap(ctx, createLabelSchema, async (args: CreateLabelArgs) => {
      const label = await ctx.store.createLabel(args.name, args.color)
      ctx.logger.info('label.created', { labelId: label.id, labelName: label.name })
      return label
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.LABELS_DELETE,
    wrap(ctx, deleteLabelSchema, async (args: DeleteLabelArgs) => {
      await ctx.store.deleteLabel(args.id)
      ctx.logger.info('label.deleted', { labelId: args.id })
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_SET_LABELS,
    wrap(ctx, setMailLabelsSchema, async (args: SetMailLabelsArgs) => {
      // 只改本地标签，不触碰服务端（邮件本身保持只读）
      await ctx.store.setMailLabels(args.id, args.labelIds)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_TOGGLE_STAR,
    wrap(ctx, toggleStarSchema, async (args: ToggleStarArgs) => {
      await ctx.store.setStarred(args.id, args.starred)
    })
  )

  // ---- V2 M5：自定义视图 ----

  ipcMain.handle(
    IPC_CHANNELS.VIEWS_LIST,
    wrap(ctx, null, async () => ctx.store.listViews())
  )

  ipcMain.handle(
    IPC_CHANNELS.VIEWS_SAVE,
    wrap(ctx, saveViewSchema, async (args: SaveViewArgs) => {
      const view = await ctx.store.saveView({ id: args.id, name: args.name, filter: args.filter, sort: args.sort })
      ctx.logger.info('view.saved', { viewId: view.id, viewName: view.name })
      return view
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.VIEWS_DELETE,
    wrap(ctx, deleteViewSchema, async (args: DeleteViewArgs) => {
      await ctx.store.deleteView(args.id)
      ctx.logger.info('view.deleted', { viewId: args.id })
    })
  )

  // ---- V2 M6：稍后提醒 ----

  ipcMain.handle(
    IPC_CHANNELS.MAIL_SNOOZE,
    wrap(ctx, snoozeMailSchema, async (args: SnoozeMailArgs) => {
      const mail = await ctx.store.getMessage(args.id)
      if (!mail) throw new AppError(ErrorCodes.UNKNOWN, '邮件不存在或已被移除。')
      if (args.until <= Date.now()) throw new AppError(ErrorCodes.VALIDATION_FAILED, '提醒时间必须晚于当前时间。')
      await ctx.store.setSnooze(args.id, args.until, args.note)
      ctx.logger.info('snooze.set', { snoozeUntil: args.until })
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_CANCEL_SNOOZE,
    wrap(ctx, cancelSnoozeSchema, async (args: CancelSnoozeArgs) => {
      await ctx.store.cancelSnooze(args.id)
      ctx.logger.info('snooze.cancelled', {})
    })
  )

  // ---- V2 M7：批量操作（只改本地，不触碰服务端） ----

  ipcMain.handle(
    IPC_CHANNELS.MAIL_BULK_READ,
    wrap(ctx, bulkReadSchema, async (args: BulkReadArgs) => {
      await ctx.store.bulkMarkRead(args.ids, args.read)
      ctx.logger.info('bulk.read', { count: args.ids.length })
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_BULK_LABEL,
    wrap(ctx, bulkLabelSchema, async (args: BulkLabelArgs) => {
      await ctx.store.bulkAddLabels(args.ids, args.labelIds)
      ctx.logger.info('bulk.label', { count: args.ids.length })
    })
  )

  // ---- V2 M9：本地草稿（发送 P1 待授权，本轮不提供发送） ----

  ipcMain.handle(
    IPC_CHANNELS.DRAFTS_LIST,
    wrap(ctx, null, async () => ctx.store.listDrafts())
  )

  ipcMain.handle(
    IPC_CHANNELS.DRAFTS_SAVE,
    wrap(ctx, saveDraftSchema, async (args: SaveDraftArgs) => {
      const draft = await ctx.store.saveDraft({ id: args.id, toAddrs: args.toAddrs, subject: args.subject, body: args.body })
      ctx.logger.info('draft.saved', { draftId: draft.id })
      return draft
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.DRAFTS_DELETE,
    wrap(ctx, deleteDraftSchema, async (args: DeleteDraftArgs) => {
      await ctx.store.deleteDraft(args.id)
      ctx.logger.info('draft.deleted', { draftId: args.id })
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_GET_ATTACHMENT,
    wrap(ctx, getAttachmentSchema, async (args: GetAttachmentArgs) => {
      // V2 M2：附件按需下载（BODY.PEEK[part]，只读不标已读）
      const mail = await ctx.store.getMessage(args.id)
      if (!mail) throw new AppError(ErrorCodes.UNKNOWN, '邮件不存在或已被移除。')
      const att = mail.attachments.find((a) => a.partId === args.partId)
      let partId = args.partId
      if (!partId && att) {
        // 旧版本同步的附件缺 partId：按需重新拉取解析该邮件，按文件名回填
        try {
          const raw = await ctx.provider.fetchBody(mail.uid)
          if (raw) {
            const parsed = await ctx.parse(raw.raw, mail.uid, [])
            const hit = parsed.attachments.find((a) => a.filename === att.filename && a.partId)
            if (hit?.partId) {
              await ctx.store.setAttachmentPartId(args.id, att.filename, hit.partId)
              partId = hit.partId
            }
          }
        } catch (e) {
          ctx.logger.warn('attachment.backfill.failed', { reason: e instanceof Error ? e.message : String(e) })
        }
        if (!partId) {
          throw new AppError(ErrorCodes.UNKNOWN, '附件信息缺失，请点「↻ 同步」重新同步该邮件后再下载。')
        }
      }
      const payload = await ctx.provider.fetchAttachment(mail.uid, partId)
      if (payload.content.length > 30 * 1024 * 1024) {
        throw new AppError(ErrorCodes.UNKNOWN, '附件超过 30MB，暂不支持下载。')
      }
      return {
        filename: payload.filename,
        contentType: payload.contentType,
        dataBase64: payload.content.toString('base64')
      }
    })
  )

  /** 彩色类别（V2.2）：列表 / 新建 / 改名改色 / 删除 / 指派给邮件 */
  ipcMain.handle(IPC_CHANNELS.CATEGORIES_LIST, wrap(ctx, null, async () => ctx.store.listCategories()))
  ipcMain.handle(IPC_CHANNELS.CATEGORIES_COUNTS, wrap(ctx, null, async () => ctx.store.listCategoryCounts()))
  ipcMain.handle(
    IPC_CHANNELS.CATEGORIES_CREATE,
    wrap(ctx, categoryCreateSchema, async (args: { name: string; color: string }) =>
      ctx.store.createCategory(args.name, args.color)
    )
  )
  ipcMain.handle(
    IPC_CHANNELS.CATEGORIES_UPDATE,
    wrap(ctx, categoryUpdateSchema, async (args: { id: number; name?: string; color?: string }) => {
      await ctx.store.updateCategory(args.id, { name: args.name, color: args.color })
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.CATEGORIES_DELETE,
    wrap(ctx, categoryIdSchema, async (args: { id: number }) => {
      await ctx.store.deleteCategory(args.id)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.MAIL_SET_CATEGORY,
    wrap(ctx, setMailCategorySchema, async (args: { messageId: number; categoryId: number | null }) => {
      await ctx.store.setMailCategory(args.messageId, args.categoryId)
    })
  )

  /** 红旗：设置/取消（V2.2） */
  ipcMain.handle(
    IPC_CHANNELS.MAIL_SET_FLAGGED,
    wrap(ctx, setFlaggedSchema, async (args: { id: number; flagged: boolean }) => {
      await ctx.store.setFlagged(args.id, args.flagged)
    })
  )

  /** 当前筛选条件下的总数（列表分页显示"共 N 封"） */
  ipcMain.handle(
    IPC_CHANNELS.MAIL_LIST_EVENTS,
    wrap(ctx, listEventsSchema, async (args: { from: number; to: number }) => {
      // 日历事件在**主进程**派生（纯函数 shared/calendar）：渲染层只拿结果，
      // 事件的时间分桶一律按北京时间，避免不同机器的时区差异。
      const src = await ctx.store.listCalendarSources(args.from, args.to)
      const events = src.flatMap((m) => mailToEvents(m))
      return events.filter((e) => e.ts >= args.from && e.ts <= args.to)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_COUNT,
    wrap(ctx, countMailsSchema, async (args: {
      folder?: string
      labelIds?: number[]
      starredOnly?: boolean
      unreadOnly?: boolean
      filter?: import('../shared/types').ViewFilter
      autoTags?: string[]
    }) => ctx.store.countMails({ limit: 0, offset: 0, ...args }))
  )

  /** 自动标签：各标签邮件数（设置页与筛选用） */
  ipcMain.handle(
    IPC_CHANNELS.TAGS_COUNTS,
    wrap(ctx, null, async () => ctx.store.listTagCounts())
  )

  /** 自动标签：用户挑的示例邮件（给 AI 当 few-shot 参考） */
  ipcMain.handle(
    IPC_CHANNELS.TAGS_EXAMPLES,
    wrap(ctx, null, async () => ctx.store.listTagExamples())
  )

  /** 自动标签：设置/取消某封邮件的示例标签 */
  ipcMain.handle(
    IPC_CHANNELS.TAGS_EXAMPLE_SET,
    wrap(ctx, tagExampleSchema, async (args: { messageId: number; tags: string[] }) => {
      await ctx.store.setTagExample(args.messageId, args.tags)
      ctx.logger.info('tags.example.set', { tags: args.tags.length })
    })
  )

  /** 标签：手动加/去（V2.2 统一标签体系；去掉自动标签会记入抑制表，重算不会加回来） */
  ipcMain.handle(
    IPC_CHANNELS.TAGS_SET_MANUAL,
    wrap(ctx, tagManualSchema, async (args: { messageId: number; tag: string; on: boolean }) => {
      await ctx.store.setMailTagManual(args.messageId, args.tag, args.on)
      ctx.logger.info('tags.manual.set', { on: args.on })
    })
  )

  /** 自动标签：用现有索引卡片重算全部规则标签（A 方案，不花 AI 成本） */
  ipcMain.handle(
    IPC_CHANNELS.TAGS_REBUILD,
    wrap(ctx, null, async () => {
      const n = await ctx.store.rebuildRuleTags()
      ctx.logger.info('tags.rebuild', { count: n })
      return n
    })
  )

  /**
   * 附件保存（V2.2）：主进程负责落盘，位置由设置决定
   *   · 设置了「附件保存目录」→ 直接写进去（同名自动加 (1)(2)）
   *   · 没设置 → 弹系统保存对话框（默认文件名/下载目录）
   * 顺带修掉「附件完全用不了」：分段号缺失时按需回填，读取失败给出可操作的提示。
   */
  ipcMain.handle(
    IPC_CHANNELS.MAIL_ATTACHMENT_SAVE,
    wrap(ctx, attachmentSaveSchema, async (args: { id: number; partId?: string }) => {
      const mail = await ctx.store.getMessage(args.id)
      if (!mail) throw new AppError(ErrorCodes.UNKNOWN, '邮件不存在或已被移除。')
      const att = mail.attachments.find((a) => a.partId === (args.partId ?? '')) ?? mail.attachments[0]
      let partId = att?.partId ?? ''
      if (att && !partId) {
        // 旧数据缺 partId：重新拉取解析该邮件，按文件名回填
        try {
          const raw = await ctx.provider.fetchBody(mail.uid)
          if (raw) {
            const parsed = await ctx.parse(raw.raw, mail.uid, [])
            const hit = parsed.attachments.find((a) => a.filename === att.filename && a.partId)
            if (hit?.partId) {
              await ctx.store.setAttachmentPartId(args.id, att.filename, hit.partId)
              partId = hit.partId
            }
          }
        } catch (e) {
          ctx.logger.warn('attachment.backfill.failed', { reason: e instanceof Error ? e.message : String(e) })
        }
        if (!partId) {
          throw new AppError(ErrorCodes.UNKNOWN, '附件信息缺失，请点右上角「↻ 同步」重新同步该邮件后再试。')
        }
      }
      if (!partId) throw new AppError(ErrorCodes.UNKNOWN, '这封邮件没有可下载的附件。')

      const payload = await ctx.provider.fetchAttachment(mail.uid, partId)
      if (payload.content.length > 30 * 1024 * 1024) {
        throw new AppError(ErrorCodes.UNKNOWN, '附件超过 30MB，暂不支持保存。')
      }
      const filename = sanitizeFilename(att?.filename || payload.filename || `attachment-${args.id}`)
      const settings = await ctx.settings.get()
      const dir = settings.attachmentDir
      let target: string
      if (dir) {
        try {
          fs.mkdirSync(dir, { recursive: true })
        } catch {
          throw new AppError(ErrorCodes.UNKNOWN, `附件保存目录不可用：${dir}（请在设置里重新选择）`)
        }
        target = uniquePath(dir, filename)
      } else if (ctx.mockMode) {
        // mock 模式（E2E）：不弹系统对话框（会阻塞自动化），直接落到临时目录
        const dir2 = path.join(os.tmpdir(), 'mail-ai-attachments')
        fs.mkdirSync(dir2, { recursive: true })
        target = uniquePath(dir2, filename)
      } else {
        const picked = await dialog.showSaveDialog({
          title: '保存附件',
          defaultPath: path.join(app.getPath('downloads'), filename),
          buttonLabel: '保存'
        })
        if (picked.canceled || !picked.filePath) {
          ctx.logger.info('attachment.save.canceled')
          return { saved: false, filename }
        }
        target = picked.filePath
      }
      fs.writeFileSync(target, payload.content)
      ctx.logger.info('attachment.saved', { bytes: payload.content.length, fixedDir: Boolean(dir) })
      return { saved: true, path: target, filename }
    })
  )

  /** 选择目录（设置 → 附件保存位置） */
  ipcMain.handle(
    IPC_CHANNELS.SHELL_PICK_DIRECTORY,
    wrap(ctx, pickDirectorySchema, async (args: { defaultPath?: string } | undefined) => {
      const picked = await dialog.showOpenDialog({
        title: '选择附件保存目录',
        defaultPath: args?.defaultPath || app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (picked.canceled || picked.filePaths.length === 0) return null
      return picked.filePaths[0]
    })
  )

  /** 在文件管理器中定位文件/文件夹（附件保存后可直接打开） */
  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_PATH,
    wrap(ctx, openPathSchema, async (args: { path: string }) => {
      if (!fs.existsSync(args.path)) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, '路径不存在。')
      }
      const stat = fs.statSync(args.path)
      if (stat.isDirectory()) await shell.openPath(args.path)
      else shell.showItemInFolder(args.path)
    })
  )

  // V2.1：修复同步——把游标回退到「本地实际最大 UID」，重新拉取中间缺失的邮件
  ipcMain.handle(
    IPC_CHANNELS.MAIL_RESYNC,
    wrap(ctx, resyncSchema, async (args: { folder?: string }) => {
      const folder = args.folder && args.folder.length > 0 ? args.folder : 'INBOX'
      const state = await ctx.store.getSyncState(folder)
      const maxUid = await ctx.store.getMaxUid(folder)
      const from = state ? state.uidValidity : 0
      await ctx.store.setSyncState({
        uidValidity: from,
        lastUid: maxUid,
        folder,
        fullHistory: state?.fullHistory ?? true
      })
      ctx.logger.info('sync.resync_floor', { folder, lastUid: maxUid })
    })
  )

  // 发信（回复/转发/草稿发送/新写）：学校账号走 SMTP + OAuth(SMTP.Send)，个人邮箱走应用密码
  ipcMain.handle(
    IPC_CHANNELS.MAIL_SEND,
    wrap(ctx, sendMailSchema, async (args: SendMailArgs) => {
      const recipients = parseAddressList(args.to)
      const ccList = parseAddressList(args.cc ?? '')
      if (recipients.length === 0) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, '请填写至少一个有效的收件人地址。')
      }
      if (recipients.length + ccList.length > 50) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, '收件人过多（上限 50 个）。')
      }
      const subject = args.subject?.trim() || '(无主题)'
      const { user, accessToken } = await ctx.auth.ensureValidToken()
      const from = user
      const text = args.body ?? ''

      const result = ctx.mockMode
        ? ({ ok: true, stage: 'done', serverMessage: '250 2.0.0 Ok: queued as MOCK [mock]' } as SmtpSendResult)
        : await sendSmtpMail({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: false,
            user: from,
            accessToken,
            from,
            to: recipients.join(', '),
            cc: ccList,
            subject,
            text,
            inReplyTo: args.inReplyTo,
            timeoutMs: 30_000
          })

      const sentId = await ctx.store.insertSentItem({
        toAddrs: recipients,
        ccAddrs: ccList,
        subject,
        body: text,
        status: result.ok ? 'sent' : 'failed',
        error: result.ok ? null : `${result.stage}: ${result.serverMessage}`.slice(0, 500)
      })
      if (result.ok && args.draftId !== undefined) {
        await ctx.store.deleteDraft(args.draftId).catch(() => undefined)
      }
      ctx.logger.info('smtp.send', {
        ok: result.ok,
        stage: result.stage,
        count: recipients.length + ccList.length
      })
      const conclusion = describeSendResult(result, recipients.join(', '), { oauth: true })
      return { ...result, conclusion, sentId }
    })
  )

  // 检索索引卡片覆盖情况（M1）
  ipcMain.handle(
    IPC_CHANNELS.MAIL_INDEX_STATS,
    wrap(ctx, null, async () => ({
      total: await ctx.store.count(),
      missing: await ctx.store.countMissingIndexDocs()
    }))
  )

  // ---- M3 知识库：集合（由索引卡片派生）+ 周报（纯聚合，不调用大模型）----
  ipcMain.handle(
    IPC_CHANNELS.KB_COLLECTIONS,
    wrap(ctx, null, async () => ctx.store.listCollections())
  )
  ipcMain.handle(
    IPC_CHANNELS.KB_COLLECTION_MAILS,
    wrap(ctx, collectionMailsSchema, async (args: { kind: 'course' | 'type'; value: string; limit?: number }) =>
      ctx.store.listCollectionMails(args.kind, args.value, args.limit ?? 200)
    )
  )
  ipcMain.handle(
    IPC_CHANNELS.KB_COLLECTION_EXCLUDE,
    wrap(ctx, collectionExcludeSchema, async (args: { messageId: number; kind: 'course' | 'type'; value: string; exclude: boolean }) => {
      if (args.exclude) await ctx.store.excludeFromCollection(args.messageId, args.kind, args.value)
      else await ctx.store.includeInCollection(args.messageId, args.kind, args.value)
      ctx.logger.info('kb.collection.override', { count: 1, forced: args.exclude })
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.KB_WEEKLY_BRIEF,
    wrap(ctx, weeklyBriefSchema, async (args: { fromTs?: number; toTs?: number } | undefined) => {
      // 默认「本周一 00:00 ~ 下周一 00:00」（本地时区）
      const now = new Date()
      const day = now.getDay() === 0 ? 7 : now.getDay()
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day - 1), 0, 0, 0, 0)
      const fromTs = args?.fromTs ?? monday.getTime()
      const toTs = args?.toTs ?? new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7, 0, 0, 0, 0).getTime() - 1
      return ctx.store.weeklyBrief(fromTs, toTs)
    })
  )

  // 本地「已发送」列表 / 删除
  ipcMain.handle(
    IPC_CHANNELS.MAIL_SENT_LIST,
    wrap(ctx, sentListSchema, async (args: { limit?: number } | undefined) => ctx.store.listSentItems(args?.limit ?? 200))
  )
  ipcMain.handle(
    IPC_CHANNELS.MAIL_SENT_DELETE,
    wrap(ctx, sentDeleteSchema, async (args: { id: number }) => {
      await ctx.store.deleteSentItem(args.id)
    })
  )

  // 个人邮箱发信测试（真的发一封纯文本测试邮件；凭据只从加密设置读取，不回传渲染进程）
  ipcMain.handle(
    IPC_CHANNELS.MAIL_SEND_TEST,
    wrap(
      ctx,
      sendTestMailSchema,
      async (args: { mode?: 'personal' | 'school'; to?: string; subject?: string; text?: string } | undefined) => {
        const settings = await ctx.settings.get()
        const mode = args?.mode ?? 'personal'
        const subject = args?.subject ?? '邮件助手发信测试'
        let result: SmtpSendResult
        let to: string
        let oauth = false

        if (mode === 'school') {
          // 学校账号发信：用登录拿到的 access token 走 AUTH XOAUTH2（需要 scope 含 SMTP.Send）
          const { user, accessToken } = await ctx.auth.ensureValidToken()
          to = (args?.to ?? '').trim() || user
          const text =
            args?.text ??
            `这是「邮件助手」用你的学校邮箱发给自己的一封测试邮件。

如果你收到它，说明该学校账号可以通过 SMTP + OAuth（SMTP.Send）发信，
应用里的「发送邮件」功能可以开放。

发送时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' })}`
          oauth = true
          if (ctx.mockMode) {
            result = { ok: true, stage: 'done', serverMessage: '250 2.0.0 Ok: queued as MOCK [mock]' }
          } else {
            result = await sendSmtpMail({
              host: SMTP_HOST,
              port: SMTP_PORT,
              secure: false,
              user,
              accessToken,
              from: user,
              to,
              subject,
              text,
              timeoutMs: 25_000
            })
          }
        } else {
          to = (args?.to ?? settings.smtpTo ?? '').trim() || settings.smtpUser
          const pass = await ctx.settings.getSmtpPass()
          if (!settings.smtpUser || !pass) {
            throw new AppError(ErrorCodes.VALIDATION_FAILED, '请先在设置里填写发信邮箱与密码（应用密码）并保存。')
          }
          if (!to) {
            throw new AppError(ErrorCodes.VALIDATION_FAILED, '请填写测试收件人地址。')
          }
          const text =
            args?.text ??
            `这是「邮件助手」的发送能力测试邮件。

如果你收到这封邮件，说明该发信邮箱（${settings.smtpUser}）配置可用，
后续可以开放「发送邮件」功能。

发送时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' })}`
          if (ctx.mockMode) {
            result = { ok: true, stage: 'done', serverMessage: '250 2.0.0 Ok: queued as MOCK [mock]' }
          } else {
            result = await sendSmtpMail({
              host: settings.smtpHost,
              port: settings.smtpPort,
              secure: settings.smtpSecure,
              user: settings.smtpUser,
              pass,
              from: settings.smtpUser,
              to,
              subject,
              text,
              timeoutMs: 20_000
            })
          }
        }
        ctx.logger.info('smtp.send_test', {
          ok: result.ok,
          stage: result.stage,
          secure: mode === 'school' ? false : settings.smtpSecure,
          mode
        })
        return { ...result, conclusion: describeSendResult(result, to, { oauth }) }
      }
    )
  )

  // 发送能力自检（只检测、不发送邮件）：回答「能不能直接发邮件」
  ipcMain.handle(
    IPC_CHANNELS.MAIL_SEND_PROBE,
    wrap(ctx, null, async () => {
      if (ctx.mockMode) {
        return {
          reachable: true,
          startTls: true,
          authMechanisms: ['LOGIN', 'XOAUTH2'],
          authOk: false,
          serverMessage: '535 5.7.3 Authentication unsuccessful [mock]',
          guidance: '⚠️ 鉴权被拒：当前登录只申请了 IMAP 只读权限；发送需要额外授权（SMTP.Send 或 Graph Mail.Send）并重新登录',
          userDataDir: ctx.userDataPath
        }
      }
      const { user, accessToken } = await ctx.auth.ensureValidToken()
      const result = await probeSmtpAuth({
        host: SMTP_HOST,
        port: SMTP_PORT,
        user,
        accessToken,
        timeoutMs: 15_000
      })
      ctx.logger.info('smtp.probe', {
        reachable: result.reachable,
        authOk: result.authOk,
        mechanisms: result.authMechanisms.length
      })
      return { ...result, guidance: describeProbeResult(result) }
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.MAIL_SYNC,
    wrap(ctx, syncMailSchema, async (args: SyncMailArgs) => {
      const settings = await ctx.settings.get()
      const folders = args?.folders && args.folders.length > 0 ? args.folders : ['INBOX']
      const result = await ctx.sync.run(emitSync, settings.syncWindow, folders)
      // 新邮件：自动 AI 总结 + Windows 通知（全量首同步不打扰，只处理增量新 UID）
      const newUids = result.newUids.slice(0, 10)
      if (newUids.length > 0) {
        void handleNewMails(ctx, newUids, settings).catch((e) =>
          ctx.logger.warn('newmail.handle.failed', { reason: e instanceof Error ? e.message : String(e) })
        )
      }
      return result
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.AI_SUMMARIZE,
    wrap(ctx, aiSummarizeSchema, async (args: { id: number }) => summarizeOne(ctx, args.id))
  )

  // V2.1：一键总结所有「还没有摘要」的邮件（顺序执行 + 进度推送，避免并发打爆 API）
  ipcMain.handle(
    IPC_CHANNELS.AI_SUMMARIZE_PENDING,
    wrap(ctx, summarizePendingSchema, async (args: { limit?: number; force?: boolean; ids?: number[] }) =>
      summarizePendingBatch(ctx, {
        limit: args.limit,
        force: args.force,
        ids: args.ids,
        onProgress: (payload) => sendToAllWindows(IPC_CHANNELS.AI_SUMMARY_PROGRESS, payload)
      })
    )
  )

  // 取消正在进行的批量总结
  ipcMain.handle(
    IPC_CHANNELS.AI_CANCEL_SUMMARIZE,
    wrap(ctx, null, async () => {
      summaryCancelRequested = true
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.AI_ASK_INBOX,
    wrap(ctx, askInboxSchema, async (args: AskInboxArgs) => {
      // V2 M1：自然语言问收件箱（本地 FTS 检索 + RAG + 可跳转引用）
      const result = await ctx.ai.askInbox(args.question)
      return { answer: result.answer, citations: result.citations, model: ctx.ai.modelName() }
    })
  )

  // ---- M4：AI 助手聊天会话（多轮上下文 + 会话管理）----
  ipcMain.handle(
    IPC_CHANNELS.AI_CHAT_SESSIONS,
    wrap(ctx, null, async () => ctx.store.listChatSessions(100))
  )
  ipcMain.handle(
    IPC_CHANNELS.AI_CHAT_MESSAGES,
    wrap(ctx, chatSessionIdSchema, async (args: { sessionId: number }) => ctx.store.getChatMessages(args.sessionId, 200))
  )
  ipcMain.handle(
    IPC_CHANNELS.AI_CHAT_NEW,
    wrap(ctx, null, async () => ctx.store.createChatSession('新对话'))
  )
  ipcMain.handle(
    IPC_CHANNELS.AI_CHAT_DELETE,
    wrap(ctx, chatSessionIdSchema, async (args: { sessionId: number }) => {
      await ctx.store.deleteChatSession(args.sessionId)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.AI_CHAT_RENAME,
    wrap(ctx, chatRenameSchema, async (args: { sessionId: number; title: string }) => {
      await ctx.store.renameChatSession(args.sessionId, args.title)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.AI_CHAT_ASK,
    wrap(ctx, chatAskSchema, async (args: { sessionId: number; question: string; topK?: number }) => {
      // 先存用户消息，再用「最近若干轮」作为上下文提问（多轮追问能理解指代）
      await ctx.store.appendChatMessage(args.sessionId, 'user', args.question)
      const history = (await ctx.store.getChatMessages(args.sessionId, 200))
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content }))
      const topK = args.topK ?? (await ctx.settings.get()).askTopK
      const result = await ctx.ai.askInbox(args.question, { history, topK })
      const id = await ctx.store.appendChatMessage(args.sessionId, 'assistant', result.answer, result.citations)
      const messages = await ctx.store.getChatMessages(args.sessionId, 200)
      return messages.find((m) => m.id === id) ?? {
        id,
        sessionId: args.sessionId,
        role: 'assistant' as const,
        content: result.answer,
        citations: result.citations,
        createdAt: Date.now()
      }
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET,
    wrap(ctx, null, async () => ctx.settings.get())
  )

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SET,
    wrap(ctx, setSettingsSchema, async (args: SetSettingsArgs) => ctx.settings.set(args))
  )

  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_EXTERNAL,
    wrap(ctx, openExternalSchema, async (args: { url: string }) => {
      // 只允许 http(s)，防钓鱼（规范 §2 第 9/11 条）
      const parsed = new URL(args.url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, '仅允许打开 http/https 链接。')
      }
      await shell.openExternal(parsed.toString())
    })
  )
}

/** 去掉文件名里的非法字符（Windows 限制），并限制长度。 */
function sanitizeFilename(name: string): string {
  const cleaned = String(name ?? '')
    .replace(/[\/:*?"<>| -]/g, '_')
    .replace(/^\s+|\s+$/g, '')
    .slice(0, 120)
  return cleaned || 'attachment'
}

/** 目录内同名文件自动加 (1)(2)…，避免覆盖用户已有文件。 */
function uniquePath(dir: string, filename: string): string {
  const ext = path.extname(filename)
  const base = path.basename(filename, ext)
  let candidate = path.join(dir, filename)
  let i = 1
  while (fs.existsSync(candidate) && i < 500) {
    candidate = path.join(dir, `${base} (${i})${ext}`)
    i += 1
  }
  return candidate
}
