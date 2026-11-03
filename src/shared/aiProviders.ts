/**
 * AI 服务商与模型目录（V2.2：不再只支持 DeepSeek）。
 *
 * 全部走 OpenAI 兼容协议（/chat/completions），所以只要填对 Base URL 与模型名就能用；
 * 这里给几个常用服务商做预设，另留「自定义」兜底。
 *
 * 注意：模型名会随服务商更新而变化，这里只放长期存在的稳定名字；
 * 万一某个名字失效，用「自定义」手填即可（不会因为列表过期而卡住用户）。
 */

export interface AiProviderPreset {
  id: string
  label: string
  /** OpenAI 兼容的 Base URL（自定义时由用户填写） */
  baseUrl: string
  /** 预设模型名（自定义服务商时为空，用户手填） */
  models: string[]
  hint?: string
}

export const AI_PROVIDERS: readonly AiProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek（默认，性价比高）',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash'],
    hint: 'deepseek-flash = V4.1 Flash；API Key 在 platform.deepseek.com 获取'
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    hint: '百炼控制台的 API Key；模型名如 qwen-plus'
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    hint: 'platform.moonshot.cn 的 API Key'
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus'],
    hint: 'bigmodel.cn 的 API Key'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    hint: '需要能直连 OpenAI 的网络环境'
  },
  {
    id: 'custom',
    label: '自定义（任意 OpenAI 兼容服务）',
    baseUrl: '',
    models: [],
    hint: '自己填 Base URL 与模型名，例如本地 Ollama / vLLM / 中转站'
  }
]

export const DEFAULT_AI_PROVIDER_ID = 'deepseek'

export function resolveAiProvider(id: string | null | undefined): AiProviderPreset {
  const found = AI_PROVIDERS.find((p) => p.id === id)
  return found ?? AI_PROVIDERS[0]
}

/** 该服务商的预设模型（自定义服务商返回空数组，界面改为手填） */
export function providerModels(id: string | null | undefined): string[] {
  return [...resolveAiProvider(id).models]
}

export function defaultModelForProvider(id: string | null | undefined): string {
  const models = providerModels(id)
  return models[0] ?? ''
}

/**
 * 校验「服务商 + 模型」组合（V2.4 放宽）。
 *
 * 以前预设服务商只允许内置列表里的模型，但服务商经常上线新模型（如 deepseek-v3.2），
 * 用户根本没法用。现在只校验**模型 ID 的字符安全**，内置列表退化为「推荐值」；
 * 弃用模型名（deepseek-chat / deepseek-reasoner）仍在 config.validateAiModel 里单独拒绝。
 */
export function validateAiConfig(providerId: string, model: string): { ok: boolean; reason?: string } {
  resolveAiProvider(providerId) // 保留参数校验（未知服务商回退默认）
  const m = String(model ?? '').trim()
  if (!m) return { ok: false, reason: '请填写模型名。' }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(m)) {
    return { ok: false, reason: '模型名不合法：只允许字母、数字和 . _ : / -' }
  }
  return { ok: true }
}

/** 服务商 + 自定义 Base URL → 实际请求地址 */
export function resolveBaseUrl(providerId: string, customBaseUrl: string): string {
  const provider = resolveAiProvider(providerId)
  const url = (provider.id === 'custom' ? customBaseUrl : provider.baseUrl).trim()
  return url || provider.baseUrl || 'https://api.deepseek.com'
}
