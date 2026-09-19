/**
 * 收件箱页：邮件列表（发件人/主题/时间/摘要/未读点）+ 搜索 + 同步进度 + 刷新。
 */
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { createPortal } from 'react-dom'
import type { AuthStatus, MailLabel, MailListItem, SavedView, SyncProgress, ViewFilter } from '@shared/types'
import { formatListTime } from '@shared/format'
import { parseVocabulary, visibleTags } from '@shared/tags'
import { avatarColor, avatarInitial } from '@shared/avatar'
import { shortcutMap } from '@shared/shortcuts'
import { api } from '../bridge'
import { errorMessage } from '../lib/errors'
import { SummaryProgressBar } from '../components/SummaryProgressBar'
import { useSettings } from '../settings-context'
import { MailDetailPane } from './MailDetail'

interface Props {
  auth: AuthStatus
  onToast: (message: string) => void
  /** 跨页跳转目标（AI 问答引用点击） */
  openMailId?: number | null
  /** 当前文件夹（V2 M3，缺省 INBOX） */
  folderPath?: string
  /** 标签/星标过滤（V2 M4） */
  labelFilter?: { labelIds?: number[]; starredOnly?: boolean; flaggedOnly?: boolean }
  /** 过滤生效时的标题（侧边栏选中的标签名/星标） */
  filterTitle?: string
  /** 自动标签过滤（V2.2：侧边栏/知识库点标签后传进来） */
  autoTagFilter?: string | null
  /** 只看未读（V2.2：从侧边栏文件夹列表切换） */
  unreadOnly?: boolean
  /** 按彩色类别筛选（V2.2：侧边栏「类别」） */
  categoryId?: number | null
  /** 标签数据变化 → 通知 App 刷新侧边栏（V2 M4） */
  onLabelsChanged?: () => void
  /** 当前激活的自定义视图（V2 M5；与标签/星标过滤互斥） */
  view?: SavedView | null
  /** 视图数据变化 → 通知 App 刷新侧边栏（V2 M5） */
  onViewsChanged?: () => void
  /** 本页面是否为激活页（V2.1：常驻挂载后，快捷键只在激活时响应） */
  isActive?: boolean
}

interface MailRowProps {
  mail: MailListItem
  /** 当前标签筛选（V2.2：命中时行内优先显示这些标签，避免"筛了还满屏别的标签"） */
  activeTags?: string[]
  selected: boolean
  selectionMode: boolean
  checked: boolean
  relativeTime: boolean
  onOpen: (m: MailListItem) => void
  onToggleCheck: (id: number) => void
  onEnterSelection: (id: number) => void
  onContextMenu: (x: number, y: number, id: number) => void
  onTagClick: (tag: string) => void
}

/**
 * 单封邮件行（V2.2 性能）：React.memo 包一层 —— 1000 封邮件的列表里，
 * 选中/切换筛选不该把整表重渲染（用户反馈切到收件箱明显卡顿）。
 * 回调由父组件用 useCallback 提供，保证引用稳定，memo 才真正生效。
 */
const MailRow = memo(function MailRow({
  mail: m,
  activeTags,
  selected,
  selectionMode,
  checked,
  relativeTime,
  onOpen,
  onToggleCheck,
  onEnterSelection,
  onContextMenu,
  onTagClick
}: MailRowProps) {
  const allTags = m.autoTags ?? []
  // 有标签筛选时：行内只显示命中的标签（其余折叠成 +N），筛选结果一眼可辨
  const tags = activeTags && activeTags.length > 0 ? allTags.filter((t) => activeTags.includes(t)) : allTags
  const hiddenByFilter = activeTags && activeTags.length > 0 ? allTags.length - tags.length : 0
  const { shown, more } = visibleTags(tags, 3)
  const manualTags = new Set(m.manualTags ?? [])
  return (
    <div
      className={`mail-item ${m.unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${selectionMode ? 'selectable' : ''} ${checked ? 'checked' : ''} ${m.category ? 'categorized' : ''}`}
      style={m.category ? ({ '--cat-color': m.category.color } as React.CSSProperties) : undefined}
      onClick={(e) => {
        if (selectionMode) {
          onToggleCheck(m.id)
          return
        }
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          onEnterSelection(m.id)
          return
        }
        onOpen(m)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(e.clientX, e.clientY, m.id)
      }}
      data-testid="mail-item"
    >
      {selectionMode && (
        <input
          type="checkbox"
          className="mail-check"
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggleCheck(m.id)}
          data-testid="mail-check"
        />
      )}
      {m.unread && <span className="dot" />}
      <div className="avatar" style={{ background: avatarColor(m.fromName, m.fromAddr) }}>
        {avatarInitial(m.fromName, m.fromAddr)}
      </div>
      <div className="mail-item-body">
        <div className="mail-item-top">
          <span className="from">{m.fromName || m.fromAddr}</span>
          {m.starred && (
            <span className="tag star" title="已星标" data-testid="mail-star">
              ★
            </span>
          )}
          {m.flagged && (
            <span className="tag flag" title="已标红旗" data-testid="mail-flag">
              🚩
            </span>
          )}
          {manualTags.size > 0 && (
            <span className="tag manual-mark" title="有手动标签（AI 重算不会覆盖）" data-testid="mail-manual-tag-mark">
              ✋
            </span>
          )}
          <span className="time">{formatListTime(m.dateTs, relativeTime)}</span>
        </div>
        <div className="subject">{m.subject}</div>
        <div className="snippet">{m.snippet}</div>
        {tags.length > 0 && (
          <div className="meta-row tag-row" data-testid="mail-auto-tags">
            {shown.map((t) => (
              <button
                key={t}
                className={`tag auto ${manualTags.has(t) ? 'manual' : ''}`}
                title={manualTags.has(t) ? `手动标签「${t}」（点一下按它筛选）` : `只看「${t}」的邮件`}
                onClick={(e) => {
                  e.stopPropagation()
                  onTagClick(t)
                }}
                data-testid="mail-auto-tag"
              >
                {t}
              </button>
            ))}
            {(more > 0 || hiddenByFilter > 0) && <span className="tag auto muted">+{more + hiddenByFilter}</span>}
          </div>
        )}
        <div className="meta-row">
          {m.snoozeUntil !== null && (
            <span className="tag snooze" title="已设稍后提醒" data-testid="mail-snooze-tag">
              ⏰ 稍后提醒
            </span>
          )}
          {m.hasAttachments && <span className="tag attach">📎 附件</span>}
          <span className="tag addr">{m.fromAddr}</span>
        </div>
      </div>
    </div>
  )
})

