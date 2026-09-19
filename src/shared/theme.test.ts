import { describe, expect, it } from 'vitest'
import { DENSITY_LABEL, THEME_LABEL, densityTokens, resolveTheme } from './theme'

describe('theme —— 主题解析（跟随系统 / 浅色 / 深色）', () => {
  it('显式选择优先于系统', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('跟随系统（含未设置时的默认）', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme(undefined, true)).toBe('dark')
    expect(resolveTheme(undefined, false)).toBe('light')
  })

  it('标签兜底（设置里存了非法值时也能显示）', () => {
    expect(THEME_LABEL('dark')).toBe('深色')
    expect(THEME_LABEL(undefined)).toBe('跟随系统')
    expect(DENSITY_LABEL('compact')).toBe('紧凑')
    expect(DENSITY_LABEL(undefined)).toBe('标准')
  })
})

describe('densityTokens —— 密度影响行高与字号', () => {
  it('三档密度各不相同且紧凑 < 标准 < 宽松', () => {
    const compact = densityTokens('compact')
    const standard = densityTokens('standard')
    const relaxed = densityTokens('relaxed')
    expect(Number.parseFloat(compact.rowH)).toBeLessThan(Number.parseFloat(standard.rowH))
    expect(Number.parseFloat(standard.rowH)).toBeLessThan(Number.parseFloat(relaxed.rowH))
    expect(Number.parseFloat(compact.font)).toBeLessThan(Number.parseFloat(relaxed.font))
  })

  it('未知值回退标准', () => {
    expect(densityTokens(undefined)).toEqual(densityTokens('standard'))
  })
})
