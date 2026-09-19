/**
 * 已发送（本地记录）：发信成功后主进程会写入 sent_items，这里展示并支持删除。
 * 说明：SMTP 发信不会自动在服务器「已发送邮件」留副本（Exchange Online 的 SMTP 提交行为），
 * 所以本地留一份记录，方便回看内容与失败原因。
 */
import { memo, useCallback, useEffect, useState } from 'react'
import type { SentItem } from '@shared/types'
import { formatFullDate } from '@shared/format'
import { api } from '../bridge'
import { errorMessage } from '../lib/errors'
import type { PageProps } from '../registry'

export const SentPage = memo(function SentPage({ onToast, isActive }: PageProps) {
  const [items, setItems] = useState<SentItem[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const list = await api.listSentItems(200)
      setItems(list)
      setSelected((prev) => (prev && list.some((s) => s.id === prev) ? prev : list[0]?.id ?? null))
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [onToast])

  // 页面常驻挂载（V2.1）：切到本页时重新拉一次，否则会一直显示启动时的空列表
  useEffect(() => {
    if (isActive === false) return
    void load()
  }, [isActive, load])

  const remove = useCallback(
    async (id: number) => {
      try {
        await api.deleteSentItem(id)
        onToast('已删除该发送记录')
        await load()
      } catch (e) {
        onToast(errorMessage(e))
      }
    },
    [load, onToast]
  )

  const current = items.find((s) => s.id === selected) ?? null

  return (
    <div className="sent-page" data-testid="sent-page">
      <header className="topbar">
        <div className="title">
          已发送 <span className="sub">共 {items.length} 封（本地记录）</span>
        </div>
      </header>
      <div className="sent-body">
        <div className="sent-list" data-testid="sent-list">
          {loading && <div className="empty-hint">加载中…</div>}
          {!loading && items.length === 0 && (
            <div className="empty-hint" data-testid="sent-empty">
              还没有发送记录。打开一封邮件点「↩ 回复」，或在草稿箱里点「发送」。
            </div>
          )}
          {items.map((s) => (
            <button
              key={s.id}
              className={`sent-item ${selected === s.id ? 'active' : ''}`}
              onClick={() => setSelected(s.id)}
              data-testid="sent-item"
            >
              <div className="row1">
                <span className="to">{s.toAddrs.join(', ') || '(无收件人)'}</span>
                <span className="time">{formatFullDate(s.sentAt)}</span>
              </div>
              <div className="subject">{s.subject}</div>
              <div className="meta-row">
                <span className={`tag ${s.status === 'sent' ? 'ok' : 'bad'}`}>
                  {s.status === 'sent' ? '✅ 已发送' : '❌ 发送失败'}
                </span>
                {s.ccAddrs.length > 0 && <span className="hint">抄送 {s.ccAddrs.length} 人</span>}
              </div>
            </button>
          ))}
        </div>
        <div className="sent-detail" data-testid="sent-detail">
          {current ? (
            <>
              <div className="sent-detail-head">
                <div className="subject">{current.subject}</div>
                <div className="hint">
                  收件人：{current.toAddrs.join(', ') || '—'}
                  {current.ccAddrs.length > 0 ? ` ｜ 抄送：${current.ccAddrs.join(', ')}` : ''}
                </div>
                <div className="hint">发送时间：{formatFullDate(current.sentAt)}</div>
                {current.error && (
                  <div className="sent-error" data-testid="sent-error">
                    失败原因：{current.error}
                  </div>
                )}
                <button className="link-btn" onClick={() => void remove(current.id)} data-testid="sent-delete">
                  删除这条记录
                </button>
              </div>
              <pre className="plain sent-body-text">{current.body || '（无正文）'}</pre>
            </>
          ) : (
            <div className="empty-hint">选择左侧一条记录查看内容</div>
          )}
        </div>
      </div>
    </div>
  )
})
