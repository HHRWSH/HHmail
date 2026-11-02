/**
 * 未读角标控制器（V2.3）：Windows 任务栏 overlay + 托盘 tooltip + macOS dock badge。
 *
 * 与 Electron 解耦（注入 window/tray/app 行为），便于单测：
 *   - `refresh(count, brand)`：按未读数选图标 / 清除，刷新 tooltip；
 *   - 只做展示，不查库 —— 调用方（index.ts）负责 `countMails({ unreadOnly: true })`。
 */
import { badgeDescription, badgeKind, badgeTooltip, type UnreadBadgeKind } from '../shared/unreadBadge'

export interface BadgeWindowLike {
  isDestroyed?(): boolean
  setOverlayIcon(icon: unknown, description: string): void
}

export interface UnreadBadgeDeps {
  getWindow: () => BadgeWindowLike | null
  /** 把角标种类变成平台的图标对象（Windows 用 nativeImage） */
  createIcon: (kind: UnreadBadgeKind) => unknown
  /** 托盘 tooltip（品牌名 + 未读数） */
  setTrayTooltip: (text: string) => void
  /** macOS dock 角标（可选；Windows 传 undefined） */
  setAppBadge?: (count: number) => void
  /** 当前平台，默认取 process.platform */
  platform?: string
}

export interface UnreadBadgeController {
  /** 用最新未读数刷新角标（0 → 清除）；brand = 设置里的显示名 */
  refresh(count: number, brand: string): void
  /** 最近一次刷新的未读数（调试/测试用） */
  lastCount(): number
}

export function createUnreadBadgeController(deps: UnreadBadgeDeps): UnreadBadgeController {
  const platform = deps.platform ?? process.platform
  let last = -1

  return {
    lastCount: () => last,
    refresh(count: number, brand: string): void {
      const n = Math.max(0, Math.floor(Number(count) || 0))
      last = n
      const kind = badgeKind(n)
      // 1) 托盘 tooltip：Windows/macOS/Linux 都支持，且不依赖窗口是否存在
      try {
        deps.setTrayTooltip(badgeTooltip(brand, n))
      } catch {
        /* 托盘可能已销毁 */
      }
      // 2) macOS：dock 角标（Apple 支持数字角标）
      if (platform === 'darwin' && deps.setAppBadge) {
        try {
          deps.setAppBadge(n)
        } catch {
          /* ignore */
        }
      }
      // 3) Windows：任务栏 overlay 图标（1–9 / 9+ / 清除）
      const win = deps.getWindow()
      if (!win || (win.isDestroyed && win.isDestroyed())) return
      try {
        const icon = kind ? deps.createIcon(kind) : null
        win.setOverlayIcon(icon, badgeDescription(n))
      } catch {
        /* 任务栏 overlay 在部分环境不可用（如无窗口/远程桌面），不影响主流程 */
      }
    }
  }
}
