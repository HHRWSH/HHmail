import { describe, expect, it } from 'vitest'
import {
  formatDndWindow,
  isInDndWindow,
  localMinutes,
  parseHhMm,
  shouldShowSystemNotification
} from './dnd'

/** 构造「本地时间」的 Date（用本地时区构造，测的是本地时区语义） */
const at = (h: number, mi = 0): number => new Date(2026, 8, 16, h, mi, 0, 0).getTime()

describe('免打扰 —— 时间解析', () => {
  it('HH:mm 解析成分钟数', () => {
    expect(parseHhMm('00:00')).toBe(0)
    expect(parseHhMm('23:00')).toBe(23 * 60)
    expect(parseHhMm('8:05')).toBe(8 * 60 + 5)
  })

  it('非法输入返回 null', () => {
    expect(parseHhMm('')).toBeNull()
    expect(parseHhMm('24:00')).toBeNull()
    expect(parseHhMm('12:60')).toBeNull()
    expect(parseHhMm('abc')).toBeNull()
    expect(parseHhMm(undefined)).toBeNull()
  })

  it('localMinutes 用本地时区', () => {
    expect(localMinutes(at(9, 30))).toBe(9 * 60 + 30)
    expect(localMinutes(at(0, 0))).toBe(0)
  })
})

describe('免打扰 —— 窗口判断（同一天）', () => {
  it('09:00–12:00：起点包含、终点不含', () => {
    expect(isInDndWindow(at(9, 0), '09:00', '12:00')).toBe(true)
    expect(isInDndWindow(at(10, 30), '09:00', '12:00')).toBe(true)
    expect(isInDndWindow(at(11, 59), '09:00', '12:00')).toBe(true)
    expect(isInDndWindow(at(12, 0), '09:00', '12:00')).toBe(false) // 终点不含
    expect(isInDndWindow(at(8, 59), '09:00', '12:00')).toBe(false)
  })
})

describe('免打扰 —— 跨午夜（23:00–08:00）', () => {
  it('23:00 起生效、凌晨到 07:59 有效、08:00 解除', () => {
    expect(isInDndWindow(at(23, 0), '23:00', '08:00')).toBe(true)
    expect(isInDndWindow(at(23, 59), '23:00', '08:00')).toBe(true)
    expect(isInDndWindow(at(0, 0), '23:00', '08:00')).toBe(true)
    expect(isInDndWindow(at(7, 59), '23:00', '08:00')).toBe(true)
    expect(isInDndWindow(at(8, 0), '23:00', '08:00')).toBe(false)
    expect(isInDndWindow(at(22, 59), '23:00', '08:00')).toBe(false)
    // 中午当然不在窗口
    expect(isInDndWindow(at(12, 0), '23:00', '08:00')).toBe(false)
  })

  it('极窄跨午夜窗口（23:59–00:01）边界正确', () => {
    expect(isInDndWindow(at(23, 59), '23:59', '00:01')).toBe(true)
    expect(isInDndWindow(at(0, 0), '23:59', '00:01')).toBe(true)
    expect(isInDndWindow(at(0, 1), '23:59', '00:01')).toBe(false)
    expect(isInDndWindow(at(23, 58), '23:59', '00:01')).toBe(false)
  })
})

describe('免打扰 —— 非法/边界配置', () => {
  it('起止相同 → 视为未启用', () => {
    expect(isInDndWindow(at(10, 0), '10:00', '10:00')).toBe(false)
    expect(formatDndWindow('10:00', '10:00')).toContain('未启用')
  })

  it('非法时间 → 不当作免打扰（宁可多提醒也不静默吞通知）', () => {
    expect(isInDndWindow(at(10, 0), 'abc', '12:00')).toBe(false)
    expect(isInDndWindow(at(10, 0), '09:00', '')).toBe(false)
    expect(formatDndWindow('abc', '12:00')).toBe('未设置')
  })

  it('窗口展示文案', () => {
    expect(formatDndWindow('09:00', '12:00')).toBe('09:00 – 12:00')
    expect(formatDndWindow('23:00', '08:00')).toBe('23:00 – 次日 08:00')
  })
})

describe('免打扰 —— 是否弹系统通知（通知策略统一入口）', () => {
  const base = { nowMs: at(10, 0) }

  it('用户手动触发 → 不弹（无论免打扰与否）', () => {
    expect(shouldShowSystemNotification({ ...base, reason: 'manual-sync' })).toBe(false)
    expect(shouldShowSystemNotification({ ...base, reason: 'manual', dndEnabled: false })).toBe(false)
  })

  it('后台同步 + 免打扰窗口内 → 不弹', () => {
    expect(
      shouldShowSystemNotification({ ...base, reason: 'interval', dndEnabled: true, dndStart: '09:00', dndEnd: '12:00' })
    ).toBe(false)
  })

  it('后台同步 + 免打扰关闭 / 不在窗口 → 弹', () => {
    expect(shouldShowSystemNotification({ ...base, reason: 'interval', dndEnabled: false, dndStart: '09:00', dndEnd: '12:00' })).toBe(true)
    expect(
      shouldShowSystemNotification({ ...base, reason: 'interval', dndEnabled: true, dndStart: '13:00', dndEnd: '14:00' })
    ).toBe(true)
  })
})
