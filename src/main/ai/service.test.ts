import { describe, expect, it } from 'vitest'
import {
  buildAskPrompt,
  buildQaPrompt,
  buildSummarizePrompt,
  MailAiServiceImpl,
  QA_SYSTEM,
  SUMMARIZE_SYSTEM,
  truncateText,
  type AskMailDetail,
  type AskSearchHit,
  type AskSummaryHit,
  type InboxSearch,
  type AskIndexHit,
  type Thread
} from './service'
import { DEFAULT_ASK_PROMPT, DEFAULT_SUMMARY_PROMPT } from '../../shared/defaults'
import type { IndexFilter } from '../../shared/indexCard'
import { FakeAiProvider } from '../../../tests/helpers/fakes'
import { MemoryLogger } from '../logger'

const thread: Thread = {
  threadId: 'T1',
  subject: '论文进度',
  messages: [
    { fromName: '林教授', fromAddr: 'lin@example.edu', dateTs: 1_760_000_000_000, bodyText: '请补充第三章实验数据。' },
    { fromName: '我', fromAddr: 'me@link.example.edu', dateTs: 1_760_001_000_000, bodyText: '好的，周五前提交。' }
  ]
}

/** 问答用 fake 检索（契约测试：换实现不破坏行为） */
class FakeInboxSearch implements InboxSearch {
  hits: AskSearchHit[] = []
  details = new Map<number, AskMailDetail>()
  summaries: AskSummaryHit[] = []
  recent: number[] = []
  /** 记录所有检索词（M4：多轮追问是否带上上一轮实词、能力类问题是否真的不检索） */
  searchCalls: string[] = []

  async search(term: string, limit?: number): Promise<AskSearchHit[]> {
    this.searchCalls.push(term)
    return this.hits.slice(0, limit ?? this.hits.length)
  }

  async getMessage(id: number): Promise<AskMailDetail | null> {
    return this.details.get(id) ?? null
  }

  async searchSummaries(term: string, limit: number): Promise<AskSummaryHit[]> {
    void term
    return this.summaries.slice(0, limit)
  }

  async query(params: { limit: number; offset: number }): Promise<{ id: number }[]> {
    return this.recent.slice(params.offset, params.offset + params.limit).map((id) => ({ id }))
  }

  // M1：索引卡片检索桩
  indexHits: AskIndexHit[] = []
  filterHits: AskIndexHit[] = []
  lastFilter: IndexFilter | null = null

  async searchIndexDocs(term: string, limit: number): Promise<AskIndexHit[]> {
    this.searchCalls.push(term)
    return this.indexHits.slice(0, limit)
  }

  async searchIndexByFilter(filter: IndexFilter, limit: number): Promise<AskIndexHit[]> {
    this.lastFilter = filter
    return this.filterHits.slice(0, limit)
  }

  // M3：集合档案桩（知识库 → AI 助手）
  collectionMails: Array<{
    id: number
    subject: string
    fromName: string
    dateTs: number
    dueTs: number | null
    type: string | null
    course: string | null
    entities: string[]
  }> = []
  lastCollection: { kind: 'course' | 'type'; value: string } | null = null

  async listCollectionMails(kind: 'course' | 'type', value: string): Promise<typeof this.collectionMails> {
    this.lastCollection = { kind, value }
    return this.collectionMails
  }
}

const HIGH_SURROGATE_ESCAPE = /\\u[dD][89abAB][0-9a-fA-F]{2}/g
const LOW_SURROGATE_ESCAPE = /^\\u[dD][c-fC-F][0-9a-fA-F]{2}/

/**
 * DeepSeek 服务端用严格 JSON 解析器：字符串里出现「孤立代理项」（`\ud83d` 后面不跟低代理项转义）
 * 会直接返回 400 `unexpected end of hex escape`。
 * 这正是「AI 助手又不能用」的真因：正文按 UTF-16 长度截断时把 emoji 切成了半个字符。
 * 这里按同样规则校验序列化后的请求体（模拟 openai SDK 的 messages 结构）。
 */
function loneSurrogateEscapes(json: string): string[] {
  const out: string[] = []
  for (const m of json.matchAll(HIGH_SURROGATE_ESCAPE)) {
    const rest = json.slice((m.index ?? 0) + m[0].length)
    if (!LOW_SURROGATE_ESCAPE.test(rest)) out.push(m[0])
  }
  return out
}

