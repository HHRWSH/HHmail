/**
 * AI 摘要展示：目标只有一个 —— 让用户在 30 秒内看清「要做什么 / 何时截止 / 跟谁有关」。
 *
 * 用户反馈（真机截图）：v4 的摘要把原文整段抄进表格，一屏全是字，还不如直接看原件。
 * 因此这里改成「决策卡」：
 *   ① 第一眼：主旨一行 + 最近截止的大字横幅（含倒计时：还有 8 小时 / 已过期 2 天）
 *   ② 第二眼：行动项清单（按截止时间从早到晚，每条一行 + 截止徽标）
 *   ③ 需要时：关键信息（紧凑定义列表，长值单行省略）；分类标签
 *   ④ 兜底：解析不出结构（老摘要）→ 通用 Markdown 渲染
 * 默认紧凑（长内容裁断），需要时点「展开全部」看完整文本/原文摘录。
 */
import { memo, useMemo, useState } from 'react'
import { renderMarkdown } from '@shared/markdown'
import {
  clampText,
  deadlineUrgency,
  earliestDeadline,
  formatRemaining,
  inlinePlain,
  parseActionItems,
  parseCategories,
  parseImportance,
  parseKeyInfoTable,
  parseQuotes,
  shortDeadline,
  sortActionItems,
  splitSummarySections
} from '@shared/summaryView'

const IMPORTANCE_CLASS: Record<string, string> = { 高: 'high', 中: 'mid', 低: 'low' }
const COMPACT_ROWS = 4

function Generic({ markdown }: { markdown: string }): JSX.Element {
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }} />
}

export const SummaryView = memo(function SummaryView({ markdown }: { markdown: string }) {
  const [expanded, setExpanded] = useState(false)
  const parsed = useMemo(() => {
    const sections = splitSummarySections(markdown)
    if (sections.length === 0) return null
    const find = (kw: string) => sections.find((s) => s.title.includes(kw))
    const importance = find('重要度')
    const keyInfo = find('关键信息')
    const actions = find('行动') || find('截止')
    const category = find('分类')
    const quotes = find('摘录')
    const rows = keyInfo ? parseKeyInfoTable(keyInfo.body) : []
    const rawItems = actions ? parseActionItems(actions.body) : []
    const items = sortActionItems(rawItems)
    // 「主旨」小节优先；没有就用第一个未知小节当主旨
    const lead =
      sections.find((s) => s.title.includes('主旨')) ??
      sections.find((s) => s !== importance && s !== keyInfo && s !== actions && s !== category && s !== quotes)
    const others = sections.filter((s) => s !== lead && s !== importance && s !== keyInfo && s !== actions && s !== category && s !== quotes)
    return {
      lead,
      others,
      level: importance ? parseImportance(importance.body) : null,
      rows,
      items,
      tags: category ? parseCategories(category.body) : [],
      quoteLines: quotes ? parseQuotes(quotes.body) : [],
      deadline: earliestDeadline(items, rows)
    }
  }, [markdown])

  if (!parsed) return <Generic markdown={markdown} />

  const { lead, others, level, items, tags, quoteLines, deadline } = parsed
  const urgency = deadline !== null ? deadlineUrgency(deadline) : null
  // 横幅已经显示「截止」时，关键信息里就不重复这一行（用户反馈：重复信息等于噪声）
  const rows = parsed.rows.filter(
    (r) => !(deadline !== null && /^(截止|截止时间|deadline|due)$/i.test(r.label.trim()))
  )
  const visibleRows = expanded ? rows : rows.slice(0, COMPACT_ROWS)
  const hiddenCount = rows.length - visibleRows.length
  const longContent =
    rows.length > COMPACT_ROWS ||
    items.length > 3 ||
    quoteLines.length > 0 ||
    others.length > 0 ||
    (lead?.body ?? '').length > 120

  return (
    <div className="summary-view" data-testid="summary-structured">
      {/* ① 最近截止：整张卡最显眼的一行 */}
      {deadline !== null && (
        <div className={`sv-deadline-banner ${urgency}`} data-testid="summary-deadline">
          <span className="ico">⏰</span>
          <span className="when">{shortDeadline(new Date(deadline).toLocaleString('zh-CN', { hour12: false }))}</span>
          <span className="left">{formatRemaining(deadline)}</span>
        </div>
      )}

      {/* ② 一句话主旨 */}
      {lead && lead.body.trim() && (
        <div className={`sv-main ${expanded ? '' : 'clamp-2'}`} data-testid="summary-lead">
          {inlinePlain(lead.body)}
        </div>
      )}

      {/* ③ 行动项：要做什么，按截止从早到晚 */}
      {items.length > 0 && (
        <ul className="sv-todo" data-testid="summary-todos">
          {(expanded ? items : items.slice(0, 3)).map((it, i) => (
            <li key={`${it.text}-${i}`} className={it.done ? 'done' : ''}>
              <span className="sv-check">{it.done ? '☑' : '☐'}</span>
              <span className="sv-todo-text">{expanded ? it.text : clampText(it.text, 60)}</span>
              {it.deadline && <span className="sv-deadline">{shortDeadline(it.deadline)}</span>}
            </li>
          ))}
        </ul>
      )}

      {/* ④ 关键信息：紧凑两列，长值单行省略 */}
      {rows.length > 0 && (
        <dl className="sv-kv" data-testid="summary-keyinfo">
          {visibleRows.map((r, i) => (
            <div className="sv-kv-row" key={`${r.label}-${i}`}>
              <dt>{r.label}</dt>
              <dd title={r.value}>{expanded ? r.value : clampText(r.value, 42)}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* ⑤ 重要度 + 分类 */}
      <div className="sv-inline">
        {level && <span className={`sv-badge ${IMPORTANCE_CLASS[level] ?? 'mid'}`}>{level}</span>}
        {tags.map((t) => (
          <span className="sv-tag" key={t}>
            {t}
          </span>
        ))}
        {hiddenCount > 0 && !expanded && <span className="sv-more">还有 {hiddenCount} 项关键信息</span>}
      </div>

      {/* ⑥ 展开后：完整小节 + 原文摘录 */}
      {expanded &&
        others.map((s, i) => (
          <section key={`${s.title}-${i}`} className="sv-block">
            {s.title && <div className="sv-label">{s.title}</div>}
            <div className="sv-text">{inlinePlain(s.body)}</div>
          </section>
        ))}
      {expanded && quoteLines.length > 0 && (
        <section className="sv-block">
          <div className="sv-label">原文摘录</div>
          <blockquote className="sv-quote">{quoteLines.join('\n')}</blockquote>
        </section>
      )}

      {longContent && (
        <button className="link-btn sv-expand" onClick={() => setExpanded((v) => !v)} data-testid="summary-expand">
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  )
})
