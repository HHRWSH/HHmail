/**
 * 前端功能注册表（规范 §14.5）：导航/页面数据驱动。
 * 加功能 = 加一个注册项 + 一个页面组件，不改布局框架。
 */
import type { ComponentType } from 'react'
import { InboxPage } from './pages/Inbox'
import { SettingsPage } from './pages/Settings'
import { SentPage } from './pages/Sent'
import { KnowledgePage } from './pages/Knowledge'
import { CalendarPage } from './pages/Calendar'
import { AISearchPage } from './pages/AISearch'
import { DraftsPage } from './pages/Drafts'
import type { AppSettings, AuthStatus, SavedView } from '@shared/types'

export interface PageProps {
  auth: AuthStatus
  onToast: (msg: string) => void
  /** 打开某封邮件（跨页跳转到收件箱详情） */
  onOpenMail?: (id: number) => void
  /** 收件箱接收「跳转打开」的目标邮件 id */
  openMailId?: number | null
  /** 收件箱当前文件夹（V2 M3） */
  folderPath?: string
  /** 标签/星标过滤（V2 M4） */
  labelFilter?: { labelIds?: number[]; starredOnly?: boolean }
  /** 过滤生效时的标题（V2 M4） */
  filterTitle?: string
  /** 标签数据变化（新建等）→ 通知 App 刷新侧边栏（V2 M4） */
  onLabelsChanged?: () => void
  /** 当前激活的自定义视图（V2 M5） */
  view?: SavedView | null
  /** 视图数据变化 → 通知 App 刷新侧边栏（V2 M5） */
  onViewsChanged?: () => void
  /** 本页面当前是否为激活页（V2.1 常驻挂载后，快捷键等全局交互只在激活时响应） */
  isActive?: boolean
  /** 退出登录（设置页用于「重新登录以应用发信权限」） */
  onLogout?: () => void
  /** 带着问题跳到 AI 助手页（知识库 → 问答） */
  onAskAI?: (question: string) => void
  /** AI 助手页的预填问题（消费一次后清空） */
  presetQuestion?: string | null
  /** 当前设置（V2.2：外观与行为；设置页保存后由 App 回传最新值） */
  settings?: AppSettings
  /** 设置保存成功 → 通知 App 立刻应用（主题/密度/品牌名等） */
  onSettingsChanged?: (settings: AppSettings) => void
  /** 自动标签筛选（V2.2：侧边栏点自动标签 → 收件箱只看这一类） */
  autoTagFilter?: string | null
  /** 只看未读（V2.2：侧边栏文件夹列表切换） */
  unreadOnly?: boolean
  /** 按彩色类别筛选（V2.2：侧边栏「类别」） */
  categoryId?: number | null
}

export interface FeatureEntry {
  id: string
  label: string
  icon: string
  enabled: boolean
  /** 未启用时的说明（显示在侧边栏） */
  hint?: string
  /** footer = 侧边栏底部（退出登录上方）；默认 nav = 主导航列表 */
  placement?: 'nav' | 'footer'
  page?: ComponentType<PageProps>
}

export const FEATURE_REGISTRY: FeatureEntry[] = [
  { id: 'inbox', label: '收件箱', icon: '📥', enabled: true, page: InboxPage },
  { id: 'ai', label: 'AI 助手', icon: '✨', enabled: true, page: AISearchPage },
  { id: 'drafts', label: '草稿箱', icon: '✎', enabled: true, page: DraftsPage },
  { id: 'knowledge', label: '知识库', icon: '📚', enabled: true, page: KnowledgePage },
  { id: 'calendar', label: '日历', icon: '🗓', enabled: true, page: CalendarPage },
  { id: 'sent', label: '已发送', icon: '↗', enabled: true, page: SentPage },
  { id: 'settings', label: '设置', icon: '⚙︎', enabled: true, placement: 'footer', page: SettingsPage }
]

export const DEFAULT_FEATURE = 'inbox'