function assertStrictPayload(ai: FakeAiProvider): void {
  const body = JSON.stringify({
    model: 'deepseek-flash',
    messages: ai.calls.flatMap((c) => [
      { role: 'system', content: c.system },
      { role: 'user', content: c.user }
    ])
  })
  expect(loneSurrogateEscapes(body)).toEqual([])
  expect(() => JSON.parse(body)).not.toThrow()
}

function makeAskFixtures() {
  const search = new FakeInboxSearch()
  search.hits = [
    { id: 11, subject: '关于毕业论文进度的沟通', fromName: '林教授', fromAddr: 'lin@example.edu', dateTs: 1_760_000_000_000, snippet: '…' },
    { id: 12, subject: '选课缴费通知', fromName: '教务处', fromAddr: 'office@link.example.edu', dateTs: 1_760_001_000_000, snippet: '…' }
  ]
  search.details.set(11, { id: 11, subject: '关于毕业论文进度的沟通', fromName: '林教授', fromAddr: 'lin@example.edu', dateTs: 1_760_000_000_000, bodyText: '请补充第三章实验数据，周五前回复。', bodyHtml: null })
  search.details.set(12, { id: 12, subject: '选课缴费通知', fromName: '教务处', fromAddr: 'office@link.example.edu', dateTs: 1_760_001_000_000, bodyText: '月底前完成选课与缴费。', bodyHtml: null })
  return search
}

describe('prompt 组装（纯函数，规范 §6.7 / §6.8）', () => {
  it('总结 prompt 包含主题/发件人/时间/正文截断', () => {
    const p = buildSummarizePrompt(thread, 6)
    expect(p).toContain('论文进度')
    expect(p).toContain('林教授')
    expect(p).toContain('[1]')
    expect(p).toContain('请补充第三章…') // 截断
  })

  it('truncateText 只截长文', () => {
    expect(truncateText('短', 10)).toBe('短')
    expect(truncateText('一二三四五六七八九十', 4)).toBe('一二三四…')
  })

  it('RAG prompt：编号与检索结果一一对应，问题截断', () => {
    const hits = [
      { uid: 101, subject: 'A', fromName: 'x', dateTs: 1, bodyText: 'body-a' },
      { uid: 202, subject: 'B', fromName: 'y', dateTs: 2, bodyText: 'body-b' }
    ]
    const p = buildQaPrompt('上周导师发了什么？', hits, 100)
    expect(p).toContain('问题：上周导师发了什么？')
    expect(p).toContain('[1] 主题：A')
    expect(p).toContain('[2] 主题：B')
  })

  it('RAG 上下文超长按每封上限截断', () => {
    const hits = [{ uid: 1, subject: 'S', fromName: 'x', dateTs: 1, bodyText: 'a'.repeat(5000) }]
    const p = buildQaPrompt('q', hits, 300)
    const bodyLine = p.split('正文：')[1]
    expect(bodyLine.length).toBeLessThan(400)
  })
})

