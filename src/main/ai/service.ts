/**
 * MailAiService —— AI 业务抽象 + 默认实现（规范 §14.2 / §6.7 / §6.8）。
 * - 总结：单封/线程 → 中文摘要；system 提示词可经 opts 自定义（设置页提供）；
 * - 搜索问答：RAG prompt 组装 + 引用编号按 uid 一一对应；
 * - prompt 组装是纯函数，可单测；正文永不写日志。
 */
import { DEFAULT_ASK_PROMPT, DEFAULT_INDEX_PROMPT, DEFAULT_SUMMARY_PROMPT } from '../../shared/defaults'
import { parseIndexCard, parseQueryIntent, type IndexCardFields, type IndexFilter } from '../../shared/indexCard'
import { CAPABILITY_BRIEF, classifyAsk, expandFollowUp } from '../../shared/askIntent'
import { buildRetrievalQuery, type WeightedTerm } from '../../shared/retrievalQuery'
import { buildTagPromptBlock } from '../../shared/tags'
import { DEFAULT_ASK_TOPK } from '../../shared/defaults'
import { rankByTerms } from '../../shared/retrievalRank'
import { cleanMailText, formatPromptDate, truncateSafe } from '../../shared/text'
import { AppError, ErrorCodes } from '../../shared/error-codes'
import type { Logger } from '../logger'
import { plainFromHtml } from '../mail/mime'

export interface ThreadMessage {
  fromName: string
  fromAddr: string
  dateTs: number
  bodyText: string
  /** HTML 正文（可选）：bodyText 混入 CSS 噪声时用于兜底取干净文本 */
  bodyHtml?: string | null
}

export interface Thread {
  threadId: string
  subject: string
  messages: ThreadMessage[]
}

export interface Summary {
  text: string
  threadId: string
  /** true = 模型多次返回空后由本地元信息兜底（不保存为正式摘要，避免覆盖旧的好摘要） */
  degraded?: boolean
}

