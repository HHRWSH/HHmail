/**
 * AI 助手的问题路由（纯函数，可单测）。
 *
 * 真机回归（用户截图）：问「你现在能不能调用知识库」这种**关于助手自身能力**的问题，
 * 系统却把它当成"搜邮件"，检索不到 → 回答「未找到」+ 两条毫不相关的邮件。
 * 所以先把问题分成三类：
 *   - capability：问助手能做什么/怎么用/数据从哪来（以及"知识库"这类功能名词）
 *   - smalltalk：打招呼、闲聊
 *   - mail：真正需要检索邮件的问题
 * 前两类直接由模型基于「能力说明」回答（不检索、不编造邮件内容）；
 * 只有 mail 类才走检索 + 引用。
 */

export type AskKind = 'capability' | 'smalltalk' | 'mail'

/** 助手能力说明（capability 类问题直接用它作答，避免模型瞎猜）。 */
export const CAPABILITY_BRIEF = `你可以使用的能力（回答用户"你能做什么"这类问题时，照此说明，不要编造）：
1. 本地邮件库：已只读同步的学校邮箱邮件（含正文、附件名），可全文检索；
2. 检索索引卡片：每封邮件一份结构化卡片（类型/课程号/截止时间/涉及系统/别名），是问答的主要依据；
3. 知识库集合：按课程号与类型自动聚合（如「ENG1110B 的全部截止」），问课程号或类型时会整段取用；
4. AI 摘要：每封邮件的人类可读摘要（决策卡）；
5. 本地「已发送」记录、标签/星标/稍后提醒等本地状态。
限制（要如实说明）：
- 只能读本地已同步的邮件，不会访问互联网、不读取未同步的邮件；
- 不会发信（发送是单独功能，需要用户点「发送」）；
- 不修改服务器上的邮件（不会删除/移动/标已读）；
- 回答邮件相关内容时只依据检索到的邮件，找不到就回答「未找到」，不编造。`

const CAPABILITY_PATTERNS = [
  /你能(不能)?(调用|访问|读取|看到|查|用)/,
  /你会(不会)?(调用|访问|读取)/,
  /你(能|可以)(做|干)什么/,
  /你(是|会)谁|你是谁|你是什么/,
  /(有|支持)什么(功能|能力)/,
  /怎么(用|使用)|如何使用|使用说明|帮助/,
  // 只把「元问题」当能力类：「知识库里有什么奖学金」是在问邮件内容，必须走检索
  /(知识库|索引卡片|摘要)(是什么|怎么|如何|能|可以|支持|用来|干啥|做什么)/,
  // 只要提到知识库/索引卡片这类功能名词，且前面没命中「邮件内容标记」，就是问助手能力
  /知识库|索引卡片/,
  /数据(来源|范围)/,
  /什么是(知识库|索引卡片|检索索引|决策卡)/,
  /你(能|可以)看到(我的)?(邮件|收件箱)/,
  /(可以|能)(帮|为)我(做|干)什么/
]

/**
 * 邮件内容标记：只要出现这些词，问题就是在问邮件本身（不是问助手能力）。
 * 防的是「你能帮我查一下这周的截止吗」被能力正则误判 → 只回一段能力说明、不检索。
 */
const MAIL_CONTENT =
  /截止|到期|deadline|due|谁(发|说|提|写)|什么时候|哪天|几点|日期|作业|考试|成绩|奖学金|申请|会议|讲座|活动|课程|导师|教授|老师|同学|教务|图书馆|报销|签证|宿舍|选课|缴费|注册|报名|面试|实习|通知|[A-Z]{2,5}\s?\d{3,4}/i

const SMALLTALK_PATTERNS = [/^(你好|您好|哈喽|嗨|hi|hello|hey|在吗|早上好|晚上好|谢谢|多谢|thanks|thank you)[!！。.~～\s]*$/i]

/** 问题分类（短问题优先判为寒暄/能力类，避免被当成检索词）。 */
export function classifyAsk(question: string): AskKind {
  const q = String(question ?? '').trim()
  if (!q) return 'mail'
  if (SMALLTALK_PATTERNS.some((re) => re.test(q))) return 'smalltalk'
  // 提到邮件内容 → 一定是检索类（哪怕句子里有「你能…吗」）
  if (MAIL_CONTENT.test(q)) return 'mail'
  // 能力类：命中关键词，且不超过两句话（长问题多半是真的在问邮件内容）
  const sentenced = q.split(/[。？！?!\n]/).filter(Boolean).length
  if (CAPABILITY_PATTERNS.some((re) => re.test(q)) && q.length <= 60 && sentenced <= 2) return 'capability'
  return 'mail'
}

/**
 * 多轮上下文里的「指代型追问」需要补上检索词：
 * 用户先问「ENG1110B 的实验」，再问「那截止呢？」——单看第二句检索不到东西。
 * 这里在检测到指代词时，把上一轮用户问题里的实词拼进来。
 */
const ANAPHORA = /^(那|这)(封|个|些|门|份|条|位|件事|一次|几封)|^(那|它|他|她|他们|她们|上述|刚才|上面|前面)|(这封|那封|这些|那些|此类|该类)/

export function expandFollowUp(question: string, previousUserQuestion?: string | null): string {
  const q = String(question ?? '').trim()
  const prev = String(previousUserQuestion ?? '').trim()
  if (!prev) return q
  const isFollowUp = q.length <= 20 && ANAPHORA.test(q)
  if (!isFollowUp) return q
  return `${prev} ${q}`
}