describe('MailAiServiceImpl —— 契约测试（FakeAiProvider）', () => {
  it('summarize：调用 system 提示词 + 返回 Summary', async () => {
    const ai = new FakeAiProvider()
    const logger = new MemoryLogger()
    const svc = new MailAiServiceImpl({ ai, logger })
    const result = await svc.summarize(thread)
    expect(result.threadId).toBe('T1')
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0].system).toBe(SUMMARIZE_SYSTEM)
    expect(ai.calls[0].user).toContain('论文进度')
    expect(ai.calls[0].maxTokens).toBe(4096)
    // 日志不包含正文（脱敏要求）
    const logged = JSON.stringify(logger.entries)
    expect(logged).not.toContain('第三章实验数据')
  })

  it('searchQA：引用编号与检索结果一一对应', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '答案见 [1][2]'
    const svc = new MailAiServiceImpl({ ai, logger: new MemoryLogger() })
    const hits = [
      { uid: 101, subject: 'A', fromName: 'x', dateTs: 1, bodyText: 'a' },
      { uid: 202, subject: 'B', fromName: 'y', dateTs: 2, bodyText: 'b' }
    ]
    const result = await svc.searchQA('问题', hits)
    expect(result.citations).toEqual([1, 2])
    expect(ai.calls[0].system).toBe(QA_SYSTEM)
    expect(ai.calls[0].user).toContain('[1]')
  })

  it('summarize：自定义 system 提示词优先；空提示词回退默认；modelName 透传', async () => {
    const ai = new FakeAiProvider()
    const svc = new MailAiServiceImpl({ ai })
    await svc.summarize(thread, { systemPrompt: '自定义提示词' })
    expect(ai.calls[0].system).toBe('自定义提示词')
    await svc.summarize(thread, { systemPrompt: '   ' })
    expect(ai.calls[1].system).toBe(DEFAULT_SUMMARY_PROMPT)
    expect(svc.modelName()).toBe('fake-model')
  })

  it('默认提示词（v5）面向学生场景：固定小节 + 硬性字数上限 + 广告过滤', () => {
    expect(DEFAULT_SUMMARY_PROMPT).toContain('## 主旨')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('## 关键信息')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('## 截止与行动项')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('## 重要度')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('广告')
    // v5：短优先（用户反馈 v4 的「完整性优先」把摘要写成长文，扫不出重点）
    expect(DEFAULT_SUMMARY_PROMPT).toContain('30 秒内看清')
    expect(DEFAULT_SUMMARY_PROMPT).toContain('短优先')
    expect(DEFAULT_SUMMARY_PROMPT).not.toContain('150 字以内')
    expect(DEFAULT_SUMMARY_PROMPT).not.toContain('完整性优先')
    expect(DEFAULT_SUMMARY_PROMPT).not.toContain('## 原文摘录')
    expect(SUMMARIZE_SYSTEM).toBe(DEFAULT_SUMMARY_PROMPT)
  })

  it('模型多次返回空内容 → 降级返回元信息兜底（degraded，不假装成功、不覆盖旧摘要）', async () => {
    const ai = new FakeAiProvider()
    ai.queue = ['', '', ''] // 原样重试 + 缩短上下文重试 都为空
    const svc = new MailAiServiceImpl({ ai })
    const result = await svc.summarize(thread)
    expect(result.degraded).toBe(true)
    expect(result.text).toContain('未能生成摘要')
    expect(result.text).toContain('论文进度')
    // 兜底文案同样用 Markdown 模板，界面渲染排版一致；本地时间（非 UTC）
    expect(result.text).toContain('## 主旨')
    expect(result.text).toContain('## 关键信息')
    expect(result.text).toContain('| 项目 | 内容 |')
    expect(ai.calls).toHaveLength(3)
  })

  it('空内容自动重试一次：第一次空、第二次有内容 → 成功', async () => {
    const ai = new FakeAiProvider()
    ai.queue = ['', '重试后返回的内容']
    const svc = new MailAiServiceImpl({ ai })
    const result = await svc.summarize(thread)
    expect(result.text).toBe('重试后返回的内容')
    expect(result.degraded).toBeUndefined()
    expect(ai.calls).toHaveLength(2)
  })

  it('缩短上下文重试：前两次空、第三次（正文只取 300 字）成功', async () => {
    const longThread: Thread = {
      ...thread,
      messages: [{ fromName: 'A', fromAddr: 'a@x', dateTs: 1, bodyText: '长'.repeat(1200) }]
    }
    const ai = new FakeAiProvider()
    ai.queue = ['', '', '缩短后成功了']
    const svc = new MailAiServiceImpl({ ai })
    const result = await svc.summarize(longThread)
    expect(result.text).toBe('缩短后成功了')
    expect(ai.calls).toHaveLength(3)
    expect(ai.calls[2].user.length).toBeLessThan(ai.calls[0].user.length)
  })
})

