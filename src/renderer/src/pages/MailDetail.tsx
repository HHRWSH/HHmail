/**
 * 邮件详情页：主题/发件人/收件人/时间 + 已保存 AI 摘要（置顶）+ 正文渲染 + AI 总结。
 * - plain text 优先；HTML 兜底且必须经 DOMPurify 净化（sanitize.ts）；
 * - 默认不加载远程图片，点「加载图片」经确认后放行；
 * - 正文里的链接点击后经确认在默认浏览器打开（不改变应用页面）；
 * - 「✨ AI 总结」对本邮件所在线程调用 MailAiService，结果自动持久化，
 *   下次打开时展示在正文最前面。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MailCategory, MailDetail, MailLabel } from '@shared/types'
import { formatFullDate, formatBytes } from '@shared/format'
import { shortcutMap } from '@shared/shortcuts'
import { api } from '../bridge'
import { errorMessage } from '../lib/errors'
import { sanitizeHtml } from '../lib/sanitize'
import { renderMarkdown } from '@shared/markdown'
import { mergeTags, parseVocabulary } from '@shared/tags'
import { avatarColor, avatarInitial } from '@shared/avatar'
import { useSettings } from '../settings-context'
import { SummaryView } from '../components/SummaryView'
import { buildQuotedBody, buildReplySubject, ComposeModal, type ComposeInitial } from '../components/ComposeModal'

interface Props {
  mailId: number | null
  onToast: (message: string) => void
  /** 标签变化时通知上层（刷新侧边栏标签列表，V2 M4） */
  onLabelsChanged?: () => void
  /** 邮件本地状态变化（稍后提醒/星标等）→ 通知列表刷新（V2 M6） */
  onMailChanged?: () => void
  /** 快捷键 l 的信号：>0 时打开标签面板（V2 M7） */
  openLabelsSignal?: number
  /** 收件箱页是否激活（V2.1：非激活时不响应 Esc） */
  isActive?: boolean
}

/** 新建类别的可选颜色（Gmail 同款色系） */
const CATEGORY_COLORS = ['#1a73e8', '#188038', '#e8710a', '#8430ce', '#d93025', '#f9ab00', '#12b5cb', '#e52592']

