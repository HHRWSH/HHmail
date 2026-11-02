import { describe, expect, it, vi } from 'vitest'
import { createUpdateController, summarizeReleaseNotes, type UpdaterLike } from './update'
import type { UpdateState } from '../shared/update'

/** 假的 electron-updater：记录调用并允许手动触发事件 */
function makeFakeUpdater(): {
  updater: UpdaterLike
  calls: { check: number; download: number; install: number }
  fire: (event: string, payload?: unknown) => void
  autoDownload?: boolean
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const calls = { check: 0, download: 0, install: 0 }
  const updater: UpdaterLike & { autoDownload: boolean } = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return updater
    },
    async checkForUpdates() {
      calls.check += 1
      return null
    },
    async downloadUpdate() {
      calls.download += 1
      return null
    },
    quitAndInstall() {
      calls.install += 1
    }
  }
  return {
    updater,
    calls,
    fire: (event, payload) => {
      for (const cb of listeners.get(event) ?? []) cb(payload)
    }
  }
}

const makeController = (opts: { portable?: boolean } = {}) => {
  const fake = makeFakeUpdater()
  const states: UpdateState[] = []
  const controller = createUpdateController({
    appVersion: '1.1.0',
    getUpdater: () => fake.updater,
    emit: (s) => states.push(s),
    portable: opts.portable ?? false,
    now: () => 1_700_000_000_000,
    logger: { info: vi.fn(), warn: vi.fn() }
  })
  controller.attach()
  return { ...fake, controller, states }
}

describe('自动更新控制器 —— 事件 → 状态', () => {
  it('attach 后关闭自动下载、关闭预发布', () => {
    const { updater, controller } = makeController()
    controller.attach()
    expect(updater.autoDownload).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(true)
  })

  it('check：checking → 调用 checkForUpdates；update-available → available 带版本与说明', async () => {
    const { controller, calls, fire, states } = makeController()
    const p = controller.check(true)
    fire('checking-for-update')
    await p
    expect(calls.check).toBe(1)
    fire('update-available', { version: '1.2.0', releaseNotes: '修了三个 bug\n\n还有性能提升' })
    const last = states.at(-1)!
    expect(last).toMatchObject({ status: 'available', latestVersion: '1.2.0', portable: false })
    expect(last.notes).toContain('修了三个 bug')
    expect(controller.getState().status).toBe('available')
  })

  it('update-not-available → not-available', async () => {
    const { controller, fire, states } = makeController()
    await controller.check()
    fire('update-not-available')
    expect(states.at(-1)?.status).toBe('not-available')
    expect(controller.describe()).toContain('已是最新')
  })

  it('download-progress → downloading + 百分比夹紧到 0..100', async () => {
    const { controller, fire, states } = makeController()
    controller.getState()
    fire('download-progress', { percent: 42.6, transferred: 100, total: 200 })
    expect(states.at(-1)).toMatchObject({ status: 'downloading', progress: 42.6 })
    fire('download-progress', { percent: 180 })
    expect(states.at(-1)?.progress).toBe(100)
    fire('download-progress', { percent: -5 })
    expect(states.at(-1)?.progress).toBe(0)
  })

  it('error → error 状态 + 裁剪后的原因', async () => {
    const { controller, fire, states } = makeController()
    fire('error', new Error('net::ERR_CONNECTION_REFUSED https://api.github.com/repos/x/y?token=SECRET\nstack...'))
    const last = states.at(-1)!
    expect(last.status).toBe('error')
    expect(last.error).toContain('ERR_CONNECTION_REFUSED')
    expect(last.error).not.toContain('stack')
    expect(last.error!.length).toBeLessThanOrEqual(200)
  })

  it('download 只在 available 时执行；downloaded 后 install 调 quitAndInstall', async () => {
    const { controller, calls, fire } = makeController()
    await controller.check()
    // 没发现新版本 → download 不做事
    await controller.download()
    expect(calls.download).toBe(0)
    fire('update-available', { version: '1.2.0' })
    await controller.download()
    expect(calls.download).toBe(1)
    // 未下载完成 → install 不做事
    controller.install()
    expect(calls.install).toBe(0)
    fire('update-downloaded', { version: '1.2.0' })
    controller.install()
    expect(calls.install).toBe(1)
  })

  it('check 抛错 → error 状态（不抛出到调用方）', async () => {
    const fake = makeFakeUpdater()
    fake.updater.checkForUpdates = async () => {
      throw new Error('network down')
    }
    const states: UpdateState[] = []
    const c = createUpdateController({
      appVersion: '1.1.0',
      getUpdater: () => fake.updater,
      emit: (s) => states.push(s),
      portable: false,
      logger: { info: vi.fn(), warn: vi.fn() }
    })
    c.attach()
    await expect(c.check()).resolves.toMatchObject({ status: 'error' })
    expect(states.at(-1)?.error).toContain('network down')
  })
})

describe('自动更新控制器 —— portable 版', () => {
  it('attach 直接 unsupported，check 也不碰 updater', async () => {
    const fake = makeFakeUpdater()
    const states: UpdateState[] = []
    const c = createUpdateController({
      appVersion: '1.1.0',
      getUpdater: () => fake.updater,
      emit: (s) => states.push(s),
      portable: true,
      logger: { info: vi.fn(), warn: vi.fn() }
    })
    c.attach()
    expect(states.at(-1)?.status).toBe('unsupported')
    await c.check()
    expect(fake.calls.check).toBe(0)
    expect(c.describe()).toContain('便携版')
  })

  it('portable 版拒绝下载/安装', async () => {
    const fake = makeFakeUpdater()
    const c = createUpdateController({
      appVersion: '1.1.0',
      getUpdater: () => fake.updater,
      emit: () => undefined,
      portable: true,
      logger: { info: vi.fn(), warn: vi.fn() }
    })
    await c.download()
    c.install()
    expect(fake.calls.download).toBe(0)
    expect(fake.calls.install).toBe(0)
  })
})

describe('自动更新 —— release notes 摘要', () => {
  it('字符串直接裁剪', () => {
    expect(summarizeReleaseNotes('a\n\nb')).toBe('a\nb')
  })
  it('数组/对象形式', () => {
    expect(summarizeReleaseNotes([{ note: 'one' }, { note: 'two' }] as never)).toContain('one')
    expect(summarizeReleaseNotes({ note: 'obj' } as never)).toBe('obj')
  })
  it('空 → undefined；超长截断到 500', () => {
    expect(summarizeReleaseNotes(null)).toBeUndefined()
    expect(summarizeReleaseNotes('')).toBeUndefined()
    expect(summarizeReleaseNotes('x'.repeat(900))!.length).toBe(500)
  })
})
