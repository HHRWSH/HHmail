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

  it('V2.4：自定义/新模型名放行（服务商经常上新），但非法字符仍拒绝', async () => {
    const ok = new DeepSeekAiProvider({
      getConfig: async () => ({ apiKey: 'sk-test', model: 'deepseek-flash' }),
      factory: () => fakeClient()
    })
    await expect(ok.complete({ system: 's', user: 'u' })).resolves.toBe('你好')
    expect(ok.modelName()).toBe('deepseek-flash')

    // V2.4：用户手填的新模型名（服务商新上的型号）允许使用
    for (const fresh of ['deepseek-v3.2', 'deepseek-v4-pro', 'deepseek-v4.1-flash']) {
      const p = new DeepSeekAiProvider({
        getConfig: async () => ({ apiKey: 'sk-test', model: fresh, providerId: 'deepseek' }),
        factory: () => fakeClient()
      })
      await expect(p.complete({ system: 's', user: 'u' })).resolves.toBe('你好')
      expect(p.modelName()).toBe(fresh)
    }
    // 非法模型名（含空格/尖括号等）仍然拒绝，避免把奇怪字符串带进请求
    for (const bad of ['bad model', '<script>', '模型名']) {
      const p = new DeepSeekAiProvider({
        getConfig: async () => ({ apiKey: 'sk-test', model: bad }),
        factory: () => fakeClient()
      })
      await expect(p.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
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

describe('DeepSeekAiProvider —— 拉取最新模型列表（V2.4 /models）', () => {
  const makeProvider = (fetchImpl: typeof fetch) =>
    new DeepSeekAiProvider({
      getConfig: async () => ({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }),
      factory: () => fakeClient(),
      fetchImpl
    })

  it('解析 { data: [{ id }] }，过滤 embedding 等非对话模型', async () => {
    let calledUrl = ''
    let auth = ''
    const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      calledUrl = String(url)
      auth = init?.headers?.authorization ?? ''
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v3.2' }, { id: 'bge-embedding' }] })
      } as unknown as Response
    }) as unknown as typeof fetch
    const models = await makeProvider(fetchImpl).listModels()
    expect(models).toEqual(['deepseek-flash', 'deepseek-v3.2'])
    expect(calledUrl).toBe('https://api.deepseek.com/models')
    expect(auth).toBe('Bearer sk-test')
  })

  it('非 2xx → 中文错误（可手填模型名）', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch
    await expect(makeProvider(fetchImpl).listModels()).rejects.toThrow(/HTTP 401/)
  })

  it('返回空列表 → 明确报错，不静默', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) as unknown as Response) as unknown as typeof fetch
    await expect(makeProvider(fetchImpl).listModels()).rejects.toThrow(/没有返回可用/)
  })

  it('网络异常 → 抛错（由 IPC 层转成中文提示）', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(makeProvider(fetchImpl).listModels()).rejects.toThrow(/network down/)
  })
})