export const MailDetailPane = memo(function MailDetailPane({ mailId, onToast, onLabelsChanged, onMailChanged, openLabelsSignal, isActive = true }: Props) {
  const settings = useSettings()
  const [mail, setMail] = useState<MailDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [summaryModel, setSummaryModel] = useState<string | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  // 用户要求：图片直接自动加载（不需要确认、不担心暴露 IP）；仍提供「隐藏图片」开关
  // V2 M4：标签/星标
  const [allLabels, setAllLabels] = useState<MailLabel[]>([])
  // 发信：回复/转发弹层
  const [compose, setCompose] = useState<ComposeInitial | null>(null)
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [tagBusy, setTagBusy] = useState(false)
  // V2.2：彩色类别（Gmail 风格：搜索 + 彩色列表 + 新建类别 / 管理类别）
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [categoryList, setCategoryList] = useState<MailCategory[]>([])
  // 可勾选的标签 = 设置里的词表 ∪ 这封邮件已有的标签（含 AI/规则给的）
  const tagChoices = useMemo(
    () => mergeTags(mail?.manualTags, mail?.autoTags, parseVocabulary(settings.tagVocabulary)).slice(0, 40),
    [mail?.manualTags, mail?.autoTags, settings.tagVocabulary]
  )
  const [labelInput, setLabelInput] = useState('')
  const [labelBusy, setLabelBusy] = useState(false)
  // V2 M6：稍后提醒
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [snoozeNote, setSnoozeNote] = useState('')
  const [snoozeCustom, setSnoozeCustom] = useState('')
  const [snoozeBusy, setSnoozeBusy] = useState(false)
  // 摘要渲染模式：默认 Markdown 预览，可切换看源码
  const [summarySource, setSummarySource] = useState(false)

  const load = useCallback(
    async (id: number | null) => {
      if (!id) {
        setMail(null)
        return
      }
      setLoading(true)
      try {
        const detail = await api.getMail(id)
        setMail(detail)
        setSummary(null)
        setSummaryModel(null)
      } catch (e) {
        setMail(null)
        onToast(errorMessage(e))
      } finally {
        setLoading(false)
      }
    },
    [onToast]
  )

  useEffect(() => {
    void load(mailId)
  }, [mailId, load])

  // 标签面板打开时拉取全部标签（V2 M4）
  useEffect(() => {
    if (!labelsOpen) return
    api
      .listLabels()
      .then(setAllLabels)
      .catch(() => undefined)
  }, [labelsOpen, mailId])

  // 快捷键 l（Inbox 转发信号）→ 打开标签面板（V2 M7）
  useEffect(() => {
    if (openLabelsSignal && openLabelsSignal > 0) setLabelsOpen(true)
  }, [openLabelsSignal])

  // 详情页快捷键：Esc 关闭弹层（V2 M7；仅收件箱激活时响应）
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isActiveRef.current) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape') (target as HTMLInputElement).blur()
        return
      }
      const action = shortcutMap(e.key, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey }, 'detail')
      if (action === 'close') {
        setLabelsOpen(false)
        setSnoozeOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleFlag = useCallback(async () => {
    if (!mail) return
    try {
      await api.setFlagged(mail.id, !mail.flagged)
      await load(mail.id)
      onMailChanged?.()
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [mail, load, onMailChanged, onToast])

  const toggleStar = useCallback(async () => {
    if (!mail) return
    try {
      await api.toggleStar(mail.id, !mail.starred)
      await load(mail.id)
      // 立即刷新列表（星标/标签变化即时可见，无需切换页面）
      onMailChanged?.()
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [mail, load, onToast, onMailChanged])

  const toggleLabel = useCallback(
    async (labelId: number) => {
      if (!mail || labelBusy) return
      setLabelBusy(true)
      try {
        const has = mail.labels.some((l) => l.id === labelId)
        const next = has ? mail.labels.filter((l) => l.id !== labelId).map((l) => l.id) : [...mail.labels.map((l) => l.id), labelId]
        await api.setMailLabels(mail.id, next)
        await load(mail.id)
        onMailChanged?.()
      } catch (e) {
        onToast(errorMessage(e))
      } finally {
        setLabelBusy(false)
      }
    },
    [mail, labelBusy, load, onToast, onMailChanged]
  )

  /** 手动标签：勾选/取消（统一标签体系；去掉自动标签会记入抑制表，重算不会加回来） */
  const toggleTag = useCallback(
    async (tag: string, on: boolean) => {
      if (!mail || tagBusy) return
      setTagBusy(true)
      try {
        await api.setMailTagManual(mail.id, tag, on)
        await load(mail.id)
        // 列表里的标签 chip 与「✋ 手动改过」标识也要跟着刷新
        onMailChanged?.()
        onLabelsChanged?.()
      } catch (e) {
        onToast(errorMessage(e))
      } finally {
        setTagBusy(false)
      }
    },
    [mail, tagBusy, load, onToast, onLabelsChanged, onMailChanged]
  )

  const addManualTag = useCallback(async () => {
    const tag = labelInput.trim().slice(0, 12)
    if (!tag) return
    await toggleTag(tag, true)
    setLabelInput('')
  }, [labelInput, toggleTag])

  // ---- V2 M6：稍后提醒 ----

  const nextOccurrence = useCallback((hour: number, minute = 0): number => {
    const d = new Date()
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0)
    if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1)
    return t.getTime()
  }, [])

  const doSnooze = useCallback(
    async (untilMs: number) => {
      if (!mail || snoozeBusy || untilMs <= Date.now()) return
      setSnoozeBusy(true)
      try {
        await api.snoozeMail(mail.id, untilMs, snoozeNote.trim() || undefined)
        setSnoozeOpen(false)
        setSnoozeNote('')
        setSnoozeCustom('')
        onToast('已设置稍后提醒')
        await load(mail.id)
        onMailChanged?.()
      } catch (e) {
        onToast(errorMessage(e))
      } finally {
        setSnoozeBusy(false)
      }
    },
    [mail, snoozeBusy, snoozeNote, load, onToast, onMailChanged]
  )

  const cancelSnooze = useCallback(async () => {
    if (!mail || snoozeBusy) return
    setSnoozeBusy(true)
    try {
      await api.cancelSnooze(mail.id)
      setSnoozeOpen(false)
      onToast('已取消稍后提醒')
      await load(mail.id)
      onMailChanged?.()
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setSnoozeBusy(false)
    }
  }, [mail, snoozeBusy, load, onToast, onMailChanged])

  const doSummarize = useCallback(async () => {
    if (!mail) return
    setSummarizing(true)
    try {
      const result = await api.summarizeMail(mail.id)
      if (!result.text.trim()) {
        onToast('AI 未返回内容，请更换模型（推荐 deepseek-v4-pro）后重试。')
        return
      }
      setSummary(result.messageCount > 1 ? `（本线程共 ${result.messageCount} 封邮件）\n\n${result.text}` : result.text)
      setSummaryModel(result.model)
      if (result.degraded) {
        onToast('AI 未能生成摘要（可能触发内容安全策略），已显示邮件元信息，原摘要未被覆盖')
      } else {
        onToast('摘要已生成并保存，下次打开仍可见')
        // 重新拉取详情，让「已保存摘要」出现在最前面
        await load(mail.id)
      }
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setSummarizing(false)
    }
  }, [mail, load, onToast])

  // 正文链接：拦截跳转 → 确认后交默认浏览器打开（防钓鱼，规范 §2 第 11 条）
  const onBodyClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      const a = target.closest('a')
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href') ?? ''
      if (!/^https?:\/\//i.test(href)) return
      const ok = window.confirm(`将在默认浏览器中打开外部链接：\n${href}\n\n请确认这是可信链接（谨防钓鱼）。`)
      if (!ok) return
      api.openExternal(href).catch((err) => onToast(errorMessage(err)))
    },
    [onToast]
  )

  const [downloadingId, setDownloadingId] = useState<number | null>(null)
  // 类别列表（打开面板时加载一次）
  useEffect(() => {
    if (!categoryOpen) return
    void api
      .listCategories()
      .then(setCategoryList)
      .catch(() => setCategoryList([]))
  }, [categoryOpen])

  const assignCategory = useCallback(
    async (categoryId: number | null) => {
      if (!mail) return
      try {
        await api.setMailCategory(mail.id, categoryId)
        await load(mail.id)
        onMailChanged?.()
        onToast(categoryId === null ? '已清除类别' : `已归入「${categoryList.find((c) => c.id === categoryId)?.name ?? '类别'}」`)
      } catch (e) {
        onToast(errorMessage(e))
      }
    },
    [mail, load, onMailChanged, onToast, categoryList]
  )

  // V2.2 自动标签：把当前邮件设为「AI 打标签的示例邮件」（few-shot）
  const [tagExampleOpen, setTagExampleOpen] = useState(false)
  const [tagExamplePick, setTagExamplePick] = useState<string[]>([])
  const tagExampleCandidates = useMemo(() => {
    const vocab = parseVocabulary(settings.tagVocabulary)
    return mergeTags(mail?.autoTags, vocab).slice(0, 24)
  }, [mail?.autoTags, settings.tagVocabulary])

  const saveTagExample = useCallback(async () => {
    if (!mail) return
    try {
      await api.setTagExample(mail.id, tagExamplePick)
      onToast(
        tagExamplePick.length > 0
          ? `已把「${mail.subject.slice(0, 20)}」设为标签示例：${tagExamplePick.join('、')}`
          : '已取消该邮件的标签示例'
      )
      setTagExampleOpen(false)
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [mail, onToast, tagExamplePick])

  /**
   * 附件保存（V2.2）：交给主进程落盘——未设置「附件保存目录」时弹系统保存对话框，
   * 设置了就直接写进该目录（同名自动加序号）。修掉了旧实现里附件永远下载不了的问题
   * （imapflow 1.x 没有 msg.attachment() 这个 API）。
   */
  const downloadAttachment = useCallback(
    async (attachmentId: number, partId: string, filename: string) => {
      if (!mail || downloadingId !== null) return
      setDownloadingId(attachmentId)
      try {
        const res = await api.saveAttachment(mail.id, partId)
        if (!res.saved) return // 用户取消了保存对话框：不打扰
        onToast(`已保存：${res.path ?? (res.filename || filename)}`)
      } catch (e) {
        onToast(errorMessage(e))
      } finally {
        setDownloadingId(null)
      }
    },
    [mail, downloadingId, onToast]
  )

  // DOMPurify 净化只依赖正文与图片开关，缓存避免每次渲染重复净化（长正文是切页卡顿主因之一）
  // 注意：必须在提前 return 之前调用（React hooks 顺序规则）
  const bodyHtml = useMemo(
    () => (mail && mail.bodyHtml ? sanitizeHtml(mail.bodyHtml, { allowRemoteImages: false }) : null),
    [mail?.bodyHtml]
  )

  if (!mailId || !mail) {
    return (
      <div className="detail-empty" data-testid="detail-empty">
        <div className="inner">
          <div className="big">✉️</div>
          <div>选择一封邮件查看内容</div>
        </div>
      </div>
    )
  }

  const showHtml = !!mail.bodyHtml
  const savedSummaryVisible = !summary && !!mail.savedSummary
  const shownSummary = summary ?? mail.savedSummary
  const shownModel = summaryModel ?? mail.savedSummaryModel

  return (
    <div className="detail-pane" data-testid="mail-detail" tabIndex={-1}>
      <div className="detail-header">
        <div className="detail-title">{mail.subject}</div>
        <div className="detail-from">
          <div className="avatar detail-avatar" style={{ background: avatarColor(mail.fromName, mail.fromAddr) }}>
            {avatarInitial(mail.fromName, mail.fromAddr)}
          </div>
          <div>
            <div className="who">{mail.fromName}</div>
            <div className="email">{mail.fromAddr}</div>
          </div>
          <div className="date">
            {formatFullDate(mail.dateTs)}
            <br />
            <span style={{ fontSize: 10 }}>收件人：{mail.toAddrs.join('、') || '—'}</span>
          </div>
        </div>
        {(mail.autoTags ?? []).length > 0 && (
          <div className="detail-auto-tags" data-testid="detail-auto-tags">
            <span className="lbl">自动标签</span>
            {(mail.autoTags ?? []).map((t) => (
              <span key={t} className={`tag auto ${(mail.manualTags ?? []).includes(t) ? 'manual' : ''}`}>
                {t}
              </span>
            ))}
            {/* V2.2：类别只体现为颜色（用户要求：不要在这里显示类别名 chip） */}
            <button className="link-btn" onClick={() => setTagExampleOpen((v) => !v)} data-testid="tag-example-btn">
              🏷 设为 AI 标签示例
            </button>
          </div>
        )}
        {tagExampleOpen && (
          <div className="tag-example-panel" data-testid="tag-example-panel">
            <div className="hint">
              挑这封邮件作为「AI 打标签」的参考示例：勾选它应该有的标签，之后生成摘要时模型会照这个口径打标签。
            </div>
            <div className="tag-example-chips">
              {tagExampleCandidates.map((t) => (
                <label key={t} className="check-label">
                  <input
                    type="checkbox"
                    checked={tagExamplePick.includes(t)}
                    onChange={(e) =>
                      setTagExamplePick((prev) => (e.target.checked ? [...prev, t] : prev.filter((x) => x !== t)))
                    }
                    data-testid="tag-example-option"
                  />
                  <span>{t}</span>
                </label>
              ))}
            </div>
            <div className="tag-example-actions">
              <button className="btn primary" onClick={() => void saveTagExample()} data-testid="tag-example-save">
                保存示例
              </button>
              <button className="btn ghost" onClick={() => setTagExampleOpen(false)}>
                取消
              </button>
              <span className="hint">示例只保存「主题 + 标签」，不会把正文发给任何人</span>
            </div>
          </div>
        )}
        <div className="detail-actions">
          <button
            className={`chip-btn ${mail.starred ? 'star-on' : ''}`}
            onClick={() => void toggleStar()}
            title={mail.starred ? '取消星标' : '加星标'}
            data-testid="star-btn"
          >
            {mail.starred ? '★ 已星标' : '☆ 星标'}
          </button>
          {/* V2.2：彩色类别（Gmail 风格）—— 标记后列表行用该颜色淡色背景常亮 */}
          <button
            className="chip-btn"
            onClick={() => setCategoryOpen((v) => !v)}
            title="给这封邮件加彩色类别"
            data-testid="category-btn"
            style={mail.category ? { borderColor: mail.category.color, color: mail.category.color } : undefined}
          >
            {mail.category ? `🎨 ${mail.category.name}` : '🎨 类别'}
          </button>
          {/* V2.2：红旗（后续标记）—— 与星标独立，列表里会用红色小旗标出 */}
          <button
            className={`chip-btn ${mail.flagged ? 'flag-on' : ''}`}
            onClick={() => void toggleFlag()}
            title={mail.flagged ? '取消红旗' : '标红旗（后续跟进）'}
            data-testid="flag-btn"
          >
            {mail.flagged ? '🚩 已标红旗' : '⚐ 红旗'}
          </button>
          <button
            className="chip-btn"
            onClick={() => setLabelsOpen((v) => !v)}
            title="管理标签"
            data-testid="labels-btn"
          >
            🏷 标签{mail.labels.length > 0 ? `（${mail.labels.length}）` : ''}
          </button>
          <button
            className={`chip-btn ${mail.snoozeUntil !== null ? 'snooze-on' : ''}`}
            onClick={() => setSnoozeOpen((v) => !v)}
            title="稍后提醒"
            data-testid="snooze-btn"
          >
            ⏰ {mail.snoozeUntil !== null ? '已设提醒' : '稍后提醒'}
          </button>
          <button
            className="chip-btn accent"
            onClick={() => void doSummarize()}
            disabled={summarizing}
            data-testid="ai-summarize-btn"
          >
            ✨ {summarizing ? 'AI 总结中…' : mail.savedSummary ? '重新总结' : 'AI 总结'}
          </button>
          <button
            className="chip-btn"
            onClick={() =>
              setCompose({
                title: '回复',
                to: mail.fromAddr,
                subject: buildReplySubject(mail.subject, 'reply'),
                body: buildQuotedBody(mail, 'reply'),
                inReplyTo: mail.messageId ?? undefined
              })
            }
            data-testid="reply-btn"
          >
            ↩ 回复
          </button>
          <button
            className="chip-btn"
            onClick={() =>
              setCompose({
                title: '转发',
                to: '',
                subject: buildReplySubject(mail.subject, 'forward'),
                body: buildQuotedBody(mail, 'forward')
              })
            }
            data-testid="forward-btn"
          >
            ↪ 转发
          </button>
        </div>
        {labelsOpen && (
          <div className="label-panel" data-testid="label-panel">
            <div className="label-panel-row">
              {tagChoices.map((t) => {
                const on = (mail.autoTags ?? []).includes(t)
                const manual = (mail.manualTags ?? []).includes(t)
                return (
                  <button
                    key={t}
                    className={`label-toggle ${on ? 'on' : ''} ${manual ? 'manual' : ''}`}
                    onClick={() => void toggleTag(t, !on)}
                    disabled={tagBusy}
                    data-testid="tag-toggle"
                    title={manual ? '手动标签（点击移除）' : on ? '自动标签（点击移除，之后重算不会再加回来）' : '点击手动加上这个标签'}
                  >
                    {manual ? '✋ ' : ''}
                    {t}
                  </button>
                )
              })}
              {tagChoices.length === 0 && <span className="muted">词表为空：先在设置 → AI → 标签词表里添加标签。</span>}
            </div>
            <div className="label-panel-row">
              <input
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addManualTag()
                }}
                placeholder="临时加一个不在词表里的标签（回车应用）"
                maxLength={12}
                data-testid="tag-input"
              />
              <button
                className="btn primary sm"
                onClick={() => void addManualTag()}
                disabled={tagBusy || !labelInput.trim()}
                data-testid="tag-add-btn"
              >
                ＋ 手动打标签
              </button>
            </div>
          </div>
        )}
        {categoryOpen && (
          <div className="category-panel" data-testid="category-panel">
            <div className="category-list">
              {categoryList.map((c) => (
                <div key={c.id} className="category-item" data-testid="category-item">
                  <button
                    className={`category-pick ${mail.category?.id === c.id ? 'on' : ''}`}
                    onClick={() => void assignCategory(mail.category?.id === c.id ? null : c.id)}
                  >
                    <span className="category-tag" style={{ background: c.color }}>
                      🏷
                    </span>
                    <span className="category-name">{c.name}</span>
                  </button>
                </div>
              ))}
              {categoryList.length === 0 && <span className="hint">还没有类别：请到设置里新建。</span>}
            </div>
            {mail.category && (
              <button className="link-btn" onClick={() => void assignCategory(null)} data-testid="category-clear">
                清除本邮件的类别
              </button>
            )}
          </div>
        )}
        {snoozeOpen && (
          <div className="label-panel" data-testid="snooze-panel">
            <div className="label-panel-row">
              <button className="chip-btn" onClick={() => void doSnooze(nextOccurrence(20, 0))} disabled={snoozeBusy} data-testid="snooze-tonight">
                🌙 今晚 20:00
              </button>
              <button className="chip-btn" onClick={() => void doSnooze(nextOccurrence(9, 0))} disabled={snoozeBusy} data-testid="snooze-tomorrow">
                🌅 明天 09:00
              </button>
              <button className="chip-btn" onClick={() => void doSnooze(Date.now() + 3600_000)} disabled={snoozeBusy} data-testid="snooze-1h">
                ⏱ 1 小时后
              </button>
            </div>
            <div className="label-panel-row">
              <input
                type="datetime-local"
                value={snoozeCustom}
                onChange={(e) => setSnoozeCustom(e.target.value)}
                data-testid="snooze-custom-input"
              />
              <input
                value={snoozeNote}
                onChange={(e) => setSnoozeNote(e.target.value)}
                placeholder="备注（可选）"
                maxLength={200}
                data-testid="snooze-note-input"
              />
              <button
                className="btn primary sm"
                onClick={() => void doSnooze(new Date(snoozeCustom).getTime())}
                disabled={snoozeBusy || !snoozeCustom || Number.isNaN(new Date(snoozeCustom).getTime())}
                data-testid="snooze-confirm"
              >
                自定义时间
              </button>
            </div>
            {mail.snoozeUntil !== null && (
              <div className="label-panel-row">
                <span className="muted">
                  当前提醒：{new Date(mail.snoozeUntil).toLocaleString()}
                </span>
                <button className="btn ghost sm" onClick={() => void cancelSnooze()} disabled={snoozeBusy} data-testid="snooze-cancel">
                  取消提醒
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {shownSummary && (
        <div className="ai-summary" data-testid={savedSummaryVisible ? 'saved-summary' : 'ai-summary'}>
          <div className="ai-summary-head">
            <span>
              ✨ AI 总结（{shownModel ?? '—'}）{savedSummaryVisible ? ' · 已保存' : ''}
            </span>
            <button
              className="btn ghost sm"
              onClick={() => setSummarySource((v) => !v)}
              data-testid="summary-view-toggle"
            >
              {summarySource ? '👁 预览' : '⌨ 源码'}
            </button>
          </div>
          <div className="ai-summary-body">
            {summarySource ? (
              <pre className="plain">{shownSummary}</pre>
            ) : (
              <div data-testid="summary-markdown">
                <SummaryView markdown={shownSummary} />
              </div>
            )}
          </div>
        </div>
      )}

      <div className="detail-body" data-testid="detail-body" onClick={onBodyClick}>
        {loading ? '加载中…' : showHtml ? <div dangerouslySetInnerHTML={{ __html: bodyHtml ?? '' }} /> : <pre className="plain">{mail.bodyText || '（无正文）'}</pre>}
      </div>

      {mail.attachments.length > 0 && (
        <div className="detail-attach">
          <div className="lbl">附件（点击下载；只读读取，不会把邮件标记为已读）</div>
          <div className="attach-grid">
            {mail.attachments.map((a) => (
              <div
                key={a.id}
                className={`attach-card ${downloadingId === a.id ? 'downloading' : ''}`}
                title={`点击下载：${a.filename}`}
                onClick={() => void downloadAttachment(a.id, a.partId, a.filename)}
                data-testid="attach-card"
              >
                <div className="file-ico">📎</div>
                <div className="attach-meta">
                  <div className="name">{a.filename}</div>
                  <div className="size">{downloadingId === a.id ? '下载中…' : formatBytes(a.size)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ComposeModal
        open={compose !== null}
        initial={compose ?? {}}
        onClose={() => setCompose(null)}
        onSent={() => {
          setCompose(null)
          onToast('邮件已发送，可在左侧「已发送」查看')
        }}
      />
    </div>
  )
})
