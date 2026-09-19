/**
 * 系统托盘：关闭窗口 → 后台驻留托盘；右键菜单可显示主窗口 / 退出应用。
 */
import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { DEFAULT_BRAND_NAME } from '../shared/defaults'
import { TRAY_ICON_DATA_URL } from './trayIcon'

/** 内置 32x32 托盘图标（代码生成的 PNG，避免资源文件打包问题）。 */
export { TRAY_ICON_DATA_URL } from './trayIcon'

export interface TrayController {
  destroy(): void
  /** 品牌名变化时刷新托盘提示（设置页可改产品名） */
  setTooltip(name: string): void
}

export function createTray(opts: {
  getWindow: () => BrowserWindow | null
  showWindow: () => void
  quitApp: () => void
}): TrayController {
  const image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  const tray = new Tray(image)
  tray.setToolTip(DEFAULT_BRAND_NAME)
  tray.on('click', () => opts.showWindow())
  tray.on('double-click', () => opts.showWindow())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => opts.showWindow() },
      { type: 'separator' },
      {
        label: '退出应用',
        click: () => opts.quitApp()
      }
    ])
  )
  return {
    destroy: () => tray.destroy(),
    setTooltip: (name: string) => {
      tray.setToolTip((name || DEFAULT_BRAND_NAME).trim() || DEFAULT_BRAND_NAME)
    }
  }
}