describe('V2.2：引用只列回答里提到的邮件（用户反馈"底下一堆无效索引"）', () => {
  it('回答没提主题时退回前 3 条，保证仍有可点入口', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '没提到任何具体邮件主题的回答。'
    const svc = new MailAiServiceImpl({ ai, store: makeAskFixtures() })
    const result = await svc.askInbox('上周导师发了什么邮件？')
    expect(result.citations.length).toBeGreaterThan(0)
    expect(result.citations.length).toBeLessThanOrEqual(3)
  })

  it('pickMentionedCitations：按主题匹配，最多 5 条', async () => {
    const { pickMentionedCitations } = await import('./service')
    const candidates = [
      { id: 1, subject: 'Daily Notifications', fromName: 'Blackboard', dateTs: 1 },
      { id: 2, subject: '选课与学费缴费通知', fromName: '教务处', dateTs: 2 },
      { id: 3, subject: 'Library Orientation', fromName: '图书馆', dateTs: 3 }
    ]
    const answer = '1. Daily Notifications 里有 Blackboard 的新通知；2. 选课与学费缴费通知 提到月底缴费。'
    const picked = pickMentionedCitations(answer, candidates)
    expect(picked.map((c) => c.id)).toEqual([1, 2])
    expect(pickMentionedCitations('完全没提主题', candidates).map((c) => c.id)).toEqual([1, 2, 3])
  })
})

