/**
 * 组合根（规范 §14.6）：唯一装配依赖的地方，禁止到处 new。
 * MailProvider → MessageStore → MailAiService → IPC handlers 全链路在此接线；
 * 测试可注入 fake；替换实现只改这里。
 */
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { BrowserWindow } from 'electron'
import { AppError, ErrorCodes } from '../shared/error-codes'
import type { DeviceCodeEvent, SyncProgress } from '../shared/types'
import { AxiosHttpClient, DeviceCodeAuth } from './auth/deviceCode'
import { buildScopeString } from './config'
import { DefaultAuthService, type AuthService } from './auth/service'
import { SafeStorageTokenStore, type SafeStorageLike, type TokenStore } from './auth/tokenStore'
import { MailAiServiceImpl } from './ai/service'
import { DeepSeekAiProvider } from './ai/deepseek'
import { SqliteMessageStore } from './db/sqlite'
import type { MessageStore } from './db/store'
import { SqliteAccountRepository } from './db/accounts'
import { SqliteSettingsRepository } from './db/settingsRepo'
import type { Logger } from './logger'
import { ImapMailProvider } from './mail/imap'
import type { MailProvider } from './mail/provider'
import type { ParsedMessage } from './mail/types'
import { SyncEngine } from './mail/sync'
import { parseRawMessage } from './mail/mime'
import { SafeStorageSettingsStore, type SettingsStore } from './settings'
import { DEFAULT_SYNC_WINDOW } from './config'
import { FakeMailProvider, MockAuthService, MockSettingsStore } from './mock'
import type { MailAiService } from './ai/service'

export interface AppContext {
  auth: AuthService
  provider: MailProvider
  store: MessageStore
  sync: SyncEngine
  settings: SettingsStore
  ai: MailAiService
  logger: Logger
  mockMode: boolean
  /** 本地数据目录（设置页「关于与数据」展示用） */
  userDataPath: string
  /** 原始 MIME → ParsedMessage（供详情页对缺失正文的旧邮件按需回填） */
  parse: (raw: Buffer, uid: number, flags: string[]) => Promise<ParsedMessage>
  shutdown: () => Promise<void>
}

export interface BootstrapDeps {
  userDataPath: string
  logger: Logger
  safeStorage: SafeStorageLike
  mock?: boolean
  emitDeviceCode?: (e: DeviceCodeEvent) => void
  httpClient?: { postForm(url: string, params: Record<string, string>): Promise<unknown> }
}

/** 数据库文件名（V2.2 起用通用名）。LEGACY_DB_FILE_NAME 是历史安装留下的旧文件名，
 *  仅用于「启动时自动改名/迁移老数据」，属于内部路径常量，不代表当前项目绑定任何学校。 */
export const DB_FILE_NAME = 'mail-ai.db'
export const LEGACY_DB_FILE_NAME = 'cuhk-mail.db'

/** 定位数据库文件：优先新名字，其次旧名字（升级用户的库不会丢） */
export function resolveDbPath(userDataPath: string, override?: string): string {
  if (override) return override
  const next = path.join(userDataPath, DB_FILE_NAME)
  if (fs.existsSync(next)) return next
  const legacy = path.join(userDataPath, LEGACY_DB_FILE_NAME)
  if (fs.existsSync(legacy)) return legacy
  return next
}

/**
 * 把旧数据库文件名（cuhk-mail.db，V2.2 之前）改名成通用名 mail-ai.db。
 * 同目录改名是元数据操作（132MB 也是瞬间完成），失败就退回用旧名字打开，绝不阻断启动。
 */
