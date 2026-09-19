/**
 * 知识库（M3）：目录式浏览 + 展开看摘要 + 本周简报。
 *
 * 用户反馈（真机截图）：原来的平铺布局太挤、只展示索引信息、读不到有效内容。
 * 因此改成「目录 → 集合 → 邮件 → 展开看摘要（决策卡）」的四层结构：
 *   ① 本周简报：只留最关键的几行（收到多少封 + 最近几个截止），其余折叠；
 *   ② 左栏是可折叠目录（课程 / 类型），类型统计收成一行小字；
 *   ③ 右栏选中集合后先给「档案卡」（共几封 / 最近截止 + 倒计时 / 涉及系统），
 *      并可直接「✨ 问 AI 这个集合」（把知识库交给 AI 助手回答）；
 *   ④ 邮件行默认只显示标题与元信息，点开后才加载并展示 AI 摘要（决策卡），
 *      以及「打开邮件 / 移出集合」操作。
 *
 * 设计约束（沿用调研结论）：集合由索引卡片派生、多标签不单桶、默认只浏览不硬过滤、
 * 归类不对可本地修正（移出）、没有课程/类型的卡片不进集合。
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { CollectionMail, CollectionSummary, WeeklyBrief } from '@shared/types'
import { formatRelativeDate } from '@shared/format'
import { formatRemaining } from '@shared/summaryView'
import { api } from '../bridge'
import { errorMessage } from '../lib/errors'
import { SummaryView } from '../components/SummaryView'
import type { PageProps } from '../registry'

const DAY = 86_400_000

function dueLabel(dueTs: number | null): string {
  if (dueTs === null) return ''
  const d = new Date(dueTs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const KnowledgePage = memo(function KnowledgePage({ onToast, onOpenMail, onAskAI, isActive }: PageProps) {
  const [collections, setCollections] = useState<CollectionSummary[]>([])
  const [brief, setBrief] = useState<WeeklyBrief | null>(null)
  const [active, setActive] = useState<CollectionSummary | null>(null)
  const [mails, setMails] = useState<CollectionMail[]>([])
  const [loading, setLoading] = useState(false)
  // 目录折叠状态 + 展开的邮件（展开后才去取摘要）
  const [openGroups, setOpenGroups] = useState<{ course: boolean; type: boolean }>({ course: true, type: false })
  const [showAllDue, setShowAllDue] = useState(false)
  const [expandedMail, setExpandedMail] = useState<number | null>(null)
  const [summaries, setSummaries] = useState<Map<number, string>>(new Map())

  const load = useCallback(async () => {
    try {
      const [cols, b] = await Promise.all([api.listCollections(), api.weeklyBrief()])
      setCollections(cols)
      setBrief(b)
    } catch (e) {
      onToast(errorMessage(e))
    }
  }, [onToast])

  useEffect(() => {
    if (isActive === false) return
    void load()
  }, [isActive, load])

  const openCollection = useCallback(
    async (c: CollectionSummary) => {
      setActive(c)
      setLoading(true)
      setExpandedMail(null)
      try {
        setMails(await api.collectionMails(c.kind, c.value, 200))
      } catch (e) {
        onToast(errorMessage(e))
      } finally {
        setLoading(false)
      }
    },
    [onToast]
  )

  /** 点开某封邮件：按需加载它的 AI 摘要（决策卡） */
  const toggleMail = useCallback(
    async (mail: CollectionMail) => {
      if (expandedMail === mail.id) {
        setExpandedMail(null)
        return
      }
      setExpandedMail(mail.id)
      if (summaries.has(mail.id)) return
      try {
        const detail = await api.getMail(mail.id)
        setSummaries((prev) => new Map(prev).set(mail.id, detail.savedSummary ?? ''))
      } catch (e) {
        onToast(errorMessage(e))
      }
    },
    [expandedMail, onToast, summaries]
  )

  const exclude = useCallback(
    async (mail: CollectionMail) => {
      if (!active) return
      try {
        await api.setCollectionExcluded(mail.id, active.kind, active.value, true)
        setMails((prev) => prev.filter((m) => m.id !== mail.id))
        onToast(`已移出「${active.value}」：${mail.subject.slice(0, 18)}…（本地修正，可撤销）`)
        void load()
      } catch (e) {
        onToast(errorMessage(e))
      }
    },
    [active, load, onToast]
  )

  const dossier = useMemo(() => {
    const withDue = mails.filter((m) => m.dueTs !== null).sort((a, b) => (a.dueTs ?? 0) - (b.dueTs ?? 0))
    const upcoming = withDue.filter((m) => (m.dueTs ?? 0) >= Date.now())
    const entities = new Map<string, number>()
    for (const m of mails) for (const e of m.entities) entities.set(e, (entities.get(e) ?? 0) + 1)
    return {
      total: mails.length,
      nextDue: upcoming[0] ?? null,
      entities: [...entities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n]) => n)
    }
  }, [mails])

  const courses = collections.filter((c) => c.kind === 'course')
  const types = collections.filter((c) => c.kind === 'type')
  const dueItems = brief?.dueItems ?? []
  const shownDue = showAllDue ? dueItems : dueItems.slice(0, 5)

  return (
    <div className="kb-page" data-testid="kb-page">
      <header className="topbar">
        <div className="title">
          知识库 <span className="sub">课程 / 类型集合 · 本周简报（由 AI 索引卡片派生）</span>
        </div>
        <button className="btn ghost" onClick={() => void load()} data-testid="kb-refresh">
          ↻ 刷新
        </button>
      </header>

      {/* ① 本周简报：只保留关键信息，其余折叠 */}
      {brief && (
        <div className="kb-brief" data-testid="kb-brief">
          <div className="kb-brief-head">
            <span className="lbl">📅 本周</span>
            <span className="hint">
              {new Date(brief.fromTs).toLocaleDateString('zh-CN')} – {new Date(brief.toTs).toLocaleDateString('zh-CN')} ·
              收到 {brief.newMails} 封
              {brief.missingCards > 0 ? `（${brief.missingCards} 封未建索引）` : ''}
            </span>
            <span className="hint kb-brief-types">{brief.byType.map((t) => `${t.type} ${t.count}`).join(' · ')}</span>
          </div>
          {dueItems.length > 0 ? (
            <ul className="kb-due-list" data-testid="kb-due-list">
              {shownDue.map((d) => {
                const overdue = d.dueTs < Date.now()
                return (
                  <li key={d.id}>
                    <span className={`kb-due ${!overdue && d.dueTs - Date.now() < DAY ? 'soon' : ''} ${overdue ? 'past' : ''}`}>
                      {dueLabel(d.dueTs)}
                    </span>
                    <button className="link-btn kb-link" onClick={() => onOpenMail?.(d.id)} data-testid="kb-due-item">
                      {d.subject}
                    </button>
                    <span className="hint">{formatRemaining(d.dueTs)}</span>
                  </li>
                )
              })}
              {dueItems.length > 5 && (
                <li>
                  <button className="link-btn" onClick={() => setShowAllDue((v) => !v)} data-testid="kb-due-toggle">
                    {showAllDue ? '收起' : `展开其余 ${dueItems.length - 5} 条截止`}
                  </button>
                </li>
              )}
            </ul>
          ) : (
            <div className="hint">本周没有截止时间</div>
          )}
        </div>
      )}

      <div className="kb-body">
        {/* ② 目录：可折叠的课程 / 类型分组 */}
        <div className="kb-collections" data-testid="kb-collections">
          {(
            [
              ['course', '🎓 课程', courses],
              ['type', '🏷 类型', types]
            ] as Array<['course' | 'type', string, CollectionSummary[]]>
          ).map(([kind, label, list]) => (
            <div key={kind}>
              <button
                className="kb-group-head"
                onClick={() => setOpenGroups((g) => ({ ...g, [kind]: !g[kind] }))}
                data-testid={`kb-group-${kind}`}
              >
                <span className={`chev ${openGroups[kind] ? 'open' : ''}`}>▸</span>
                {label}（{list.length}）
              </button>
              {openGroups[kind] &&
                list.map((c) => (
                  <button
                    key={`${c.kind}-${c.value}`}
                    className={`kb-collection ${active?.value === c.value && active?.kind === c.kind ? 'active' : ''}`}
                    onClick={() => void openCollection(c)}
                    data-testid="kb-collection"
                  >
                    <span className="kb-collection-name">{c.value}</span>
                    <span className="kb-collection-meta">
                      {c.count} 封{c.nextDue !== null ? ` · 截止 ${dueLabel(c.nextDue)}` : ''}
                    </span>
                  </button>
                ))}
            </div>
          ))}
          {collections.length === 0 && <div className="hint">还没有集合：先批量生成一次索引卡片</div>}
        </div>

        {/* ③ 详情：档案卡 + 可展开的邮件（展开看摘要） */}
        <div className="kb-detail" data-testid="kb-detail">
          {!active && <div className="empty-hint">从左侧选一个集合：先看档案卡，需要时展开每封邮件看摘要</div>}
          {active && (
            <>
              <div className="kb-dossier" data-testid="kb-dossier">
                <div className="kb-dossier-line">
                  <span className="kb-dossier-title">
                    {active.kind === 'course' ? '🎓' : '🏷'} {active.value}
                  </span>
                  <span className="hint">共 {dossier.total} 封</span>
                  {dossier.nextDue && (
                    <span className="kb-due soon">
                      最近截止 {dueLabel(dossier.nextDue.dueTs)}（{formatRemaining(dossier.nextDue.dueTs ?? 0)}）
                    </span>
                  )}
                  {onAskAI && (
                    <button
                      className="btn ghost sm"
                      onClick={() => onAskAI(`${active.value} 有哪些截止和待办？`)}
                      data-testid="kb-ask-ai"
                      title="把该集合同步给 AI 助手回答（知识库 → 问答）"
                    >
                      ✨ 问 AI
                    </button>
                  )}
                </div>
                {dossier.entities.length > 0 && (
                  <div className="kb-chips">
                    {dossier.entities.map((name) => (
                      <span className="kb-chip" key={name}>
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {loading && <div className="hint">加载中…</div>}
              <div className="kb-mails">
                {mails.map((m) => {
                  const open = expandedMail === m.id
                  return (
                    <div className={`kb-mail ${open ? 'open' : ''}`} key={m.id} data-testid="kb-mail">
                      <button className="kb-mail-head" onClick={() => void toggleMail(m)} data-testid="kb-mail-toggle">
                        <span className={`chev ${open ? 'open' : ''}`}>▸</span>
                        <span className="kb-mail-title">{m.subject}</span>
                        <span className="kb-mail-meta">
                          {m.fromName || m.fromAddr} · {formatRelativeDate(m.dateTs)}
                          {m.dueTs !== null ? ` · 截止 ${dueLabel(m.dueTs)}` : ''}
                        </span>
                      </button>
                      {open && (
                        <div className="kb-mail-body" data-testid="kb-mail-expanded">
                          {summaries.get(m.id) ? (
                            <SummaryView markdown={summaries.get(m.id) as string} />
                          ) : (
                            <div className="hint">这封还没有 AI 摘要（可在设置里批量生成）</div>
                          )}
                          <div className="kb-mail-actions">
                            <button className="link-btn" onClick={() => onOpenMail?.(m.id)} data-testid="kb-open-mail">
                              打开邮件
                            </button>
                            <button className="link-btn" onClick={() => void exclude(m)} data-testid="kb-exclude">
                              移出这个集合
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
                {!loading && mails.length === 0 && <div className="hint">这个集合里暂时没有邮件</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
})
