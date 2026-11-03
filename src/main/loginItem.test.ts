import { describe, expect, it, vi } from 'vitest'
import { applyLoginItem, isHiddenStart, loginItemOptions } from './loginItem'

describe('开机自动启动（V2.4）', () => {
  it('开启时：Windows 用 --hidden 参数、macOS 用 openAsHidden', () => {
    expect(loginItemOptions(true, 'win32')).toEqual({ openAtLogin: true, args: ['--hidden'] })
    expect(loginItemOptions(true, 'darwin')).toEqual({ openAtLogin: true, openAsHidden: true })
  })

  it('关闭时只传 openAtLogin: false', () => {
    expect(loginItemOptions(false, 'win32')).toEqual({ openAtLogin: false })
    expect(loginItemOptions(false, 'darwin')).toEqual({ openAtLogin: false })
  })

  it('applyLoginItem 调用一次 setter 并返回参数', () => {
    const setter = vi.fn()
    const opts = applyLoginItem(true, setter, 'win32')
    expect(setter).toHaveBeenCalledTimes(1)
    expect(setter).toHaveBeenCalledWith({ openAtLogin: true, args: ['--hidden'] })
    expect(opts.openAtLogin).toBe(true)
  })

  it('setter 抛错（平台不支持/无权限）不冒泡', () => {
    const setter = vi.fn(() => {
      throw new Error('not supported')
    })
    expect(() => applyLoginItem(true, setter, 'linux')).not.toThrow()
  })

  it('isHiddenStart 识别 --hidden', () => {
    expect(isHiddenStart(['electron', '--hidden'])).toBe(true)
    expect(isHiddenStart(['electron'])).toBe(false)
    expect(isHiddenStart([])).toBe(false)
  })
})
