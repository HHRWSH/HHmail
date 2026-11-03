/**
 * 开机自动启动（V2.4）。
 *
 * Windows：`app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })`，
 *   `--hidden` 让应用开机后**只驻留托盘**（不弹窗打扰），用户点托盘图标再打开。
 * macOS：同一 API，用 `openAsHidden: true` 实现隐藏启动（Windows 上该字段会被忽略）。
 * Linux：Electron 不保证支持，调用失败只会记日志（不阻断设置保存）。
 *
 * 这里做成纯函数 + 注入 setter，便于单测（不需要真的改注册表）。
 */

export interface LoginItemOptions {
  openAtLogin: boolean
  openAsHidden?: boolean
  args?: string[]
}

/** 按平台生成 setLoginItemSettings 的参数 */
export function loginItemOptions(enabled: boolean, platform: string = process.platform): LoginItemOptions {
  if (!enabled) return { openAtLogin: false }
  if (platform === 'darwin') return { openAtLogin: true, openAsHidden: true }
  // Windows（及 Linux）：用参数标记隐藏启动；Linux 不保证生效，失败由调用方 catch
  return { openAtLogin: true, args: ['--hidden'] }
}

/**
 * 应用开机启动设置。返回实际传给 Electron 的参数（便于日志/断言）。
 * setter 抛错（无权限/平台不支持）不向上抛 —— 设置项本身仍保存成功。
 */
export function applyLoginItem(
  enabled: boolean,
  setter: (opts: LoginItemOptions) => void,
  platform: string = process.platform
): LoginItemOptions {
  const opts = loginItemOptions(enabled, platform)
  try {
    setter(opts)
  } catch {
    /* 平台不支持时忽略 */
  }
  return opts
}

/** 应用启动参数里是否带 --hidden（开机自启的隐藏启动标记） */
export function isHiddenStart(argv: readonly string[]): boolean {
  return argv.includes('--hidden')
}
