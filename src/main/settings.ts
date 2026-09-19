/**
 * 设置存储：DeepSeek API Key 等敏感值经 safeStorage 加密落盘（规范 §2 第 7 条 / §11）。
 */
import { createHash } from 'node:crypto'
import { DEFAULT_TAG_VOCABULARY, vocabularyToText } from '../shared/tags'
import {
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER_ID,
  defaultModelForProvider,
  resolveAiProvider,
  resolveBaseUrl,
  validateAiConfig
} from '../shared/aiProviders'
import type { AppSettings, SetSettingsArgs } from '../shared/types'
import {
  DEFAULT_ASK_TOPK,
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_SUBTITLE,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_SUMMARY_PROMPT,
  LEGACY_SUMMARY_PROMPT_HASHES,
  THEME_MODES,
  UI_DENSITIES,
  normalizePromptText
} from '../shared/defaults'
import {
  DEEPSEEK_BASE_URL,
  DEFAULT_REFRESH_INTERVAL_SEC,
  DEFAULT_SYNC_WINDOW,
  DEEPSEEK_MODEL,
  LEGACY_DEFAULT_AI_MODELS,
  validateAiModel
} from './config'
import type { SafeStorageLike } from './auth/tokenStore'
import { decodeB64, encodeB64 } from './auth/tokenStore'

export interface SettingsRepository {
  getRaw(key: string): Promise<{ value_enc: string } | null>
  setRaw(key: string, valueEnc: string): Promise<void>
  deleteRaw(key: string): Promise<void>
}

export const SETTINGS_KEY_PROVIDER = 'ai.provider'
export const SETTINGS_KEY_CUSTOM_BASE_URL = 'ai.custom_base_url'
export const SETTINGS_KEY_MODEL = 'ai.model'
export const SETTINGS_KEY_API_KEY = 'ai.api_key'
/** 每个服务商各存一份 Key（切换服务商不必重填） */
export const apiKeyFor = (providerId: string): string => `ai.api_key.${providerId}`
export const SETTINGS_KEY_SYNC_WINDOW = 'sync.window'
export const SETTINGS_KEY_REFRESH_INTERVAL = 'sync.interval'
export const SETTINGS_KEY_SUMMARY_PROMPT = 'ai.summary_prompt'
export const SETTINGS_KEY_AUTO_SUMMARY = 'sync.auto_summary'
/** 默认模型一次性迁移标记（新默认模型发布后只迁移一次，之后尊重用户选择） */
export const SETTINGS_KEY_MODEL_MIGRATED = 'ai.model_migrated'
/** 默认提示词一次性迁移标记（用户没自定义过就跟随新模板，自定义过的不动） */
export const SETTINGS_KEY_PROMPT_MIGRATED = 'ai.prompt_migrated'
/** v5（精简可扫读版）一次性迁移标记：v4 默认值同样跟随升级 */
export const SETTINGS_KEY_PROMPT_MIGRATED_V5 = 'ai.prompt_migrated_v5'
/** V2.2 通用化一次性迁移标记：把「旧版（绑定学校）」默认提示词换成不绑定学校的通用文案 */
export const SETTINGS_KEY_PROMPT_MIGRATED_GENERIC = 'ai.prompt_migrated_generic'
/** 个人邮箱发信（SMTP）配置 */
export const SETTINGS_KEY_SMTP_HOST = 'smtp.host'
export const SETTINGS_KEY_SMTP_PORT = 'smtp.port'
export const SETTINGS_KEY_SMTP_SECURE = 'smtp.secure'
export const SETTINGS_KEY_SMTP_USER = 'smtp.user'
export const SETTINGS_KEY_SMTP_PASS = 'smtp.pass'
export const SETTINGS_KEY_SMTP_TO = 'smtp.to'
/** 登录 scope 是否包含 SMTP.Send（发信权限） */
export const SETTINGS_KEY_SEND_SCOPE = 'mail.send_scope'
// —— 外观 / 行为（V2.2 通用化：任何学校的用户也能按自己习惯调整）——
export const SETTINGS_KEY_THEME = 'ui.theme'
export const SETTINGS_KEY_DENSITY = 'ui.density'
export const SETTINGS_KEY_BRAND_NAME = 'ui.brand_name'
export const SETTINGS_KEY_BRAND_SUBTITLE = 'ui.brand_subtitle'
export const SETTINGS_KEY_LIST_PAGE_SIZE = 'ui.list_page_size'
export const SETTINGS_KEY_RELATIVE_TIME = 'ui.relative_time'
export const SETTINGS_KEY_OPEN_MARKS_READ = 'mail.open_marks_read'
export const SETTINGS_KEY_SYNC_ON_STARTUP = 'sync.on_startup'
export const SETTINGS_KEY_CONFIRM_SEND = 'mail.confirm_send'
export const SETTINGS_KEY_ASK_TOPK = 'ai.ask_topk'
export const SETTINGS_KEY_ATTACHMENT_DIR = 'mail.attachment_dir'
export const SETTINGS_KEY_AUTO_TAG = 'tags.auto'
export const SETTINGS_KEY_TAG_VOCAB = 'tags.vocabulary'

