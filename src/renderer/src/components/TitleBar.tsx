/**
 * V2.8 自绘标题栏（Windows 无边框窗口）。
 *
 * 集成：品牌标识 / 返回 / 全局搜索 / 全部已读 / 同步 / 设置 / 最小化 · 最大化 · 关闭。
 * 交互约定（用户要求）：按钮**无圆角、无边框**，整格填满，只有 hover 才有底色反馈；
 * 关闭按钮 hover 为红色（Windows 习惯）。拖动条区域 `-webkit-app-region: drag`。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../bridge'

export interface TitleBarProps {
  brandName: string
  brandInitial: string
  /** 全局搜索词（受控） */
  search: string
  onSearchChange: (value: string) => void
  /** 回车/点搜索图标时把焦点带到收件箱搜索结果 */
  onSearchSubmit: () => void
  /** 返回：详情 → 列表；其它页面 → 收件箱 */
  canGoBack: boolean
  onBack: () => void
  /** 当前页面是否在收件箱（决定 全部已读/同步 是否可用） */
  inboxActive: boolean
  onMarkAllRead: () => void
  markingAllRead: boolean
  onSync: () => void
  syncing: boolean
  syncLabel: string
  onOpenSettings: () => void
  settingsActive: boolean
}

const ICON = {
  back: (
    <>
      <path d="M15 5l-7 7 7 7" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  checkAll: (
    <>
      <path d="M2 12.5l4 4L13 9" />
      <path d="M10 12.5l4 4L21 9" />
    </>
  ),
  sync: (
    <>
      <path d="M20 11a8 8 0 1 0-2.6 6.3" />
      <path d="M20 4v7h-7" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </>
  ),
  minimize: <path d="M4 12h16" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="0" />,
  restore: (
    <>
      <rect x="8" y="4" width="12" height="12" />
      <path d="M4 8h12v12H4z" />
    </>
  ),
  close: (
    <>
      <path d="M5 5l14 14" />
      <path d="M19 5L5 19" />
    </>
  )
}

function BarIcon({ name }: { name: keyof typeof ICON }): JSX.Element {
  return (
    <svg
      className="tb-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON[name]}
    </svg>
  )
}

export function TitleBar(props: TitleBarProps): JSX.Element {
  const {
    brandName,
    brandInitial,
    search,
    onSearchChange,
    onSearchSubmit,
    canGoBack,
    onBack,
    inboxActive,
    onMarkAllRead,
    markingAllRead,
    onSync,
    syncing,
    syncLabel,
    onOpenSettings,
    settingsActive
  } = props
  const [maximized, setMaximized] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void api.windowIsMaximized().then(setMaximized).catch(() => undefined)
    const off = api.onWindowState((m) => setMaximized(m))
    return () => {
      off()
    }
  }, [])

  const toggleMaximize = useCallback(() => {
    void api.windowToggleMaximize().then(setMaximized).catch(() => undefined)
  }, [])

  return (
    <header className="titlebar" onDoubleClick={toggleMaximize} data-testid="titlebar">
      <div className="tb-left">
        <button
          className="tb-btn tb-icon-btn tb-back"
          onClick={onBack}
          disabled={!canGoBack}
          title="返回（Alt+←）"
          data-testid="titlebar-back"
        >
          <BarIcon name="back" />
        </button>
      </div>

      <div className="tb-search" data-testid="titlebar-search">
        <BarIcon name="search" />
        <input
          ref={searchRef}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSearchSubmit()
            if (e.key === 'Escape') onSearchChange('')
          }}
          placeholder="搜索邮件（主题 / 正文 / 发件人）"
          data-testid="search-input"
          spellCheck={false}
        />
        {search ? (
          <button className="tb-clear" onClick={() => onSearchChange('')} title="清空" data-testid="search-clear">
            <BarIcon name="close" />
          </button>
        ) : null}
      </div>

      <div className="tb-actions">
        <span className="tb-sync-label" data-testid="sync-status">
          {syncLabel}
        </span>
        <button
          className="tb-btn"
          onClick={onMarkAllRead}
          disabled={!inboxActive || markingAllRead}
          title="把当前文件夹里的所有未读邮件标记为已读（只改本地，不会同步到服务器）"
          data-testid="mark-all-read"
        >
          <BarIcon name="checkAll" />
          <span className="tb-btn-text">{markingAllRead ? '标记中…' : '全部已读'}</span>
        </button>
        <button
          className="tb-btn"
          onClick={onSync}
          disabled={!inboxActive || syncing}
          title="立即同步（只读收信）"
          data-testid="sync-btn"
        >
          <BarIcon name="sync" />
          <span className="tb-btn-text">{syncing ? '同步中…' : '同步'}</span>
        </button>
        <button
          className={`tb-btn ${settingsActive ? 'tb-btn-on' : ''}`}
          onClick={onOpenSettings}
          title="设置"
          data-testid="titlebar-settings"
        >
          <BarIcon name="settings" />
          <span className="tb-btn-text">设置</span>
        </button>
      </div>

      {/* Windows 才自绘窗口按钮；macOS 保留系统红绿灯（避免和原生按钮重复） */}
      {api.platform === 'win32' && (
        <div className="tb-window" data-testid="titlebar-window">
          <button className="tb-win-btn" onClick={() => void api.windowMinimize()} title="最小化" data-testid="win-minimize">
            <BarIcon name="minimize" />
          </button>
          <button
            className="tb-win-btn"
            onClick={toggleMaximize}
            title={maximized ? '还原' : '最大化'}
            data-testid="win-maximize"
          >
            <BarIcon name={maximized ? 'restore' : 'maximize'} />
          </button>
          <button
            className="tb-win-btn tb-win-close"
            onClick={() => void api.windowClose()}
            title="关闭"
            data-testid="win-close"
          >
            <BarIcon name="close" />
          </button>
        </div>
      )}
    </header>
  )
}
