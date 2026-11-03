/**
 * AI 模型列表（V2.4）—— 纯逻辑部分。
 *
 * 背景：服务商（尤其 DeepSeek）经常上/下线模型，内置静态列表很快就过时。
 * 这里做两件事：
 *   1) 调 `/models` 拿到最新可选模型（OpenAI 兼容格式 `{ data: [{ id }] }`）；
 *   2) 与内置列表合并/去重/过滤（embedding、tts 等非对话模型不显示），并允许用户手填任意新模型 ID。
 */

/** 模型 ID 安全校验：只允许常见字符，避免把奇怪字符串写进配置/URL */
export function isSafeModelId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(String(id ?? '').trim())
}

/** OpenAI /models 响应 → 模型 id 列表（兼容数组/对象两种返回） */
export function parseModelsResponse(json: unknown): string[] {
  if (!json) return []
  const data = (json as { data?: unknown }).data ?? json
  if (!Array.isArray(data)) return []
  const out: string[] = []
  for (const item of data) {
    const id =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? String((item as { id?: unknown }).id ?? '')
          : ''
    if (id && isSafeModelId(id)) out.push(id)
  }
  return [...new Set(out)]
}

/** 非对话模型（embedding/tts/asr/rerank…）不放进下拉，避免误选 */
const NON_CHAT_PATTERN = /embed|embedding|tts|whisper|speech|audio|rerank|moderation|image|vision/i

/** 过滤出可对话模型，并稳定排序（保持服务端顺序里的 chat 模型） */
export function filterChatModelIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (!id || seen.has(id) || !isSafeModelId(id)) continue
    if (NON_CHAT_PATTERN.test(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 合并内置模型与远端模型：内置在前（用户熟悉的默认项），远端独有追加在后。
 * 都为空时返回空数组（界面会退化成手填输入框）。
 */
export function mergeModelOptions(preset: string[], fetched: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of [...preset, ...filterChatModelIds(fetched)]) {
    const id = String(m ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 当前模型是否在候选列表里（不在 → 界面显示「自定义」输入框） */
export function isListedModel(model: string, options: string[]): boolean {
  return options.includes(String(model ?? '').trim())
}