describe('askInbox —— AI 搜索问答（V2 M1）', () => {
  it('本地完全没有邮件：如实提示先同步，不调用模型、不编造', async () => {
    const ai = new FakeAiProvider()
    const svc = new MailAiServiceImpl({ ai, store: new FakeInboxSearch() })
    const result = await svc.askInbox('明天有没有外星人来访？')
    expect(result.answer).toContain('还没有可用于回答的邮件')
    expect(result.citations).toEqual([])
    expect(ai.calls).toHaveLength(0)
  })

  it('截断点落在 emoji 中间时，请求体仍是严格合法 JSON（修复 400 hex escape）', async () => {
    const ai = new FakeAiProvider()
    const svc = new MailAiServiceImpl({ ai })
    const bodyText = '正'.repeat(2999) + '😀' + 'ABC'
    await svc.summarize({ threadId: 'T', subject: '长正文', messages: [{ fromName: 'a', fromAddr: 'a@x.example.edu', dateTs: 1, bodyText }] })
    assertStrictPayload(ai)
  })

  it('正文自带孤立代理项（脏数据）时先清洗再送模型', async () => {
    const ai = new FakeAiProvider()
    const svc = new MailAiServiceImpl({ ai })
    await svc.summarize({ threadId: 'T', subject: '脏数据', messages: [{ fromName: 'a', fromAddr: 'a@x.example.edu', dateTs: 1, bodyText: '前半段\uD83D' }] })
    assertStrictPayload(ai)
  })

  it('askInbox 检索到含孤立代理项的正文也不破坏请求体', async () => {
    const ai = new FakeAiProvider()
    const store = makeAskFixtures()
    store.hits = []
    store.details.set(11, {
      id: 11,
      subject: '脏数据',
      fromName: '林教授',
      fromAddr: 'lin@example.edu',
      dateTs: 1_760_000_000_000,
      bodyText: '请补充第三章实验数据\uD83D',
      bodyHtml: null
    })
    const svc = new MailAiServiceImpl({ ai, store })
    await svc.askInbox('导师要求我做什么？')
    assertStrictPayload(ai)
  })

  it('检索无命中但有最近邮件：仍调用模型（把最近邮件作为上下文），不直接拒绝回答', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '未找到相关邮件（最近邮件里没有相关信息）。'
    const store = makeAskFixtures()
    store.hits = []
    store.recent = [11, 12]
    const svc = new MailAiServiceImpl({ ai, store })
    const result = await svc.askInbox('明天有没有外星人来访？')
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0].user).toContain('相关邮件原文（共 2 封）')
    expect(result.citations.map((c) => c.id)).toEqual([11, 12])
  })

  it('已生成摘要优先：摘要命中时 prompt 带摘要区块，引用含摘要来源', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '回答：周五前交第三章数据。\n引用：[S1] 关于毕业论文进度的沟通 · 林教授'
    const store = makeAskFixtures()
    store.hits = []
    store.summaries = [
      {
        id: 11,
        subject: '关于毕业论文进度的沟通',
        fromName: '林教授',
        fromAddr: 'lin@example.edu',
        dateTs: 1_760_000_000_000,
        summary: '【一句话主旨】要求补充第三章实验数据，周五前回复。'
      }
    ]
    const svc = new MailAiServiceImpl({ ai, store })
    const result = await svc.askInbox('导师要求我做什么？')
    expect(ai.calls[0].user).toContain('已生成摘要（可信、优先使用，共 1 条）')
    expect(ai.calls[0].user).toContain('【一句话主旨】要求补充第三章实验数据')
    expect(result.citations.map((c) => c.id)).toEqual([11])
    expect(ai.calls[0].system).toContain('绝不编造')
  })

  it('有命中：prompt 带编号与正文，引用一一对应，日志不含正文', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '回答：请补充实验数据。\n引用：[1] 关于毕业论文进度的沟通 · 林教授'
    const logger = new MemoryLogger()
    const svc = new MailAiServiceImpl({ ai, store: makeAskFixtures(), logger })
    const result = await svc.askInbox('上周导师发了什么邮件？')
    expect(result.answer).toContain('补充实验数据')
    // V2.2：引用只保留「回答里提到」的邮件（#11 的主题在回答里，另一封被过滤掉）
    expect(result.citations.map((c) => c.id)).toEqual([11])
    expect(result.citations[0].fromName).toBe('林教授')
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0].system).toBe(DEFAULT_ASK_PROMPT)
    expect(ai.calls[0].user).toContain('[1] 主题：关于毕业论文进度的沟通')
    expect(ai.calls[0].user).toContain('请补充第三章实验数据')
    // 日志只记字符数，不含正文
    expect(JSON.stringify(logger.entries)).not.toContain('第三章实验数据')
  })

  it('自定义 system 提示词与 topK 生效', async () => {
    const ai = new FakeAiProvider()
    const store = makeAskFixtures()
    const svc = new MailAiServiceImpl({ ai, store })
    await svc.askInbox('导师', { topK: 1, systemPrompt: '自定义问答提示词' })
    expect(ai.calls[0].system).toBe('自定义问答提示词')
    expect(ai.calls[0].user).toContain('相关邮件原文（共 1 封）')
  })

  it('模型空返回自动重试一次；两次为空 → AI_FAILED', async () => {
    const ai = new FakeAiProvider()
    ai.queue = ['', '重试后回答']
    const svc = new MailAiServiceImpl({ ai, store: makeAskFixtures() })
    const ok = await svc.askInbox('导师')
    expect(ok.answer).toBe('重试后回答')
    expect(ai.calls).toHaveLength(2)

    const ai2 = new FakeAiProvider()
    ai2.queue = ['', '']
    const svc2 = new MailAiServiceImpl({ ai: ai2, store: makeAskFixtures() })
    await expect(svc2.askInbox('导师')).rejects.toMatchObject({ code: 'AI_FAILED' })
  })

  it('未注入 store → AI_FAILED', async () => {
    const svc = new MailAiServiceImpl({ ai: new FakeAiProvider() })
    await expect(svc.askInbox('问题')).rejects.toMatchObject({ code: 'AI_FAILED' })
  })

  it('buildAskPrompt 纯 HTML 正文兜底为纯文本', () => {
    const p = buildAskPrompt('问题', [{ id: 1, subject: 'S', fromName: 'A', fromAddr: 'a@x', dateTs: 1, bodyText: '', bodyHtml: '<p>HTML 正文内容</p>' }], 300)
    expect(p).toContain('HTML 正文内容')
    expect(p).not.toContain('<p>')
  })
})

