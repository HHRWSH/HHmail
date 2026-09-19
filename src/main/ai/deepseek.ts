/**
 * OpenAiCompatibleProvider —— AiProvider 的 OpenAI 兼容实现（openai SDK 的唯一落点）。
 * V2.2 起支持多家服务商（DeepSeek / 百炼 / Kimi / 智谱 / OpenAI / 自定义），只需 Base URL + 模型名。
 * baseURL 固定 https://api.deepseek.com，运行时模型默认 deepseek-v4-pro（规范 §3.1）。
 * API Key 从加密配置读取（注入 getConfig），不写代码仓库、不写日志。
 */
import OpenAI from 'openai'
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, validateAiModel } from '../config'
import { aiError, type AiProvider, type ChatParams } from './provider'
import type { Logger } from '../logger'

export interface DeepSeekConfig {
  apiKey: string
  baseUrl?: string
  model?: string
  /** 服务商 id（V2.2：用于按服务商校验模型名；缺省 deepseek） */
  providerId?: string
}

export type ChatCompletionsClient = {
  chat: {
    completions: {
      create(payload: {
        model: string
        messages: { role: 'system' | 'user'; content: string }[]
        temperature?: number
        max_tokens?: number
      }): Promise<{ choices?: { message?: { content?: string | null }; finish_reason?: string }[] }>
    }
  }
}

export function createOpenAIClient(cfg: DeepSeekConfig): ChatCompletionsClient {
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl ?? DEEPSEEK_BASE_URL,
    // 防止「点了没反应」：120 秒超时（思考型模型较慢）+ 关闭 SDK 自动重试（默认重试 2 次会假死很久）
    timeout: 120_000,
    maxRetries: 0
  })
  return client as unknown as ChatCompletionsClient
}

export interface DeepSeekProviderDeps {
  getConfig: () => Promise<DeepSeekConfig>
  factory?: (cfg: DeepSeekConfig) => ChatCompletionsClient
  logger?: Logger
}

export class DeepSeekAiProvider implements AiProvider {
  private getConfig: () => Promise<DeepSeekConfig>
  private factory: (cfg: DeepSeekConfig) => ChatCompletionsClient
  private client: ChatCompletionsClient | null = null
  private logger?: Logger
  private model: string

  constructor(deps: DeepSeekProviderDeps) {
    this.getConfig = deps.getConfig
    this.factory = deps.factory ?? createOpenAIClient
    this.logger = deps.logger
    this.model = DEEPSEEK_MODEL
  }

  modelName(): string {
    return this.model
  }

  private async ensureClient(): Promise<ChatCompletionsClient> {
    const cfg = await this.getConfig()
    const model = validateAiModel(cfg.model ?? DEEPSEEK_MODEL, cfg.providerId ?? 'deepseek')
    if (this.model !== model || !this.client) {
      // 模型变化 → 重建客户端，保证设置页切换模型立即生效（旧实现会一直复用旧模型）
      this.client = null
      this.model = model
      this.client = this.factory(cfg)
    }
    return this.client
  }

  async complete(params: ChatParams): Promise<string> {
    const client = await this.ensureClient()
    try {
      const resp = await client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user }
        ],
        temperature: params.temperature ?? 0.2,
        max_tokens: params.maxTokens ?? 4096
      })
      const content = resp.choices?.[0]?.message?.content ?? ''
      const finishReason = resp.choices?.[0]?.finish_reason ?? ''
      // 记录完成状态（不含正文），用于定位「返回空内容」类问题
      this.logger?.info('ai.complete', {
        inputChars: params.user.length,
        outputChars: content.length,
        finishReason
      })
      return content
    } catch (e) {
      // 记录真实失败原因（截断 + 走 logger 脱敏），便于区分「模型名不对 / Key 无效 / 限流 / 网络」
      const raw = e instanceof Error ? e.message : String(e)
      this.logger?.warn('ai.complete.failed', { reason: raw.slice(0, 200) })
      throw aiError(e)
    }
  }
}
