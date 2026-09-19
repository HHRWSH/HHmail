/**
 * Electron 主进程入口：窗口 / 生命周期 / 安全基线 / 系统托盘（规范 §6.9）。
 * contextIsolation: true、nodeIntegration: false、sandbox: true、无 webviewTag。
 * 关闭窗口 → 最小化到托盘后台运行；托盘右键可「显示主窗口 / 退出应用」。
 */
import { app, BrowserWindow, dialog, Notification, powerMonitor, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { bootstrap, normalizeDbFileName, type AppContext } from './bootstrap'
import { FileLogger } from './logger'
import { registerIpcHandlers, summarizePendingBatch } from './ipc'
import { repairNoisyBodies } from './db/repair'
import { createTray, type TrayController } from './tray'
import { startSnoozeScheduler, type SnoozeSchedulerHandle } from './mail/snoozeScheduler'
import { createAutoSyncScheduler, type AutoSyncScheduler } from './mail/autoSync'
import { IPC_CHANNELS } from '../shared/ipc-contract'
import type { DeviceCodeEvent, SyncProgress } from '../shared/types'
import { DEFAULT_BRAND_NAME } from '../shared/defaults'

/**
 * GPU 安全模式：某些机器/远程会话下 GPU 进程会反复崩溃（Electron 报
 * "GPU process isn't usable. Goodbye." → 应用直接退出，用户看到「闪退」）。
 * 策略：连续崩溃 2 次 → 写标记文件并重启为软件渲染；标记存在时后续启动直接用软件渲染。
 */
/**
 * 环境变量（V2.2 起改成通用前缀，旧名保留兼容）：
 *   HHMAIL_USERDATA（旧名 MAILAI_USERDATA / LEGACY_MAIL_USERDATA）  指定 userData 目录（E2E / 诊断用）
 *   HHMAIL_DISABLE_GPU（旧名 MAILAI_/LEGACY_MAIL_ 前缀同样兼容）    强制软件渲染
 *   HHMAIL_MOCK（旧名 MAILAI_MOCK / LEGACY_MAIL_MOCK）              mock 模式（不碰真实账号）
 */
const envAny = (...names: string[]): string | undefined => {
  for (const n of names) {
    const v = process.env[n]
    if (v !== undefined) return v
  }
  return undefined
}
/** 新名字对应的数据目录（全新安装用这个） */
const CURRENT_APPDATA_DIR = 'hhmail'
/** 上一版用的数据目录（v2.1 及之前叫 mail-ai-assistant）—— 改名后必须继续用它，否则用户的邮件/登录会"消失" */
const PREVIOUS_APPDATA_DIR = 'mail-ai-assistant'
/** 更早的历史目录名（内部路径常量，仅用于升级时把老数据搬过来） */
const LEGACY_APPDATA_DIR = 'cuhk-mail-ai'

const USERDATA_ENV = envAny('HHMAIL_USERDATA', 'MAILAI_USERDATA', 'LEGACY_MAIL_USERDATA')
const userDataOverride = USERDATA_ENV ?? app.getPath('userData')
export const GPU_SAFE_MODE_MARKER = path.join(userDataOverride, 'gpu-safe-mode')
const FORCE_SOFTWARE_GPU = envAny('HHMAIL_DISABLE_GPU', 'MAILAI_DISABLE_GPU', 'LEGACY_MAIL_DISABLE_GPU') === '1'
let gpuSafeMode =
  FORCE_SOFTWARE_GPU ||
  (() => {
    try {
      return fs.existsSync(GPU_SAFE_MODE_MARKER)
    } catch {
      return false
    }
  })()

if (gpuSafeMode) {
  // 必须在 app ready 之前调用；--in-process-gpu 让 GPU 在浏览器进程内运行，
  // 可绕过「独立 GPU 进程反复崩溃 → FATAL: GPU process isn't usable」这类环境问题
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('in-process-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

let mainWindow: BrowserWindow | null = null
let ctx: AppContext | null = null
let tray: TrayController | null = null
let snoozeTimer: SnoozeSchedulerHandle | null = null
let autoSync: AutoSyncScheduler | null = null
/** 每次自动同步成功后最多补几封摘要（控制成本） */
const AUTO_SUMMARY_CATCHUP_LIMIT = 3
let isQuitting = false

const MOCK_MODE = envAny('HHMAIL_MOCK', 'MAILAI_MOCK', 'LEGACY_MAIL_MOCK') === '1'

function sendToAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function showWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

/**
 * 旧数据目录迁移：更老版本的 app 名是 LEGACY_APPDATA_DIR，升级后 userData 变成新名字，
 * 这里把旧目录整体复制过来（数据库/加密后的登录态/设置/附件/日志），避免用户重新登录 + 重新同步。
 * 只在「新目录里没有数据库」且「旧目录有数据库」时做一次。
 */
export function migrateLegacyUserData(): boolean {
  try {
    const target = app.getPath('userData')
    const legacy = path.join(app.getPath('appData'), LEGACY_APPDATA_DIR)
    if (path.resolve(target) === path.resolve(legacy)) return false
    // 「已经迁过了」的判定必须同时看新名字与旧名字：
    // 只判 legacy-mail.db 会在「上次启动把库改名成 mail-ai.db」之后误判成没迁过，从而再复制一份（真机踩过）
    const hasDb = (dir: string): boolean =>
      fs.existsSync(path.join(dir, 'mail-ai.db')) || fs.existsSync(path.join(dir, 'cuhk-mail.db'))
    if (hasDb(target)) return false
    if (!hasDb(legacy)) return false
    fs.mkdirSync(target, { recursive: true })
    for (const entry of fs.readdirSync(legacy)) {
      if (entry === 'logs' || entry === 'Cache' || entry === 'GPUCache') continue
      const src = path.join(legacy, entry)
      const dst = path.join(target, entry)
      fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false })
    }
    return true
  } catch {
    return false
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    title: DEFAULT_BRAND_NAME,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // 隐藏到托盘/最小化后不要把渲染进程的定时器与 UI 节流掉
      // （真机反馈：托盘后台跑久了界面不刷新、像"没在同步"）
      backgroundThrottling: false
    }
  })

  // 关闭 = 隐藏到托盘（后台继续同步），托盘菜单里才能真退出
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  // 外链一律交给系统浏览器并校验协议（校验逻辑在 IPC handler 里）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void import('electron').then(({ shell }) => shell.openExternal(url))
    }
    return { action: 'deny' }
  })

  // 禁止应用内跳转到外部页面（邮件里的链接走默认浏览器，防钓鱼）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const allowed = app.isPackaged ? false : !!devUrl && url.startsWith(devUrl)
    if (!allowed) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** 窗口标题跟随设置里的品牌名（用户可改成自己学校的名字） */
