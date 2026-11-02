/**
 * 自动更新控制器（V2.3）—— 对 electron-updater 的薄封装，**不 import electron-updater**。
 *
 * 为什么这样设计：electron-updater 只能在 Electron 运行时加载（它依赖 electron），
 * 直接 import 会让单元测试/主进程模块图炸掉。这里只依赖一个「事件发射器 + 三个方法」的形状，
 * 真实实例在 `updateRuntime.ts`（只有 Electron 会加载）里创建并注入，于是本文件可单测。
 *
 * 行为约定：
 *   - 自动下载**关闭**（autoDownload=false）：发现新版本后由用户点「下载更新」；
 *   - portable（绿色版）不支持自动更新：检查可以提示「有新版本」，但拒绝下载/安装并提示手动下载；
 *   - 所有失败都转成 error 状态 + 裁剪后的原因，绝不把整段异常对象（可能含 token/URL）丢给渲染层。
 */
import { describeUpdateState, isPortableBuild, type UpdateState } from '../shared/update'

/** electron-updater 事件载荷（只声明用到的字段） */
export interface UpdateInfoLike {
  version?: string
  releaseNotes?: string | { note?: string } | null
  releaseName?: string | null
}

export interface UpdateProgressLike {
  percent?: number
  transferred?: number
  total?: number
}

/** electron-updater 的 autoUpdater 形状（只用到这些） */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeAllListeners?(event?: string): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateControllerDeps {
  /** 当前应用版本（Electron: app.getVersion()） */
  appVersion: string
  /** 拿 updater 实例（首次用到时才创建；返回 null = 当前环境不支持自动更新，如开发模式） */
  getUpdater: () => UpdaterLike | null
  /** 状态变化 → 推给渲染层 */
  emit: (state: UpdateState) => void
  logger?: { info: (event: string, extra?: Record<string, unknown>) => void; warn: (event: string, extra?: Record<string, unknown>) => void }
  /** 是否 portable（默认按环境变量判断） */
  portable?: boolean
  /** 注入时间（测试用） */
  now?: () => number
}

export interface UpdateController {
  attach(): void
  /** 检查更新；manual=true 表示用户主动点的（返回结果用） */
  check(manual?: boolean): Promise<UpdateState>
  /** 下载已发现的新版本 */
  download(): Promise<UpdateState>
  /** 重启并安装已下载的更新 */
  install(): void
  getState(): UpdateState
  /** 状态文案（调试/日志用） */
  describe(): string
}

/** 从 releaseNotes 里取一段纯文本摘要（GitHub Release notes 可能是数组/对象/长 Markdown） */
export function summarizeReleaseNotes(notes: UpdateInfoLike['releaseNotes']): string | undefined {
  if (!notes) return undefined
  let text = ''
  if (typeof notes === 'string') text = notes
  else if (Array.isArray(notes)) {
    text = notes
      .map((n) => (typeof n === 'string' ? n : typeof n === 'object' && n ? String((n as { note?: string }).note ?? '') : ''))
      .join('\n')
  } else if (typeof notes === 'object') {
    text = String((notes as { note?: string }).note ?? '')
  }
  const flat = text.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim()
  return flat ? flat.slice(0, 500) : undefined
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const portable = deps.portable ?? isPortableBuild()
  const now = deps.now ?? Date.now
  let state: UpdateState = { status: 'idle', currentVersion: deps.appVersion, portable }
  let attached = false
  let checking = false

  const set = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch }
    try {
      deps.emit(state)
    } catch {
      /* 渲染层可能已关闭 */
    }
  }

  const fail = (reason: unknown, event: string): void => {
    const message = reason instanceof Error ? reason.message : String(reason)
    // 裁剪：只留第一行、去掉超长 URL/路径细节，避免把敏感信息带给渲染层
    const clean = message.split('\n')[0].replace(/\s+/g, ' ').slice(0, 200)
    deps.logger?.warn(event, { reason: clean })
    set({ status: 'error', error: clean, checkedAt: now() })
  }

  const wire = (updater: UpdaterLike): void => {
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    updater.on('checking-for-update', () => {
      set({ status: 'checking', error: undefined, checkedAt: now() })
    })
    updater.on('update-available', (...args) => {
      const info = (args[0] ?? {}) as UpdateInfoLike
      set({
        status: 'available',
        latestVersion: info.version ?? state.latestVersion,
        notes: summarizeReleaseNotes(info.releaseNotes),
        checkedAt: now(),
        error: undefined
      })
      deps.logger?.info('update.available', { latest: info.version ?? null })
    })
    updater.on('update-not-available', () => {
      set({ status: 'not-available', latestVersion: undefined, checkedAt: now(), error: undefined })
    })
    updater.on('download-progress', (...args) => {
      const p = (args[0] ?? {}) as UpdateProgressLike
      set({
        status: 'downloading',
        progress: Math.max(0, Math.min(100, Number(p.percent ?? 0))),
        transferred: p.transferred,
        total: p.total
      })
    })
    updater.on('update-downloaded', (...args) => {
      const info = (args[0] ?? {}) as UpdateInfoLike
      set({ status: 'downloaded', latestVersion: info.version ?? state.latestVersion, progress: 100, error: undefined })
      deps.logger?.info('update.downloaded', { latest: info.version ?? null })
    })
    updater.on('error', (...args) => {
      fail(args[0], 'update.error')
    })
  }

  return {
    attach(): void {
      if (attached) return
      attached = true
      if (portable) {
        set({ status: 'unsupported' })
        return
      }
      const updater = deps.getUpdater()
      if (!updater) {
        set({ status: 'unsupported' })
        return
      }
      try {
        wire(updater)
      } catch (e) {
        fail(e, 'update.attach.failed')
      }
    },

    async check(manual = false): Promise<UpdateState> {
      if (portable) {
        set({ status: 'unsupported' })
        return state
      }
      if (checking) return state
      const updater = deps.getUpdater()
      if (!updater) {
        set({ status: 'unsupported' })
        return state
      }
      checking = true
      set({ status: 'checking', error: undefined, checkedAt: now() })
      try {
        await updater.checkForUpdates()
        // 结果由事件回调更新；这里兜底：如果 3 秒内没有事件（某些渠道不会发 not-available），标成已是最新
        setTimeout(() => {
          if (state.status === 'checking') set({ status: 'not-available', checkedAt: now() })
        }, 3_000)
      } catch (e) {
        fail(e, 'update.check.failed')
      } finally {
        checking = false
      }
      deps.logger?.info('update.check', { manual, status: state.status })
      return state
    },

    async download(): Promise<UpdateState> {
      if (portable) {
        set({ status: 'unsupported', error: '便携版不支持自动更新，请手动下载新版' })
        return state
      }
      if (state.status !== 'available') return state
      const updater = deps.getUpdater()
      if (!updater) {
        set({ status: 'unsupported' })
        return state
      }
      set({ status: 'downloading', progress: 0, error: undefined })
      try {
        await updater.downloadUpdate()
      } catch (e) {
        fail(e, 'update.download.failed')
      }
      return state
    },

    install(): void {
      if (portable || state.status !== 'downloaded') return
      const updater = deps.getUpdater()
      if (!updater) return
      try {
        deps.logger?.info('update.install', { version: state.latestVersion ?? null })
        updater.quitAndInstall(false, true)
      } catch (e) {
        fail(e, 'update.install.failed')
      }
    },

    getState: (): UpdateState => state,
    describe: (): string => describeUpdateState(state)
  }
}