export const InboxPage = memo(function InboxPage({
  onToast,
  openMailId,
  folderPath = 'INBOX',
  labelFilter,
  filterTitle,
  autoTagFilter,
  unreadOnly: unreadOnlyProp,
  categoryId,
  onLabelsChanged,
  view,
  onViewsChanged,
  isActive = true
}: Props) {
  const settings = useSettings()
  const [mails, setMails] = useState<MailListItem[]>([])
  /** 已渲染的行数（渐进式分块；滚动接近底部时 +40） */
  const [renderLimit, setRenderLimit] = useState(40)
  /** 当前筛选条件下的真实总数（列表只取前若干封，角标要显示真实数量） */
  const [totalCount, setTotalCount] = useState(0)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  // V2.2：未读筛选以侧边栏 prop 为准（不再用本地 state —— 否则「红旗/未读」同时切换时，
  // 重新查询会用上一帧的旧值，出现"点了红旗却是 0 封"这类错位）
  const unreadOnly = unreadOnlyProp === true
  // V2.2：自动标签筛选（可多选 OR；点列表 chip / 标签面板 / 侧边栏都能设置；只看，不做硬过滤）
  const [tagFilters, setTagFilters] = useState<string[]>([])
  const [tagPanelOpen, setTagPanelOpen] = useState(false)
  const [tagPanelQuery, setTagPanelQuery] = useState('')
  const [allTagCounts, setAllTagCounts] = useState<Array<{ tag: string; count: number; manual?: boolean }>>([])
  /** 标签面板里「课程与平台」分组是否展开（默认收起，避免一屏几十个标签） */
  const [showAllTagKinds, setShowAllTagKinds] = useState(false)
  const toggleTagFilter = useCallback((tag: string) => {
    setTagFilters((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
  }, [])
  // 侧边栏点了自动标签 → 由 App 通过 prop 传进来（持久挂载的页面需要同步）
  useEffect(() => {
    setTagFilters(autoTagFilter ? [autoTagFilter] : [])
  }, [autoTagFilter])
  const [sync, setSync] = useState<SyncProgress | null>(null)
  const [loading, setLoading] = useState(true)
  const [shownCount, setShownCount] = useState(settings.listPageSize)
  const [refreshSec, setRefreshSec] = useState<number | null>(null)
  // V2 M5：保存为视图弹层
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const [savingView, setSavingView] = useState(false)
  // V2 M7：批量选择 + 批量工具栏（勾选框仅在「多选模式」下显示，右键进入）
  const [selection, setSelection] = useState<Set<number>>(new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; mailId: number } | null>(null)
  const [bulkLabelsOpen, setBulkLabelsOpen] = useState(false)
  // V2.2：批量「打标签」用统一标签（词表 + 已有标签），不再用旧的彩色标签
  const [bulkLabelOptions, setBulkLabelOptions] = useState<string[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  // V2 M7：快捷键 l → 打开详情页标签面板的信号
  const [labelsSignal, setLabelsSignal] = useState(0)
  const syncedOnce = useRef(false)
  /** 单次拉取上限（V2.2 性能：默认 200 封，点「加载更多」时翻倍） */
  const fetchLimitRef = useRef(200)
  const syncedFolders = useRef(new Set<string>())
  const syncingRef = useRef(false)

  const mailListRef = useRef<HTMLDivElement | null>(null)

  // V2.2 性能：渐进式分块渲染 —— 先渲染 40 行，滚到接近底部时哨兵进入视口再多渲染 40 行。
  // （旧实现按估算行高做窗口化：会留空白、行高估错时列表显示不全，加载更多还会跳回顶部。）
  useEffect(() => {
    const root = mailListRef.current
    const sentinel = root?.querySelector('[data-testid="list-sentinel"]')
    if (!root || !sentinel) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setRenderLimit((n) => n + 40)
      },
      { root, rootMargin: '600px 0px' }
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [mails, shownCount, renderLimit])

  // 换文件夹/换筛选时回到第一屏
  useEffect(() => {
    setRenderLimit(40)
  }, [folderPath, labelFilter, view?.id, autoTagFilter, unreadOnly, categoryId])

  const loadList = useCallback(async (term: string) => {
    try {
      // V2.2 修复：刷新时**不清空**已有列表（原来先显示"正在加载…"，容器高度塌成 0，
      // 浏览器把滚动位置夹回顶部 —— 这就是点「加载更多」后"回到最初位置"的原因）。
      const items = term.trim()
        ? await api.searchMail(term.trim())
        : view
          ? await api.listMails({ limit: fetchLimitRef.current, folder: 'INBOX', filter: view.filter, sort: view.sort })
          : await api.listMails({
              limit: fetchLimitRef.current,
              folder: folderPath,
              labelIds: labelFilter?.labelIds,
              starredOnly: labelFilter?.starredOnly,
              flaggedOnly: labelFilter?.flaggedOnly,
              categoryId: categoryId ?? undefined,
              autoTags: tagFilters.length > 0 ? tagFilters : undefined
            })
      setMails(items)
      // 角标显示真实总数（列表只取前 fetchLimit 封，之前会误显示成"共 200 封"）
      void api
        .countMails({
          folder: folderPath,
          labelIds: labelFilter?.labelIds,
          starredOnly: labelFilter?.starredOnly,
          flaggedOnly: labelFilter?.flaggedOnly,
          categoryId: categoryId ?? undefined,
          unreadOnly,
          filter: view?.filter,
          autoTags: tagFilters.length > 0 ? tagFilters : undefined
        })
        .then((n) => setTotalCount(typeof n === 'number' && n > 0 ? n : items.length))
        .catch(() => setTotalCount(items.length))
      setShownCount(settings.listPageSize)
      setSelectedId((prev) => {
        if (prev && items.some((m) => m.id === prev)) return prev
        return items[0]?.id ?? null
      })
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setLoading(false)
    }
    // V2.2 修复（关键）：依赖里必须带上 tagFilters/unreadOnly/listPageSize ——
    // 之前漏了 tagFilters，loadList 一直闭包着最初的空数组，所以「按标签筛选」请求里
    // 根本没带标签条件（用户反馈"标签筛选无法正常运行"）。tagFilters 变化 → loadList 身份变化
    // → 上面依赖 loadList 的 effect 重新查列表。
  }, [onToast, folderPath, labelFilter, view, tagFilters, unreadOnly, categoryId, settings.listPageSize])

  // doSync 通过 ref 取「当前视图」的 loadList / 文件夹 / 搜索词，
  // 避免旧闭包在同步完成后把过期的列表写回（曾导致切文件夹后列表被旧收件箱数据覆盖）
  const loadListRef = useRef(loadList)
  loadListRef.current = loadList
  const folderPathRef = useRef(folderPath)
  folderPathRef.current = folderPath

  const doSync = useCallback(async () => {
    // 防重入：首次进入 + 文件夹切换 effect 可能同时触发，串行化避免并发同步
    if (syncingRef.current) return
    syncingRef.current = true
    setSync({ phase: 'connecting', done: 0, total: 0 })
    try {
      await api.syncMail({ folders: [folderPathRef.current] })
      await loadListRef.current(searchTermRef.current)
    } catch (e) {
      setSync({ phase: 'error', done: 0, total: 0, errorCode: (e as { code?: string }).code })
      onToast(errorMessage(e))
    } finally {
      syncingRef.current = false
    }
  }, [onToast])

  // 订阅同步进度
  useEffect(() => {
    // V2.2 性能：同步一次会推几十个进度事件，若每个都 setState 就会整页重渲染几十次。
    // 这里只在「阶段变化」或「完成数变化」时才更新（进度数字本来就是粗粒度展示）。
    let lastPhase = ''
    let lastDone = -1
    const unsubscribe = api.onSyncProgress((p) => {
      const key = `${p.phase}`
      const done = p.total > 0 ? Math.floor((p.done / p.total) * 20) : 0
      if (key === lastPhase && done === lastDone) return
      lastPhase = key
      lastDone = done
      setSync(p)
    })
    return unsubscribe
  }, [])

  // 首次进入：同步一次再拉列表
  useEffect(() => {
    if (syncedOnce.current) return
    syncedOnce.current = true
    void doSync()
  }, [doSync])

  // 切换视图（文件夹 / 标签 / 星标 / 自定义视图）：立即切换到本地已有数据；
  // 首次进入该文件夹再后台同步一次（V2 M3/M4/M5）。
  // 初始挂载的 INBOX 已由上方"首次进入" effect 同步，这里跳过，避免双重并发同步
  const viewKey = `${folderPath}|${(labelFilter?.labelIds ?? []).join(',')}|${labelFilter?.starredOnly ? 1 : 0}|${labelFilter?.flaggedOnly ? 1 : 0}|${view?.id ?? 0}`
  // V2.2 修复：标签筛选也要参与「要不要重新加载」的判断。
  // 之前只比对 viewKey，改标签筛选后 effect 提前 return，列表根本没重新查（用户反馈"标签筛选没用"）。
  const filterKey = `${viewKey}|${tagFilters.join(',')}|${unreadOnly ? 1 : 0}|${categoryId ?? ''}`
  const viewKeyRef = useRef(filterKey)
  // 切文件夹/视图时清掉标签筛选（否则会因为"上一条筛选"看起来空空如也）
  const prevViewKeyRef = useRef(viewKey)
  useEffect(() => {
    if (prevViewKeyRef.current !== viewKey) {
      prevViewKeyRef.current = viewKey
      setTagFilters([])
    }
  }, [viewKey])
  useEffect(() => {
    const prev = viewKeyRef.current
    viewKeyRef.current = filterKey
    if (prev === filterKey) return
    const firstTime = !syncedFolders.current.has(folderPath)
    syncedFolders.current.add(folderPath)
    void loadList(searchTermRef.current)
    if (firstTime && !(syncedOnce.current && folderPath === 'INBOX')) void doSync()
  }, [filterKey, loadList, doSync, folderPath])

  // 新邮件事件：刷新列表 + 提示；点系统通知时自动打开该邮件
  useEffect(() => {
    // V2.2 性能：一次同步可能连推几十条新邮件事件，逐条 loadList（IPC + 查询 + 整表重渲染）
    // 正是「切到收件箱很卡」的主因之一 → 这里合并成尾随 400ms 的一次刷新。
    let timer: number | null = null
    const scheduleReload = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void loadList(searchTermRef.current)
      }, 400)
    }
    const unsubscribe = api.onNewMail((event) => {
      scheduleReload()
      onToast(`📬 新邮件：${event.subject}${event.summary ? '（已自动总结）' : ''}`)
      if (event.fromClick) setSelectedId(event.id)
    })
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      unsubscribe()
    }
  }, [loadList, onToast])

  // 自动刷新：**由主进程调度**（V2.2 真机修复）。
  // 旧实现在渲染进程 setInterval：窗口隐藏到托盘/最小化后会被 Chromium 节流甚至暂停，
  // 休眠后也不再恢复，用户看到的就是「长时间不同步 / 同步不上」。
  // 现在主进程按设置间隔自动同步 + 唤醒/解锁立即补偿；这里只读取间隔用于状态显示，
  // 新邮件到达时主进程会推 onNewMail → 列表自动刷新。
  const searchTermRef = useRef(searchTerm)
  searchTermRef.current = searchTerm
  useEffect(() => {
    void api
      .getSettings()
      .then((s) => setRefreshSec(s.refreshIntervalSec))
      .catch(() => undefined)
  }, [])

  // 跨页跳转打开指定邮件（AI 问答引用点击）
  useEffect(() => {
    if (openMailId) {
      setSearchTerm('')
      setSelectedId(openMailId)
    }
  }, [openMailId])

  // 搜索防抖
  useEffect(() => {
    if (!syncedOnce.current) return
    const t = window.setTimeout(() => void loadList(searchTerm), 250)
    return () => window.clearTimeout(t)
  }, [searchTerm, loadList])

  const visible = useMemo(() => {
    if (!unreadOnly) return mails
    return mails.filter((m) => m.unread)
  }, [mails, unreadOnly])

  const unreadCount = useMemo(() => mails.filter((m) => m.unread).length, [mails])

  // 右键菜单回调（useCallback 保证 MailRow 的 memo 生效）
  const handleRowContextMenu = useCallback((x: number, y: number, id: number) => {
    setCtxMenu({ x, y, mailId: id })
  }, [])

  // 点击邮件 → 选中 + 本地标记已读（不改服务端，规范 §1.1 第 8 条）
  const selectMail = useCallback(
    (m: MailListItem) => {
    setSelectedId(m.id)
    if (m.unread && settings.openMailMarksRead) {
      api
        .markMailRead(m.id, true)
        .then(() => setMails((prev) => prev.map((x) => (x.id === m.id ? { ...x, unread: false } : x))))
        .catch(() => undefined)
    }
    },
    [settings.openMailMarksRead]
  )

  // V2 M5：把当前视图状态（搜索词 / 未读 / 标签）保存为命名视图
  const doSaveView = useCallback(async () => {
    const name = viewName.trim()
    if (!name) return
    setSavingView(true)
    try {
      const filter: ViewFilter = {
        ...(searchTerm.trim() ? { text: searchTerm.trim() } : {}),
        ...(unreadOnly ? { unread: true } : {}),
        ...(labelFilter?.labelIds && labelFilter.labelIds.length > 0 ? { labelIds: [...labelFilter.labelIds] } : {})
      }
      await api.saveView({ id: view?.id, name, filter, sort: { by: 'date', dir: 'desc' } })
      setSaveViewOpen(false)
      setViewName('')
      onToast(view ? '视图已更新' : '视图已保存')
      onViewsChanged?.()
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setSavingView(false)
    }
  }, [viewName, searchTerm, unreadOnly, labelFilter, view, onToast, onViewsChanged])

  // ---- V2 M7：批量选择 / 批量操作 ----

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false)
    setSelection(new Set())
    setBulkLabelsOpen(false)
  }, [])

  // ---- 右键菜单（V2.1）：标记已读/未读、星标、稍后提醒、多选模式 ----

  // 稳定引用：避免 memo 失效导致 MailDetailPane 随列表重渲染
  const handleMailChanged = useCallback(() => {
    void loadListRef.current(searchTermRef.current)
  }, [])

  const ctxMail = useMemo(() => (ctxMenu ? mails.find((m) => m.id === ctxMenu.mailId) ?? null : null), [ctxMenu, mails])

  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])

  const ctxMarkRead = useCallback(
    (read: boolean) => {
      if (!ctxMail) return
      setCtxMenu(null)
      void api
        .markMailRead(ctxMail.id, read)
        .then(() => setMails((prev) => prev.map((x) => (x.id === ctxMail.id ? { ...x, unread: !read } : x))))
        .catch(() => undefined)
    },
    [ctxMail]
  )

  const ctxToggleFlag = useCallback(() => {
    if (!ctxMail) return
    setCtxMenu(null)
    void api
      .setFlagged(ctxMail.id, !ctxMail.flagged)
      .then(() => loadListRef.current(searchTermRef.current))
      .catch(() => undefined)
  }, [ctxMail])

  const ctxToggleStar = useCallback(() => {
    if (!ctxMail) return
    setCtxMenu(null)
    void api
      .toggleStar(ctxMail.id, !ctxMail.starred)
      .then(() => loadListRef.current(searchTermRef.current))
      .catch(() => undefined)
  }, [ctxMail])

  const ctxSnooze = useCallback(() => {
    if (!ctxMail) return
    setCtxMenu(null)
    void api
      .snoozeMail(ctxMail.id, Date.now() + 3600_000)
      .then(() => {
        onToast('已设置稍后提醒（1 小时后）')
        return loadListRef.current(searchTermRef.current)
      })
      .catch((e) => onToast(errorMessage(e)))
  }, [ctxMail, onToast])

  const enterSelectionMode = useCallback(
    (mailId?: number) => {
      setSelectionMode(true)
      setCtxMenu(null)
      if (mailId !== undefined) {
        setSelection((prev) => {
          const next = new Set(prev)
          if (next.has(mailId)) next.delete(mailId)
          else next.add(mailId)
          return next
        })
      }
    },
    []
  )

  const toggleSelect = useCallback((id: number) => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 右键菜单：点击其它区域/再次右键/Esc 关闭
  useEffect(() => {
    const close = (): void => setCtxMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const selectAll = useCallback(() => {
    setSelection((prev) => {
      const all = visible.slice(0, shownCount).map((m) => m.id)
      return prev.size === all.length ? new Set<number>() : new Set(all)
    })
  }, [visible, shownCount])

  const runBulk = useCallback(
    async (fn: () => Promise<void>) => {
      if (bulkBusy || selection.size === 0) return
      setBulkBusy(true)
      try {
        await fn()
        exitSelectionMode()
        await loadListRef.current(searchTermRef.current)
      } catch (e) {
        onToast(errorMessage(e))
      } finally {
        setBulkBusy(false)
      }
    },
    [bulkBusy, selection, exitSelectionMode, onToast]
  )

  /**
   * 批量重新生成总结（含 AI 检索索引卡片）：只跑选中的邮件、覆盖旧摘要。
   * 进度走全局事件（SummaryProgressBar 显示「正在生成哪一封 + 已用时间」）。
   */
  const bulkSummarize = useCallback(async () => {
    if (bulkBusy || selection.size === 0) return
    const ids = [...selection]
    setBulkBusy(true)
    try {
      const res = await api.summarizePending(ids.length, true, ids)
      onToast(
        res.cancelled
          ? `已停止：本次重新生成了 ${res.done} 封`
          : `已重新生成 ${res.done} 封摘要${res.failed > 0 ? `，${res.failed} 封失败` : ''}`
      )
      exitSelectionMode()
      await loadListRef.current(searchTermRef.current)
    } catch (e) {
      onToast(errorMessage(e))
    } finally {
      setBulkBusy(false)
    }
  }, [bulkBusy, exitSelectionMode, loadListRef, onToast, selection])

  const bulkRead = useCallback(
    (read: boolean) => runBulk(() => api.bulkMarkRead([...selection], read)),
    [runBulk, selection]
  )

  const bulkStar = useCallback(
    () =>
      runBulk(async () => {
        for (const id of selection) await api.toggleStar(id, true)
      }),
    [runBulk, selection]
  )

  const bulkSnooze = useCallback(
    () =>
      runBulk(async () => {
        const until = Date.now() + 3600_000
        for (const id of selection) await api.snoozeMail(id, until)
      }),
    [runBulk, selection]
  )

  /** 打开批量「打标签」面板：候选 = 设置里的词表 + 已出现过的标签 */
  const openBulkLabels = useCallback(() => {
    setBulkLabelsOpen((v) => !v)
    void Promise.all([api.tagCounts().catch(() => []), api.getSettings().catch(() => null)])
      .then(([counts, cfg]) => {
        const vocab = cfg?.tagVocabulary
          ? cfg.tagVocabulary
              .split(/[、,，;；\n]+/)
              .map((t) => t.trim())
              .filter(Boolean)
          : []
        const merged = [...new Set([...counts.map((c) => c.tag), ...vocab])]
        setBulkLabelOptions(merged.slice(0, 30))
      })
      .catch(() => setBulkLabelOptions([]))
  }, [])

  /** 批量手动打标签（逐封写入手动标签，永不被 AI 重算覆盖） */
  const bulkAddTag = useCallback(
    (tag: string) => {
      const ids = [...selection]
      void runBulk(async () => {
        for (const id of ids) await api.setMailTagManual(id, tag, true)
      })
    },
    [runBulk, selection]
  )

  // ---- V2 M7：全局快捷键（j/k/Enter/s/l///u/a/Esc；输入框内不响应） ----

  const orderedRef = useRef<MailListItem[]>([])
  orderedRef.current = visible.slice(0, shownCount)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive

  const handleShortcut = useCallback(
    (e: KeyboardEvent) => {
      // 常驻挂载：非激活页不响应快捷键
      if (!isActiveRef.current) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        // 输入框内只放行 Esc（失焦）
        if (e.key === 'Escape') (target as HTMLInputElement).blur()
        return
      }
      const action = shortcutMap(e.key, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey }, 'inbox')
      const ordered = orderedRef.current
      switch (action) {
        case 'next':
        case 'prev': {
          e.preventDefault()
          const idx = ordered.findIndex((m) => m.id === selectedIdRef.current)
          const targetIdx = action === 'next' ? Math.min(idx + 1, ordered.length - 1) : Math.max(idx - 1, 0)
          const next = ordered[targetIdx]
          if (next && next.id !== selectedIdRef.current) {
            setSelectedId(next.id)
            if (next.unread && settings.openMailMarksRead) {
              api
                .markMailRead(next.id, true)
                .then(() => setMails((prev) => prev.map((x) => (x.id === next.id ? { ...x, unread: false } : x))))
                .catch(() => undefined)
            }
          }
          break
        }
        case 'open': {
          const pane = document.querySelector('[data-testid="mail-detail"]') as HTMLElement | null
          pane?.focus({ preventScroll: true })
          break
        }
        case 'star': {
          const id = selectedIdRef.current
          const mail = ordered.find((m) => m.id === id)
          if (id && mail) {
            void api.toggleStar(id, !mail.starred).then(() => loadListRef.current(searchTermRef.current))
          }
          break
        }
        case 'label':
          setLabelsSignal((n) => n + 1)
          break
        case 'search':
          e.preventDefault()
          searchInputRef.current?.focus()
          break
        case 'unread': {
          const id = selectedIdRef.current
          if (id) {
            void api
              .markMailRead(id, false)
              .then(() => setMails((prev) => prev.map((x) => (x.id === id ? { ...x, unread: true } : x))))
              .catch(() => undefined)
          }
          break
        }
        case 'archive':
          onToast('「归档/移动」为预留功能：本应用收信侧只读，不会改动服务端邮件')
          break
        case 'close':
          exitSelectionMode()
          setCtxMenu(null)
          setSaveViewOpen(false)
          break
        default:
          break
      }
    },
    [onToast, exitSelectionMode]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [handleShortcut])

  /** 行渲染回调（稳定引用，配合 MailRow 的 memo） */
  const syncLabel = sync?.phase === 'done'
      ? refreshSec && refreshSec > 0
        ? `同步完成 · 每 ${refreshSec} 秒自动刷新`
        : '同步完成'
      : sync?.phase === 'error'
        ? '同步失败'
        : sync
          ? `${sync.phase === 'connecting' ? '连接中…' : sync.phase === 'full' ? '首次同步' : '增量同步'} ${sync.done}/${sync.total}`
          : ''

  return (
    <div className="inbox-wrap">
      <header className="topbar">
        <div className="title">
          {view
            ? `🗂 ${view.name}`
            : labelFilter?.starredOnly
              ? '★ 星标邮件'
              : labelFilter?.flaggedOnly
                ? '🚩 红旗邮件'
                : categoryId !== null && categoryId !== undefined
                  ? '🎨 类别'
              : labelFilter?.labelIds?.length
                ? `🏷 ${filterTitle ?? '标签'}`
                : folderPath === 'INBOX'
                  ? '收件箱'
                  : `📁 ${folderPath}`}{' '}
          <span className="sub" data-testid="mail-total">
            {unreadCount > 0 ? `${unreadCount} 封未读` : `共 ${totalCount || mails.length} 封`}
          </span>
        </div>
        {!view && (
          <div className="searchbox">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M16 16l4 4" />
            </svg>
            <input
              ref={searchInputRef}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜索邮件…（主题/正文/发件人）"
              data-testid="search-input"
            />
          </div>
        )}
        {/* V2.2：标签筛选入口就放在搜索框旁边（用户反馈原来孤零零一行太占地方） */}
        <div className="topbar-tags" data-testid="tag-filter-bar">
          <button
            className={`chip-btn ${tagFilters.length > 0 ? 'star-on' : ''}`}
            onClick={() => {
              setTagPanelOpen((v) => !v)
              if (!tagPanelOpen) void api.tagCounts().then(setAllTagCounts).catch(() => undefined)
            }}
            data-testid="tag-panel-toggle"
          >
            🏷 标签{tagFilters.length > 0 ? `（${tagFilters.length}）` : ''}
          </button>
          {tagFilters.map((t) => (
            <button key={t} className="chip-btn star-on" onClick={() => toggleTagFilter(t)} data-testid="tag-filter-chip">
              {t} ✕
            </button>
          ))}
          {tagFilters.length > 0 && (
            <button className="link-btn" onClick={() => setTagFilters([])} data-testid="tag-filter-clear">
              清除
            </button>
          )}
        </div>
        <button
          className="btn ghost"
          onClick={() => {
            setViewName(view?.name ?? '')
            setSaveViewOpen((v) => !v)
          }}
          data-testid="save-view-btn"
        >
          💾 {view ? '更新视图' : '保存为视图'}
        </button>
        <button className="btn primary" onClick={() => void doSync()} data-testid="sync-btn">
          ↻ 同步
        </button>
        <span className="sync-status" data-testid="sync-status">
          {syncLabel}
        </span>
      </header>

      {/* 批量总结进度：显示「正在生成哪一封 + 已用 + 停止」 */}
      <SummaryProgressBar />
      {saveViewOpen && (
        <div className="save-view-bar" data-testid="save-view-bar">
          <input
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doSaveView()
            }}
            placeholder="视图名称（保存当前筛选与排序）"
            maxLength={50}
            data-testid="view-name-input"
          />
          <button className="btn primary sm" onClick={() => void doSaveView()} disabled={savingView || !viewName.trim()} data-testid="view-save-confirm">
            {view ? '更新' : '保存'}
          </button>
          <button className="btn ghost sm" onClick={() => setSaveViewOpen(false)} data-testid="view-save-cancel">
            取消
          </button>
        </div>
      )}

      <div className="workspace">
        <section className="list-pane">
          {selectionMode && selection.size === 0 && (
            <div className="bulk-bar select-hint-bar" data-testid="select-mode-bar">
              <span className="bulk-count">☑ 多选模式</span>
              <span className="muted">点击邮件勾选；Ctrl/⌘+点击 也可勾选</span>
              <button className="chip-btn" onClick={exitSelectionMode} data-testid="select-mode-exit">
                ✕ 退出多选
              </button>
            </div>
          )}
          {selection.size > 0 && (
            <div className="bulk-bar" data-testid="bulk-bar">
              <span className="bulk-count" data-testid="bulk-count">
                已选 {selection.size} 封
              </span>
              <button className="chip-btn" onClick={selectAll} data-testid="bulk-all">
                {selection.size === visible.slice(0, shownCount).length ? '取消全选' : '全选'}
              </button>
              <button className="chip-btn" onClick={() => void bulkRead(true)} disabled={bulkBusy} data-testid="bulk-read">
                ✓ 标记已读
              </button>
              <button className="chip-btn" onClick={() => void bulkRead(false)} disabled={bulkBusy} data-testid="bulk-unread">
                ○ 标未读
              </button>
              <button className="chip-btn" onClick={() => void bulkStar()} disabled={bulkBusy} data-testid="bulk-star">
                ★ 星标
              </button>
              <button className="chip-btn" onClick={openBulkLabels} disabled={bulkBusy} data-testid="bulk-label-btn">
                🏷 加标签
              </button>
              <button className="chip-btn" onClick={() => void bulkSnooze()} disabled={bulkBusy} data-testid="bulk-snooze">
                ⏰ 稍后提醒
              </button>
              <button
                className="chip-btn"
                onClick={() => void bulkSummarize()}
                disabled={bulkBusy}
                title="对选中的邮件重新生成 AI 摘要（覆盖旧摘要，同时更新 AI 检索索引）"
                data-testid="bulk-summarize"
              >
                🧠 重新生成总结
              </button>
              <button className="chip-btn" onClick={exitSelectionMode} data-testid="bulk-clear">
                ✕ 取消
              </button>
              {bulkLabelsOpen && (
                <div className="bulk-label-menu" data-testid="bulk-label-menu">
                  {bulkLabelOptions.map((t) => (
                    <button key={t} className="label-toggle" onClick={() => bulkAddTag(t)} data-testid="bulk-label-pick">
                      {t}
                    </button>
                  ))}
                  {bulkLabelOptions.length === 0 && <span className="muted">词表为空：先在设置 → AI → 标签词表里添加标签</span>}
                </div>
              )}
            </div>
          )}
        {tagPanelOpen && (
          <div className="tag-panel" data-testid="tag-panel">
            <input
              className="settings-input"
              placeholder="搜索标签…"
              value={tagPanelQuery}
              onChange={(e) => setTagPanelQuery(e.target.value)}
              data-testid="tag-panel-search"
            />
            {/* V2.2：分组显示 —— 「主题标签」= 词表内/手动（用户真正在用的）；「课程与平台」= 卡片自动识别的，
                噪音多，默认收起（用户反馈"怎么这么多不该出现的标记"） */}
            {(() => {
              const vocab = new Set(parseVocabulary(settings.tagVocabulary))
              const q = tagPanelQuery.trim()
              const matched = allTagCounts.filter((t) => (q ? t.tag.includes(q) : true))
              // 主题标签 = 词表里的 + 手动打过的（这两类才是用户真正在用的）
              const theme = matched.filter((t) => vocab.has(t.tag) || t.manual === true)
              const other = matched.filter((t) => !vocab.has(t.tag) && t.manual !== true)
              const chip = (t: { tag: string; count: number; manual?: boolean }): React.ReactElement => (
                <button
                  key={t.tag}
                  className={`tag auto ${tagFilters.includes(t.tag) ? 'on' : ''}`}
                  onClick={() => toggleTagFilter(t.tag)}
                  data-testid="tag-panel-item"
                >
                  {t.tag} <span className="cnt">{t.count}</span>
                </button>
              )
              return (
                <>
                  <div className="tag-panel-group">
                    <span className="tag-panel-head">主题标签（{theme.length}）</span>
                    <div className="tag-panel-list">{theme.map(chip)}</div>
                  </div>
                  {other.length > 0 && (
                    <div className="tag-panel-group">
                      <button className="link-btn" onClick={() => setShowAllTagKinds((v) => !v)} data-testid="tag-panel-more">
                        {showAllTagKinds ? '收起' : `课程与平台等自动标签（${other.length}）`}
                      </button>
                      {showAllTagKinds && <div className="tag-panel-list">{other.map(chip)}</div>}
                    </div>
                  )}
                  {matched.length === 0 && <span className="hint">没有匹配的标签</span>}
                </>
              )
            })()}
          </div>
        )}
        {/* V2.2：原来的「全部/未读」分段器与统计串已移除（未读筛选移到侧边栏文件夹列表，统计在顶栏） */}
        {tagFilters.length > 0 && (
          <div className="list-toolbar">
            <span className="muted" data-testid="tag-filter-active">
              正在按标签筛选：{tagFilters.join('、')}
            </span>
            <button className="link-btn" onClick={() => setTagFilters([])} data-testid="tag-filter-clear-inline">
              清除
            </button>
          </div>
        )}
          <div className="mail-list" data-testid="mail-list" ref={mailListRef}>
            {loading ? (
              <div className="list-empty">正在加载…</div>
            ) : visible.length === 0 ? (
              <div className="list-empty">暂无邮件</div>
            ) : (
              <>
                {(() => {
                  const sliced = visible.slice(0, shownCount)
                  const renderItem = (m: MailListItem) => (
                    <MailRow
                      key={m.id}
                      mail={m}
                      selected={selectedId === m.id}
                      selectionMode={selectionMode}
                      checked={selection.has(m.id)}
                      relativeTime={settings.relativeTime}
                      onOpen={selectMail}
                      onToggleCheck={toggleSelect}
                      onEnterSelection={enterSelectionMode}
                      onContextMenu={handleRowContextMenu}
                      onTagClick={toggleTagFilter}
                      activeTags={tagFilters}
                    />
                  )
                  // V2.2 性能：渐进式分块渲染（先 40 行，接近底部再追加 40 行）——
                  // 不估算行高、不留空白、加载更多也不跳回顶部；屏幕外的行由 CSS
                  // `content-visibility: auto` 跳过布局与绘制，代价很低。
                  const rendered = sliced.slice(0, renderLimit)
                  const snoozeCount = sliced.filter((m) => m.snoozeUntil !== null).length
                  return (
                    <>
                      {snoozeCount > 0 && (
                        <div className="list-group-head" data-testid="snooze-group">
                          ⏰ 稍后提醒 · {snoozeCount} 封
                        </div>
                      )}
                      {rendered.map(renderItem)}
                      {rendered.length < sliced.length && (
                        <div className="list-sentinel" data-testid="list-sentinel" aria-hidden="true" />
                      )}
                    </>
                  )
                })()}
                {visible.length > shownCount && (
                  <div className="list-more">
                    <button
                      className="btn ghost"
                      onClick={() => {
                        // 先看本地还有没有：没有就把服务端拉取上限翻倍再取一次
                        if (shownCount + 100 > visible.length && fetchLimitRef.current < 2000) {
                          fetchLimitRef.current = Math.min(fetchLimitRef.current * 2, 2000)
                          void loadListRef.current(searchTermRef.current)
                        }
                        setShownCount((c) => c + 100)
                      }}
                      data-testid="load-more"
                    >
                      加载更多（本地还有 {Math.max(0, visible.length - shownCount)} 封
                      {totalCount > visible.length ? ` · 服务器共 ${totalCount} 封` : ''}）
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <MailDetailPane
          mailId={selectedId}
          onToast={onToast}
          onLabelsChanged={onLabelsChanged}
          onMailChanged={handleMailChanged}
          openLabelsSignal={labelsSignal}
          isActive={isActive}
        />
      </div>

      {ctxMenu &&
        ctxMail &&
        createPortal(
          <div
            className="ctx-menu"
            style={{
              // 经 Portal 挂到 body 下，fixed 相对视口定位；钳制在窗口内不溢出
              left: Math.min(ctxMenu.x, window.innerWidth - 190),
              top: Math.min(ctxMenu.y, window.innerHeight - 240)
            }}
            data-testid="ctx-menu"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <button className="ctx-item" data-testid="ctx-read" onClick={() => ctxMarkRead(ctxMail.unread)}>
              {ctxMail.unread ? '✉️ 标记为已读' : '📭 标记为未读'}
            </button>
            <button className="ctx-item" data-testid="ctx-star" onClick={ctxToggleStar}>
              {ctxMail.starred ? '☆ 取消星标' : '★ 加星标'}
            </button>
            <button className="ctx-item" data-testid="ctx-flag" onClick={ctxToggleFlag}>
              {ctxMail.flagged ? '⚐ 取消红旗' : '🚩 标红旗'}
            </button>
            <button className="ctx-item" data-testid="ctx-snooze" onClick={ctxSnooze}>
              ⏰ 稍后提醒（1 小时后）
            </button>
            <div className="ctx-sep" />
            {!selectionMode ? (
              <button className="ctx-item" data-testid="ctx-multi-select" onClick={() => enterSelectionMode(ctxMail.id)}>
                ☑ 进入多选模式
              </button>
            ) : (
              <button className="ctx-item" data-testid="ctx-exit-select" onClick={exitSelectionMode}>
                ☐ 退出多选模式
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  )
})
