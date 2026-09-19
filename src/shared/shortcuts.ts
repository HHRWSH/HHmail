/**
 * 快捷键映射纯函数（V2 M7，规范 §7.2）：
 * j/k 上/下；Enter 打开；s 星标；l 加标签；/ 聚焦搜索；u 标未读；a 归档入口（只读提示）；Esc 关闭。
 * 带 Ctrl/Cmd/Alt 修饰的组合键不参与（留给系统/多选交互）。
 */

export type ShortcutContext = 'inbox' | 'detail'

export type ShortcutAction =
  | 'next'
  | 'prev'
  | 'open'
  | 'star'
  | 'label'
  | 'search'
  | 'unread'
  | 'archive'
  | 'close'
  | 'none'

export interface KeyModifiers {
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

export function shortcutMap(key: string, mods: KeyModifiers, context: ShortcutContext): ShortcutAction {
  if (mods.ctrl || mods.meta || mods.alt) return 'none'
  switch (key) {
    case 'j':
      return context === 'inbox' ? 'next' : 'none'
    case 'k':
      return context === 'inbox' ? 'prev' : 'none'
    case 'Enter':
      return 'open'
    case 's':
      return 'star'
    case 'l':
      return 'label'
    case '/':
      return 'search'
    case 'u':
      return 'unread'
    case 'a':
      return 'archive'
    case 'Escape':
      return 'close'
    default:
      return 'none'
  }
}
