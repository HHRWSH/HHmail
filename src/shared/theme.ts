/**
 * 外观（主题 / 密度）—— 纯函数，便于单测与在渲染端任何地方复用。
 *
 * V2.2 通用化：不再绑定任何学校；主题支持 跟随系统 / 浅色 / 深色，密度影响列表行高与字号。
 */
import type { ThemeMode, UiDensity } from './types'

export type ResolvedTheme = 'light' | 'dark'

/** 把「跟随系统」解析成实际主题。 */
export function resolveTheme(mode: ThemeMode | undefined, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return 'light'
  return systemPrefersDark ? 'dark' : 'light'
}

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; hint?: string }> = [
  { value: 'system', label: '跟随系统', hint: '按 Windows 的浅色/深色设置自动切换' },
  { value: 'light', label: '浅色', hint: '始终使用浅色主题' },
  { value: 'dark', label: '深色', hint: '始终使用深色主题（夜间护眼）' }
]

export const DENSITY_OPTIONS: Array<{ value: UiDensity; label: string; hint?: string }> = [
  { value: 'compact', label: '紧凑', hint: '一屏看更多邮件（行高与字号更小）' },
  { value: 'standard', label: '标准', hint: '默认' },
  { value: 'relaxed', label: '宽松', hint: '行高与字号更大，适合高分屏' }
]

export const THEME_LABEL = (mode: ThemeMode | undefined): string =>
  THEME_OPTIONS.find((o) => o.value === (mode ?? 'system'))?.label ?? '跟随系统'

export const DENSITY_LABEL = (density: UiDensity | undefined): string =>
  DENSITY_OPTIONS.find((o) => o.value === (density ?? 'standard'))?.label ?? '标准'

/** 外观设置 → CSS 变量值（渲染端用；集中一处便于测试与调参）。 */
export interface DensityTokens {
  /** 列表行最小高度 */
  rowH: string
  /** 正文字号 */
  font: string
  /** 列表项上下内边距 */
  padY: string
}

export function densityTokens(density: UiDensity | undefined): DensityTokens {
  switch (density) {
    case 'compact':
      return { rowH: '56px', font: '12.4px', padY: '5px' }
    case 'relaxed':
      return { rowH: '82px', font: '14px', padY: '11px' }
    default:
      return { rowH: '68px', font: '13px', padY: '8px' }
  }
}
