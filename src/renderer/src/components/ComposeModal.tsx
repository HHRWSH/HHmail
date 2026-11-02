/**
 * 发信弹层（回复 / 转发 / 草稿发送 / 新写共用）。
 * - 真正发信走 IPC mail:send → 主进程 SMTP：
 *   学校账号用登录 token（AUTH XOAUTH2，需要 scope SMTP.Send），个人邮箱用保存的应用密码；
 * - 成功后写入本地「已发送」记录；带 draftId 时同时删除对应草稿。
 */
import { memo, useEffect, useState } from 'react'
import type { MailAttachmentPayload, SendMailResult } from '@shared/types'
import { api } from '../bridge'
import { errorMessage } from '../lib/errors'
import { useSettings } from '../settings-context'
import {
  MAX_ATTACH_COUNT,
  MAX_ATTACH_TOTAL_BYTES,
  MAX_ATTACH_BYTES,
  formatAttachmentSize,
  mergeAttachments,
  totalAttachmentBytes
} from '@shared/attachments'

// 兼容旧引用（ComposeModal 内部/测试都从这里导入常量）
export { MAX_ATTACH_BYTES, MAX_ATTACH_TOTAL_BYTES, MAX_ATTACH_COUNT }

export interface ComposeInitial {
  to?: string
  cc?: string
  subject?: string
  body?: string
  inReplyTo?: string
  draftId?: number
  /** 弹层标题（回复 / 转发 / 发送草稿 / 写邮件） */
  title?: string
}

interface Props {
  open: boolean
  initial: ComposeInitial
  onClose: () => void
  onSent?: (result: SendMailResult) => void
}

export const ComposeModal = memo(function ComposeModal({ open, initial, onClose, onSent }: Props) {
  const settings = useSettings()
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<MailAttachmentPayload[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<SendMailResult | null>(null)

  useEffect(() => {
    if (!open) return
    setTo(initial.to ?? '')
    setCc(initial.cc ?? '')
    setSubject(initial.subject ?? '')
    setBody(initial.body ?? '')
    setAttachments([])
    setAttachError(null)
    setResult(null)
    setSending(false)
  }, [open, initial])

  if (!open) return null

  /** 选附件：走主进程 dialog（渲染进程不直接读盘），拿到 base64 后只保留展示所需字段 */
  const pickAttachments = async (): Promise<void> => {
    setAttachError(null)
    try {
      const picked = await api.pickAttachments()
      if (!picked || picked.length === 0) return
      const merged = mergeAttachments(attachments, picked)
      setAttachments(merged.list)
      if (merged.error) setAttachError(merged.error)
    } catch (e) {
      setAttachError(errorMessage(e))
    }
  }

  const totalBytes = totalAttachmentBytes(attachments)

  const send = async (): Promise<void> => {
    if (sending) return
    // 设置里的「发送前确认」：默认关闭，开启后先弹一次确认（防手滑）
    if (settings.confirmBeforeSend) {
      const ok = window.confirm(`确认发送这封邮件给 ${to || '（未填收件人）'} 吗？`)
      if (!ok) return
    }
    setSending(true)
    setResult(null)
    try {
      const r = await api.sendMail({
        to,
        cc,
        subject,
        body,
        attachments: attachments.length > 0 ? attachments : undefined,
        inReplyTo: initial.inReplyTo,
        draftId: initial.draftId
      })
      setResult(r)
      if (r.ok) onSent?.(r)
    } catch (e) {
      setResult({ ok: false, stage: 'error', serverMessage: errorMessage(e), conclusion: `❌ ${errorMessage(e)}` })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="compose-mask" data-testid="compose-modal" onClick={onClose}>
      <div className="compose" onClick={(e) => e.stopPropagation()}>
        <div className="compose-head">
          <span>✉️ {initial.title ?? '写邮件'}</span>
          <button className="link-btn" onClick={onClose} data-testid="compose-close">
            关闭
          </button>
        </div>
        <div className="compose-fields">
          <label className="compose-row">
            <span className="k">收件人</span>
            <input
              className="input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="多个地址用逗号分隔"
              data-testid="compose-to"
            />
          </label>
          <label className="compose-row">
            <span className="k">抄送</span>
            <input className="input" value={cc} onChange={(e) => setCc(e.target.value)} data-testid="compose-cc" />
          </label>
          <label className="compose-row">
            <span className="k">主题</span>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="compose-subject" />
          </label>
          <textarea
            className="compose-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="正文"
            data-testid="compose-body"
          />
        </div>
        {result && (
          <div className={`compose-result ${result.ok ? 'ok' : 'bad'}`} data-testid="compose-result">
            {result.conclusion}
          </div>
        )}
        <div className="compose-attach" data-testid="compose-attach-area">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void pickAttachments()}
            disabled={sending}
            data-testid="compose-add-attachment"
          >
            📎 添加附件
          </button>
          <span className="hint">
            {attachments.length > 0
              ? `已选 ${attachments.length} 个（${formatAttachmentSize(totalBytes)} / 上限 20MB）`
              : '最多 10 个，合计不超过 20MB'}
          </span>
          {attachError && (
            <span className="compose-attach-err" data-testid="compose-attach-error">
              {attachError}
            </span>
          )}
          {attachments.length > 0 && (
            <ul className="compose-attach-list" data-testid="compose-attach-list">
              {attachments.map((a, i) => (
                <li key={`${a.filename}:${a.size}`} data-testid="compose-attach-item">
                  <span className="name" title={a.filename}>
                    {a.filename}
                  </span>
                  <span className="size">{formatAttachmentSize(a.size)}</span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                    disabled={sending}
                    data-testid="compose-attach-remove"
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attachments.length > 0 && initial.draftId !== undefined && (
            <div className="hint" data-testid="compose-draft-attach-hint">
              ⚠️ 草稿暂不保存附件：保存草稿后附件会被丢弃，请直接发送。
            </div>
          )}
        </div>
        <div className="compose-foot">
          <span className="hint">收件人只填地址；发送记录会保存在左侧「已发送」。</span>
          <button className="btn primary" onClick={() => void send()} disabled={sending} data-testid="compose-send">
            {sending ? '发送中…' : attachments.length > 0 ? `发送（含 ${attachments.length} 个附件）` : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
})

/** 回复/转发时的引用正文（尽量保留上下文，过长截断）。 */
export function buildQuotedBody(
  mail: { fromName: string; fromAddr: string; dateLabel: string; subject: string; bodyText: string },
  mode: 'reply' | 'forward'
): string {
  const quoted = (mail.bodyText || '').trim().slice(0, 4000)
  const head = `------------------ 原始邮件 ------------------\n发件人：${mail.fromName || mail.fromAddr} <${mail.fromAddr}>\n时间：${mail.dateLabel}\n主题：${mail.subject}`
  return mode === 'reply' ? `\n\n${head}\n\n${quoted}` : `\n\n---------- 转发邮件 ----------\n${head}\n\n${quoted}`
}

/** 回复/转发的主题前缀（避免重复叠加 Re: / Fwd:）。 */
export function buildReplySubject(subject: string, mode: 'reply' | 'forward'): string {
  const s = (subject || '(无主题)').trim()
  if (mode === 'reply') return /^re:/i.test(s) ? s : `Re: ${s}`
  return /^(fwd|fw):/i.test(s) ? s : `Fwd: ${s}`
}