const THEMES: readonly string[] = [...THEME_MODES]
const DENSITIES: readonly string[] = [...UI_DENSITIES]

export const DEFAULT_SMTP_HOST = 'smtp.gmail.com'
export const DEFAULT_SMTP_PORT = 587

export interface SettingsStore {
  get(): Promise<AppSettings>
  set(args: SetSettingsArgs): Promise<AppSettings>
  getApiKey(): Promise<string | null>
  /** 个人邮箱发信凭据（仅主进程内部使用，绝不回传渲染进程） */
  getSmtpPass(): Promise<string | null>
}

/**
 * 判断用户当前提示词是否「仍是某个历史默认值」（用于一次性迁移到新默认）。
 * V2.2：旧默认文案里含真实联系人邮箱，改成**只比哈希**，原文不再进安装包。
 */
/** 提示词指纹（与历史默认值比对用；空白差异不影响） */
export function promptDigest(prompt: string): string {
  return createHash('sha256').update(normalizePromptText(prompt), 'utf8').digest('hex')
}

export function isLegacyDefaultPrompt(
  prompt: string,
  hashes: readonly string[] = LEGACY_SUMMARY_PROMPT_HASHES
): boolean {
  return hashes.includes(promptDigest(prompt))
}

function pickEnum(raw: string | null, allowed: readonly string[], fallback: string): string {
  const v = (raw ?? '').trim()
  return allowed.includes(v) ? v : fallback
}

function pickInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

export class SafeStorageSettingsStore implements SettingsStore {
  private safeStorage: SafeStorageLike
  private repo: SettingsRepository

  constructor(safeStorage: SafeStorageLike, repo: SettingsRepository) {
    this.safeStorage = safeStorage
    this.repo = repo
  }

  private async readEnc(key: string): Promise<string | null> {
    const row = await this.repo.getRaw(key)
    if (!row) return null
    try {
      return this.safeStorage.decryptString(decodeB64(row.value_enc))
    } catch {
      return null
    }
  }