export function normalizeDbFileName(userDataPath: string): void {
  try {
    const next = path.join(userDataPath, DB_FILE_NAME)
    const legacy = path.join(userDataPath, LEGACY_DB_FILE_NAME)
    if (fs.existsSync(next) || !fs.existsSync(legacy)) return
    fs.renameSync(legacy, next)
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${legacy}${suffix}`)) fs.renameSync(`${legacy}${suffix}`, `${next}${suffix}`)
    }
  } catch {
    /* 改名失败：resolveDbPath 仍会找到旧名字，功能不受影响 */
  }
}

export async function bootstrap(deps: BootstrapDeps): Promise<AppContext> {
  const { userDataPath, logger, safeStorage } = deps
  const mock = deps.mock === true
  const emitDeviceCode =
    deps.emitDeviceCode ??
    ((e: DeviceCodeEvent): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('auth:device-code:event', e)
      }
    })

  const dbPath = mock
    ? path.join(os.tmpdir(), `mail-ai-mock-${process.pid}-${Date.now()}.db`)
    : resolveDbPath(userDataPath)

  const store: MessageStore = new SqliteMessageStore(dbPath, logger)

  let auth: AuthService
  let provider: MailProvider
  let settings: SettingsStore
  let ai: MailAiService
  let closeExtra: Array<{ close(): void }> = []

  if (mock) {
    auth = new MockAuthService(emitDeviceCode)
    provider = FakeMailProvider.withDefaults(20)
    settings = new MockSettingsStore()
    ai = new MailAiServiceImpl({
      ai: {
        complete: async (params: { system?: string }) => {
          const d = new Date(Date.now() + 2 * 86400000)
          const pad = (n: number): string => String(n).padStart(2, '0')
          const deadline = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 23:59`
          // 索引卡片请求（M1）：返回结构化卡片，便于验证检索链路
          if ((params?.system ?? '').includes('[TYPE]')) {
            return [
              '[TYPE] 作业 | [COURSE] ENG1110B | [TERM] 2026R1 | [DUE] ' + deadline,
              '[FROM] lin@example.edu | [ORG] 电子工程系',
              '[ENTITIES] Lab 0, GraderScope, Blackboard',
              '[ALIASES] 实验一, Lab0',
              '[FACTS]',
              '- Lab 0 上机 ' + deadline + ' 截止，用 GraderScope 提交',
              '[QUESTIONS] 这周有什么截止？ | Lab 0 怎么提交？',
              '[QUOTE] Lab 0 is due ' + deadline
            ].join('\n')
          }
          // v5 风格（短行 + 近期截止），便于验证「决策卡」排版与倒计时
          return [
            '## 主旨',
            `（mock）测试邮件：完成实验并提交，${deadline.slice(5)} 截止`,
            '',
            '## 重要度',
            '高',
            '',
            '## 关键信息',
            '| 项目 | 内容 |',
            '| --- | --- |',
            '| 截止 | ' + deadline + ' |',
            '| 地点/形式 | 线上 |',
            '',
            '## 截止与行动项',
            '- [ ] 完成实验并提交 —— 截止：' + deadline,
            '',
            '## 分类',
            '作业'
          ].join('\n')
        },
        modelName: () => 'mock'
      },
      store,
      logger
    })
  } else {
    const accountRepo = new SqliteAccountRepository(dbPath)
    const settingsRepo = new SqliteSettingsRepository(dbPath)
    closeExtra = [accountRepo, settingsRepo]
    const tokenStore: TokenStore = new SafeStorageTokenStore(safeStorage, accountRepo, logger)
    const http = deps.httpClient ?? new AxiosHttpClient()
    // 登录 scope 跟随设置：默认申请 IMAP 只读 + SMTP.Send（发信），关掉则退回纯只读。
    // 注：settings 在下方同作用域赋值，闭包在运行时才求值。
    const deviceCodeAuth = new DeviceCodeAuth(http, logger, undefined, async () =>
      buildScopeString((await settings.get()).sendScope)
    )
    auth = new DefaultAuthService({ deviceCodeAuth, tokenStore, logger, emit: emitDeviceCode })
    provider = new ImapMailProvider(() => auth.ensureValidToken(), logger)
    settings = new SafeStorageSettingsStore(safeStorage, settingsRepo)
    ai = new MailAiServiceImpl({
      ai: new DeepSeekAiProvider({
        getConfig: async () => {
          const s = await settings.get()
          const apiKey = await settings.getApiKey()
          if (!apiKey) throw new AppError(ErrorCodes.AI_NOT_CONFIGURED, '尚未配置 AI API Key（设置 → AI 总结与问答）。')
          return { apiKey, baseUrl: s.aiBaseUrl, model: s.aiModel, providerId: s.aiProvider }
        },
        logger
      }),
      store,
      logger
    })
  }

  const parse = (raw: Buffer, uid: number, flags: string[]): Promise<ParsedMessage> => parseRawMessage(raw, uid, flags)

  const sync = new SyncEngine({
    provider,
    store,
    parse,
    logger,
    syncWindow: DEFAULT_SYNC_WINDOW
  })

  return {
    auth,
    provider,
    store,
    sync,
    settings,
    ai,
    logger,
    parse,
    mockMode: mock,
    userDataPath,
    shutdown: async () => {
      await provider.close().catch(() => undefined)
      store.close()
      for (const repo of closeExtra) repo.close()
      logger.close()
      if (mock) {
        try {
          fs.rmSync(dbPath, { force: true })
          fs.rmSync(`${dbPath}-wal`, { force: true })
          fs.rmSync(`${dbPath}-shm`, { force: true })
        } catch {
          /* ignore */
        }
      }
    }
  }
}
