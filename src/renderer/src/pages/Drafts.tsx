/**
 * 草稿箱（V2 M9）：本地草稿列表 + 编辑器。
 * - 「发送」已开放：走 IPC mail:send（学校账号用 SMTP + OAuth，个人邮箱用应用密码），
 *   发送成功后自动删除该草稿并写入「已发送」记录；
 * - 草稿本身只存本地 SQLite，不会自动上传。
 */
import { memo, useCallback, useEffect, useState } from 'react'
import type { MailDraft } from '@shared/types'
import { formatRelativeDate } from '@shared/format'
import { api } from '../bridge'
import { errorMessage } from '../lib/errors'
import type { PageProps } from '../registry'
import { ComposeModal, type ComposeInitial } from '../components/ComposeModal'

export const DraftsPage = memo(function DraftsPage({ onToast }: PageProps) {
  const [drafts, setDrafts] = useState<MailDraft[]>([])
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [compose, setCompose] = useState<ComposeInitial | null>(null)

  const load = useCallback(async () => {
    try {
      setDrafts(await api.listDrafts())
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [onToast])

  useEffect(() => {
    void load()
  }, [load])

  const openNew = useCallback(() => {
    setCurrentId(null)
    setTo('')
    setSubject('')
    setBody('')
  }, [])

  const openDraft = useCallback((d: MailDraft) => {
    setCurrentId(d.id)
    setTo(d.toAddrs.join(', '))
    setSubject(d.subject)
    setBody(d.body)
  }, [])

  const save = useCallback(async () => {
    if (busy) return
    const toAddrs = to
      .split(/[,;，；]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (toAddrs.length === 0) {
      onToast('请先填写收件人')
      return
    }
    setBusy(true)
    try {
      const saved = await api.saveDraft({ id: currentId ?? undefined, toAddrs, subject: subject.trim() || '(无主题)', body })
      setCurrentId(saved.id)
      onToast('草稿已保存（仅本地）')
      await load()
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [busy, to, subject, body, currentId, onToast, load])

  const remove = useCallback(
    async (id: number) => {
      if (busy) return
      setBusy(true)
      try {
        await api.deleteDraft(id)
        if (currentId === id) openNew()
        onToast('草稿已删除')
        await load()
      } catch (e) {
        onToast(errorMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [busy, currentId, openNew, onToast, load]
  )

  return (
    <div className="drafts-wrap" data-testid="drafts-page">
      <header className="topbar">
        <div className="title">
          ✎ 草稿箱 <span className="sub">本地保存 · 可直接发送</span>
        </div>
        <button className="btn primary" onClick={openNew} data-testid="draft-new-btn">
          ＋ 写邮件
        </button>
      </header>
      <div className="workspace drafts-workspace">
        <section className="list-pane">
          <div className="list-toolbar">
            <span className="muted">{drafts.length} 封草稿</span>
          </div>
          <div className="mail-list">
            {drafts.length === 0 ? (
              <div className="list-empty">暂无草稿，点「写邮件」开始</div>
            ) : (
              drafts.map((d) => (
                <div
                  key={d.id}
                  className={`mail-item ${currentId === d.id ? 'selected' : ''}`}
                  onClick={() => openDraft(d)}
                  data-testid="draft-item"
                >
                  <div className="avatar" style={{ background: '#5e5ce6' }}>
                    {d.toAddrs[0]?.slice(0, 1) || '?'}
                  </div>
                  <div className="mail-item-body">
                    <div className="mail-item-top">
                      <span className="from">{d.subject}</span>
                      <span className="time">{formatRelativeDate(d.updatedAt)}</span>
                    </div>
                    <div className="snippet">收件人：{d.toAddrs.join('、')}</div>
                    <div className="snippet">{d.body.slice(0, 60) || '（无正文）'}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
        <div className="draft-editor" data-testid="draft-editor">
          <div className="draft-field">
            <label>收件人</label>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="收件人邮箱（多个用逗号分隔）"
              data-testid="draft-to-input"
            />
          </div>
          <div className="draft-field">
            <label>主题</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="邮件主题"
              maxLength={300}
              data-testid="draft-subject-input"
            />
          </div>
          <div className="draft-field grow">
            <label>正文</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="正文内容…"
              data-testid="draft-body-input"
            />
          </div>
          <div className="draft-actions">
            <button className="btn primary" onClick={() => void save()} disabled={busy} data-testid="draft-save-btn">
              💾 保存草稿
            </button>
            <button
              className="btn"
              onClick={() => {
                const toAddrs = to
                  .split(/[,;，；]/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                if (toAddrs.length === 0) {
                  onToast('请先填写收件人')
                  return
                }
                setCompose({
                  title: '发送草稿',
                  to: toAddrs.join(', '),
                  subject: subject.trim() || '(无主题)',
                  body,
                  draftId: currentId ?? undefined
                })
              }}
              disabled={busy}
              title="通过 SMTP 直接发送（学校账号走 OAuth）"
              data-testid="draft-send-btn"
            >
              ➤ 发送
            </button>
            {currentId !== null && (
              <button className="btn ghost" onClick={() => void remove(currentId)} disabled={busy} data-testid="draft-delete">
                🗑 删除草稿
              </button>
            )}
          </div>
          <div className="draft-hint" data-testid="draft-send-hint">
            ℹ️ 发送会通过 SMTP 真实投递（学校账号用登录凭据 + SMTP.Send 权限）。发送成功后草稿会自动删除，
            并在左侧「已发送」留一条本地记录。
          </div>
        </div>
      </div>

      <ComposeModal
        open={compose !== null}
        initial={compose ?? {}}
        onClose={() => setCompose(null)}
        onSent={() => {
          setCompose(null)
          onToast('邮件已发送，草稿已删除（可在左侧「已发送」查看）')
          void load()
          openNew()
        }}
      />
    </div>
  )
})
