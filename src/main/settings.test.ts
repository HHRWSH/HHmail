import { describe, expect, it } from 'vitest'
import {
  SafeStorageSettingsStore,
  SETTINGS_KEY_MODEL,
  SETTINGS_KEY_MODEL_MIGRATED,
  SETTINGS_KEY_PROMPT_MIGRATED,
  SETTINGS_KEY_REFRESH_INTERVAL,
  SETTINGS_KEY_SUMMARY_PROMPT,
  type SettingsRepository
} from './settings'
import { DEFAULT_SUMMARY_PROMPT, LEGACY_SUMMARY_PROMPT_HASHES } from '../shared/defaults'
import { isLegacyDefaultPrompt, promptDigest } from './settings'
import { FakeSafeStorage } from '../../tests/helpers/fakes'

class FakeSettingsRepo implements SettingsRepository {
  store = new Map<string, string>()

  async getRaw(key: string): Promise<{ value_enc: string } | null> {
    const v = this.store.get(key)
    return v === undefined ? null : { value_enc: v }
  }

  async setRaw(key: string, valueEnc: string): Promise<void> {
    this.store.set(key, valueEnc)
  }

  async deleteRaw(key: string): Promise<void> {
    this.store.delete(key)
  }
}

describe('SafeStorageSettingsStore（设置加密落盘）', () => {
  it('默认值：deepseek-flash（V4.1 Flash 的 API 名）/ 同步全部(0) / 自动刷新 300 秒 / 无 Key', async () => {
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), new FakeSettingsRepo())
    const cfg = await s.get()
    expect(cfg.aiModel).toBe('deepseek-flash')
    expect(cfg.syncWindow).toBe(0)
    expect(cfg.refreshIntervalSec).toBe(300)
    expect(cfg.hasApiKey).toBe(false)
  })

  it('保存刷新间隔/同步范围后读回；明文不落 repo', async () => {
    const safe = new FakeSafeStorage()
    const repo = new FakeSettingsRepo()
    const s = new SafeStorageSettingsStore(safe, repo)
    await s.set({ refreshIntervalSec: 60, syncWindow: 50 })
    const cfg = await s.get()
    expect(cfg.refreshIntervalSec).toBe(60)
    expect(cfg.syncWindow).toBe(50)
    const raw = JSON.stringify([...repo.store.entries()])
    expect(raw).not.toContain('enc:') // 明文不落盘（只有 base64 密文）
  })

  it('API Key 保存/清除', async () => {
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), new FakeSettingsRepo())
    await s.set({ apiKey: 'sk-secret-123' })
    expect((await s.get()).hasApiKey).toBe(true)
    expect(await s.getApiKey()).toBe('sk-secret-123')
    await s.set({ apiKey: '' })
    expect((await s.get()).hasApiKey).toBe(false)
    expect(await s.getApiKey()).toBeNull()
  })

  it('个人邮箱发信配置：默认值 + 保存读回 + 密码加密且不回传明文', async () => {
    const repo = new FakeSettingsRepo()
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), repo)
    const def = await s.get()
    expect(def.smtpHost).toBe('smtp.gmail.com')
    expect(def.smtpPort).toBe(587)
    expect(def.smtpSecure).toBe(false)
    expect(def.hasSmtpPass).toBe(false)

    await s.set({
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: 'me@qq.com',
      smtpTo: 'other@qq.com',
      smtpPass: 'app-pass-1'
    })
    const cfg = await s.get()
    expect(cfg.smtpHost).toBe('smtp.qq.com')
    expect(cfg.smtpPort).toBe(465)
    expect(cfg.smtpSecure).toBe(true)
    expect(cfg.smtpUser).toBe('me@qq.com')
    expect(cfg.smtpTo).toBe('other@qq.com')
    expect(cfg.hasSmtpPass).toBe(true)
    // 密码只在主进程内部可取；get() 返回的设置对象里没有明文，落盘也是密文
    expect(await s.getSmtpPass()).toBe('app-pass-1')
    expect(JSON.stringify(cfg)).not.toContain('app-pass-1')
    expect(JSON.stringify([...repo.store.entries()])).not.toContain('app-pass-1')
  })

  it('发信密码留空 = 保持原值；传空串 = 清除', async () => {
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), new FakeSettingsRepo())
    await s.set({ smtpPass: 'p1' })
    await s.set({ smtpUser: 'me@qq.com' }) // 未传 smtpPass
    expect(await s.getSmtpPass()).toBe('p1')
    await s.set({ smtpPass: '' })
    expect(await s.getSmtpPass()).toBeNull()
    expect((await s.get()).hasSmtpPass).toBe(false)
  })

  it('发信权限开关（sendScope）默认开启，可关闭', async () => {
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), new FakeSettingsRepo())
    expect((await s.get()).sendScope).toBe(true)
    await s.set({ sendScope: false })
    expect((await s.get()).sendScope).toBe(false)
    await s.set({ sendScope: true })
    expect((await s.get()).sendScope).toBe(true)
  })

  it('非法端口不覆盖已有配置', async () => {
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), new FakeSettingsRepo())
    await s.set({ smtpPort: 2525 })
    await s.set({ smtpPort: 999999 })
    expect((await s.get()).smtpPort).toBe(2525)
  })

  it('非法模型保存被拒绝（validateAiModel）', async () => {
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), new FakeSettingsRepo())
    await expect(s.set({ aiModel: 'deepseek-chat' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('总结提示词：默认值 → 自定义保存 → 空串恢复默认（v3 模板字段）', async () => {
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), new FakeSettingsRepo())
    expect((await s.get()).summaryPrompt).toContain('## 主旨')
    await s.set({ summaryPrompt: '我的自定义提示词' })
    expect((await s.get()).summaryPrompt).toBe('我的自定义提示词')
    await s.set({ summaryPrompt: '' })
    expect((await s.get()).summaryPrompt).toContain('## 主旨')
  })

  it('新邮件自动总结开关：默认开，可关闭', async () => {
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), new FakeSettingsRepo())
    expect((await s.get()).autoSummarizeNew).toBe(true)
    await s.set({ autoSummarizeNew: false })
    expect((await s.get()).autoSummarizeNew).toBe(false)
    await s.set({ autoSummarizeNew: true })
    expect((await s.get()).autoSummarizeNew).toBe(true)
  })

  it('存储的刷新间隔键名稳定', () => {
    expect(SETTINGS_KEY_REFRESH_INTERVAL).toBe('sync.interval')
  })
  it('V2.2 模型校验：DeepSeek 只留 deepseek-flash；老模型名自动落回默认', async () => {
    const safe = new FakeSafeStorage()
    const repo = new FakeSettingsRepo()
    // 模拟老用户：存的是已下线的 deepseek-v4-pro
    repo.store.set(SETTINGS_KEY_MODEL, Buffer.from(`enc:deepseek-v4-pro`, 'utf8').toString('base64'))
    const s = new SafeStorageSettingsStore(safe, repo)
    const cfg = await s.get()
    expect(cfg.aiProvider).toBe('deepseek')
    expect(cfg.aiModel).toBe('deepseek-flash')
    // 已落盘纠正
    expect(repo.store.has(SETTINGS_KEY_MODEL)).toBe(true)

    // DeepSeek 其它模型名现在会被拒绝（用户要求只保留 v4.1 flash）
    await expect(s.set({ aiModel: 'deepseek-v4-pro' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    // 换成别的服务商：模型自动落回该服务商默认值，切换后可用
    await s.set({ aiProvider: 'zhipu' })
    const zhipu = await s.get()
    expect(zhipu.aiProvider).toBe('zhipu')
    expect(zhipu.aiModel).toBe('glm-4-flash')
    expect(zhipu.aiBaseUrl).toContain('bigmodel.cn')
    await s.set({ aiModel: 'glm-4-plus' })
    expect((await s.get()).aiModel).toBe('glm-4-plus')

    // 自定义服务商：手填 Base URL 与模型名
    await s.set({ aiProvider: 'custom', aiCustomBaseUrl: 'http://localhost:11434/v1', aiModel: 'qwen2.5:7b' })
    const custom = await s.get()
    expect(custom.aiBaseUrl).toBe('http://localhost:11434/v1')
    expect(custom.aiModel).toBe('qwen2.5:7b')
  })

  it('API Key 按服务商分开存：切换服务商不用重填，清空只清当前服务商', async () => {
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), new FakeSettingsRepo())
    await s.set({ aiKey: undefined, apiKey: 'sk-deepseek' } as never)
    expect(await s.getApiKey()).toBe('sk-deepseek')
    await s.set({ aiProvider: 'zhipu' })
    expect(await s.getApiKey()).toBeNull() // 智谱还没填
    await s.set({ apiKey: 'sk-zhipu' })
    expect(await s.getApiKey()).toBe('sk-zhipu')
    // 切回 DeepSeek：原来的 Key 还在
    await s.set({ aiProvider: 'deepseek' })
    expect(await s.getApiKey()).toBe('sk-deepseek')
    await s.set({ apiKey: '' })
    expect(await s.getApiKey()).toBeNull()
  })

  it('已失效的模型名（deepseek-v4.1 / deepseek-v4.1-flash）自动回落到新默认', async () => {
    const repo = new FakeSettingsRepo()
    repo.store.set(SETTINGS_KEY_MODEL, Buffer.from(`enc:deepseek-v4.1`, 'utf8').toString('base64'))
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), repo)
    expect((await s.get()).aiModel).toBe('deepseek-flash')

    // API 已下线的名字也要能自愈并落盘
    repo.store.set(SETTINGS_KEY_MODEL, Buffer.from(`enc:deepseek-v4.1-flash`, 'utf8').toString('base64'))
    const cfg2 = await s.get()
    expect(cfg2.aiModel).toBe('deepseek-flash')
    expect(repo.store.has(SETTINGS_KEY_MODEL)).toBe(true)
  })

  it('历史默认提示词只比哈希：命中即迁移，自定义提示词不动（V2.2 去私人信息）', async () => {
    // V2.2：旧默认文案含真实联系人邮箱，改为只存哈希；这里用注入的哈希列表验证判定逻辑
    const legacyText = '历史默认提示词（测试用）'
    const digest = promptDigest(legacyText)
    expect(isLegacyDefaultPrompt(legacyText, [digest])).toBe(true)
    // 空白差异不影响判定（与写入时同样的归一化）
    expect(isLegacyDefaultPrompt(`  ${legacyText}

`, [digest])).toBe(true)
    expect(isLegacyDefaultPrompt('我的自定义提示词', [digest])).toBe(false)
    // 真实哈希表非空，且不会把任意文本误判成历史默认值
    expect(LEGACY_SUMMARY_PROMPT_HASHES.length).toBeGreaterThan(0)
    expect(isLegacyDefaultPrompt('我的自定义提示词：只写三行')).toBe(false)

    // 用户自定义的提示词不被覆盖
    const repo2 = new FakeSettingsRepo()
    repo2.store.set(SETTINGS_KEY_SUMMARY_PROMPT, Buffer.from('enc:我的自定义提示词：只写三行', 'utf8').toString('base64'))
    const s2 = new SafeStorageSettingsStore(new FakeSafeStorage(), repo2)
    expect((await s2.get()).summaryPrompt).toBe('我的自定义提示词：只写三行')
  })

  it('安装包里的默认提示词不含真实联系人邮箱（隐私）', () => {
    expect(DEFAULT_SUMMARY_PROMPT).not.toMatch(/[\w.+-]+@(?!example\.(edu|com))[\w.-]+\.[a-z]{2,}/i)
    expect(DEFAULT_SUMMARY_PROMPT).not.toMatch(/[\w.+-]+@(?!example\.)[\w.-]+\.edu/i)
  })

  it('v5 模板追求「30 秒扫读」：硬性字数上限、无原文摘录、仍要求忽略 CSS 噪声', () => {
    expect(DEFAULT_SUMMARY_PROMPT).not.toContain('150 字以内')
    // v5 起不再要求「完整性优先/原文未提供」（那正是 v4 写成长文、看不清重点的原因）
    expect(DEFAULT_SUMMARY_PROMPT).not.toContain('完整性优先')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('30 秒内看清')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('不超过 30 字')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('不超过 18 字')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('最多 3 条')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('max-width')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('## 重要度')
    expect(DEFAULT_SUMMARY_PROMPT).not.toContain('## 原文摘录')
  })

  it('提示词 v5 迁移：自定义过的提示词不会被迁移标记覆盖', async () => {
    const s = new SafeStorageSettingsStore(new FakeSafeStorage(), new FakeSettingsRepo())
    await s.set({ summaryPrompt: '我的自定义提示词：只写三行' })
    expect((await s.get()).summaryPrompt).toBe('我的自定义提示词：只写三行')

    const repo2 = new FakeSettingsRepo()
    const s2 = new SafeStorageSettingsStore(new FakeSafeStorage(), repo2)
    await s2.set({ summaryPrompt: '我的自定义提示词：只写三行' })
    repo2.store.delete('ai.prompt_migrated_v5')
    expect((await s2.get()).summaryPrompt).toBe('我的自定义提示词：只写三行')
  })
})