/** 模型多次空返回时的诚实兜底：只陈述邮件元信息，不编造内容。 */
export function buildFallbackSummary(thread: Thread): string {
  const first = thread.messages[0]
  const date = first ? formatPromptDate(first.dateTs) : '未知'
  const sender = first?.fromName || first?.fromAddr || '未知'
  return [
    '## 主旨',
    '',
    'AI 未能生成摘要（该邮件内容可能触发了模型安全策略），以下仅为邮件元信息。',
    '',
    '## 重要度',
    '',
    '**低**',
    '',
    '## 关键信息',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 主题 | ${thread.subject || '未知'} |`,
    `| 发件人 | ${sender} |`,
    `| 时间 | ${date} |`,
    `| 邮件数 | ${thread.messages.length} 封 |`,
    '',
    '## 截止与行动项',
    '',
    '- [ ] 请直接阅读原文确认（AI 未生成可执行行动项）',
    '',
    '## 分类',
    '',
    '待确认'
  ].join('\n')
}

/** 索引卡片命中（M1：给 AI 的检索材料，比摘要更结构化） */
export interface AskIndexHit {
  id: number
  subject: string
  fromName: string
  fromAddr: string
  dateTs: number
  card: string
  type: string | null
  course: string | null
  dueTs: number | null
  /** 命中来源（评测脚本用于区分关键词路与结构化过滤路） */
  via?: 'keyword' | 'filter'
}

export interface SearchHitForAi {
  uid: number
  subject: string
  fromName: string
  dateTs: number
  bodyText: string
}

export interface QaAnswer {
  text: string
  /** 引用编号（对应检索结果的 1-based 下标；UI 按 uid 跳转，避免排序变化跳错）。 */
  citations: number[]
}

export interface SummarizeOptions {
  /** 自定义 system 提示词（设置页可改；缺省用 DEFAULT_SUMMARY_PROMPT）。 */
  systemPrompt?: string
}

// —— AI 搜索问答（V2 M1，规范 v2-dev-spec §1）——

export interface Citation {
  id: number
  subject: string
  fromName: string
  dateTs: number
}

export interface AskInboxResult {
  answer: string
  citations: Citation[]
}

/** 多轮对话历史（聊天式界面：让模型理解指代与上下文） */
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface AskInboxOptions {
  /** 检索 Top-K（默认 8） */
  topK?: number
  /** 自定义 system 提示词（缺省 DEFAULT_ASK_PROMPT） */
  systemPrompt?: string
  /** 之前的对话（按时间升序、最近 N 轮）；用于多轮追问 */
  history?: ChatTurn[]
}

/**
 * 从候选引用里挑出「回答中真正提到」的那些（V2.2）。
 *
 * 用户反馈：回答底下列出十几条检索命中，反而找不到真正相关的那几封。
 * 做法：把主题与回答都归一化（去空白/标点、转小写），用主题的前 12 字与后 10 字做子串匹配；
 * 都不匹配时（模型没写主题）退回前 3 条，保证仍有可点的入口。
 */
export function pickMentionedCitations(answer: string, candidates: Citation[], limit = 5): Citation[] {
  const norm = (s: string): string =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[\s　]+/g, '')
      .replace(/[，。、；：！？…—–\-·|/\()（）\[\]【】"'“”‘’*#>]/g, '')
  const text = norm(answer)
  const hit: Citation[] = []
  for (const c of candidates) {
    const subject = norm(c.subject)
    if (!subject) continue
    const head = subject.slice(0, 12)
    const tail = subject.length > 14 ? subject.slice(-10) : ''
    if ((head.length >= 6 && text.includes(head)) || (tail.length >= 6 && text.includes(tail))) hit.push(c)
  }
  if (hit.length > 0) return hit.slice(0, limit)
  return candidates.slice(0, Math.min(3, limit))
}

/** 问答用检索命中（结构兼容 MessageStore.search 返回） */
export interface AskSearchHit {
  id: number
  subject: string
  fromName: string
  fromAddr: string
  dateTs: number
  snippet: string
}

/** 问答用邮件详情（结构兼容 MessageStore.getMessage 返回） */
export interface AskMailDetail {
  id: number
  subject: string
  fromName: string
  fromAddr: string
  dateTs: number
  bodyText: string
  bodyHtml: string | null
}

/** 已生成摘要的检索命中（AI 问答优先使用，V2.1） */
export interface AskSummaryHit {
  id: number
  subject: string
  fromName: string
  fromAddr: string
  dateTs: number
  summary: string
}

/** 收件箱检索注入接口：上层只依赖它，组合根注入 SqliteMessageStore。 */
export interface InboxSearch {
  search(term: string, limit?: number, opts?: { retrieval?: boolean; rankTerms?: WeightedTerm[] }): Promise<AskSearchHit[]>
  getMessage(id: number): Promise<AskMailDetail | null>
  /** 已生成摘要检索（优先用摘要回答，省 token 且更稳定） */
  searchSummaries?(term: string, limit: number): Promise<AskSummaryHit[]>
  /** 索引卡片关键词检索（M1；rankTerms 用于相关度排序，「第一条就命中」） */
  searchIndexDocs?(term: string, limit: number, opts?: { rankTerms?: WeightedTerm[] }): Promise<AskIndexHit[]>
  /** 索引卡片结构化过滤：类型/课程/截止窗口（M1；rankTerms 在同类结果里重排） */
  searchIndexByFilter?(filter: IndexFilter, limit: number): Promise<AskIndexHit[]>
  /** 集合里的邮件（M3 知识库档案：课程/类型集合的聚合视图） */
  listCollectionMails?(
    kind: 'course' | 'type',
    value: string,
    limit?: number
  ): Promise<
    Array<{
      id: number
      subject: string
      fromName: string
      dateTs: number
      dueTs: number | null
      type: string | null
      course: string | null
      entities: string[]
    }>
  >
  /** 最近邮件（检索无命中时的兜底上下文，避免直接回答「未找到」） */
  query?(params: { limit: number; offset: number }): Promise<{ id: number }[]>
}

export interface MailAiService {
  summarize(thread: Thread, opts?: SummarizeOptions): Promise<Summary>
  /** 生成检索索引卡片（M1：与人类摘要分开的第二份产物） */
  indexDoc(
    thread: Thread,
    tagOptions?: { vocabulary?: string[]; examples?: Array<{ id: number; subject: string; tags: string[] }> }
  ): Promise<IndexDocResult>
  searchQA(question: string, hits: SearchHitForAi[]): Promise<QaAnswer>
  /** 自然语言问收件箱：本地检索 + RAG + 可跳转引用（V2 M1）。 */
  askInbox(question: string, opts?: AskInboxOptions): Promise<AskInboxResult>
  /** 当前实际使用的模型名（UI 显示用，避免写死）。 */
  modelName(): string
  // —— P1 预留：compose / reply / translate / classify 在此加方法，不碰收件箱逻辑 ——
}

/** 兼容旧引用的别名。 */
export const SUMMARIZE_SYSTEM = DEFAULT_SUMMARY_PROMPT

/** 索引卡片：放进 prompt 的正文上限（字符） */
const INDEX_CARD_BODY_CHARS = 3500
/** 索引卡片：空返回重试时的正文上限（再砍一半，确保能出结果） */
const INDEX_CARD_RETRY_BODY_CHARS = 1200
/**
 * 索引卡片：输出上限。卡片本身很短（约 200 字），但**模型可能先做一段思考**，
 * 思考也算在 max_tokens 里 —— 1024 会经常被思考吃光导致 content 为空（真机 bug）。
 */
const INDEX_CARD_MAX_TOKENS = 3072

/** AI 问答一次最多参考/引用多少封邮件（设置里可调） */
export const MAX_ASK_TOPK = 40

export const QA_SYSTEM = `你是邮件助手。基于以下检索到的邮件回答问题。
如果邮件中找不到答案，明确说"未找到"，不要编造。
在回答末尾列出引用的邮件（主题 + 发件人 + 日期）。`

export function truncateText(text: string, maxChars: number): string {
  // 用 truncateSafe：先清洗孤立代理项/控制字符，再按不切断代理对的方式截断。
  // 旧实现直接 t.slice(0, max) 会把 emoji 切成半个字符，JSON 序列化后产生
  // `\ud83d` 这类孤立代理项转义，DeepSeek 直接 400 unexpected end of hex escape → 「AI 助手不能用」。
  return truncateSafe((text || '').trim(), maxChars)
}

/** 总结 prompt（优先保留主题/发件人/时间/正文前 N 字符，规范 §6.7）。 */
export function buildSummarizePrompt(thread: Thread, maxCharsPerMail: number): string {
  const lines = thread.messages.map((m, i) => {
    const date = formatPromptDate(m.dateTs)
    const body = cleanMailText(m.bodyText, m.bodyHtml)
    return `[${i + 1}] 发件人：${m.fromName || m.fromAddr}  收件时间：${date}\n正文：${truncateText(body, maxCharsPerMail)}`
  })
  return `请总结以下邮件线程（主题：${thread.subject}，共 ${thread.messages.length} 封）：\n\n${lines.join('\n\n')}`
}

/** RAG prompt（规范 §6.8：编号对应检索结果，超长截断）。 */
export function buildQaPrompt(question: string, hits: SearchHitForAi[], maxCharsPerMail: number): string {
  const mailLines = hits.map((h, i) => {
    const date = formatPromptDate(h.dateTs)
    return `[${i + 1}] 主题：${h.subject} 发件人：${h.fromName} 日期：${date} 正文：${truncateText(h.bodyText, maxCharsPerMail)}`
  })
  return `问题：${truncateText(question, 2000)}\n\n邮件：\n${mailLines.join('\n')}`
}

/** 索引卡片 prompt（M1：给检索用的结构化卡片，与人类摘要分开调用）。 */
export function buildIndexPrompt(thread: Thread, maxCharsPerMail: number, tagBlock = ''): string {
  const lines = thread.messages.map((m, i) => {
    const date = formatPromptDate(m.dateTs)
    const body = cleanMailText(m.bodyText, m.bodyHtml)
    return `[${i + 1}] 发件人：${m.fromName || m.fromAddr}  收件时间：${date}\n正文：${truncateText(body, maxCharsPerMail)}`
  })
  // B 方案：标签词表 + 用户挑的示例邮件（few-shot）放在正文之前，指引模型产出 [TAGS]
  const tagSection = tagBlock ? `\n\n## 标签规则（[TAGS] 用）\n${tagBlock}` : ''
  return `请为以下邮件线程生成检索索引卡片（主题：${thread.subject}，共 ${thread.messages.length} 封）：${tagSection}\n\n${lines.join('\n\n')}`
}

/** AI 搜索问答 prompt（V2 M1：编号与检索结果一一对应，正文截断控制 token）。
 *  V2.1：带上「已生成摘要」区块——摘要优先，正文兜底。 */
export function buildAskPrompt(
  question: string,
  mails: AskMailDetail[],
  maxCharsPerMail: number,
  summaries: AskSummaryHit[] = [],
  indexDocs: AskIndexHit[] = [],
  dossier: AskDossier | null = null
): string {
  // M3：知识库档案最优先——集合级聚合（整门课的全部截止/涉及系统），
  // 让「ENG1110B 有哪些截止」这类问题能答全，而不是只看零散几条卡片
  const dossierBlock = dossier
    ? `知识库档案（${dossier.kind === 'course' ? '课程' : '类型'}「${dossier.value}」，来自本地索引卡片的结构化聚合，共 ${
        dossier.total
      } 封${dossier.nextDue !== null ? `，最近截止 ${formatPromptDate(dossier.nextDue)}` : ''}）：\n${
        dossier.dues.length > 0
          ? dossier.dues.map((d) => `- ${formatPromptDate(d.dueTs)}　${truncateText(d.subject, 60)}`).join('\n')
          : '- （该集合没有明确的截止时间）'
      }${dossier.entities.length > 0 ? `\n涉及系统/平台：${dossier.entities.join('、')}` : ''}\n（回答与「${
        dossier.value
      }」相关的问题时，以上清单是完整依据，不要遗漏其中的日期）\n\n`
    : ''
  // M1：索引卡片最优先（信息密度高、字段可信，已带别名与可能被问的问题）
  const indexBlock = indexDocs.length
    ? `邮件索引卡片（最可信、优先使用，共 ${indexDocs.length} 条）：\n${indexDocs
        .map((d, i) => {
          const date = formatPromptDate(d.dateTs)
          return `[I${i + 1}] 主题：${d.subject} 发件人：${d.fromName || d.fromAddr} 日期：${date}\n卡片：${truncateText(d.card, 700)}`
        })
        .join('\n')}\n\n`
    : ''
  const summaryBlock = summaries.length
    ? `已生成摘要（可信、优先使用，共 ${summaries.length} 条）：\n${summaries
        .map((s, i) => {
          const date = formatPromptDate(s.dateTs)
          return `[S${i + 1}] 主题：${s.subject} 发件人：${s.fromName || s.fromAddr} 日期：${date}\n摘要：${truncateText(s.summary, 600)}`
        })
        .join('\n')}\n\n`
    : ''
  const mailLines = mails.map((m, i) => {
    const date = formatPromptDate(m.dateTs)
    const body = cleanMailText(m.bodyText, m.bodyHtml)
    return `[${i + 1}] 主题：${m.subject} 发件人：${m.fromName || m.fromAddr} 收件时间：${date} 正文：${truncateText(body, maxCharsPerMail)}`
  })
  const mailBlock = mails.length
    ? `相关邮件原文（共 ${mails.length} 封）：\n${mailLines.join('\n')}`
    : '相关邮件原文：无'
  return `问题：${truncateText(question, 2000)}\n\n${dossierBlock}${indexBlock}${summaryBlock}${mailBlock}`
}

/** 索引卡片生成结果（M1） */
export interface IndexDocResult {
  text: string
  fields: IndexCardFields
  model: string
  /** true = 模型多次空返回，未生成有效卡片 */
  degraded?: boolean
}

export interface MailAiServiceImplDeps {
  ai: AiProviderLike
  logger?: Logger
  maxCharsPerMail?: number
  /** 收件箱检索注入（组合根注入 SqliteMessageStore）；缺省时 askInbox 不可用。 */
  store?: InboxSearch
}

interface AiProviderLike {
  complete(params: { system: string; user: string; temperature?: number; maxTokens?: number }): Promise<string>
  modelName(): string
}

/** 一次问答的检索上下文（M1：索引卡片 → 摘要 → 原文 → 最近邮件兜底）。 */
/**
 * 知识库档案（M3）：某个集合（课程/类型）的结构化聚合。
 * 用户问「ENG1110B 有哪些截止」时，零散几条卡片答不全；
 * 把整个集合的截止时间线与实体一次性交给模型，答案才完整、可核对。
 */
export interface AskDossier {
  kind: 'course' | 'type'
  value: string
  total: number
  /** 还没过期的最近一个截止 */
  nextDue: number | null
  /** 全部截止（时间升序，最多 15 条） */
  dues: Array<{ id: number; subject: string; dueTs: number }>
  /** 集合里反复出现的系统/平台（最多 6 个） */
  entities: string[]
  /** 集合成员（供引用卡片；最多 20 条） */
  items: Array<{ id: number; subject: string; fromName: string; dateTs: number }>
}

export interface AskContext {
  intent: ReturnType<typeof parseQueryIntent>
  indexDocs: AskIndexHit[]
  summaries: AskSummaryHit[]
  mails: AskMailDetail[]
  usedRecentFallback: boolean
  /** M3：命中的知识库集合档案（没有则为 null） */
  dossier: AskDossier | null
}

/**
 * 收集问答所需的检索上下文（不含 LLM 调用）。
 * 抽成独立函数的原因：askInbox 与「离线检索评测脚本」共用同一条链路，
 * 避免评测跑的是另一套逻辑（评测结论就失去意义了）。
 */
export async function collectAskContext(
  store: InboxSearch,
  question: string,
  topK: number,
  logger?: Logger
): Promise<AskContext> {
  const intent = parseQueryIntent(question)
  // 检索词统一在这里构造：去疑问词 + 简繁变体 + 跨语言同义词 + 中文滑窗兜底（见 shared/retrievalQuery.ts）。
  // 之前把 intent.keywords 原样丢给 FTS，导致「图书馆」（简体 vs 语料英文/繁体）、
  // 「语言课程或英语工作坊」（长中文串必须连续出现）这类问题直接 0 命中。
  const rq = buildRetrievalQuery(question, intent.keywords)
  const rankTerms: WeightedTerm[] = rq.hasContent ? rq.terms : []
  const query = rq.query || intent.keywords.trim() || question
  const indexDocs: AskIndexHit[] = []
  const seenIndex = new Set<number>()
  try {
    // 关键词路适当多带几条（卡片内部按检索词相关性排序，最相关的仍在最前）
    const keywordLimit = Math.max(topK, 12)
    const kw = rq.hasContent || intent.keywords.trim() ? await store.searchIndexDocs?.(query, keywordLimit, { rankTerms }) : []
    for (const hit of kw ?? []) {
      if (!seenIndex.has(hit.id)) {
        seenIndex.add(hit.id)
        indexDocs.push(hit)
      }
    }
    if (Object.keys(intent.filter).length > 0) {
      // 集合类问题（"这周有什么截止""有哪些活动"）要把窗口内的都列出来：
      // 实测上限 12 会把覆盖率卡在 50%（24 条本周截止只能带 12 条）；
      // 卡片很短（约 200 字/条），放宽到 40 条也就多几 KB token，覆盖率 84% → 接近全量。
      const filterLimit = Math.max(topK * 3, 40)
      const byFilter = (await store.searchIndexByFilter?.(intent.filter, filterLimit)) ?? []
      for (const hit of byFilter) {
        if (!seenIndex.has(hit.id)) {
          seenIndex.add(hit.id)
          indexDocs.push(hit)
        }
      }
    }
    // 注意：这里**不再**对合并后的 indexDocs 重新排序。
    // 关键词路已经按相关性排好（而且 IDF 是在 90 条候选池上算的，比这里的 12 条更准），
    // 结构化过滤路则刻意保持「未来最近截止优先」的集合视图顺序；再排一次反而会互相打架。
  } catch (e) {
    logger?.warn('ai.askInbox.index_search_failed', { reason: e instanceof Error ? e.message : String(e) })
  }

  let summaries: AskSummaryHit[] = []
  try {
    summaries = (await store.searchSummaries?.(query, topK)) ?? []
    if (summaries.length < topK) {
      // 摘要路也补一次原句：有些邮件的中文摘要措辞和问句用词不同，双路召回后再去重
      const more = (await store.searchSummaries?.(question, topK)) ?? []
      const ids = new Set(summaries.map((s) => s.id))
      for (const m of more) if (!ids.has(m.id)) summaries.push(m)
      if (rankTerms.length > 0) summaries = rankByTerms(summaries.map((x) => ({ ...x, body: x.summary })), rankTerms)
    }
  } catch (e) {
    logger?.warn('ai.askInbox.summary_search_failed', { reason: e instanceof Error ? e.message : String(e) })
  }

  let hits: AskSearchHit[] = []
  try {
    // M1：用检索词（含跨语言同义词与简繁变体）检索；问句整句送进 FTS 会 0 命中（trigram 要求子串完全匹配）
    hits = await store.search(query, topK, { retrieval: true, rankTerms })
    if (hits.length < topK) {
      const more = await store.search(question, topK, { retrieval: true, rankTerms })
      const ids = new Set(hits.map((h) => h.id))
      for (const m of more) if (!ids.has(m.id)) hits.push(m)
    }
  } catch (e) {
    logger?.warn('ai.askInbox.search_failed', { reason: e instanceof Error ? e.message : String(e) })
  }
  const mails: AskMailDetail[] = []
  const seen = new Set<number>()
  for (const h of hits) {
    const detail = await store.getMessage(h.id)
    if (detail && !seen.has(detail.id)) {
      seen.add(detail.id)
      mails.push(detail)
    }
  }
  // 正文路同样按相关性排序（主题命中优先），避免"最近但无关"的邮件排在真正相关的前面
  if (rankTerms.length > 0 && mails.length > 1) {
    const rankedMails = rankByTerms(
      mails.map((m) => ({ ...m, body: m.bodyText })),
      rankTerms
    )
    mails.length = 0
    mails.push(...rankedMails)
  }

  let usedRecentFallback = false
  if (indexDocs.length === 0 && summaries.length === 0 && mails.length === 0) {
    try {
      const recent = (await store.query?.({ limit: topK, offset: 0 })) ?? []
      for (const item of recent) {
        const detail = await store.getMessage(item.id)
        if (detail) mails.push(detail)
      }
      usedRecentFallback = mails.length > 0
    } catch (e) {
      logger?.warn('ai.askInbox.recent_failed', { reason: e instanceof Error ? e.message : String(e) })
    }
  }
  // M3：问题里出现课程号或类型时，把对应的「集合档案」也取出来（知识库 → AI 助手）
  let dossier: AskDossier | null = null
  try {
    const kind: 'course' | 'type' | null = intent.filter.course ? 'course' : intent.filter.type ? 'type' : null
    const value = intent.filter.course ?? intent.filter.type ?? null
    if (kind && value && store.listCollectionMails) {
      const items = await store.listCollectionMails(kind, value, 60)
      if (items.length > 0) {
        const now = Date.now()
        const dues = items
          .filter((m) => m.dueTs !== null)
          .sort((a, b) => (a.dueTs ?? 0) - (b.dueTs ?? 0))
          .slice(0, 15)
          .map((m) => ({ id: m.id, subject: m.subject, dueTs: m.dueTs as number }))
        const entityCount = new Map<string, number>()
        for (const m of items) for (const e of m.entities ?? []) entityCount.set(e, (entityCount.get(e) ?? 0) + 1)
        dossier = {
          kind,
          value,
          total: items.length,
          nextDue: dues.find((d) => d.dueTs >= now)?.dueTs ?? null,
          dues,
          entities: [...entityCount.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([name]) => name),
          items: items.slice(0, 20).map((m) => ({ id: m.id, subject: m.subject, fromName: m.fromName, dateTs: m.dateTs }))
        }
      }
    }
  } catch (e) {
    logger?.warn('ai.askInbox.dossier_failed', { reason: e instanceof Error ? e.message : String(e) })
  }

  return { intent, indexDocs, summaries, mails, usedRecentFallback, dossier }
}

export class MailAiServiceImpl implements MailAiService {
  private ai: AiProviderLike
  private logger?: Logger
  private maxCharsPerMail: number
  private store?: InboxSearch

  constructor(deps: MailAiServiceImplDeps) {
    this.ai = deps.ai
    this.logger = deps.logger
    // 每封邮件的正文字符预算：模板要求「硬信息完整」，给足空间避免截止时间被截断（真机教训）
    this.maxCharsPerMail = deps.maxCharsPerMail ?? 3000
    this.store = deps.store
  }

  modelName(): string {
    return this.ai.modelName()
  }

  async summarize(thread: Thread, opts: SummarizeOptions = {}): Promise<Summary> {
    const system = (opts.systemPrompt ?? '').trim() || DEFAULT_SUMMARY_PROMPT
    const prompt = buildSummarizePrompt(thread, this.maxCharsPerMail)
    // 只记输入字符数，不记正文（规范 §2 第 7 条）
    this.logger?.info('ai.summarize', { inputChars: prompt.length })
    // 思考型模型会把隐藏思考也算进 max_tokens：给足预算，避免思考耗尽后正文为空
    let text = await this.ai.complete({ system, user: prompt, temperature: 0.2, maxTokens: 4096 })
    if (!text.trim()) {
      // DeepSeek 偶发返回空内容：原样自动重试一次
      this.logger?.warn('ai.summarize.empty_retry')
      await new Promise((r) => setTimeout(r, 800))
      text = await this.ai.complete({ system, user: prompt, temperature: 0.2, maxTokens: 4096 })
    }
    if (!text.trim()) {
      // 仍为空（可能正文触发了内容安全过滤）：降级为「最近 3 封 × 每封 300 字」再试一次
      this.logger?.warn('ai.summarize.empty_reduced_retry')
      const reducedThread = { ...thread, messages: thread.messages.slice(-3) }
      const reducedPrompt = buildSummarizePrompt(reducedThread, 300)
      text = await this.ai.complete({ system, user: reducedPrompt, temperature: 0.2, maxTokens: 4096 })
    }
    if (!text.trim()) {
      // 降级仍失败：返回诚实的元信息摘要（明确标注非 AI 生成），不再假装成功
      this.logger?.warn('ai.summarize.fallback_metadata')
      return { text: buildFallbackSummary(thread), threadId: thread.threadId, degraded: true }
    }
    return { text, threadId: thread.threadId }
  }

  async searchQA(question: string, hits: SearchHitForAi[]): Promise<QaAnswer> {
    const prompt = buildQaPrompt(question, hits, this.maxCharsPerMail)
    this.logger?.info('ai.searchQA', { questionLength: question.length, hits: hits.length, inputChars: prompt.length })
    const text = await this.ai.complete({ system: QA_SYSTEM, user: prompt, temperature: 0.2, maxTokens: 4096 })
    return { text, citations: hits.map((_, i) => i + 1) }
  }

  /**
   * 生成「检索索引卡片」（M1）。与 summarize() 是两次独立调用：
   * 人类摘要追求可扫读，索引卡片追求信息密度与可检索性（别名、可能被问的问题、可过滤字段）。
   */
  async indexDoc(thread: Thread, tagOptions: { vocabulary?: string[]; examples?: Array<{ id: number; subject: string; tags: string[] }> } = {}): Promise<IndexDocResult> {
    // 索引卡片的输入上限比人类摘要更小：卡片只要「可检索的字段」，不需要整篇正文。
    // 真机教训：超长邮件（输入 12k 字符）会让模型把 max_tokens 全花在思考上，
    // finish_reason=length 且 content 为空 → 索引卡片整批失败（设置页一直显示「已建 x/y」补不齐）。
    // B 方案：标签词表 + 用户挑的示例邮件（few-shot）——同一个调用里顺带产出标签，不增加调用次数
    const tagBlock = buildTagPromptBlock(tagOptions.vocabulary ?? [], tagOptions.examples ?? [])
    const prompt = buildIndexPrompt(thread, Math.min(this.maxCharsPerMail, INDEX_CARD_BODY_CHARS), tagBlock)
    this.logger?.info('ai.indexDoc', { inputChars: prompt.length })
    const call = (user: string, maxTokens: number): Promise<string> =>
      this.ai.complete({ system: DEFAULT_INDEX_PROMPT, user, temperature: 0, maxTokens })
    let text = await call(prompt, INDEX_CARD_MAX_TOKENS)
    if (!text.trim()) {
      // 空返回：缩短上下文再试一次（与摘要路径同样的兜底策略）
      this.logger?.warn('ai.indexDoc.empty_retry')
      await new Promise((r) => setTimeout(r, 600))
      const shortPrompt = buildIndexPrompt(thread, INDEX_CARD_RETRY_BODY_CHARS, tagBlock)
      text = await call(shortPrompt, INDEX_CARD_MAX_TOKENS)
    }
    const model = this.ai.modelName()
    if (!text.trim()) {
      this.logger?.warn('ai.indexDoc.failed')
      return { text: '', fields: parseIndexCard(''), model, degraded: true }
    }
    const clean = text.trim()
    return { text: clean, fields: parseIndexCard(clean), model }
  }

  async askInbox(question: string, opts: AskInboxOptions = {}): Promise<AskInboxResult> {
    if (!this.store) {
      throw new AppError(ErrorCodes.AI_FAILED, 'AI 问答服务未初始化。')
    }
    // V2.2：上限从 12/20 放宽到 40 —— 用户希望「能问到邮箱里所有相关邮件」；
    // 「全部/所有/都有哪些」这类穷举问法再自动放大 3 倍（封顶 40），让集合类问题答得更全。
    const requested = Math.max(1, Math.min(opts.topK ?? DEFAULT_ASK_TOPK, MAX_ASK_TOPK))
    const exhaustive = /全部|所有|都有哪些|都有什么|列出来|列一下|全量|list all|all of/i.test(question)
    const topK = exhaustive ? Math.min(Math.max(requested * 3, 12), MAX_ASK_TOPK) : requested
    // 0) 路由：能力/寒暄类问题**不检索邮件**，直接用能力说明回答
    //    真机回归：问「你能不能调用知识库」被当成搜邮件 → 答「未找到」+ 两条不相关邮件
    const kind = classifyAsk(question)
    if (kind !== 'mail') {
      this.logger?.info('ai.askInbox.capability', { questionLength: question.length })
      const system = (opts.systemPrompt ?? '').trim() || DEFAULT_ASK_PROMPT
      const user =
        kind === 'capability'
          ? `${CAPABILITY_BRIEF}

用户问题：${question}

请用简体中文、分点、简明回答（2-6 行），只依据上面的能力说明，不要编造邮件内容。`
          : `用户说：${question}

请用简体中文友好回应一句，并说明你可以帮他查收件箱（例如「这周有什么截止」），不要编造邮件内容。`
      // 800 太小：模型可能先做一段思考，思考也算 max_tokens，容易被吃光后 content 为空（真机教训）
      const answer = await this.ai.complete({ system, user, temperature: 0.3, maxTokens: 2048 })
      return {
        answer: answer.trim() || (kind === 'capability' ? CAPABILITY_BRIEF : '你好，我可以帮你查收件箱。'),
        citations: []
      }
    }
    // 多轮追问：「那截止呢？」这类指代句需要带上上一轮问句里的实词才能检索到。
    // 注意：IPC 传进来的 history 里最后一条用户消息就是当前问题本身（提问已先落库），必须跳过它，
    // 否则「上一轮问句」会等于自己 → 追问永远不扩展（真机表现：第二轮检索退化）。
    const lastUser =
      [...(opts.history ?? [])]
        .reverse()
        .find((t) => t.role === 'user' && t.content.trim() !== question.trim())?.content ?? null
    const retrievalQuestion = expandFollowUp(question, lastUser)
    const ctx = await collectAskContext(this.store, retrievalQuestion, topK, this.logger)
    const { intent, indexDocs, summaries, mails, usedRecentFallback, dossier } = ctx
    if (indexDocs.length === 0 && summaries.length === 0 && mails.length === 0 && dossier === null) {
      // 收件箱确实是空的（或还没同步）：如实告知，不编造
      return { answer: '收件箱里还没有可用于回答的邮件（或尚未同步完成）。请先点右上角「↻ 同步」再试。', citations: [] }
    }
    // 正文预算：有索引卡片时不需要塞太多原文（卡片已含要点），省 token 也减少噪声
    const bodyBudget = indexDocs.length > 0 ? 250 : 400
    const historyBlock =
      opts.history && opts.history.length > 0
        ? `对话历史（用于理解指代与上文，回答保持一致）：\n${opts.history
            .slice(-6)
            .map((t) => `${t.role === 'user' ? '用户' : '助手'}：${truncateText(t.content, 300)}`)
            .join('\n')}\n\n`
        : ''
    const prompt = historyBlock + buildAskPrompt(question, mails, bodyBudget, summaries, indexDocs, dossier)
    // 只记字符数，不记正文（规范 §2 第 7 条）
    this.logger?.info('ai.askInbox', {
      questionLength: question.length,
      hits: mails.length,
      summaries: summaries.length,
      indexDocs: indexDocs.length,
      dossierCards: dossier ? dossier.total : 0,
      filtered: Object.keys(intent.filter).length > 0,
      recentFallback: usedRecentFallback,
      inputChars: prompt.length
    })
    const system = (opts.systemPrompt ?? '').trim() || DEFAULT_ASK_PROMPT
    let answer = await this.ai.complete({ system, user: prompt, temperature: 0.2, maxTokens: 4096 })
    if (!answer.trim()) {
      this.logger?.warn('ai.askInbox.empty_retry')
      await new Promise((r) => setTimeout(r, 800))
      answer = await this.ai.complete({ system, user: prompt, temperature: 0.2, maxTokens: 4096 })
    }
    if (!answer.trim()) {
      throw new AppError(ErrorCodes.AI_FAILED, 'AI 未返回内容，请稍后重试或更换模型。')
    }
    // 引用：摘要命中 + 邮件原文命中（按 id 去重）
    const citationMap = new Map<number, Citation>()
    for (const it of dossier?.items ?? []) {
      citationMap.set(it.id, { id: it.id, subject: it.subject, fromName: it.fromName, dateTs: it.dateTs })
    }
    for (const d of indexDocs) {
      citationMap.set(d.id, { id: d.id, subject: d.subject, fromName: d.fromName || d.fromAddr, dateTs: d.dateTs })
    }
    for (const s of summaries) {
      citationMap.set(s.id, { id: s.id, subject: s.subject, fromName: s.fromName || s.fromAddr, dateTs: s.dateTs })
    }
    for (const m of mails) {
      if (!citationMap.has(m.id)) {
        citationMap.set(m.id, { id: m.id, subject: m.subject, fromName: m.fromName || m.fromAddr, dateTs: m.dateTs })
      }
    }
    // V2.2：只把**回答里真正提到**的邮件作为引用（用户反馈「底下一堆无效索引，找不到正确邮件」）。
    // 判断方式：把回答与主题都去掉空白/标点后做子串匹配（模型常把主题原样或截断后写进表格）。
    const all = [...citationMap.values()]
    const picked = pickMentionedCitations(answer, all)
    this.logger?.info('ai.askInbox.citations', { candidates: all.length, cited: picked.length })
    return { answer, citations: picked }
  }

}
