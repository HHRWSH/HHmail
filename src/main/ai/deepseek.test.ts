import { describe, expect, it } from 'vitest'
import { DeepSeekAiProvider, type ChatCompletionsClient, type DeepSeekConfig } from './deepseek'
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from '../config'

function fakeClient(opts: { reply?: string; failWith?: Error; onPayload?: (p: unknown) => void } = {}): ChatCompletionsClient {
  return {
    chat: {
      completions: {
        create: async (payload) => {
          opts.onPayload?.(payload)
          if (opts.failWith) throw opts.failWith
          return { choices: [{ message: { content: 'reply' in opts ? opts.reply : '你好' } }] }
        }
      }
    }
  }
}

describe('DeepSeekAiProvider（openai SDK 不直接进入测试，注入 fake client）', () => {
  it('baseURL 指向 https://api.deepseek.com，默认模型 deepseek-flash', async () => {
    const received: { cfg: DeepSeekConfig | null } = { cfg: null }
    const provider = new DeepSeekAiProvider({
      getConfig: async () => ({ apiKey: 'sk-test', baseUrl: DEEPSEEK_BASE_URL, model: DEEPSEEK_MODEL }),
      factory: (cfg) => {
        received.cfg = cfg
        return fakeClient()
      }
    })
    const text = await provider.complete({ system: 's', user: 'u' })
    expect(text).toBe('你好')
    expect(received.cfg?.apiKey).toBe('sk-test')
    expect(received.cfg?.baseUrl).toBe('https://api.deepseek.com')
    expect(provider.modelName()).toBe(DEEPSEEK_MODEL)
  })

  it('请求体包含 system/user/温度/最大 token 与 v4 模型名', async () => {
    const holder: {
      payload: {
        model?: string
        messages?: { role: string; content: string }[]
        temperature?: number
        max_tokens?: number
      } | null
    } = { payload: null }
    const provider = new DeepSeekAiProvider({
      getConfig: async () => ({ apiKey: 'sk-test' }),
      factory: () => fakeClient({ onPayload: (p) => (holder.payload = p as typeof holder.payload) })
    })
    await provider.complete({ system: 'sys', user: 'usr', temperature: 0.2, maxTokens: 800 })
    expect(holder.payload?.model).toBe(DEEPSEEK_MODEL)
    expect(holder.payload?.messages?.map((m) => m.role)).toEqual(['system', 'user'])
    expect(holder.payload?.temperature).toBe(0.2)
    expect(holder.payload?.max_tokens).toBe(800)
  })

  it('弃用模型名（deepseek-chat / deepseek-reasoner）被拒绝', async () => {
    const provider = new DeepSeekAiProvider({
      getConfig: async () => ({ apiKey: 'sk-test', model: 'deepseek-chat' }),
      factory: () => fakeClient()
    })
    await expect(provider.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('V2.2：DeepSeek 只放行 deepseek-flash（其余 DeepSeek 模型与下线名字都被拒绝）', async () => {
    const ok = new DeepSeekAiProvider({
      getConfig: async () => ({ apiKey: 'sk-test', model: 'deepseek-flash' }),
      factory: () => fakeClient()
    })
    await expect(ok.complete({ system: 's', user: 'u' })).resolves.toBe('你好')
    expect(ok.modelName()).toBe('deepseek-flash')

    // 用户要求下线 DeepSeek 的其它模型
    for (const gone of ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      const legacy = new DeepSeekAiProvider({
        getConfig: async () => ({ apiKey: 'sk-test', model: gone, providerId: 'deepseek' }),
        factory: () => fakeClient()
      })
      await expect(legacy.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    // 已下线/内测的模型名不再放行（设置层会自动回落到官方默认，不会走到这里）
    for (const gone of ['deepseek-v4.1', 'deepseek-v4.1-flash']) {
      const legacy = new DeepSeekAiProvider({
        getConfig: async () => ({ apiKey: 'sk-test', model: gone }),
        factory: () => fakeClient()
      })
      await expect(legacy.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
  })

  it('切换服务商/模型立即生效：重建客户端并使用新模型（修复旧模型被缓存的 bug）', async () => {
    const holder: { factoryCalls: number; models: (string | undefined)[]; bases?: (string | undefined)[] } = {
      factoryCalls: 0,
      models: []
    }
    let currentModel = 'deepseek-flash'
    let currentProvider = 'deepseek'
    const provider = new DeepSeekAiProvider({
      getConfig: async () => ({ apiKey: 'sk-test', model: currentModel, providerId: currentProvider }),
      factory: (cfg) => {
        holder.factoryCalls += 1
        holder.bases = holder.bases ?? []
        holder.bases.push(cfg.baseUrl)
        return fakeClient({ onPayload: (p) => holder.models.push((p as { model?: string }).model) })
      }
    })
    await provider.complete({ system: 's', user: 'u' })
    expect(holder.models[0]).toBe('deepseek-flash')
    // 切到智谱：换服务商 → 重建客户端 + 换模型 + 换 Base URL
    currentProvider = 'zhipu'
    currentModel = 'glm-4-flash'
    await provider.complete({ system: 's', user: 'u' })
    expect(holder.factoryCalls).toBe(2)
    expect(holder.models[1]).toBe('glm-4-flash')
    // Base URL 由设置层（resolveBaseUrl）给出，这里只验证模型与重建行为
    expect(provider.modelName()).toBe('glm-4-flash')
  })

  it('429 → AI_RATE_LIMIT；其他错误 → AI_FAILED', async () => {
    const rate = new DeepSeekAiProvider({
      getConfig: async () => ({ apiKey: 'sk-test' }),
      factory: () => fakeClient({ failWith: new Error('429 rate limit exceeded') })
    })
    await expect(rate.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'AI_RATE_LIMIT' })

    const other = new DeepSeekAiProvider({
      getConfig: async () => ({ apiKey: 'sk-test' }),
      factory: () => fakeClient({ failWith: new Error('connection refused') })
    })
    await expect(other.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'AI_FAILED' })
  })

  it('空 choices → 返回空串而不抛错', async () => {
    const provider = new DeepSeekAiProvider({
      getConfig: async () => ({ apiKey: 'sk-test' }),
      factory: () => fakeClient({ reply: undefined })
    })
    expect(await provider.complete({ system: 's', user: 'u' })).toBe('')
  })
})
