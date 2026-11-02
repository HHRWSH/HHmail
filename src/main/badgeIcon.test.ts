import { describe, expect, it, vi } from 'vitest'
import { badgeIconDataUrl, encodePng, renderBadgeRgba } from './badgeIcon'
import { createUnreadBadgeController } from './unreadBadge'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('角标图标生成（纯 Node 画 PNG）', () => {
  it('encodePng 产出合法 PNG 头，IHDR 尺寸正确', () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(255)
    const png = encodePng(rgba, 4, 4)
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
    // IHDR 数据从第 16 字节开始（8 magic + 4 len + 4 type）
    expect(png.readUInt32BE(16)).toBe(4)
    expect(png.readUInt32BE(20)).toBe(4)
  })

  it('1–9 与 9+ 都能生成 data URL（且带缓存）', () => {
    const a = badgeIconDataUrl('3')
    expect(a.startsWith('data:image/png;base64,')).toBe(true)
    expect(badgeIconDataUrl('3')).toBe(a) // 缓存命中，字符串相同
    expect(badgeIconDataUrl('9plus')).not.toBe(a)
  })

  it('数字图与 9+ 图内容不同（不是同一张）', () => {
    const one = Buffer.from(badgeIconDataUrl('1').split(',')[1]!, 'base64')
    const ninePlus = Buffer.from(badgeIconDataUrl('9plus').split(',')[1]!, 'base64')
    expect(one.equals(ninePlus)).toBe(false)
    expect(one.length).toBeGreaterThan(100)
  })

  it('renderBadgeRgba 输出尺寸与像素量正确', () => {
    const px = renderBadgeRgba('5', 32)
    expect(px.length).toBe(32 * 32 * 4)
    // 圆底中心必须有颜色（不透明）
    const center = (16 * 32 + 16) * 4 + 3
    expect(px[center]).toBe(255)
    // 四角是透明（圆外）
    expect(px[3]).toBe(0)
  })
})

describe('未读角标控制器（注入假 window/tray）', () => {
  const makeDeps = (platform = 'win32') => {
    const calls = { overlay: [] as Array<{ icon: unknown; desc: string }>, tooltip: [] as string[], badge: [] as number[] }
    const win = { isDestroyed: () => false, setOverlayIcon: (icon: unknown, desc: string) => calls.overlay.push({ icon, desc }) }
    const deps = {
      getWindow: () => win,
      createIcon: (kind: string) => ({ kind }),
      setTrayTooltip: (t: string) => calls.tooltip.push(t),
      setAppBadge: (n: number) => calls.badge.push(n),
      platform
    }
    return { deps, calls }
  }

  it('未读 3 → overlay 图标是 "3"、描述与 tooltip 正确', () => {
    const { deps, calls } = makeDeps()
    const c = createUnreadBadgeController(deps)
    c.refresh(3, 'HHmail')
    expect(c.lastCount()).toBe(3)
    expect(calls.overlay.at(-1)).toMatchObject({ icon: { kind: '3' }, desc: '3 封未读邮件' })
    expect(calls.tooltip.at(-1)).toBe('HHmail · 3 封未读')
    expect(calls.badge).toHaveLength(0) // Windows 不设 dock badge
  })

  it('未读 ≥10 → 9+ 图标', () => {
    const { deps, calls } = makeDeps()
    createUnreadBadgeController(deps).refresh(42, 'HHmail')
    expect(calls.overlay.at(-1)).toMatchObject({ icon: { kind: '9plus' }, desc: '42 封未读邮件' })
    expect(calls.tooltip.at(-1)).toBe('HHmail · 42 封未读')
  })

  it('未读清零 → overlay 传 null 清除，tooltip 回到品牌名', () => {
    const { deps, calls } = makeDeps()
    const c = createUnreadBadgeController(deps)
    c.refresh(5, 'HHmail')
    c.refresh(0, 'HHmail')
    expect(calls.overlay.at(-1)).toMatchObject({ icon: null, desc: '没有未读邮件' })
    expect(calls.tooltip.at(-1)).toBe('HHmail')
  })

  it('macOS → 同时设置 dock badge', () => {
    const { deps, calls } = makeDeps('darwin')
    createUnreadBadgeController(deps).refresh(7, 'HHmail')
    expect(calls.badge.at(-1)).toBe(7)
    expect(calls.overlay.at(-1)).toMatchObject({ icon: { kind: '7' } })
  })

  it('窗口已销毁 / 不存在时不崩（只刷新 tooltip）', () => {
    const calls: string[] = []
    const c = createUnreadBadgeController({
      getWindow: () => null,
      createIcon: () => ({}),
      setTrayTooltip: (t) => calls.push(t),
      platform: 'win32'
    })
    expect(() => c.refresh(2, 'HHmail')).not.toThrow()
    expect(calls.at(-1)).toBe('HHmail · 2 封未读')
  })

  it('setOverlayIcon 抛错（远程桌面等不支持 overlay）时不影响 tooltip', () => {
    const tooltip = vi.fn()
    const c = createUnreadBadgeController({
      getWindow: () => ({
        isDestroyed: () => false,
        setOverlayIcon: () => {
          throw new Error('not supported')
        }
      }),
      createIcon: () => ({}),
      setTrayTooltip: tooltip,
      platform: 'win32'
    })
    expect(() => c.refresh(4, 'HHmail')).not.toThrow()
    expect(tooltip).toHaveBeenCalledWith('HHmail · 4 封未读')
  })
})