describe('aiError —— 失败原因归类（V2.1 真机回归）', () => {
  const mk = (msg: string) => Object.assign(new Error(msg), {})

  it('模型名不受支持时给出「可用模型」提示（而不是泛泛的 Key/网络）', async () => {
    const { aiError } = await import('./provider')
    const err = aiError(
      mk('400 The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash.')
    )
    expect(err.message).toContain('deepseek-flash, deepseek-v4-pro')
    expect(err.message).toContain('设置')
  })

  it('限流 / 无效 Key / 超时各自归类', async () => {
    const { aiError } = await import('./provider')
    expect(aiError(mk('429 rate limit')).message).toContain('频繁')
    expect(aiError(mk('401 Incorrect API key provided')).message).toContain('API Key 无效')
    expect(aiError(mk('request timed out')).message).toContain('超时')
  })
describe('总结/问答 prompt —— 正文清洗与本地时区（V2.1 真机回归）', () => {
  it('总结 prompt：CSS 噪声被清掉、日期带北京时间标注、含 HTML 时用 HTML 文本', () => {
    const thread: Thread = {
      threadId: 't-1',
      subject: 'MAE Career',
      messages: [
        {
          fromName: 'MAE Office',
          fromAddr: 'mae@example.edu',
          dateTs: Date.UTC(2026, 8, 10, 8, 14),
          bodyText: 'img { max-width: 600px; } @media screen { .a { width: 100% !important; } }\nWelcome to the programme.',
          bodyHtml: '<html><body><p>Welcome to the programme.</p><p>Best regards, Vicky Long</p></body></html>'
        }
      ]
    }
    const prompt = buildSummarizePrompt(thread, 1500)
    expect(prompt).not.toContain('max-width')
    expect(prompt).not.toContain('@media')
    expect(prompt).toContain('Welcome to the programme')
    expect(prompt).toContain('16:14')
    expect(prompt).toContain('北京时间')
  })

  it('问答 prompt：同样清洗正文并统一「收件时间」字段', () => {
    const prompt = buildAskPrompt(
      '导师说了什么？',
      [
        {
          id: 1,
          subject: 'S',
          fromName: 'A',
          fromAddr: 'a@example.edu',
          dateTs: Date.UTC(2026, 8, 10, 8, 14),
          bodyText: 'p { color: red; } 正文要点：周五前提交。',
          bodyHtml: '<p>正文要点：周五前提交。</p>'
        }
      ],
      400
    )
    expect(prompt).not.toContain('color: red')
    expect(prompt).toContain('正文要点：周五前提交')
    expect(prompt).toContain('收件时间：2026-09-10 16:14（北京时间）')
  })
})

})

describe('M1：索引卡片生成与「索引优先」检索', () => {
  const cardText = [
    '[TYPE] 作业 | [COURSE] ENG1110B | [DUE] 2026-09-20 23:59',
    '[FROM] lin@example.edu | [ORG] 电子工程系',
    '[ENTITIES] GraderScope, Lab 0',
    '[ALIASES] 实验一',
    '[FACTS]',
    '- Lab 0 用 GraderScope 提交',
    '[QUESTIONS] 实验什么时候截止？',
    '[QUOTE] due 23:59'
  ].join('\n')

  it('indexDoc：独立于人类摘要的一次调用，解析出可过滤字段', async () => {
    const ai = new FakeAiProvider()
    ai.reply = cardText
    const svc = new MailAiServiceImpl({ ai })
    const res = await svc.indexDoc(thread)
    expect(ai.calls[0].system).toContain('[TYPE]')
    expect(ai.calls[0].system).not.toBe(DEFAULT_SUMMARY_PROMPT)
    expect(res.degraded).toBeUndefined()
    expect(res.fields.type).toBe('作业')
    expect(res.fields.course).toBe('ENG1110B')
    expect(res.fields.dueTs).toBe(new Date(2026, 8, 20, 23, 59).getTime())
    expect(res.fields.aliases).toContain('实验一')
  })

  it('indexDoc：超长邮件会截断输入，并给足输出预算（真机：思考吃光 max_tokens → 卡片全失败）', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '[TYPE] 通知\n[FACTS]\n- x'
    const svc = new MailAiServiceImpl({ ai, store: makeAskFixtures() })
    const huge: Thread = {
      threadId: 'T-huge',
      subject: '超长邮件',
      messages: [
        {
          fromName: '教务处',
          fromAddr: 'office@example.edu',
          dateTs: 1_760_000_000_000,
          // 40k 字符正文：不做上限就会把模型预算全花在思考上
          bodyText: '正文'.repeat(20_000)
        }
      ]
    }
    await svc.indexDoc(huge)
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0].user.length).toBeLessThan(6000)
    // 输出预算必须明显大于卡片本身（卡片约 200 字，留给思考的空间）
    expect(ai.calls[0].maxTokens ?? 0).toBeGreaterThanOrEqual(2048)
  })

  it('indexDoc：模型空返回 → degraded，不写库', async () => {
    const ai = new FakeAiProvider()
    ai.queue = ['', '']
    const svc = new MailAiServiceImpl({ ai })
    const res = await svc.indexDoc(thread)
    expect(res.degraded).toBe(true)
    expect(res.text).toBe('')
  })

  it('askInbox：索引卡片命中最优先，并进入 prompt 与引用', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '结论：实验一 09-20 截止。'
    const store = makeAskFixtures()
    store.hits = []
    store.indexHits = [
      {
        id: 11,
        subject: '关于毕业论文进度的沟通',
        fromName: '林教授',
        fromAddr: 'lin@example.edu',
        dateTs: 1_760_000_000_000,
        card: cardText,
        type: '作业',
        course: 'ENG1110B',
        dueTs: new Date(2026, 8, 20, 23, 59).getTime()
      }
    ]
    const svc = new MailAiServiceImpl({ ai, store })
    const result = await svc.askInbox('ENG1110B 的实验什么时候截止？')
    expect(ai.calls[0].user).toContain('邮件索引卡片（最可信、优先使用，共 1 条）')
    expect(ai.calls[0].user).toContain('GraderScope')
    expect(result.citations.map((c) => c.id)).toEqual([11])
    // 关键词里已过滤掉疑问词，结构化过滤条件（课程号）被用于第二路召回
    expect(store.lastFilter?.course).toBe('ENG1110B')
  })

  it('askInbox：纯时间/类型问题（"这周有什么截止"）走结构化过滤', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '这周有 1 个截止。'
    const store = makeAskFixtures()
    store.hits = []
    store.filterHits = [
      {
        id: 12,
        subject: '选课缴费通知',
        fromName: '教务处',
        fromAddr: 'office@link.example.edu',
        dateTs: 1_760_001_000_000,
        card: '[TYPE] 行政 | [DUE] 2026-09-13 23:59',
        type: '行政',
        course: null,
        dueTs: new Date(2026, 8, 13, 23, 59).getTime()
      }
    ]
    const svc = new MailAiServiceImpl({ ai, store })
    const result = await svc.askInbox('这周有什么截止？')
    expect(store.lastFilter?.hasDue).toBe(true)
    expect(ai.calls[0].user).toContain('邮件索引卡片')
    expect(result.citations.map((c) => c.id)).toEqual([12])
  })
})


