/**
 * 应用根组件：登录态判定 + 布局壳（侧边栏由功能注册表驱动）。
 * - 侧边栏分组（邮箱/文件夹/标签/视图）可折叠，折叠状态本地持久化；中部可滚动，底部固定；
 * - 页面常驻挂载（display 切换）：切换页面不再重新同步/重建状态，即时切换。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSettings, AuthStatus, MailFolder, MailLabel, SavedView } from '@shared/types'
import { resolveTheme, densityTokens } from '@shared/theme'
import { folderIcon, isCommonFolder } from '@shared/folderIcons'
import { api } from './bridge'
import { FALLBACK_SETTINGS, SettingsContext } from './settings-context'
import { FEATURE_REGISTRY, DEFAULT_FEATURE, type PageProps } from './registry'
import { LoginPage } from './pages/Login'
import { Toast, type ToastState } from './components/Toast'

const COLLAPSE_STORAGE_KEY = 'mail-ai-sidebar-collapsed'

function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : null
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [active, setActive] = useState<string>(DEFAULT_FEATURE)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [openMailId, setOpenMailId] = useState<number | null>(null)
  const [folders, setFolders] = useState<MailFolder[]>([])
  const [activeFolder, setActiveFolder] = useState<string>('INBOX')
  // V2 M4：标签 + 星标过滤
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [activeLabelId, setActiveLabelId] = useState<number | null>(null)
  const [activeStarred, setActiveStarred] = useState(false)
  /** V2.2：红旗（Outlook 式后续标记）筛选 */
  const [activeFlagged, setActiveFlagged] = useState(false)
  /** V2.2：侧边栏只常驻常用文件夹，其余收进「更多文件夹」 */
  const [showAllFolders, setShowAllFolders] = useState(false)
  /** V2.2：只看未读（从文件夹列表切换，原工具栏分段器已移除） */
  const [activeUnreadOnly, setActiveUnreadOnly] = useState(false)
  /** 未读数（文件夹列表里显示） */
  const [unreadTotal, setUnreadTotal] = useState(0)
  // V2.2：自动标签（与手动标签同一个「标签」分组里展示，交互一致：点一下筛出这一类）
  const [autoTags, setAutoTags] = useState<Array<{ tag: string; count: number }>>([])
  /** V2.2：侧边栏按「类别」筛选（原来的标签列表已从侧边栏移除） */
  const [categories, setCategories] = useState<Array<{ id: number; name: string; color: string; count: number }>>([])
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null)
  const [activeAutoTag, setActiveAutoTag] = useState<string | null>(null)
  // V2 M5：自定义视图
  const [views, setViews] = useState<SavedView[]>([])
  const [activeViewId, setActiveViewId] = useState<number | null>(null)
  // 侧边栏分组折叠状态（本地持久化）
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  // V2.2：外观与行为设置（主题/密度/品牌名/列表条数…）
  const [settings, setSettings] = useState<AppSettings>(FALLBACK_SETTINGS)
  const [systemDark, setSystemDark] = useState<boolean>(
    () => window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
  )

  // 设置：登录后加载一次（设置页保存后会回传最新值）
  useEffect(() => {
    if (!auth?.loggedIn) return
    let mounted = true
    api
      .getSettings()
      .then((s) => {
        if (mounted) setSettings(s)
      })
      .catch(() => undefined)
    return () => {
      mounted = false
    }
  }, [auth?.loggedIn])

  // 启动时自动同步（设置里开启才做；失败静默，用户仍可手动同步）
  useEffect(() => {
    if (!auth?.loggedIn || !settings.syncOnStartup) return
    let mounted = true
    const timer = window.setTimeout(() => {
      api
        .syncMail({ folders: ['INBOX'] })
        .then(() => {
          if (mounted) showToast('已按设置完成启动同步')
        })
        .catch(() => undefined)
    }, 1500)
    return () => {
      mounted = false
      window.clearTimeout(timer)
    }
    // showToast 是稳定引用（useCallback 空依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.loggedIn, settings.syncOnStartup])

  // 跟随系统主题：监听系统深浅色变化
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  // 应用主题 + 密度（写到 <html> 的 data-* 上，CSS 变量随之切换）
  useEffect(() => {
    const theme = resolveTheme(settings.theme, systemDark)
    const root = document.documentElement
    root.dataset.theme = theme
    root.dataset.density = settings.density
    const tokens = densityTokens(settings.density)
    root.style.setProperty('--row-h', tokens.rowH)
    root.style.setProperty('--app-font-size', tokens.font)
    root.style.setProperty('--row-pad-y', tokens.padY)
    try {
      window.localStorage.setItem('mail-ai-theme', theme)
    } catch {
      /* ignore */
    }
  }, [settings.theme, settings.density, systemDark])

  // 窗口标题跟随品牌名
  useEffect(() => {
    const name = (settings.brandName || FALLBACK_SETTINGS.brandName).trim()
    if (name) document.title = name
  }, [settings.brandName])

  const showToast = useCallback((message: string) => {
    setToast({ id: Date.now(), message })
  }, [])

  const toggleSection = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  /** 跨页跳转：AI 问答引用 → 收件箱并打开对应邮件 */
  const handleOpenMail = useCallback((id: number) => {
    setOpenMailId(id)
    setActive('inbox')
  }, [])

  // 文件夹列表（V2 M3，数据驱动侧边栏导航）
  useEffect(() => {
    if (!auth?.loggedIn) return
    let mounted = true
    api
      .listFolders()
      .then((f) => {
        if (mounted) setFolders(f.length > 0 ? f : [{ path: 'INBOX', name: '收件箱' }])
      })
      .catch(() => {
        if (mounted) setFolders([{ path: 'INBOX', name: '收件箱' }])
      })
    return () => {
      mounted = false
    }
  }, [auth?.loggedIn])

  // 未读数（V2.2：文件夹列表显示「未读 N」）
  useEffect(() => {
    if (!auth?.loggedIn) return
    const reload = (): void => {
      api
        .countMails({ folder: activeFolder, unreadOnly: true })
        .then((n) => setUnreadTotal(typeof n === 'number' ? n : 0))
        .catch(() => setUnreadTotal(0))
    }
    reload()
    const unsubscribe = api.onSyncProgress((p) => {
      if (p.phase === 'done') reload()
    })
    return unsubscribe
  }, [auth?.loggedIn, activeFolder])

  // 自动标签计数（V2.2）：侧边栏与列表筛选面板共用
  const reloadAutoTags = useCallback(() => {
    api
      .tagCounts()
      .then(setAutoTags)
      .catch(() => setAutoTags([]))
  }, [])

  useEffect(() => {
    if (!auth?.loggedIn) return
    api
      .categoryCounts()
      .then(setCategories)
      .catch(() => setCategories([]))
    reloadAutoTags()
    // 同步结束时刷新一次（新邮件/新摘要会带来新标签）
    const unsubscribe = api.onSyncProgress((p) => {
      if (p.phase === 'done') {
        reloadAutoTags()
        void api.categoryCounts().then(setCategories).catch(() => undefined)
      }
    })
    return unsubscribe
  }, [auth?.loggedIn, reloadAutoTags])

  // 标签列表（V2 M4）
  const reloadLabels = useCallback(() => {
    api
      .listLabels()
      .then(setLabels)
      .catch(() => setLabels([]))
  }, [])

  useEffect(() => {
    if (!auth?.loggedIn) return
    let mounted = true
    api
      .listLabels()
      .then((l) => {
        if (mounted) setLabels(l)
      })
      .catch(() => {
        if (mounted) setLabels([])
      })
    return () => {
      mounted = false
    }
  }, [auth?.loggedIn])

  // 已保存视图列表（V2 M5）
  const reloadViews = useCallback(() => {
    api
      .listViews()
      .then(setViews)
      .catch(() => setViews([]))
  }, [])

  useEffect(() => {
    if (!auth?.loggedIn) return
    let mounted = true
    api
      .listViews()
      .then((v) => {
        if (mounted) setViews(v)
      })
      .catch(() => {
        if (mounted) setViews([])
      })
    return () => {
      mounted = false
    }
  }, [auth?.loggedIn])

  const handleDeleteView = useCallback(
    (id: number) => {
      api
        .deleteView(id)
        .then(() => {
          reloadViews()
          if (activeViewId === id) setActiveViewId(null)
          showToast('视图已删除')
        })
        .catch(() => showToast('删除视图失败'))
    },
    [activeViewId, reloadViews, showToast]
  )

  useEffect(() => {
    let mounted = true
    api
      .getAuthStatus()
      .then((s) => {
        if (mounted) setAuth(s)
      })
      .catch(() => {
        if (mounted) setAuth({ loggedIn: false, email: null })
      })
    return () => {
      mounted = false
    }
  }, [])

  // 会话失效（refresh 失效 / token 过期）时主进程会推送错误事件 → 自动回到登录页
  useEffect(() => {
    const unsubscribe = api.onDeviceCodeEvent((event) => {
      if (
        event.type === 'error' &&
        (event.code === 'AUTH_INVALID_GRANT' || event.code === 'AUTH_REQUIRED' || event.code === 'AUTH_ACCESS_DENIED')
      ) {
        setAuth({ loggedIn: false, email: null })
        showToast(event.message || '登录已失效，请重新登录。')
      }
    })
    return unsubscribe
  }, [showToast])

  const handleLoggedIn = useCallback((status: AuthStatus) => {
    setAuth(status)
    setActive(DEFAULT_FEATURE)
  }, [])

  // 稳定 props（useMemo）：避免 App 每次重渲染都让 memo 化的页面组件重渲染。
  // 注意：必须放在所有条件 return 之前（React hooks 顺序规则）。
  // V2.2 修复（关键）：这里的条件与依赖都必须包含 activeFlagged ——
  // 之前只判断 starred/label，红旗被漏掉，于是「点侧边栏红旗」根本不会产生新的 labelFilter，
  // memo 化的收件箱页面也就不重渲染、不重新查询（用户反馈"点了红旗没反应"）。
  const labelFilter = useMemo(
    () =>
      active === 'inbox' && activeViewId === null && activeStarred
        ? { starredOnly: true }
        : active === 'inbox' && activeViewId === null && activeFlagged
          ? { flaggedOnly: true }
          : active === 'inbox' && activeViewId === null && activeLabelId !== null
            ? { labelIds: [activeLabelId] }
            : undefined,
    [active, activeViewId, activeStarred, activeFlagged, activeLabelId]
  )
  const activeView = useMemo(
    () => (active === 'inbox' ? views.find((v) => v.id === activeViewId) ?? null : null),
    [active, activeViewId, views]
  )
  const filterTitle = useMemo(
    () => (activeLabelId !== null ? labels.find((l) => l.id === activeLabelId)?.name : undefined),
    [activeLabelId, labels]
  )
  // 知识库「✨ 问 AI」：跳到 AI 助手页并带上问题（消费后清空）
  const [aiQuestion, setAiQuestion] = useState<string | null>(null)

  const pageProps: PageProps = useMemo(
    () => ({
      // 页面只在登录后渲染，此处 auth 必非 null
      auth: auth as AuthStatus,
      onToast: showToast,
      onOpenMail: handleOpenMail,
      openMailId: active === 'inbox' ? openMailId : null,
      folderPath: active === 'inbox' ? activeFolder : undefined,
      labelFilter,
      filterTitle,
      onLabelsChanged: active === 'inbox' ? reloadLabels : undefined,
      view: activeView,
      onViewsChanged: active === 'inbox' ? reloadViews : undefined,
      onAskAI: (question: string) => {
        setAiQuestion(question)
        setActive('ai')
      },
      presetQuestion: aiQuestion,
      // 设置页改完「发信权限」后需要重新登录才生效
      onLogout: () => {
        void api.logout().then(() => setAuth({ loggedIn: false, email: null }))
      },
      settings,
      onSettingsChanged: setSettings,
      autoTagFilter: active === 'inbox' ? activeAutoTag : null,
      categoryId: active === 'inbox' ? activeCategoryId : null,
      unreadOnly: active === 'inbox' ? activeUnreadOnly : false
    }),
    [
      auth,
      active,
      aiQuestion,
      openMailId,
      activeFolder,
      labelFilter,
      filterTitle,
      activeView,
      activeAutoTag,
      activeUnreadOnly,
      activeCategoryId,
      showToast,
      handleOpenMail,
      reloadLabels,
      reloadViews,
      settings
    ]
  )

  const enabled = useMemo(() => FEATURE_REGISTRY.filter((f) => f.enabled), [])
  const navFeatures = enabled.filter((f) => f.placement !== 'footer')
  const footerFeatures = enabled.filter((f) => f.placement === 'footer')
  const future = FEATURE_REGISTRY.filter((f) => !f.enabled)

  if (!auth) {
    return <div className="boot">正在启动…</div>
  }

  if (!auth.loggedIn) {
    return <LoginPage onLoggedIn={handleLoggedIn} onToast={showToast} />
  }

  const sectionHead = (key: string, title: string) => {
    const isCollapsed = collapsed.has(key)
    return (
      <button className="nav-label side-section-head" onClick={() => toggleSection(key)} data-testid={`side-section-${key}`}>
        <span className={`chev ${isCollapsed ? '' : 'open'}`}>▸</span>
        {title}
      </button>
    )
  }

  /**
   * V2.2：统一切换收件箱筛选（星标 / 红旗 / 未读 / 标签 / 自定义视图互斥）。
   *
   * 之前的写法是 `clearInboxFilters()` + `setXxx((v) => !v)`：函数式更新拿到的是**队列里已被清空的值**，
   * 于是"退出未读"会变成"再次开启未读"，而"切到红旗"又不会清掉未读 → 查询条件错位（用户反馈红旗/未读点了不对）。
   * 这里改成一次性显式设置所有筛选项。
   */
  const applyInboxFilter = (patch: {
    starred?: boolean
    flagged?: boolean
    unread?: boolean
    labelId?: number | null
    autoTag?: string | null
    categoryId?: number | null
  }): void => {
    setActiveLabelId(patch.labelId ?? null)
    setActiveStarred(patch.starred === true)
    setActiveFlagged(patch.flagged === true)
    setActiveUnreadOnly(patch.unread === true)
    setActiveAutoTag(patch.autoTag ?? null)
    setActiveCategoryId(patch.categoryId ?? null)
    setActiveViewId(null)
    setActive('inbox')
  }

  const clearInboxFilters = (): void => {
    setActiveCategoryId(null)
    setActiveLabelId(null)
    setActiveStarred(false)
    setActiveFlagged(false)
    setActiveViewId(null)
    setActiveAutoTag(null)
    setActiveUnreadOnly(false)
  }

  return (
    <SettingsContext.Provider value={settings}>
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">{(settings.brandName || 'M').trim().slice(0, 1).toUpperCase()}</div>
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">{settings.brandName}</div>
            {settings.brandSubtitle ? <div className="brand-sub">{settings.brandSubtitle}</div> : null}
          </div>
        </div>

        <div className="account-pill">
          <span className="dot" />
          <span className="email" title={auth.email ?? ''}>
            {auth.email ?? ''}
          </span>
        </div>

        <div className="sidebar-nav-scroll">
          <nav className="nav-group">
            {sectionHead('mailbox', '邮箱')}
            {!collapsed.has('mailbox') && (
              <>
                {navFeatures.map((f) => (
                  <div
                    key={f.id}
                    className={`nav-item ${active === f.id ? 'active' : ''}`}
                    onClick={() => setActive(f.id)}
                    data-nav={f.id}
                  >
                    <span className="ico">{f.icon}</span> {f.label}
                  </div>
                ))}
                {future.map((f) => (
                  <div
                    key={f.id}
                    className="nav-item future"
                    data-nav={f.id}
                    onClick={() => showToast(`「${f.label}」为 P1 预留功能，当前版本未实现`)}
                  >
                    <span className="ico">{f.icon}</span> {f.label}
                    <span className="soon">{f.hint}</span>
                  </div>
                ))}
              </>
            )}

            {sectionHead('folders', '文件夹')}
            {!collapsed.has('folders') && (
              <>
                {(showAllFolders ? folders : folders.filter((f) => isCommonFolder(f.name || f.path))).map((f) => (
                  <div key={`wrap:${f.path}`}>
                  <div
                    key={f.path}
                    className={`nav-item ${active === 'inbox' && activeFolder === f.path && activeLabelId === null && !activeStarred && !activeFlagged && activeViewId === null ? 'active' : ''}`}
                    onClick={() => {
                      setActiveFolder(f.path)
                      clearInboxFilters()
                      setActive('inbox')
                    }}
                    data-nav={`folder:${f.path}`}
                    title={f.path}
                  >
                    <span className="ico">{folderIcon(f.name || f.path)}</span> {f.name}
                  </div>
                  {/* V2.2：未读作为文件夹列表里的子项（原来的工具栏「全部/未读」已移除） */}
                  {f.path === 'INBOX' && (
                    <div
                      className={`nav-item sub ${active === 'inbox' && activeUnreadOnly ? 'active' : ''}`}
                      onClick={() => {
                        setActiveFolder('INBOX')
                        applyInboxFilter({ unread: !activeUnreadOnly })
                      }}
                      data-nav="unread"
                    >
                      <span className="ico">●</span> 未读
                      {unreadTotal > 0 && <span className="cnt">{unreadTotal}</span>}
                    </div>
                  )}
                  </div>
                ))}
                {folders.length > folders.filter((f) => isCommonFolder(f.name || f.path)).length && (
                  <div
                    className="nav-item subtle"
                    onClick={() => setShowAllFolders((v) => !v)}
                    data-nav="folders-more"
                  >
                    <span className="ico">{showAllFolders ? '▴' : '▾'}</span>
                    {showAllFolders
                      ? '收起不常用文件夹'
                      : `更多文件夹（${folders.length - folders.filter((f) => isCommonFolder(f.name || f.path)).length}）`}
                  </div>
                )}
              </>
            )}

            {sectionHead('labels', '类别')}
            {!collapsed.has('labels') && (
              <>
                <div
                  className={`nav-item ${active === 'inbox' && activeStarred ? 'active' : ''}`}
                  onClick={() => applyInboxFilter({ starred: !activeStarred })}
                  data-nav="starred"
                >
                  <span className="ico">⭐</span> 星标
                </div>
                {/* V2.2：红旗（像 Outlook 的后续标记）—— 与星标独立，列表里显示红色小旗 */}
                <div
                  className={`nav-item ${active === 'inbox' && activeFlagged ? 'active' : ''}`}
                  onClick={() => applyInboxFilter({ flagged: !activeFlagged })}
                  data-nav="flagged"
                >
                  <span className="ico">🚩</span> 红旗
                </div>
                {/* V2.2：老的「彩色标签」体系已并入统一标签（自动 + 手动），这里只列统一标签 */}
                <div className="nav-item" style={{ display: 'none' }} aria-hidden="true" data-legacy-labels={labels.length} />
                {/* V2.2：侧边栏这里是**类别**筛选（用户要求把标签换成类别；标签仍在顶栏 🏷 面板里搜索） */}
                {categories.map((c) => (
                  <div
                    key={`cat:${c.id}`}
                    className={`nav-item ${active === 'inbox' && activeCategoryId === c.id ? 'active' : ''}`}
                    title={`只看「${c.name}」类别的邮件`}
                    onClick={() => applyInboxFilter({ categoryId: activeCategoryId === c.id ? null : c.id })}
                    data-nav={`category:${c.id}`}
                  >
                    <span className="label-dot" style={{ background: c.color }} />
                    <span className="cat-name">{c.name.replace(/ category$/i, '')}</span>
                    <span className="cnt">{c.count}</span>
                  </div>
                ))}
                {categories.length === 0 && <div className="nav-item subtle">（还没有类别，去设置里新建）</div>}
              </>
            )}

            {views.length > 0 && (
              <>
                {sectionHead('views', '视图')}
                {!collapsed.has('views') &&
                  views.map((v) => (
                    <div
                      key={v.id}
                      className={`nav-item ${active === 'inbox' && activeViewId === v.id ? 'active' : ''}`}
                      onClick={() => {
                        setActiveViewId(v.id)
                        setActiveLabelId(null)
                        setActiveStarred(false)
                        setActiveFolder('INBOX')
                        setActive('inbox')
                      }}
                      data-nav={`view:${v.id}`}
                    >
                      <span className="ico">🗂</span> {v.name}
                      <span
                        className="view-del"
                        title="删除视图"
                        data-testid="view-del"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteView(v.id)
                        }}
                      >
                        ×
                      </span>
                    </div>
                  ))}
              </>
            )}
          </nav>
        </div>

        <div className="sidebar-footer">
          {footerFeatures.map((f) => (
            <button
              key={f.id}
              className={`nav-item ${active === f.id ? 'active' : ''}`}
              style={{ width: '100%' }}
              onClick={() => setActive(f.id)}
              data-nav={f.id}
            >
              <span className="ico">{f.icon}</span> {f.label}
            </button>
          ))}
          <button
            className="nav-item"
            style={{ width: '100%' }}
            onClick={() => {
              void api.logout().then(() => setAuth({ loggedIn: false, email: null }))
            }}
          >
            <span className="ico">↪</span> 退出登录
          </button>
        </div>
      </aside>

      <main className="main">
        {enabled.map((f) => {
          const Page = f.page
          if (!Page) return null
          return (
            <div key={f.id} className={`page-slot ${active === f.id ? 'page-slot-active' : ''}`}>
              <Page {...pageProps} isActive={active === f.id} />
            </div>
          )
        })}
      </main>

      {toast && <Toast toast={toast} onDone={() => setToast(null)} />}
    </div>
    </SettingsContext.Provider>
  )
}
