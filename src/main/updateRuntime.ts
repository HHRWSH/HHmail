/**
 * electron-updater 的**真实**实例创建（只有 Electron 主进程会加载本文件）。
 *
 * 与 `update.ts` 分开的原因：那个文件要能被 vitest 直接 import（纯逻辑 + 依赖注入），
 * 而 electron-updater 依赖 electron 运行时，只能在打包后的应用里加载。
 */
import type { UpdaterLike } from './update'

/** 创建真实 updater；开发模式（未打包）返回 null —— 自动更新只在安装版里工作 */
export function createRuntimeUpdater(opts: {
  isPackaged: boolean
  logger?: { info: (event: string, extra?: Record<string, unknown>) => void; warn: (event: string, extra?: Record<string, unknown>) => void }
}): UpdaterLike | null {
  if (!opts.isPackaged) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { autoUpdater } = require('electron-updater') as { autoUpdater: UpdaterLike }
    return autoUpdater
  } catch (e) {
    opts.logger?.warn('update.runtime.load_failed', { reason: e instanceof Error ? e.message : String(e) })
    return null
  }
}