describe('M3：AI 助手调用知识库（集合档案）', () => {
  // 提示词里的时间是按**北京时间（Asia/Hong_Kong，UTC+8）**格式化的（见 shared/text.ts formatPromptDate），
  // 所以这里必须用 UTC 显式构造时间戳：`new Date(2026, 8, 16, 14, 42)` 会跟着跑测试的机器时区变，
  // 在 UTC 的 CI runner 上就变成 22:42（北京时间）→ 断言随机失败（真踩过）。
  const hkt = (y: number, mo: number, d: number, h: number, mi: number): number =>
    Date.UTC(y, mo - 1, d, h - 8, mi)
  const due1 = hkt(2026, 9, 16, 14, 42)
  const due2 = hkt(2026, 9, 18, 23, 59)

  it('问题里出现课程号 → prompt 带上该课程集合的完整截止清单', async () => {
    const ai = new FakeAiProvider()
    ai.reply = 'ENG1110B 有 2 个截止：09-16 14:42 与 09-18 23:59。'
    const store = makeAskFixtures()
    store.hits = []
    store.collectionMails = [
      {
        id: 11,
        subject: 'Welcome to Gradescope for 2026R1-ENGG1110ABCDEF',
        fromName: 'Gradescope',
        dateTs: 1_760_000_000_000,
        dueTs: due1,
        type: '作业',
        course: 'ENG1110B',
        entities: ['Gradescope']
      },
      {
        id: 12,
        subject: 'Lab-01 Ex02 提交成功',
        fromName: 'Gradescope',
        dateTs: 1_760_001_000_000,
        dueTs: due2,
        type: '作业',
        course: 'ENG1110B',
        entities: ['Gradescope', 'Lab-01 Ex02']
      }
    ]
    const svc = new MailAiServiceImpl({ ai, store })
    const result = await svc.askInbox('ENG1110B 有哪些截止？')
    expect(store.lastCollection?.value).toBe('ENG1110B')
    const prompt = ai.calls[0].user
    expect(prompt).toContain('知识库档案（课程「ENG1110B」')
    expect(prompt).toContain('共 2 封')
    expect(prompt).toContain('09-16 14:42')
    expect(prompt).toContain('09-18 23:59')
    expect(prompt).toContain('涉及系统/平台：Gradescope')
    expect(prompt).toContain('以上清单是完整依据')
    expect(result.citations.map((c) => c.id)).toEqual([11, 12])
  })

  it('问题里出现类型 → 也带类型集合档案；无关问题不带', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '有 1 个奖学金申请。'
    const store = makeAskFixtures()
    store.hits = []
    store.collectionMails = [
      {
        id: 11,
        subject: '某某奖学金 2026/27 开放申请',
        fromName: '教务处',
        dateTs: 1_760_000_000_000,
        dueTs: due1,
        type: '奖学金',
        course: null,
        entities: ['CUSIS']
      }
    ]
    const svc = new MailAiServiceImpl({ ai, store })
    await svc.askInbox('有什么奖学金可以申请？')
    expect(store.lastCollection?.kind).toBe('type')
    expect(ai.calls[0].user).toContain('知识库档案（类型「奖学金」')

    const ai2 = new FakeAiProvider()
    const store2 = makeAskFixtures()
    store2.hits = []
    store2.collectionMails = store.collectionMails
    // 给一条摘要命中，确保真的有上下文（否则会走"收件箱为空"的提前返回）
    store2.summaries = [
      {
        id: 11,
        subject: '关于毕业论文进度的沟通',
        fromName: '林教授',
        fromAddr: 'lin@example.edu',
        dateTs: 1_760_000_000_000,
        summary: '要求补充第三章实验数据。'
      }
    ]
    const svc2 = new MailAiServiceImpl({ ai: ai2, store: store2 })
    await svc2.askInbox('导师说了什么？')
    expect(store2.lastCollection).toBeNull()
    expect(ai2.calls[0].user).not.toContain('知识库档案')
  })
})

