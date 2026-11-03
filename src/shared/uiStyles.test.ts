import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_STYLE, UI_STYLES, isUiStyle, normalizeUiStyle, uiStyleMeta } from './uiStyles'

describe('视觉风格预设（V2.6）', () => {
  it('默认是 apple', () => {
    expect(DEFAULT_UI_STYLE).toBe('apple')
  })

  it('5 套预设都有 label/desc/色块', () => {
    expect(UI_STYLES).toHaveLength(5)
    for (const s of UI_STYLES) {
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.desc.length).toBeGreaterThan(0)
      expect(s.swatch).toHaveLength(3)
    }
    expect(UI_STYLES.map((s) => s.id)).toEqual(['apple', 'linear', 'notion', 'paper', 'glass'])
  })

  it('isUiStyle 只认预设 id', () => {
    for (const s of UI_STYLES) expect(isUiStyle(s.id)).toBe(true)
    expect(isUiStyle('apple ')).toBe(false)
    expect(isUiStyle('')).toBe(false)
    expect(isUiStyle(null)).toBe(false)
    expect(isUiStyle('rounded')).toBe(false)
  })

  it('normalizeUiStyle 容错回退默认', () => {
    expect(normalizeUiStyle('linear')).toBe('linear')
    expect(normalizeUiStyle('unknown')).toBe('apple')
    expect(normalizeUiStyle(undefined)).toBe('apple')
  })

  it('uiStyleMeta 找不到时回退第一套', () => {
    expect(uiStyleMeta('notion').id).toBe('notion')
    expect(uiStyleMeta(null).id).toBe('apple')
    expect(uiStyleMeta('nope').id).toBe('apple')
  })
})
