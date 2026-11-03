import { describe, expect, it } from 'vitest'
import { filterChatModelIds, isListedModel, isSafeModelId, mergeModelOptions, parseModelsResponse } from './aiModels'

describe('AI 模型列表（V2.4）：解析服务端 /models', () => {
  it('OpenAI 兼容格式 { data: [{ id }] }', () => {
    const json = { object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }
    expect(parseModelsResponse(json)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('也接受纯数组 / 字符串数组', () => {
    expect(parseModelsResponse(['a-model', 'b-model'])).toEqual(['a-model', 'b-model'])
    expect(parseModelsResponse([{ id: 'x' }, 'y'])).toEqual(['x', 'y'])
  })

  it('去重 + 丢掉非法项', () => {
    expect(parseModelsResponse({ data: [{ id: 'm1' }, { id: 'm1' }, { id: '' }, {}, { id: 'bad model!' }] })).toEqual(['m1'])
  })

  it('空/异常输入 → 空数组，不抛错', () => {
    expect(parseModelsResponse(null)).toEqual([])
    expect(parseModelsResponse({})).toEqual([])
    expect(parseModelsResponse('nope')).toEqual([])
    expect(parseModelsResponse({ data: 'str' })).toEqual([])
  })
})

describe('AI 模型列表：安全与过滤', () => {
  it('模型 ID 只允许常见字符', () => {
    expect(isSafeModelId('deepseek-v3.2')).toBe(true)
    expect(isSafeModelId('qwen2.5:7b')).toBe(true)
    expect(isSafeModelId('meta-llama/Llama-3-8B')).toBe(true)
    expect(isSafeModelId('bad model')).toBe(false)
    expect(isSafeModelId('<script>')).toBe(false)
    expect(isSafeModelId('')).toBe(false)
  })

  it('过滤非对话模型（embedding/tts/whisper/rerank…）', () => {
    const ids = ['deepseek-chat', 'bge-embedding', 'tts-1', 'whisper-1', 'rerank-v2', 'deepseek-v3.2']
    expect(filterChatModelIds(ids)).toEqual(['deepseek-chat', 'deepseek-v3.2'])
  })

  it('合并：内置在前、远端独有追加、去重', () => {
    expect(mergeModelOptions(['deepseek-flash'], ['deepseek-flash', 'deepseek-v3.2'])).toEqual([
      'deepseek-flash',
      'deepseek-v3.2'
    ])
    expect(mergeModelOptions([], ['a'])).toEqual(['a'])
    expect(mergeModelOptions(['a'], [])).toEqual(['a'])
    expect(mergeModelOptions([], [])).toEqual([])
  })

  it('判断当前模型是否在列表里（决定要不要显示自定义输入框）', () => {
    expect(isListedModel('deepseek-flash', ['deepseek-flash'])).toBe(true)
    expect(isListedModel('brand-new-model', ['deepseek-flash'])).toBe(false)
  })
})