  private async writeEnc(key: string, value: string): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('DPAPI 不可用，无法保存设置。')
    }
    await this.repo.setRaw(key, encodeB64(this.safeStorage.encryptString(value)))
  }

  async get(): Promise<AppSettings> {
    // V2.2：先定服务商（决定模型目录、默认模型、Base URL 与 Key 存放位置）
    const providerId = pickEnum(
      await this.readEnc(SETTINGS_KEY_PROVIDER),
      AI_PROVIDERS.map((p) => p.id),
      DEFAULT_AI_PROVIDER_ID
    )
    const provider = resolveAiProvider(providerId)
    const customBaseUrl = ((await this.readEnc(SETTINGS_KEY_CUSTOM_BASE_URL)) ?? '').trim()
    const modelRaw = ((await this.readEnc(SETTINGS_KEY_MODEL)) ?? '').trim()
    const fallbackModel = defaultModelForProvider(providerId) || DEEPSEEK_MODEL
    const check = validateAiConfig(providerId, modelRaw)
    // 存的是别的服务商的模型 / 已下线的模型名 → 落回该服务商默认模型并落盘
    const model = modelRaw && check.ok ? modelRaw : fallbackModel
    if (model !== modelRaw && modelRaw !== '') {
      await this.writeEnc(SETTINGS_KEY_MODEL, fallbackModel).catch(() => undefined)
    }
    // 一次性迁移：老版本把 DeepSeek Key 存在 ai.api_key → 搬到 ai.api_key.deepseek
    const legacyKey = await this.readEnc(SETTINGS_KEY_API_KEY)
    if (legacyKey !== null && (await this.readEnc(apiKeyFor('deepseek'))) === null) {
      await this.writeEnc(apiKeyFor('deepseek'), legacyKey).catch(() => undefined)
    }
    const autoSummaryRaw = await this.readEnc(SETTINGS_KEY_AUTO_SUMMARY)
    const hasApiKey = (await this.readEnc(apiKeyFor(providerId))) !== null
    const syncWindowRaw = (await this.readEnc(SETTINGS_KEY_SYNC_WINDOW)) ?? String(DEFAULT_SYNC_WINDOW)
    const refreshRaw = (await this.readEnc(SETTINGS_KEY_REFRESH_INTERVAL)) ?? String(DEFAULT_REFRESH_INTERVAL_SEC)
    let summaryPrompt = (await this.readEnc(SETTINGS_KEY_SUMMARY_PROMPT)) ?? DEFAULT_SUMMARY_PROMPT
    // 默认提示词升级（一次性，只比哈希）：老默认值 → 新模板；用户自定义过的保持不变
    for (const [key, marker] of [
      ['migrated', SETTINGS_KEY_PROMPT_MIGRATED],
      ['v5', SETTINGS_KEY_PROMPT_MIGRATED_V5],
      ['generic', SETTINGS_KEY_PROMPT_MIGRATED_GENERIC]
    ] as const) {
      void key
      if ((await this.readEnc(marker)) === '1') continue
      if (isLegacyDefaultPrompt(summaryPrompt)) {
        summaryPrompt = DEFAULT_SUMMARY_PROMPT
        await this.writeEnc(SETTINGS_KEY_SUMMARY_PROMPT, DEFAULT_SUMMARY_PROMPT).catch(() => undefined)
      }
      await this.writeEnc(marker, '1').catch(() => undefined)
    }
    const syncWindow = Number.parseInt(syncWindowRaw, 10)
    const refreshIntervalSec = Number.parseInt(refreshRaw, 10)
    const smtpPortRaw = Number.parseInt((await this.readEnc(SETTINGS_KEY_SMTP_PORT)) ?? String(DEFAULT_SMTP_PORT), 10)
    return {
      aiProvider: provider.id,
      aiModel: model,
      aiBaseUrl: resolveBaseUrl(providerId, customBaseUrl),
      aiCustomBaseUrl: customBaseUrl,
      hasApiKey,
      syncWindow: Number.isFinite(syncWindow) && syncWindow >= 0 ? syncWindow : DEFAULT_SYNC_WINDOW,
      refreshIntervalSec:
        Number.isFinite(refreshIntervalSec) && refreshIntervalSec >= 0 ? refreshIntervalSec : DEFAULT_REFRESH_INTERVAL_SEC,
      summaryPrompt: summaryPrompt.trim() || DEFAULT_SUMMARY_PROMPT,
      autoSummarizeNew: autoSummaryRaw !== '0',
      smtpHost: ((await this.readEnc(SETTINGS_KEY_SMTP_HOST)) ?? DEFAULT_SMTP_HOST).trim() || DEFAULT_SMTP_HOST,
      smtpPort: Number.isFinite(smtpPortRaw) && smtpPortRaw > 0 && smtpPortRaw < 65536 ? smtpPortRaw : DEFAULT_SMTP_PORT,
      smtpSecure: (await this.readEnc(SETTINGS_KEY_SMTP_SECURE)) === '1',
      smtpUser: ((await this.readEnc(SETTINGS_KEY_SMTP_USER)) ?? '').trim(),
      smtpTo: ((await this.readEnc(SETTINGS_KEY_SMTP_TO)) ?? '').trim(),
      hasSmtpPass: (await this.readEnc(SETTINGS_KEY_SMTP_PASS)) !== null,
      sendScope: (await this.readEnc(SETTINGS_KEY_SEND_SCOPE)) !== '0',
      theme: pickEnum(await this.readEnc(SETTINGS_KEY_THEME), THEMES, 'system') as AppSettings['theme'],
      density: pickEnum(await this.readEnc(SETTINGS_KEY_DENSITY), DENSITIES, 'standard') as AppSettings['density'],
      brandName: ((await this.readEnc(SETTINGS_KEY_BRAND_NAME)) ?? '').trim() || DEFAULT_BRAND_NAME,
      brandSubtitle: await this.readBrandSubtitle(),
      listPageSize: pickInt(await this.readEnc(SETTINGS_KEY_LIST_PAGE_SIZE), DEFAULT_LIST_PAGE_SIZE, 5, 200),
      relativeTime: (await this.readEnc(SETTINGS_KEY_RELATIVE_TIME)) !== '0',
      openMailMarksRead: (await this.readEnc(SETTINGS_KEY_OPEN_MARKS_READ)) !== '0',
      syncOnStartup: (await this.readEnc(SETTINGS_KEY_SYNC_ON_STARTUP)) === '1',
      confirmBeforeSend: (await this.readEnc(SETTINGS_KEY_CONFIRM_SEND)) === '1',
      askTopK: pickInt(await this.readEnc(SETTINGS_KEY_ASK_TOPK), DEFAULT_ASK_TOPK, 3, 40),
      attachmentDir: ((await this.readEnc(SETTINGS_KEY_ATTACHMENT_DIR)) ?? '').trim(),
      autoTagEnabled: (await this.readEnc(SETTINGS_KEY_AUTO_TAG)) !== '0',
      tagVocabulary:
        ((await this.readEnc(SETTINGS_KEY_TAG_VOCAB)) ?? '').trim() || vocabularyToText(DEFAULT_TAG_VOCABULARY)
    }
  }

  /**
   * 副标题：默认值升级时跟随新文案（老库里存的是「本地只读 · AI 摘要」，
   * 但应用已支持发信，留着会误导），用户自己改过的则保持不动。
   */
  private async readBrandSubtitle(): Promise<string> {
    const raw = await this.readEnc(SETTINGS_KEY_BRAND_SUBTITLE)
    if (raw === null) return DEFAULT_BRAND_SUBTITLE
    const value = raw.trim()
    if (value === '本地只读 · AI 摘要') {
      await this.writeEnc(SETTINGS_KEY_BRAND_SUBTITLE, DEFAULT_BRAND_SUBTITLE).catch(() => undefined)
      return DEFAULT_BRAND_SUBTITLE
    }
    return value
  }

  async set(args: SetSettingsArgs): Promise<AppSettings> {
    if (args.aiProvider !== undefined) {
      const id = resolveAiProvider(args.aiProvider).id
      await this.writeEnc(SETTINGS_KEY_PROVIDER, id)
      const current = (await this.readEnc(SETTINGS_KEY_MODEL)) ?? ''
      if (!validateAiConfig(id, current).ok) {
        const fallback = defaultModelForProvider(id)
        if (fallback) await this.writeEnc(SETTINGS_KEY_MODEL, fallback)
      }
    }
    if (args.aiCustomBaseUrl !== undefined) {
      await this.writeEnc(SETTINGS_KEY_CUSTOM_BASE_URL, args.aiCustomBaseUrl.trim().slice(0, 300))
    }
    if (args.aiModel !== undefined) {
      const providerId = resolveAiProvider((await this.readEnc(SETTINGS_KEY_PROVIDER)) ?? DEFAULT_AI_PROVIDER_ID).id
      await this.writeEnc(SETTINGS_KEY_MODEL, validateAiModel(args.aiModel, providerId))
    }
    // API Key 按服务商分开存（切换服务商不用重填；清空只清当前服务商）
    const activeProvider = resolveAiProvider(
      (await this.readEnc(SETTINGS_KEY_PROVIDER)) ?? DEFAULT_AI_PROVIDER_ID
    ).id
    if (args.apiKey !== undefined && args.apiKey !== '') {
      // 只写当前服务商的键位（旧键位 ai.api_key 仅用于一次性迁移读取）
      await this.writeEnc(apiKeyFor(activeProvider), args.apiKey)
    }
    if (args.apiKey === '') {
      await this.repo.deleteRaw(apiKeyFor(activeProvider))
      await this.repo.deleteRaw(SETTINGS_KEY_API_KEY)
    }
    if (args.syncWindow !== undefined) {
      await this.writeEnc(SETTINGS_KEY_SYNC_WINDOW, String(args.syncWindow))
    }
    if (args.refreshIntervalSec !== undefined) {
      await this.writeEnc(SETTINGS_KEY_REFRESH_INTERVAL, String(args.refreshIntervalSec))
    }
    if (args.summaryPrompt !== undefined) {
      const prompt = args.summaryPrompt.trim()
      if (prompt) {
        await this.writeEnc(SETTINGS_KEY_SUMMARY_PROMPT, prompt)
      } else {
        // 空提示词 → 恢复默认
        await this.repo.deleteRaw(SETTINGS_KEY_SUMMARY_PROMPT)
      }
    }
    if (args.autoSummarizeNew !== undefined) {
      await this.writeEnc(SETTINGS_KEY_AUTO_SUMMARY, args.autoSummarizeNew ? '1' : '0')
    }
    if (args.theme !== undefined && THEMES.includes(args.theme)) {
      await this.writeEnc(SETTINGS_KEY_THEME, args.theme)
    }
    if (args.density !== undefined && DENSITIES.includes(args.density)) {
      await this.writeEnc(SETTINGS_KEY_DENSITY, args.density)
    }
    if (args.brandName !== undefined) {
      const name = args.brandName.trim().slice(0, 24)
      await this.writeEnc(SETTINGS_KEY_BRAND_NAME, name || DEFAULT_BRAND_NAME)
    }
    if (args.brandSubtitle !== undefined) {
      await this.writeEnc(SETTINGS_KEY_BRAND_SUBTITLE, args.brandSubtitle.trim().slice(0, 40))
    }
    if (args.listPageSize !== undefined) {
      const n = Number.parseInt(String(args.listPageSize), 10)
      if (Number.isFinite(n) && n >= 5 && n <= 200) await this.writeEnc(SETTINGS_KEY_LIST_PAGE_SIZE, String(n))
    }
    if (args.relativeTime !== undefined) {
      await this.writeEnc(SETTINGS_KEY_RELATIVE_TIME, args.relativeTime ? '1' : '0')
    }
    if (args.openMailMarksRead !== undefined) {
      await this.writeEnc(SETTINGS_KEY_OPEN_MARKS_READ, args.openMailMarksRead ? '1' : '0')
    }
    if (args.syncOnStartup !== undefined) {
      await this.writeEnc(SETTINGS_KEY_SYNC_ON_STARTUP, args.syncOnStartup ? '1' : '0')
    }
    if (args.confirmBeforeSend !== undefined) {
      await this.writeEnc(SETTINGS_KEY_CONFIRM_SEND, args.confirmBeforeSend ? '1' : '0')
    }
    if (args.askTopK !== undefined) {
      const n = Number.parseInt(String(args.askTopK), 10)
      if (Number.isFinite(n) && n >= 3 && n <= 40) await this.writeEnc(SETTINGS_KEY_ASK_TOPK, String(n))
    }
    if (args.attachmentDir !== undefined) {
      await this.writeEnc(SETTINGS_KEY_ATTACHMENT_DIR, args.attachmentDir.trim().slice(0, 400))
    }
    if (args.autoTagEnabled !== undefined) {
      await this.writeEnc(SETTINGS_KEY_AUTO_TAG, args.autoTagEnabled ? '1' : '0')
    }
    if (args.tagVocabulary !== undefined) {
      await this.writeEnc(SETTINGS_KEY_TAG_VOCAB, args.tagVocabulary.trim().slice(0, 600))
    }
    if (args.smtpHost !== undefined) {
      await this.writeEnc(SETTINGS_KEY_SMTP_HOST, args.smtpHost.trim())
    }
    if (args.smtpPort !== undefined) {
      const port = Number.parseInt(String(args.smtpPort), 10)
      if (Number.isFinite(port) && port > 0 && port < 65536) await this.writeEnc(SETTINGS_KEY_SMTP_PORT, String(port))
    }
    if (args.smtpSecure !== undefined) {
      await this.writeEnc(SETTINGS_KEY_SMTP_SECURE, args.smtpSecure ? '1' : '0')
    }
    if (args.smtpUser !== undefined) {
      await this.writeEnc(SETTINGS_KEY_SMTP_USER, args.smtpUser.trim())
    }
    if (args.smtpTo !== undefined) {
      await this.writeEnc(SETTINGS_KEY_SMTP_TO, args.smtpTo.trim())
    }
    if (args.sendScope !== undefined) {
      await this.writeEnc(SETTINGS_KEY_SEND_SCOPE, args.sendScope ? '1' : '0')
    }
    if (args.smtpPass !== undefined) {
      // 空串 = 清除已保存的密码，避免「留着一个不知道对不对的旧密码」
      if (args.smtpPass === '') {
        await this.repo.deleteRaw(SETTINGS_KEY_SMTP_PASS)
      } else {
        await this.writeEnc(SETTINGS_KEY_SMTP_PASS, args.smtpPass)
      }
    }
    return this.get()
  }

  async getApiKey(): Promise<string | null> {
    const providerId = resolveAiProvider(
      (await this.readEnc(SETTINGS_KEY_PROVIDER)) ?? DEFAULT_AI_PROVIDER_ID
    ).id
    return (await this.readEnc(apiKeyFor(providerId))) ?? (await this.readEnc(SETTINGS_KEY_API_KEY))
  }

  async getSmtpPass(): Promise<string | null> {
    return this.readEnc(SETTINGS_KEY_SMTP_PASS)
  }
}