describe('M4：能力/寒暄路由 + 多轮聊天上下文', () => {
  it('能力类问题直接答能力：不检索邮件、不带引用（真机回归：问「你能调用知识库吗」曾答「未找到」）', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '我可以读取本地已同步的邮件与索引卡片，但不会发信，也不会访问互联网。'
    const store = makeAskFixtures()
    const svc = new MailAiServiceImpl({ ai, store })
    const res = await svc.askInbox('你能不能调用知识库？')
    expect(res.answer).toContain('索引卡片')
    expect(res.citations).toEqual([])
    // 关键：能力说明进 prompt，检索结果不进 prompt（不该拿邮件糊弄）
    expect(ai.calls[0].user).toContain('不会发信')
    expect(ai.calls[0].user).not.toContain('[1] 主题：')
    expect(store.searchCalls.length).toBe(0)
  })

  it('寒暄不做检索，也不编造邮件内容', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '你好！我可以帮你查收件箱，比如「这周有什么截止」。'
    const store = makeAskFixtures()
    const svc = new MailAiServiceImpl({ ai, store })
    const res = await svc.askInbox('你好')
    expect(res.citations).toEqual([])
    expect(ai.calls[0].user).toContain('不要编造邮件内容')
    expect(store.searchCalls.length).toBe(0)
  })

  it('多轮追问：「那截止呢？」带上一轮问句里的实词去检索，并把历史送进 prompt', async () => {
    const ai = new FakeAiProvider()
    ai.reply = '毕业论文相关的截止是本周五。'
    const store = makeAskFixtures()
    const svc = new MailAiServiceImpl({ ai, store })
    // 真实 IPC 形状：提问先落库，history 最后一条就是当前问题
    await svc.askInbox('那截止呢？', {
      history: [
        { role: 'user', content: '上周导师发了什么邮件？' },
        { role: 'assistant', content: '林教授提到要补充第三章实验数据。' },
        { role: 'user', content: '那截止呢？' }
      ]
    })
    // 检索用了合并后的问句（含「导师」），提示词里也有对话历史
    expect(store.searchCalls.some((t) => t.includes('导师'))).toBe(true)
    expect(ai.calls[0].user).toContain('对话历史')
    expect(ai.calls[0].user).toContain('林教授提到要补充第三章实验数据。')
  })
})
