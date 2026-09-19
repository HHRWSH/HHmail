/**
 * 渲染端设置上下文（V2.2）：设置项要影响很多组件（主题、列表条数、时间格式、发送确认、AI 引用数…），
 * 用 Context 下发，避免把 settings 一层层往下传。
 */
import { createContext, useContext } from 'react'
import type { AppSettings } from '@shared/types'
import {
  DEFAULT_ASK_TOPK,
  DEFAULT_ATTACHMENT_DIR,
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_SUBTITLE,
  DEFAULT_LIST_PAGE_SIZE
} from '@shared/defaults'
import { DEFAULT_TAG_VOCABULARY } from '@shared/tags'

/** 设置还没加载出来时的兜底值（与主进程默认值保持一致） */
export const FALLBACK_SETTINGS: AppSettings = {
  aiProvider: 'deepseek',
  aiModel: 'deepseek-flash',
  aiCustomBaseUrl: '',
  aiBaseUrl: 'https://api.deepseek.com',
  hasApiKey: false,
  syncWindow: 0,
  refreshIntervalSec: 300,
  summaryPrompt: '',
  autoSummarizeNew: true,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpTo: '',
  hasSmtpPass: false,
  sendScope: true,
  theme: 'system',
  density: 'standard',
  brandName: DEFAULT_BRAND_NAME,
  brandSubtitle: DEFAULT_BRAND_SUBTITLE,
  listPageSize: DEFAULT_LIST_PAGE_SIZE,
  relativeTime: true,
  openMailMarksRead: true,
  syncOnStartup: false,
  confirmBeforeSend: false,
  askTopK: DEFAULT_ASK_TOPK,
  attachmentDir: DEFAULT_ATTACHMENT_DIR,
  autoTagEnabled: true,
  tagVocabulary: DEFAULT_TAG_VOCABULARY.join('、')
}

export const SettingsContext = createContext<AppSettings>(FALLBACK_SETTINGS)

export function useSettings(): AppSettings {
  return useContext(SettingsContext)
}
