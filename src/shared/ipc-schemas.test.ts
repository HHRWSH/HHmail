import { describe, expect, it } from 'vitest'
import {
  askInboxSchema,
  bulkLabelSchema,
  bulkReadSchema,
  cancelSnoozeSchema,
  createLabelSchema,
  deleteDraftSchema,
  deleteLabelSchema,
  deleteViewSchema,
  getAttachmentSchema,
  getMailSchema,
  listMailsSchema,
  openExternalSchema,
  saveDraftSchema,
  resyncSchema,
  saveViewSchema,
  searchMailSchema,
  setMailLabelsSchema,
  setSettingsSchema,
  snoozeMailSchema,
  summarizePendingSchema,
  syncMailSchema,
  toggleStarSchema,
  viewFilterSchema,
  viewSortSchema
} from './ipc-schemas'

describe('IPC 入参 zod 校验（白名单契约，规范 §14.4）', () => {
  it('ai:ask-inbox —— question 1..2000 字符（V2 M1）', () => {
    expect(askInboxSchema.safeParse({ question: '上周导师发了什么邮件？' }).success).toBe(true)
    expect(askInboxSchema.safeParse({ question: '' }).success).toBe(false)
    expect(askInboxSchema.safeParse({ question: '  ' }).success).toBe(false)
    expect(askInboxSchema.safeParse({ question: 'x'.repeat(2000) }).success).toBe(true)
    expect(askInboxSchema.safeParse({ question: 'x'.repeat(2001) }).success).toBe(false)
    expect(askInboxSchema.safeParse({}).success).toBe(false)
  })

  it('mail:get-attachment —— id 正整数，partId ≤100 字符（允许空串走回填，V2 M2）', () => {
    expect(getAttachmentSchema.safeParse({ id: 1, partId: '2' }).success).toBe(true)
    expect(getAttachmentSchema.safeParse({ id: 1, partId: '' }).success).toBe(true)
    expect(getAttachmentSchema.safeParse({ id: 0, partId: '2' }).success).toBe(false)
    expect(getAttachmentSchema.safeParse({ id: 1, partId: 'x'.repeat(101) }).success).toBe(false)
    expect(getAttachmentSchema.safeParse({ id: 1 }).success).toBe(false)
  })

  it('mail:list —— limit 1..2000 整数，offset 非负整数', () => {
    expect(listMailsSchema.safeParse({}).success).toBe(true)
    expect(listMailsSchema.safeParse({ limit: 20 }).success).toBe(true)
    expect(listMailsSchema.safeParse({ limit: 1000 }).success).toBe(true)
    expect(listMailsSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(listMailsSchema.safeParse({ limit: 2001 }).success).toBe(false)
    expect(listMailsSchema.safeParse({ limit: 1.5 }).success).toBe(false)
    expect(listMailsSchema.safeParse({ limit: '20' }).success).toBe(false)
    expect(listMailsSchema.safeParse({ offset: -1 }).success).toBe(false)
    // 文件夹过滤（V2 M3）
    expect(listMailsSchema.safeParse({ folder: 'Sent' }).success).toBe(true)
    expect(listMailsSchema.safeParse({ folder: '' }).success).toBe(false)
    // 标签/星标过滤（V2 M4）
    expect(listMailsSchema.safeParse({ labelIds: [1, 2] }).success).toBe(true)
    expect(listMailsSchema.safeParse({ labelIds: [] }).success).toBe(true)
    expect(listMailsSchema.safeParse({ labelIds: [0] }).success).toBe(false)
    expect(listMailsSchema.safeParse({ labelIds: Array.from({ length: 51 }, (_, i) => i + 1) }).success).toBe(false)
    expect(listMailsSchema.safeParse({ starredOnly: true }).success).toBe(true)
    expect(listMailsSchema.safeParse({ starredOnly: 'yes' }).success).toBe(false)
  })

  it('mail:sync —— folders 数组（V2 M3）', () => {
    expect(syncMailSchema.safeParse({}).success).toBe(true)
    expect(syncMailSchema.safeParse({ folders: ['INBOX', 'Sent'] }).success).toBe(true)
    expect(syncMailSchema.safeParse({ folders: [] }).success).toBe(true)
    expect(syncMailSchema.safeParse({ folders: Array.from({ length: 11 }, (_, i) => `F${i}`) }).success).toBe(false)
    expect(syncMailSchema.safeParse({ folders: 'INBOX' }).success).toBe(false)
  })

  it('mail:get —— id 必须正整数', () => {
    expect(getMailSchema.safeParse({ id: 1 }).success).toBe(true)
    expect(getMailSchema.safeParse({ id: 0 }).success).toBe(false)
    expect(getMailSchema.safeParse({ id: -1 }).success).toBe(false)
    expect(getMailSchema.safeParse({ id: '1' }).success).toBe(false)
    expect(getMailSchema.safeParse({}).success).toBe(false)
  })

  it('mail:search —— term 1..200 字符', () => {
    expect(searchMailSchema.safeParse({ term: 'VPN' }).success).toBe(true)
    expect(searchMailSchema.safeParse({ term: '' }).success).toBe(false)
    expect(searchMailSchema.safeParse({ term: 'x'.repeat(201) }).success).toBe(false)
  })

  it('settings:set —— 可选字段各自校验（syncWindow 0=全部历史）', () => {
    expect(setSettingsSchema.safeParse({}).success).toBe(true)
    expect(setSettingsSchema.safeParse({ syncWindow: 0 }).success).toBe(true)
    expect(setSettingsSchema.safeParse({ syncWindow: 20 }).success).toBe(true)
    expect(setSettingsSchema.safeParse({ syncWindow: -1 }).success).toBe(false)
    expect(setSettingsSchema.safeParse({ syncWindow: 10001 }).success).toBe(false)
    expect(setSettingsSchema.safeParse({ aiModel: '' }).success).toBe(false)
    expect(setSettingsSchema.safeParse({ apiKey: 'x'.repeat(501) }).success).toBe(false)
    expect(setSettingsSchema.safeParse({ refreshIntervalSec: 300 }).success).toBe(true)
    expect(setSettingsSchema.safeParse({ refreshIntervalSec: 0 }).success).toBe(true)
    expect(setSettingsSchema.safeParse({ refreshIntervalSec: -1 }).success).toBe(false)
    expect(setSettingsSchema.safeParse({ refreshIntervalSec: 86401 }).success).toBe(false)
    expect(setSettingsSchema.safeParse({ summaryPrompt: '自定义提示词' }).success).toBe(true)
    expect(setSettingsSchema.safeParse({ summaryPrompt: 'x'.repeat(2001) }).success).toBe(false)
    expect(setSettingsSchema.safeParse({ autoSummarizeNew: true }).success).toBe(true)
    expect(setSettingsSchema.safeParse({ autoSummarizeNew: 'yes' }).success).toBe(false)
  })

  it('shell:open-external —— url 1..2048 字符（协议校验在 handler 内）', () => {
    expect(openExternalSchema.safeParse({ url: 'https://microsoft.com/devicelogin' }).success).toBe(true)
    expect(openExternalSchema.safeParse({ url: '' }).success).toBe(false)
    expect(openExternalSchema.safeParse({ url: 'x'.repeat(2049) }).success).toBe(false)
  })

  it('labels:create —— name 1..30 字符，color 可选 #hex（V2 M4）', () => {
    expect(createLabelSchema.safeParse({ name: '课业' }).success).toBe(true)
    expect(createLabelSchema.safeParse({ name: '课业', color: '#ff375f' }).success).toBe(true)
    expect(createLabelSchema.safeParse({ name: '' }).success).toBe(false)
    expect(createLabelSchema.safeParse({ name: '  ' }).success).toBe(false)
    expect(createLabelSchema.safeParse({ name: 'x'.repeat(31) }).success).toBe(false)
    expect(createLabelSchema.safeParse({ name: 'x', color: 'red' }).success).toBe(false)
    expect(createLabelSchema.safeParse({}).success).toBe(false)
  })

  it('labels:delete —— id 正整数（V2 M4）', () => {
    expect(deleteLabelSchema.safeParse({ id: 1 }).success).toBe(true)
    expect(deleteLabelSchema.safeParse({ id: 0 }).success).toBe(false)
    expect(deleteLabelSchema.safeParse({}).success).toBe(false)
  })

  it('mail:set-labels —— id 正整数 + labelIds 数组（V2 M4）', () => {
    expect(setMailLabelsSchema.safeParse({ id: 1, labelIds: [1, 2] }).success).toBe(true)
    expect(setMailLabelsSchema.safeParse({ id: 1, labelIds: [] }).success).toBe(true)
    expect(setMailLabelsSchema.safeParse({ id: 1 }).success).toBe(false)
    expect(setMailLabelsSchema.safeParse({ id: 0, labelIds: [] }).success).toBe(false)
    expect(setMailLabelsSchema.safeParse({ id: 1, labelIds: [0] }).success).toBe(false)
  })

  it('mail:toggle-star —— id 正整数 + starred 布尔（V2 M4）', () => {
    expect(toggleStarSchema.safeParse({ id: 1, starred: true }).success).toBe(true)
    expect(toggleStarSchema.safeParse({ id: 1, starred: false }).success).toBe(true)
    expect(toggleStarSchema.safeParse({ id: 1 }).success).toBe(false)
    expect(toggleStarSchema.safeParse({ id: 1, starred: 'yes' }).success).toBe(false)
    expect(toggleStarSchema.safeParse({ id: 0, starred: true }).success).toBe(false)
  })

  it('view filter/sort —— 字段与枚举校验（V2 M5）', () => {
    expect(viewFilterSchema.safeParse({}).success).toBe(true)
    expect(viewFilterSchema.safeParse({ text: 'VPN', unread: true, labelIds: [1], dateFrom: 0 }).success).toBe(true)
    expect(viewFilterSchema.safeParse({ text: '' }).success).toBe(false)
    expect(viewFilterSchema.safeParse({ unknown: 1 }).success).toBe(false)
    expect(viewFilterSchema.safeParse({ labelIds: [0] }).success).toBe(false)
    expect(viewFilterSchema.safeParse({ dateFrom: -1 }).success).toBe(false)
    expect(viewSortSchema.safeParse({ by: 'date', dir: 'desc' }).success).toBe(true)
    expect(viewSortSchema.safeParse({ by: 'subject', dir: 'asc' }).success).toBe(true)
    expect(viewSortSchema.safeParse({ by: 'size', dir: 'asc' }).success).toBe(false)
    expect(viewSortSchema.safeParse({ by: 'date', dir: 'up' }).success).toBe(false)
  })

  it('views:save —— name + filter + sort，id 可选覆盖（V2 M5）', () => {
    const base = { name: 'VPN 视图', filter: { text: 'VPN' }, sort: { by: 'date', dir: 'desc' } }
    expect(saveViewSchema.safeParse(base).success).toBe(true)
    expect(saveViewSchema.safeParse({ ...base, id: 1 }).success).toBe(true)
    expect(saveViewSchema.safeParse({ ...base, id: 0 }).success).toBe(false)
    expect(saveViewSchema.safeParse({ ...base, name: '' }).success).toBe(false)
    expect(saveViewSchema.safeParse({ ...base, name: 'x'.repeat(51) }).success).toBe(false)
    expect(saveViewSchema.safeParse({ ...base, filter: { bogus: 1 } }).success).toBe(false)
    expect(saveViewSchema.safeParse({ ...base, sort: { by: 'nope', dir: 'asc' } }).success).toBe(false)
    expect(saveViewSchema.safeParse({ name: 'x' }).success).toBe(false)
  })

  it('views:delete —— id 正整数（V2 M5）', () => {
    expect(deleteViewSchema.safeParse({ id: 1 }).success).toBe(true)
    expect(deleteViewSchema.safeParse({ id: 0 }).success).toBe(false)
    expect(deleteViewSchema.safeParse({}).success).toBe(false)
  })

  it('mail:list —— filter/sort 透传（V2 M5）', () => {
    expect(listMailsSchema.safeParse({ filter: { text: 'VPN' }, sort: { by: 'subject', dir: 'asc' } }).success).toBe(true)
    expect(listMailsSchema.safeParse({ filter: { labelIds: [1, 2] } }).success).toBe(true)
    expect(listMailsSchema.safeParse({ filter: { labelIds: [0] } }).success).toBe(false)
    expect(listMailsSchema.safeParse({ sort: { by: 'date', dir: 'up' } }).success).toBe(false)
  })

  it('mail:snooze —— id 正整数 + until 正整数时间戳，note 可选 ≤200（V2 M6）', () => {
    expect(snoozeMailSchema.safeParse({ id: 1, until: 1730000000000 }).success).toBe(true)
    expect(snoozeMailSchema.safeParse({ id: 1, until: 1730000000000, note: '记得跟进' }).success).toBe(true)
    expect(snoozeMailSchema.safeParse({ id: 1 }).success).toBe(false)
    expect(snoozeMailSchema.safeParse({ id: 0, until: 1 }).success).toBe(false)
    expect(snoozeMailSchema.safeParse({ id: 1, until: 0 }).success).toBe(false)
    expect(snoozeMailSchema.safeParse({ id: 1, until: 1, note: 'x'.repeat(201) }).success).toBe(false)
  })

  it('mail:snooze:cancel —— id 正整数（V2 M6）', () => {
    expect(cancelSnoozeSchema.safeParse({ id: 1 }).success).toBe(true)
    expect(cancelSnoozeSchema.safeParse({ id: 0 }).success).toBe(false)
    expect(cancelSnoozeSchema.safeParse({}).success).toBe(false)
  })

  it('mail:bulk-read / mail:bulk-label —— ids 1..500 正整数（V2 M7）', () => {
    expect(bulkReadSchema.safeParse({ ids: [1, 2], read: true }).success).toBe(true)
    expect(bulkReadSchema.safeParse({ ids: [1], read: false }).success).toBe(true)
    expect(bulkReadSchema.safeParse({ ids: [], read: true }).success).toBe(false)
    expect(bulkReadSchema.safeParse({ ids: [0], read: true }).success).toBe(false)
    expect(bulkReadSchema.safeParse({ ids: [1] }).success).toBe(false)
    expect(bulkReadSchema.safeParse({ ids: Array.from({ length: 501 }, (_, i) => i + 1), read: true }).success).toBe(false)
    expect(bulkLabelSchema.safeParse({ ids: [1], labelIds: [1, 2] }).success).toBe(true)
    expect(bulkLabelSchema.safeParse({ ids: [1], labelIds: [] }).success).toBe(false)
    expect(bulkLabelSchema.safeParse({ ids: [1], labelIds: [0] }).success).toBe(false)
    expect(bulkLabelSchema.safeParse({ ids: [1] }).success).toBe(false)
  })

  it('drafts:save / drafts:delete —— 草稿校验（V2 M9）', () => {
    const base = { toAddrs: ['a@example.edu'], subject: '课题讨论', body: '正文' }
    expect(saveDraftSchema.safeParse(base).success).toBe(true)
    expect(saveDraftSchema.safeParse({ ...base, id: 1 }).success).toBe(true)
    expect(saveDraftSchema.safeParse({ ...base, id: 0 }).success).toBe(false)
    expect(saveDraftSchema.safeParse({ ...base, toAddrs: [] }).success).toBe(false)
    expect(saveDraftSchema.safeParse({ ...base, toAddrs: [''] }).success).toBe(false)
    expect(saveDraftSchema.safeParse({ ...base, subject: 'x'.repeat(301) }).success).toBe(false)
    expect(saveDraftSchema.safeParse({ ...base, body: 'x'.repeat(20001) }).success).toBe(false)
    expect(saveDraftSchema.safeParse({ toAddrs: ['a@example.edu'] }).success).toBe(false)
    expect(deleteDraftSchema.safeParse({ id: 1 }).success).toBe(true)
    expect(deleteDraftSchema.safeParse({ id: 0 }).success).toBe(false)
  })
  it('ai:summarize-pending / mail:resync —— 批量总结与修复同步入参（V2.1）', () => {
    expect(summarizePendingSchema.safeParse({}).success).toBe(true)
    expect(summarizePendingSchema.safeParse({ limit: 30 }).success).toBe(true)
    expect(summarizePendingSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(summarizePendingSchema.safeParse({ limit: 500 }).success).toBe(true)
    expect(summarizePendingSchema.safeParse({ limit: 501 }).success).toBe(false)
    expect(summarizePendingSchema.safeParse({ limit: 201 }).success).toBe(true)
    expect(summarizePendingSchema.safeParse({ limit: 1.5 }).success).toBe(false)
    expect(summarizePendingSchema.safeParse({ force: true }).success).toBe(true)
    expect(summarizePendingSchema.safeParse({ force: 'yes' }).success).toBe(false)
    expect(resyncSchema.safeParse({}).success).toBe(true)
    expect(resyncSchema.safeParse({ folder: 'INBOX' }).success).toBe(true)
    expect(resyncSchema.safeParse({ folder: '' }).success).toBe(false)
  })

})
