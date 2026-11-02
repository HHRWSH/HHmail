import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  describeUpdateState,
  isNewerVersion,
  isPortableBuild,
  parseVersion,
  updatePrimaryAction,
  type UpdateState
} from './update'

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: 'idle',
  currentVersion: '1.1.0',
  portable: false,
  ...over
})

describe('自动更新 —— 版本解析与比较', () => {
  it('解析语义化版本（含 v 前缀与预发布）', () => {
    expect(parseVersion('1.2.3')).toEqual({ nums: [1, 2, 3], prerelease: null })
    expect(parseVersion('v2.0')).toEqual({ nums: [2, 0], prerelease: null })
    expect(parseVersion('1.2.3-beta.1')).toEqual({ nums: [1, 2, 3], prerelease: 'beta.1' })
    expect(parseVersion('1.2.3+build')).toEqual({ nums: [1, 2, 3], prerelease: null })
  })

  it('非法版本返回 null', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('abc')).toBeNull()
    expect(parseVersion('1.2.x')).toBeNull()
  })

  it('逐段比较数字（缺省补 0）', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.1', '1.1.0')).toBe(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
  })

  it('预发布小于同号正式版', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(-1)
    expect(compareVersions('1.2.3', '1.2.3-beta.1')).toBe(1)
    expect(compareVersions('1.2.3-beta.1', '1.2.3-beta.2')).toBe(-1)
    expect(compareVersions('1.2.3-beta.1', '1.2.3-beta.1')).toBe(0)
  })

  it('无法解析按相等处理（不更新）', () => {
    expect(compareVersions('abc', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '')).toBe(0)
  })

  it('isNewerVersion：只有严格更新才算有更新', () => {
    expect(isNewerVersion('1.1.0', '1.2.0')).toBe(true)
    expect(isNewerVersion('1.1.0', '1.1.0')).toBe(false)
    expect(isNewerVersion('1.2.0', '1.1.0')).toBe(false)
    expect(isNewerVersion('1.1.0', 'v1.1.0')).toBe(false)
    expect(isNewerVersion('1.1.0', ''));
    // 非法版本不升级（避免误升）
    expect(isNewerVersion('1.1.0', 'abc')).toBe(false)
  })
})

describe('自动更新 —— portable 判定', () => {
  it('有 PORTABLE_EXECUTABLE_DIR → portable', () => {
    expect(isPortableBuild({ PORTABLE_EXECUTABLE_DIR: 'C:\\Users\\x\\Downloads' })).toBe(true)
  })

  it('没有/空值 → 安装版', () => {
    expect(isPortableBuild({})).toBe(false)
    expect(isPortableBuild({ PORTABLE_EXECUTABLE_DIR: '  ' })).toBe(false)
  })
})

describe('自动更新 —— 状态文案与主按钮', () => {
  it('各状态文案', () => {
    expect(describeUpdateState(state({ status: 'checking' }))).toContain('正在检查')
    expect(describeUpdateState(state({ status: 'available', latestVersion: '1.2.0' }))).toContain('1.2.0')
    expect(describeUpdateState(state({ status: 'not-available' }))).toContain('已是最新')
    expect(describeUpdateState(state({ status: 'downloading', progress: 42 }))).toContain('42%')
    expect(describeUpdateState(state({ status: 'downloaded', latestVersion: '1.2.0' }))).toContain('重启')
    expect(describeUpdateState(state({ status: 'error', error: '网络不通' }))).toContain('网络不通')
    expect(describeUpdateState(state({ status: 'unsupported' }))).toContain('便携版')
  })

  it('主按钮随状态变化', () => {
    expect(updatePrimaryAction(state({ status: 'available' }))).toMatchObject({ kind: 'download' })
    expect(updatePrimaryAction(state({ status: 'downloaded' }))).toMatchObject({ kind: 'install' })
    expect(updatePrimaryAction(state({ status: 'downloading' }))).toMatchObject({ kind: null })
    expect(updatePrimaryAction(state({ status: 'not-available' }))).toMatchObject({ kind: 'recheck' })
  })

  it('portable 版不提供下载/安装，只提示手动下载', () => {
    const action = updatePrimaryAction(state({ portable: true, status: 'available', latestVersion: '1.2.0' }))
    expect(action.kind).toBe('recheck')
    expect(action.label).toContain('手动下载')
  })
})
