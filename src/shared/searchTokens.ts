/**
 * 检索词切分（纯函数，从 src/main/db/search.ts 抽出到 shared，供跨语言查询构造复用）。
 *
 * 真机评测发现：把中文问句原样丢给 trigram FTS
 *   「Blackboard 上有什么新通知？」
 * → `"Blackboard" AND "上有什么新通知？"` → 第二段永远匹配不上 → 0 命中，
 * 于是 AI 助手只能退回「最近邮件」兜底。这里把疑问词/停顿词剥掉再召回。
 */

/** 多字疑问词/时间词（出现在词中间也删掉）。 */
const QUESTION_WORDS_MULTI = [
  '什么',
  '哪些',
  '哪个',
  '哪里',
  '怎么',
  '如何',
  '为什么',
  '有没有',
  '是否',
  '什么时候',
  '几时',
  '请问',
  '帮我',
  '查一下',
  '找一下',
  '看看',
  '告诉我',
  '关于',
  '相关',
  '最近',
  '今天',
  '明天',
  '昨天',
  '本周',
  '这周',
  '上周',
  '下周',
  '本月',
  '这个月'
]

/** 疑问词按长度倒序（先删长词，避免「什么」把「什么时候」拆成残渣）。 */
const QUESTION_WORDS_SORTED = [...QUESTION_WORDS_MULTI].sort((a, b) => b.length - a.length)

/** 单字停顿词（只在词首/词尾删）。 */
const BOUNDARY_CHARS = '的了吗呢吧啊哦嘛呀和有是在于我你他她它这那上下中里把给被跟对'

/** 英文疑问词/停顿词。 */
export const QUESTION_WORDS_EN = new Set([
  'a','an','the','is','are','was','were','be','been','do','does','did','doing','what','which','who','whom','whose',
  'when','where','why','how','can','could','should','would','will','shall','may','might','must','i','me','my','mine',
  'you','your','yours','we','our','ours','they','them','their','he','she','it','its','and','or','but','if','then',
  'than','of','to','for','in','on','at','by','with','about','from','into','over','after','before','any','some',
  'there','here','have','has','had','please','show','find','tell','give','list','any','all','recent','today',
  'tomorrow','yesterday','this','that','these','those','last','next','week','month','year'
])

/** 去掉疑问词/停顿词后的检索词（用于 AI 问答；搜索框仍用原始分词）。 */
export function extractRetrievalTokens(term: string): string[] {
  const raw = String(term ?? '')
  const parts = raw
    .split(/[^\p{L}\p{N}]+/u)
    .map((p) => p.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const part of parts) {
    let token = part
    if (/^[a-zA-Z0-9]+$/.test(part)) {
      // 英文/数字：整词匹配停用词
      if (QUESTION_WORDS_EN.has(part.toLowerCase())) continue
      out.push(part)
      continue
    }
    // 中文：删掉词中出现的疑问词（长词优先，否则「什么」会把「什么时候」拆掉，留下「时候」这种残渣）
    for (const w of QUESTION_WORDS_SORTED) token = token.split(w).join('')
    while (token.length > 1 && BOUNDARY_CHARS.includes(token[0])) token = token.slice(1)
    while (token.length > 1 && BOUNDARY_CHARS.includes(token[token.length - 1])) token = token.slice(0, -1)
    for (const w of QUESTION_WORDS_SORTED) token = token.split(w).join('')
    if ([...token].length >= 2) out.push(token)
  }
  return out
}
