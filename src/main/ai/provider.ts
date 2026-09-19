/**
 * AiProvider —— AI 抽象（规范 §14.2）：只负责"补全"，不含业务。
 * openai SDK 只允许出现在 deepseek.ts；换模型/换供应商只改实现。
 */
import { AppError, ErrorCodes } from '../../shared/error-codes'

export interface ChatParams {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
}

export interface AiProvider {
  complete(params: ChatParams): Promise<string>
  modelName(): string
}

export function aiError(e: unknown): AppError {
  const text = e instanceof Error ? e.message : String(e)
  if (/429|rate.?limit/i.test(text)) {
    return new AppError(ErrorCodes.AI_RATE_LIMIT, 'AI 服务请求过于频繁，请稍后再试。')
  }
  if (/timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(text)) {
    return new AppError(ErrorCodes.AI_FAILED, 'AI 服务响应超时，请稍后重试。')
  }
  if (/401|403|incorrect api key|invalid api key/i.test(text)) {
    return new AppError(ErrorCodes.AI_FAILED, 'API Key 无效，请在设置中检查后重试。')
  }
  // 服务端明确回报模型名不受支持（真机回归：deepseek-v4.1-flash 已下线）
  if (/supported api model names|model not exist|invalid model|does not exist/i.test(text)) {
    const supported = /supported API model names are ([^.]*)/i.exec(text)?.[1]?.trim()
    return new AppError(
      ErrorCodes.AI_FAILED,
      supported
        ? `当前模型不被服务端支持，可用模型：${supported}。请在「设置 → 模型」中更换。`
        : '当前模型不被服务端支持，请在「设置 → 模型」中更换。'
    )
  }
  return new AppError(ErrorCodes.AI_FAILED, 'AI 服务调用失败，请检查 API Key 与网络后重试。')
}