async function applyBrandTitle(context: AppContext): Promise<void> {
  try {
    const settings = await context.settings.get()
    const name = (settings.brandName || DEFAULT_BRAND_NAME).trim() || DEFAULT_BRAND_NAME
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(name)
    tray?.setTooltip(name)
  } catch {
    /* 设置读不到就保持默认标题 */
  }
}

async function main(): Promise<void> {
  // 诊断用：允许指定 userData（默认按 app 名；裸 electron 运行时会落到 Roaming\Electron）
  if (USERDATA_ENV) {
    app.setPath('userData', USERDATA_ENV)
  } else {
    // 项目改名 HHmail 后，Electron 默认数据目录会变成 %APPDATA%\hhmail；
    // **只要老目录（%APPDATA%\mail-ai-assistant）存在就继续用它** —— 那里有用户的邮件库、摘要索引与登录态，
    // 换成新目录会让用户「像丢了数据一样」（还要重新同步、重新花 AI 额度）。
    // 只有全新安装（没有老目录）才使用新目录名。
    let usingPrevious = false
    try {
      const appData = app.getPath('appData')
      const previous = path.join(appData, PREVIOUS_APPDATA_DIR)
      if (fs.existsSync(path.join(previous, 'mail-ai.db')) || fs.existsSync(path.join(previous, 'logs'))) {
        app.setPath('userData', previous)
        usingPrevious = true
      }
    } catch {
      /* 判断失败就用默认目录，不影响启动 */
    }
    // 更老的目录（cuhk-mail-ai）只在「确实没有可用数据目录」时才搬，避免把旧快照复制进新目录
    if (!usingPrevious) migrateLegacyUserData()
    // 数据库文件名也统一成通用名（同目录改名，失败不影响使用）
    normalizeDbFileName(app.getPath('userData'))
  }  await app.whenReady()

  if (process.platform === 'win32') {
    app.setAppUserModelId('app.hhmail.desktop')
  }

  const userDataPath = app.getPath('userData')
  const logger = new FileLogger({ logDir: path.join(userDataPath, 'logs') })

  if (!safeStorage.isEncryptionAvailable() && !MOCK_MODE) {
    // Windows DPAPI 不可用时拒绝启动（规范 §2 第 4 条：token 不能明文落盘）
    logger.error('startup.dpapi.unavailable')
    dialog.showErrorBox('无法启动', '系统加密服务不可用（DPAPI），应用无法安全保存登录凭证。')
    app.quit()
    return
  }

  const emitDeviceCode = (e: DeviceCodeEvent): void => sendToAll(IPC_CHANNELS.AUTH_DEVICE_CODE_EVENT, e)
  const emitSync = (p: SyncProgress): void => sendToAll(IPC_CHANNELS.MAIL_SYNC_EVENT, p)

  ctx = await bootstrap({
    userDataPath,
    logger,
    safeStorage,
    mock: MOCK_MODE,
    emitDeviceCode
  })

  registerIpcHandlers(ctx, logger, emitSync)
  logger.info('app.ready', { mock: MOCK_MODE })
  if (gpuSafeMode) logger.warn('app.gpu.safe_mode', { forced: FORCE_SOFTWARE_GPU })

  // GPU 进程崩溃兜底：连续两次即切换到软件渲染并重启（避免用户侧「应用闪退」）
  let gpuCrashes = 0
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') return
    gpuCrashes += 1
    logger.warn('app.gpu.gone', { crashes: gpuCrashes, reason: details.reason })
    if (gpuCrashes >= 2 && !gpuSafeMode) {
      try {
        fs.writeFileSync(GPU_SAFE_MODE_MARKER, String(Date.now()))
      } catch {
        /* ignore */
      }
      gpuSafeMode = true
      logger.warn('app.gpu.restart_safe_mode')
      app.relaunch()
      app.exit(0)
    }
  })

  // 一次性数据清洗：修掉早期版本把 HTML 邮件 CSS 当正文入库的问题（后台执行，不阻塞启动）
  void repairNoisyBodies(ctx.store, logger).catch(() => undefined)

  /**
   * 后台自动同步（V2.2 真机修复：休眠/托盘久置后长时间不同步）：
   * 定时器放在主进程（与窗口可见性无关），休眠唤醒/解锁立即补偿一次，
   * 同步超过 2 分钟视为卡死 → 关连接让请求快速失败、下一次重连。
   */
  autoSync = createAutoSyncScheduler({
    sync: (reason) => {
      logger.info('sync.auto.run', { reason })
      return ctx!.sync.run((p) => emitSync(p))
    },
    intervalSec: async () => (await ctx!.settings.get()).refreshIntervalSec,
    logger,
    onStall: () => {
      // 半死连接：直接关掉，让挂住的 IMAP 请求立刻失败，下一个心跳重新连
      void ctx?.provider.close().catch(() => undefined)
    },
    // 同步成功后自动补摘要（真机反馈「有时 AI 不会自动总结，要手动点」）：
    // 只处理少量缺摘要的邮件，失败也只记日志；没有 API Key 时直接跳过。
    afterSync: async (reason) => {
      if (!ctx) return
      const settings = await ctx.settings.get()
      if (!settings.autoSummarizeNew || !settings.hasApiKey) return
      const res = await summarizePendingBatch(ctx, { limit: AUTO_SUMMARY_CATCHUP_LIMIT })
      if (res && (res.done > 0 || res.failed > 0)) {
        logger.info('ai.auto_catchup', { reason, total: res.total, done: res.done, failed: res.failed })
      }
    }
  })
  autoSync.start()

  // 窗口重新获得焦点时：如果已经陈旧（超过一个间隔没成功同步）就补一次
  // —— 用户「打开应用发现邮件没更新」的场景靠这条兜底（不依赖激活窗口的渲染端定时器）
  app.on('browser-window-focus', () => {
    void autoSync?.kickIfStale('focus')
  })

  // 休眠/唤醒：唤醒后连接基本已经废了 → 先丢掉旧连接，再立刻同步一次
  if (typeof powerMonitor?.on === 'function') {
    powerMonitor.on('suspend', () => logger.info('app.power.suspend'))
    powerMonitor.on('resume', () => {
      logger.info('app.power.resume')
      void ctx?.provider.close().catch(() => undefined)
      void autoSync?.kick('resume')
    })
    powerMonitor.on('unlock-screen', () => {
      logger.info('app.power.unlock')
      void autoSync?.kick('unlock-screen')
    })
  }

  // 稍后提醒调度（V2 M6）：周期检查到期提醒 → Windows 通知（间隔兜底 60s）
  snoozeTimer = startSnoozeScheduler(
    {
      store: ctx.store,
      logger,
      notifier: {
        notify: (title, body) => {
          new Notification({ title, body }).show()
        }
      }
    },
    60_000
  )

  createWindow()

  tray = createTray({
    getWindow: () => mainWindow,
    showWindow,
    quitApp: () => {
      isQuitting = true
      app.quit()
    }
  })

  // 标题/托盘名跟随设置里的品牌名（用户可改成自己学校的名字）
  void applyBrandTitle(ctx)
  // 设置变化后同步刷新标题
  app.on('browser-window-focus', () => {
    if (ctx) void applyBrandTitle(ctx)
  })

  app.on('activate', () => {
    showWindow()
  })
}

// 单实例锁：重复双击只唤起已有实例（托盘/后台模式下的正确行为）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })
  void main()
}

app.on('window-all-closed', () => {
  // 托盘模式：窗口关闭即隐藏，应用常驻后台；真正退出走托盘菜单
})

app.on('before-quit', () => {
  isQuitting = true
  if (autoSync) {
    autoSync.stop()
    autoSync = null
  }
  if (snoozeTimer) {
    snoozeTimer.stop()
    snoozeTimer = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
  if (ctx) {
    void ctx.shutdown()
    ctx = null
  }
})

process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e && e.message ? e.message : e)
})

process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && (e as Error).message ? (e as Error).message : e)
})
