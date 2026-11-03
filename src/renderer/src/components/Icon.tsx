/**
 * V2.8 统一图标集（线性描边风格，替代之前混用的 emoji）。
 *
 * 约定：24×24 viewBox、stroke=currentColor、stroke-width 1.7、圆角端点；
 * 尺寸由外层 CSS 控制（`.ico svg { width:16px }`），颜色跟随文字色。
 */

export type IconName =
  // 侧边栏功能
  | 'inbox'
  | 'sparkles'
  | 'draft'
  | 'book'
  | 'calendar'
  | 'tasks'
  | 'sent'
  | 'settings'
  | 'logout'
  // 文件夹
  | 'folder'
  | 'archive'
  | 'trash'
  | 'junk'
  | 'conversation'
  | 'notes'
  | 'outbox'
  | 'search'
  // 标记
  | 'star'
  | 'flag'
  | 'dot'
  | 'chevron-down'
  | 'chevron-up'
  | 'chevron-right'
  // 标题栏/通用
  | 'back'
  | 'forward'
  | 'check-all'
  | 'sync'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  | 'block'
  | 'palette'
  | 'tag'
  | 'clock'
  | 'reply'
  | 'task-add'
  | 'bell-off'
  | 'paperclip'
  | 'download'
  | 'undo'
  | 'user'
  | 'info'

const PATHS: Record<IconName, JSX.Element> = {
  palette: (
    <>
      <path d="M12 4a8 8 0 1 0 0 16h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h3a5 5 0 0 0 0-10z" />
      <circle cx="8" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="7" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  tag: (
    <>
      <path d="M4 11.5V5.5A1.5 1.5 0 0 1 5.5 4h6L20 12.5 12.5 20z" />
      <circle cx="8.2" cy="8.2" r="1.3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  reply: (
    <>
      <path d="M10 8L4 13l6 5" />
      <path d="M4 13h9a6 6 0 0 1 6 6v1" />
    </>
  ),
  'task-add': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="0" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  'bell-off': (
    <>
      <path d="M6 9a6 6 0 0 1 9.6-4.8" />
      <path d="M18 12.5V15l1.5 2.5H6.5" />
      <path d="M10 19a2 2 0 0 0 4 0" />
      <path d="M4 4l16 16" />
    </>
  ),
  paperclip: <path d="M8 12.5l6.8-6.8a3 3 0 0 1 4.2 4.2L10.5 18.5a5 5 0 0 1-7-7l8-8" />,
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7 10.5l5 5 5-5" />
      <path d="M5 19.5h14" />
    </>
  ),
  undo: (
    <>
      <path d="M4 10h9a6 6 0 0 1 0 12h-2" />
      <path d="M8 5l-4 5 4 5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.4 3.1-5.5 7-5.5s7 2.1 7 5.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13l2.2-7.2A2 2 0 0 1 8.1 4.4h7.8a2 2 0 0 1 1.9 1.4L20 13" />
      <path d="M4 13v4.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V13" />
      <path d="M4 13h4l1.5 2.5h5L16 13h4" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 4l1.7 4.6L18 10l-4.3 1.4L12 16l-1.7-4.6L6 10l4.3-1.4z" />
      <path d="M18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </>
  ),
  draft: (
    <>
      <path d="M4 20l1-4L16 5l3 3L8 19z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  book: (
    <>
      <path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z" />
      <path d="M5 18.5V5.5" />
      <path d="M9 7.5h6" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="0" />
      <path d="M4 10h16" />
      <path d="M8 3v4M16 3v4" />
    </>
  ),
  tasks: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="0" />
      <path d="M8 12l2.5 2.5L16 9.5" />
    </>
  ),
  sent: (
    <>
      <path d="M21 4L3.5 11l6.5 2.5L12 20z" />
      <path d="M10 13.5L21 4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10" />
      <path d="M15 8l4 4-4 4" />
      <path d="M9 12h10" />
    </>
  ),
  folder: (
    <>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3l2 2.2h6A2.5 2.5 0 0 1 20 9.7v7.8A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z" />
    </>
  ),
  archive: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4" rx="0" />
      <path d="M5.5 8.5V19h13V8.5" />
      <path d="M10 12.5h4" />
    </>
  ),
  trash: (
    <>
      <path d="M5 7h14" />
      <path d="M9.5 7V4.8h5V7" />
      <path d="M7 7l.8 12.2A1.8 1.8 0 0 0 9.6 21h4.8a1.8 1.8 0 0 0 1.8-1.8L17 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </>
  ),
  junk: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 6.5l11 11" />
    </>
  ),
  conversation: (
    <>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-5 4v-4h-.5A2.5 2.5 0 0 1 2 13.5z" transform="translate(1 1)" />
    </>
  ),
  notes: (
    <>
      <path d="M6 4h9l5 5v11H6z" />
      <path d="M14.5 4v5H20" />
      <path d="M9 13h6M9 16.5h4" />
    </>
  ),
  outbox: (
    <>
      <path d="M4 13l2.2-7.2A2 2 0 0 1 8.1 4.4h7.8a2 2 0 0 1 1.9 1.4L20 13" />
      <path d="M4 13v4.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V13" />
      <path d="M12 15V7M9 10l3-3 3 3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  star: (
    <path d="M12 4l2.4 5 5.6.7-4.1 3.9 1.1 5.5L12 16.4 7 19.1l1.1-5.5L4 9.7 9.6 9z" />
  ),
  flag: (
    <>
      <path d="M6 21V4" />
      <path d="M6 5h10l-2 3.5L16 12H6" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />,
  'chevron-down': <path d="M6 9.5l6 6 6-6" />,
  'chevron-up': <path d="M6 14.5l6-6 6 6" />,
  'chevron-right': <path d="M9.5 6l6 6-6 6" />,
  back: <path d="M15 5l-7 7 7 7" />,
  forward: <path d="M9 5l7 7-7 7" />,
  'check-all': (
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
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 6.5l11 11" />
    </>
  )
}

export function Icon({
  name,
  size = 16,
  className
}: {
  name: IconName
  size?: number
  className?: string
}): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

/** 功能页 id → 图标名（侧边栏导航） */
export function featureIconName(id: string): IconName {
  switch (id) {
    case 'inbox':
      return 'inbox'
    case 'ai':
      return 'sparkles'
    case 'drafts':
      return 'draft'
    case 'knowledge':
      return 'book'
    case 'calendar':
      return 'calendar'
    case 'tasks':
      return 'tasks'
    case 'sent':
      return 'sent'
    case 'settings':
      return 'settings'
    default:
      return 'folder'
  }
}
